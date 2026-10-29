export type DiffLine = { op: " " | "+" | "-"; text: string };

/** Line-level diff via LCS; enough for showing edit tool calls. */
export function diffLines(oldText: string | null | undefined, newText: string): DiffLine[] {
  const a = oldText ? oldText.split("\n") : [];
  const b = newText.split("\n");
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ op: " ", text: a[i]! });
      i++;
      j++;
    }
    else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) out.push({ op: "-", text: a[i++]! });
    else out.push({ op: "+", text: b[j++]! });
  }
  while (i < n) out.push({ op: "-", text: a[i++]! });
  while (j < m) out.push({ op: "+", text: b[j++]! });
  return out;
}

export type FilePatch = {
  /** Path shown to the user: the new path, or the old one for a deleted file. */
  path: string;
  oldPath: string | null;
  newPath: string | null;
  status: "A" | "D" | "M";
  /** This file's own `diff --git` section; git-diff-view takes it as one entry of `hunks`. */
  text: string;
  additions: number;
  deletions: number;
};

/** Splits a `git diff` into one section per file, in the shape git-diff-view's `data` wants. */
export function splitPatch(patch: string): FilePatch[] {
  const out: FilePatch[] = [];
  const sections = patch.split(/^(?=diff --git )/m).filter((s) => s.startsWith("diff --git "));
  for (const raw of sections) {
    const text = raw.endsWith("\n") ? raw : raw + "\n";
    const lines = text.split("\n");
    const header = lines[0]!.match(/^diff --git a\/(.+) b\/(.+)$/);
    const minus = lines.find((l) => l.startsWith("--- "))?.slice(4);
    const plus = lines.find((l) => l.startsWith("+++ "))?.slice(4);
    const strip = (p: string | undefined, fallback: string | undefined) =>
      p === undefined ? (fallback ?? null) : p === "/dev/null" ? null : p.replace(/^[ab]\//, "");
    const oldPath = strip(minus, header?.[1]);
    const newPath = strip(plus, header?.[2]);
    let additions = 0;
    let deletions = 0;
    let inHunk = false;
    for (const l of lines) {
      if (l.startsWith("@@")) inHunk = true;
      else if (inHunk && l.startsWith("+")) additions++;
      else if (inHunk && l.startsWith("-")) deletions++;
    }
    out.push({
      path: newPath ?? oldPath ?? lines[0]!,
      oldPath,
      newPath,
      status: oldPath === null ? "A" : newPath === null ? "D" : "M",
      text,
      additions,
      deletions,
    });
  }
  return out;
}

/** One side's line text by line number, from the hunks (null outside them). */
export function hunkLines(text: string): { old: Map<number, string>; new: Map<number, string> } {
  const old = new Map<number, string>();
  const nu = new Map<number, string>();
  let o = 0;
  let n = 0;
  let inHunk = false;
  for (const l of text.split("\n")) {
    const h = l.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (h) {
      o = Number(h[1]);
      n = Number(h[2]);
      inHunk = true;
    } else if (!inHunk || l.startsWith("\\")) continue;
    else if (l.startsWith("-")) old.set(o++, l.slice(1));
    else if (l.startsWith("+")) nu.set(n++, l.slice(1));
    else if (l.startsWith(" ") || l === "") {
      old.set(o++, l.slice(1));
      nu.set(n++, l.slice(1));
    }
  }
  return { old, new: nu };
}

/** Number of change blocks (runs of added/deleted lines), the "N differences" count. */
export function changeCount(text: string): number {
  let n = 0;
  let inRun = false;
  let inHunk = false;
  for (const l of text.split("\n")) {
    if (l.startsWith("@@")) {
      inHunk = true;
      inRun = false;
      continue;
    }
    if (!inHunk || l.startsWith("\\")) continue;
    const change = l.startsWith("+") || l.startsWith("-");
    if (change && !inRun) n++;
    inRun = change;
  }
  return n;
}

const LANGS: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  json: "json", md: "markdown", rs: "rust", py: "python", go: "go", css: "css", html: "xml", xml: "xml", svg: "xml",
  yml: "yaml", yaml: "yaml", toml: "ini", sh: "bash", zsh: "bash", sql: "sql", java: "java", kt: "kotlin", swift: "swift", rb: "ruby",
};

/** highlight.js language name for a path ("plaintext" when unknown). */
export const langOf = (path: string): string => LANGS[path.split(".").pop()?.toLowerCase() ?? ""] ?? "plaintext";

/** A `git diff`-style patch for one file from two texts (edit tool calls), with `context` lines around changes. */
export function unifiedPatch(path: string, oldText: string | null | undefined, newText: string, context = 3): string {
  const lines = diffLines(oldText, newText);
  // Old/new line counts before each line.
  const oPos: number[] = [];
  const nPos: number[] = [];
  let o = 0;
  let n = 0;
  for (const l of lines) {
    oPos.push(o);
    nPos.push(n);
    if (l.op !== "+") o++;
    if (l.op !== "-") n++;
  }
  const groups: [number, number][] = [];
  lines.forEach((l, i) => {
    if (l.op === " ") return;
    const s = Math.max(0, i - context);
    const e = Math.min(lines.length - 1, i + context);
    const last = groups.at(-1);
    if (last && s <= last[1] + 1) last[1] = e;
    else groups.push([s, e]);
  });
  const a = oldText == null ? "/dev/null" : `a/${path}`;
  let out = `diff --git a/${path} b/${path}\n${oldText == null ? "new file mode 100644\n" : ""}--- ${a}\n+++ b/${path}\n`;
  for (const [s, e] of groups) {
    const part = lines.slice(s, e + 1);
    const oLen = part.filter((l) => l.op !== "+").length;
    const nLen = part.filter((l) => l.op !== "-").length;
    const oStart = oLen ? oPos[s]! + 1 : oPos[s]!;
    const nStart = nLen ? nPos[s]! + 1 : nPos[s]!;
    out += `@@ -${oStart},${oLen} +${nStart},${nLen} @@\n` + part.map((l) => l.op + l.text + "\n").join("");
  }
  return out;
}
