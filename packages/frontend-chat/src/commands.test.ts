import { describe, expect, it } from "vitest";
import type { SlashCommand } from "@harness/api";
import { btwQuestion, matchCommands, withSideThreadCommand } from "./commands";

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

describe("/btw", () => {
  it("takes only the exact prefix with text after it", () => {
    expect(btwQuestion("/btw why is it slow?")).toBe("why is it slow?");
    expect(btwQuestion("  /btw line1\nline2 ")).toBe("line1\nline2");
    expect(btwQuestion("/btw")).toBeNull();
    expect(btwQuestion("/btw  ")).toBeNull();
    expect(btwQuestion("/btwx hi")).toBeNull();
    expect(btwQuestion("hello /btw hi")).toBeNull();
  });
  it("our command wins over the Agent's", () => {
    const list = withSideThreadCommand([c("review"), { ...c("btw"), description: "agent's" }]);
    expect(list.map((x) => x.name)).toEqual(["btw", "review"]);
    expect(list[0]!.description).not.toBe("agent's");
  });
});
