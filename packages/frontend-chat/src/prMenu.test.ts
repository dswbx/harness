import { describe, expect, it } from "vitest";
import { repoName, type KnownRepo, type PrInfo, type PrRefContext, type RepoId } from "@harness/api";
import { exactNumber, prMenuHeader, prMenuRows, prMenuState, repoToken, searchQuery, type PrMenuRow, type PrMenuState } from "./prMenu";

const repo = (full: string): RepoId => {
  const [owner, name] = full.split("/") as [string, string];
  return { owner, name };
};
const known = (full: string, sessions: number, score: number): KnownRepo => ({ repo: repo(full), sessions, score, last_ms: 0 });
const harness = repo("dswbx/harness");
const ctx: PrRefContext = {
  sessionRepo: harness,
  knownRepos: [known("dswbx/harness", 9, 4.2), known("supabase/spark", 4, 2.1), known("supabase/supabase", 3, 1.1), known("supabase/lite", 2, 0.6), known("dswbx/spikes", 3, 1.8)],
};
const noRepo: PrRefContext = { ...ctx, sessionRepo: null };
const pr = (full: string, number: number, title: string, author: string, hoursAgo: number): PrInfo => ({
  repo: repo(full), number, title, author, state: "open", checks: "none", checks_passed: 0, checks_total: 0,
  additions: 0, deletions: 0, changed_files: 0, updated_at: new Date(Date.UTC(2026, 10, 1) - hoursAgo * 3600e3).toISOString(), url: "",
});
const PRS = [
  pr("dswbx/harness", 21, "Terminal: keep scrollback", "other", 1),
  pr("dswbx/harness", 24, "PR chips and autocomplete", "me", 5),
  pr("dswbx/harness", 3, "Fix the slash popup", "other", 0.5),
  pr("dswbx/harness", 23, "Slash commands: popup fixes", "me", 2),
];
const nums = (rows: PrMenuRow[]) => rows.map((r) => (r.kind === "pr" ? r.pr.number : repoName(r.hit.repo.repo)));
const st = (token: string, c = ctx) => prMenuState(token, c);

describe("prMenuState", () => {
  it("# → the Session repo's recent PRs; no Session repo → no menu", () => {
    expect(st("#")).toEqual({ mode: "recent", repo: harness, query: "", matched: null });
    expect(st("#", noRepo)).toBeNull();
    expect(st("#fix", noRepo)).toBeNull();
  });
  it("#fix → title search in the Session repo", () => {
    const s = st("#fix")!;
    expect(s).toEqual({ mode: "title", repo: harness, query: "fix", matched: null });
    expect(searchQuery(s)).toBe("fix");
  });
  it("#2 → number prefix, with an exact lookup of the full number", () => {
    const s = st("#2")!;
    expect(s).toMatchObject({ mode: "number", repo: harness, query: "2" });
    expect(searchQuery(s)).toBeNull();
    expect(exactNumber(s)).toBe(2);
    expect(exactNumber(st("#")!)).toBeNull();
  });
  it("spark# / spark#1 → fuzzy repo match with one clear winner", () => {
    expect(st("spark#")).toEqual({ mode: "recent", repo: repo("supabase/spark"), query: "", matched: { query: "spark", sessions: 4 } });
    expect(st("spar#1")).toEqual({ mode: "number", repo: repo("supabase/spark"), query: "1", matched: { query: "spar", sessions: 4 } });
    expect(st("lit#fix")).toMatchObject({ mode: "title", repo: repo("supabase/lite"), query: "fix" });
  });
  it("sp# → ambiguous: repo rows ranked by tier, then score, with matched positions in owner/name", () => {
    const s = st("sp#")!;
    expect(s.mode).toBe("repos");
    const rows = prMenuRows(s, PRS, null, "me");
    expect(nums(rows)).toEqual(["supabase/spark", "dswbx/spikes", "supabase/supabase"]);
    expect(rows[0]).toMatchObject({ kind: "repo", hit: { positions: [9, 10] } });
    expect(rows[2]).toMatchObject({ kind: "repo", hit: { positions: [9, 11] } });
    expect(searchQuery(s)).toBeUndefined();
  });
  it("owner/repo#17 → exact, any repo, also unknown ones; owner/repo# → recent", () => {
    expect(st("dswbx/harness#17")).toEqual({ mode: "exact", repo: harness, query: "17", matched: null });
    expect(st("DSWBX/Harness#17")).toMatchObject({ repo: harness });
    expect(st("acme/widgets#5", noRepo)).toEqual({ mode: "exact", repo: repo("acme/widgets"), query: "5", matched: null });
    expect(st("supabase/spark#")).toMatchObject({ mode: "recent", repo: repo("supabase/spark") });
    expect(st("supabase/spark#edge")).toMatchObject({ mode: "title", query: "edge" });
  });
  it("no menu: no #, unknown repo name, a second #, URLs", () => {
    for (const t of ["fix", "C#", "xyz#1", "#a#", "https://x.com/a#3", "a/#1"]) expect(st(t)).toBeNull();
  });
});

describe("prMenuRows", () => {
  it("recent: own PRs first, then by last update; other repos dropped", () => {
    const rows = prMenuRows(st("#")!, [...PRS, pr("supabase/spark", 9, "x", "me", 0)], null, "me");
    expect(nums(rows)).toEqual([23, 24, 3, 21]);
  });
  it("title: the query underlined in the title", () => {
    const rows = prMenuRows(st("#fix")!, PRS, null, "me");
    const hits = rows.map((r) => r.kind === "pr" && r.hit);
    expect(nums(rows)).toEqual([23, 24, 3, 21]);
    expect(hits).toEqual([[22, 25], null, [0, 3], null]);
  });
  it("number: prefix filter, the exact PR first and once", () => {
    expect(nums(prMenuRows(st("#2")!, PRS, null, "me"))).toEqual([23, 24, 21]);
    const exact = pr("dswbx/harness", 2, "Old one", "other", 900);
    expect(nums(prMenuRows(st("#2")!, PRS, exact, "me"))).toEqual([2, 23, 24, 21]);
    expect(nums(prMenuRows(st("#24")!, PRS, PRS[1]!, "me"))).toEqual([24]);
  });
  it("exact: the looked-up PR even when the search found nothing", () => {
    const exact = pr("acme/widgets", 5, "Widget", "x", 1);
    expect(nums(prMenuRows(st("acme/widgets#5")!, [], exact, null))).toEqual([5]);
  });
});

describe("prMenuHeader", () => {
  const head = (s: PrMenuState | null) => prMenuHeader(s!, ctx);
  it("repo and why", () => {
    expect(head(st("#"))).toEqual({ title: "dswbx/harness", note: "this repo · recent" });
    expect(head(st("#fix"))).toEqual({ title: "dswbx/harness", note: "title match" });
    expect(head(st("#2"))).toEqual({ title: "dswbx/harness", note: "number starts with 2" });
    expect(head(st("dswbx/harness#17"))).toEqual({ title: "dswbx/harness", note: "exact" });
    expect(head(st("supabase/lite#"))).toEqual({ title: "supabase/lite", note: "recent" });
    expect(head(st("spark#"))).toEqual({ title: "supabase/spark", note: "matched “spark” · 4 sessions" });
    expect(head(st("sp#"))).toEqual({ title: "Repositories", note: "3 matches for “sp”" });
  });
});

it("a repo pick becomes owner/repo#", () => {
  const s = st("sp#")!;
  if (s.mode !== "repos") throw new Error("expected repos");
  expect(repoToken(s.repos[0]!)).toBe("supabase/spark#");
});
