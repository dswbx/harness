import { describe, expect, it } from "vitest";
import type { ChatState } from "../../../state/reducer";
import { pendingStage } from "./pendingStage";

const state = (over: Partial<ChatState>) => over as ChatState;

describe("pendingStage", () => {
   it("names the reopen attempt first", () => {
      expect(
         pendingStage(
            state({
               restoring: { attempt: 2, of: 3 },
               process: { state: "starting", message: null },
            }),
         ),
      ).toBe("Reopening session, attempt 2 of 3...");
   });
   it("says the Agent is starting", () => {
      expect(
         pendingStage(state({ restoring: null, process: { state: "starting", message: null } })),
      ).toBe("Starting agent...");
   });
   it("else it is sending", () => {
      expect(pendingStage(state({ restoring: null, process: null }))).toBe("Sending...");
      expect(
         pendingStage(state({ restoring: null, process: { state: "ready", message: null } })),
      ).toBe("Sending...");
   });
});
