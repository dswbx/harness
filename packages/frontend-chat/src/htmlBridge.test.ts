import { describe, expect, it } from "vitest";
import { onceEach } from "./htmlBridge";

describe("onceEach", () => {
   it("reports each message once, at most max in all", () => {
      const sent: string[] = [];
      const report = onceEach((m) => sent.push(m), 2);
      for (const m of ["a", "a", "b", "a", "c"]) report(m);
      expect(sent).toEqual(["a", "b"]);
   });
});
