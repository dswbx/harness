import { useSyncExternalStore } from "react";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Relative message time: "just now", "5 minutes ago", "yesterday", "3 days ago"; after a week a date ("12 Oct", year added when not this year). */
export function formatRelativeTime(ts: number, now: number = Date.now(), locale?: string): string {
  const diff = now - ts;
  if (diff < 45_000) return "just now";
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (diff < HOUR) return rtf.format(-Math.max(1, Math.round(diff / MIN)), "minute");
  if (diff < DAY) return rtf.format(-Math.round(diff / HOUR), "hour");
  const startOfDay = (x: number) => { const d = new Date(x); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
  const days = Math.round((startOfDay(now) - startOfDay(ts)) / DAY);
  if (days < 7) return rtf.format(-days, "day");
  const d = new Date(ts);
  return d.toLocaleDateString(locale, {
    day: "numeric",
    month: "short",
    ...(d.getFullYear() !== new Date(now).getFullYear() && { year: "numeric" }),
  });
}

/** Elapsed time: "8s", "4m 05s", "1h 02m". */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const pad = (n: number) => String(n).padStart(2, "0");
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${pad(s % 60)}s`;
  return `${Math.floor(s / 3600)}h ${pad(Math.floor(s / 60) % 60)}m`;
}

/** Full date and time for the tooltip. */
export const fullMessageTime = (ts: number, locale?: string) =>
  new Date(ts).toLocaleString(locale, { dateStyle: "full", timeStyle: "medium" });

/** One shared 30s clock for all relative times, so many messages cost one timer. */
const listeners = new Set<() => void>();
let now = Date.now();
let timer: ReturnType<typeof setInterval> | null = null;

function subscribe(cb: () => void) {
  listeners.add(cb);
  if (!timer) {
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      for (const l of listeners) l();
    }, 30_000);
  }
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

export const useNow = () => useSyncExternalStore(subscribe, () => now);
