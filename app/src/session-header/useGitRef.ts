import {
   type HarnessClient,
   type PrInfo,
   type RepoId,
   type SessionSummary,
   useGitStatus,
} from "@harness/api";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { watchingChecks } from "./checks";
import type { GitRef } from "./GitRefButton";

/**
 * The Session's git ref for the header: branch with ahead/behind, its GitHub repo and PR. Reloaded as the
 * Session's status changes, every minute (20s while checks are watched) while the window is visible, and
 * when it comes back (focus or visible again, at most once a second), which also bypasses the cached PR
 * without dimming. `refresh` bypasses it too, with `refreshing` until it loaded.
 */
export function useGitRef(client: HarnessClient, s: SessionSummary | null): GitRef {
   const none = { repo: null, pr: null, base: null };
   const [gh, setGh] = useState<{ repo: RepoId | null; pr: PrInfo | null; base: string | null }>(
      none,
   );
   const [version, setVersion] = useState(0);
   const [refreshing, setRefreshing] = useState(false);
   const fresh = useRef(false);
   const watching = watchingChecks(gh.pr);
   const id = s?.workspace.repo_root ? s.id : null;
   const sessionStatus = s?.status;
   // The status comes from the store shared with the Changes and Files panels, which polls and reloads on
   // focus; this reloads it after a Turn (`sessionStatus`) and for `refresh`.
   const api = useMemo(() => (id ? client.sessionApi(id) : null), [client, id]);
   const git = useGitStatus(api, { refreshKey: `${sessionStatus}:${version}` });
   const status = !git.error ? git.status : null;
   useEffect(() => {
      if (!id) {
         setGh(none);
         setRefreshing(false);
         return;
      }
      let off = false;
      const load = (bypass = false) => {
         if (document.hidden) return;
         const wasFresh = fresh.current;
         fresh.current = false;
         if (wasFresh) setRefreshing(true);
         const api = client.sessionApi(id);
         Promise.allSettled([
            wasFresh ? git.refresh() : null,
            api.branchPr(wasFresh || watching || bypass).then(
               (r) => !off && setGh(r),
               () => !off && setGh(none),
            ),
         ]).then(() => !off && setRefreshing(false));
      };
      let lastBack = 0;
      const onBack = () => {
         if (document.hidden || Date.now() - lastBack < 1000) return;
         lastBack = Date.now();
         load(true);
      };
      load();
      const timer = setInterval(() => load(), watching ? 20_000 : 60_000);
      window.addEventListener("focus", onBack);
      document.addEventListener("visibilitychange", onBack);
      return () => {
         off = true;
         clearInterval(timer);
         window.removeEventListener("focus", onBack);
         document.removeEventListener("visibilitychange", onBack);
      };
   }, [client, id, sessionStatus, version, watching, git.refresh]);
   const refresh = useCallback(() => {
      fresh.current = true;
      setVersion((v) => v + 1);
   }, []);
   return { status, repo: gh.repo, pr: gh.pr, base: gh.base, refresh, refreshing };
}
