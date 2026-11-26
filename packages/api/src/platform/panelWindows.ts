import { invoke } from "@tauri-apps/api/core";
import { useSyncExternalStore } from "react";
import { inTauri } from "../transport/transport";
import { codec, onOffText, onStoredChange, type Stored, storedKeys, storedValue } from "./storage";
import { matchKey } from "./storageKeys";
import { type Frame, focusWindow, openWindow, parseFrame } from "./window";

/**
 * Panel windows: a Session's panel popped out into its own OS window. One key per pop-out
 * (`harness.panelWindow.{session}#{panel}`), so two webviews never race on one shared list. The
 * key present means popped; the pop-out keeps its frame under `harness.panelWindowFrame.…`.
 */
export type PanelWindow = { session: string; panel: string };
type Entry = { v: 1; at: number };

const ENTRY = "harness.panelWindow.";
const FRAME = "harness.panelWindowFrame.";
const ENTRY_PATTERN = `${ENTRY}{session}#{name}`;

/** A stored entry; anything else (bad JSON, another version) is null. */
export function parsePanelWindow(raw: string | null): Entry | null {
   if (raw === null) return null;
   try {
      const e = JSON.parse(raw);
      return e && typeof e === "object" && e.v === 1 && Number.isFinite(e.at)
         ? { v: 1, at: e.at }
         : null;
   } catch {
      return null;
   }
}

const entryStore = (session: string, panel: string): Stored<Entry | null> =>
   storedValue<Entry | null>({
      key: `${ENTRY}${session}#${panel}`,
      scope: { session },
      parse: parsePanelWindow,
   });

/** Where the pop-out of `panel` keeps its place and size (written only by the pop-out). */
export const panelWindowFrame = (session: string, panel: string): Stored<Frame | null> =>
   storedValue<Frame | null>({
      key: `${FRAME}${session}#${panel}`,
      scope: { session },
      parse: parseFrame,
      sync: false,
   });

/** App setting: reopen panel windows on launch (default on). */
export const panelWindowsReopen = (): Stored<boolean> =>
   storedValue<boolean>({
      key: "harness.panelWindows.reopen",
      scope: "app",
      parse: codec.onOff(true),
      serialize: onOffText,
   });

const ALLOWED = /[a-zA-Z0-9-]/;
/** Every char outside `a-zA-Z0-9-` as `_xx` (2 hex) or `_uxxxxxx` (6 hex): no two inputs give the same output. */
function escapeLabel(s: string): string {
   let out = "";
   for (const ch of s) {
      if (ALLOWED.test(ch)) {
         out += ch;
         continue;
      }
      const c = ch.codePointAt(0) ?? 0;
      out +=
         c < 0x100 ? `_${c.toString(16).padStart(2, "0")}` : `_u${c.toString(16).padStart(6, "0")}`;
   }
   return out;
}

/** The window label of a pop-out: stable, so an open window is found and focused. `:` never occurs in an escaped part. */
export const panelWindowLabel = (session: string, panel: string): string =>
   `panel-${escapeLabel(session)}:${escapeLabel(panel)}`;

/** The app URL a pop-out loads. */
export const panelWindowUrl = (session: string, panel: string): string =>
   `/?session=${encodeURIComponent(session)}&solo=1&pane=panel&panel=${encodeURIComponent(panel)}`;

/** The pop-out key a storage key belongs to; null for any other key. */
function entryOf(key: string): PanelWindow | null {
   const m = matchKey(key);
   if (m?.def.pattern !== ENTRY_PATTERN || m.session === null) return null;
   return { session: m.session, panel: key.slice(ENTRY.length + m.session.length + 1) };
}

/** The popped panels, oldest first, and whether a key held bad data. */
function scan(clean: boolean): { list: PanelWindow[]; bad: boolean } {
   const out: (PanelWindow & { at: number })[] = [];
   let bad = false;
   for (const key of storedKeys()) {
      const w = entryOf(key);
      if (!w) continue;
      const store = entryStore(w.session, w.panel);
      const e = store.get();
      if (e) out.push({ ...w, at: e.at });
      else if (store.has()) {
         bad = true;
         if (clean) store.remove();
      }
   }
   const list = out.sort((a, b) => a.at - b.at).map(({ session, panel }) => ({ session, panel }));
   return { list, bad };
}

/** Every popped panel, oldest first. A key with bad data counts as absent and is removed. */
export const listPanelWindows = (): PanelWindow[] => scan(true).list;

let cache: { sig: string; list: PanelWindow[] } | undefined;
const snapshot = (): PanelWindow[] => {
   const { list, bad } = scan(false);
   // Not while React reads a snapshot: removing a key notifies the listeners.
   if (bad) queueMicrotask(listPanelWindows);
   const sig = JSON.stringify(list);
   if (cache?.sig !== sig) cache = { sig, list };
   return cache.list;
};
const subscribe = (l: () => void) =>
   onStoredChange((key) => {
      if (key === null || entryOf(key)) l();
   });

/** The popped panels (of one Session when given) as React state; follows other windows. */
export function usePanelWindows(session?: string): PanelWindow[] {
   const all = useSyncExternalStore(subscribe, snapshot, snapshot);
   return session === undefined ? all : all.filter((w) => w.session === session);
}

/** Pops `panel` of `session` out: marks it popped, then opens its window (or focuses it when open). */
export async function popPanel(
   session: string,
   panel: string,
   opts: { title: string; quiet?: boolean; frame?: Frame },
): Promise<void> {
   const entry = entryStore(session, panel);
   if (!entry.get()) entry.set({ v: 1, at: Date.now() });
   await openWindow(panelWindowLabel(session, panel), panelWindowUrl(session, panel), {
      title: opts.title,
      width: 560,
      height: 720,
      remember: panelWindowFrame(session, panel),
      ...(opts.frame && { frame: opts.frame }),
      stable: true,
      ...(opts.quiet && { quiet: true }),
      overlayTitleBar: true,
   });
}

/** Docks `panel` back: removes its key (the pop-out closes itself when it sees that). */
export function dockPanel(session: string, panel: string): void {
   entryStore(session, panel).remove();
}

/** Brings the pop-out of `panel` to the front; false when it is not open. */
export const focusPanelWindow = (session: string, panel: string): Promise<boolean> =>
   focusWindow(panelWindowLabel(session, panel));

/** Shows `session` in the main window and brings that window to the front (Tauri only). */
export async function showSession(session: string): Promise<void> {
   if (inTauri()) await invoke("show_session", { sessionId: session });
}

/** Part of a window that must be on a display for it to count as on screen: its title bar. */
const MIN_VISIBLE = { width: 100, height: 30 };

/**
 * A saved frame, moved onto `fallback` (the main display) when no display shows enough of its
 * title bar (a display was removed or moved). Moved frames are centered and fit in `fallback`.
 */
export function fitFrame(frame: Frame, monitors: readonly Frame[], fallback: Frame): Frame {
   const bar = { x: frame.x, y: frame.y, width: frame.width, height: MIN_VISIBLE.height };
   const visible = monitors.some((m) => {
      const w = Math.min(bar.x + bar.width, m.x + m.width) - Math.max(bar.x, m.x);
      const h = Math.min(bar.y + bar.height, m.y + m.height) - Math.max(bar.y, m.y);
      return w >= Math.min(MIN_VISIBLE.width, frame.width) && h >= MIN_VISIBLE.height;
   });
   if (visible) return frame;
   const width = Math.min(frame.width, fallback.width);
   const height = Math.min(frame.height, fallback.height);
   return {
      x: fallback.x + Math.round((fallback.width - width) / 2),
      y: fallback.y + Math.round((fallback.height - height) / 2),
      width,
      height,
   };
}
