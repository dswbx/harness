import { describe, expect, it } from "vitest";
import { formatAge, formatAgeAgo, formatDateTime } from "./time";

const NOW = Date.UTC(2026, 10, 2, 12);
const M = 60_000;
const D = 1440 * M;

describe("formatAge", () => {
   it("short units", () => {
      expect(
         [0, 30_000, 12 * M, 120 * M, 3 * D, 45 * D, 100 * D, 800 * D].map((d) =>
            formatAge(NOW - d, NOW),
         ),
      ).toEqual(["now", "now", "12m", "2h", "3d", "45d", "3mo", "2y"]);
   });
   it("thresholds floor, the future is now", () => {
      expect(formatAge(NOW - 59_999, NOW)).toBe("now");
      expect(formatAge(NOW - M, NOW)).toBe("1m");
      expect(formatAge(NOW - (60 * M - 1), NOW)).toBe("59m");
      expect(formatAge(NOW - 7 * D, NOW)).toBe("7d");
      expect(formatAge(NOW - 30 * D, NOW)).toBe("30d");
      expect(formatAge(NOW - (90 * D - 1), NOW)).toBe("89d");
      expect(formatAge(NOW - 90 * D, NOW)).toBe("3mo");
      expect(formatAge(NOW - 364 * D, NOW)).toBe("12mo");
      expect(formatAge(NOW - 365 * D, NOW)).toBe("1y");
      expect(formatAge(NOW + 5 * D, NOW)).toBe("now");
   });
});

describe("formatAgeAgo", () => {
   it("now stays bare, units get ago", () => {
      expect(formatAgeAgo(NOW - 10_000, NOW)).toBe("now");
      expect(formatAgeAgo(NOW - 5 * M, NOW)).toBe("5m ago");
      expect(formatAgeAgo(NOW - 3 * D, NOW)).toBe("3d ago");
   });
});

describe("formatDateTime", () => {
   it("medium date, short time, in the given zone", () => {
      expect(formatDateTime(Date.UTC(2026, 10, 2, 12, 5), "en-US", "UTC")).toMatch(
         /^Nov 2, 2026,.*12:05.*PM$/,
      );
   });
});
