import type { GitStatus, SessionApi } from "@harness/api";
import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "./errors";

/** Branch, upstream counts and the changed files: what a reload would show differently. */
export const fingerprint = (s: GitStatus) =>
   `${s.branch}|${s.ahead}|${s.behind}|${s.files.map((f) => `${f.status}${f.path}+${f.additions}-${f.deletions}`).join(",")}`;

/**
 * The Session folder's git status. The Workspace changes behind the Agent's back too (the user's editor, a
 * terminal): every 20s while the window is visible, and when it comes back, a cheap git status checks for a change.
 * `changes` goes up each time the status differs from the last one seen, so views can reload what they show.
 * `enabled`: false for a folder that is not a git repository. A new `refreshKey` loads the status again.
 */
export function useGitStatus(api: SessionApi, enabled = true, refreshKey?: unknown) {
   const [status, setStatus] = useState<GitStatus | null>(null);
   const [error, setError] = useState<string | null>(null);
   const [changes, setChanges] = useState(0);
   /** What the last loaded status looked like, so polling counts only a change. */
   const seen = useRef<string | null>(null);

   const load = useCallback(
      (isOff: () => boolean) =>
         api.gitStatus().then(
            (s) => {
               if (isOff()) return;
               const f = fingerprint(s);
               if (seen.current !== null && f !== seen.current) setChanges((c) => c + 1);
               seen.current = f;
               setStatus(s);
               setError(null);
            },
            (e) => !isOff() && setError(errorMessage(e)),
         ),
      [api],
   );

   // biome-ignore lint/correctness/useExhaustiveDependencies: `refreshKey` only triggers a reload.
   useEffect(() => {
      if (!enabled) return;
      let off = false;
      void load(() => off);
      return () => {
         off = true;
      };
   }, [enabled, load, refreshKey]);

   useEffect(() => {
      if (!enabled) return;
      let off = false;
      const check = () => {
         if (!document.hidden) void load(() => off);
      };
      const timer = setInterval(check, 20_000);
      window.addEventListener("focus", check);
      document.addEventListener("visibilitychange", check);
      return () => {
         off = true;
         clearInterval(timer);
         window.removeEventListener("focus", check);
         document.removeEventListener("visibilitychange", check);
      };
   }, [enabled, load]);

   return { status, error, changes };
}
