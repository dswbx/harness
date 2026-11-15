import { describe, expect, it } from "vitest";
import {
   base64,
   contextAction,
   contextAttachment,
   contextDetail,
   contextKey,
   contextLabel,
   contextMarkdown,
   contextName,
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

   it("writes a Markdown file with the title, URL and quoted selection", () => {
      const c = base({
         url: "https://github.com/dswbx/harness/pull/52",
         pageTitle: "Quick overlay by dswbx",
         windowTitle: "Quick overlay by dswbx - Google Chrome",
         selectedText: "fn main() {\n\n}",
      });
      expect(contextMarkdown(c)).toBe(
         [
            "# Window context",
            "",
            "What the user is looking at in another app (from the Harness Quick overlay).",
            "",
            "- App: Google Chrome",
            "- Window: Quick overlay by dswbx - Google Chrome",
            "- Page: Quick overlay by dswbx",
            "- URL: https://github.com/dswbx/harness/pull/52",
            "",
            "Selected text:",
            "",
            "> fn main() {",
            ">",
            "> }",
            "",
         ].join("\n"),
      );
   });

   it("caps the selected text and lists Finder items", () => {
      expect(contextMarkdown(base({ selectedText: "a".repeat(5000) })).length).toBeLessThan(2300);
      const md = contextMarkdown(
         base({ app: "Finder", folder: "/Users/me", files: ["/Users/me/a.txt"] }),
      );
      expect(md).toContain("- Folder: /Users/me\n- Selected files:\n  - /Users/me/a.txt\n");
   });

   it("names the attachment after the app and host, without path characters", () => {
      expect(contextName(base({ url: "https://www.github.com/dswbx/harness/pull/52?x=1" }))).toBe(
         "Context - Google Chrome · github.com.md",
      );
      expect(contextName(base({ app: "Preview", documentPath: "/Users/me/a:b.pdf" }))).toBe(
         "Context - Preview · a b.pdf.md",
      );
      expect(contextName(base({ app: "Slack" }))).toBe("Context - Slack.md");
      const long = contextName(base({ app: "Notes", windowTitle: "x/".repeat(80) }));
      expect(long.length).toBeLessThanOrEqual(60);
      expect(long.endsWith("….md")).toBe(true);
      expect(long).not.toContain("/");
   });

   it("encodes the attachment as UTF-8 base64 Markdown", () => {
      const a = contextAttachment(base({ windowTitle: "Café ✓" }));
      expect(a).toMatchObject({ type: "data", mime: "text/markdown" });
      const data = a.type === "data" ? a.data : "";
      const text = new TextDecoder().decode(Uint8Array.from(atob(data), (ch) => ch.charCodeAt(0)));
      expect(text).toContain("- Window: Café ✓");
      expect(base64("hi")).toBe("aGk=");
   });

   it("keys a context by app, window, document and page", () => {
      const a = base({ windowTitle: "PR", url: "https://x.dev/1" });
      expect(contextKey(a)).toBe(
         contextKey({ ...a, selectedText: "more", missing: ["automation"] }),
      );
      expect(contextKey(a)).not.toBe(contextKey({ ...a, url: "https://x.dev/2" }));
      expect(contextKey(a)).not.toBe(contextKey({ ...a, windowTitle: "Other" }));
      expect(contextKey(a)).not.toBe(contextKey({ ...a, bundleId: "com.apple.Safari" }));
   });

   it("links to Automation first, then Accessibility", () => {
      expect(contextAction(base({ missing: ["accessibility", "automation"] }))).toEqual({
         label: "Allow browser access",
         pane: "automation",
      });
      expect(
         contextAction(
            base({ app: "Finder", bundleId: "com.apple.finder", missing: ["automation"] }),
         )?.label,
      ).toBe("Allow access to Finder");
      expect(contextAction(base({ missing: ["accessibility"] }))?.pane).toBe("accessibility");
      expect(contextAction(base({}))).toBeUndefined();
   });

   it("says what is missing in the tooltip", () => {
      expect(contextDetail(base({ missing: ["accessibility"] }))).toContain("Allow Accessibility");
   });
});
