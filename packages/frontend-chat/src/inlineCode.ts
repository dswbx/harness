import { useSyncExternalStore } from "react";
import { common, createLowlight } from "lowlight";

const lowlight = createLowlight(common);

type Node = { type: string; tagName?: string; value?: string; properties?: Record<string, unknown>; children?: Node[] };

/** `{:lang}` before inline code names its language (the Shiki convention); `{:plain}` or an unknown one shows it plain. */
const PREFIX = /^\{:([\w+#-]+)\}/;
/** Unmarked inline code is guessed only when it looks like code: calls, objects, arrows, assignments. Names, paths and
 * dotted keys (`email`, `use-auth.ts`, `auth.user.change`) stay plain. */
const CODE_LIKE = /[(){}]|=>|\s=\s|;\s*$/;
/** Guess when the message gives no hint. */
export const FALLBACK = "typescript";

/** Programming languages a message hints at by file extension. Shell, data and docs (`.sh`, `.json`, `.md`) are left
 * out: a message about Rust often runs a command or shows a config too. */
const EXTENSIONS: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript",
  cjs: "javascript", rs: "rust", py: "python", go: "go", rb: "ruby", java: "java", kt: "kotlin", swift: "swift", c: "c", h: "c",
  cc: "cpp", cpp: "cpp", hpp: "cpp", cs: "csharp", php: "php", lua: "lua", scala: "scala", css: "css", scss: "scss", sql: "sql",
};
const PROGRAMMING = new Set(Object.values(EXTENSIONS));
const EXT = new RegExp(`\\w\\.(${Object.keys(EXTENSIONS).join("|")})\\b`, "g");

const classes = (n: Node) => (Array.isArray(n.properties?.className) ? (n.properties.className as string[]) : []);

/** The language a message is about: the most common one among its code blocks, else among the file extensions it
 * mentions (first seen wins a tie); null without a hint. */
export function messageLanguage(tree: Node): string | null {
  const blocks = new Map<string, number>();
  const exts = new Map<string, number>();
  const count = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  const walk = (node: Node, parent?: Node) => {
    if (node.tagName === "code" && parent?.tagName === "pre") {
      const lang = classes(node).find((c) => c.startsWith("language-"))?.slice(9).toLowerCase();
      const name = lang && (EXTENSIONS[lang] ?? lang);
      if (name && PROGRAMMING.has(name)) count(blocks, name);
      return;
    }
    // A snippet's member access (`config.go()`) is not a file name.
    if (node.tagName === "code" && CODE_LIKE.test(node.children?.[0]?.value ?? "")) return;
    if (node.type === "text") for (const m of node.value!.matchAll(EXT)) count(exts, EXTENSIONS[m[1]!]!);
    for (const c of node.children ?? []) walk(c, node);
  };
  walk(tree);
  const top = (m: Map<string, number>) => [...m].reduce<[string, number] | null>((a, b) => (!a || b[1] > a[1] ? b : a), null)?.[0] ?? null;
  return top(blocks) ?? top(exts);
}

/** The language inline code is highlighted as, and the code without its `{:lang}` prefix. `guess`: the language for
 * unmarked code-like snippets, null to leave them plain. */
export function inlineLanguage(text: string, guess: string | null = FALLBACK): { lang: string | null; code: string } {
  const m = PREFIX.exec(text);
  if (m) {
    const lang = m[1]!.toLowerCase();
    return { lang: lowlight.registered(lang) ? lang : null, code: text.slice(m[0].length) };
  }
  return { lang: guess && CODE_LIKE.test(text) ? guess : null, code: text };
}

/** Rehype plugin: highlight.js tokens for inline code (`code` outside `pre`), colored by the shared code theme.
 * `guess`: unmarked code-like snippets take the message's language (`messageLanguage`), else `FALLBACK`. */
export function rehypeInlineCode({ guess = true }: { guess?: boolean } = {}) {
  return (tree: Node) => {
    const lang = guess ? (messageLanguage(tree) ?? FALLBACK) : null;
    const walk = (node: Node, parent?: Node) => {
      if (node.type === "element" && node.tagName === "code" && parent?.tagName !== "pre") {
        const text = node.children?.length === 1 && node.children[0]!.type === "text" ? node.children[0]!.value! : null;
        if (text === null) return;
        const { lang: l, code } = inlineLanguage(text, lang);
        node.children = l ? (lowlight.highlight(l, code).children as Node[]) : [{ type: "text", value: code }];
        return;
      }
      for (const c of node.children ?? []) walk(c, node);
    };
    walk(tree);
  };
}

// Per-viewer choice (Settings > Appearance), on by default; every chat follows it, across windows too.
const KEY = "harness.chat.guessInlineCode";
const listeners = new Set<() => void>();
const read = () => {
  try { return localStorage.getItem(KEY) !== "off"; } catch { return true; }
};
const subscribe = (f: () => void) => {
  listeners.add(f);
  const onStorage = (e: StorageEvent) => e.key === KEY && f();
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(f);
    window.removeEventListener("storage", onStorage);
  };
};

export function setGuessInlineCode(on: boolean) {
  try { localStorage.setItem(KEY, on ? "on" : "off"); } catch { /* per-viewer convenience only */ }
  listeners.forEach((f) => f());
}

/** Whether unmarked inline code that looks like code is highlighted in a guessed language. */
export const useGuessInlineCode = () => useSyncExternalStore(subscribe, read);
