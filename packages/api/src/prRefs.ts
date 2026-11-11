// PR references in text (`#17`, `PR #17`, `spark#17`, `supabase/spark#17`, PR URLs): finding, resolving the repo, display.
// Pure, shared by every Frontend that shows PR chips (ADR 0012).
import type { KnownRepo, PrRefKey, RepoId } from "./generated";

/** What refs resolve against: the Session's repo (for `#17`) and the user's known repos (for `repo#17`). */
export type PrRefContext = { sessionRepo: RepoId | null; knownRepos: KnownRepo[] };

/** A ref found in text; `repo` is as typed (`spark`, `supabase/spark`), null for a bare `#17`. */
export type PrRefMatch = {
   start: number;
   end: number;
   raw: string;
   repo: string | null;
   number: number;
   /** `PR #17` or `PR#17`: an explicit ref to the Session's repo (`repo` is null). */
   prefixed: boolean;
};

/** A ref is "explicit" when it names its repo, is a URL, or is written `PR #17` / `PR#17`. Messages chip only these: a bare
 * `#3` is too often a list item or step. */
export const isExplicit = (m: PrRefMatch) => m.repo !== null || m.prefixed;

/** `PR ` right before a bare ref (`PR#17` matches as the repo name `PR`; `findPrRefs` handles that). */
const PR_PREFIX = /(?:^|[\s(])PR $/;

export type RepoResolution =
   | { kind: "one"; repo: RepoId }
   | { kind: "ambiguous"; repos: RepoId[] }
   | { kind: "none" };

/** GitHub owners have no dots (so `x.com/a#3` is no ref); repo names may. */
const OWNER = String.raw`[\w-]+`;
const NAME = String.raw`[\w.-]+`;
// A ref starts at the start, after whitespace or `(`, and ends at the end, whitespace, closing brackets/quotes or
// punctuation not followed by a word (`#3.5` is no ref). So `https://x.com/a#3` and `a/b#3x` stay text.
const REF = new RegExp(
   String.raw`(?<=^|[\s(])(?:https?://(?:www\.)?github\.com/(${OWNER})/(${NAME})/pull/(\d+)(?:/[\w/-]*)?(?:#[\w-]*)?|(?:(?:(${OWNER})/)?(${NAME}))?#(\d+))` +
      String.raw`(?=$|\s|[.,;:!?](?!\w)|[)\]}'"])`,
   "g",
);

const toNumber = (s: string) => {
   const n = Number(s);
   return Number.isSafeInteger(n) && n > 0 ? n : null;
};
export const repoName = (r: RepoId) => `${r.owner}/${r.name}`;
export const sameRepo = (a: RepoId, b: RepoId) =>
   repoName(a).toLowerCase() === repoName(b).toLowerCase();
/** A ref's key for maps and `data-pr-ref`: `owner/repo#17`. */
export const prKey = (k: PrRefKey) => `${repoName(k.repo)}#${k.number}`;
/** The inverse of `prKey`. */
export function parsePrKey(s: string): PrRefKey | null {
   const m = /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(s);
   const number = m && toNumber(m[3]!);
   return m && number ? { repo: { owner: m[1]!, name: m[2]! }, number } : null;
}

/** `fuzzy` allows prefix/substring/subsequence repo matches. Only for UIs where the user picks a match (prompt
 * autocomplete). Message text stays strict: `repo` must equal exactly one known repo's name. */
export type ResolveOpts = { fuzzy?: boolean };

/** Refs in `text`. `repo#17` counts only when `repo` resolves to one known repo, so `issue#3` stays text. */
export function findPrRefs(
   text: string,
   ctx: PrRefContext = { sessionRepo: null, knownRepos: [] },
   opts: ResolveOpts = {},
): PrRefMatch[] {
   const out: PrRefMatch[] = [];
   for (const m of text.matchAll(REF)) {
      const [raw, uOwner, uName, uNum, owner, name, num] = m;
      const number = toNumber(uNum ?? num!);
      if (!number) continue;
      let repo: string | null = null;
      // `PR#17` is `PR #17`, not a repo named `PR`.
      let prefixed = !owner && name === "PR";
      if (uOwner) repo = `${uOwner}/${uName}`;
      else if (owner) repo = `${owner}/${name}`;
      else if (name && !prefixed) {
         if (resolveRepo(name, ctx, opts).kind !== "one") continue;
         repo = name;
      }
      if (repo === null && !prefixed)
         prefixed = PR_PREFIX.test(text.slice(Math.max(0, m.index - 4), m.index));
      out.push({ start: m.index, end: m.index + raw.length, raw, repo, number, prefixed });
   }
   return out;
}

export type FuzzyHit<T> = { item: T; tier: 0 | 1 | 2 | 3; positions: number[] };

/** Case-insensitive match tiers: 0 exact, 1 prefix, 2 substring, 3 subsequence; `positions` are the matched
 * characters. Sorted by tier, then `score` (higher first), then input order. */
export function fuzzyRank<T>(
   query: string,
   items: readonly T[],
   text: (t: T) => string = String,
   score?: (t: T) => number,
): FuzzyHit<T>[] {
   const q = query.toLowerCase();
   const range = (from: number, n: number) => Array.from({ length: n }, (_, i) => from + i);
   const hits: (FuzzyHit<T> & { i: number })[] = [];
   items.forEach((item, i) => {
      const t = text(item).toLowerCase();
      if (t === q) return hits.push({ item, i, tier: 0, positions: range(0, q.length) });
      if (t.startsWith(q)) return hits.push({ item, i, tier: 1, positions: range(0, q.length) });
      const at = t.indexOf(q);
      if (at >= 0) return hits.push({ item, i, tier: 2, positions: range(at, q.length) });
      const positions: number[] = [];
      for (let j = 0, k = 0; j < t.length && k < q.length; j++)
         if (t[j] === q[k]) positions.push(j), k++;
      if (positions.length === q.length) hits.push({ item, i, tier: 3, positions });
   });
   hits.sort((a, b) => a.tier - b.tier || (score ? score(b.item) - score(a.item) : 0) || a.i - b.i);
   return hits.map(({ i: _, ...h }) => h);
}

/** Known repos plus the Session's repo (scored like the best known one when it is not known). */
export function repoCandidates(ctx: PrRefContext): KnownRepo[] {
   const { sessionRepo, knownRepos } = ctx;
   if (!sessionRepo || knownRepos.some((k) => sameRepo(k.repo, sessionRepo))) return knownRepos;
   const top = Math.max(0, ...knownRepos.map((k) => k.score));
   return [...knownRepos, { repo: sessionRepo, sessions: 1, score: top, last_ms: 0 }];
}

/** The repo a typed `repo` or `owner/repo` means. Strict (default): the token must equal exactly one known repo's name
 * (case-insensitive), else "ambiguous" (several) or "none". With `fuzzy`: the best match tier wins, ties go by score;
 * when the top two of that tier are within 25% of each other it is ambiguous. */
export function resolveRepo(
   token: string,
   ctx: PrRefContext,
   { fuzzy = false }: ResolveOpts = {},
): RepoResolution {
   if (!token) return { kind: "none" };
   const full = token.includes("/");
   if (!fuzzy) {
      const t = token.toLowerCase();
      const same = repoCandidates(ctx).filter(
         (k) => (full ? repoName(k.repo) : k.repo.name).toLowerCase() === t,
      );
      if (same.length > 1) return { kind: "ambiguous", repos: same.map((k) => k.repo) };
      return same[0] ? { kind: "one", repo: same[0].repo } : { kind: "none" };
   }
   const hits = fuzzyRank(
      token,
      repoCandidates(ctx),
      (k) => (full ? repoName(k.repo) : k.repo.name),
      (k) => k.score,
   );
   if (!hits.length) return { kind: "none" };
   const best = hits.filter((h) => h.tier === hits[0]!.tier);
   const [a, b] = best;
   if (b && b.item.score >= a!.item.score * 0.75)
      return { kind: "ambiguous", repos: best.map((h) => h.item.repo) };
   return { kind: "one", repo: a!.item.repo };
}

/** The full key of one ref (a string like `#17`, or a match); null when its repo is unknown or ambiguous. */
export function qualify(
   ref: string | PrRefMatch,
   ctx: PrRefContext,
   opts: ResolveOpts = {},
): PrRefKey | null {
   let m: PrRefMatch | undefined;
   if (typeof ref === "string") {
      const s = ref.trim();
      m = findPrRefs(s, ctx, opts).find((x) => x.start === 0 && x.end === s.length);
   } else m = ref;
   if (!m) return null;
   if (m.repo === null) return ctx.sessionRepo ? { repo: ctx.sessionRepo, number: m.number } : null;
   if (m.repo.includes("/")) {
      const [owner, name] = m.repo.split("/") as [string, string];
      const known = repoCandidates(ctx).find((k) => sameRepo(k.repo, { owner, name }));
      return { repo: known?.repo ?? { owner, name }, number: m.number };
   }
   const r = resolveRepo(m.repo, ctx, opts);
   return r.kind === "one" ? { repo: r.repo, number: m.number } : null;
}

/** One display rule everywhere: `#17` in the Session's repo, else the full `owner/repo#17`. */
export function displayRef(key: PrRefKey, ctx: PrRefContext): string {
   if (ctx.sessionRepo && sameRepo(key.repo, ctx.sessionRepo)) return `#${key.number}`;
   return `${repoName(key.repo)}#${key.number}`;
}

/** A PR number from "142", "#142" or a GitHub PR URL. */
export function parsePrRef(q: string): number | null {
   const m = q.trim().match(/^#?(\d+)$/) ?? q.match(/\/pull\/(\d+)/);
   const n = m ? Number(m[1]) : NaN;
   return Number.isSafeInteger(n) && n > 0 ? n : null;
}
