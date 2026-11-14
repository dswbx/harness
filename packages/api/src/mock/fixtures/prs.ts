import type { KnownRepo, PrInfo, RepoId } from "../../generated";

/** PRs for PR references, one per state, in two repos; the mock `gh` user is `dswbx`. */
export const MOCK_ME = "dswbx";
export const repo = (full: string): RepoId => {
   const [owner, name] = full.split("/");
   return { owner, name };
};
export const prInfo = (
   full: string,
   number: number,
   title: string,
   author: string,
   state: PrInfo["state"],
   checks: [PrInfo["checks"], number, number],
   stats: [number, number, number],
   hoursAgo: number,
): PrInfo => ({
   repo: repo(full),
   number,
   title,
   author,
   state,
   checks: checks[0],
   checks_passed: checks[1],
   checks_total: checks[2],
   additions: stats[0],
   deletions: stats[1],
   changed_files: stats[2],
   updated_at: new Date(Date.now() - hoursAgo * 3600e3).toISOString(),
   url: `https://github.com/${full}/pull/${number}`,
});
export const MOCK_PR_INFOS: PrInfo[] = [
   prInfo(
      "dswbx/harness",
      24,
      "PR reference chips and # autocomplete",
      "dswbx",
      "open",
      ["passing", 4, 4],
      [812, 64, 14],
      1,
   ),
   prInfo(
      "dswbx/harness",
      23,
      "Slash commands: popup fixes, highlight used command",
      "dswbx",
      "merged",
      ["passing", 4, 4],
      [121, 10, 5],
      5,
   ),
   prInfo(
      "dswbx/harness",
      21,
      "Terminal: keep scrollback on resize",
      "contributor",
      "open",
      ["failing", 2, 4],
      [45, 12, 2],
      30,
   ),
   prInfo(
      "dswbx/harness",
      20,
      "Draft: side thread summaries",
      "dswbx",
      "draft",
      ["failing", 1, 3],
      [230, 18, 6],
      50,
   ),
   prInfo(
      "dswbx/harness",
      17,
      "Slash popup: keyboard navigation",
      "dswbx",
      "merged",
      ["passing", 4, 4],
      [88, 21, 3],
      170,
   ),
   prInfo(
      "dswbx/harness",
      18,
      "Drop the old sidebar layout",
      "contributor",
      "closed",
      ["none", 0, 0],
      [3, 140, 4],
      200,
   ),
   prInfo(
      "supabase/spark",
      17,
      "Edge runtime: stream request bodies",
      "dswbx",
      "open",
      ["pending", 3, 5],
      [96, 20, 3],
      3,
   ),
   prInfo(
      "supabase/spark",
      12,
      "Fix auth token refresh race",
      "kiwicopple",
      "merged",
      ["passing", 6, 6],
      [18, 4, 1],
      120,
   ),
   prInfo(
      "supabase/spark",
      9,
      "Spike: WASM extensions",
      "dswbx",
      "draft",
      ["none", 0, 0],
      [1400, 0, 22],
      400,
   ),
];
export const MOCK_KNOWN_REPOS: KnownRepo[] = [
   ["dswbx/harness", 9, 4.2, 0.2],
   ["supabase/spark", 4, 2.1, 26],
   ["supabase/supabase", 3, 1.1, 150],
   ["supabase/lite", 2, 0.6, 380],
   ["dswbx/spikes", 3, 1.8, 330],
].map(([full, sessions, score, hoursAgo]) => ({
   repo: repo(full as string),
   sessions: sessions as number,
   score: score as number,
   last_ms: Date.now() - (hoursAgo as number) * 3600e3,
}));
export const sameRepo = (a: RepoId, b: RepoId) =>
   `${a.owner}/${a.name}`.toLowerCase() === `${b.owner}/${b.name}`.toLowerCase();
/** A mock Session's GitHub repo, from its folder name. */
export const folderRepo = (folder: string): RepoId | null =>
   folder.includes("norepo") || folder.includes("nogh")
      ? null
      : folder.includes("spark")
        ? repo("supabase/spark")
        : repo("dswbx/harness");
