import type { SessionApi } from "@harness/api";
import { describe, expect, it } from "vitest";
import type { Item } from "../../state/reducer";
import type { UiEnv } from "../renderUi/RenderUi";
import { type ChatSubagent, groupTools, type Tool } from "../toolDisplay/group";
import { sameRow } from "./Row";

const tool = (id: string, over: Partial<Tool> = {}): Tool => ({
   type: "tool",
   id,
   title: id,
   kind: null,
   status: "completed",
   content: [],
   locations: null,
   rawInput: null,
   rawOutput: null,
   parent: null,
   background: false,
   report: null,
   harnessTool: null,
   subagentPrompt: null,
   subagentMeta: null,
   ts: 0,
   endedAt: null,
   commitMessage: null,
   ...over,
});
const sub = (steps: Item[]): ChatSubagent => ({ calls: [], steps, report: null, endedAt: null });

type Props = Parameters<typeof sameRow>[0];
const base = (over: Partial<Props> = {}): Props => ({
   item: groupTools([tool("t1"), tool("task")])[0]!,
   api: {} as SessionApi,
   env: {} as UiEnv,
   onOpenDiff: () => {},
   subagents: new Map(),
   active: true,
   threadId: "main",
   side: false,
   ...over,
});

describe("sameRow", () => {
   it("equal props are the same, also with a new but equal view wrapper", () => {
      const root = { type: "Text" } as never;
      const files = {};
      expect(sameRow(base(), base())).toBe(false); // other item objects
      const a = base({ view: { root, files } });
      expect(sameRow(a, { ...a, view: { root, files } })).toBe(true);
      expect(sameRow(a, { ...a })).toBe(true);
   });

   it("a changed view root or files re-renders", () => {
      const root = { type: "Text" } as never;
      const a = base({ view: { root, files: {} } });
      expect(sameRow(a, { ...a, view: { root: { type: "Text" } as never, files: {} } })).toBe(
         false,
      );
      expect(sameRow(a, { ...a, view: { root, files: {} } })).toBe(false);
      expect(sameRow(a, { ...a, view: null })).toBe(false);
   });

   it("a changed prop re-renders, also one present only in the new props", () => {
      const a = base();
      expect(sameRow(a, { ...a, active: false })).toBe(false);
      expect(sameRow(a, { ...a, streaming: true })).toBe(false);
      expect(sameRow(a, { ...a, extra: 1 } as Props)).toBe(false);
      expect(sameRow({ ...a, extra: 1 } as Props, a)).toBe(false);
   });

   it("a status change inside a group is another group, so it re-renders", () => {
      const a = base();
      const next = groupTools([tool("t1", { status: "failed" }), tool("task")])[0]!;
      expect(sameRow(a, { ...a, item: next })).toBe(false);
   });

   it("a subagent shown by the row re-renders it, a nested one too, an unrelated one does not", () => {
      const inner = tool("inner");
      const innerSub = sub([]);
      const taskSub = sub([inner]);
      const other = sub([]);
      const subs = new Map([
         ["task", taskSub],
         ["inner", innerSub],
         ["other", other],
      ]);
      const a = base({ subagents: subs });
      // Unrelated subagent changes.
      expect(sameRow(a, { ...a, subagents: new Map(subs).set("other", sub([])) })).toBe(true);
      // The row's own subagent changes.
      expect(sameRow(a, { ...a, subagents: new Map(subs).set("task", sub([inner])) })).toBe(false);
      // A child of a shown subagent changes: its own entry, with the parent's steps the same.
      expect(sameRow(a, { ...a, subagents: new Map(subs).set("inner", sub([])) })).toBe(false);
      // Same map: equal.
      expect(sameRow(a, { ...a })).toBe(true);
   });
});
