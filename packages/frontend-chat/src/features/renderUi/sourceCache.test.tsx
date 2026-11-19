import type { SharedArtifactData } from "@harness/api";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSharedArtifact } from "./sharedSource";
import { usePanelSource } from "./source";

afterEach(cleanup);

const settle = () => act(async () => {});
const file = (content: string) => ({ content, hash: `h:${content}`, mtime_ms: 0 });

/** A Session's panel files: `write` changes one and tells the watchers, as the core does. */
function session(scope: string, files: Record<string, string>) {
   const watchers = new Set<(name: string) => void>();
   const readSource = vi.fn(async (name: string) => {
      const content = files[name];
      if (content === undefined) throw new Error("missing");
      return file(content);
   });
   const env = {
      scope,
      readSource,
      watchSources: async (on: (name: string) => void) => {
         watchers.add(on);
         return () => void watchers.delete(on);
      },
   };
   const write = (name: string, content?: string) => {
      if (content === undefined) delete files[name];
      else files[name] = content;
      for (const w of watchers) w(name);
   };
   return { env, write, readSource };
}

describe("usePanelSource cache (rows the virtual list remounts)", () => {
   it("shows the last read at once on a remount, then what the file holds now", async () => {
      const s = session("s1", { "a.md": "one" });
      const first = renderHook(() => usePanelSource(s.env, "a.md"));
      expect(first.result.current).toBeNull();
      await settle();
      expect(first.result.current).toMatchObject({ content: "one" });
      first.unmount();

      // Changed while no row showed it: the old content for the first frame, not a placeholder.
      s.write("a.md", "two");
      const again = renderHook(() => usePanelSource(s.env, "a.md"));
      expect(again.result.current).toMatchObject({ content: "one" });
      await settle();
      expect(again.result.current).toMatchObject({ content: "two" });
   });

   it("follows a change of the file while shown, and a later mount starts from it", async () => {
      const s = session("s2", { "a.md": "one" });
      const view = renderHook(() => usePanelSource(s.env, "a.md"));
      await settle();
      s.write("a.md", "two");
      await settle();
      expect(view.result.current).toMatchObject({ content: "two" });
      view.unmount();
      expect(renderHook(() => usePanelSource(s.env, "a.md")).result.current).toMatchObject({
         content: "two",
      });
   });

   it("keeps Sessions apart: the same file name in another Session starts empty", async () => {
      const a = session("s3", { "plan.md": "A's plan" });
      const b = session("s4", { "plan.md": "B's plan" });
      renderHook(() => usePanelSource(a.env, "plan.md"));
      await settle();
      const other = renderHook(() => usePanelSource(b.env, "plan.md"));
      expect(other.result.current).toBeNull();
      await settle();
      expect(other.result.current).toMatchObject({ content: "B's plan" });
   });

   it("forgets a file that is gone", async () => {
      const s = session("s5", { "a.md": "one" });
      const view = renderHook(() => usePanelSource(s.env, "a.md"));
      await settle();
      s.write("a.md", undefined);
      await settle();
      expect(view.result.current).toEqual({ missing: true });
      view.unmount();
      expect(renderHook(() => usePanelSource(s.env, "a.md")).result.current).toBeNull();
   });
});

describe("useSharedArtifact cache", () => {
   const artifact = (content: string) =>
      ({
         content,
         hash: `h:${content}`,
         state: {},
         meta: { kind: "md" },
         dir: "/d",
      }) as unknown as SharedArtifactData;

   it("shows the last read at once on a remount, then a change made meanwhile", async () => {
      let content = "one";
      const read = vi.fn(async () => artifact(content));
      const first = renderHook(() => useSharedArtifact("art-1", read, undefined));
      expect(first.result.current).toBeNull();
      await settle();
      const shown = first.result.current;
      expect(shown).toMatchObject({ data: { content: "one" } });
      first.unmount();

      const again = renderHook(() => useSharedArtifact("art-1", read, undefined));
      // The same object: an Html frame keeps its document.
      expect(again.result.current).toBe(shown);
      content = "two";
      window.dispatchEvent(new Event("focus"));
      await settle();
      expect(again.result.current).toMatchObject({ data: { content: "two" } });
   });

   it("forgets an artifact that is gone, and does not show another one's content", async () => {
      const read = vi.fn(async (id: string) => {
         if (id === "art-gone") throw new Error("missing");
         return artifact(id);
      });
      const gone = renderHook(() => useSharedArtifact("art-gone", read, undefined));
      await settle();
      expect(gone.result.current).toEqual({ missing: true });
      gone.unmount();
      expect(
         renderHook(() => useSharedArtifact("art-gone", read, undefined)).result.current,
      ).toBeNull();

      const view = renderHook(({ id }) => useSharedArtifact(id, read, undefined), {
         initialProps: { id: "art-2" },
      });
      await settle();
      view.rerender({ id: "art-3" });
      expect(view.result.current).toBeNull();
      await settle();
      expect(view.result.current).toMatchObject({ data: { content: "art-3" } });
   });
});
