const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Short age for dense lists: "now", "12m", "2h", "45d", "3mo", "1y". Days count up to 90, then months
 * (30 days each), then years (365 days). Never negative. */
export function formatAge(ts: number, now: number = Date.now()): string {
   const diff = Math.max(0, now - ts);
   if (diff < MIN) return "now";
   if (diff < HOUR) return `${Math.floor(diff / MIN)}m`;
   if (diff < DAY) return `${Math.floor(diff / HOUR)}h`;
   if (diff < 90 * DAY) return `${Math.floor(diff / DAY)}d`;
   if (diff < 365 * DAY) return `${Math.floor(diff / (30 * DAY))}mo`;
   return `${Math.floor(diff / (365 * DAY))}y`;
}

/** `formatAge` as a sentence tail: "now", "5m ago". */
export function formatAgeAgo(ts: number, now: number = Date.now()): string {
   const age = formatAge(ts, now);
   return age === "now" ? age : `${age} ago`;
}

/** Full local date and time of a timestamp, for the hover on an age label. */
export function formatDateTime(
   ts: number,
   locale?: Intl.LocalesArgument,
   timeZone?: string,
): string {
   return new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone,
   }).format(ts);
}
