import type { Commit, FileChange } from "../../generated";

export const NOW_S = Math.floor(Date.now() / 1000);
/** Newest first. */
export const MOCK_COMMITS: Commit[] = [
   {
      sha: "c3f1a9e7d2b84c0a5e6f7a1b9c8d3e2f4a5b6c7d",
      short: "c3f1a9e",
      subject: "Document routes, lowercase method match",
      author: "Dennis",
      author_email: "dennis@example.com",
      committer: "Dennis",
      body: "Router matches methods case-insensitively now; the guide lists every route.\n\nCo-authored-by: Claude <noreply@anthropic.com>",
      time: NOW_S - 1800,
   },
   {
      sha: "b2e8d4a61f903c7b5a2d8e4f6c1a0b9d7e3f5a21",
      short: "b2e8d4a",
      subject: "Drop legacy entry point, greet by name",
      author: "Dennis",
      author_email: "dennis@example.com",
      committer: "Dennis",
      body: "",
      time: NOW_S - 7200,
   },
   {
      sha: "a1d7c3f50e8b2a4d6c9f1e3b5a7d0c2e4f6a8b10",
      short: "a1d7c3f",
      subject: "Add README, bump to 0.2.0 with dev script",
      author: "Sam",
      author_email: "sam@example.com",
      committer: "Dennis",
      body: "Adds a `dev` script that reloads on save.",
      time: NOW_S - 86400,
   },
];
export const MOCK_COMMIT_FILES: Record<string, string[]> = {
   [MOCK_COMMITS[0].sha]: ["docs/guide.md", "src/server/router.ts"],
   [MOCK_COMMITS[1].sha]: ["src/legacy.ts", "src/hello.ts"],
   [MOCK_COMMITS[2].sha]: ["README.md", "package.json"],
};
export const MOCK_UNCOMMITTED = ["src/hello.ts", "src/server/router.ts"];

export const MOCK_FILES: FileChange[] = [
   { path: "README.md", status: "A", additions: 2, deletions: 0 },
   { path: "docs/guide.md", status: "M", additions: 3, deletions: 2 },
   { path: "package.json", status: "M", additions: 3, deletions: 2 },
   { path: "src/hello.ts", status: "M", additions: 3, deletions: 1 },
   { path: "src/legacy.ts", status: "D", additions: 0, deletions: 5 },
   { path: "src/server/router.ts", status: "M", additions: 6, deletions: 4 },
];
