import { act, render } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GIT_POLL_MS } from "../client/gitStatusStore";
import { useGitStatus } from "./hooks";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("under StrictMode a refreshKey change loads once on the store the view reads, with one timer", async () => {
   let calls = 0;
   const api = {
      sessionId: "strict",
      workspace: async () => ({ repo_root: "/r" }) as never,
      gitStatus: async () => {
         calls++;
         return { branch: `b${calls}`, ahead: 0, behind: 0, files: [] } as never;
      },
   };
   let seen = "";
   function View({ k }: { k: number }) {
      seen = useGitStatus(api, { refreshKey: k }).status?.branch ?? "";
      return null;
   }
   const r = render(
      <StrictMode>
         <View k={0} />
      </StrictMode>,
   );
   await act(() => vi.advanceTimersByTimeAsync(0));
   expect(vi.getTimerCount()).toBe(1);
   calls = 0;
   r.rerender(
      <StrictMode>
         <View k={1} />
      </StrictMode>,
   );
   await act(() => vi.advanceTimersByTimeAsync(0));
   expect(calls).toBe(1);
   expect(seen).toBe("b1");
   await act(() => vi.advanceTimersByTimeAsync(GIT_POLL_MS));
   expect(calls).toBe(2);
   r.unmount();
   expect(vi.getTimerCount()).toBe(0);
});

it("a view mounting on a store that already has a status counts no change", async () => {
   let branch = "a";
   const api = {
      sessionId: "late",
      workspace: async () => ({ repo_root: "/r" }) as never,
      gitStatus: async () => ({ branch, ahead: 0, behind: 0, files: [] }) as never,
   };
   let first = -1;
   let second = -1;
   const A = () => ((first = useGitStatus(api).changes), null);
   const B = () => ((second = useGitStatus(api).changes), null);
   const r = render(<A />);
   await act(() => vi.advanceTimersByTimeAsync(0));
   branch = "b";
   r.rerender(
      <>
         <A />
         <B />
      </>,
   );
   await act(() => vi.advanceTimersByTimeAsync(0));
   expect(first).toBe(1);
   expect(second).toBe(0);
});
