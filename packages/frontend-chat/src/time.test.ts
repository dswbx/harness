import { describe, expect, it } from "vitest";
import { formatMessageTime } from "./time";

const at = (y: number, mo: number, d: number, h = 14, mi = 32) => new Date(y, mo - 1, d, h, mi).getTime();
const now = at(2026, 10, 29, 18, 0);

describe("formatMessageTime", () => {
  it("today: time only", () => {
    expect(formatMessageTime(at(2026, 10, 29), now, "en-GB")).toBe("14:32");
  });
  it("this week: weekday and time", () => {
    expect(formatMessageTime(at(2026, 10, 26), now, "en-GB")).toBe("Mon 14:32");
  });
  it("yesterday just before midnight counts as a day ago", () => {
    expect(formatMessageTime(at(2026, 10, 28, 23, 59), at(2026, 10, 29, 0, 1), "en-GB")).toBe("Wed 23:59");
  });
  it("older: date and time, no year when this year", () => {
    expect(formatMessageTime(at(2026, 10, 12), now, "en-GB")).toBe("12 Oct 14:32");
  });
  it("other year: adds year", () => {
    expect(formatMessageTime(at(2025, 10, 12), now, "en-GB")).toBe("12 Oct 2025 14:32");
  });
  it("future timestamps (clock skew) show a date", () => {
    expect(formatMessageTime(at(2026, 10, 31), now, "en-GB")).toBe("31 Oct 14:32");
  });
});
