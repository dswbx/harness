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

export type PatchLine = { kind: "add" | "del" | "hunk" | "ctx" | "meta"; text: string };
export type PatchFile = { path: string; lines: PatchLine[] };

/** Splits a unified diff (`git diff` style) into per-file sections with classified lines. */
export function parsePatch(patch: string): PatchFile[] {
  const files: PatchFile[] = [];
  let cur: PatchFile | null = null;
  let inHunk = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      cur = { path: line.match(/ b\/(.+)$/)?.[1] ?? line, lines: [] };
      files.push(cur);
      inHunk = false;
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("@@")) {
      inHunk = true;
      cur.lines.push({ kind: "hunk", text: line });
    } else if (!inHunk) cur.lines.push({ kind: "meta", text: line });
    else if (line.startsWith("+")) cur.lines.push({ kind: "add", text: line });
    else if (line.startsWith("-")) cur.lines.push({ kind: "del", text: line });
    else if (line !== "" || cur.lines.length) cur.lines.push({ kind: "ctx", text: line });
  }
  for (const f of files) while (f.lines.at(-1)?.text === "" ) f.lines.pop();
  return files;
}
