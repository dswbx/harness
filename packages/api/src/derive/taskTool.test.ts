import { describe, expect, it } from "vitest";
import { taskToolSummary } from "./taskTool";

const call = (harnessTool: string | null, rawInput: unknown, rawOutput: unknown) =>
   taskToolSummary({ harnessTool, rawInput, rawOutput });
const blocks = (v: unknown) => [{ type: "text", text: JSON.stringify(v, null, 2) }];

describe("taskToolSummary", () => {
   it("add: rows from the result", () => {
      expect(
         call(
            "task_add",
            { tasks: [{ title: "Cache target" }, { title: "Skip install" }] },
            blocks({
               tasks: [
                  { id: "t6", title: "Cache target", status: "todo" },
                  { id: "t7", title: "Skip install", status: "in_progress" },
               ],
            }),
         ),
      ).toEqual({
         tool: "task_add",
         tasks: [
            { id: "t6", title: "Cache target", status: "todo" },
            { id: "t7", title: "Skip install", status: "in_progress" },
         ],
      });
   });

   it("add: before the result, the input's titles; rows without a title dropped", () => {
      expect(
         call(
            "task_add",
            { tasks: [{ title: " A " }, { body: "x" }, { title: "B", status: "done" }] },
            null,
         ),
      ).toEqual({ tool: "task_add", tasks: [{ title: "A" }, { title: "B", status: "done" }] });
      expect(call("task_add", { tasks: "nope" }, null)).toEqual({ tool: "task_add", tasks: [] });
   });

   it("update: the changes from the input, the row from the result", () => {
      expect(
         call(
            "task_update",
            { id: "t3", status: "in_review", due: "", parent: null, body: "x", priority: "bad" },
            blocks({ tasks: [{ id: "t3", title: "Fix the check", status: "in_review" }] }),
         ),
      ).toEqual({
         tool: "task_update",
         tasks: [{ id: "t3", title: "Fix the check", status: "in_review" }],
         changes: { status: "in_review", due: null, parent: null, body: true },
      });
   });

   it("update: a refusal is the error, the row is the id", () => {
      expect(
         call(
            "task_update",
            { id: "t1", parent: "t2" },
            "```\ntask t1 was not created in this Session. Ask the user to change it.\n```",
         ),
      ).toEqual({
         tool: "task_update",
         tasks: [{ id: "t1", title: "t1" }],
         changes: { parent: "t2" },
         error: "task t1 was not created in this Session. Ask the user to change it.",
      });
   });

   it("null for other tools", () => {
      expect(call("task_list", {}, null)).toBeNull();
      expect(call(null, {}, null)).toBeNull();
   });
});
