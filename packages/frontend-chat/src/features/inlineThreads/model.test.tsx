import type { SessionApi, TextAnchor, ThreadInfo } from "@harness/api";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ChatState, initialState } from "../../state/reducer";
import { getDraft, setDraft, updateDraftAttachments } from "../prompt/drafts";
import type { PendingMessage } from "../prompt/pendingMessages";
import { composerKey, setQuotes, withReviewComments } from "../review/reviewComments";
import { type InlineModel, useInlineThreads } from "./model";

const SID = "s1";
const quote = { quote: "twice as long", prefix: "waits ", suffix: " as before" };
const api = {
   sessionId: SID,
   startSideThread: vi.fn(async () => ({ thread_id: "t9", forked: true })),
   prompt: vi.fn(async () => {}),
   resolveSideThread: vi.fn(async () => {}),
} as unknown as SessionApi & {
   startSideThread: ReturnType<typeof vi.fn>;
   prompt: ReturnType<typeof vi.fn>;
};

const anchor = (seq = 5): TextAnchor => ({ thread_id: "main", seq, ...quote });
const info = (id: string, a: TextAnchor | null, resolved = false): ThreadInfo => ({
   id,
   main: false,
   title: null,
   agentTitle: null,
   forkedFrom: null,
   anchor: a,
   resolved,
   turns: 1,
   lastAt: 0,
});
const mainState = (over: Partial<ChatState> = {}): ChatState => ({
   ...initialState(),
   mainThreadId: "main",
   ...over,
});
const item = (prompt: string): PendingMessage => ({
   id: "p1",
   prompt,
   inputs: [],
   files: [],
   comments: [],
   snap: null as never,
   status: "sending",
   base: 0,
});

const draftsKey = `harness.chat.inlineDrafts.${SID}`;
const stored = () => JSON.parse(JSON.parse(localStorage.getItem(draftsKey)!).d);

function setup(state: ChatState = mainState()) {
   const out = { current: null as unknown as InlineModel };
   const view = renderHook(
      ({ s }) => {
         const m = useInlineThreads({ api, state: s });
         out.current = m;
         return m;
      },
      { initialProps: { s: state } },
   );
   return { out, rerender: (s: ChatState) => view.rerender({ s }), unmount: view.unmount };
}

const mem = new Map<string, string>();
beforeEach(() => {
   mem.clear();
   vi.stubGlobal("localStorage", {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, String(v)),
      removeItem: (k: string) => void mem.delete(k),
      clear: () => mem.clear(),
   });
   vi.clearAllMocks();
});
afterEach(() => {
   cleanup();
   vi.unstubAllGlobals();
});

describe("useInlineThreads", () => {
   it("send forks with the Anchor and leads the first prompt with the quote", async () => {
      const { out } = setup();
      let id: string | null = null;
      act(() => {
         id = out.current.begin("e5", quote);
      });
      expect(id).toMatch(/^draft:/);
      expect(out.current.openIds).toEqual([id]);
      expect(out.current.composing).toBe(id);
      expect(out.current.drafts[id!]).toEqual({ itemId: "e5", anchor: anchor() });

      await act(() => out.current.send(id!, "Why?", [], item("Why?"), "ask"));
      expect(api.startSideThread).toHaveBeenCalledWith({
         source: "fork",
         mode: "ask",
         anchor: anchor(),
      });
      const prompt = withReviewComments("Why?", [
         { id: "x", kind: "quote", quote: quote.quote, text: "" },
      ]);
      expect(prompt.startsWith("Comments on the conversation:")).toBe(true);
      expect(api.prompt).toHaveBeenCalledWith(prompt, [], "t9");
      // The draft became the Thread, which the popover now shows (its Anchor kept until its replay arrives).
      expect(out.current.drafts).toEqual({});
      expect(out.current.openIds).toEqual(["t9"]);
      expect(out.current.threads.map((t) => [t.id, t.itemId])).toEqual([["t9", "e5"]]);
   });

   it("begin refuses ids that are not agent messages", () => {
      const { out } = setup();
      act(() => {
         expect(out.current.begin("u3", quote)).toBeNull();
      });
      expect(out.current.openIds).toBeNull();
   });

   it("lists anchored Side Threads newest first, not others", () => {
      const { out } = setup(
         mainState({
            threadList: [
               { ...info("main", null), main: true },
               info("plain", null),
               info("a", anchor(5)),
               info("b", anchor(7), true),
            ],
         }),
      );
      expect(out.current.threads.map((t) => [t.id, t.itemId, t.resolved])).toEqual([
         ["b", "e7", true],
         ["a", "e5", false],
      ]);
   });

   it("unread follows seen", () => {
      const later = Date.now() + 60_000;
      const s = mainState({
         threadList: [info("a", anchor())],
         threads: { a: { ...initialState(), turnEndedAt: later } },
      });
      const { out } = setup(s);
      expect(out.current.statusOf("a")).toBe("unread");
      // Opening it marks it seen; it stays seen after closing.
      act(() => out.current.open(["a"]));
      expect(out.current.statusOf("a")).toBe(null);
      act(() => out.current.close());
      expect(out.current.statusOf("a")).toBe(null);
      expect(JSON.parse(localStorage.getItem(`harness.chat.inlineSeen.${SID}`)!)).toEqual({
         v: 1,
         d: JSON.stringify({ a: later }),
      });
   });

   it("running wins over unread", () => {
      const s = mainState({
         threadList: [info("a", anchor())],
         threads: { a: { ...initialState(), turnId: "t1", turnEndedAt: Date.now() + 1 } },
      });
      expect(setup(s).out.current.statusOf("a")).toBe("running");
   });

   it("close drops drafts without text and keeps the others", () => {
      const { out } = setup();
      let empty = "";
      let typed = "";
      act(() => {
         empty = out.current.begin("e5", quote)!;
      });
      act(() => out.current.close());
      expect(out.current.drafts[empty]).toBeUndefined();
      act(() => {
         typed = out.current.begin("e5", quote)!;
      });
      setDraft(composerKey(SID, typed), { root: { children: [] } } as never);
      act(() => out.current.close());
      expect(out.current.openIds).toBeNull();
      expect(out.current.drafts[typed]).toBeDefined();
      act(() => out.current.discard(typed));
      expect(out.current.drafts[typed]).toBeUndefined();
      expect(getDraft(composerKey(SID, typed))).toBeNull();
   });

   it("loads old, missing and broken stored values", () => {
      const key = `harness.chat.inlineDrafts.${SID}`;
      const seenKey = `harness.chat.inlineSeen.${SID}`;
      for (const raw of [
         "{nope",
         "[]",
         '"x"',
         JSON.stringify({ v: 0, d: "{}" }),
         JSON.stringify({ v: 1, d: "[1]" }),
      ]) {
         localStorage.setItem(key, raw);
         localStorage.setItem(seenKey, raw);
         const { out } = setup();
         expect(out.current.drafts).toEqual({});
         cleanup();
      }
      // A bad entry goes alone.
      const good = { itemId: "e5", anchor: anchor() };
      localStorage.setItem(
         key,
         JSON.stringify({
            v: 1,
            d: JSON.stringify({ "draft:a": good, "draft:b": { itemId: 3 }, "draft:c": null }),
         }),
      );
      localStorage.setItem(
         seenKey,
         JSON.stringify({ v: 1, d: JSON.stringify({ a: 5, b: "x", c: null }) }),
      );
      // (draft:a has text: drafts with nothing in their composer go on load.)
      setDraft(composerKey(SID, "draft:a"), { root: { children: [] } } as never);
      const s = mainState({
         threadList: [info("a", anchor()), info("b", anchor())],
         threads: {
            a: { ...initialState(), turnEndedAt: 5 },
            b: { ...initialState(), turnEndedAt: Date.now() + 60_000 },
         },
      });
      const { out } = setup(s);
      expect(out.current.drafts).toEqual({ "draft:a": good });
      expect(out.current.statusOf("a")).toBe(null);
      expect(out.current.statusOf("b")).toBe("unread");
   });

   it("markFound keeps the set of anchors not found", () => {
      const { out } = setup();
      act(() => out.current.markFound("a", false));
      expect([...out.current.notFound]).toEqual(["a"]);
      const same = out.current.notFound;
      act(() => out.current.markFound("a", false));
      expect(out.current.notFound).toBe(same);
      act(() => out.current.markFound("a", true));
      expect(out.current.notFound.size).toBe(0);
   });

   it("showInChat bumps reveal", () => {
      const { out } = setup();
      act(() => out.current.showInChat("a"));
      act(() => out.current.showInChat("a"));
      expect(out.current.reveal).toEqual({ id: "a", n: 2 });
   });
   it("a draft being sent stays on close, refuses a second send, and gets its text back on failure", async () => {
      const { out } = setup();
      let id = "";
      act(() => {
         id = out.current.begin("e5", quote)!;
      });
      const key = composerKey(SID, id);
      const snap = { root: { children: [] } } as never;
      let fail: (e: Error) => void = () => {};
      api.startSideThread.mockImplementationOnce(() => new Promise((_, reject) => (fail = reject)));
      let first: Promise<void> = Promise.resolve();
      act(() => {
         first = out.current.send(id, "Why?", [], { ...item("Why?"), snap });
      });
      // The composer cleared its text when it sent; an outside click or Esc closes now.
      expect(getDraft(key)).toBeNull();
      expect(out.current.hasContent(id)).toBe(true);
      act(() => out.current.close());
      expect(out.current.drafts[id]).toBeDefined();
      await expect(out.current.send(id, "Again", [], item("Again"))).rejects.toThrow(
         "already being sent",
      );
      expect(api.startSideThread).toHaveBeenCalledTimes(1);
      await act(async () => {
         fail(new Error("fork failed"));
         await expect(first).rejects.toThrow("fork failed");
      });
      // The popover is gone: the text is stored again for when it opens.
      expect(getDraft(key)).toEqual(snap);
      expect(out.current.drafts[id]).toBeDefined();
      expect(out.current.sentAs(id)).toBeNull();
   });

   it("sentAs names the Thread a draft became", async () => {
      const { out } = setup();
      let id = "";
      act(() => {
         id = out.current.begin("e5", quote)!;
      });
      await act(() => out.current.send(id, "Why?", [], item("Why?")));
      expect(out.current.sentAs(id)).toBe("t9");
   });

   it("a draft with only a quote or an attachment stays on close", () => {
      const { out } = setup();
      let q = "";
      let f = "";
      act(() => {
         q = out.current.begin("e5", quote)!;
      });
      setQuotes(composerKey(SID, q), [{ id: "c1", kind: "quote", quote: "x", text: "" }]);
      act(() => out.current.close());
      act(() => {
         f = out.current.begin("e5", quote)!;
      });
      updateDraftAttachments(composerKey(SID, f), () => [{ id: "a1" } as never]);
      act(() => out.current.close());
      expect(Object.keys(out.current.drafts).sort()).toEqual([q, f].sort());
      updateDraftAttachments(composerKey(SID, f), () => []);
   });

   it("drops drafts with nothing in their composer on load and on unmount", () => {
      const good = { itemId: "e5", anchor: anchor() };
      localStorage.setItem(
         draftsKey,
         JSON.stringify({ v: 1, d: JSON.stringify({ "draft:a": good, "draft:b": good }) }),
      );
      setDraft(composerKey(SID, "draft:a"), { root: { children: [] } } as never);
      const { out, unmount } = setup();
      expect(Object.keys(out.current.drafts)).toEqual(["draft:a"]);
      // An empty draft begun now (Ask inline, then a reload or Session switch) goes too.
      let id = "";
      act(() => {
         id = out.current.begin("e5", quote)!;
      });
      expect(stored()[id]).toBeDefined();
      unmount();
      expect(Object.keys(stored())).toEqual(["draft:a"]);
   });
});
