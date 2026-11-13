/**
 * What a Harness sub session tool call (`session_start`, `session_send`, `session_wait`) did, read
 * from its raw input and JSON output (ADR 0012, shared helper). Parsing is defensive: anything
 * unreadable just leaves a field out.
 */
import { FENCED, failure, type GitToolCall, parseJson, textOf } from "./gitTool";

export const SUB_SESSION_TOOLS = ["session_start", "session_send", "session_wait"] as const;

export type SubSessionToolSummary = {
   sessionId?: string;
   title?: string;
   /** session_start: the repository's folder name (else the folder's). */
   repo?: string;
   branch?: string;
   model?: string;
   effort?: string;
   /** session_start: the first prompt. */
   prompt?: string;
   /** session_send: the message. */
   text?: string;
   /** session_wait: the sub session's last reply, how long its last Turn took, and its state. */
   reply?: string;
   durationMs?: number;
   status?: "idle" | "needs_attention" | "working";
   stopReason?: string;
   /** The first line of the failure text. */
   error?: string;
};

const str = (v: unknown): string | undefined =>
   typeof v === "string" && v.trim() ? v.trim() : undefined;

/** Last part of a path: `/a/b/harness` → `harness`. */
const baseName = (p: string) =>
   p
      .replace(/[/\\]+$/, "")
      .split(/[/\\]/)
      .pop() || p;

export function subSessionToolSummary(tool: GitToolCall): SubSessionToolSummary | null {
   const { harnessTool, rawInput, rawOutput, content } = tool;
   if (!harnessTool || !(SUB_SESSION_TOOLS as readonly string[]).includes(harnessTool)) return null;
   const input = (rawInput && typeof rawInput === "object" ? rawInput : {}) as Record<
      string,
      unknown
   >;
   const texts = [textOf(content), textOf(rawOutput)].filter((t): t is string => t !== null);
   const out: SubSessionToolSummary = {};
   const error = texts.map(failure).find((e) => e !== undefined);
   if (error) out.error = error;
   const text = texts.find((t) => !FENCED.test(t));
   const parsed = text === undefined ? undefined : parseJson(text);
   const r = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;

   const id = str(r.session_id) ?? str(input.id);
   if (id) out.sessionId = id;
   const title = str(r.title) ?? (harnessTool === "session_start" ? str(input.title) : undefined);
   if (title) out.title = title;
   switch (harnessTool) {
      case "session_start": {
         const repo = str(r.repo) ?? str(r.folder) ?? str(input.folder);
         if (repo) out.repo = baseName(repo);
         const branch = str(r.branch) ?? str(input.branch);
         if (branch) out.branch = branch;
         const model = str(r.model) ?? str(input.model);
         if (model) out.model = model;
         const effort = str(r.effort) ?? str(input.effort);
         if (effort) out.effort = effort;
         const prompt = str(input.prompt);
         if (prompt) out.prompt = prompt;
         break;
      }
      case "session_send": {
         const message = str(input.text);
         if (message) out.text = message;
         break;
      }
      case "session_wait": {
         if (typeof r.reply === "string" && r.reply.trim()) out.reply = r.reply;
         if (typeof r.duration_ms === "number") out.durationMs = r.duration_ms;
         if (r.status === "idle" || r.status === "needs_attention" || r.status === "working")
            out.status = r.status;
         const stop = str(r.stop_reason);
         if (stop) out.stopReason = stop;
         break;
      }
   }
   return out;
}
