import { describe, expect, it } from "vitest";
import {
   contextDetail,
   contextLabel,
   contextPrompt,
   shortUrl,
   type WindowContext,
   windowTitle,
} from "./windowContext";

const base = (c: Partial<WindowContext>): WindowContext => ({
   app: "Google Chrome",
   bundleId: "com.google.Chrome",
   missing: [],
   ...c,
});

describe("window context", () => {
   it("shortens URLs to host and path", () => {
      expect(shortUrl("https://www.github.com/dswbx/harness/pull/52?x=1#y")).toBe(
         "github.com/dswbx/harness/pull/52",
      );
      expect(shortUrl("https://example.com/")).toBe("example.com");
      expect(shortUrl("not a url")).toBe("not a url");
   });

   it("drops the app name from window titles", () => {
      expect(windowTitle("App.tsx — harness — Cursor", "Cursor")).toBe("App.tsx — harness");
      expect(windowTitle("general - Acme - Slack", "Slack")).toBe("general - Acme");
      expect(windowTitle("Slack", "Slack")).toBe("Slack");
   });

   it("labels a browser by its URL", () => {
      const c = base({ url: "https://github.com/dswbx/harness/pull/52", pageTitle: "PR" });
      expect(contextLabel(c)).toBe("Google Chrome · github.com/dswbx/harness/pull/52");
   });

   it("labels documents, Finder, windows and bare apps", () => {
      expect(
         contextLabel(base({ app: "Preview", documentPath: "/Users/me/a.pdf", windowTitle: "a" })),
      ).toBe("Preview · a.pdf");
      expect(
         contextLabel(base({ app: "Finder", folder: "/Users/me/Downloads/", files: ["/a", "/b"] })),
      ).toBe("Finder · Downloads · 2 selected");
      expect(contextLabel(base({ app: "Cursor", windowTitle: "App.tsx — harness — Cursor" }))).toBe(
         "Cursor · App.tsx — harness",
      );
      expect(contextLabel(base({ app: "Slack" }))).toBe("Slack");
   });

   it("cuts long labels", () => {
      const label = contextLabel(base({ app: "Notes", windowTitle: "x".repeat(100) }));
      expect(label.length).toBe("Notes · ".length + 60);
      expect(label.endsWith("…")).toBe(true);
   });

   it("writes one prompt line with the title, URL and quoted selection", () => {
      const c = base({
         url: "https://github.com/dswbx/harness/pull/52",
         pageTitle: "Quick overlay by dswbx",
         windowTitle: "Quick overlay by dswbx - Google Chrome",
         selectedText: "fn main() {}",
      });
      expect(contextPrompt(c)).toBe(
         'Context: the user is looking at Google Chrome, "Quick overlay by dswbx", https://github.com/dswbx/harness/pull/52. Selected text: "fn main() {}"',
      );
      expect(contextPrompt(base({ app: "Slack" }))).toBe("Context: the user is looking at Slack.");
   });

   it("caps the selected text", () => {
      const line = contextPrompt(base({ selectedText: "a".repeat(5000) }));
      expect(line.length).toBeLessThan(2100);
   });

   it("lists Finder items and says what is missing", () => {
      const c = base({
         app: "Finder",
         folder: "/Users/me",
         files: ["/Users/me/a.txt"],
         missing: ["accessibility"],
      });
      expect(contextPrompt(c)).toBe(
         "Context: the user is looking at Finder, folder /Users/me, selected files: /Users/me/a.txt.",
      );
      expect(contextDetail(c)).toContain("Allow Accessibility");
   });
});
