import type { Event } from "@harness/api";
import { type Ctx, initialState, newCtx, sideCtx } from "./draft";
import { agentSlice, endSideJobs } from "./slices/agent";
import { configSlice } from "./slices/config";
import { plansSlice } from "./slices/plans";
import { adoptMainThread, sessionLevel, sessionSlice, trackThreadList } from "./slices/session";
import { timelineSlice } from "./slices/timeline";
import { turnSlice } from "./slices/turn";
import type { ChatState, ContentBlock, ToolCallRef } from "./types";

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
} from "./types";
export { initialState };

/** Folds one Event. Pure from the caller's view: never mutates `state`. */
export function reduce(state: ChatState, e: Event): ChatState {
   return reduceBatch(state, [e]);
}

/**
 * Folds many Events at once (replay, per-frame batches). Same result as folding one by one,
 * but copies `items` at most once and looks tool calls up through an index.
 */
export function reduceBatch(state: ChatState, events: readonly Event[]): ChatState {
   if (events.length === 0) return state;
   const c = newCtx({ ...state });
   for (const e of events) apply(c, e);
   return c.d;
}

function apply(c: Ctx, e: Event) {
   const d = c.d;
   if (sessionLevel(c, e)) return;
   trackThreadList(c, e);
   // The Agent process is gone, and its background jobs with it: in every Thread.
   endSideJobs(c, e);
   adoptMainThread(c, e);
   // Side Threads fold into their own state; everything else (Main Thread, Session-level) into this one.
   if (e.thread_id && d.mainThreadId && e.thread_id !== d.mainThreadId) {
      applyThread(sideCtx(c, e.thread_id), e);
      return;
   }
   applyThread(c, e);
}

/**
 * Folds one Event into one Thread's state (`c.d`). Each Event kind belongs to one slice, except
 * `TurnStarted` and `TurnEnded`, which the timeline and the turn both fold, the timeline first
 * (stamping a Turn's duration reads the start time that `turnSlice` clears).
 */
function applyThread(c: Ctx, e: Event) {
   timelineSlice(c, e);
   turnSlice(c, e);
   sessionSlice(c, e);
   agentSlice(c, e);
   configSlice(c, e);
   plansSlice(c, e);
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
