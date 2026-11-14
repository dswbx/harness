import type { AgentInfo } from "@harness/api";
import { describe, expect, it } from "vitest";
import { checkLine, parseEnvLines } from "./agents";

const agent = (check: unknown): AgentInfo =>
   ({ id: "a", install: check === undefined ? null : { check } }) as unknown as AgentInfo;

describe("checkLine", () => {
   it("nothing without an install or a check", () => {
      expect(checkLine({ id: "a" } as AgentInfo)).toBeNull();
      expect(checkLine(agent(undefined))).toBeNull();
      expect(checkLine(agent(null))).toBeNull();
   });
   it("a passed check", () => {
      expect(checkLine(agent({ passed: true, version: "1.2.3", auth_required: false }))).toEqual({
         ok: true,
         text: "v1.2.3 check passed",
      });
   });
   it("a passed check that needs a sign-in", () => {
      expect(checkLine(agent({ passed: true, version: "1.2.3", auth_required: true }))).toEqual({
         ok: true,
         text: "v1.2.3 check passed (sign-in needed)",
      });
   });
   it("a failed check: only the first line of the error", () => {
      expect(
         checkLine(agent({ passed: false, version: "2.0.0", error: "boom\nstack line\nmore" })),
      ).toEqual({ ok: false, text: "Update to v2.0.0 was refused, check failed: boom" });
   });
   it("a failed check without an error text", () => {
      expect(checkLine(agent({ passed: false, version: "2.0.0" }))).toEqual({
         ok: false,
         text: "Update to v2.0.0 was refused, check failed: ",
      });
   });
});

describe("parseEnvLines", () => {
   it("KEY=VALUE per line", () => {
      expect(parseEnvLines("A=1\nB=two")).toEqual({ A: "1", B: "two" });
   });
   it("empty text and blank lines give nothing", () => {
      expect(parseEnvLines("")).toEqual({});
      expect(parseEnvLines("\n  \n\t\n")).toEqual({});
      expect(parseEnvLines("A=1\n\n\nB=2\n")).toEqual({ A: "1", B: "2" });
   });
   it("the line and the key are trimmed, the value is kept as typed after the first =", () => {
      expect(parseEnvLines("  KEY  = a b \n")).toEqual({ KEY: " a b" });
      expect(parseEnvLines("URL=https://x/?a=b=c")).toEqual({ URL: "https://x/?a=b=c" });
   });
   it("an empty value is allowed", () => {
      expect(parseEnvLines("EMPTY=")).toEqual({ EMPTY: "" });
   });
   it("a later line of the same key wins", () => {
      expect(parseEnvLines("A=1\nA=2")).toEqual({ A: "2" });
   });
   it("handles CRLF line ends (the trim drops the CR)", () => {
      expect(parseEnvLines("A=1\r\nB=2\r\n")).toEqual({ A: "1", B: "2" });
   });
   it("throws for a line without = or without a key", () => {
      expect(() => parseEnvLines("A=1\nnope")).toThrow(
         'Invalid env line "nope", expected KEY=VALUE',
      );
      expect(() => parseEnvLines("=x")).toThrow('Invalid env line "=x"');
   });
});
