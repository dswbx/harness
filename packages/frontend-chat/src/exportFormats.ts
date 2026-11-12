import { drawMermaid } from "./drawMermaid";
import type { RawNode } from "./tools";
import { standaloneSvg, svgToPng } from "./toPng";

/** One download: a menu entry and how to make the file. */
export type ExportFormat = { label: string; file: string; blob: () => Promise<Blob> };

/** A table's cells (the header first) as plain text, from its Markdown. */
export function markdownTableRows(md: string): string[][] {
   return md
      .split("\n")
      .map((l) => l.replace(/^\s*(>\s*)*/, "").trim())
      .filter((l, i) => l && i !== 1)
      .map((l) =>
         l
            .replace(/^\||(?<!\\)\|$/g, "")
            .split(/(?<!\\)\|/)
            .map(cellText),
      );
}

/** A Markdown cell as plain text: no emphasis, code ticks or link targets. */
function cellText(cell: string): string {
   return cell
      .replace(/\\\|/g, "|")
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/`([^`]*)`/g, "$1")
      .replace(/(\*\*|__)(.+?)\1/g, "$2")
      .replace(/(^|[\s(])[*_](\S(?:.*?\S)?)[*_](?=$|[\s).,:;!?])/g, "$1$2")
      .replace(/~~(.+?)~~/g, "$1")
      .replace(/<br\s*\/?>/gi, " ")
      .trim();
}

export const rowsToCsv = (rows: string[][]) =>
   rows
      .map((r) => r.map((c) => (/[",\r\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(","))
      .join("\n");

/** Tabs and newlines would end a cell here: they become spaces. */
export const rowsToTsv = (rows: string[][]) =>
   rows.map((r) => r.map((c) => c.replace(/[\t\r\n]+/g, " ")).join("\t")).join("\n");

export function rowsToMarkdown(rows: string[][]): string {
   const line = (r: string[]) =>
      `| ${r.map((c) => c.replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ")).join(" | ")} |`;
   const [head = [], ...body] = rows;
   return [line(head), line(head.map(() => "---")), ...body.map(line)].join("\n");
}

const text = (s: string, type: string) => () => Promise.resolve(new Blob([s], { type }));

/** Downloads of a table: its Markdown (the source when there is one), CSV, TSV. */
export function tableFormats(name: string, rows: string[][], markdown?: string): ExportFormat[] {
   return [
      {
         label: "Markdown",
         file: `${name}.md`,
         blob: text(markdown ?? rowsToMarkdown(rows), "text/markdown"),
      },
      { label: "CSV", file: `${name}.csv`, blob: text(rowsToCsv(rows), "text/csv") },
      {
         label: "TSV",
         file: `${name}.tsv`,
         blob: text(rowsToTsv(rows), "text/tab-separated-values"),
      },
   ];
}

/** A diagram as a standalone SVG, in the app's theme. Throws Mermaid's message when it does not parse. */
export async function mermaidSvg(source: string) {
   const dark = document.documentElement.classList.contains("dark");
   const out = await drawMermaid(dark, source);
   if ("error" in out) throw new Error(out.error);
   const svg = standaloneSvg(out.svg, getComputedStyle(document.body).fontFamily);
   if (!svg) throw new Error("Mermaid gave a diagram without a size.");
   return svg;
}

export function mermaidFormats(name: string, source: string): ExportFormat[] {
   return [
      {
         label: "PNG",
         file: `${name}.png`,
         blob: async () => svgToPng(await mermaidSvg(source)),
      },
      {
         label: "SVG",
         file: `${name}.svg`,
         blob: async () => new Blob([(await mermaidSvg(source)).xml], { type: "image/svg+xml" }),
      },
      { label: "Mermaid source", file: `${name}.mmd`, blob: text(source, "text/plain") },
   ];
}

const cellOf = (c: unknown): string =>
   c && typeof c === "object" ? String((c as { text?: unknown }).text ?? "") : String(c ?? "");

/** What a render_ui tree can also be downloaded as, besides an image: by its root (the data, when it has plain data). */
export function uiFormats(name: string, root: RawNode): ExportFormat[] {
   const p = root.props ?? {};
   if (root.type === "Html" && typeof p.html === "string")
      return [{ label: "HTML", file: `${name}.html`, blob: text(p.html, "text/html") }];
   if (root.type === "Table" && Array.isArray(p.columns) && Array.isArray(p.rows)) {
      const rows = (p.rows as unknown[]).map((r) =>
         (Array.isArray(r) ? r : ((r as { cells?: unknown[] })?.cells ?? [])).map(cellOf),
      );
      return tableFormats(name, [(p.columns as unknown[]).map(String), ...rows]);
   }
   if (root.type === "Chart" && Array.isArray(p.data) && typeof p.x === "string") {
      const series = Array.isArray(p.series) ? (p.series as { key: string }[]) : [];
      const keys = [p.x, ...series.map((s) => s.key)];
      const rows = (p.data as Record<string, unknown>[]).map((d) => keys.map((k) => cellOf(d[k])));
      return [
         {
            label: "CSV data",
            file: `${name}.csv`,
            blob: text(rowsToCsv([keys, ...rows]), "text/csv"),
         },
      ];
   }
   return [];
}

/** A title as a file name: the title itself, without what file systems refuse. */
export const fileName = (title: string) =>
   title
      // biome-ignore lint/suspicious/noControlCharactersInRegex: file systems refuse them
      .replace(/[/\\:*?"<>|\u0000-\u001f]+/g, " ")
      .replace(/\s+/g, " ")
      .slice(0, 100)
      .replace(/^[\s.]+|[\s.]+$/g, "") || "artifact";

/** Downloads of a Shared Artifact's content (ADR 0024), besides its picture: the file, or a tree's own formats. */
export function sharedFormats(
   name: string,
   kind: "md" | "html" | "ui",
   content: string,
   root: RawNode | null,
): ExportFormat[] {
   if (kind === "md")
      return [{ label: "Markdown", file: `${name}.md`, blob: text(content, "text/markdown") }];
   if (kind === "html")
      return [{ label: "HTML", file: `${name}.html`, blob: text(content, "text/html") }];
   return root ? uiFormats(name, root) : [];
}
