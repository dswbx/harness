import { type FileDrop, HarnessClient } from "@harness/api";
import { MockTransport } from "@harness/api/mock";
import { TooltipProvider } from "@harness/ui";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pickZone, registerDropTarget, registerDropZone } from "../prompt/fileDropTargets";
import { TaskDetail } from "./TaskDetail";

// Tauri delivers file drops to the window as paths and a point: stand in for that listener.
let send: ((e: FileDrop) => void) | null = null;
vi.mock("@harness/api", async (orig) => ({
   ...(await orig<typeof import("@harness/api")>()),
   onFileDrop: async (cb: (e: FileDrop) => void) => {
      send = cb;
      return () => {
         send = null;
      };
   },
}));

/** What `document.elementFromPoint` answers (happy-dom does no layout). */
let hit: Element | null = null;
beforeEach(() => {
   hit = null;
   document.elementFromPoint = () => hit;
});
afterEach(cleanup);

const fire = (e: FileDrop) => act(() => send?.(e));
const at = { x: 10, y: 10 };
const noop = () => {};

/** A prompt box (the Main Thread's) that takes every drop no zone takes. */
function promptBox() {
   const box = document.createElement("div");
   document.body.append(box);
   const t = { over: vi.fn(), drop: vi.fn() };
   const off = registerDropTarget({ el: () => box, region: () => null, main: true, ...t });
   return { ...t, off: () => (off(), box.remove()) };
}

describe("pickZone", () => {
   it("takes the innermost zone that holds the element under the pointer", () => {
      const outer = document.createElement("div");
      const inner = document.createElement("div");
      const leaf = document.createElement("span");
      outer.append(inner);
      inner.append(leaf);
      expect(pickZone([outer, inner], leaf)).toBe(1);
      expect(pickZone([inner, outer], leaf)).toBe(0);
      expect(pickZone([outer, inner], outer)).toBe(0);
      expect(pickZone([outer, null], document.body)).toBe(-1);
      expect(pickZone([outer], null)).toBe(-1);
   });
});

describe("window file drops", () => {
   it("go to the zone under the pointer, else to the prompt box", async () => {
      const prompt = promptBox();
      const zoneEl = document.createElement("div");
      const child = document.createElement("span");
      zoneEl.append(child);
      document.body.append(zoneEl);
      const zone = { over: vi.fn(), drop: vi.fn() };
      const off = registerDropZone({ el: () => zoneEl, ...zone });
      await waitFor(() => expect(send).not.toBeNull());

      hit = child;
      fire({ type: "over", position: at });
      expect(zone.over).toHaveBeenLastCalledWith(true);
      expect(prompt.over).toHaveBeenLastCalledWith(false);
      fire({ type: "drop", paths: ["/a.txt"], position: at });
      expect(zone.drop).toHaveBeenCalledWith(["/a.txt"]);
      expect(prompt.drop).not.toHaveBeenCalled();
      expect(zone.over).toHaveBeenLastCalledWith(false);

      hit = document.body;
      fire({ type: "over", position: at });
      expect(zone.over).toHaveBeenLastCalledWith(false);
      expect(prompt.over).toHaveBeenLastCalledWith(true);
      fire({ type: "drop", paths: ["/b.txt"], position: at });
      expect(prompt.drop).toHaveBeenCalledWith(["/b.txt"]);
      expect(zone.drop).toHaveBeenCalledTimes(1);

      off();
      prompt.off();
      zoneEl.remove();
      expect(send).toBeNull();
   });
});

async function renderTask() {
   const mock = new MockTransport([], []);
   const api = new HarnessClient(mock).sessionApi("mock-1");
   const add = vi.spyOn(api, "addTaskAssets");
   const tasks = await api.listTasks();
   render(
      <TooltipProvider>
         <TaskDetail api={api} id="t12" tasks={tasks} host={{}} onClose={noop} onOpen={noop} />
      </TooltipProvider>,
   );
   const zone = await waitFor(() => screen.getByRole("button", { name: "Add files" }));
   return { add, zone };
}

describe("task detail file drops", () => {
   it("a window drop over the task adds the paths to its assets; elsewhere it goes to the prompt", async () => {
      const prompt = promptBox();
      const { add, zone } = await renderTask();
      await waitFor(() => expect(send).not.toBeNull());

      hit = zone;
      fire({ type: "over", position: at });
      expect(zone.dataset.over).toBe("true");
      fire({ type: "drop", paths: ["/tmp/spec.pdf"], position: at });
      expect(zone.dataset.over).toBeUndefined();
      expect(add).toHaveBeenCalledWith("t12", [{ type: "path", path: "/tmp/spec.pdf" }]);
      expect(prompt.drop).not.toHaveBeenCalled();

      // Anywhere on the task counts, not only the zone.
      hit = screen.getByRole("textbox", { name: "Task title" });
      fire({ type: "drop", paths: ["/tmp/b.txt"], position: at });
      expect(add).toHaveBeenLastCalledWith("t12", [{ type: "path", path: "/tmp/b.txt" }]);

      hit = document.body;
      fire({ type: "drop", paths: ["/tmp/c.txt"], position: at });
      expect(prompt.drop).toHaveBeenCalledWith(["/tmp/c.txt"]);
      expect(add).toHaveBeenCalledTimes(2);
      prompt.off();
   });

   it("an HTML5 drop on the zone adds the files once", async () => {
      const { add, zone } = await renderTask();
      const file = new File(["hello"], "notes.txt", { type: "text/plain" });
      const dataTransfer = { files: [file], types: ["Files"] };
      fireEvent.dragEnter(zone, { dataTransfer });
      expect(zone.dataset.over).toBe("true");
      fireEvent.drop(zone, { dataTransfer });
      expect(zone.dataset.over).toBeUndefined();
      await waitFor(() => expect(add).toHaveBeenCalledTimes(1));
      expect(add.mock.calls[0]?.[1]).toEqual([
         expect.objectContaining({ type: "data", name: "notes.txt", mime: "text/plain" }),
      ]);
   });
});
