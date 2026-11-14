import { act, renderHook } from "@testing-library/react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type DropTarget, targetAt, usePanelDrag } from "./panelDrag";

let zoneEl: HTMLElement;
let under: Element[];
beforeEach(() => {
   document.body.innerHTML = "";
   zoneEl = document.createElement("div");
   zoneEl.dataset.dropZone = "rightTop";
   document.body.append(zoneEl);
   under = [zoneEl];
   document.elementsFromPoint = () => under;
});
afterEach(() => {
   document.body.style.cssText = "";
});

const press = (over: Partial<{ button: number; clientX: number; clientY: number }> = {}) => {
   const el = document.createElement("button");
   document.body.append(el);
   return {
      button: 0,
      clientX: 100,
      clientY: 100,
      pointerId: 1,
      currentTarget: el,
      preventDefault: vi.fn(),
      ...over,
   } as unknown as ReactPointerEvent;
};
const fire = (type: string, init: MouseEventInit = {}) =>
   act(() => {
      window.dispatchEvent(new MouseEvent(type, init));
   });
const move = (x: number, y: number) => fire("pointermove", { clientX: x, clientY: y });

function setup() {
   const onDrop = vi.fn<(id: string, t: DropTarget) => void>();
   const hook = renderHook(() => usePanelDrag(onDrop as never));
   const start = (e = press()) => act(() => hook.result.current.start("files", "Files", e));
   return { onDrop, hook, start };
}

describe("usePanelDrag", () => {
   it("ignores a press with a button other than the primary", () => {
      const { onDrop, hook, start } = setup();
      const e = press({ button: 2 });
      start(e);
      move(200, 200);
      fire("pointerup");
      expect(e.preventDefault).not.toHaveBeenCalled();
      expect(hook.result.current.drag).toBeNull();
      expect(onDrop).not.toHaveBeenCalled();
   });

   it("a move under 4px is not a drag: nothing shown, no drop, no cursor", () => {
      const { onDrop, hook, start } = setup();
      start();
      move(102, 102);
      expect(hook.result.current.drag).toBeNull();
      expect(document.body.style.cursor).toBe("");
      fire("pointerup");
      expect(onDrop).not.toHaveBeenCalled();
   });

   it("passing the threshold starts the drag with the target under the pointer", () => {
      const { hook, start } = setup();
      start();
      move(110, 100);
      expect(hook.result.current.drag).toEqual({
         id: "files",
         label: "Files",
         x: 110,
         y: 100,
         target: { zone: "rightTop", index: null },
      });
      expect(document.body.style.cursor).toBe("grabbing");
      expect(document.body.style.userSelect).toBe("none");
   });

   it("a normal drop commits once and cleans up", () => {
      const { onDrop, hook, start } = setup();
      start();
      move(120, 100);
      fire("pointerup");
      expect(onDrop).toHaveBeenCalledTimes(1);
      expect(onDrop).toHaveBeenCalledWith("files", { zone: "rightTop", index: null });
      expect(hook.result.current.drag).toBeNull();
      expect(document.body.style.cursor).toBe("");
      expect(document.body.style.userSelect).toBe("");
      // Further events do nothing: the listeners are gone.
      fire("pointerup");
      move(300, 300);
      expect(onDrop).toHaveBeenCalledTimes(1);
      expect(hook.result.current.drag).toBeNull();
   });

   it("a drop over no zone does not commit", () => {
      const { onDrop, hook, start } = setup();
      under = [];
      start();
      move(120, 100);
      fire("pointerup");
      expect(onDrop).not.toHaveBeenCalled();
      expect(hook.result.current.drag).toBeNull();
   });

   it("Escape cancels: no drop, even on the release that follows", () => {
      const { onDrop, hook, start } = setup();
      start();
      move(120, 100);
      const key = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
      act(() => {
         window.dispatchEvent(key);
      });
      expect(key.defaultPrevented).toBe(true);
      expect(hook.result.current.drag).toBeNull();
      expect(document.body.style.cursor).toBe("");
      fire("pointerup");
      expect(onDrop).not.toHaveBeenCalled();
   });

   it("another key does not cancel", () => {
      const { onDrop, hook, start } = setup();
      start();
      move(120, 100);
      act(() => {
         window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
      });
      expect(hook.result.current.drag).not.toBeNull();
      fire("pointerup");
      expect(onDrop).toHaveBeenCalledTimes(1);
   });

   it("the window losing focus cancels", () => {
      const { onDrop, hook, start } = setup();
      start();
      move(120, 100);
      fire("blur");
      expect(hook.result.current.drag).toBeNull();
      fire("pointerup");
      expect(onDrop).not.toHaveBeenCalled();
   });

   it("pointercancel cancels", () => {
      const { onDrop, hook, start } = setup();
      start();
      move(120, 100);
      fire("pointercancel");
      expect(hook.result.current.drag).toBeNull();
      expect(onDrop).not.toHaveBeenCalled();
   });

   it("the click that ends a drag is swallowed once, then clicks work again", async () => {
      const { start } = setup();
      const seen = vi.fn();
      document.body.addEventListener("click", seen);
      start();
      move(120, 100);
      fire("pointerup");
      act(() => {
         document.body.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      });
      expect(seen).not.toHaveBeenCalled();
      await new Promise((r) => setTimeout(r, 5));
      act(() => {
         document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      expect(seen).toHaveBeenCalledTimes(1);
   });

   it("a press that never became a drag swallows nothing", () => {
      const { start } = setup();
      const seen = vi.fn();
      document.body.addEventListener("click", seen);
      start();
      fire("pointerup");
      act(() => {
         document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      expect(seen).toHaveBeenCalledTimes(1);
   });

   it("unmounting during a drag cancels it", () => {
      const { onDrop, hook, start } = setup();
      start();
      move(120, 100);
      hook.unmount();
      fire("pointerup");
      expect(onDrop).not.toHaveBeenCalled();
      expect(document.body.style.cursor).toBe("");
   });

   it("calls the latest onDrop", () => {
      const first = vi.fn();
      const second = vi.fn();
      const hook = renderHook(({ f }) => usePanelDrag(f), { initialProps: { f: first } });
      act(() => hook.result.current.start("files", "Files", press()));
      move(120, 100);
      hook.rerender({ f: second });
      fire("pointerup");
      expect(first).not.toHaveBeenCalled();
      expect(second).toHaveBeenCalledTimes(1);
   });
});

describe("targetAt", () => {
   it("is null over no drop zone", () => {
      under = [document.createElement("div")];
      expect(targetAt(1, 1)).toBeNull();
   });

   it("takes the insert index from the stripe icon under the pointer: after it when below its middle", () => {
      const icon = document.createElement("button");
      icon.dataset.dropIndex = "2";
      zoneEl.append(icon);
      icon.getBoundingClientRect = () => ({ top: 100, height: 40 }) as DOMRect;
      under = [icon, zoneEl];
      expect(targetAt(5, 110)).toEqual({ zone: "rightTop", index: 2 });
      expect(targetAt(5, 130)).toEqual({ zone: "rightTop", index: 3 });
   });

   it("ignores an index element outside the zone", () => {
      const stray = document.createElement("button");
      stray.dataset.dropIndex = "1";
      document.body.append(stray);
      under = [stray, zoneEl];
      expect(targetAt(5, 5)).toEqual({ zone: "rightTop", index: null });
   });
});
