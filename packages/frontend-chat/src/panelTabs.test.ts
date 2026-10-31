import { describe, expect, it } from "vitest";
import { closeThread, emptyPanel, openThread, selectThread, showView, toggleView, type PanelView } from "./panelTabs";

const changes: PanelView = { kind: "changes" };
const term: PanelView = { kind: "terminal" };

describe("panel", () => {
  it("toggle shows the view, then closes the panel when it is the shown one", () => {
    const open = toggleView(emptyPanel, changes);
    expect(open.view).toEqual(changes);
    expect(toggleView(open, changes)).toEqual(emptyPanel);
  });
  it("toggling another view switches to it", () => {
    expect(toggleView(toggleView(emptyPanel, changes), term).view).toEqual(term);
  });
  it("opening a thread appends it, activates it and shows the side view", () => {
    const s = openThread(openThread(showView(emptyPanel, changes), "a"), "b");
    expect(s).toEqual({ threads: ["a", "b"], thread: "b", view: { kind: "side" } });
    expect(openThread(s, "a")).toEqual({ threads: ["a", "b"], thread: "a", view: { kind: "side" } });
  });
  it("toggling the side view off keeps the open threads", () => {
    const s = toggleView(openThread(emptyPanel, "a"), { kind: "side" });
    expect(s).toEqual({ threads: ["a"], thread: "a", view: null });
  });
  it("selecting only works for open threads", () => {
    const s = openThread(openThread(emptyPanel, "a"), "b");
    expect(selectThread(s, "a").thread).toBe("a");
    expect(selectThread(s, "zzz")).toBe(s);
  });
  it("closing the active thread shows its left neighbour, else right", () => {
    let s = ["a", "b", "c"].reduce(openThread, emptyPanel);
    s = closeThread(s, "c");
    expect(s.thread).toBe("b");
    s = selectThread(s, "a");
    expect(closeThread(s, "a").thread).toBe("b");
  });
  it("closing a background thread keeps the active one", () => {
    const s = closeThread(["a", "b"].reduce(openThread, emptyPanel), "a");
    expect(s).toEqual({ threads: ["b"], thread: "b", view: { kind: "side" } });
  });
  it("closing the last thread closes the panel", () => {
    expect(closeThread(openThread(emptyPanel, "a"), "a")).toEqual(emptyPanel);
  });
  it("closing the last thread leaves another shown view alone", () => {
    const s = showView(openThread(emptyPanel, "a"), term);
    expect(closeThread(s, "a").view).toEqual(term);
  });
});
