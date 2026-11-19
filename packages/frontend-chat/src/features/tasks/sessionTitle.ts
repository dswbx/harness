import type { SessionInfo } from "./ListView";

/** Live Session titles by id (the host's Session list); a Session not in it was deleted. */
export type Sessions = ReadonlyMap<string, SessionInfo>;

/**
 * A Session's title: live from `sessions` when given (not in it: deleted, then `gone`), else `cached`, the title the
 * task stored when it was linked (a window without a Session list, e.g. the Quick Overlay).
 */
export function sessionTitle(
   id: string,
   cached: string | null,
   sessions: Sessions | undefined,
): { title: string; gone: boolean } {
   if (!sessions) return { title: cached ?? id, gone: false };
   const live = sessions.get(id);
   if (live) return { title: live.title, gone: false };
   return { title: `${cached ?? "Session"} (deleted)`, gone: true };
}
