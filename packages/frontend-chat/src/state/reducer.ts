import type { Event, EventKind } from "@harness/api";
import { type Ctx, initialState, newCtx, sideCtx } from "./draft";
import { agentSlice, endSideJobs } from "./slices/agent";
import { configSlice } from "./slices/config";
import { plansSlice } from "./slices/plans";
import { adoptMainThread, sessionLevel, sessionSlice, trackThreadList } from "./slices/session";
import { timelineSlice } from "./slices/timeline";
import { turnSlice } from "./slices/turn";
import type { ChatState, ContentBlock, ToolCallRef, ToolDecoder } from "./types";

/** Chat state is a pure fold over the Session Log: replay and live share this one path. */

export type {
   BackgroundJobInfo,
   ChatState,
   ConfigOption,
   ContentBlock,
   Item,
   PlanEntry,
   SubagentMeta,
   ToolCallRef,
   ToolDecoder,
} from "./types";
export { initialState };

/**
 * The reducer, with the Frontend's decoder for Frontend Tool inputs (`render_ui`) injected, so this
 * file does not import `features/`. The app's instance is `features/renderUi/chatReducer.ts`.
 */
export function createReducer({ decodeTool }: { decodeTool: ToolDecoder }) {
   /**
    * Folds many Events at once (replay, per-frame batches). Same result as folding one by one,
    * but copies `items` at most once and looks tool calls up through an index.
    */
   function reduceBatch(state: ChatState, events: readonly Event[]): ChatState {
      if (events.length === 0) return state;
      const c = newCtx({ ...state, loaded: true }, decodeTool);
      for (const e of events) apply(c, e);
      return c.d;
   }
   /** Folds one Event. Pure from the caller's view: never mutates `state`. */
   const reduce = (state: ChatState, e: Event): ChatState => reduceBatch(state, [e]);
   return { init: initialState, reduce, reduceBatch };
}

type Slice = (c: Ctx, e: Event) => void;

const T = [timelineSlice];
const A = [agentSlice];
const NONE: readonly Slice[] = [];

/**
 * Which slices fold each Event kind into a Thread's state. Typed over every kind, so a new Event
 * kind fails the typecheck until it is routed. `TurnStarted` and `TurnEnded` go to the timeline and
 * the turn (`TurnEnded` also places the Task List), the timeline first (stamping a Turn's duration reads the start time that `turnSlice`
 * clears). Session-level kinds (`StateChanged`, artifacts) are handled before this, in `apply`.
 */
const ROUTES: Record<EventKind["type"], readonly Slice[]> = {
   TurnStarted: [timelineSlice, turnSlice],
   TurnEnded: [timelineSlice, plansSlice, turnSlice],
   AgentMessageChunk: T,
   AgentThoughtChunk: T,
   ToolCall: T,
   ToolCallUpdate: T,
   WorkspaceChanged: T,
   FrontendToolOutput: T,
   AgentNotice: T,
   GitCommitted: T,
   GitPushed: T,
   Error: T,
   PermissionRequested: T,
   PermissionResolved: T,
   PermissionRuleAdded: T,
   UsageUpdated: [turnSlice],
   SessionInfoUpdated: [sessionSlice],
   ThreadStarted: [sessionSlice],
   SessionArchived: [sessionSlice],
   AgentCapabilities: A,
   BackgroundJobEnded: A,
   AgentProcessState: A,
   ThreadReadOnly: A,
   AgentSessionRestoring: A,
   AgentSessionStarted: A,
   AuthRequired: A,
   ConfigOptionsChanged: [configSlice],
   AvailableCommandsChanged: [configSlice],
   TaskListUpdated: [plansSlice],
   StateChanged: NONE,
   ArtifactAttached: NONE,
   ArtifactDetached: NONE,
   ArtifactStateChanged: NONE,
   CommentAdded: NONE,
   CommentEdited: NONE,
   CommentDeleted: NONE,
   CommentsSent: NONE,
   CommentResolved: NONE,
   AgentUpdate: NONE,
   FrontendError: NONE,
   ModeChanged: [configSlice],
   SessionCreated: NONE,
   SessionStatusChanged: NONE,
   Unknown: NONE,
};

function apply(c: Ctx, e: Event) {
   const d = c.d;
   const type = e.kind.type;
   if (
      type === "StateChanged" ||
      type === "ArtifactAttached" ||
      type === "ArtifactDetached" ||
      type === "ArtifactStateChanged" ||
      type === "CommentAdded" ||
      type === "CommentEdited" ||
      type === "CommentDeleted" ||
      type === "CommentsSent" ||
      type === "CommentResolved"
   ) {
      sessionLevel(c, e);
      return;
   }
   trackThreadList(c, e);
   // The Agent process is gone, and its background jobs with it: in every Thread.
   if (type === "AgentProcessState") endSideJobs(c, e);
   if (type === "ThreadStarted") adoptMainThread(c, e);
   // Side Threads fold into their own state; everything else (Main Thread, Session-level) into this one.
   const target =
      e.thread_id && d.mainThreadId && e.thread_id !== d.mainThreadId ? sideCtx(c, e.thread_id) : c;
   const slices = ROUTES[type] ?? NONE;
   for (let i = 0; i < slices.length; i++) slices[i]!(target, e);
}

/** Text of an ACP tool content block, if it carries any. */
export function blockText(b: ContentBlock): string | null {
   if (b.type === "content") {
      const c = b.content as { type?: string; text?: string } | undefined;
      return c?.type === "text" && typeof c.text === "string" ? c.text : null;
   }
   return null;
}

/** Readable title for Harness MCP permission requests; null for other requests. */
export function permissionTitle(
   toolCall: ToolCallRef,
   facts: { commitMessage?: string | null; frontendTool?: string | null } = {},
   /** Shown as a step: the message goes in the detail, not the title. */
   step = false,
): string | null {
   switch (toolCall.kind) {
      case "git_push":
         return "Push branch to origin?";
      case "pr_create":
         return "Open pull request?";
      case "git_commit": {
         const msg = facts.commitMessage;
         return msg && !step ? `Commit all changes: "${msg}"?` : "Commit all changes?";
      }
      case "frontend_tool": {
         const name = facts.frontendTool;
         return name
            ? `Let the Agent use Frontend tool ${name}?`
            : "Let the Agent use a Frontend tool?";
      }
      default:
         return null;
   }
}
