import { describe, expect, it } from "vitest";
import {
   INITIAL_OVERLAY,
   type OverlayAction,
   type OverlayState,
   overlayReducer,
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

   it("hides the prompt on the shortcut, Esc or Cmd+M, and keeps the draft", () => {
      expect(run("shown", "shortcut")).toEqual({ mode: "prompt", visible: false, newReply: false });
      expect(run("shown", "minimize").visible).toBe(false);
      expect(run("shown", "shortcut", "shown")).toEqual(run("shown"));
   });

   it("switches a pinned chat between chat and mini on the shortcut", () => {
      expect(run("shown", "sent", "shortcut").mode).toBe("mini");
      expect(run("shown", "sent", "shortcut", "shortcut").mode).toBe("chat");
      expect(run("shown", "sent", "shortcut").visible).toBe(true);
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
