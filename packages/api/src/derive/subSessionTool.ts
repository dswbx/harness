/**
 * What a Harness sub session tool call (`session_start`, `session_send`, `session_wait`,
 * `session_list`) did, read
 * from its raw input and JSON output (ADR 0012, shared helper). Parsing is defensive: anything
 * unreadable just leaves a field out.
 */
import { FENCED, failure, type GitToolCall, parseJson, textOf } from "./gitTool";

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

const statusOf = (v: unknown): SubSessionStatus | undefined =>
   v === "idle" || v === "needs_attention" || v === "working" ? v : undefined;

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
         const status = statusOf(r.status);
         if (status) out.status = status;
         const stop = str(r.stop_reason);
         if (stop) out.stopReason = stop;
         if (input.timeout_s === 0) out.check = true;
         break;
      }
      case "session_list": {
         if (!Array.isArray(r.sub_sessions)) break;
         out.sessions = r.sub_sessions.flatMap((v): SubSessionRow[] => {
            const row = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
            const sessionId = str(row.session_id);
            if (!sessionId) return [];
            const repo = str(row.repo) ?? str(row.folder);
            const status = statusOf(row.status);
            return [
               {
                  sessionId,
                  title: str(row.title) ?? sessionId,
                  ...(repo && { repo: baseName(repo) }),
                  ...(status && { status }),
                  ...(row.archived === true && { archived: true }),
               },
            ];
         });
         break;
      }
   }
   return out;
}
