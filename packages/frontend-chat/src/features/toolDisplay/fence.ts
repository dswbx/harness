import { stripLineNumbers } from "@harness/api";

/** A text block that is one code fence: its language and code. With `numbered` (the call's output carries line
 * numbers, `toolDetail(tool).read?.lineNumbered`), they become the range `from`–`to`. */
export function parseFence(
   text: string,
   numbered = false,
): { lang: string; code: string; from?: number; to?: number } | null {
   const m = /^(`{3,})([\w+#.-]*)\n([\s\S]*?)\n?\1\s*$/.exec(text.trim());
   // A closing fence inside means more than one block (with prose between): leave it to Markdown.
   if (!m || new RegExp(`^${m[1]}\\s*$`, "m").test(m[3]!)) return null;
   const code = m[3]!;
   const stripped = numbered ? stripLineNumbers(code) : null;
   return { lang: m[2]!, ...(stripped ?? { code }) };
}

/** Text that is, or ends in, a JSON object or array: the prose before it and the value, pretty-printed.
 * Null when there is none, or it is empty (`[]`, `{}` read fine inline). */
export function jsonTail(text: string): { prose: string; json: string } | null {
   const t = text.trim();
   const last = t.at(-1);
   if (last !== "}" && last !== "]") return null;
   // Try each `{` / `[` from the start: the first that parses to the end is the outermost value.
   for (let i = 0, tries = 0; i < t.length && tries < 50; i++) {
      const c = t[i];
      if (c !== "{" && c !== "[") continue;
      tries++;
      try {
         const v = JSON.parse(t.slice(i));
         if (typeof v !== "object" || v === null || Object.keys(v).length === 0) return null;
         return { prose: t.slice(0, i).trim(), json: JSON.stringify(v, null, 2) };
      } catch {
         /* not JSON from here */
      }
   }
   return null;
}
