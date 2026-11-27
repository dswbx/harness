import { describe, expect, it } from "vitest";
import { ALL_CHANGES, diffWindowScope, diffWindowUrl, folderDiffWindow } from "./diffWindow";

describe("diffWindowUrl", () => {
   it("keeps the Session window's URL as it was", () => {
      expect(diffWindowUrl({ sessionId: "s1" }, ALL_CHANGES)).toBe(
         "/?session=s1&solo=1&pane=diff&label=All+changes&sel=all",
      );
      expect(
         diffWindowUrl({ sessionId: "s1" }, { from: "a^", to: "b", label: "b fix", sel: ["b"] }),
      ).toBe("/?session=s1&solo=1&pane=diff&label=b+fix&from=a%5E&to=b&sel=b");
      expect(diffWindowUrl({ sessionId: "s1" }, { from: "x", to: null, label: "Turn" })).toBe(
         "/?session=s1&solo=1&pane=diff&label=Turn&from=x",
      );
   });

   it("a folder window's URL round-trips its folder and scope", () => {
      const scope = { from: "a^", to: null, label: "Uncommitted + a", sel: ["wip", "a"] };
      const url = diffWindowUrl({ folder: "/home/me/my proj" }, scope);
      expect(url).toBe(
         "/?folder=%2Fhome%2Fme%2Fmy+proj&pane=diff&label=Uncommitted+%2B+a&from=a%5E&sel=wip%2Ca",
      );
      const search = url.slice(1);
      expect(diffWindowScope(search)).toEqual(scope);
      expect(folderDiffWindow(search)).toBe("/home/me/my proj");
      expect(diffWindowScope(diffWindowUrl({ folder: "/r" }, ALL_CHANGES).slice(1))).toEqual(
         ALL_CHANGES,
      );
   });

   it("only a diff window with a folder is a Folder Diff window", () => {
      expect(folderDiffWindow(diffWindowUrl({ sessionId: "s1" }, ALL_CHANGES).slice(1))).toBeNull();
      expect(folderDiffWindow("?folder=/r")).toBeNull();
      expect(diffWindowScope("?session=s1&solo=1")).toBeNull();
   });
});
