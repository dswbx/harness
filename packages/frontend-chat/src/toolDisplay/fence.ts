/** A text block that is one code fence: its language and code. With `numbered` (Read output), `N\t` line numbers
 * become the range `from`–`to`, but only when they count up by one: `wc -l` output has the same shape. */
export function parseFence(
   text: string,
   numbered = false,
): { lang: string; code: string; from?: number; to?: number } | null {
   const m = /^(`{3,})([\w+#.-]*)\n([\s\S]*?)\n?\1\s*$/.exec(text.trim());
   // A closing fence inside means more than one block (with prose between): leave it to Markdown.
   if (!m || new RegExp(`^${m[1]}\\s*$`, "m").test(m[3]!)) return null;
   const code = m[3]!;
   const lines = code.split("\n");
   const nums = lines.map((l) => (/^\s*\d+\t/.test(l) ? parseInt(l, 10) : NaN));
   if (!numbered || !nums.every((n, i) => n === nums[0]! + i)) return { lang: m[2]!, code };
   return {
      lang: m[2]!,
      code: lines.map((l) => l.replace(/^\s*\d+\t/, "")).join("\n"),
      from: nums[0],
      to: nums.at(-1),
   };
}
