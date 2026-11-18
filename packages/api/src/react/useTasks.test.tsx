import { act, render } from "@testing-library/react";
import { expect, it } from "vitest";
import type { TaskSummary } from "../generated";
import { type TaskListSource, useTasks } from "./hooks";

it("drops a list that resolves after a newer one", async () => {
   const pending: ((l: TaskSummary[]) => void)[] = [];
   let changed: (ids: string[]) => void = () => {};
   const source: TaskListSource = {
      list: () => new Promise((resolve) => pending.push(resolve)),
      onChanged: async (f) => {
         changed = f;
         return () => {};
      },
   };
   let seen: TaskSummary[] | null = null;
   function View() {
      seen = useTasks(source);
      return null;
   }
   render(<View />);
   act(() => changed(["t1"]));
   expect(pending).toHaveLength(2);
   // The newer list comes first, the older one after it.
   await act(async () => pending[1]?.([{ id: "new" }] as TaskSummary[]));
   await act(async () => pending[0]?.([{ id: "old" }] as TaskSummary[]));
   expect((seen as TaskSummary[] | null)?.map((t) => t.id)).toEqual(["new"]);
});
