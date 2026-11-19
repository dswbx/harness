import type { InstructionsScope } from "../generated";

/** A Custom Instructions part found in a `<harness_context>` block. */
export type ContextInstructions = { scope: InstructionsScope; name: string };

/**
 * The Custom Instructions parts of a `<harness_context>` block (core: `harness_context.rs`), Global first.
 * The repository's path comes from the block's "- Repository:" (else "- Workspace folder:") line.
 */
export function contextInstructions(context: string): ContextInstructions[] {
   const found: ContextInstructions[] = [];
   if (/^## Your instructions \(global\)$/m.test(context))
      found.push({ scope: { type: "global" }, name: "global" });
   const repo = /^## Your instructions \((.+)\)$/gm;
   for (const m of context.matchAll(repo)) {
      if (m[1] === "global") continue;
      // The last one: the Session facts come after the user's own texts.
      const path =
         last(context, /^- Repository: (.+)$/gm) ?? last(context, /^- Workspace folder: (.+)$/gm);
      if (path) found.push({ scope: { type: "repo", path }, name: m[1] });
      break;
   }
   return found;
}

const last = (text: string, re: RegExp) => [...text.matchAll(re)].at(-1)?.[1];
