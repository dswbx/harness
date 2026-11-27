import type { SessionApi, ThreadInfo } from "@harness/api";
import { TooltipProvider } from "@harness/ui";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ChatState, initialState } from "../../state/reducer";
import { getDraft, setDraft } from "../prompt/drafts";
import type { PendingMessage } from "../prompt/pendingMessages";
import type { UiEnv } from "../renderUi/RenderUi";
import { composerKey } from "../review/reviewComments";
import { AnchorRegistry } from "./anchors";
import { InlinePopover } from "./InlinePopover";
import { type InlineModel, useInlineThreads } from "./model";

const SID = "s1";
const api = {
   sessionId: SID,
   startSideThread: vi.fn(async () => ({ thread_id: "t9", forked: true })),
   prompt: vi.fn(async () => {}),
   resolveSideThread: vi.fn(async () => {}),
   setConfigOption: vi.fn(async () => {}),
   cancel: vi.fn(async () => {}),
} as unknown as SessionApi;
const state: ChatState = {
   ...initialState(),
   mainThreadId: "main",
   loaded: true,
   commands: [{ name: "compact", description: "", hint: null }],
};
const quote = { quote: "twice", prefix: "waits ", suffix: " as long" };

/** A saved composer text (the editor's JSON) for a draft. */
const typed = (text: string) =>
   ({
      root: {
         type: "root",
         version: 1,
         direction: "ltr",
         format: "",
         indent: 0,
         children: [
            {
               type: "paragraph",
               version: 1,
               direction: "ltr",
               format: "",
               indent: 0,
               textFormat: 0,
               textStyle: "",
               children: [
                  {
                     type: "text",
                     version: 1,
                     text,
                     detail: 0,
                     format: 0,
                     mode: "normal",
                     style: "",
                  },
               ],
            },
         ],
      },
   }) as never;

function setup(s: ChatState = state) {
   const row = document.createElement("p");
   row.textContent = "The loop waits twice as long each time.";
   document.body.append(row);
   const registry = new AnchorRegistry();
   const out = { m: null as unknown as InlineModel };
   function Harness() {
      const m = useInlineThreads({ api, state: s });
      out.m = m;
      return (
         <InlinePopover
            api={api}
            state={s}
            inline={m}
            registry={registry}
            env={{} as UiEnv}
            onOpenDiff={() => {}}
            onShowInSideChats={() => {}}
         />
      );
   }
   render(
      <TooltipProvider>
         <Harness />
      </TooltipProvider>,
   );
   /** Begins a draft on the text and registers its range, as the chat row would. */
   const begin = () => {
      let id = "";
      act(() => {
         id = out.m.begin("e5", quote)!;
         const r = document.createRange();
         r.setStart(row.firstChild!, 15);
         r.setEnd(row.firstChild!, 20);
         registry.set(id, r, row);
      });
      return id;
   };
   return { out, begin, row, registry };
}

// Hidden from the accessibility tree in happy-dom (no layout: the anchor looks detached).
const popover = () => document.querySelector<HTMLElement>('[role="dialog"]');
/** Radix listens for outside clicks (a pointer down, then its click) from the next tick after it opens. */
const tick = () => act(() => new Promise((r) => setTimeout(r, 0)));
const editorText = () => popover()?.querySelector("[contenteditable]")?.textContent?.trim() ?? null;

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
   document.body.innerHTML = "";
   vi.unstubAllGlobals();
});

describe("inline drafts", () => {
   it("an outside click keeps a draft with text open; Close keeps the draft and its text", async () => {
      const { out, begin, row } = setup();
      const id = begin();
      // The user typed (the composer saves its text as they type), shown again from the saved text.
      act(() => out.m.open([]));
      setDraft(composerKey(SID, id), typed("Is there a cap?"));
      act(() => out.m.open([id]));
      expect(editorText()).toBe("Is there a cap?");
      await tick();
      fireEvent.pointerDown(row);
      fireEvent.click(row);
      expect(popover()).not.toBeNull();

      fireEvent.click(popover()!.querySelector('[aria-label="Close"]')!);
      expect(popover()).toBeNull();
      expect(out.m.drafts[id]).toBeDefined();
      expect(getDraft(composerKey(SID, id))).not.toBeNull();

      // A click on its highlight (or marker) opens it again, with the text.
      act(() => out.m.open([id]));
      expect(editorText()).toBe("Is there a cap?");
   });

   it("an empty draft goes on an outside click", async () => {
      const { out, begin, row } = setup();
      const id = begin();
      await tick();
      expect(popover()).not.toBeNull();
      fireEvent.pointerDown(row);
      fireEvent.click(row);
      expect(popover()).toBeNull();
      expect(out.m.drafts[id]).toBeUndefined();
   });

   it("an empty draft goes on Close", () => {
      const { out, begin } = setup();
      const id = begin();
      fireEvent.click(popover()!.querySelector('[aria-label="Close"]')!);
      expect(out.m.drafts[id]).toBeUndefined();
   });

   it("Discard removes the draft and its text", () => {
      const { out, begin } = setup();
      const id = begin();
      act(() => void setDraft(composerKey(SID, id), typed("Why?")));
      act(() => out.m.discard(id));
      expect(popover()).toBeNull();
      expect(out.m.drafts[id]).toBeUndefined();
      expect(getDraft(composerKey(SID, id))).toBeNull();
   });

   it("send turns the draft into an Inline Thread", async () => {
      const { out, begin } = setup();
      const id = begin();
      act(() => void setDraft(composerKey(SID, id), typed("Why?")));
      await act(() =>
         out.m.send(id, "Why?", [], {
            id: "p",
            prompt: "Why?",
            files: [],
            status: "sending",
         } as unknown as PendingMessage),
      );
      expect(out.m.drafts).toEqual({});
      expect(getDraft(composerKey(SID, id))).toBeNull();
      // Still open, now on the Thread (at the same text until its own range is found).
      expect(out.m.openIds).toEqual(["t9"]);
      expect(popover()?.getAttribute("aria-label")).toBe("Inline thread");
   });
   it("Esc in the composer's slash menu closes the menu, not the popover", async () => {
      const { out, begin } = setup();
      const id = begin();
      act(() => out.m.open([]));
      setDraft(composerKey(SID, id), typed("/"));
      act(() => out.m.open([id]));
      await tick();
      expect(document.querySelector('[role="option"]')).not.toBeNull();
      const ed = popover()!.querySelector<HTMLElement>("[contenteditable]")!;
      fireEvent.keyDown(ed, { key: "Escape" });
      expect(popover()).not.toBeNull();
      expect(document.querySelector('[role="option"]')).toBeNull();
      // With the menu closed, Esc closes the popover (the draft has text: it stays).
      fireEvent.keyDown(ed, { key: "Escape" });
      expect(popover()).toBeNull();
      expect(out.m.drafts[id]).toBeDefined();
   });

   it("a Thread whose text is not on screen does not open at another Thread's text", () => {
      const thread = (id: string, seq: number): ThreadInfo => ({
         id,
         main: false,
         title: null,
         agentTitle: null,
         forkedFrom: null,
         anchor: { thread_id: "main", seq, ...quote },
         resolved: false,
         turns: 1,
         lastAt: 0,
      });
      const { out, row, registry } = setup({
         ...state,
         threadList: [thread("a", 5), thread("b", 9)],
      });
      act(() => {
         const r = document.createRange();
         r.setStart(row.firstChild!, 15);
         r.setEnd(row.firstChild!, 20);
         registry.set("a", r, row);
         out.m.open(["a"]);
      });
      expect(popover()).not.toBeNull();
      act(() => out.m.open(["b"]));
      expect(popover()).toBeNull();
   });
});
