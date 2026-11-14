import { describe, expect, it } from "vitest";
import { commandOf, jsonTail, parseFence } from "./fence";

describe("parseFence", () => {
   it("one fence: language and code; Read output loses its line numbers", () => {
      expect(parseFence("```console\n12  a.rs\n3  b.rs\n```")).toEqual({
         lang: "console",
         code: "12  a.rs\n3  b.rs",
      });
      expect(parseFence('```\n4\t{\n5\t  "a": 1\n```', true)).toEqual({
         lang: "",
         code: '{\n  "a": 1',
         from: 4,
         to: 5,
      });
      // `wc -l` counts look the same but are not a range; outside Read, numbers stay.
      expect(parseFence("```\n1290\ta.rs\n158\tb.rs\n```", true)).toEqual({
         lang: "",
         code: "1290\ta.rs\n158\tb.rs",
      });
      expect(parseFence("```\n4\t{\n5\t}\n```")).toEqual({ lang: "", code: "4\t{\n5\t}" });
   });

   it("prose or more than a fence is not one", () => {
      expect(parseFence("List the 15 largest files")).toBeNull();
      expect(parseFence("```\na\n```\nthen\n```\nb\n```")).toBeNull();
   });
});

describe("jsonTail", () => {
   it("whole JSON or prose then JSON, pretty-printed", () => {
      expect(jsonTail('{ "items": [], "a": 1 }')).toEqual({
         prose: "",
         json: '{\n  "items": [],\n  "a": 1\n}',
      });
      expect(jsonTail('Done (x.json). Live items: [{"id":"a"}]')).toEqual({
         prose: "Done (x.json). Live items:",
         json: '[\n  {\n    "id": "a"\n  }\n]',
      });
   });

   it("no JSON, or only an empty value", () => {
      expect(jsonTail("Done. Live items: []")).toBeNull();
      expect(jsonTail("see [a](b)")).toBeNull();
      expect(jsonTail("plain text")).toBeNull();
   });
});

describe("commandOf", () => {
   it("string, argv or title", () => {
      expect(commandOf({ command: "ls -la" }, "ls")).toBe("ls -la");
      expect(commandOf({ command: ["bash", "-lc", "git status"] }, "x")).toBe("git status");
      expect(commandOf({ command: ["git", "status"] }, "x")).toBe("git status");
      expect(commandOf({}, "git diff")).toBe("git diff");
      expect(commandOf(null, "Terminal")).toBeNull();
   });
});
