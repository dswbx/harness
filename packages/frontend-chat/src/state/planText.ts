/** The first `#` heading of a plan, without the hashes. Null when the plan has none. */
export function planTitle(md: string): string | null {
   const m = /^#{1,6}\s+(.+?)\s*#*\s*$/m.exec(md);
   return m ? m[1]!.trim() : null;
}

const LIST_ITEM = /^(?:[-*+]|\d+[.)])\s+/;
const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

/**
 * The number of steps in a plan: the top-level list items under a heading that names steps
 * ("Steps", "Implementation steps"), else all top-level list items. Null when there are none.
 */
export function planSteps(md: string): number | null {
   const lines = md.split("\n");
   let inFence = false;
   let section: { level: number; steps: boolean } | null = null;
   let underSteps = 0;
   let all = 0;
   for (const l of lines) {
      if (/^\s*(```|~~~)/.test(l)) inFence = !inFence;
      if (inFence) continue;
      const h = HEADING.exec(l);
      if (h) {
         const level = h[1]!.length;
         if (section?.steps && level > section.level) continue;
         section = { level, steps: /\bsteps?\b/i.test(h[2]!) };
         continue;
      }
      if (!LIST_ITEM.test(l)) continue;
      all++;
      if (section?.steps) underSteps++;
   }
   const n = underSteps || all;
   return n > 0 ? n : null;
}
