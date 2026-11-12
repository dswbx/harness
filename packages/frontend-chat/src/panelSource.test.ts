import type { Event, EventKind } from "@harness/api";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "./Markdown";
import { RenderUi } from "./RenderUi";
import { initialState, reduce } from "./reducer";
import { Env, type UiEnv } from "./renderUi/runtime";
import { SourceMarkdown, SourceView } from "./renderUi/source";
import { slotChangeKey, splitRenderUi } from "./slots";
import { renderUiSchema, withSourceRoot } from "./tools";

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
   it("takes exactly one of root or source, a relative .md or .html name", () => {
      const at = { id: "p", placement: "right", title: "P" };
      expect(valid({ ...at, source: "progress.md" })).toBe(true);
      expect(valid({ ...at, source: "upgrade/progress.md" })).toBe(true);
      expect(valid({ ...at, root: md("x") })).toBe(true);
      expect(valid({ ...at, root: md("x"), source: "progress.md" })).toBe(false);
      expect(valid({ ...at })).toBe(false);
      expect(valid({ ...at, source: "progress.html" })).toBe(true);
      expect(valid({ ...at, source: "progress.txt" })).toBe(false);
      expect(valid({ ...at, source: "progress.htm" })).toBe(false);
      // The node that names a file is the reducer's; the Agent cannot send one in a root.
      expect(valid({ ...at, root: { type: "Html", props: { source: "b.html" } } })).toBe(false);
      expect(valid({ ...at, root: { type: "Markdown", props: { source: "a.md" } } })).toBe(false);
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

   it("maps .md to a Markdown node and .html to an Html node", () => {
      expect(withSourceRoot({ source: "a.md" }).root).toEqual({
         type: "Markdown",
         props: { source: "a.md" },
      });
      expect(withSourceRoot({ source: "sub/b.html" }).root).toEqual({
         type: "Html",
         props: { source: "sub/b.html" },
      });
      const s = fold([ui({ id: "b", placement: "left", title: "B", source: "b.html" })]);
      expect(splitRenderUi(s.items).slots.left[0]!.root).toEqual({
         type: "Html",
         props: { source: "b.html" },
      });
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

   it("shows the placeholder for an .html source too, so a capture waits for the frame's document", () => {
      const env = { readSource: () => new Promise(() => {}) } as unknown as UiEnv;
      const out = renderToStaticMarkup(
         createElement(
            Env.Provider,
            { value: env },
            // biome-ignore lint/correctness/noChildrenProp: SourceView takes a render function
            createElement(SourceView, { name: "b.html", children: () => "frame" }),
         ),
      );
      expect(out).toContain("animate-pulse");
      expect(out).not.toContain("frame");
   });

   it("renders an Html node naming a file through the source reader, not its html prop", () => {
      const env = {
         state: {},
         files: {},
         readSource: () => new Promise(() => {}),
      } as unknown as UiEnv;
      const out = renderToStaticMarkup(
         createElement(RenderUi, { root: { type: "Html", props: { source: "b.html" } }, env }),
      );
      expect(out).toContain("animate-pulse");
      expect(out).not.toContain("<iframe");
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

describe("render_ui shared: source (ADR 0024)", () => {
   it("accepts shared:<id> as a source and makes the internal Shared node", () => {
      expect(valid({ id: "p", placement: "right", source: "shared:release-3f9a1c" })).toBe(true);
      expect(valid({ id: "p", placement: "right", source: "shared:Bad/Id" })).toBe(false);
      expect(withSourceRoot({ source: "shared:release-3f9a1c" }).root).toEqual({
         type: "Shared",
         props: { id: "release-3f9a1c" },
      });
      // The Agent cannot send the node itself.
      expect(valid({ id: "p", root: { type: "Shared", props: { id: "release-3f9a1c" } } })).toBe(
         false,
      );
   });

   it("keeps the source on the slot", () => {
      const s = fold([ui({ id: "p", placement: "right", title: "P", source: "shared:x-000001" })]);
      const slot = splitRenderUi(s.items, [{ id: "x-000001", ts: 0 }]).slots.right[0]!;
      expect(slot.source).toBe("shared:x-000001");
      expect(slot.root).toEqual({ type: "Shared", props: { id: "x-000001" } });
   });

   it("renders a Shared node through the artifact reader, with a placeholder while it loads", () => {
      const env = {
         state: {},
         files: {},
         readShared: () => new Promise(() => {}),
      } as unknown as UiEnv;
      const out = renderToStaticMarkup(
         createElement(RenderUi, {
            root: { type: "Shared" as "Markdown", props: { id: "x" } },
            env,
         }),
      );
      expect(out).toContain("animate-pulse");
   });
});
