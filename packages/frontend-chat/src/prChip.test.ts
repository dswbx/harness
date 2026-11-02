import { describe, expect, it } from "vitest";
import { chipClick, chipOpen, chipPopover, closedChip, type ChipPopover, type ChipPopoverAction } from "./prChip";

const run = (...as: ChipPopoverAction[]) => as.reduce(chipPopover, closedChip);

describe("chipClick", () => {
  it("opens on GitHub with Cmd or Ctrl, else pins", () => {
    expect(chipClick({ metaKey: true, ctrlKey: false })).toBe("open");
    expect(chipClick({ metaKey: false, ctrlKey: true })).toBe("open");
    expect(chipClick({ metaKey: false, ctrlKey: false })).toBe("pin");
  });
});

describe("chipPopover", () => {
  it("hover opens and closes", () => {
    expect(chipOpen(run({ type: "hover", on: true }), false)).toBe(true);
    expect(chipOpen(run({ type: "hover", on: true }, { type: "hover", on: false }), false)).toBe(false);
  });

  it("a pinned popover stays open when the mouse leaves", () => {
    const s = run({ type: "hover", on: true }, { type: "toggle" }, { type: "hover", on: false });
    expect(s.pinned).toBe(true);
    expect(chipOpen(s, false)).toBe(true);
  });

  it("a second click unpins and closes, even under the mouse or next to the caret", () => {
    const s = run({ type: "hover", on: true }, { type: "toggle" }, { type: "toggle" });
    expect(chipOpen(s, true)).toBe(false);
  });

  it("Esc / click outside closes a pinned popover and one opened by the caret", () => {
    expect(chipOpen(run({ type: "toggle" }, { type: "close" }), false)).toBe(false);
    expect(chipOpen(run({ type: "close" }), true)).toBe(false);
  });

  it("the caret opens it again after it left the chip", () => {
    const s = run({ type: "close" }, { type: "inactive" });
    expect(chipOpen(s, true)).toBe(true);
  });

  it("keeps the same state when nothing changes", () => {
    const s: ChipPopover = { ...closedChip, hover: true };
    expect(chipPopover(s, { type: "hover", on: true })).toBe(s);
    expect(chipPopover(closedChip, { type: "inactive" })).toBe(closedChip);
  });
});
