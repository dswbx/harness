import type { Event, EventKind } from "@harness/api";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "./Markdown";
import { initialState, reduce } from "./reducer";
import { splitRenderUi } from "./slots";
import { renderUiSchema } from "./tools";

/** File-backed panels (ADR 0023): render_ui `source` instead of `root`. */

let seq = 0;
const ev = (kind: EventKind): Event => ({
   v: 1,
   seq: seq++,
   session_id: "s",
   thread_id: "main",
   ts_ms: 0,
   kind,
});
const ui = (input: Record<string, unknown>) =>
   ev({ type: "FrontendToolOutput", tool: "render_ui", call_id: `c${seq}`, path: "p", input });
const fold = (events: Event[]) => events.reduce(reduce, initialState());
const md = (text: string) => ({ type: "Markdown", props: { text } });
const valid = (input: unknown) => renderUiSchema.validate(input).valid;

describe("render_ui source", () => {
   it("takes exactly one of root or source, a relative .md name", () => {
      const at = { id: "p", placement: "right", title: "P" };
      expect(valid({ ...at, source: "progress.md" })).toBe(true);
      expect(valid({ ...at, source: "upgrade/progress.md" })).toBe(true);
      expect(valid({ ...at, root: md("x") })).toBe(true);
      expect(valid({ ...at, root: md("x"), source: "progress.md" })).toBe(false);
      expect(valid({ ...at })).toBe(false);
      expect(valid({ ...at, source: "progress.html" })).toBe(false);
      expect(valid({ ...at, source: "/etc/progress.md" })).toBe(false);
      expect(valid({ id: "p", remove: true })).toBe(true);
   });

   it("replays as a Markdown node naming the file, and can switch to a root and back", () => {
      const s = fold([
         ui({ id: "p", placement: "right", title: "P", source: "plan/progress.md" }),
         ui({ id: "q", source: "notes.md" }),
      ]);
      const { inline, slots } = splitRenderUi(s.items);
      expect(slots.right.map((x) => [x.id, x.root])).toEqual([
         ["p", { type: "Markdown", props: { source: "plan/progress.md" } }],
      ]);
      expect(inline.get(s.items[1]!.id)?.root).toEqual({
         type: "Markdown",
         props: { source: "notes.md" },
      });
      const later = fold([
         ui({ id: "p", placement: "right", title: "P", source: "a.md" }),
         ui({ id: "p", placement: "right", title: "P", root: md("tree") }),
      ]);
      expect(splitRenderUi(later.items).slots.right[0]!.root).toEqual(md("tree"));
   });
});

describe("Markdown with html", () => {
   const html = (text: string, on = true) =>
      // biome-ignore lint/correctness/noChildrenProp: Markdown takes its text as children
      renderToStaticMarkup(createElement(Markdown, { html: on, children: text }));
   const text =
      '<details open>\n<summary>More</summary>\n\nHidden **text**\n\n</details>\n\n<script>alert(1)</script><img src="x.png" onerror="alert(1)"><iframe src="https://x"></iframe><div style="color:red">styled</div>';

   it("shows <details> and <summary>, and strips scripts, frames, handlers and styles", () => {
      const out = html(text);
      expect(out).toContain('<details open="">');
      expect(out).toContain("<summary>More</summary>");
      expect(out).toContain("<strong>text</strong>");
      expect(out).not.toMatch(/<script|<iframe|onerror|style=/);
   });

   it("drops raw HTML without it", () => {
      expect(html(text, false)).not.toContain("<details");
   });
});
