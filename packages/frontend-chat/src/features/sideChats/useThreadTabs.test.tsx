import { act, cleanup, renderHook } from "@testing-library/react";
import { useState } from "react";
import { flushSync } from "react-dom";
import { afterEach, describe, expect, test } from "vitest";
import { openThread, useThreadTabs } from "./threadTabs";

afterEach(cleanup);

describe("useThreadTabs", () => {
   test("two applies with a re-render in between keep both changes", () => {
      const { result, rerender } = renderHook(() => useThreadTabs("s1", false));
      act(() => {
         result.current.apply((t) => openThread(t, "a"));
      });
      rerender();
      act(() => {
         result.current.apply((t) => openThread(t, "b"));
      });
      expect(result.current.tabs.threads).toEqual(["a", "b"]);
   });
   test("an urgent render between two applies (skipping the first) does not hide it from the second", () => {
      const { result } = renderHook(() => {
         const [, setN] = useState(0);
         return { ...useThreadTabs("s1", false), setN };
      });
      act(() => {
         result.current.apply((t) => openThread(t, "a"));
         flushSync(() => result.current.setN(1));
         result.current.apply((t) => openThread(t, "b"));
      });
      expect(result.current.tabs.threads).toEqual(["a", "b"]);
   });
});
