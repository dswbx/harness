import type { HarnessClient } from "@harness/api";
import { TooltipProvider } from "@harness/ui";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppearancePanel } from "./AppearancePanel";

const mem = new Map<string, string>();
beforeEach(() => {
   mem.clear();
   vi.stubGlobal("localStorage", {
      get length() {
         return mem.size;
      },
      key: (i: number) => [...mem.keys()][i] ?? null,
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
   });
});
afterEach(cleanup);

const mount = () =>
   render(
      <TooltipProvider>
         <AppearancePanel client={{} as HarnessClient} />
      </TooltipProvider>,
   );

describe("Windows > Reopen panel windows on launch", () => {
   it("is on by default and toggles the stored setting", () => {
      mount();
      const sw = screen.getByRole("switch", { name: /Panel windows/ });
      expect(sw.getAttribute("aria-checked")).toBe("true");
      fireEvent.click(sw);
      expect(mem.get("harness.panelWindows.reopen")).toBe("off");
      expect(sw.getAttribute("aria-checked")).toBe("false");
      fireEvent.click(sw);
      expect(mem.get("harness.panelWindows.reopen")).toBe("on");
      expect(sw.getAttribute("aria-checked")).toBe("true");
   });

   it("follows a change from another window", () => {
      mount();
      const sw = screen.getByRole("switch", { name: /Panel windows/ });
      act(() => {
         mem.set("harness.panelWindows.reopen", "off");
         window.dispatchEvent(new StorageEvent("storage", { key: "harness.panelWindows.reopen" }));
      });
      expect(sw.getAttribute("aria-checked")).toBe("false");
   });
});
