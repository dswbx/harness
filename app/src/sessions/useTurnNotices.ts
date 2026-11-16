import type { AppEvent, HarnessClient, SessionSummary } from "@harness/api";
import { useEffect, useRef } from "react";
import { useAnnounce } from "../platform/toast";

/** How a Turn ended, in words (`stop_reason` as in `TurnEnded`). */
export const stopText = (reason: string | undefined) =>
   reason === "error"
      ? "Failed"
      : reason === "auth_required"
        ? "Needs you to sign in"
        : reason === "end_turn" || reason === undefined
          ? "Finished"
          : "Turn ended";

/**
 * Whether a `SessionStatus` is a Turn that just ended out of the user's view: the Session became
 * unseen, it is not the one shown, and its Agent is not the one told (a Sub Session reporting to
 * its parent's Agent).
 */
export function isTurnNotice(
   e: Extract<AppEvent, { type: "SessionStatus" }>,
   wasUnseen: boolean,
   session: SessionSummary | undefined,
   shownId: string | null,
): boolean {
   return e.unseen && !wasUnseen && e.session_id !== shownId && !session?.parent?.notify;
}

/**
 * While this window is in front, announces a Session whose Turn ended out of view (Open shows it);
 * withdrawn once it is seen. In the background the OS notification (host) tells instead.
 */
export function useTurnNotices(
   client: HarnessClient,
   sessions: SessionSummary[],
   shownId: string | null,
   open: (id: string) => void,
   /** Off in a window that does not show Sessions (a pop-out diff). */
   enabled = true,
) {
   const { announce, withdraw } = useAnnounce();
   const live = useRef({ sessions, shownId, open });
   live.current = { sessions, shownId, open };
   useEffect(() => {
      if (!enabled) return;
      let stop = false;
      let unsub: (() => void) | undefined;
      const reasons = new Map<string, string>();
      client
         .subscribeApp((e) => {
            if (e.type === "TurnFinished") reasons.set(e.session_id, e.stop_reason);
            if (e.type !== "SessionStatus") return;
            const { sessions, shownId } = live.current;
            const s = sessions.find((x) => x.id === e.session_id);
            if (!e.unseen) return withdraw(`turn:${e.session_id}`);
            if (!isTurnNotice(e, s?.unseen ?? false, s, shownId)) return;
            if (document.visibilityState !== "visible" || !document.hasFocus()) return;
            announce({
               key: `turn:${e.session_id}`,
               title: e.title,
               text: stopText(reasons.get(e.session_id)),
               action: { label: "Open", run: () => live.current.open(e.session_id) },
            });
         })
         .then((u) => (stop ? u() : (unsub = u)))
         .catch(() => {}); // useSessions reports a failed subscription
      return () => {
         stop = true;
         unsub?.();
      };
   }, [client, announce, withdraw, enabled]);
}
