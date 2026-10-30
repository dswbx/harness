/** A run of text with the SGR styles in effect. Colors are indexes into the code theme's `--ansi-*`, or `#rrggbb`. */
export type AnsiSpan = { text: string; fg?: string; bg?: string; bold?: boolean; dim?: boolean; italic?: boolean; underline?: boolean };

const ESC = "\u001b";
const color = (n: number) => `var(--ansi-${n})`;

/** 256-color index -> CSS color (0-15: the theme's palette). */
function color256(n: number): string {
  if (n < 16) return color(n);
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return `rgb(${v}, ${v}, ${v})`;
  }
  const i = n - 16;
  const c = (x: number) => (x === 0 ? 0 : 55 + x * 40);
  return `rgb(${c(Math.floor(i / 36))}, ${c(Math.floor(i / 6) % 6)}, ${c(i % 6)})`;
}

/** Parses SGR color and style codes; drops other escape sequences (cursor moves, titles). */
export function parseAnsi(input: string): AnsiSpan[] {
  const out: AnsiSpan[] = [];
  let style: Omit<AnsiSpan, "text"> = {};
  // CSI sequences, OSC sequences (terminated by BEL or ESC \), and lone escapes.
  const re = new RegExp(`${ESC}\\[([0-9;?]*)([A-Za-z])|${ESC}\\][^\\u0007${ESC}]*(?:\\u0007|${ESC}\\\\)|${ESC}.`, "g");
  let last = 0;
  for (let m = re.exec(input); m; m = re.exec(input)) {
    if (m.index > last) out.push({ text: input.slice(last, m.index), ...style });
    last = re.lastIndex;
    if (m[2] !== "m") continue;
    const codes = (m[1] || "0").split(";").map((x) => Number(x) || 0);
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i]!;
      if (c === 0) style = {};
      else if (c === 1) style = { ...style, bold: true };
      else if (c === 2) style = { ...style, dim: true };
      else if (c === 3) style = { ...style, italic: true };
      else if (c === 4) style = { ...style, underline: true };
      else if (c === 22) style = { ...style, bold: false, dim: false };
      else if (c === 23) style = { ...style, italic: false };
      else if (c === 24) style = { ...style, underline: false };
      else if (c >= 30 && c <= 37) style = { ...style, fg: color(c - 30) };
      else if (c >= 90 && c <= 97) style = { ...style, fg: color(c - 90 + 8) };
      else if (c === 39) style = { ...style, fg: undefined };
      else if (c >= 40 && c <= 47) style = { ...style, bg: color(c - 40) };
      else if (c >= 100 && c <= 107) style = { ...style, bg: color(c - 100 + 8) };
      else if (c === 49) style = { ...style, bg: undefined };
      else if ((c === 38 || c === 48) && codes[i + 1] === 5) {
        style = { ...style, [c === 38 ? "fg" : "bg"]: color256(codes[i + 2] ?? 0) };
        i += 2;
      } else if ((c === 38 || c === 48) && codes[i + 1] === 2) {
        const [r, g, b] = [codes[i + 2] ?? 0, codes[i + 3] ?? 0, codes[i + 4] ?? 0];
        style = { ...style, [c === 38 ? "fg" : "bg"]: `rgb(${r}, ${g}, ${b})` };
        i += 4;
      }
    }
  }
  if (last < input.length) out.push({ text: input.slice(last), ...style });
  return out.filter((s) => s.text);
}
