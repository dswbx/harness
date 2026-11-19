import type { InstructionsEntry } from "@harness/api";
import { describe, expect, test } from "vitest";
import { repoHints } from "./repoHints";

const repo = (path: string): InstructionsEntry => ({
   scope: { type: "repo", path },
   name: path.split("/").at(-1) ?? path,
   lines: 0,
   folder_exists: true,
});

describe("repoHints", () => {
   test("only repeated names get their parent folder", () => {
      const hints = repoHints([
         { scope: { type: "global" }, name: "Global", lines: 0, folder_exists: true },
         repo("/home/sam/code/spark"),
         repo("/home/sam/code/spark/spark"),
         repo("/home/sam/code/demo-app"),
      ]);
      expect([...hints]).toEqual([
         ["/home/sam/code/spark", "code"],
         ["/home/sam/code/spark/spark", "spark"],
      ]);
   });
});
