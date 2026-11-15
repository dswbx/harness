import type { Event } from "@harness/api";
import { listSubagents } from "@harness/api";
import { describe, expect, it } from "vitest";
import { type ChatState, initialState } from "../../state/reducer";
import { syntheticLog } from "../../state/syntheticLog";
import { collectArtifacts } from "../artifacts/artifacts";
import { collectReferences } from "../references/references";
import { reduceBatch } from "../renderUi/chatReducer";
import { chatRowsOf, renderUiOf, stabilizeRows } from "./chatRows";

const chunk = (seq: number): Event => ({
   v: 1,
   seq,
   session_id: "s",
   thread_id: "main",
   ts_ms: 0,
   kind: { type: "AgentMessageChunk", text: "more words " },
});

/** `n` Task calls (background subagents), each with a few calls of its own. */
function subagentEvents(from: number, n: number): Event[] {
   const out: Event[] = [];
   const push = (kind: Event["kind"]) =>
      out.push({
         v: 1,
         seq: from + out.length,
         session_id: "s",
         thread_id: "main",
         ts_ms: 0,
         kind,
      });
   const call = (id: string, parent: string | null, title: string): Event["kind"] => ({
      type: "ToolCall",
      tool_call_id: id,
      title,
      kind: "other",
      status: "in_progress",
      content: [],
      locations: null,
      raw_input: {},
      parent_tool_call_id: parent,
   });
   for (let i = 0; i < n; i++) {
      push(call(`task${i}`, null, "Task"));
      for (let j = 0; j < 5; j++) push(call(`task${i}-c${j}`, `task${i}`, "Read"));
   }
   return out;
}

const PROSE = "Some prose that explains what changed and why, with `code` and **emphasis**. ";
const BODY = `${PROSE.repeat(6)}\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n\`\`\`ts\nconst x = 1;\n\`\`\`\n\n${PROSE.repeat(6)}`;

/** `n` finished Turns whose answer is a long Markdown message (a table and a code block in it). */
function longTurns(from: number, n: number): Event[] {
   const out: Event[] = [];
   const push = (kind: Event["kind"]) =>
      out.push({
         v: 1,
         seq: from + out.length,
         session_id: "s",
         thread_id: "main",
         ts_ms: 0,
         kind,
      });
   for (let i = 0; i < n; i++) {
      push({ type: "TurnStarted", turn_id: `L${i}`, text: `long ${i}` });
      push({ type: "AgentMessageChunk", text: BODY });
      push({ type: "TurnEnded", turn_id: `L${i}`, stop_reason: "end_turn" });
   }
   return out;
}

/** What the host derives from `items` per frame batch, outside React: the rows and the panel models. */
let last: ReturnType<typeof chatRowsOf> | null = null;
const stages: Record<string, number[]> = {};
const timed = <T>(name: string, f: () => T): T => {
   const t0 = performance.now();
   const r = f();
   (stages[name] ??= []).push(performance.now() - t0);
   return r;
};
function derive(state: ChatState) {
   const ui = timed("renderUi", () => renderUiOf(state.items, state.sharedAttached));
   const { rows, subagents } = timed(
      "rows",
      () => (last = stabilizeRows(last, chatRowsOf(state.items, ui))),
   );
   const artifacts = timed("artifacts", () => collectArtifacts(state.items));
   // The References panel, once opened.
   const references = timed("references", () => collectReferences(state.items));
   // The Subagents panel, as `subagentsPanel.useModel` builds it.
   const sub = timed("subagents", () =>
      subagents.size === 0
         ? []
         : listSubagents(
              state.items.flatMap((i) => (i.type === "tool" ? [i] : [])),
              subagents,
              true,
           ),
   );
   return { rows, subagents, artifacts, references, sub };
}

describe("cost of one streamed chunk in a long Session", () => {
   it("derive work stays bounded and unchanged rows keep their identity", () => {
      const log = syntheticLog();
      const more = [...subagentEvents(log.length, 20), ...longTurns(log.length + 200, 300)];
      const base = reduceBatch(initialState(), [...log, ...more]);
      // Open a message to stream into.
      let state = reduceBatch(base, [chunk(40_000)]);
      expect(derive(state).subagents.size).toBe(20);
      derive(state);
      const times: number[] = [];
      let prev = derive(state);
      let changed = 0;
      let sameSubagents = false;
      for (let i = 0; i < 20; i++) {
         state = reduceBatch(state, [chunk(40_001 + i)]);
         const t0 = performance.now();
         const next = derive(state);
         times.push(performance.now() - t0);
         if (i === 19) {
            changed = next.rows.filter((r, n) => r !== prev.rows[n]).length;
            expect(next.rows.length).toBe(prev.rows.length);
            sameSubagents = next.subagents === prev.subagents;
         }
         prev = next;
      }
      const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1]!;
      console.log(
         `  per stage (median ms): ${Object.entries(stages)
            .map(([k, v]) => `${k} ${med(v).toFixed(2)}`)
            .join(", ")}`,
      );
      times.sort((a, b) => a - b);
      const median = times[times.length >> 1]!;
      console.log(
         `stream chunk after 20k events: derive median ${median.toFixed(2)} ms, ` +
            `rows with a new identity ${changed}/${prev.rows.length}, subagents Map kept: ${sameSubagents}`,
      );
      expect(sameSubagents).toBe(true);
      expect(changed).toBeLessThanOrEqual(2);
      expect(median).toBeLessThan(40);
   });
});
