import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useLineComments } from "./useLineComments";

afterEach(cleanup);

describe("useLineComments", () => {
   it("has no comments and subscribes to nothing without a Session (Folder Diff)", () => {
      const { result, rerender } = renderHook(() => useLineComments(undefined));
      expect(result.current).toEqual([]);
      const first = result.current;
      rerender();
      expect(result.current).toBe(first);
   });
});
