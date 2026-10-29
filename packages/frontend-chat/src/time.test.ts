import { describe, expect, it } from "vitest";
import { formatRelativeTime } from "./time";

const at = (y: number, mo: number, d: number, h = 14, mi = 32) => new Date(y, mo - 1, d, h, mi).getTime();
const now = at(2026, 10, 29, 18, 0);
const ago = (ms: number) => formatRelativeTime(now - ms, now, "en");

describe("formatRelativeTime", () => {
  it("under 45s: just now (also for small clock skew into the future)", () => {
    expect(ago(10_000)).toBe("just now");
    expect(ago(-5_000)).toBe("just now");
  });
  it("minutes, never 0", () => {
    expect(ago(50_000)).toBe("1 minute ago");
    expect(ago(5 * 60_000)).toBe("5 minutes ago");
  });
  it("hours", () => {
    expect(ago(60 * 60_000)).toBe("1 hour ago");
    expect(ago(3 * 60 * 60_000 + 10 * 60_000)).toBe("3 hours ago");
  });
  it("days by calendar day: yesterday, then n days ago", () => {
    expect(formatRelativeTime(at(2026, 10, 28, 9, 0), now, "en")).toBe("yesterday");
    expect(formatRelativeTime(at(2026, 10, 26), now, "en")).toBe("3 days ago");
  });
  it("over 23h but same-ish evening counts as yesterday", () => {
    expect(formatRelativeTime(at(2026, 10, 28, 17, 0), at(2026, 10, 29, 17, 30), "en")).toBe("yesterday");
  });
  it("a week or older: date, year only when not this year", () => {
    expect(formatRelativeTime(at(2026, 10, 12), now, "en-GB")).toBe("12 Oct");
    expect(formatRelativeTime(at(2025, 10, 12), now, "en-GB")).toBe("12 Oct 2025");
  });
});
