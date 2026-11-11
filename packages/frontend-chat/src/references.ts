import {
   findPrRefs,
   isExplicit,
   type PrEntry,
   type PrInfo,
   type PrRefContext,
   type PrRefKey,
   prKey,
   qualify,
   type RepoId,
   repoName,
   sameRepo,
} from "@harness/api";
import { type FileRef, fileRefKey, lineLabel, linkFileRef, parseFileRef } from "./fileRefs";
import type { Item } from "./reducer";

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
/** Inline code | a link or image | an autolink | a bare URL. */
const TOKEN =
   /`([^`\n]+)`|(!?)\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"\n]*")?\)|<(https?:\/\/[^>\s]+)>|(https?:\/\/[^\s<>()[\]]+)/g;
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
const prUrl = (url: string) => /\/pull\/\d+/.test(url);

type Target =
   | { kind: "pr"; ref: PrRefKey }
   | { kind: "file"; ref: FileRef }
   | { kind: "link"; url: string; title: string | null };
type Found = { start: number; end: number; hit: string; target: Target };

/** The refs of one Markdown line, the same ones the chat marks: file refs in inline code and links, PR refs in text
 * (not a bare `#N` unless written `PR #N`, not headings) and bare PR URLs, every other http link. */
function scanLine(line: string, ctx: PrRefContext): Found[] {
   const out: Found[] = [];
   const heading = /^\s{0,3}#{1,6}\s/.test(line);
   const text = (from: number, to: number) => {
      if (heading || to <= from) return;
      for (const m of findPrRefs(line.slice(from, to), ctx)) {
         if (!isExplicit(m)) continue;
         const ref = qualify(m, ctx);
         if (ref)
            out.push({
               start: from + m.start,
               end: from + m.end,
               hit: m.raw,
               target: { kind: "pr", ref },
            });
      }
   };
   const url = (raw: string, start: number, end: number) => {
      const clean = raw.replace(/[.,;:!?'"]+$/, "");
      const ref = prUrl(clean) ? qualify(clean, ctx) : null;
      out.push({
         start,
         end: start + clean.length + (end - start - raw.length),
         hit: clean,
         target: ref ? { kind: "pr", ref } : { kind: "link", url: clean, title: null },
      });
   };
   let at = 0;
   for (const m of line.matchAll(TOKEN)) {
      const [raw, code, bang, label, href, auto, bare] = m;
      const start = m.index;
      const end = start + raw.length;
      text(at, start);
      at = end;
      if (code !== undefined) {
         if (code.startsWith("{:")) continue;
         const ref = parseFileRef(code);
         if (ref) out.push({ start, end, hit: code, target: { kind: "file", ref } });
      } else if (href !== undefined) {
         if (bang) continue;
         const name = label!.replace(/[*_`~]/g, "");
         const ref = linkFileRef(href, name);
         if (ref) out.push({ start, end, hit: name, target: { kind: "file", ref } });
         else if (name === href) url(href, start, end);
         else if (http(href))
            out.push({ start, end, hit: name, target: { kind: "link", url: href, title: name } });
      } else url((auto ?? bare)!, start, end);
   }
   text(at, line.length);
   return out.sort((a, b) => a.start - b.start);
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
      let fence: RegExp | null = null;
      for (const line of it.text.split("\n")) {
         if (fence) {
            if (fence.test(line)) fence = null;
            continue;
         }
         const open = /^\s*(`{3,}|~{3,})/.exec(line);
         if (open) {
            fence = new RegExp(`^\\s*${open[1]![0]}{${open[1]!.length},}\\s*$`);
            continue;
         }
         for (const f of scanLine(line, ctx ?? NO_CONTEXT)) {
            const t = f.target;
            const key =
               t.kind === "pr" ? prKey(t.ref) : t.kind === "file" ? fileRefKey(t.ref) : t.url;
            const id = `${t.kind}:${key}`;
            let c = byKey.get(id);
            if (!c) {
               c = { ...t, key, mentions: [] } as ReferenceCandidate;
               byKey.set(id, c);
            }
            if (c.kind === "link" && !c.title && t.kind === "link") c.title = t.title;
            c.mentions.push({
               rowId: it.id,
               turn,
               who,
               ts: it.ts,
               before: quoteBefore(line.slice(0, f.start)),
               hit: f.hit,
               after: quoteAfter(line.slice(f.end)),
               range: t.kind === "file" ? lineLabel(t.ref) : null,
            });
         }
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
