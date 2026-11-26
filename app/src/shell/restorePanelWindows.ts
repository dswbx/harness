import {
   dockPanel,
   fitFrame,
   inTauri,
   listClosedPanelWindows,
   listDisplays,
   listPanelWindows,
   type PanelWindow,
   panelWindowFrame,
   panelWindowsReopen,
   popPanel,
   type SessionSummary,
} from "@harness/api";
import { useEffect, useRef } from "react";

type SessionRef = Pick<SessionSummary, "id" | "archived" | "title">;

/**
 * What to do with the panel windows left from the last run: `open` them again, or `drop` them
 * (dock back). A deleted Session's go; an archived Session's dock back (its layout still has the
 * panel open in its zone); with the setting off all dock back. `closed` (windows the user closed) are
 * never opened: they stay for the Session's main view to hide, and go only when the Session is gone.
 */
export function planRestore(
   entries: readonly PanelWindow[],
   sessions: readonly Pick<SessionSummary, "id" | "archived">[],
   reopen: boolean,
   closed: readonly PanelWindow[] = [],
): { open: PanelWindow[]; drop: PanelWindow[] } {
   const open: PanelWindow[] = [];
   const drop: PanelWindow[] = [];
   const byId = new Map(sessions.map((s) => [s.id, s]));
   for (const e of entries) {
      const s = byId.get(e.session);
      (reopen && s && !s.archived ? open : drop).push(e);
   }
   for (const e of closed) if (!byId.has(e.session)) drop.push(e);
   return { open, drop };
}

/** A title until the pop-out sets its own (the panel labels live in the Frontend): `plan` → `Plan`. */
const panelTitle = (id: string) => id.charAt(0).toUpperCase() + id.slice(1);

let ran = false;

/**
 * Restores the panel windows once per app launch (not again on StrictMode's second effect or HMR).
 * Browser tabs outlive the main page, and a closed tab marks its own key closed, so outside Tauri only
 * the drops run.
 */
export async function restorePanelWindows(sessions: readonly SessionRef[]): Promise<void> {
   if (ran) return;
   ran = true;
   const plan = planRestore(
      listPanelWindows(),
      sessions,
      panelWindowsReopen().get(),
      listClosedPanelWindows(),
   );
   for (const w of plan.drop) dockPanel(w.session, w.panel);
   if (plan.open.length === 0 || !inTauri()) return;
   const displays = await listDisplays().catch(() => ({ all: [], current: null }));
   const main = displays.current ?? displays.all[0];
   const titles = new Map(sessions.map((s) => [s.id, s.title]));
   for (const w of plan.open) {
      const saved = panelWindowFrame(w.session, w.panel).get();
      const frame = saved && main ? fitFrame(saved, displays.all, main) : undefined;
      await popPanel(w.session, w.panel, {
         title: `${panelTitle(w.panel)} · ${titles.get(w.session) ?? ""}`,
         quiet: true,
         ...(frame && { frame }),
      }).catch((e) => console.error("reopen panel window failed", e));
   }
}

/** Delay after the first Session list: the main window is on screen before the pop-outs open behind it. */
const AFTER_REVEAL_MS = 300;

/** Main window only (`Shell`): restores the panel windows once the Session list loaded. */
export function useRestorePanelWindows(sessions: readonly SessionRef[], loaded: boolean) {
   // The latest list when the timer fires; list updates do not restart it.
   const latest = useRef(sessions);
   latest.current = sessions;
   useEffect(() => {
      if (!loaded || ran) return;
      const t = setTimeout(() => void restorePanelWindows(latest.current), AFTER_REVEAL_MS);
      return () => clearTimeout(t);
   }, [loaded]);
}
