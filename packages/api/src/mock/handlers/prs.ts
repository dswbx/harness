import { CommandError } from "../../errors";
import { MOCK_PRS } from "../fixtures/branches";
import { folderRepo, MOCK_KNOWN_REPOS, MOCK_ME, MOCK_PR_INFOS, sameRepo } from "../fixtures/prs";
import type { Handlers } from "./types";

export const prsHandlers = {
   ListPullRequests: (_mock, cmd) => {
      if (cmd.folder.includes("norepo") || cmd.folder.includes("nogh"))
         throw new CommandError("internal", "gh: no GitHub remote");
      const prs =
         cmd.filter === "mine"
            ? MOCK_PRS.filter((p) => p.author === "you")
            : cmd.filter === "review_requested"
              ? MOCK_PRS.slice(1, 2)
              : MOCK_PRS;
      return { type: "PullRequests", prs };
   },
   PrContext: (mock, cmd) => {
      const s = mock.session(cmd.session_id);
      return {
         type: "PrContext",
         session_repo: s.workspace.repo_root ? folderRepo(s.folder) : null,
         known_repos: MOCK_KNOWN_REPOS,
         me: MOCK_ME,
      };
   },
   LookupPrs: (mock, cmd) => {
      mock.session(cmd.session_id);
      return {
         type: "PrLookup",
         prs: cmd.refs.map(
            (r) =>
               MOCK_PR_INFOS.find((p) => p.number === r.number && sameRepo(p.repo, r.repo)) ?? null,
         ),
      };
   },
   SearchPrs: (mock, cmd) => {
      mock.session(cmd.session_id);
      const q = cmd.query?.trim().toLowerCase() ?? "";
      const prs = MOCK_PR_INFOS.filter(
         (p) => sameRepo(p.repo, cmd.repo) && p.title.toLowerCase().includes(q),
      );
      return {
         type: "PrSearch",
         prs: [
            ...prs.filter((p) => p.author === MOCK_ME),
            ...prs.filter((p) => p.author !== MOCK_ME),
         ],
      };
   },
   BranchPr: (mock, cmd) => {
      const s = mock.session(cmd.session_id);
      const base = s.workspace.base_branch ?? "main";
      if (!s.workspace.repo_root || s.folder.includes("nogh"))
         return { type: "BranchPr", repo: null, pr: null, base };
      const repo = folderRepo(s.folder);
      if (!repo) return { type: "BranchPr", repo: null, pr: null, base };
      const pr =
         MOCK_PR_INFOS.find((p) => sameRepo(p.repo, repo) && p.number === s.workspace.pr) ??
         (s.workspace.worktree_branch ? (MOCK_PR_INFOS[0] ?? null) : null);
      return { type: "BranchPr", repo, pr, base };
   },
} satisfies Partial<Handlers>;
