import type { SessionApi } from "@harness/api";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { Item } from "../../state/reducer";
import { FileRefProvider } from "../files/FileRef";
import { PrRefProvider } from "../prRefs/prRefs";
import { useReferences } from "./ReferencesPanel";

const items: Item[] = [
   {
      type: "user",
      id: "u1",
      text: "See `src/a.ts:12-20`.",
      ts: 0,
      attachments: [],
      context: null,
      from: null,
   },
];

function setup() {
   const readSessionFile = vi.fn(async (path: string, from: number) => ({
      path,
      start: from,
      lines: ["a", "b"],
      total: 40,
   }));
   const api = {
      readSessionFile,
      openInEditor: vi.fn(),
      prContext: () => new Promise(() => {}),
      lookupPrs: vi.fn(),
      searchPrs: vi.fn(),
   } as unknown as SessionApi;
   const wrapper = ({ children }: { children: ReactNode }) => (
      <PrRefProvider api={api}>
         <FileRefProvider api={api}>{children}</FileRefProvider>
      </PrRefProvider>
   );
   return { readSessionFile, wrapper };
}

describe("useReferences", () => {
   it("looks nothing up, and has no count, before the panel was opened", () => {
      const { readSessionFile, wrapper } = setup();
      const { result } = renderHook(() => useReferences(items, false), { wrapper });
      expect(readSessionFile).not.toHaveBeenCalled();
      expect(result.current.count).toBeUndefined();
      expect(result.current.refs).toEqual([]);
   });

   it("looks each reference up once it was opened, then counts what exists", async () => {
      const { readSessionFile, wrapper } = setup();
      const { result, rerender } = renderHook(({ on }) => useReferences(items, on), {
         wrapper,
         initialProps: { on: false },
      });
      expect(readSessionFile).not.toHaveBeenCalled();
      rerender({ on: true });
      await waitFor(() => expect(result.current.count).toBe(1));
      expect(readSessionFile).toHaveBeenCalledTimes(1);
      expect(readSessionFile.mock.calls[0]![0]).toBe("src/a.ts");
      expect(result.current.refs).toHaveLength(1);
      // Opened once, the lookups are not repeated by later renders.
      rerender({ on: true });
      expect(readSessionFile).toHaveBeenCalledTimes(1);
   });
});
