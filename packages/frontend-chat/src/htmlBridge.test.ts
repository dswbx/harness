import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HTML_CSP, onceEach } from "./htmlBridge";

describe("HTML_CSP", () => {
   it("allows no network, images only from data: and blob:", () => {
      expect(HTML_CSP).toContain("connect-src 'none'");
      expect(HTML_CSP).toContain("img-src data: blob:;");
      expect(HTML_CSP).not.toMatch(/https?:/);
   });

   it("is the same string as the Tauri harness-frame header", () => {
      const rs = readFileSync(
         new URL("../../../crates/harness-tauri/src/lib.rs", import.meta.url),
         "utf8",
      );
      expect(rs).toContain(`const FRAME_CSP: &str = "${HTML_CSP}";`);
   });
});

describe("onceEach", () => {
   it("reports each message once, at most max in all", () => {
      const sent: string[] = [];
      const report = onceEach((m) => sent.push(m), 2);
      for (const m of ["a", "a", "b", "a", "c"]) report(m);
      expect(sent).toEqual(["a", "b"]);
   });
});
