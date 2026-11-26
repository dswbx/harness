import type { SessionApi } from "@harness/api";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { definePanel, definePanelFamily } from "../../panels/contract";
import { type ChatState, initialState } from "../../state/reducer";
import { usePanelHost } from "../usePanelHost";
import { availablePanels, renderablePanels } from "../viewState";
import { shownOpen } from "./geometry";
import { isOpen, type Zone } from "./model";
import { mountedPanels } from "./mountedPanels";
import { loadRecord, saveRecord, usePanelRecord } from "./panelRecord";
import { useDockLayout, useHostPlaces } from "./useDockLayout";

const Book = () => <svg data-testid="icon-book" />;

const files = definePanel<null>({
   id: "files",
   label: "Files",
   icon: () => null,
   placement: { edge: "right" },
   useModel: () => null,
   status: () => ({ presence: "ready" }),
   Body: () => <div data-testid="body-files" />,
});

/** Like the render_ui panels: its instances exist only once the log is here (and while `present`). */
let present = true;
const A = ["a"];
const NONE: string[] = [];
const slots = definePanelFamily<string[]>({
   prefix: "slot",
   useModel: ({ state }) => (state.loaded && present ? A : NONE),
   instances: (keys) =>
      keys.map((key) => ({
         key,
         label: "Notes",
         icon: Book,
         iconName: "book",
         placement: { edge: "right" },
         status: { presence: "ready" },
      })),
   iconOf: (name) => (name === "book" ? Book : undefined),
   Body: ({ instance }) => <div data-testid={`body-${instance}`} />,
});

const PANELS = [files];
const FAMILIES = [slots];

type Frame = { open: Zone | null; shown: string | null; mounted: string[] };
let frames: Frame[] = [];

function Harness({ state, overlay = false }: { state: ChatState; overlay?: boolean }) {
   const { lay, update, placesRef, setPlaces } = useDockLayout("s1", overlay ? "overlay" : "main");
   const host = usePanelHost({
      api: { sessionId: "s1" } as SessionApi,
      state,
      variant: overlay ? "overlay" : "full",
      lay,
      update,
      chat: null,
      host: {},
      panels: PANELS,
      families: FAMILIES,
   });
   const availableNow = availablePanels({
      overlay,
      statuses: host.statuses,
      overlayPanels: host.overlayIds,
   });
   const r = usePanelRecord({
      sessionId: "s1",
      overlay,
      loaded: state.loaded,
      entries: host.entries,
      available: availableNow,
      renderable: renderablePanels(availableNow, host.statuses),
      families: FAMILIES,
   });
   const shown = shownOpen(lay, r.renderable);
   useHostPlaces({ placesRef, setPlaces }, host.places);
   const panels = mountedPanels(
      host.entries,
      (id) => isOpen(shown, id),
      r.renderable,
      r.placeholders,
   );
   frames.push({
      open: lay.open.rightBottom === "slot:a" ? "rightBottom" : null,
      shown: shown.open.rightBottom,
      mounted: panels.map((p) => p.id),
   });
   const Icon = r.hints.get("slot:a")?.icon;
   return (
      <>
         {Icon && <Icon />}
         {panels.map((p) => (
            <section key={p.id} aria-label={p.label}>
               {p.children}
            </section>
         ))}
      </>
   );
}

const loaded = (): ChatState => ({ ...initialState(), loaded: true });

const mem = new Map<string, string>();
beforeEach(() => {
   mem.clear();
   vi.stubGlobal("localStorage", {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, String(v)),
      removeItem: (k: string) => void mem.delete(k),
      clear: () => mem.clear(),
   });
   frames = [];
   present = true;
   localStorage.setItem(
      "harness.chat.layout.s1",
      JSON.stringify({
         v: 2,
         zones: { rightTop: ["files"], rightBottom: ["slot:a"] },
         open: { rightBottom: "slot:a" },
         sizes: {},
      }),
   );
   saveRecord("s1", [
      { id: "files", label: "Files", ready: true },
      { id: "slot:a", label: "Notes", icon: "book", ready: true },
   ]);
});
afterEach(() => {
   cleanup();
   vi.unstubAllGlobals();
});

describe("usePanelRecord in the dock", () => {
   it("shows a recorded open panel in its zone from the first render, as a placeholder", () => {
      const { rerender } = render(<Harness state={initialState()} />);
      expect(frames[0]).toEqual({ open: "rightBottom", shown: "slot:a", mounted: ["slot:a"] });
      expect(screen.getByRole("region", { name: "Notes" })).toBeTruthy();
      expect(screen.queryByTestId("body-a")).toBeNull();
      expect(screen.getByTestId("icon-book")).toBeTruthy();
      // The pre-load state never writes the record.
      expect(loadRecord("s1")).toEqual([
         { id: "files", label: "Files", ready: true },
         { id: "slot:a", label: "Notes", icon: "book", ready: true },
      ]);

      // The log is here: the real panel takes the frame, the zone never closed.
      rerender(<Harness state={loaded()} />);
      expect(screen.getByTestId("body-a")).toBeTruthy();
      expect(frames.every((f) => f.shown === "slot:a" && f.open === "rightBottom")).toBe(true);
      expect(loadRecord("s1")).toEqual([
         { id: "files", label: "Files", ready: true },
         { id: "slot:a", label: "Notes", icon: "book", ready: true },
      ]);
   });

   it("lets the real state decide after load: a gone panel closes its zone, the layout keeps it", () => {
      present = false;
      const { rerender } = render(<Harness state={initialState()} />);
      expect(frames[0]!.shown).toBe("slot:a");
      rerender(<Harness state={loaded()} />);
      const last = frames.at(-1)!;
      expect(last.shown).toBeNull();
      expect(last.open).toBe("rightBottom");
      expect(screen.queryByRole("region", { name: "Notes" })).toBeNull();
      expect(loadRecord("s1")).toEqual([{ id: "files", label: "Files", ready: true }]);
      expect(JSON.parse(localStorage.getItem("harness.chat.layout.s1")!).open.rightBottom).toBe(
         "slot:a",
      );
   });

   it("is neither read nor written by the Quick overlay", () => {
      const { rerender } = render(<Harness state={initialState()} overlay />);
      expect(frames[0]!.mounted).toEqual([]);
      present = false;
      rerender(<Harness state={loaded()} overlay />);
      expect(loadRecord("s1")).toHaveLength(2);
   });
});
