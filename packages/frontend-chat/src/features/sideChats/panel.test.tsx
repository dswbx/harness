import type { SessionApi, ViewVariant } from "@harness/api";
import { act, cleanup, render } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultLayout, isOpen, type Layout, resetLayout } from "../../shell/dock/model";
import { usePanelHost } from "../../shell/usePanelHost";
import { type ChatState, initialState } from "../../state/reducer";
import { getPendingMessages } from "../prompt/pendingMessages";
import { composerKey } from "../review/reviewComments";
import { type SideChatsModel, sideChatsPanel } from "./panel";

const PANELS = [sideChatsPanel];
const NO_FAMILIES: never[] = [];

const api = {
   sessionId: "s1",
   startSideThread: vi.fn(async () => ({ thread_id: "t9" })),
   prompt: vi.fn(async () => {}),
} as unknown as SessionApi;

// Threads the Session Log has replayed (an open tab shows once its Thread did).
let known: string[] = [];
const stateWith = (): ChatState => ({
   ...initialState(),
   threads: Object.fromEntries(known.map((id) => [id, {}])) as ChatState["threads"],
});

function setup(variant: ViewVariant = "full") {
   const out = {} as {
      host: ReturnType<typeof usePanelHost>;
      lay: Layout;
      model: SideChatsModel;
      update: (f: (l: Layout) => Layout) => void;
   };
   function Harness({ tick }: { tick: number }) {
      const [lay, update] = useState(defaultLayout);
      const host = usePanelHost({
         api,
         state: stateWith(),
         variant,
         lay,
         update: (f) => update(f),
         chat: null,
         host: {},
         panels: PANELS,
         families: NO_FAMILIES,
      });
      out.host = host;
      out.lay = lay;
      out.model = host.models.side as SideChatsModel;
      out.update = (f) => update(f);
      return <span data-tick={tick} />;
   }
   const view = render(<Harness tick={0} />);
   return { out, again: (n: number) => view.rerender(<Harness tick={n} />) };
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
   known = [];
});
afterEach(() => {
   cleanup();
   vi.unstubAllGlobals();
});

const sideOpen = (l: Layout) => isOpen(l, "side");
const stored = () => JSON.parse(localStorage.getItem("harness.chat.sideThreads.s1") ?? "null");

describe("Side chats panel", () => {
   it("a new chat opens a draft tab and shows the panel; its Thread replaces the draft in place", async () => {
      known = ["t1"];
      const { out, again } = setup();
      act(() => void out.model.newThread());
      act(() => void out.model.newThread());
      const draft = out.model.active!;
      expect(draft.startsWith("draft:")).toBe(true);
      // A second "new chat" reuses the open draft.
      expect(out.model.open).toEqual([draft]);
      expect(sideOpen(out.lay)).toBe(true);
      // The draft's Thread starts and takes its tab's place.
      known = ["t1", "t9"];
      await act(async () => {
         await out.model.start("hi", [], { draft });
      });
      again(1);
      expect(out.model.open).toEqual(["t9"]);
      expect(out.model.active).toBe("t9");
      expect(api.prompt).toHaveBeenCalledWith("hi", [], "t9");
      expect(stored()).toEqual({ v: 1, threads: ["t9"], thread: "t9" });
   });

   it("a sent draft keeps the panel, takes the message's title and shows it pending before the replay arrives", async () => {
      const { out, again } = setup();
      act(() => void out.model.newThread());
      const draft = out.model.active!;
      const item = {
         id: "p1",
         prompt: "why is the sky blue",
         inputs: [],
         files: [],
         comments: [],
         snap: {} as never,
         status: "sending" as const,
         base: 0,
      };
      let sent!: () => void;
      vi.mocked(api.prompt).mockImplementationOnce(() => new Promise<void>((r) => (sent = r)));
      let done!: Promise<void>;
      act(() => {
         done = out.model.start("why is the sky blue", [], { draft, item });
      });
      expect(out.model.titleOf(draft)).toBe("why is the sky blue");
      await act(async () => {});
      again(1);
      // "t9" has no replay yet: its tab shows anyway, the panel stays, the message waits there.
      expect(out.model.open).toEqual(["t9"]);
      expect(out.model.titleOf("t9")).toBe("why is the sky blue");
      expect(sideOpen(out.lay)).toBe(true);
      expect(getPendingMessages(composerKey("s1", "t9")).map((p) => p.status)).toEqual(["sending"]);
      await act(async () => {
         sent();
         await done;
      });
      expect(getPendingMessages(composerKey("s1", "t9")).map((p) => p.status)).toEqual(["sent"]);
   });

   it("closing the last tab hides the panel (its icon stays)", () => {
      const { out } = setup();
      act(() => void out.model.newThread());
      expect(sideOpen(out.lay)).toBe(true);
      expect(out.host.statuses.get("side")?.presence).toBe("ready");
      act(() => out.model.close(out.model.active!));
      expect(out.model.open).toEqual([]);
      expect(sideOpen(out.lay)).toBe(false);
      expect(out.host.statuses.get("side")?.presence).toBe("icon");
   });

   it("closing one of two tabs keeps the panel and activates the neighbour", () => {
      known = ["a", "b"];
      localStorage.setItem(
         "harness.chat.sideThreads.s1",
         JSON.stringify({ v: 1, threads: ["a", "b"], thread: "b" }),
      );
      const { out } = setup();
      act(() => out.host.selves.side!.show());
      act(() => out.model.close("b"));
      expect(out.model.open).toEqual(["a"]);
      expect(out.model.active).toBe("a");
      expect(sideOpen(out.lay)).toBe(true);
   });

   it("restores the tabs from the layout's old value when it has no key of its own, and keeps that value", () => {
      known = ["t1"];
      const old = JSON.stringify({ zones: {}, threads: ["t1", "draft:x"], thread: "t1" });
      localStorage.setItem("harness.chat.layout.s1", old);
      const { out } = setup();
      expect(out.model.open).toEqual(["t1", "draft:x"]);
      expect(out.model.active).toBe("t1");
      // Written to its own key at once (the older value is not touched), so the tabs survive a rewrite of it.
      expect(stored()).toEqual({ v: 1, threads: ["t1", "draft:x"], thread: "t1" });
      expect(localStorage.getItem("harness.chat.layout.s1")).toBe(old);
   });

   it("writes nothing for a Session without side chats", () => {
      setup();
      expect(localStorage.getItem("harness.chat.sideThreads.s1")).toBeNull();
   });

   it("Reset layout resets placement only: it does not reopen the panel because tabs exist", () => {
      const { out } = setup();
      act(() => void out.model.newThread());
      expect(sideOpen(out.lay)).toBe(true);
      act(() => out.update(() => resetLayout()));
      expect(sideOpen(out.lay)).toBe(false);
      expect(out.model.open).toHaveLength(1);
   });

   it("the icon shows the last tab, or starts a new chat when there is none", () => {
      known = ["a"];
      localStorage.setItem(
         "harness.chat.sideThreads.s1",
         JSON.stringify({ v: 1, threads: ["a"], thread: "a" }),
      );
      const first = setup();
      expect(sideOpen(first.out.lay)).toBe(false);
      act(() => sideChatsPanel.activate!(first.out.model, first.out.host.selves.side as never));
      expect(sideOpen(first.out.lay)).toBe(true);
      cleanup();
      localStorage.clear();
      const second = setup();
      act(() => sideChatsPanel.activate!(second.out.model, second.out.host.selves.side as never));
      expect(second.out.model.active?.startsWith("draft:")).toBe(true);
      expect(sideOpen(second.out.lay)).toBe(true);
   });

   const press = (init: KeyboardEventInit) =>
      act(() => {
         window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyB", ...init }));
      });

   it("Cmd or Ctrl+Shift+B starts a new chat, and only that exact chord", () => {
      const { out } = setup();
      press({ metaKey: true });
      press({ shiftKey: true });
      press({ metaKey: true, shiftKey: true, altKey: true });
      expect(out.model.open).toEqual([]);
      press({ metaKey: true, shiftKey: true });
      expect(out.model.open).toHaveLength(1);
      expect(sideOpen(out.lay)).toBe(true);
      cleanup();
      localStorage.clear();
      const again = setup();
      press({ ctrlKey: true, shiftKey: true });
      expect(again.out.model.open).toHaveLength(1);
   });

   it("has no shortcut in the Quick Overlay, and keeps its tabs in memory", () => {
      const { out } = setup("overlay");
      press({ metaKey: true, shiftKey: true });
      expect(out.model.open).toEqual([]);
      act(() => void out.model.newThread());
      expect(out.model.open).toHaveLength(1);
      expect(stored()).toBeNull();
   });
});
