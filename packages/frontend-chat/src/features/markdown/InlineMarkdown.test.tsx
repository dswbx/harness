import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { InlineMarkdown } from "./InlineMarkdown";

const html = (text: unknown, variant?: "rich" | "quiet") =>
   renderToStaticMarkup(<InlineMarkdown variant={variant}>{text}</InlineMarkdown>);

test("rich: links are anchors that open in a new tab", () => {
   const out = html("see [docs](https://x.dev)");
   expect(out).toContain('<a href="https://x.dev" target="_blank"');
});

test("quiet: links are underlined text, no anchor", () => {
   const out = html("see [docs](https://x.dev)", "quiet");
   expect(out).not.toContain("<a");
   expect(out).toContain('<span class="underline">docs</span>');
});

test("quiet collapses newlines, rich keeps plain text as is", () => {
   expect(html("a\n  b", "quiet")).toBe("a b");
   expect(html("a\nb")).toBe("a\nb");
});

test("code: chip in rich, bare in quiet", () => {
   expect(html("`x`")).toContain("bg-muted");
   expect(html("`x`", "quiet")).toBe('<code class="font-mono">x</code>');
});

test("non-string children and null", () => {
   expect(html(null)).toBe("");
   expect(html(42)).toBe("42");
});
