import { describe, expect, it } from "vitest";
import { closeTab, emptyPanel, openTab, toggleTab, type PanelTab } from "./panelTabs";

const changes: PanelTab = { kind: "changes" };
const term: PanelTab = { kind: "terminal" };
const t1: PanelTab = { kind: "thread", id: "a" };
const t2: PanelTab = { kind: "thread", id: "b" };

describe("panel tabs", () => {
  it("toggle opens, then closes the shown tab (as the single panel did)", () => {
    const open = toggleTab(emptyPanel, changes);
    expect(open).toEqual({ tabs: [changes], active: changes });
    expect(toggleTab(open, changes)).toEqual(emptyPanel);
  });
  it("opening an open tab only shows it", () => {
    const s = openTab(openTab(openTab(emptyPanel, changes), t1), changes);
    expect(s.tabs).toEqual([changes, t1]);
    expect(s.active).toEqual(changes);
  });
  it("closing the shown tab shows its left neighbour, else right, else none", () => {
    let s = [changes, t1, t2].reduce(openTab, emptyPanel);
    s = closeTab(s, t2);
    expect(s.active).toEqual(t1);
    s = openTab(openTab(s, term), t2);
    expect(closeTab(s, t2).active).toEqual(term);
    expect(closeTab(closeTab(openTab(emptyPanel, t1), t2), t1)).toEqual(emptyPanel);
    expect(closeTab(openTab(openTab(emptyPanel, t1), t2), t1).active).toEqual(t2);
  });
  it("closing a background tab keeps the shown one", () => {
    const s = closeTab([changes, t1].reduce(openTab, emptyPanel), changes);
    expect(s).toEqual({ tabs: [t1], active: t1 });
  });
  it("toggling a tab that is open but not shown shows it", () => {
    const s = toggleTab([term, t1].reduce(openTab, emptyPanel), term);
    expect(s.active).toEqual(term);
    expect(s.tabs).toHaveLength(2);
  });
});
