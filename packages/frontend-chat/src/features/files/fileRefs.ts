/** A file reference in a message: `path`, `path:line` or `path:start-end` (also `path#L12-L20`, `path:12:5`). */
export type FileRef = { path: string; start: number | null; end: number | null };

/** Extensions a bare file name (no `/`) needs to count as a file; with a `/`, any letter extension does. */
const FILE_EXTENSIONS = new Set(
   (
      "rs ts tsx mts cts js jsx mjs cjs json jsonc json5 md mdx toml yaml yml py go rb java kt kts swift c h cc cpp " +
      "hpp cs php lua scala css scss sass less html htm vue svelte astro sql sh bash zsh fish txt lock env xml " +
      "gradle proto graphql gql ex exs erl hs ml zig nix dart r jl vim el clj tf ini cfg conf"
   ).split(" "),
);
/** Extensionless file names that are still files. */
const BARE_NAMES = new Set([
   "Makefile",
   "Dockerfile",
   "Justfile",
   "Cargo.lock",
   "LICENSE",
   "Gemfile",
]);

const LINES = /(?::(\d+)(?:[-–](\d+)|:\d+)?|#L(\d+)(?:-L?(\d+))?)$/;
/** A path: no spaces, quotes, brackets, globs or call syntax. */
const PATH = /^(?:\.{1,2}\/|\/)?[\w@.+-]+(?:\/[\w@.+-]+)*$/;

/** The file reference `text` is, or null: `crates/engine/src/lib.rs:220-230` is one; `a.b`, `foo()`, URLs are not.
 * Trailing punctuation (`lib.rs:12.`) is ignored. Whether the file exists is up to the reader. */
export function parseFileRef(text: string): FileRef | null {
   let t = text.trim().replace(/[.,;:!?)\]'"`]+$/, "");
   if (!t || t.length > 300 || /^[a-z][\w+.-]*:\/\//i.test(t) || t.startsWith("www.")) return null;
   let start: number | null = null;
   let end: number | null = null;
   const m = LINES.exec(t);
   if (m) {
      start = Number(m[1] ?? m[3]);
      const e = m[2] ?? m[4];
      end = e ? Number(e) : start;
      if (start < 1 || end < start) return null;
      t = t.slice(0, m.index);
   }
   if (!PATH.test(t) || /(^|\/)\.\.?$/.test(t)) return null;
   const name = t.slice(t.lastIndexOf("/") + 1);
   const dot = name.lastIndexOf(".");
   const ext = dot > 0 ? name.slice(dot + 1) : "";
   const isFile = t.includes("/")
      ? /^[a-z][a-z0-9]{0,9}$/i.test(ext) || BARE_NAMES.has(name)
      : FILE_EXTENSIONS.has(ext.toLowerCase()) || BARE_NAMES.has(name);
   return isFile ? { path: t, start, end } : null;
}

/** Lines shown around a reference: 5 before and after its lines; a bare path shows its first 11. At most 60. */
export const CONTEXT = 5;
export function refWindow(ref: FileRef): { from: number; to: number } {
   if (ref.start === null) return { from: 1, to: 1 + 2 * CONTEXT };
   const from = Math.max(1, ref.start - CONTEXT);
   return { from, to: Math.min((ref.end ?? ref.start) + CONTEXT, from + 59) };
}

/** `L220–230` / `L12`, or null for a bare path. */
export const lineLabel = (ref: FileRef) =>
   ref.start === null
      ? null
      : ref.end !== null && ref.end !== ref.start
        ? `L${ref.start}–${ref.end}`
        : `L${ref.start}`;

/** The key a file ref is stored under in `data-file-ref` (and the read cache). */
export const fileRefKey = (r: FileRef) => `${r.start ?? ""}:${r.end ?? ""}:${r.path}`;
export function parseFileRefKey(key: string): FileRef | null {
   const m = /^(\d*):(\d*):(.+)$/.exec(key);
   if (!m) return null;
   return { path: m[3]!, start: m[1] ? Number(m[1]) : null, end: m[2] ? Number(m[2]) : null };
}

type Node = {
   type: string;
   tagName?: string;
   value?: string;
   properties?: Record<string, unknown>;
   children?: Node[];
};
const textOf = (n: Node): string => n.value ?? (n.children ?? []).map(textOf).join("");
const decode = (s: string) => {
   try {
      return decodeURI(s);
   } catch {
      return s;
   }
};
const hasScheme = (href: string) =>
   /^[a-z][\w+.-]*:\/\//i.test(href) || /^(mailto|tel):/i.test(href);

/** The file reference a Markdown link is: by its href, or by its text when the href is relative. */
export function linkFileRef(href: string, text: string): FileRef | null {
   return parseFileRef(decode(href)) ?? (hasScheme(href) ? null : parseFileRef(text));
}

/** Rehype plugin: marks inline code (`code` outside `pre`, not `{:lang}`-prefixed) and links whose text (or relative
 * href) is a file reference with `data-file-ref` (see `fileRefKey`). Runs before `rehypeInlineCode`. */
export function rehypeFileRefs() {
   return (tree: Node) => {
      const walk = (node: Node, parent?: Node) => {
         if (node.type === "element" && node.tagName === "pre") return;
         if (node.type === "element" && node.tagName === "code" && parent?.tagName !== "a") {
            const only = node.children?.length === 1 ? node.children[0]! : null;
            if (only?.type !== "text" || only.value!.startsWith("{:")) return;
            const ref = parseFileRef(only.value!);
            if (ref) node.properties = { ...node.properties, dataFileRef: fileRefKey(ref) };
            return;
         }
         if (node.type === "element" && node.tagName === "a") {
            const href = typeof node.properties?.href === "string" ? node.properties.href : "";
            const ref = linkFileRef(href, textOf(node));
            if (ref) node.properties = { ...node.properties, dataFileRef: fileRefKey(ref) };
            return;
         }
         for (const c of node.children ?? []) walk(c, node);
      };
      walk(tree);
   };
}
