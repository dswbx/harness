import type { Event, SessionApi } from "@harness/api";
import { TooltipProvider } from "@harness/ui";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ChatState, initialState } from "../../state/reducer";
import { syntheticLog } from "../../state/syntheticLog";
import { reduceBatch } from "../renderUi/chatReducer";
import type { UiEnv } from "../renderUi/RenderUi";
import { useRows } from "./MessageList";
import { Row } from "./Row";

// Counts what a row costs: every `<Markdown>` render is a parse of its text.
const renders = vi.hoisted(() => ({ n: 0 }));
vi.mock("../markdown/Markdown", () => ({
   Markdown: () => {
      renders.n++;
      return null;
   },
}));

afterEach(cleanup);

const VISIBLE = 25;
const api = { sessionId: "s" } as unknown as SessionApi;
const env = {} as UiEnv;
const noop = () => {};

const chunk = (seq: number): Event => ({
   v: 1,
   seq,
   session_id: "s",
   thread_id: "main",
   ts_ms: 0,
   kind: { type: "AgentMessageChunk", text: "more words " },
});

/** The visible rows of a Thread, wired like `MessageList` wires them. */
function Rows({ state }: { state: ChatState }) {
   const { ui, rows, subagents } = useRows(state.items, state.sharedAttached);
   const shown = rows.slice(-VISIBLE);
   return (
      <>
         {shown.map((r, i) => (
            <Row
               key={r.id}
               item={r}
               api={api}
               env={env}
               view={ui.inline.get(r.id)}
               onOpenDiff={noop}
               subagents={subagents}
               active
               streaming={i === shown.length - 1}
               threadId="main"
               side={false}
            />
         ))}
      </>
   );
}

describe("rendering one streamed chunk in a long Session", () => {
   it("re-renders only the row that changed", () => {
      let state = reduceBatch(initialState(), [...syntheticLog(), chunk(30_000)]);
      const ui = render(
         <TooltipProvider>
            <Rows state={state} />
         </TooltipProvider>,
      );
      const first = renders.n;
      let spent = 0;
      let worst = 0;
      for (let i = 0; i < 10; i++) {
         renders.n = 0;
         state = reduceBatch(state, [chunk(30_001 + i)]);
         const t0 = performance.now();
         act(() =>
            ui.rerender(
               <TooltipProvider>
                  <Rows state={state} />
               </TooltipProvider>,
            ),
         );
         spent += performance.now() - t0;
         worst = Math.max(worst, renders.n);
      }
      console.log(
         `stream chunk: ${first} message renders for the first paint of ${VISIBLE} rows, ` +
            `then at most ${worst} per chunk, ${(spent / 10).toFixed(2)} ms per commit`,
      );
      expect(worst).toBeLessThanOrEqual(1);
   });
});
