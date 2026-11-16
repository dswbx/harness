import type { SessionSummary } from "@harness/api";
import { describe, expect, it } from "vitest";
import { isTurnNotice, stopText } from "./useTurnNotices";

const ev = (session_id: string, unseen: boolean) =>
   ({
      type: "SessionStatus",
      session_id,
      title: "t",
      status: "idle",
      unused: false,
      unseen,
   }) as const;
const s = (id: string, over: Partial<SessionSummary> = {}) => ({ id, ...over }) as SessionSummary;

describe("isTurnNotice", () => {
   it("tells a Session that just became unseen, out of view", () => {
      expect(isTurnNotice(ev("a", true), false, s("a"), "b")).toBe(true);
   });
   it("not the shown Session, not again while unseen, not when seen", () => {
      expect(isTurnNotice(ev("a", true), false, s("a"), "a")).toBe(false);
      expect(isTurnNotice(ev("a", true), true, s("a"), "b")).toBe(false);
      expect(isTurnNotice(ev("a", false), true, s("a"), "b")).toBe(false);
   });
   it("not a Sub Session that reports to its parent's Agent", () => {
      const parent = { session_id: "p", thread_id: "t", notify: true };
      expect(isTurnNotice(ev("a", true), false, s("a", { parent }), "b")).toBe(false);
      expect(
         isTurnNotice(ev("a", true), false, s("a", { parent: { ...parent, notify: false } }), "b"),
      ).toBe(true);
   });
});

describe("stopText", () => {
   it("names how the Turn ended", () => {
      expect(stopText("end_turn")).toBe("Finished");
      expect(stopText("error")).toBe("Failed");
      expect(stopText("auth_required")).toBe("Needs you to sign in");
   });
});
