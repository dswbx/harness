import { describe, expect, it } from "vitest";
import {
   INITIAL_OVERLAY,
   type OverlayAction,
   type OverlayState,
   overlayReducer,
   rowEdge,
} from "./overlayMode";

const run = (...actions: OverlayAction["type"][]) =>
   actions.reduce<OverlayState>((s, type) => overlayReducer(s, { type }), INITIAL_OVERLAY);

describe("overlayReducer", () => {
   it("starts hidden on the prompt", () =>
      expect(INITIAL_OVERLAY).toEqual({ mode: "prompt", visible: false, newReply: false }));

   it("shows the prompt, then the chat after the first message", () => {
      expect(run("shown")).toEqual({ mode: "prompt", visible: true, newReply: false });
      expect(run("shown", "sent").mode).toBe("chat");
   });

   it("hides the prompt on Esc or Cmd+M, and keeps the draft", () => {
      expect(run("shown", "minimize")).toEqual({ mode: "prompt", visible: false, newReply: false });
      expect(run("shown", "minimize", "shown")).toEqual(run("shown"));
   });

   it("the shortcut only opens: keeps the prompt and the chat, expands mini", () => {
      expect(run("shown", "shortcut")).toEqual(run("shown"));
      expect(run("shown", "sent", "shortcut")).toEqual(run("shown", "sent"));
      expect(run("shown", "sent", "minimize", "shortcut").mode).toBe("chat");
   });

   it("minimizes and expands", () => {
      expect(run("shown", "sent", "minimize").mode).toBe("mini");
      expect(run("shown", "sent", "minimize", "minimize").mode).toBe("mini");
      expect(run("shown", "sent", "minimize", "expand").mode).toBe("chat");
      expect(run("shown", "sent", "expand").mode).toBe("chat");
   });

   it("marks a reply that ended while mini, and clears it on expand", () => {
      expect(run("shown", "sent", "turnFinished").newReply).toBe(false);
      expect(run("shown", "sent", "minimize", "turnFinished").newReply).toBe(true);
      expect(run("shown", "sent", "minimize", "turnFinished", "expand").newReply).toBe(false);
      expect(run("shown", "sent", "minimize", "turnFinished", "shortcut").newReply).toBe(false);
   });

   it("a later title change does not move a chat back", () =>
      expect(run("shown", "sent", "minimize", "sent").mode).toBe("mini"));

   it("resets to a hidden prompt on close or merge", () =>
      expect(run("shown", "sent", "minimize", "turnFinished", "reset")).toEqual(INITIAL_OVERLAY));

   it("returns the same state when nothing changes", () => {
      const s = run("shown");
      expect(overlayReducer(s, { type: "shown" })).toBe(s);
      expect(overlayReducer(s, { type: "expand" })).toBe(s);
      expect(overlayReducer(s, { type: "turnFinished" })).toBe(s);
   });
});

describe("rowEdge", () => {
   it("keeps the right edge when only the left side changes", () => {
      expect(rowEdge({ left: 0, right: 420 }, { left: 320, right: 420 })).toBe("right");
      expect(rowEdge({ left: 320, right: 0 }, { left: 0, right: 0 })).toBe("right");
   });
   it("keeps the left edge when the right side (or both) changes", () => {
      expect(rowEdge({ left: 320, right: 0 }, { left: 320, right: 420 })).toBe("left");
      expect(rowEdge({ left: 0, right: 0 }, { left: 320, right: 420 })).toBe("left");
   });
});
