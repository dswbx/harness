import { describe, expect, it } from "vitest";
import type { SlashCommand } from "@harness/api";
import { matchCommands } from "./commands";

const c = (name: string): SlashCommand => ({ name, description: "", hint: null }) as SlashCommand;
const cmds = ["review", "init", "compact", "pr-review", "reset", "release-notes"].map(c);

describe("matchCommands", () => {
  it("needs a leading slash and no whitespace", () => {
    expect(matchCommands(cmds, "re")).toEqual([]);
    expect(matchCommands(cmds, "/re view")).toEqual([]);
  });
  it("lists everything for a bare slash", () => {
    expect(matchCommands(cmds, "/")).toHaveLength(6);
  });
  it("puts prefix matches before substring matches", () => {
    expect(matchCommands(cmds, "/re").map((x) => x.name)).toEqual(["review", "reset", "release-notes", "pr-review"]);
  });
  it("is case-insensitive and caps at 8", () => {
    expect(matchCommands(cmds, "/REV").map((x) => x.name)).toEqual(["review", "pr-review"]);
    expect(matchCommands(Array.from({ length: 20 }, (_, i) => c(`a${i}`)), "/a")).toHaveLength(8);
  });
});
