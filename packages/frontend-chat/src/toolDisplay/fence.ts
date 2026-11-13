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

/** The command line of an `execute` call: `rawInput.command` (a string, or argv like `["bash", "-lc", cmd]`), else its title. */
export function commandOf(rawInput: unknown, title: string): string | null {
   const cmd = (rawInput as { command?: unknown } | null)?.command;
   if (typeof cmd === "string" && cmd.trim()) return cmd;
   if (Array.isArray(cmd) && cmd.every((a) => typeof a === "string")) {
      const shell = cmd.length === 3 && /^-l?c$/.test(cmd[1]!);
      return shell ? cmd[2]! : cmd.join(" ");
   }
   return title && title !== "Terminal" ? title : null;
}
