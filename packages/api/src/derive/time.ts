const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Short age for dense lists: "now", "12m", "2h", "3d", "2w", "4mo", "1y". Never negative. */
export function formatAge(ts: number, now: number = Date.now()): string {
   const diff = Math.max(0, now - ts);
   if (diff < MIN) return "now";
   if (diff < HOUR) return `${Math.floor(diff / MIN)}m`;
   if (diff < DAY) return `${Math.floor(diff / HOUR)}h`;
   if (diff < 7 * DAY) return `${Math.floor(diff / DAY)}d`;
   if (diff < 30 * DAY) return `${Math.floor(diff / (7 * DAY))}w`;
   if (diff < 365 * DAY) return `${Math.floor(diff / (30 * DAY))}mo`;
   return `${Math.floor(diff / (365 * DAY))}y`;
}

/** `formatAge` as a sentence tail: "now", "5m ago". */
export function formatAgeAgo(ts: number, now: number = Date.now()): string {
   const age = formatAge(ts, now);
   return age === "now" ? age : `${age} ago`;
}
