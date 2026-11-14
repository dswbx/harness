import type { ToolDetail } from "../generated";

/**
 * What a Frontend needs out of a tool call, without reading raw Agent payloads (ADR 0012). The
 * core fills `plan`, `subagent`, `commit_message`, `frontend_tool` and `detail` on Events;
 * `toolFacts` and `toolDetail` are the one fallback for logs recorded before it did. They mirror
 * the core's `tool_facts` and `agent_quirks::tool_detail`.
 */

export type ToolFacts = {
   /** A plan awaiting approval (a mode switch carrying one): Markdown. */
   plan: string | null;
   /** What a call that starts a subagent asked it to do. */
   subagentPrompt: string | null;
   /** A subagent call: the subagent's type (e.g. `Explore`). */
   subagentType: string | null;
   /** A subagent call: the model it asked for; null when it inherits the Thread's. */
   subagentModel: string | null;
   /** git_commit: the commit message. */
   commitMessage: string | null;
   /** A Frontend Tool request: the tool's name. */
   frontendTool: string | null;
};

export type ToolFactsInput = {
   kind?: string | null;
   title?: string | null;
   harnessTool?: string | null;
   /** The call's input as the Event carries it; read only here. */
   rawInput?: unknown;
};

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** `toolFacts` of a raw ACP tool call as a permission request carries it (`kind`, `title`, `rawInput`). */
export function toolFactsOfCall(call: unknown, harnessTool?: string | null): ToolFacts {
   const c = (call && typeof call === "object" ? call : {}) as Record<string, unknown>;
   return toolFacts({
      kind: typeof c.kind === "string" ? c.kind : null,
      title: typeof c.title === "string" ? c.title : null,
      harnessTool,
      rawInput: c.rawInput,
   });
}

export function toolFacts(call: ToolFactsInput): ToolFacts {
   const input =
      call.rawInput && typeof call.rawInput === "object"
         ? (call.rawInput as Record<string, unknown>)
         : {};
   const isCommit = call.kind === "git_commit" || call.harnessTool === "git_commit";
   const subagentPrompt =
      "subagent_type" in input || "description" in input ? str(input.prompt) : null;
   return {
      plan: call.kind === "switch_mode" ? str(input.plan) : null,
      subagentPrompt,
      subagentType: subagentPrompt != null ? str(input.subagent_type) : null,
      subagentModel: subagentPrompt != null ? str(input.model) : null,
      commitMessage: isCommit
         ? str(typeof input.message === "string" ? input.message.trim() : null)
         : null,
      frontendTool:
         call.kind === "frontend_tool"
            ? (str(/^Frontend tool:\s*(.+)$/.exec(call.title ?? "")?.[1]) ?? str(call.harnessTool))
            : null,
   };
}

/** A tool an Agent names: its own id, and the MCP server it belongs to when it is one. */
export type ToolRefFacts = { name: string; mcp: McpToolFacts | null };
export type McpToolFacts = { server: string; tool: string };

/** What a View needs to show a tool call (the core's `ToolDetail`, with every field present). */
export type ToolDetailFacts = {
   /** An `execute` call's command line. */
   command: string | null;
   /** A `read` call: the file, and whether its output code carries `N\t` line numbers. */
   read: { path: string | null; lineNumbered: boolean } | null;
   /** A tool search call: the tools it loaded; `[]` when none yet, null for any other call. */
   loadedTools: ToolRefFacts[] | null;
   /** A tool search call: its search words (not a `select:` lookup). */
   searchQuery: string | null;
   mcp: McpToolFacts | null;
   /** What the call does when its kind alone does not say. */
   op: "write" | "web_search" | null;
   /** What the call acts on when that differs from its title; null: use the title. */
   target: string | null;
};

export type ToolDetailInput = {
   kind?: string | null;
   title?: string | null;
   locations?: unknown;
   rawInput?: unknown;
   rawOutput?: unknown;
   content?: unknown;
   /** The Event's own `detail`; absent on logs recorded before it. */
   detail?: ToolDetail | null;
};

const cached = new WeakMap<object, ToolDetailFacts>();

/**
 * `detail` of a tool call as a Frontend keeps it: the core's typed fields when the Events had
 * them, else derived from the raw payloads.
 */
export function toolDetail(call: ToolDetailInput): ToolDetailFacts {
   const hit = cached.get(call);
   if (hit) return hit;
   const out = call.detail ? fromWire(call.detail) : deriveDetail(call);
   cached.set(call, out);
   return out;
}

function fromWire(d: ToolDetail): ToolDetailFacts {
   return {
      command: d.command ?? null,
      read: d.read
         ? { path: d.read.path ?? null, lineNumbered: d.read.line_numbered ?? false }
         : null,
      loadedTools: d.loaded_tools
         ? d.loaded_tools.map((t) => ({ name: t.name, mcp: t.mcp ?? null }))
         : null,
      searchQuery: d.search_query ?? null,
      mcp: d.mcp ?? null,
      op: d.op ?? null,
      target: d.target ?? null,
   };
}

// Removal: derivation below only serves Session Logs recorded before `detail` existed
// (ADR 0021). Once no supported log lacks it (log::upcast can fill it), delete `deriveDetail`
// and its helpers; `toolDetail` then reads `call.detail` alone.

const BARE_TITLES = new Set(["Terminal", "Read File", "Fetch", "Edit", "Web search"]);
const VERB_PREFIX = /^(Read( file)?|Edit|Fetch) /;

/** `mcp__server__tool`, the way the core's `agent_quirks::tool_detail` reads it. */
function mcpOf(name: string): McpToolFacts | null {
   const m = /^mcp__(.+?)__(.+)$/.exec(name);
   return m ? { server: m[1]!, tool: m[2]! } : null;
}

/** The text of each `content` block of a call. */
function contentTexts(content: unknown): string[] {
   if (!Array.isArray(content)) return [];
   return content.flatMap((b: { type?: unknown; content?: { text?: unknown } }) =>
      b?.type === "content" && typeof b.content?.text === "string" ? [b.content.text] : [],
   );
}

/** The code of a text that is one code fence (a closing fence inside means several blocks). */
function fenceCode(text: string): string | null {
   const m = /^(`{3,})([\w+#.-]*)\n([\s\S]*?)\n?\1\s*$/.exec(text.trim());
   if (!m || new RegExp(`^${m[1]}\\s*$`, "m").test(m[3]!)) return null;
   return m[3]!;
}

/** Strips `N\t` line numbers off code whose lines count up by one: the code and its first and last number. Null otherwise (`wc -l` output has the same shape). */
export function stripLineNumbers(code: string): { code: string; from: number; to: number } | null {
   const lines = code.split("\n");
   const nums = lines.map((l) => (/^\s*\d+\t/.test(l) ? parseInt(l, 10) : Number.NaN));
   if (!nums.every((n, i) => n === nums[0]! + i)) return null;
   return {
      code: lines.map((l) => l.replace(/^\s*\d+\t/, "")).join("\n"),
      from: nums[0]!,
      to: nums.at(-1)!,
   };
}

function commandOf(rawInput: unknown, title: string): string | null {
   const cmd = (rawInput as { command?: unknown } | null)?.command;
   if (typeof cmd === "string" && cmd.trim()) return cmd;
   if (Array.isArray(cmd) && cmd.every((a) => typeof a === "string")) {
      const shell = cmd.length === 3 && /^-.*c$/.test(cmd[1]!);
      return (shell ? cmd[2]! : cmd.join(" ")) || null;
   }
   return title && title !== "Terminal" ? title : null;
}

function loadedTools(call: ToolDetailInput): ToolRefFacts[] {
   const ref = (name: string): ToolRefFacts => ({ name, mcp: mcpOf(name) });
   const out = call.rawOutput;
   const refs = Array.isArray(out)
      ? (out as { type?: unknown; tool_name?: unknown }[])
           .filter((r) => r?.type === "tool_reference" && typeof r.tool_name === "string")
           .map((r) => ref(r.tool_name as string))
      : [];
   if (refs.length) return refs;
   return contentTexts(call.content).flatMap((t) => {
      const m = /^Tool: (\S+)$/.exec(t.trim());
      return m ? [ref(m[1]!)] : [];
   });
}

function deriveDetail(call: ToolDetailInput): ToolDetailFacts {
   const kind = call.kind ?? null;
   const title = call.title ?? "";
   const query = (call.rawInput as { query?: unknown } | null)?.query;
   let read: ToolDetailFacts["read"] = null;
   if (kind === "read") {
      const loc = (call.locations as { path?: unknown }[] | null)?.[0]?.path;
      read = {
         path: typeof loc === "string" ? loc : (/^Read (.+)$/.exec(title)?.[1] ?? null),
         lineNumbered: contentTexts(call.content).some((t) => {
            const code = fenceCode(t);
            return code !== null && stripLineNumbers(code) !== null;
         }),
      };
   }
   const toolSearch = title === "ToolSearch";
   const [op, target] = title.startsWith("Write ")
      ? (["write", title.slice("Write ".length)] as const)
      : /^Search (?=")/.test(title)
        ? (["web_search", title.slice("Search ".length)] as const)
        : ([null, BARE_TITLES.has(title) ? "" : title.replace(VERB_PREFIX, "")] as const);
   return {
      command: kind === "execute" ? commandOf(call.rawInput, title) : null,
      read,
      loadedTools: toolSearch ? loadedTools(call) : null,
      searchQuery:
         toolSearch && typeof query === "string" && query && !query.startsWith("select:")
            ? query
            : null,
      mcp: mcpOf(title),
      op,
      target: target !== title ? target : null,
   };
}
