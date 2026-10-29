import { describe, expect, it } from "vitest";
import { chipLabel, fastOn, groupConfigOptions, isToggle, toggleKind } from "./configGroups";
import type { ConfigOption } from "./reducer";

const opt = (id: string, name: string, category: string | undefined, currentValue: string, values: (string | [string, string])[]): ConfigOption => ({
  id,
  name,
  category,
  type: "select",
  currentValue,
  options: values.map((v) => (Array.isArray(v) ? { value: v[0], name: v[1] } : { value: v, name: v })),
});
const ids = (os: ConfigOption[]) => os.map((o) => o.id);

const codex = [
  opt("mode", "Mode", "mode", "agent", [["read-only", "Read-only"], ["agent", "Auto review"]]),
  opt("collaboration_mode", "Collaboration mode", "collaboration_mode", "default", [["default", "Default"], ["plan", "Plan"]]),
  opt("model", "Model", "model", "gpt-6.1-sol", [["gpt-6.1-sol", "6.1 Sol"], ["gpt-6-luna", "6 Luna"]]),
  opt("reasoning_effort", "Reasoning effort", "thought_level", "high", [["low", "Low"], ["high", "High"]]),
  opt("service_tier", "Fast mode", "model_config", "off", ["off", "on"]),
];

const claude = [
  opt("mode", "Mode", "mode", "default", [["default", "Manual"], ["auto", "Auto"]]),
  opt("model", "Model", "model", "opus", [["opus", "Opus 5.5"], ["sonnet", "Sonnet 5"]]),
  opt("effort", "Effort", "thought_level", "medium", [["low", "Low"], ["medium", "Medium"], ["high", "High"]]),
  opt("thinking", "Thinking", undefined, "true", [["false", "Disabled"], ["true", "Enabled"]]),
  opt("fast", "Fast mode", undefined, "On", ["Off", "On"]),
  opt("output_style", "Output style", undefined, "default", [["default", "Default"], ["explanatory", "Explanatory"]]),
];

describe("isToggle", () => {
  it("matches on/off pairs by value or name, any order and case", () => {
    expect(isToggle(opt("a", "A", undefined, "x", [["1", "On"], ["0", "Off"]]))).toEqual({ on: "1", off: "0" });
    expect(isToggle(opt("a", "A", undefined, "x", ["FALSE", "TRUE"]))).toEqual({ on: "TRUE", off: "FALSE" });
    expect(isToggle(opt("a", "A", undefined, "x", ["disabled", "enabled"]))).toEqual({ on: "enabled", off: "disabled" });
  });
  it("rejects other options", () => {
    expect(isToggle(opt("a", "A", undefined, "x", [["default", "Default"], ["plan", "Plan"]]))).toBeNull();
    expect(isToggle(opt("a", "A", undefined, "x", ["off", "on", "auto"]))).toBeNull();
  });
});

describe("groupConfigOptions", () => {
  it("groups Codex-like options", () => {
    const g = groupConfigOptions(codex);
    expect(g.mode?.id).toBe("mode");
    expect(g.model?.id).toBe("model");
    expect(g.effort?.id).toBe("reasoning_effort");
    expect(ids(g.chipToggles)).toEqual(["service_tier"]);
    expect(ids(g.more)).toEqual(["collaboration_mode"]);
    expect(chipLabel(g)).toBe("6.1 Sol · High");
    expect(fastOn(g)).toBe(false);
  });

  it("groups Claude-like options (toggles without category by name)", () => {
    const g = groupConfigOptions(claude);
    expect(ids(g.chipToggles)).toEqual(["thinking", "fast"]);
    expect(g.chipToggles.map(toggleKind)).toEqual(["think", "fast"]);
    expect(ids(g.more)).toEqual(["output_style"]);
    expect(chipLabel(g)).toBe("Opus 5.5 · Medium");
    expect(fastOn(g)).toBe(true);
  });

  it("puts a 3-value model_config option in a chip submenu", () => {
    const g = groupConfigOptions([...codex, opt("verbosity", "Verbosity", "model_config", "low", ["low", "medium", "high"])]);
    expect(ids(g.chipSubmenus)).toEqual(["verbosity"]);
    expect(ids(g.more)).toEqual(["collaboration_mode"]);
  });

  it("moves chip parts to more when there is no model option", () => {
    const g = groupConfigOptions(claude.filter((o) => o.id !== "model"));
    expect(g.model).toBeUndefined();
    expect(g.effort).toBeUndefined();
    expect(g.chipToggles).toEqual([]);
    expect(ids(g.more)).toEqual(["effort", "thinking", "fast", "output_style"]);
    expect(chipLabel(g)).toBeNull();
  });

  it("puts an option without category in more and skips non-select types", () => {
    const g = groupConfigOptions([opt("x", "Something", undefined, "a", ["a", "b"]), { ...opt("y", "Y", undefined, "a", ["a"]), type: "text" }]);
    expect(g.mode).toBeUndefined();
    expect(ids(g.more)).toEqual(["x"]);
  });
});
