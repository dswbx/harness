import type { PrInfo, SessionApi } from "@harness/api";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { FileRefProvider } from "../files/FileRef";
import { PrRefProvider } from "../prRefs/prRefs";
import { Markdown } from "./Markdown";

afterEach(cleanup);

const pr = (number: number): PrInfo => ({
   repo: { owner: "dswbx", name: "harness" },
   number,
   title: `PR ${number}`,
   author: "me",
   state: "open",
   checks: "none",
   checks_passed: 0,
   checks_total: 0,
   additions: 1,
   deletions: 1,
   changed_files: 1,
   updated_at: "2026-01-01T00:00:00Z",
   url: `https://github.com/dswbx/harness/pull/${number}`,
});

const api = {
   prContext: async () => ({
      session_repo: { owner: "dswbx", name: "harness" },
      known_repos: [],
      me: null,
   }),
   lookupPrs: async (refs: { number: number }[]) => refs.map((r) => pr(r.number)),
   searchPrs: async () => [],
   readSessionFile: async (path: string) => ({ path, start: 1, lines: ["a", "b", "c"], total: 3 }),
   openInEditor: async () => {},
} as unknown as SessionApi;

/** Markdown inside both providers, as in a Session. */
const view = (text: string) =>
   render(
      <PrRefProvider api={api}>
         <FileRefProvider api={api}>
            <Markdown>{text}</Markdown>
         </FileRefProvider>
      </PrRefProvider>,
   );

/** A PR chip is a link marked `data-not-typeset` to the PR. */
const chips = (c: HTMLElement) => [...c.querySelectorAll<HTMLAnchorElement>("a[data-not-typeset]")];
const fileRefs = (c: HTMLElement) => [...c.querySelectorAll('span[role="button"]')];

describe("Markdown plugin order (PR refs, file refs, inline code)", () => {
   it("turns a PR ref in text into a chip", async () => {
      const { container } = view("Fixed in harness#7.");
      await waitFor(() => expect(chips(container)).toHaveLength(1));
      expect(chips(container)[0]!.href).toBe("https://github.com/dswbx/harness/pull/7");
   });

   it("keeps a PR ref inside a link and inside inline code as text", async () => {
      // The first paragraph is the one that turns into a chip: once it has, the rest was decided too.
      const { container } = view(
         "harness#7\n\n[see harness#8](https://example.com/x)\n\n`harness#9`",
      );
      await waitFor(() => expect(chips(container)).toHaveLength(1));
      expect(chips(container)[0]!.textContent).toBe("#7");
      const link = container.querySelector<HTMLAnchorElement>('a[href="https://example.com/x"]');
      expect(link?.textContent).toBe("see harness#8");
      expect(link?.querySelector("a")).toBeNull();
      const code = [...container.querySelectorAll("code")].find((c) =>
         c.textContent?.includes("harness#9"),
      );
      expect(code?.textContent).toBe("harness#9");
      expect(code?.closest("a")).toBeNull();
      expect(chips(container)).toHaveLength(1);
   });

   it("renders a file ref and plain inline code on one line", async () => {
      const { container } = view("Edit `src/a.ts:2` and `value` there.");
      await waitFor(() => expect(fileRefs(container)).toHaveLength(1));
      const ref = fileRefs(container)[0]!;
      expect(ref.querySelector("code")?.textContent).toBe("src/a.ts:2");
      const codes = [...container.querySelectorAll("code")];
      expect(codes.map((c) => c.textContent)).toEqual(["src/a.ts:2", "value"]);
      expect(codes[1]!.closest('span[role="button"]')).toBeNull();
   });

   it("a PR chip, a file ref and inline code all render in one line", async () => {
      const { container } = view("Fix harness#7 in `src/a.ts` and `foo(1)`.");
      await waitFor(() => {
         expect(chips(container)).toHaveLength(1);
         expect(fileRefs(container)).toHaveLength(1);
      });
      expect([...container.querySelectorAll("code")].map((c) => c.textContent)).toEqual([
         "src/a.ts",
         "foo(1)",
      ]);
   });

   it("without providers, refs stay plain text and inline code still renders", () => {
      const { container } = render(<Markdown>{"harness#7 and `src/a.ts`"}</Markdown>);
      expect(chips(container)).toHaveLength(0);
      expect(fileRefs(container)).toHaveLength(0);
      expect(container.textContent).toContain("harness#7 and src/a.ts");
      expect(container.querySelector("code")?.textContent).toBe("src/a.ts");
   });
});
