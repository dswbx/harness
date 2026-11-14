/**
 * What a Frontend needs out of a tool call, without reading raw Agent payloads (ADR 0012). The
 * core fills `plan`, `subagent`, `commit_message` and `frontend_tool` on Events; `toolFacts` is
 * the one fallback for logs recorded before it did. It mirrors the core's `tool_facts`.
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
