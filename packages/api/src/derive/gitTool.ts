/**
 * What a Harness git tool call did, read from its raw input and output (ADR 0012, shared helper).
 * Parsing is defensive: anything unreadable just leaves a field out.
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
};

export function gitToolSummary(tool: GitToolCall): GitToolSummary | null {
   const { harnessTool, rawInput, rawOutput, content } = tool;
   if (
      !harnessTool ||
      !["git_commit", "git_push", "git_status", "git_diff", "list_branches"].includes(harnessTool)
   )
      return null;
   const input = (rawInput && typeof rawInput === "object" ? rawInput : {}) as Record<
      string,
      unknown
   >;
   const texts = [textOf(content), textOf(rawOutput)].filter((t): t is string => t !== null);
   const out: GitToolSummary = {};
   const error = texts.map(failure).find((e) => e !== undefined);
   if (error) out.error = error;
   // Success output is never fenced; take the first text that is not a failure.
   const text = texts.find((t) => !FENCED.test(t)) ?? "";
   switch (harnessTool) {
      case "git_commit": {
         const message = typeof input.message === "string" ? input.message.trim() : "";
         if (message) {
            const [subject = "", ...rest] = message.split("\n");
            out.subject = subject.trim();
            const body = rest.join("\n").trim();
            if (body) out.body = body;
         }
         const hash = /Committed\s+([0-9a-f]{7,40})/i.exec(text)?.[1];
         if (hash) out.hash = hash.slice(0, 7);
         break;
      }
      case "git_push": {
         const branch = /^Pushed\s+(.+?)\.?\s*$/m.exec(text)?.[1];
         if (branch) out.branch = branch;
         break;
      }
      case "git_status": {
         const s = parseJson(text) as { branch?: unknown; files?: unknown } | undefined;
         if (s && typeof s === "object") {
            if (typeof s.branch === "string" && s.branch) out.branch = s.branch;
            if (Array.isArray(s.files)) out.changed = s.files.length;
         }
         break;
      }
      case "git_diff": {
         const from = typeof input.from === "string" && input.from ? input.from : null;
         const to = typeof input.to === "string" && input.to ? input.to : null;
         out.range = from || to ? `${from ?? ""}..${to ?? ""}` : "working tree";
         if (text) {
            let add = 0;
            let del = 0;
            for (const l of text.split("\n")) {
               if (l.startsWith("+") && !l.startsWith("+++")) add++;
               else if (l.startsWith("-") && !l.startsWith("---")) del++;
            }
            out.additions = add;
            out.deletions = del;
         }
         break;
      }
      case "list_branches": {
         const b = parseJson(text);
         if (Array.isArray(b)) out.count = b.length;
         break;
      }
   }
   return out;
}
