import { applyStatePatch } from "@harness/api";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RenderUi } from "../RenderUi";
import { type RawNode, renderUiSchema } from "../tools";
import type { UiEnv } from "./runtime";

const ok = (root: unknown) => renderUiSchema.validate({ root }).valid;
const card: RawNode = { type: "Text", props: { text: { $template: "#${$index}: ${note}" } } };
const repeat = { statePath: "/tickets", title: "name" };

describe("Accordion and Tabs with repeat", () => {
   it("takes static titles or repeat, never both, and one template child with repeat", () => {
      for (const [type, titles] of [
         ["Accordion", "items"],
         ["Tabs", "tabs"],
      ] as const) {
         expect(ok({ type, props: { [titles]: ["A"] }, children: [card] }), type).toBe(true);
         expect(ok({ type, props: { repeat }, children: [card] }), type).toBe(true);
         expect(
            ok({
               type,
               props: { repeat: { ...repeat, title: { $template: "${id}" } } },
               children: [card],
            }),
            type,
         ).toBe(true);
         expect(ok({ type, props: { [titles]: ["A"], repeat }, children: [card] }), type).toBe(
            false,
         );
         expect(ok({ type, props: {}, children: [card] }), type).toBe(false);
         expect(ok({ type, props: { repeat }, children: [card, card] }), type).toBe(false);
         expect(ok({ type, props: { repeat } }), type).toBe(false);
         expect(ok({ type, props: { repeat: { statePath: "/t" } }, children: [card] }), type).toBe(
            false,
         );
      }
   });

   it("renders one item per state entry and follows state changes", () => {
      const tickets = ["Alpha", "Beta", "Gamma"].map((name, i) => ({ name, note: `n${i}` }));
      let state: unknown = { tickets };
      const html = (root: RawNode) => {
         const env: UiEnv = { state, patch: async () => {}, send: async () => {}, files: {} };
         return renderToStaticMarkup(createElement(RenderUi, { root, env }));
      };
      const accordion: RawNode = {
         type: "Accordion",
         props: { repeat, multiple: true, open: [0, 1, 2, 3] },
         children: [
            { type: "Text", props: { text: { $template: "body ${note} #${/tickets/0/name}" } } },
         ],
      };
      const tabs: RawNode = {
         type: "Tabs",
         props: { repeat: { statePath: "/tickets", title: { $template: "T-${name}" } } },
         children: [{ type: "Text", props: { text: { $item: "note" } } }],
      };
      const count = (s: string, re: RegExp) => s.match(re)?.length ?? 0;

      let a = html(accordion);
      expect(count(a, /aria-expanded/g)).toBe(3);
      for (const n of ["Alpha", "Beta", "Gamma", "body n0 #Alpha", "body n2 #Alpha"])
         expect(a).toContain(n);
      let t = html(tabs);
      expect(count(t, /role="tab"/g)).toBe(3);
      expect(t).toContain("T-Gamma");
      expect(t).toContain(">n0<");

      state = applyStatePatch(state, [
         { op: "add", path: "/tickets/-", value: { name: "Delta", note: "n3" } },
      ]);
      a = html(accordion);
      expect(count(a, /aria-expanded/g)).toBe(4);
      expect(a).toContain("Delta");
      expect(a).toContain("body n3 #Alpha");
      t = html(tabs);
      expect(count(t, /role="tab"/g)).toBe(4);
      expect(t).toContain("T-Delta");
   });

   it("keeps static items working", () => {
      const env: UiEnv = { state: {}, patch: async () => {}, send: async () => {}, files: {} };
      const root: RawNode = {
         type: "Accordion",
         props: { items: ["One", "Two"], open: [1] },
         children: [card, { type: "Text", props: { text: "second" } }],
      };
      const a = renderToStaticMarkup(createElement(RenderUi, { root, env }));
      expect(a).toContain("One");
      expect(a).toContain("second");
   });
});
