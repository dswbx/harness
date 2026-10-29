/** Message time: "14:32" today, "Mon 14:32" within a week, else "12 Oct 14:32" (year added when not this year). */
export function formatMessageTime(ts: number, now: number = Date.now(), locale?: string): string {
  const d = new Date(ts);
  const n = new Date(now);
  const time = d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOfDay(n) - startOfDay(d)) / 86_400_000);
  if (days === 0) return time;
  if (days > 0 && days < 7) return `${d.toLocaleDateString(locale, { weekday: "short" })} ${time}`;
  const date = d.toLocaleDateString(locale, {
    day: "numeric",
    month: "short",
    ...(d.getFullYear() !== n.getFullYear() && { year: "numeric" }),
  });
  return `${date} ${time}`;
}

/** Full date and time for the tooltip. */
export const fullMessageTime = (ts: number, locale?: string) =>
  new Date(ts).toLocaleString(locale, { dateStyle: "full", timeStyle: "medium" });
