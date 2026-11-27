import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliRequest } from "../platform/generated";
import { type CliHost, useCliRequests } from "./useCliRequests";

afterEach(cleanup);

/** A host with a queue, like `cli.rs`: `take` drains it, `poke` fires the listener. */
function fakeHost(queued: CliRequest[]) {
   const queue = [...queued];
   let poke = () => {};
   const off = vi.fn();
   const host: CliHost = {
      take: vi.fn(async () => queue.splice(0)),
      listen: (onPoke, onListening) => {
         poke = onPoke;
         onListening();
         return off;
      },
   };
   return { host, queue, poke: () => poke(), off };
}

describe("useCliRequests", () => {
   it("takes what was queued before mount, then each poke's requests, in order", async () => {
      const f = fakeHost([{ kind: "diff", folder: "/repo/a" }]);
      const seen: CliRequest[] = [];
      const { unmount } = renderHook(() => useCliRequests((r) => seen.push(r), f.host));
      await waitFor(() => expect(seen).toEqual([{ kind: "diff", folder: "/repo/a" }]));
      f.queue.push({ kind: "new", folder: "/repo/b" }, { kind: "diff", folder: "/repo/c" });
      f.poke();
      await waitFor(() => expect(seen).toHaveLength(3));
      expect(seen.slice(1)).toEqual([
         { kind: "new", folder: "/repo/b" },
         { kind: "diff", folder: "/repo/c" },
      ]);
      unmount();
      expect(f.off).toHaveBeenCalled();
   });

   it("uses the latest handler", async () => {
      const f = fakeHost([]);
      const first = vi.fn();
      const second = vi.fn();
      const { rerender } = renderHook(({ on }) => useCliRequests(on, f.host), {
         initialProps: { on: first },
      });
      rerender({ on: second });
      f.queue.push({ kind: "new", folder: "/repo" });
      f.poke();
      await waitFor(() => expect(second).toHaveBeenCalledWith({ kind: "new", folder: "/repo" }));
      expect(first).not.toHaveBeenCalled();
   });
});
