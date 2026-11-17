import { describe, expect, it } from "vitest";
import { closeTab, type FileTab, isMarkdown, openTab, parseTabs } from "./fileTabs";

const t = (path: string, pinned = true): FileTab => ({ path, pinned });

describe("openTab", () => {
   it("a browsed file replaces the preview tab, in its place", () => {
      expect(openTab([t("a"), t("b", false), t("c")], "d")).toEqual([
         t("a"),
         t("d", false),
         t("c"),
      ]);
   });
   it("adds a preview tab when there is none", () => {
      expect(openTab([t("a")], "b")).toEqual([t("a"), t("b", false)]);
   });
   it("an open file keeps its tab; pin pins it", () => {
      const tabs = [t("a"), t("b", false)];
      expect(openTab(tabs, "a")).toBe(tabs);
      expect(openTab(tabs, "b")).toBe(tabs);
      expect(openTab(tabs, "b", true)).toEqual([t("a"), t("b")]);
   });
   it("a pinned open adds a pinned tab and keeps the preview", () => {
      expect(openTab([t("a", false)], "b", true)).toEqual([t("a", false), t("b")]);
   });
});

describe("closeTab", () => {
   it("closing the active tab shows the one that took its place, else the one before", () => {
      const tabs = [t("a"), t("b"), t("c")];
      expect(closeTab(tabs, "b", "b")).toEqual({ tabs: [t("a"), t("c")], active: "c" });
      expect(closeTab(tabs, "c", "c")).toEqual({ tabs: [t("a"), t("b")], active: "b" });
      expect(closeTab([t("a")], "a", "a")).toEqual({ tabs: [], active: null });
   });
   it("closing another tab keeps the active one", () => {
      expect(closeTab([t("a"), t("b")], "a", "b")).toEqual({ tabs: [t("b")], active: "b" });
   });
});

it("parseTabs drops malformed entries", () => {
   expect(parseTabs([{ path: "a", pinned: true, source: true }, { path: 1 }, null, "x"])).toEqual([
      { path: "a", pinned: true, source: true },
   ]);
   expect(parseTabs("nope")).toEqual([]);
});

it("isMarkdown", () => {
   expect(isMarkdown("docs/README.md")).toBe(true);
   expect(isMarkdown("a.MDX")).toBe(true);
   expect(isMarkdown("Cargo.toml")).toBe(false);
});
