import type { Event, EventKind, SessionApi } from "@harness/api";
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { type ChatState, initialState } from "../../state/reducer";
import { reduceBatch } from "../renderUi/chatReducer";
import type { UiEnv } from "../renderUi/RenderUi";
import { MessageList, useRows } from "./MessageList";

afterEach(cleanup);

const EMPTY = "Send a message to start.";
const api = { sessionId: "s" } as unknown as SessionApi;
const ev = (seq: number, thread_id: string | null, kind: EventKind): Event => ({
   v: 1,
   seq,
   session_id: "s",
   thread_id,
   ts_ms: 0,
   kind,
});
/** How every Session Log starts. */
const created = [
   ev(0, null, {
      type: "SessionCreated",
      title: "t",
      frontend_id: "chat",
      agent_id: "a",
      folder: "/f",
   }),
   ev(1, "main", { type: "ThreadStarted", agent_id: "a", main: true }),
];

/** The Main Thread's list, wired like the chat view wires it. */
function List({ state }: { state: ChatState }) {
   const { ui, rows, subagents } = useRows(state.items, state.sharedAttached);
   return (
      <MessageList
         api={api}
         state={state}
         threadId="main"
         side={false}
         env={{} as UiEnv}
         ui={ui}
         rows={rows}
         subagents={subagents}
         onOpenDiff={() => {}}
         empty={state.loaded ? EMPTY : null}
      />
   );
}

it("shows nothing while the Session Log is not here yet", () => {
   const view = render(<List state={initialState()} />);
   expect(view.queryByText(EMPTY)).toBeNull();
});

it("shows the empty state for a Session with no messages", () => {
   const view = render(<List state={reduceBatch(initialState(), created)} />);
   expect(view.queryByText(EMPTY)).not.toBeNull();
});
