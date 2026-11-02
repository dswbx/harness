import { describe, expect, it } from "vitest";
import { parseFence } from "./fence";

describe("parseFence", () => {
  it("one fence: language and code; Read output loses its line numbers", () => {
    expect(parseFence("```console\n12  a.rs\n3  b.rs\n```")).toEqual({ lang: "console", code: "12  a.rs\n3  b.rs" });
    expect(parseFence("```\n4\t{\n5\t  \"a\": 1\n```")).toEqual({ lang: "", code: "{\n  \"a\": 1", from: 4, to: 5 });
  });

  it("prose or more than a fence is not one", () => {
    expect(parseFence("List the 15 largest files")).toBeNull();
    expect(parseFence("```\na\n```\nthen\n```\nb\n```")).toBeNull();
  });
});
