import {
   type PrEntry,
   type PrInfo,
   type PrRefContext,
   type PrRefKey,
   prKey,
   type RepoId,
   repoName,
   sameRepo,
} from "@harness/api";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import type { Item } from "../../state/reducer";
import { type FileRef, fileRefKey, lineLabel, linkFileRef, parseFileRef } from "../files/fileRefs";
import { type Node, prAutolink, walkPrRefs } from "../prRefs/rehypePrRefs";

/** One place a Reference is named: `hit` in its message, with the text around it. */
export type Mention = {
   rowId: string;
   /** 1-based Turn (user prompt); 0 before the first prompt. */
   turn: number;
   who: "you" | "agent";
   ts: number;
   before: string;
   hit: string;
   after: string;
   /** `L12–20` for a file ref with lines. */
   range: string | null;
};

/** What a message names, before anyone checked that it exists. */
export type ReferenceCandidate =
   | { kind: "pr"; key: string; ref: PrRefKey; mentions: Mention[] }
   | { kind: "file"; key: string; ref: FileRef; mentions: Mention[] }
   | { kind: "link"; key: string; url: string; title: string | null; mentions: Mention[] };

/** A file, PR or link named in the Session's messages; one per target, mentions newest first. */
export type Reference =
   | { kind: "pr"; key: string; pr: PrInfo; ts: number; mentions: Mention[] }
   | {
        kind: "code";
        key: string;
        /** Relative to the Session's folder when `inside`; else as written. */
        path: string;
        name: string;
        dir: string;
        /** In the Session's folder: its lines can be read. */
        inside: boolean;
        ranges: FileRef[];
        changed: boolean;
        ts: number;
        mentions: Mention[];
     }
   | {
        kind: "link";
        key: string;
        url: string;
        site: string;
        title: string;
        ts: number;
        mentions: Mention[];
     };
export type ReferenceKind = Reference["kind"];

const NO_CONTEXT: PrRefContext = { sessionRepo: null, knownRepos: [] };
const QUOTE_BEFORE = 44;
const QUOTE_AFTER = 54;

const quoteText = (s: string) => s.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*`~]/g, "");
const quoteBefore = (s: string) => {
   const t = quoteText(s).replace(/^\s*(#{1,6}\s+|[-*+]\s+|\d+\.\s+|>\s*)/, "");
   return t.length > QUOTE_BEFORE ? `…${t.slice(-QUOTE_BEFORE)}` : t;
};
const quoteAfter = (s: string) => {
   const t = quoteText(s);
   return t.length > QUOTE_AFTER ? `${t.slice(0, QUOTE_AFTER)}…` : t;
};

const http = (url: string) => /^https?:\/\//i.test(url);

type Target =
   | { kind: "pr"; ref: PrRefKey }
   | { kind: "file"; ref: FileRef }
   | { kind: "link"; url: string; title: string | null };
/** `start`/`end`: offsets in the message text. */
type Found = { start: number; end: number; hit: string; target: Target };

/** The same Markdown pass the chat renders with (`Markdown.tsx`): CommonMark + GFM to a rendered tree. */
const markdown = unified().use(remarkParse).use(remarkGfm).use(remarkRehype);
/** Text with none of these has no ref, so there is nothing to parse. */
const MAYBE_REF = /[`#[]|https?:|www\./i;

const textOf = (n: Node): string => n.value ?? (n.children ?? []).map(textOf).join("");

/**
 * What a message names, from its rendered tree, so what counts is what the chat marks: file refs in inline code and
 * links, PR refs in text (`walkPrRefs`: not a bare `#N` unless written `PR #N`, not headings, code or links) and PR
 * autolinks, every other http link.
 */
function scan(text: string, ctx: PrRefContext): Found[] {
   if (!MAYBE_REF.test(text)) return [];
   const tree = markdown.runSync(markdown.parse(text)) as Node;
   const out: Found[] = [];
   const span = (n: Node): [number, number] | null => {
      const s = n.position?.start.offset;
      const e = n.position?.end.offset;
      return s === undefined || e === undefined ? null : [s, e];
   };
   walkPrRefs(tree, ctx, (node, hits) => {
      const [from, to] = span(node) ?? [0, 0];
      for (const h of hits) {
         if (node.type === "element") {
            out.push({ start: from, end: to, hit: h.raw, target: { kind: "pr", ref: h.key } });
            continue;
         }
         // The text can differ from the source (escapes); look for the ref from where it should be.
         let start = from + h.start;
         if (!text.startsWith(h.raw, start)) start = Math.max(text.indexOf(h.raw, from), from);
         out.push({
            start,
            end: start + h.raw.length,
            hit: h.raw,
            target: { kind: "pr", ref: h.key },
         });
      }
      return undefined;
   });
   const walk = (n: Node, parent?: Node) => {
      if (n.type === "text" || n.tagName === "pre") return;
      const at = span(n);
      if (n.tagName === "code" && parent?.tagName !== "a") {
         const only = n.children?.length === 1 ? n.children[0]! : null;
         if (only?.type !== "text" || only.value!.startsWith("{:") || !at) return;
         const ref = parseFileRef(only.value!);
         if (ref)
            out.push({ start: at[0], end: at[1], hit: only.value!, target: { kind: "file", ref } });
         return;
      }
      if (n.tagName === "a") {
         const href = typeof n.properties?.href === "string" ? n.properties.href : "";
         if (!at || prAutolink(n, ctx)) return;
         const name = textOf(n).replace(/[*_`~]/g, "");
         const ref = linkFileRef(href, name);
         if (ref) out.push({ start: at[0], end: at[1], hit: name, target: { kind: "file", ref } });
         else if (http(href)) {
            // An autolink (its text is the URL, or `www.` form of it) has no title.
            const bare = !name || name === href || `http://${name}` === href;
            out.push({
               start: at[0],
               end: at[1],
               hit: name || href,
               target: { kind: "link", url: href, title: bare ? null : name },
            });
         }
         return;
      }
      for (const c of n.children ?? []) walk(c, n);
   };
   walk(tree);
   return out.sort((a, b) => a.start - b.start);
}

/** `scan` per message, kept while the message and the PR context stay the same objects (streaming replaces only the
 * growing message), so a chunk parses one message, not all. */
const scanned = new WeakMap<Item, { ctx: PrRefContext; found: Found[] }>();
function scanItem(it: Item & { text: string }, ctx: PrRefContext): Found[] {
   const hit = scanned.get(it);
   if (hit?.ctx === ctx) return hit.found;
   const found = scan(it.text, ctx);
   scanned.set(it, { ctx, found });
   return found;
}

/** Everything the Session's user and Agent messages name, one candidate per target, in order of first mention. */
export function collectReferences(
   items: Item[],
   ctx: PrRefContext | null = null,
): ReferenceCandidate[] {
   const byKey = new Map<string, ReferenceCandidate>();
   let turn = 0;
   for (const it of items) {
      if (it.type !== "user" && it.type !== "agent") continue;
      if (it.type === "user") turn++;
      const who = it.type === "user" ? "you" : "agent";
      const text = it.text;
      for (const f of scanItem(it, ctx ?? NO_CONTEXT)) {
         const t = f.target;
         const key = t.kind === "pr" ? prKey(t.ref) : t.kind === "file" ? fileRefKey(t.ref) : t.url;
         const id = `${t.kind}:${key}`;
         let c = byKey.get(id);
         if (!c) {
            c = { ...t, key, mentions: [] } as ReferenceCandidate;
            byKey.set(id, c);
         }
         if (c.kind === "link" && !c.title && t.kind === "link") c.title = t.title;
         const lineStart = text.lastIndexOf("\n", f.start - 1) + 1;
         const lineEnd = text.indexOf("\n", f.end);
         c.mentions.push({
            rowId: it.id,
            turn,
            who,
            ts: it.ts,
            before: quoteBefore(text.slice(lineStart, f.start)),
            hit: f.hit,
            after: quoteAfter(text.slice(f.end, lineEnd < 0 ? text.length : lineEnd)),
            range: t.kind === "file" ? lineLabel(t.ref) : null,
         });
      }
   }
   return [...byKey.values()];
}

/** A path that can't be in the Session's folder unless the read says so; the read can't tell if it exists. */
export const outsidePath = (path: string) => path.startsWith("/") || path.startsWith("../");

const newestFirst = (m: Mention[]) => [...m].sort((a, b) => b.ts - a.ts);
const latest = (m: Mention[]) => m.reduce((t, x) => Math.max(t, x.ts), 0);
const splitPath = (path: string) => {
   const i = path.lastIndexOf("/");
   return { name: path.slice(i + 1), dir: i < 0 ? "." : i === 0 ? "/" : path.slice(0, i) };
};
const siteOf = (url: string) => {
   try {
      return new URL(url).hostname.replace(/^www\./, "");
   } catch {
      return url;
   }
};

/** What resolving needs: the PR store's entry, and a file's real path (undefined: not read yet; null: no such file). */
export type ReferenceLookups = {
   pr: (ref: PrRefKey) => PrEntry | null;
   file: (ref: FileRef) => { path: string } | null | undefined;
   changed: ReadonlySet<string>;
};

/**
 * The candidates that exist. PRs: found by a lookup. Files: read from the Session's folder, merged by the real path (a
 * name can be the end of a path). Absolute and `../` paths can't be read, so they stay, unchecked and without lines,
 * except when the read found them inside. Links always stay.
 */
export function resolveReferences(
   candidates: ReferenceCandidate[],
   { pr, file, changed }: ReferenceLookups,
): { refs: Reference[]; prsUnavailable: boolean } {
   const refs: Reference[] = [];
   const files = new Map<string, Extract<Reference, { kind: "code" }>>();
   let prsUnavailable = false;
   for (const c of candidates) {
      if (c.kind === "pr") {
         const entry = pr(c.ref);
         if (!entry || entry.status === "unavailable") prsUnavailable = true;
         if (entry?.status === "found")
            refs.push({
               kind: "pr",
               key: c.key,
               pr: entry.pr,
               ts: latest(c.mentions),
               mentions: newestFirst(c.mentions),
            });
      } else if (c.kind === "link") {
         refs.push({
            kind: "link",
            key: c.key,
            url: c.key,
            site: siteOf(c.url),
            title: c.title ?? c.url.replace(/^https?:\/\//i, ""),
            ts: latest(c.mentions),
            mentions: newestFirst(c.mentions),
         });
      } else {
         const found = file(c.ref);
         if (found === undefined || (found === null && !outsidePath(c.ref.path))) continue;
         const path = found?.path ?? c.ref.path;
         let f = files.get(path);
         if (!f) {
            f = {
               kind: "code",
               key: path,
               path,
               ...splitPath(path),
               inside: !!found,
               ranges: [],
               changed: !!found && changed.has(path),
               ts: 0,
               mentions: [],
            };
            files.set(path, f);
            refs.push(f);
         }
         const ref = { ...c.ref, path };
         if (
            ref.start !== null &&
            !f.ranges.some((r) => r.start === ref.start && r.end === ref.end)
         )
            f.ranges.push(ref);
         f.mentions = newestFirst([...f.mentions, ...c.mentions]);
         f.ts = latest(f.mentions);
      }
   }
   for (const f of files.values()) f.ranges.sort((a, b) => a.start! - b.start!);
   return { refs, prsUnavailable };
}

const haystack = (r: Reference) =>
   r.kind === "pr"
      ? `${repoName(r.pr.repo)}#${r.pr.number} ${r.pr.title} ${r.pr.state}`
      : r.kind === "code"
        ? r.path
        : `${r.title} ${r.url}`;

export const filterReferences = (refs: Reference[], query: string) => {
   const q = query.trim().toLowerCase();
   return q ? refs.filter((r) => haystack(r).toLowerCase().includes(q)) : refs;
};

export type ReferenceSection = {
   key: string;
   title: string;
   /** A path after the title. */
   note: string;
   /** "Session", "This repo". */
   tag: string | null;
   /** Rows under a folder row (code in the Session's folder); `items` sit directly in the section, after them. */
   dirs: { label: string; items: Reference[] }[];
   items: Reference[];
};

const STATE_ORDER = { open: 0, draft: 1, merged: 2, closed: 3 };

/** Newest first. */
export const byRecency = (refs: Reference[]) => [...refs].sort((a, b) => b.ts - a.ts);

/**
 * One kind's references by where they live: code by workspace (the Session's folder first, its files by folder; a
 * folder of its own for each other path, as nothing here knows other workspaces' roots), PRs by repository (the
 * Session's first; open ones first), links by site.
 */
export function groupReferences(
   refs: Reference[],
   kind: ReferenceKind,
   sessionRepo: RepoId | null,
): ReferenceSection[] {
   const of = refs.filter((r) => r.kind === kind);
   const section = (key: string, title: string, note = "", tag: string | null = null) => ({
      key,
      title,
      note,
      tag,
      dirs: [],
      items: [],
   });
   const add = (map: Map<string, ReferenceSection>, s: ReferenceSection) =>
      map.get(s.key) ?? (map.set(s.key, s), s);
   if (kind === "pr") {
      const out = new Map<string, ReferenceSection>();
      const prs = of as Extract<Reference, { kind: "pr" }>[];
      const sorted = [...prs].sort(
         (a, b) => STATE_ORDER[a.pr.state] - STATE_ORDER[b.pr.state] || b.ts - a.ts,
      );
      if (sessionRepo && sorted.some((r) => sameRepo(r.pr.repo, sessionRepo)))
         add(out, section(repoName(sessionRepo), repoName(sessionRepo), "", "This repo"));
      for (const r of sorted) {
         const name = sessionRepo && sameRepo(r.pr.repo, sessionRepo) ? sessionRepo : r.pr.repo;
         add(out, section(repoName(name), repoName(name))).items.push(r);
      }
      return [...out.values()];
   }
   if (kind === "link") {
      const out = new Map<string, ReferenceSection>();
      for (const r of byRecency(of) as Extract<Reference, { kind: "link" }>[])
         add(out, section(r.site, r.site)).items.push(r);
      return [...out.values()];
   }
   const code = of as Extract<Reference, { kind: "code" }>[];
   const out: ReferenceSection[] = [];
   const inside = code.filter((r) => r.inside);
   if (inside.length) {
      const session: ReferenceSection = section(
         "session",
         sessionRepo?.name ?? "Session folder",
         "",
         "Session",
      );
      const dirs = new Map<string, Reference[]>();
      for (const r of inside)
         if (r.dir === ".") session.items.push(r);
         else dirs.set(r.dir, [...(dirs.get(r.dir) ?? []), r]);
      session.items = byName(session.items);
      session.dirs = [...dirs.keys()]
         .sort()
         .map((label) => ({ label, items: byName(dirs.get(label)!) }));
      out.push(session);
   }
   const others = new Map<string, ReferenceSection>();
   for (const r of code.filter((x) => !x.inside))
      add(
         others,
         section(r.dir, r.dir.slice(r.dir.lastIndexOf("/") + 1) || r.dir, r.dir),
      ).items.push(r);
   return [...out, ...[...others.values()].sort((a, b) => a.key.localeCompare(b.key))];
}

const byName = (refs: Reference[]) =>
   [...refs].sort((a, b) =>
      a.kind === "code" && b.kind === "code" ? a.name.localeCompare(b.name) : 0,
   );
