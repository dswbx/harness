/** A text block that is one code fence: its language and code. Read output also loses its `N\t` line numbers. */
export function parseFence(text: string): { lang: string; code: string; from?: number; to?: number } | null {
  const m = /^(`{3,})([\w+#.-]*)\n([\s\S]*?)\n?\1\s*$/.exec(text.trim());
  // A closing fence inside means more than one block (with prose between): leave it to Markdown.
  if (!m || new RegExp(`^${m[1]}\\s*$`, "m").test(m[3]!)) return null;
  let code = m[3]!;
  const lines = code.split("\n");
  const numbered = lines.length > 0 && lines.every((l) => /^\s*\d+\t/.test(l));
  if (!numbered) return { lang: m[2]!, code };
  const nums = lines.map((l) => parseInt(l, 10));
  code = lines.map((l) => l.replace(/^\s*\d+\t/, "")).join("\n");
  return { lang: m[2]!, code, from: nums[0], to: nums.at(-1) };
}
