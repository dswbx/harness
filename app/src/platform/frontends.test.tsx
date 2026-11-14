import type { Frontend } from "@harness/api";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const registry: Record<string, Frontend> = {};
vi.mock("./registry", () => ({ registry }));

const { frontendToggles, gallery, sharedView } = await import("./frontends");

const base = { manifest: { id: "x" }, View: () => null } as unknown as Frontend;
const toggle = (id: string, group: "chat" | "terminal") => ({
   id,
   group,
   label: id,
   toggleLabel: id,
   useValue: () => true,
   set: () => {},
});

afterEach(() => {
   cleanup();
   for (const k of Object.keys(registry)) delete registry[k];
});

describe("Frontend members through the registry", () => {
   it("renders the SharedView and Gallery of the Frontend that has them", () => {
      registry.plain = base;
      registry.rich = {
         ...base,
         SharedView: ({ id }) => <p>shared {id}</p>,
         Gallery: () => <p>gallery</p>,
      };
      const SharedView = sharedView();
      const Gallery = gallery();
      render(
         <>
            {SharedView && (
               <SharedView
                  client={{} as never}
                  id="a1"
                  sessions={[]}
                  onOpenSession={() => {}}
                  onAttach={() => {}}
                  onNewSession={() => {}}
               />
            )}
            {Gallery && <Gallery />}
         </>,
      );
      expect(screen.getByText("shared a1")).toBeTruthy();
      expect(screen.getByText("gallery")).toBeTruthy();
   });

   it("lists the toggles of a group across Frontends", () => {
      registry.a = { ...base, toggles: [toggle("t1", "chat"), toggle("t2", "terminal")] };
      registry.b = { ...base, toggles: [toggle("t3", "chat")] };
      expect(frontendToggles("chat").map((t) => t.id)).toEqual(["t1", "t3"]);
      expect(frontendToggles("terminal").map((t) => t.id)).toEqual(["t2"]);
   });

   it("a Frontend without them offers nothing and does not crash", () => {
      registry.plain = base;
      expect(sharedView()).toBeUndefined();
      expect(gallery()).toBeUndefined();
      expect(frontendToggles("chat")).toEqual([]);
   });
});
