import { describe, expect, it } from "vitest";
import { HarnessClient } from "./client";
import { CommandError, errText, isCommandError, toCommandError } from "./errors";
import { MockTransport } from "./mock";
import type { Transport } from "./transport";

describe("CommandError", () => {
   it("reads the core's { code, message } shape", () => {
      const e = toCommandError({ code: "not_found", message: "unknown session x" });
      expect(e).toBeInstanceOf(Error);
      expect(isCommandError(e, "not_found")).toBe(true);
      expect(isCommandError(e, "conflict")).toBe(false);
      expect(e.message).toBe("unknown session x");
   });

   it("makes anything else internal", () => {
      expect(toCommandError("boom")).toMatchObject({ code: "internal", message: "boom" });
      expect(toCommandError(new Error("bad"))).toMatchObject({ code: "internal", message: "bad" });
      expect(toCommandError({ code: "nope", message: "m" }).code).toBe("internal");
      const same = new CommandError("conflict", "c");
      expect(toCommandError(same)).toBe(same);
   });

   it("errText: the message of any failure", () => {
      expect(errText(new CommandError("conflict", "taken"))).toBe("taken");
      expect(errText({ code: "not_found", message: "unknown session x" })).toBe(
         "unknown session x",
      );
      expect(errText(new Error("bad"))).toBe("bad");
      expect(errText("boom")).toBe("boom");
      expect(errText({ a: 1 })).toBe('{"a":1}');
   });

   it("the mock transport rejects with codes", async () => {
      const t = new MockTransport([], []) as Transport;
      await expect(t.execute({ type: "GitStatus", session_id: "nope" })).rejects.toMatchObject({
         code: "not_found",
      });
      const client = new HarnessClient(new MockTransport([], []));
      await expect(client.archiveSession("nope")).rejects.toSatisfy((e) =>
         isCommandError(e, "not_found"),
      );
   });
});
