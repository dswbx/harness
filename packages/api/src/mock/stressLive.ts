import type { EventKind } from "../generated";

/** One step of the live stress Turn: `at` ms after it starts, logged in the Main Thread. */
export type StressStep = { at: number; kind: EventKind };

/** Deterministic PRNG (mulberry32), so every run streams the same Turn. */
function rng(seed: number) {
   return () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
   };
}

const LINE =
   "| E-%n | `pg_has_role(oid, text)` | returns 42883 function does not exist | catalog |";
const text = (n: number, lines: number) =>
   Array.from({ length: lines }, (_, i) => LINE.replace("%n", `${n}-${i}`)).join("\n");

/**
 * A long Turn shaped like a real one that strained the chat (`/stress` in the browser mock): the Agent starts
 * `subagents` background subagents, each makes 30 to 80 tool calls (shell, reads, MCP calls, large writes) with
 * thoughts in between, then hands back its report; the Main Thread keeps working meanwhile. About 2,500 Events
 * over `minutes`, with bursts, like the original's 3,000 Events in an hour (compressed). The caller ends the Turn.
 */
export function stressLiveTurn(subagents = 8, minutes = 3): StressStep[] {
   const r = rng(42);
   const span = minutes * 60e3;
   const steps: StressStep[] = [];
   const at = (t: number, kind: EventKind) => steps.push({ at: Math.round(t), kind });
   const update = (id: string, o: Partial<Extract<EventKind, { type: "ToolCallUpdate" }>>) =>
      ({
         type: "ToolCallUpdate",
         tool_call_id: id,
         title: null,
         kind: null,
         status: null,
         content: null,
         locations: null,
         raw_input: null,
         raw_output: null,
         ...o,
      }) as EventKind;
   const output = (body: string) => [{ type: "content", content: { type: "text", text: body } }];
   let n = 0;
   /** One tool call by `parent` (null: the Main Thread) starting at `t`; returns when it ends. */
   const call = (t: number, parent: string | null): number => {
      const id = `stress-call-${n++}`;
      const pick = r();
      const dur = 300 + r() * 4000;
      if (pick < 0.5) {
         const cmd = `cd /Users/me/turso && rg -n "pg_has_role|has_.*_privilege" core/ testing/ # ${n}`;
         at(t, {
            type: "ToolCall",
            tool_call_id: id,
            title: cmd,
            kind: "execute",
            status: null,
            content: [],
            locations: [],
            raw_input: { command: cmd },
            parent_tool_call_id: parent,
            detail: { command: cmd },
         });
         // Shell output streams in, growing.
         for (let u = 1; u <= 3; u++)
            at(
               t + (dur * u) / 4,
               update(id, { content: output(`\`\`\`console\n${text(n, u * 40)}\n\`\`\``) }),
            );
         at(t + dur, update(id, { status: "completed", raw_output: { stdout: text(n, 120) } }));
      } else if (pick < 0.65) {
         const path = `/Users/me/turso/core/function/catalog_${n}.rs`;
         at(t, {
            type: "ToolCall",
            tool_call_id: id,
            title: `Read ${path}`,
            kind: "read",
            status: null,
            content: [],
            locations: [{ path }],
            raw_input: { file_path: path },
            parent_tool_call_id: parent,
         });
         at(t + dur, update(id, { status: "completed", content: output(text(n, 200)) }));
      } else if (pick < 0.9) {
         const issue = `TUR-${40 + (n % 60)}`;
         at(t, {
            type: "ToolCall",
            tool_call_id: id,
            title: "mcp__claude_ai_Linear__save_issue",
            kind: null,
            status: null,
            content: [],
            locations: [],
            raw_input: {
               id: issue,
               title: `Support catalog function ${n}`,
               description: text(n, 30),
            },
            parent_tool_call_id: parent,
            detail: { mcp: { server: "claude_ai_Linear", tool: "save_issue" } },
         } as EventKind);
         at(
            t + dur,
            update(id, {
               status: "completed",
               content: output(`{"id":"${issue}","url":"https://linear.app/x/${issue}"}`),
            }),
         );
      } else {
         // A large write: the whole file in the input and again as a diff (the original had 40 to 100 KB ones).
         const path = `/tmp/gaps/out-${n}.md`;
         const body = text(n, 400 + Math.floor(r() * 600));
         at(t, {
            type: "ToolCall",
            tool_call_id: id,
            title: `Write ${path}`,
            kind: "edit",
            status: null,
            content: [{ type: "diff", path, oldText: null, newText: body }],
            locations: [{ path }],
            raw_input: { file_path: path, content: body },
            parent_tool_call_id: parent,
            detail: { op: "write" },
         } as EventKind);
         at(t + dur, update(id, { status: "completed" }));
      }
      return t + dur;
   };

   for (let s = 0; s < subagents; s++) {
      const task = `stress-task-${s}`;
      const start = 2000 + s * 1500;
      const title = `Draft E${s * 3 + 2}-E${s * 3 + 4} catalog issues`;
      at(start, {
         type: "ToolCall",
         tool_call_id: task,
         title: "Task",
         kind: "think",
         status: null,
         content: [],
         locations: [],
         raw_input: {},
      });
      at(start + 50, update(task, { title, raw_input: { description: title, model: "opus" } }));
      at(
         start + 100,
         update(task, {
            raw_input: { description: title, model: "opus", run_in_background: true },
         }),
      );
      at(
         start + 150,
         update(task, {
            content: output(
               `Read /tmp/gaps/brief.md first. Your items: ${title}.\n\n${text(s, 20)}`,
            ),
         }),
      );
      at(
         start + 400,
         update(task, {
            status: "completed",
            content: output("Async agent launched successfully."),
            background: true,
         } as never),
      );
      const calls = 30 + Math.floor(r() * 50);
      const end = span * (0.6 + r() * 0.35);
      let t = start + 500;
      for (let c = 0; c < calls && t < end; c++) {
         if (r() < 0.4)
            for (let k = 0; k < 4; k++)
               at(t + k * 40, {
                  type: "AgentThoughtChunk",
                  text: "Checking the next gap against the tests. ",
                  parent_tool_call_id: task,
               });
         // Some calls run in parallel with the next one.
         const done = call(t, task);
         t = r() < 0.3 ? t + 200 : done + 100 + r() * 1500;
      }
      at(t, {
         type: "ToolCall",
         tool_call_id: `stress-handback-${s}`,
         title: "SubagentHandback",
         kind: null,
         status: null,
         content: [],
         locations: [],
         raw_input: { message: `I wrote ${calls} drafts.` },
         parent_tool_call_id: task,
         report: `I wrote drafts for ${title}.\n\n${text(s, 15)}`,
      } as EventKind);
   }
   // The Main Thread: usage updates, its own calls, and a running reply.
   for (let t = 1000; t < span; t += 2000 + r() * 3000)
      at(t, {
         type: "UsageUpdated",
         usage: { used: 50000 + t / 10, size: 200000 },
         used: 50000 + t / 10,
         size: 200000,
      } as EventKind);
   for (let t = 20000; t < span; t += 8000 + r() * 8000) call(t, null);
   const reply = `All ${subagents} subagents reported. The drafts are in \`/tmp/gaps/\`. ${"Each draft lists the gap, the test and the fix. ".repeat(20)}`;
   for (let i = 0; i < reply.length; i += 30)
      at(span + i * 2, { type: "AgentMessageChunk", text: reply.slice(i, i + 30) });
   return steps.sort((a, b) => a.at - b.at);
}
