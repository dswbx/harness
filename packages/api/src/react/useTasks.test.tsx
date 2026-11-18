import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { HarnessClient } from "../client/app";
import { createTaskStore } from "../client/taskStore";
import type { TaskSummary } from "../generated";
import { MockTransport } from "../mock/mock";
import { useTasks } from "./hooks";

afterEach(cleanup);

const task = (id: string, title = id) => ({ id, title }) as TaskSummary;
const ids = (l: TaskSummary[] | null) => l?.map((t) => t.id);

/** A store over a fake source: each `list()` waits for `resolve`; `change` sends a `TasksChanged`. */
function fake() {
   const pending: ((l: TaskSummary[]) => void)[] = [];
   const list = vi.fn(() => new Promise<TaskSummary[]>((resolve) => pending.push(resolve)));
   let change: (ids: string[], tasks: TaskSummary[]) => void = () => {};
   const off = vi.fn();
   const onChanged = vi.fn(async (f: typeof change) => {
      change = f;
      return off;
   });
   const store = createTaskStore({ list, onChanged });
   const seen: (TaskSummary[] | null)[] = [];
   function View({ at }: { at: number }) {
      seen[at] = useTasks({ taskStore: store });
      return null;
   }
   return {
      list,
      onChanged,
      off,
      pending,
      seen,
      View,
      change: (ids: string[], tasks: TaskSummary[]) => act(() => change(ids, tasks)),
   };
}

it("shares one load and one subscription between hooks", async () => {
   const f = fake();
   render(
      <>
         <f.View at={0} />
         <f.View at={1} />
      </>,
   );
   expect(f.list).toHaveBeenCalledTimes(1);
   expect(f.onChanged).toHaveBeenCalledTimes(1);
   await act(async () => f.pending[0]?.([task("t1")]));
   expect(ids(f.seen[0] ?? null)).toEqual(["t1"]);
   expect(f.seen[1]).toBe(f.seen[0]);
});

it("patches the list from TasksChanged without reloading", async () => {
   const f = fake();
   render(<f.View at={0} />);
   await act(async () => f.pending[0]?.([task("t1"), task("t2"), task("t3")]));
   f.change(["t2"], [task("t2", "renamed")]);
   expect(f.seen[0]?.map((t) => t.title)).toEqual(["t1", "renamed", "t3"]);
   // t3 deleted, its child t11 moved; t10 is new and goes in id order.
   f.change(["t3", "t11", "t10"], [task("t11"), task("t10")]);
   expect(ids(f.seen[0] ?? null)).toEqual(["t1", "t2", "t10", "t11"]);
   expect(f.list).toHaveBeenCalledTimes(1);
});

it("applies changes seen during the load on top of it", async () => {
   const f = fake();
   render(<f.View at={0} />);
   f.change(["t2"], [task("t2")]);
   f.change(["t1"], []);
   expect(f.list).toHaveBeenCalledTimes(1);
   await act(async () => f.pending[0]?.([task("t1")]));
   expect(ids(f.seen[0] ?? null)).toEqual(["t2"]);
});

it("stops when the last hook goes and loads again for the next", async () => {
   const f = fake();
   const a = render(<f.View at={0} />);
   const b = render(<f.View at={1} />);
   await act(async () => f.pending[0]?.([task("t1")]));
   a.unmount();
   expect(f.off).not.toHaveBeenCalled();
   b.unmount();
   await act(async () => {});
   expect(f.off).toHaveBeenCalledTimes(1);
   render(<f.View at={2} />);
   expect(f.seen[2]).toBeNull();
   expect(f.list).toHaveBeenCalledTimes(2);
   expect(f.onChanged).toHaveBeenCalledTimes(2);
});

it("drops a list that resolves after a newer one", async () => {
   const f = fake();
   render(<f.View at={0} />).unmount();
   render(<f.View at={1} />);
   expect(f.pending).toHaveLength(2);
   // The newer list comes first, the older one after it.
   await act(async () => f.pending[1]?.([task("new")]));
   await act(async () => f.pending[0]?.([task("old")]));
   expect(ids(f.seen[1] ?? null)).toEqual(["new"]);
});

it("loads again on a change after a failed load", async () => {
   const f = fake();
   const error = vi.spyOn(console, "error").mockImplementation(() => {});
   f.list.mockImplementationOnce(() => Promise.reject(new Error("down")));
   render(<f.View at={0} />);
   await act(async () => {});
   expect(error).toHaveBeenCalled();
   f.change(["t1"], [task("t1")]);
   expect(f.list).toHaveBeenCalledTimes(2);
   await act(async () => f.pending[0]?.([task("t1")]));
   expect(ids(f.seen[0] ?? null)).toEqual(["t1"]);
   error.mockRestore();
});

it("is one store per transport, for the app and every Session", () => {
   const mock = new MockTransport([], []);
   const client = new HarnessClient(mock);
   expect(client.sessionApi("a").taskStore).toBe(client.taskStore);
   expect(new HarnessClient(mock).sessionApi("b").taskStore).toBe(client.taskStore);
   expect(new HarnessClient(new MockTransport([], [])).taskStore).not.toBe(client.taskStore);
});

it("follows the mock's TasksChanged deltas", async () => {
   const mock = new MockTransport([], []);
   const client = new HarnessClient(mock);
   let seen: TaskSummary[] | null = null;
   function View() {
      seen = useTasks(client);
      return null;
   }
   render(<View />);
   await act(async () => {});
   const list = vi.spyOn(mock, "execute");
   const a = await act(() => client.createTask({ title: "A" }));
   const b = await act(() => client.createTask({ title: "B", parentId: a.id }));
   await act(() => client.updateTask(b.id, { title: "B2" }));
   await act(() => client.deleteTask(a.id));
   expect(list.mock.calls.filter(([c]) => c.type === "ListTasks")).toHaveLength(0);
   const current = seen as TaskSummary[] | null;
   expect(current?.find((t) => t.id === b.id)).toMatchObject({ title: "B2", parent_id: null });
   expect(current?.some((t) => t.id === a.id)).toBe(false);
   expect(current).toEqual(await client.listTasks());
});
