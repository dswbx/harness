import { CommandError } from "@harness/api";
import { describe, expect, it } from "vitest";
import { needsEditor } from "./editorError";

describe("needsEditor", () => {
   it("is the core's invalid code, whatever the text says", () => {
      expect(needsEditor(new CommandError("invalid", "pick one in Settings"))).toBe(true);
      expect(needsEditor(new CommandError("internal", "choose an editor in Settings first"))).toBe(
         false,
      );
      expect(needsEditor(new CommandError("not_found", "unknown shared artifact"))).toBe(false);
      expect(needsEditor(new Error("invalid"))).toBe(false);
   });
});
