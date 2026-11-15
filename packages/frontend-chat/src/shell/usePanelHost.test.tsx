import type { SessionApi } from "@harness/api";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { type ComponentType, lazy, Suspense, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { definePanel, type PanelBodyProps, type PanelCtx } from "../panels/contract";
import { usePanelTarget } from "../panels/usePanelTarget";
import { initialState } from "../state/reducer";
import { defaultLayout, isOpen, type Layout } from "./dock/model";
import { usePanelHost } from "./usePanelHost";

const applied: string[] = [];
const fallback = vi.fn();

/** Applies its target in the body. */
const files = definePanel<null, string>({
   id: "files",
   label: "Files",
   icon: () => null,
   placement: { edge: "right" },
   useModel: () => null,
   status: () => ({ presence: "ready" }),
   fallback: (_ctx, t) => fallback(t),
   Body: ({ self }: PanelBodyProps<null, string>) => {
      usePanelTarget(self, (t) => applied.push(`files:${t}`));
      return <div data-testid="files" />;
   },
});

/** A lazy body that stays mounted once opened, like the Terminal. */
const terminal = definePanel<null, string>({
   id: "terminal",
   label: "Terminal",
   icon: () => null,
   placement: { edge: "bottom" },
   mount: "afterFirstOpen",
   useModel: () => null,
   status: () => ({ presence: "ready" }),
   Body: lazy(async () => ({
      default: ({ self }: PanelBodyProps<null, string>) => {
         usePanelTarget(self, (t) => applied.push(`terminal:${t}`));
         return <div data-testid="terminal" />;
      },
   })),
});

/** Applies in the model, so it works while hidden. */
const plan = definePanel<null, string>({
   id: "plan",
   label: "Plan",
   icon: () => null,
   placement: { edge: "right" },
   useModel: (_ctx, self) => {
      usePanelTarget(self, (t) => applied.push(`plan:${t}`));
      return null;
   },
   status: () => ({ presence: "ready" }),
   Body: () => <div data-testid="plan" />,
});

const PANELS = [files, terminal, plan];

function setup(variant: "full" | "overlay" = "full") {
   const out = {} as { ctx: PanelCtx; lay: Layout };
   function Harness() {
      const [lay, setLay] = useState(defaultLayout);
      const host = usePanelHost({
         api: { sessionId: "s" } as SessionApi,
         state: initialState(),
         variant,
         lay,
         update: setLay,
         chat: null,
         host: {},
         panels: PANELS,
      });
      out.ctx = host.ctx;
      out.lay = lay;
      return (
         <>
            {PANELS.map((p) => {
               const self = host.selves[p.id]!;
               if (!(p.mount === "afterFirstOpen" ? self.opened : self.open)) return null;
               const Body = p.Body as ComponentType<PanelBodyProps<unknown, string>>;
               return (
                  <Suspense key={p.id} fallback={null}>
                     <Body model={host.models[p.id]} ctx={host.ctx} self={self as never} />
                  </Suspense>
               );
            })}
         </>
      );
   }
   const view = render(<Harness />);
   return { out, view };
}

afterEach(cleanup);

describe("usePanelHost targets", () => {
   it("applies the same target twice when opened twice", () => {
      applied.length = 0;
      const { out } = setup();
      act(() => out.ctx.open(files, "a.ts"));
      act(() => out.ctx.open(files, "a.ts"));
      expect(applied).toEqual(["files:a.ts", "files:a.ts"]);
   });

   it("opens a closed panel at the target, applied once after mount", () => {
      applied.length = 0;
      const { out, view } = setup();
      expect(view.queryByTestId("files")).toBeNull();
      act(() => out.ctx.open(files, "b.ts"));
      expect(isOpen(out.lay, "files")).toBe(true);
      expect(view.queryByTestId("files")).not.toBeNull();
      expect(applied).toEqual(["files:b.ts"]);
   });

   it("keeps a target sent before a lazy body mounted", async () => {
      applied.length = 0;
      const { out, view } = setup();
      act(() => out.ctx.open(terminal, "ls"));
      await waitFor(() => expect(view.queryByTestId("terminal")).not.toBeNull());
      expect(applied).toEqual(["terminal:ls"]);
   });

   it("applies a target in a model while the panel is hidden", () => {
      applied.length = 0;
      const { out } = setup();
      act(() => out.ctx.open(plan, "p1"));
      expect(applied).toEqual(["plan:p1"]);
   });

   it("calls the fallback instead of showing in the Quick overlay", () => {
      applied.length = 0;
      fallback.mockClear();
      const { out, view } = setup("overlay");
      act(() => out.ctx.open(files, "c.ts"));
      expect(fallback).toHaveBeenCalledWith("c.ts");
      expect(isOpen(out.lay, "files")).toBe(false);
      expect(view.queryByTestId("files")).toBeNull();
      expect(applied).toEqual([]);
   });
});
