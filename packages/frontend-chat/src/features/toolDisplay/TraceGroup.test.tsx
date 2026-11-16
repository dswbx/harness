import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Step, Tool } from "./group";
import { groupSummary, TraceGroup, VISIBLE_STEPS } from "./TraceGroup";

let n = 0;
const tool = (over: Partial<Tool> = {}): Tool => ({
   type: "tool",
   id: `t${++n}`,
   title: `step ${n}`,
   kind: "execute",
   status: "completed",
   content: [],
   locations: null,
   rawInput: null,
   rawOutput: null,
   parent: null,
   background: false,
   report: null,
   harnessTool: null,
   subagentPrompt: null,
   subagentMeta: null,
   ts: 1000 * n,
   endedAt: 1000 * n + 500,
   commitMessage: null,
   ...over,
});
const lines = () => document.querySelectorAll("[data-step]").length;
const show = (steps: Step[], streaming: boolean) =>
   render(
      <TraceGroup steps={steps} subagents={new Map()} active={streaming} streaming={streaming} />,
   );

afterEach(cleanup);

describe("groupSummary", () => {
   it("counts calls by kind, failures and time", () => {
      const s = groupSummary([
         tool({ kind: "execute", ts: 1000, endedAt: 2000 }),
         tool({ kind: "execute", status: "failed", ts: 2000, endedAt: 3000 }),
         tool({ kind: "edit", ts: 3000, endedAt: 9000 }),
         { type: "thought", id: "th", text: "", ts: 4000, parent: null },
      ]);
      expect(s).toEqual({ calls: 3, parts: ["2 commands", "1 edit"], failed: 1, durationMs: 8000 });
   });
});

describe("TraceGroup", () => {
   it("shows a lone finished step as is", () => {
      show([tool()], false);
      expect(screen.queryByRole("button", { expanded: false })).toBeNull();
      expect(lines()).toBe(1);
   });

   it("while running shows the last steps, all on a click", () => {
      const steps = Array.from({ length: 10 }, () => tool());
      show(steps, true);
      expect(screen.getByText("Working")).toBeTruthy();
      expect(lines()).toBe(VISIBLE_STEPS);
      expect(screen.getByText("Show all · 6 more")).toBeTruthy();
      fireEvent.click(screen.getByText("Working"));
      expect(lines()).toBe(10);
   });

   it("once done collapses to one line, opens on a click", () => {
      show([tool(), tool({ kind: "edit" }), tool({ status: "failed" })], false);
      expect(screen.getByText("Ran 3 tool calls")).toBeTruthy();
      expect(screen.getByText("1 failed")).toBeTruthy();
      expect(lines()).toBe(0);
      fireEvent.click(screen.getByText("Ran 3 tool calls"));
      expect(lines()).toBe(3);
   });
});
