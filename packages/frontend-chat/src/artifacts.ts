import type { Item } from "./reducer";
import type { Placement, RawNode } from "./tools";

export type ArtifactKind = "ui" | "diagram" | "table";

/**
 * One thing worth finding again in a Session: a `render_ui` item (its latest content), or a
 * Mermaid diagram or table in an Agent message. Derived from the chat Items, like the rows.
 */
export type Artifact = {
  /** Stable while the Session grows: render_ui id (or row id), else `row:n`. */
  key: string;
  kind: ArtifactKind;
  title: string;
  /** What it is: "Mermaid · flowchart", "Table · 3 columns, 2 rows", "PullRequest". */
  sub: string;
  /** Chat row that shows it; null for render_ui items placed top, bottom, left or right. */
  rowId: string | null;
  /** Which diagram/table of its message (0-based, per kind); null for render_ui. */
  index: number | null;
  placement: Placement;
  /** render_ui id, for placed items. */
  slotId: string | null;
  ts: number;
  /** 1-based Turn (user prompt) it came from; 0 before the first prompt. */
  turn: number;
  /** That Turn's prompt text. */
  prompt: string;
  /** Mermaid or table Markdown, or the render_ui node as JSON. */
  source: string;
  ui: { root: RawNode; files: Record<string, string> } | null;
};

/** Diagrams and tables in Markdown, in order, outside other code fences. */
export function markdownArtifacts(text: string): { kind: "diagram" | "table"; title: string; sub: string; source: string; index: number }[] {
  const out: { kind: "diagram" | "table"; title: string; sub: string; source: string; index: number }[] = [];
  const lines = text.split("\n");
  const counts = { diagram: 0, table: 0 };
  /** The last line of prose before the artifact names it ("Last 20 CI runs:"). */
  let lastProse = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = /^\s*(`{3,}|~{3,})\s*([\w-]*)/.exec(line);
    if (fence) {
      const close = new RegExp(`^\\s*${fence[1]![0]}{${fence[1]!.length},}\\s*$`);
      let j = i + 1;
      while (j < lines.length && !close.test(lines[j]!)) j++;
      if (fence[2] === "mermaid") {
        const source = lines.slice(i + 1, j).join("\n");
        // The diagram type is the first line after an optional `---` front matter block and `%%` comments.
        const body = source.replace(/^\s*---\n[\s\S]*?\n---\s*(\n|$)/, "");
        const first = body.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("%%")) ?? "";
        const type = /^(\w[\w-]*)/.exec(first)?.[1] ?? "diagram";
        const title = /^\s*title:\s*(.+)$/m.exec(source)?.[1]?.trim() || lastProse || "Diagram";
        out.push({ kind: "diagram", title, sub: `Mermaid · ${type.replace(/Diagram(-v2)?$/, "")}`, source, index: counts.diagram++ });
      }
      i = j;
      lastProse = "";
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(lines[i + 1] ?? "")) {
      let j = i + 2;
      while (j < lines.length && /^\s*\|.*\|\s*$/.test(lines[j]!)) j++;
      const cols = cells(line);
      const rows = j - i - 2;
      out.push({
        kind: "table",
        title: lastProse || cols.join(", ") || "Table",
        sub: `Table · ${cols.length} ${cols.length === 1 ? "column" : "columns"}, ${rows} ${rows === 1 ? "row" : "rows"}`,
        source: lines.slice(i, j).join("\n"),
        index: counts.table++,
      });
      i = j - 1;
      lastProse = "";
      continue;
    }
    const prose = plain(line);
    if (prose) lastProse = prose.length > 80 ? `${prose.slice(0, 79)}…` : prose;
  }
  return out;
}

const cells = (row: string) => row.trim().replace(/^\||\|$/g, "").split("|").map((c) => plain(c)).filter(Boolean);

/** A line as plain text: no list/heading markers, emphasis, code ticks, links or trailing colon. */
function plain(line: string): string {
  return line
    .replace(/^\s*(#{1,6}\s+|[-*+]\s+|\d+\.\s+|>\s*)/, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~]/g, "")
    .trim()
    .replace(/:$/, "")
    .trim();
}

/** A render_ui node's name: the call's title, else the first title/label-ish prop in the tree. */
function uiTitle(root: RawNode, title: string | undefined): string {
  if (title) return title;
  const seen: RawNode[] = [root];
  while (seen.length) {
    const n = seen.shift()!;
    const p = n.props ?? {};
    if (n.type === "PullRequest" && typeof p.repo === "string") return `${p.repo} #${String(p.number ?? "")}`.trim();
    for (const k of ["title", "label"]) if (typeof p[k] === "string" && p[k]) return p[k] as string;
    if (n.type === "Markdown" && typeof p.text === "string") {
      const first = p.text.split("\n").map(plain).find(Boolean);
      if (first) return first.length > 80 ? `${first.slice(0, 79)}…` : first;
    }
    seen.push(...(n.children ?? []));
  }
  return root.type;
}

function uiSub(root: RawNode): string {
  const p = root.props ?? {};
  if (root.type === "PullRequest" && typeof p.state === "string") return `PullRequest · ${p.state[0]!.toUpperCase()}${p.state.slice(1)}`;
  if (root.type === "Chart" && typeof p.kind === "string") return `Chart · ${p.kind}`;
  return root.type;
}

/**
 * Every artifact of the Session, oldest first. render_ui calls with an id are one artifact
 * (latest content; inline ones stay at the row where they first appeared), removed ones drop out.
 */
export function collectArtifacts(items: Item[]): Artifact[] {
  const out: Artifact[] = [];
  /** render_ui id -> its artifact (in `out`). */
  const byId = new Map<string, Artifact>();
  let turn = 0;
  let prompt = "";
  for (const it of items) {
    if (it.type === "user") {
      turn++;
      prompt = it.text.split("\n").map(plain).find(Boolean) ?? "";
      continue;
    }
    if (it.type === "agent") {
      for (const m of markdownArtifacts(it.text)) {
        out.push({ key: `${it.id}:${m.kind}:${m.index}`, ...m, rowId: it.id, placement: "inline", slotId: null, ts: it.ts, turn, prompt, ui: null });
      }
      continue;
    }
    if (it.type !== "frontend_tool" || !it.render?.ok) continue;
    const v = it.render.value;
    const old = v.id ? byId.get(v.id) : undefined;
    if (v.remove || !v.root) {
      if (old) {
        out.splice(out.indexOf(old), 1);
        byId.delete(v.id!);
      }
      continue;
    }
    const placement = v.placement ?? "inline";
    const a: Artifact = {
      key: v.id ? `ui:${v.id}` : it.id,
      kind: "ui",
      title: uiTitle(v.root, v.title),
      sub: uiSub(v.root),
      rowId: placement === "inline" ? (old?.placement === "inline" ? old.rowId : it.id) : null,
      index: null,
      placement,
      slotId: v.id ?? null,
      ts: it.ts,
      turn: old?.placement === "inline" && placement === "inline" ? old.turn : turn,
      prompt: old?.placement === "inline" && placement === "inline" ? old.prompt : prompt,
      source: JSON.stringify(v.root, null, 2),
      ui: { root: v.root, files: it.files },
    };
    if (old) {
      // Replaced in place while inline; moving to another placement makes it new again.
      if (old.placement === "inline" && placement === "inline") out[out.indexOf(old)] = a;
      else {
        out.splice(out.indexOf(old), 1);
        out.push(a);
      }
    } else out.push(a);
    if (v.id) byId.set(v.id, a);
  }
  return out;
}

/** Artifacts of `kind` (or all) whose title, kind line or source contain `query` (any case). */
export function filterArtifacts(list: Artifact[], kind: ArtifactKind | "all", query: string): Artifact[] {
  const q = query.trim().toLowerCase();
  return list.filter((a) => (kind === "all" || a.kind === kind) && (!q || `${a.title}\n${a.sub}\n${a.source}`.toLowerCase().includes(q)));
}
