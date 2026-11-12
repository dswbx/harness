import type { Event, EventKind } from "@harness/api";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "./Markdown";
import { initialState, reduce } from "./reducer";
import { Env, type UiEnv } from "./renderUi/runtime";
import { SourceMarkdown } from "./renderUi/source";
import { slotChangeKey, splitRenderUi } from "./slots";
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

   it("keeps the source and the call's time on the slot", () => {
      const s = fold([ui({ id: "p", placement: "right", title: "P", source: "a.md" })]);
      const slot = splitRenderUi(s.items).slots.right[0]!;
      expect(slot.source).toBe("a.md");
      expect(slot.ts).toBe(0);
   });

   it("counts a write of the source file as a change (the change dot)", () => {
      const s = fold([
         ui({ id: "p", placement: "right", title: "P", source: "a.md" }),
         ui({ id: "q", placement: "right", title: "Q", root: md("x") }),
      ]);
      const [p, q] = splitRenderUi(s.items).slots.right;
      const before = slotChangeKey(p!, { "a.md": { hash: "h1" } });
      expect(slotChangeKey(p!, { "a.md": { hash: "h2" } })).not.toBe(before);
      expect(slotChangeKey(p!, { "a.md": { hash: "h1" } })).toBe(before);
      expect(slotChangeKey(q!, { "a.md": { hash: "h2" } })).toBe(slotChangeKey(q!, {}));
   });

   it("shows a pulsing placeholder while the file loads, so a capture waits for it", () => {
      const env = {
         readSource: () => new Promise(() => {}),
      } as unknown as UiEnv;
      const out = renderToStaticMarkup(
         createElement(
            Env.Provider,
            { value: env },
            createElement(SourceMarkdown, { name: "a.md" }),
         ),
      );
      expect(out).toContain("animate-pulse");
      // Without a reader (nothing will load), nothing waits.
      const none = renderToStaticMarkup(
         createElement(
            Env.Provider,
            { value: {} as UiEnv },
            createElement(SourceMarkdown, { name: "a.md" }),
         ),
      );
      expect(none).toBe("");
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
