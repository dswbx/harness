import type { Event, EventKind } from "@harness/api";

/** A long synthetic Session (open the app with `?stress`) shaped like a long real one: ~20 turns, each with a hook
 * notice, shell calls with large streamed output, usage updates, and a reply full of inline code, file refs, a table
 * and a code block. For profiling the chat. */
export function stressEvents(turns = 21): Event[] {
   let seq = 0;
   const t0 = Date.now() - 3600e3;
   const ev = (kind: EventKind): Event => ({
      v: 1,
      seq: seq++,
      session_id: "mock",
      thread_id: "main",
      ts_ms: t0 + seq * 500,
      kind,
   });
   const out: Event[] = [
      ev({
         type: "SessionCreated",
         title: "stress",
         frontend_id: "chat",
         agent_id: "claude",
         folder: "/mock/project",
      } as EventKind),
   ];
   const output = (n: number, lines: number) =>
      Array.from(
         { length: lines },
         (_, i) =>
            `src/widgets/panel.ts:${i + 1}:   widget.update("item${n}-${i}", opts); // ${"x".repeat(40)}`,
      ).join("\n");
   for (let t = 0; t < turns; t++) {
      const turn = `stress-t${t}`;
      out.push(
         ev({
            type: "TurnStarted",
            turn_id: turn,
            text: `Question ${t}: when does \`fix_something\` run?`,
         }),
         ev({
            type: "AgentNotice",
            severity: "info",
            title: "SessionStart says: [example-hook] Context loaded",
            description: null,
         }),
      );
      for (let c = 0; c < 3; c++) {
         const id = `stress-${t}-${c}`;
         const cmd = `rg -n "fix_something" src lib --glob '!dist' # ${t}.${c}`;
         out.push(
            ev({
               type: "ToolCall",
               tool_call_id: id,
               title: cmd,
               kind: "execute",
               status: "in_progress",
               content: [],
               locations: [],
               raw_input: { command: cmd },
            }),
         );
         for (let u = 1; u <= 4; u++) {
            const text = output(t * 10 + c, u * 30);
            out.push(
               ev({
                  type: "ToolCallUpdate",
                  tool_call_id: id,
                  title: null,
                  kind: null,
                  status: u === 4 ? "completed" : null,
                  content: [
                     {
                        type: "content",
                        content: { type: "text", text: `\`\`\`console\n${text}\n\`\`\`` },
                     },
                  ],
                  locations: null,
                  raw_input: null,
                  raw_output: u === 4 ? { stdout: text } : null,
               }),
            );
         }
         for (let k = 0; k < 3; k++)
            out.push(
               ev({ type: "UsageUpdated", usage: { used: 1000 * (t + 1) + k, size: 200000 } }),
            );
      }
      const reply =
         `\`fix_something\` rebuilds the widget list (\`Registry\`). Cases:\n\n` +
         `| Case | Where | When |\n| --- | --- | --- |\n` +
         Array.from(
            { length: 6 },
            (_, i) =>
               `| \`Widget::refresh\` | \`lib/widgets/src/lib.rs:${120 + i}\` | After \`load_items\`, see \`src/server/router.ts:${4 + i}\` and \`server/router.ts:${40 + i}\` |`,
         ).join("\n") +
         `\n\nThe \`Mode::Full\` path calls \`fix_something()\` once; \`Mode::Quick\` skips it. ` +
         `See \`docs/guide.md\`, \`package.json\`, \`src/hello.ts:2\` and \`missing/file.rs:9\`.\n\n` +
         "```rust\npub fn refresh(&self, input: &str) -> Result<()> {\n    self.apply(input)?;\n    self.fix_something()\n}\n```\n";
      // Streamed in small chunks, like an Agent does.
      for (let i = 0; i < reply.length; i += 40)
         out.push(ev({ type: "AgentMessageChunk", text: reply.slice(i, i + 40) }));
      out.push(ev({ type: "TurnEnded", turn_id: turn, stop_reason: "end_turn" }));
   }
   return out;
}
