import type { InstructionsScope } from "../generated";

/** A Custom Instructions part found in a `<harness_context>` block. */
export type ContextInstructions = { scope: InstructionsScope; name: string };

/**
 * The Custom Instructions parts of a `<harness_context>` block (core: `harness_context.rs`), Global first.
 * The repository part's key folder comes from the block's "- Instructions folder:" line.
 */
export function contextInstructions(context: string): ContextInstructions[] {
   const found: ContextInstructions[] = [];
   if (/^## Your instructions for all Sessions$/m.test(context))
      found.push({ scope: { type: "global" }, name: "global" });
   const name = context.match(/^## Your instructions \((.+)\)$/m)?.[1];
   // The last one: the Session facts come after the user's own texts.
   const path = [...context.matchAll(/^- Instructions folder: (.+)$/gm)].at(-1)?.[1];
   if (name && path) found.push({ scope: { type: "repo", path }, name });
   return found;
}
