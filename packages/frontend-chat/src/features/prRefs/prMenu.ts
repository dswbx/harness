// The prompt's `#` menu: what a `#` token at the caret asks for, and the rows to show. Pure.
// The only place where repo names match fuzzily: the user sees the matches and picks one, or ignores them.
import {
   fuzzyRank,
   type KnownRepo,
   type PrInfo,
   type PrRefContext,
   type RepoId,
   repoCandidates,
   repoName,
   resolveRepo,
   sameRepo,
} from "@harness/api";

/** A fuzzy repo match that was taken as the one meant (`spark` → supabase/spark). */
export type RepoMatch = { query: string; sessions: number };

export type PrMenuState =
   /** `#`: recent PRs. `#fix`: title search. `#2`: number prefix (+ exact). `owner/repo#17`: exact. */
   | {
        mode: "recent" | "title" | "number" | "exact";
        repo: RepoId;
        query: string;
        matched: RepoMatch | null;
     }
   /** `sp#`: several repos match; pick one first. */
   | { mode: "repos"; query: string; repos: RepoHit[] };

/** `positions`: matched characters in `owner/name`. */
export type RepoHit = { repo: KnownRepo; positions: number[] };

export type PrMenuRow =
   | { kind: "pr"; pr: PrInfo; hit: [number, number] | null }
   | { kind: "repo"; hit: RepoHit };

const TOKEN = /^(?:([\w-]+)\/([\w.-]+)|([\w.-]+))?#([^#\s]*)$/;

/**
 * What the `#` token at the caret (`#`, `#fix`, `#2`, `spark#1`, `sp#`, `owner/repo#17`) asks for; null for no menu
 * (no `#`, a bare `#` without a Session repo, a repo name that matches no known repo).
 */
export function prMenuState(token: string, ctx: PrRefContext): PrMenuState | null {
   const m = TOKEN.exec(token);
   if (!m) return null;
   const [, owner, name, short, query = ""] = m;
   const pick = (repo: RepoId, matched: RepoMatch | null, full = false): PrMenuState => ({
      mode: !query ? "recent" : /^\d+$/.test(query) ? (full ? "exact" : "number") : "title",
      repo,
      query,
      matched,
   });
   if (owner && name) {
      const known = repoCandidates(ctx).find((k) => sameRepo(k.repo, { owner, name }));
      return pick(known?.repo ?? { owner, name }, null, true);
   }
   if (!short) return ctx.sessionRepo ? pick(ctx.sessionRepo, null) : null;
   const r = resolveRepo(short, ctx, { fuzzy: true });
   if (r.kind === "none") return null;
   const hits = fuzzyRank(
      short,
      repoCandidates(ctx),
      (k) => k.repo.name,
      (k) => k.score,
   );
   if (r.kind === "one") {
      const k = hits.find((h) => sameRepo(h.item.repo, r.repo))!.item;
      return pick(r.repo, { query: short, sessions: k.sessions });
   }
   return {
      mode: "repos",
      query: short,
      repos: hits.map((h) => ({
         repo: h.item,
         positions: h.positions.map((p) => p + h.item.repo.owner.length + 1),
      })),
   };
}

/** The `searchPrs` query a state needs (the title text for `title`), or undefined for none. */
export function searchQuery(s: PrMenuState): string | null | undefined {
   if (s.mode === "repos") return undefined;
   return s.mode === "title" ? s.query : null;
}

/** The full number to look up exactly (`#24`, `owner/repo#17`), else null. */
export function exactNumber(s: PrMenuState): number | null {
   if (s.mode !== "number" && s.mode !== "exact") return null;
   const n = Number(s.query);
   return Number.isSafeInteger(n) && n > 0 ? n : null;
}

const byRecent = (me: string | null) => (a: PrInfo, b: PrInfo) =>
   Number(b.author === me) - Number(a.author === me) ||
   Date.parse(b.updated_at) - Date.parse(a.updated_at);

/**
 * The rows: repos for `repos`; else PRs (own first, then by last update). `title` underlines the query in the title;
 * `number`/`exact` keep numbers starting with the digits, the exactly looked up PR first.
 */
export function prMenuRows(
   s: PrMenuState,
   prs: PrInfo[],
   exact: PrInfo | null,
   me: string | null,
): PrMenuRow[] {
   if (s.mode === "repos") return s.repos.map((hit) => ({ kind: "repo", hit }));
   let list = prs.filter((p) => sameRepo(p.repo, s.repo)).sort(byRecent(me));
   if (s.mode === "number" || s.mode === "exact") {
      list = list.filter((p) => String(p.number).startsWith(s.query));
      if (exact) list = [exact, ...list.filter((p) => p.number !== exact.number)];
   }
   const q = s.mode === "title" ? s.query.toLowerCase() : "";
   return list.map((pr) => {
      const at = q ? pr.title.toLowerCase().indexOf(q) : -1;
      return { kind: "pr", pr, hit: at >= 0 ? [at, at + q.length] : null };
   });
}

/** Header line: the repo (or "Repositories") and a note on why these rows. */
export function prMenuHeader(s: PrMenuState, ctx: PrRefContext): { title: string; note: string } {
   if (s.mode === "repos")
      return { title: "Repositories", note: `${s.repos.length} matches for “${s.query}”` };
   const own = !!ctx.sessionRepo && sameRepo(ctx.sessionRepo, s.repo);
   const mode = {
      recent: own ? "this repo · recent" : "recent",
      title: "title match",
      number: `number starts with ${s.query}`,
      exact: "exact",
   }[s.mode];
   const note = s.matched
      ? `matched “${s.matched.query}” · ${s.matched.sessions} ${s.matched.sessions === 1 ? "session" : "sessions"}`
      : mode;
   return { title: repoName(s.repo), note };
}

/** What picking a repo row puts in place of the token: its PR list comes next. */
export const repoToken = (hit: RepoHit) => `${repoName(hit.repo.repo)}#`;
