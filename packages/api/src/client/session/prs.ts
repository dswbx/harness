import type { Transport } from "../../transport/transport";
import { expectResult } from "../expect";
import type { SessionApi } from "../session";

type Prs = Pick<SessionApi, "prContext" | "lookupPrs" | "searchPrs" | "branchPr">;

export const prsApi = (transport: Transport, sessionId: string): Prs => ({
   prContext: async () => {
      const r = await expectResult(
         transport,
         { type: "PrContext", session_id: sessionId },
         "PrContext",
      );
      return { session_repo: r.session_repo, known_repos: r.known_repos, me: r.me };
   },
   lookupPrs: async (refs) =>
      (
         await expectResult(
            transport,
            { type: "LookupPrs", session_id: sessionId, refs },
            "PrLookup",
         )
      ).prs,
   searchPrs: async (repo, query = null) =>
      (
         await expectResult(
            transport,
            { type: "SearchPrs", session_id: sessionId, repo, query },
            "PrSearch",
         )
      ).prs,
   branchPr: async (refresh = false) => {
      const r = await expectResult(
         transport,
         { type: "BranchPr", session_id: sessionId, refresh },
         "BranchPr",
      );
      return { repo: r.repo, pr: r.pr, base: r.base };
   },
});
