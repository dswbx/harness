/**
 * What a Harness sub session tool call (`session_start`, `session_send`, `session_wait`,
 * `session_list`) did, read
 * from its raw input and JSON output (ADR 0012, shared helper). Parsing is defensive: anything
 * unreadable just leaves a field out.
 */
import { failure, type GitToolCall, harnessResult, textOf } from "./gitTool";
import { baseName } from "./paths";

export const SUB_SESSION_TOOLS = [
   "session_start",
   "session_send",
   "session_wait",
   "session_list",
] as const;

export type SubSessionStatus = "idle" | "needs_attention" | "working";

/** One row of `session_list`. */
export type SubSessionRow = {
   sessionId: string;
   title: string;
   repo?: string;
   status?: SubSessionStatus;
   archived?: boolean;
};

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
   status?: SubSessionStatus;
   stopReason?: string;
   /** session_wait with `timeout_s: 0`: only checked the status. */
   check?: boolean;
   /** session_list: every sub session. */
   sessions?: SubSessionRow[];
   /** The first line of the failure text. */
   error?: string;
};

const str = (v: unknown): string | undefined =>
   typeof v === "string" && v.trim() ? v.trim() : undefined;

export function subSessionToolSummary(tool: GitToolCall): SubSessionToolSummary | null {
   const { harnessTool, rawInput } = tool;
   if (!harnessTool || !(SUB_SESSION_TOOLS as readonly string[]).includes(harnessTool)) return null;
   const input = (rawInput && typeof rawInput === "object" ? rawInput : {}) as Record<
      string,
      unknown
   >;
   const out: SubSessionToolSummary = {};
   const error = [textOf(tool.content), textOf(tool.rawOutput)]
      .map((t) => (t === null ? undefined : failure(t)))
      .find((e) => e !== undefined);
   if (error) out.error = error;
   const result = harnessResult(tool);
   const r = result?.type === "sub_session" ? result : undefined;

   const id = str(r?.session_id) ?? str(input.id);
   if (id) out.sessionId = id;
   const title = str(r?.title) ?? (harnessTool === "session_start" ? str(input.title) : undefined);
   if (title) out.title = title;
   switch (harnessTool) {
      case "session_start": {
         const repo = str(r?.repo) ?? str(input.folder);
         if (repo) out.repo = baseName(repo);
         const branch = str(r?.branch) ?? str(input.branch);
         if (branch) out.branch = branch;
         const model = str(r?.model) ?? str(input.model);
         if (model) out.model = model;
         const effort = str(r?.effort) ?? str(input.effort);
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
         if (r?.reply) out.reply = r.reply;
         if (typeof r?.duration_ms === "number") out.durationMs = r.duration_ms;
         if (r?.status) out.status = r.status;
         const stop = str(r?.stop_reason);
         if (stop) out.stopReason = stop;
         if (input.timeout_s === 0) out.check = true;
         break;
      }
      case "session_list": {
         if (result?.type !== "sub_session_list") break;
         out.sessions = result.sessions.map((row) => {
            const repo = str(row.repo);
            return {
               sessionId: row.session_id,
               title: str(row.title) ?? row.session_id,
               ...(repo && { repo: baseName(repo) }),
               ...(row.status && { status: row.status }),
               ...(row.archived && { archived: true }),
            };
         });
         break;
      }
   }
   return out;
}
