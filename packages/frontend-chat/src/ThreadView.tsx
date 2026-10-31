import { useEffect, useMemo, useRef } from "react";
import type { SessionApi } from "@harness/api";
import type { DiffScope } from "./DiffPanel";
import { MessageList, useRows } from "./Messages";
import { PromptBox, type PromptBoxHandle } from "./PromptBox";
import type { ChatState } from "./reducer";
import type { UiEnv } from "./RenderUi";

/** A Side Thread in the right panel: its messages (opening with how it started) and its own prompt box. */
export function ThreadView({ api, thread, threadId, env, onOpenDiff, focusKey }: {
  api: SessionApi;
  thread: ChatState;
  threadId: string;
  env: UiEnv;
  onOpenDiff: (s: DiffScope) => void;
  /** Changes when the prompt box should take focus (the chat was just created). */
  focusKey: number;
}) {
  const prompt = useRef<PromptBoxHandle>(null);
  const { ui, rows, subagents } = useRows(thread.items);
  const sideEnv = useMemo<UiEnv>(() => ({ ...env, send: (text) => api.prompt(text, [], threadId) }), [env, api, threadId]);
  useEffect(() => {
    if (focusKey) prompt.current?.focus();
  }, [focusKey]);

  return (
    <aside className="flex h-full w-full min-w-0 flex-col bg-background" aria-label="Side chat">
      <MessageList
        api={api}
        state={thread}
        threadId={threadId}
        side
        env={sideEnv}
        ui={ui}
        rows={rows}
        subagents={subagents}
        onOpenDiff={onOpenDiff}
        empty="Ask a question. The Main Thread never sees this."
      />
      <PromptBox ref={prompt} api={api} state={thread} threadId={threadId} />
    </aside>
  );
}
