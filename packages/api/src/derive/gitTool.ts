import type { HarnessResult } from "../generated";

/**
 * What a Harness git tool call did, read from its raw input and the core's typed `harness_result`
 * (ADR 0012, shared helper). Parsing is defensive: anything unreadable just leaves a field out.
 */

export type GitToolSummary = {
   /** git_commit: first line of the message, the rest, and the short hash. */
   subject?: string;
   body?: string;
   hash?: string;
   /** git_push, git_status. */
   branch?: string;
   /** git_status: files changed. */
   changed?: number;
   /** git_diff: `from..to` or `working tree`, and the patch's line counts. */
   range?: string;
   additions?: number;
   deletions?: number;
   /** list_branches. */
   count?: number;
   /** The first line of the failure text. */
   error?: string;
};

/** Text of a raw output (a string, or text blocks) or of ACP content blocks. */
export function textOf(v: unknown): string | null {
   if (typeof v === "string") return v;
   if (!Array.isArray(v)) return null;
   const parts: string[] = [];
   for (const b of v as Record<string, unknown>[]) {
      const inner = b?.type === "content" ? (b.content as Record<string, unknown> | null) : b;
      if (inner?.type === "text" && typeof inner.text === "string") parts.push(inner.text);
   }
   return parts.length ? parts.join("\n") : null;
}

export const FENCED = /^\s*(`{3,})[\w+#.-]*\n([\s\S]*?)\n?\1\s*$/;

/** First line of a failure: Harness wraps it in a code fence. */
export function failure(text: string): string | undefined {
   const m = FENCED.exec(text);
   if (!m) return undefined;
   return (
      m[2]!
         .split("\n")
         .find((l) => l.trim())
         ?.trim() || undefined
   );
}

export function parseJson(text: string): unknown {
   try {
      return JSON.parse(text);
   } catch {
      return undefined;
   }
}

/** The parts of a tool call (as a Frontend keeps it) a git summary is read from. */
export type GitToolCall = {
   harnessTool: string | null;
   rawInput: unknown;
   rawOutput: unknown;
   content?: unknown;
   /** The core's typed result; absent on logs recorded before it (`harnessResult` reads the output text then). */
   harnessResult?: HarnessResult | null;
};

const outputTexts = (tool: GitToolCall) =>
   [textOf(tool.content), textOf(tool.rawOutput)].filter((t): t is string => t !== null);

/**
 * What a Harness tool call did: the core's typed `harness_result`, else read back from the
 * tool's output text. Mirrors the core's `mcp::results::result_of`; both run
 * `crates/harness-core/tests/cases/harness_result.json`.
 */
export function harnessResult(tool: GitToolCall): HarnessResult | null {
   return tool.harnessResult ?? deriveResult(tool);
}

// Needed for Session Logs written before `harness_result` existed: an upcaster is stateless per
// line and cannot rebuild it from a call's output. Permanent unless logs get a migration.
function deriveResult(tool: GitToolCall): HarnessResult | null {
   const name = tool.harnessTool;
   if (!name) return null;
   const text = outputTexts(tool).find((t) => !FENCED.test(t));
   if (text === undefined) return null;
   switch (name) {
      case "git_commit": {
         const hash = /Committed\s+([0-9a-f]{7,40})/i.exec(text)?.[1];
         return hash ? { type: "git_commit", hash } : null;
      }
      case "git_push": {
         const branch = /^Pushed\s+(.+?)\.?\s*$/m.exec(text)?.[1];
         return branch ? { type: "git_push", branch } : null;
      }
      case "git_status": {
         const s = parseJson(text) as Record<string, unknown> | null | undefined;
         if (!s || typeof s !== "object" || Array.isArray(s)) return null;
         return {
            type: "git_status",
            ...(typeof s.branch === "string" && s.branch && { branch: s.branch }),
            ...(Array.isArray(s.files) && { changed: s.files.length }),
         };
      }
      case "git_diff": {
         if (!text) return null;
         let additions = 0;
         let deletions = 0;
         for (const l of text.split("\n")) {
            if (l.startsWith("+") && !l.startsWith("+++")) additions++;
            else if (l.startsWith("-") && !l.startsWith("---")) deletions++;
         }
         return { type: "git_diff", additions, deletions };
      }
      case "list_branches": {
         const b = parseJson(text);
         return Array.isArray(b) ? { type: "list_branches", count: b.length } : null;
      }
      case "session_start":
      case "session_send":
      case "session_wait":
      case "session_list":
         return deriveSubSession(name, text);
      default:
         return null;
   }
}

const str = (v: unknown): string | undefined =>
   typeof v === "string" && v.trim() ? v.trim() : undefined;
const stateOf = (v: unknown) =>
   v === "idle" || v === "needs_attention" || v === "working" ? v : undefined;

function deriveSubSession(name: string, text: string): HarnessResult | null {
   const parsed = parseJson(text);
   if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
   const r = parsed as Record<string, unknown>;
   if (name === "session_list") {
      if (!Array.isArray(r.sub_sessions)) return null;
      return {
         type: "sub_session_list",
         sessions: r.sub_sessions.flatMap((v) => {
            const row = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
            const session_id = str(row.session_id);
            if (!session_id) return [];
            const title = str(row.title);
            const repo = str(row.repo) ?? str(row.folder);
            const status = stateOf(row.status);
            return [
               {
                  session_id,
                  ...(title && { title }),
                  ...(repo && { repo }),
                  ...(status && { status }),
                  ...(row.archived === true && { archived: true }),
               },
            ];
         }),
      };
   }
   const get = (k: string) => str(r[k]);
   const repo = get("repo") ?? get("folder");
   const status = stateOf(r.status);
   return {
      type: "sub_session",
      ...(get("session_id") && { session_id: get("session_id") }),
      ...(get("title") && { title: get("title") }),
      ...(repo && { repo }),
      ...(get("branch") && { branch: get("branch") }),
      ...(get("model") && { model: get("model") }),
      ...(get("effort") && { effort: get("effort") }),
      ...(typeof r.reply === "string" && r.reply.trim() && { reply: r.reply }),
      ...(typeof r.duration_ms === "number" && { duration_ms: Math.trunc(r.duration_ms) }),
      ...(get("stop_reason") && { stop_reason: get("stop_reason") }),
      ...(status && { status }),
   };
}

export function gitToolSummary(tool: GitToolCall): GitToolSummary | null {
   const { harnessTool, rawInput } = tool;
   if (
      !harnessTool ||
      !["git_commit", "git_push", "git_status", "git_diff", "list_branches"].includes(harnessTool)
   )
      return null;
   const input = (rawInput && typeof rawInput === "object" ? rawInput : {}) as Record<
      string,
      unknown
   >;
   const out: GitToolSummary = {};
   const error = outputTexts(tool)
      .map(failure)
      .find((e) => e !== undefined);
   if (error) out.error = error;
   const result = harnessResult(tool);
   switch (harnessTool) {
      case "git_commit": {
         const message = typeof input.message === "string" ? input.message.trim() : "";
         if (message) {
            const [subject = "", ...rest] = message.split("\n");
            out.subject = subject.trim();
            const body = rest.join("\n").trim();
            if (body) out.body = body;
         }
         if (result?.type === "git_commit") out.hash = result.hash.slice(0, 7);
         break;
      }
      case "git_push": {
         if (result?.type === "git_push") out.branch = result.branch;
         break;
      }
      case "git_status": {
         if (result?.type === "git_status") {
            if (result.branch) out.branch = result.branch;
            if (result.changed != null) out.changed = result.changed;
         }
         break;
      }
      case "git_diff": {
         const from = typeof input.from === "string" && input.from ? input.from : null;
         const to = typeof input.to === "string" && input.to ? input.to : null;
         out.range = from || to ? `${from ?? ""}..${to ?? ""}` : "working tree";
         if (result?.type === "git_diff") {
            out.additions = result.additions;
            out.deletions = result.deletions;
         }
         break;
      }
      case "list_branches": {
         if (result?.type === "list_branches") out.count = result.count;
         break;
      }
   }
   return out;
}
