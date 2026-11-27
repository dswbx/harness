import { invoke } from "@tauri-apps/api/core";
import { useMemo, useSyncExternalStore } from "react";
import { inTauri } from "../transport/transport";
import { codec, onOffText, onStoredChange, type Stored, storedKeys, storedValue } from "./storage";
import { matchKey } from "./storageKeys";
import { type Frame, focusWindow, openWindow, parseFrame } from "./window";

/**
 * Panel windows: a Session's panel popped out into its own OS window. One key per pop-out
 * (`harness.panelWindow.{session}#{panel}`), so two webviews never race on one shared list. The
 * key present means popped (live), unless it is marked as ended: `closed` (the user closed the window,
 * red X) or `docked` (Dock back). The main view of the Session applies an ended entry to its layout
 * (hides or shows the panel) and then removes the key. The pop-out keeps its frame under
 * `harness.panelWindowFrame.…`.
 */
export type PanelWindow = { session: string; panel: string };
/** How a pop-out ended: closed (the panel is hidden in its zone) or docked (it shows in its zone). */
export type PanelWindowEnd = "closed" | "docked";
export type EndedPanelWindow = PanelWindow & { end: PanelWindowEnd };
type Entry = { v: 1; at: number; closed?: true; docked?: true };
const endOf = (e: Entry): PanelWindowEnd | null =>
   e.closed ? "closed" : e.docked ? "docked" : null;

const ENTRY = "harness.panelWindow.";
const FRAME = "harness.panelWindowFrame.";
const ENTRY_PATTERN = `${ENTRY}{session}#{name}`;

/** A stored entry; anything else (bad JSON, another version) is null. Older values have no `closed` or `docked`. */
export function parsePanelWindow(raw: string | null): Entry | null {
   if (raw === null) return null;
   try {
      const e = JSON.parse(raw);
      if (!(e && typeof e === "object" && e.v === 1 && Number.isFinite(e.at))) return null;
      if (e.closed === true) return { v: 1, at: e.at, closed: true };
      if (e.docked === true) return { v: 1, at: e.at, docked: true };
      return { v: 1, at: e.at };
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

type Scan = { list: PanelWindow[]; ended: EndedPanelWindow[] };
const byAge = <T extends { at: number }>(l: T[]) => l.sort((a, b) => a.at - b.at);

/** The popped and the ended panels, oldest first, and whether a key held bad data. */
function scan(clean: boolean): Scan & { bad: boolean } {
   const out: (PanelWindow & { at: number })[] = [];
   const done: (EndedPanelWindow & { at: number })[] = [];
   let bad = false;
   for (const key of storedKeys()) {
      const w = entryOf(key);
      if (!w) continue;
      const store = entryStore(w.session, w.panel);
      const e = store.get();
      const end = e && endOf(e);
      if (end) done.push({ ...w, end, at: e.at });
      else if (e) out.push({ ...w, at: e.at });
      else if (store.has()) {
         bad = true;
         if (clean) store.remove();
      }
   }
   return {
      list: byAge(out).map(({ session, panel }) => ({ session, panel })),
      ended: byAge(done).map(({ session, panel, end }) => ({ session, panel, end })),
      bad,
   };
}

/** Every popped panel (ended ones not), oldest first. A key with bad data counts as absent and is removed. */
export const listPanelWindows = (): PanelWindow[] => scan(true).list;

/** Every panel whose pop-out ended (closed or docked) and whose key is not removed yet, oldest first. */
export const listEndedPanelWindows = (): EndedPanelWindow[] => scan(true).ended;

/** Whether `panel` of `session` is popped now (its key is live). */
export function isPanelPopped(session: string, panel: string): boolean {
   const e = entryStore(session, panel).get();
   return !!e && !endOf(e);
}

let cache: { sig: string; value: Scan } | undefined;
const snapshot = (): Scan => {
   const { bad, ...value } = scan(false);
   // Not while React reads a snapshot: removing a key notifies the listeners.
   if (bad) queueMicrotask(listPanelWindows);
   const sig = JSON.stringify([value.list, value.ended]);
   if (cache?.sig !== sig) cache = { sig, value };
   return cache.value;
};
const subscribe = (l: () => void) =>
   onStoredChange((key) => {
      if (key === null || entryOf(key)) l();
   });

/** The popped panels (of one Session when given) as React state; follows other windows. Ended ones are not popped. */
export function usePanelWindows(session?: string): PanelWindow[] {
   const all = useSyncExternalStore(subscribe, snapshot, snapshot).list;
   return session === undefined ? all : all.filter((w) => w.session === session);
}

/** The panels of `session` whose pop-out ended (closed or docked), as React state, for the main view to apply. */
export function useEndedPanelWindows(session: string): EndedPanelWindow[] {
   const { ended } = useSyncExternalStore(subscribe, snapshot, snapshot);
   return ended.filter((w) => w.session === session);
}

/**
 * Pops `panel` of `session` out: marks it popped (an absent or ended key gets a fresh live entry),
 * then opens its window (or focuses it when open). The stored layout does not change. When the window
 * cannot be created, the key goes again (the panel is not popped). Returns whether a window is there.
 */
export async function popPanel(
   session: string,
   panel: string,
   opts: { title: string; quiet?: boolean; frame?: Frame },
): Promise<boolean> {
   const entry = entryStore(session, panel);
   const e = entry.get();
   if (!e || endOf(e)) entry.set({ v: 1, at: Date.now() });
   const ok = await openWindow(panelWindowLabel(session, panel), panelWindowUrl(session, panel), {
      title: opts.title,
      width: 560,
      height: 720,
      remember: panelWindowFrame(session, panel),
      ...(opts.frame && { frame: opts.frame }),
      stable: true,
      ...(opts.quiet && { quiet: true }),
      overlayTitleBar: true,
   });
   if (!ok && isPanelPopped(session, panel)) entry.remove();
   return ok;
}

/**
 * Shows the pop-out of `panel`: brings its window to the front, or, when there is none (the key is live
 * but the window is gone), opens it again at its saved frame. Returns whether a window is there.
 */
export async function showPanelWindow(
   session: string,
   panel: string,
   opts: { title?: string } = {},
): Promise<boolean> {
   if (await focusPanelWindow(session, panel)) return true;
   return popPanel(session, panel, { title: opts.title ?? panel });
}

/**
 * Docks `panel` back: marks its key `docked` (the pop-out closes itself when it sees that). The main
 * view of the Session shows the panel in its zone and then removes the key. Does nothing without a key.
 */
export function dockPanel(session: string, panel: string): void {
   const entry = entryStore(session, panel);
   const e = entry.get();
   if (e) entry.set({ v: 1, at: e.at, docked: true });
}

/** Removes the key of `panel` (no window, nothing for the main view to apply): an unknown panel, a deleted Session. */
export function forgetPanelWindow(session: string, panel: string): void {
   entryStore(session, panel).remove();
}

/**
 * The user closed the pop-out of `panel` (red X, Cmd+W, a closed tab): marks its key `closed`. The
 * panel is no longer popped; the main view of the Session hides it in its zone and then removes the
 * key. Does nothing when the panel is not popped (docked already, or closed).
 */
export function closePanel(session: string, panel: string): void {
   const entry = entryStore(session, panel);
   const e = entry.get();
   if (e && !endOf(e)) entry.set({ v: 1, at: e.at, closed: true });
}

/** Brings the pop-out of `panel` to the front; false when it is not open. */
export const focusPanelWindow = (session: string, panel: string): Promise<boolean> =>
   focusWindow(panelWindowLabel(session, panel));

/** Whether the pop-out window of `panel` exists now (Tauri only; else false). */
export async function panelWindowOpen(session: string, panel: string): Promise<boolean> {
   if (!inTauri()) return false;
   const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
   return (await WebviewWindow.getByLabel(panelWindowLabel(session, panel))) !== null;
}

/** Shows `session` in the main window and brings that window to the front (Tauri only). */
export async function showSession(session: string): Promise<void> {
   if (inTauri()) await invoke("show_session", { sessionId: session });
}

/**
 * Panel inbox: an open (`ctx.open`) that a View cannot show goes to the View that owns the panel for
 * this Session (its pop-out when popped, else the main view). One key per (Session, panel):
 * `harness.panelOpen.{session}#{panel}` → `{v:1, at, target?}`; `target` is a JSON value. The owner
 * applies it once and removes the key. An entry older than `PANEL_OPEN_TTL` is stale: removed, never
 * applied (a request that no View took does not fire on the next launch).
 */
export type PanelOpen = PanelWindow & { at: number; target?: unknown };
type OpenEntry = { v: 1; at: number; target?: unknown };

const OPEN = "harness.panelOpen.";
const OPEN_PATTERN = `${OPEN}{session}#{name}`;
/** How long an open waits for its owner (ms). */
export const PANEL_OPEN_TTL = 30_000;

/** A stored open; anything else (bad JSON, another version) is null. */
export function parsePanelOpen(raw: string | null): OpenEntry | null {
   if (raw === null) return null;
   try {
      const e = JSON.parse(raw);
      if (!(e && typeof e === "object" && e.v === 1 && Number.isFinite(e.at))) return null;
      return "target" in e ? { v: 1, at: e.at, target: e.target } : { v: 1, at: e.at };
   } catch {
      return null;
   }
}

const openStore = (session: string, panel: string): Stored<OpenEntry | null> =>
   storedValue<OpenEntry | null>({
      key: `${OPEN}${session}#${panel}`,
      scope: { session },
      parse: parsePanelOpen,
   });

/** The open key a storage key belongs to; null for any other key. */
function openOf(key: string): PanelWindow | null {
   const m = matchKey(key);
   if (m?.def.pattern !== OPEN_PATTERN || m.session === null) return null;
   return { session: m.session, panel: key.slice(OPEN.length + m.session.length + 1) };
}

const isStale = (at: number, now: number) => now - at > PANEL_OPEN_TTL;

/** The live opens, oldest first, and whether a key held bad or stale data (removed when `clean`). */
function scanOpens(clean: boolean): { list: PanelOpen[]; bad: boolean } {
   const now = Date.now();
   const out: PanelOpen[] = [];
   let bad = false;
   for (const key of storedKeys()) {
      const w = openOf(key);
      if (!w) continue;
      const store = openStore(w.session, w.panel);
      const e = store.get();
      if (e && !isStale(e.at, now))
         out.push({ ...w, at: e.at, ...("target" in e && { target: e.target }) });
      else if (store.has()) {
         bad = true;
         if (clean) store.remove();
      }
   }
   return { list: byAge(out), bad };
}

/** Every live open, oldest first. Keys with bad or stale data are removed. */
export const listPanelOpens = (): PanelOpen[] => scanOpens(true).list;

let openCache: { sig: string; value: PanelOpen[] } | undefined;
const openSnapshot = (): PanelOpen[] => {
   const { list, bad } = scanOpens(false);
   // Not while React reads a snapshot: removing a key notifies the listeners.
   if (bad) queueMicrotask(listPanelOpens);
   const sig = JSON.stringify(list);
   if (openCache?.sig !== sig) openCache = { sig, value: list };
   return openCache.value;
};
const subscribeOpens = (l: () => void) =>
   onStoredChange((key) => {
      if (key === null || openOf(key)) l();
   });

/** The live opens of `session` as React state, oldest first; follows other windows. */
export function usePanelOpens(session: string): PanelOpen[] {
   const all = useSyncExternalStore(subscribeOpens, openSnapshot, openSnapshot);
   return useMemo(() => all.filter((o) => o.session === session), [all, session]);
}

/** Removes the open of `panel` (its owner applied it). */
export function takePanelOpen(session: string, panel: string): void {
   openStore(session, panel).remove();
}

/**
 * Sends an open of `panel` (at `target`, a JSON value) to the View that owns it: writes the key,
 * then brings that View forward: the pop-out when `panel` is popped, else the main window at `session`.
 */
export async function sendPanelOpen(
   session: string,
   panel: string,
   target?: unknown,
): Promise<void> {
   openStore(session, panel).set({
      v: 1,
      at: Date.now(),
      ...(target !== undefined && { target }),
   });
   if (isPanelPopped(session, panel)) await showPanelWindow(session, panel);
   else await showSession(session);
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
