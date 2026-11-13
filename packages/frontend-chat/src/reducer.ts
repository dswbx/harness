import {
   type Attachment,
   type AuthMethodInfo,
   applyStatePatch,
   type Boundary,
   type Event,
   type FileChange,
   type ForkPoint,
   type PermissionOption,
   type PermissionRule,
   type SlashCommand,
   stepThreads,
   type TaskEntry,
   type ThreadInfo,
   type TranscriptSize,
   toolFacts,
   toolFactsOfCall,
} from "@harness/api";
import { groupConfigOptions, valueName } from "./configGroups";
import { planSteps, planTitle } from "./plans";
import { parseReviewComments } from "./reviewComments";
import {
   formatErrors,
   RENDER_UI,
   type RenderUiInput,
   renderUiSchema,
   withSourceRoot,
} from "./tools";

/** Chat state is a pure fold over the Session Log: replay and live share this one path. */

export type ContentBlock = Record<string, unknown>;

export type ConfigOption = {
   id: string;
   name: string;
   description?: string;
   category?: string;
   type: string;
   currentValue: string;
   options: { value: string; name: string; description?: string }[];
};

export type Item =
   /** `ts`: ms epoch of the message's first Event. */
   /** `context`: the `<harness_context>` the core sent before this text (first prompt of an Agent Session). */
   /** `from`: the Session whose Agent sent this prompt (a sub session's parent); null when the user did. */
   | {
        type: "user";
        id: string;
        text: string;
        ts: number;
        attachments: Attachment[];
        context: string | null;
        /** Who sent it when not the user: a parent's Agent, or the Harness with news from sub sessions. */
        from: { sessionId: string; title: string; subSession: boolean } | null;
     }
   /** `durationMs`: on the last agent message of a finished Turn, how long the Turn took. */
   /** `parent`: the tool call that started the subagent which wrote this text; null for the Thread's own. */
   | {
        type: "agent";
        id: string;
        text: string;
        ts: number;
        parent: string | null;
        durationMs?: number;
     }
   | { type: "thought"; id: string; text: string; ts: number; parent: string | null }
   | {
        type: "tool";
        id: string;
        title: string;
        kind: string | null;
        status: string | null;
        content: ContentBlock[];
        locations: unknown;
        rawInput: unknown;
        rawOutput: unknown;
        /** The tool call that started the subagent which made this call. */
        parent: string | null;
        /** Finished, but its work goes on in the background (a background subagent). */
        background: boolean;
        /** This call hands its subagent's final report to the parent: the text. */
        report: string | null;
        /** The Harness MCP tool this calls (`git_status`), when it is one. */
        harnessTool: string | null;
        /** What this call started a subagent for: its task. */
        subagentPrompt: string | null;
        /** A subagent's type, model and effort, taken when the call first named its task. */
        subagentMeta: SubagentMeta | null;
        /** ms epoch of the call's first Event, and of its first completed or failed status. */
        ts: number;
        endedAt: number | null;
        /** git_commit: the commit message. */
        commitMessage: string | null;
        /** How a Harness tool call got through its approval: you answered, a rule, the Agent's auto mode, or it was denied. */
        approval?: "you" | "denied" | "rule" | "auto";
     }
   | {
        type: "permission";
        id: string;
        requestId: string;
        toolCall: ToolCallRef;
        /** The Harness MCP tool the request is for, when it is one. */
        harnessTool: string | null;
        /** A plan to approve (Plan Mode): Markdown. */
        plan: string | null;
        /** git_commit: the commit message. */
        commitMessage: string | null;
        /** The Frontend Tool the request is for: its name. */
        frontendTool: string | null;
        /** The tool call this approves (a Harness tool's step in the Trace), when there is one. */
        stepId: string | null;
        options: PermissionOption[];
        resolved: boolean;
        /** Set when the core answered via the Permission Policy (no actionable card). */
        auto?: { allowed: boolean; ruleId: string | null };
     }
   /** The Agent refuses to start a session until the user signs in. */
   | { type: "auth"; id: string; message: string; methods: AuthMethodInfo[] }
   | {
        type: "notice";
        id: string;
        level: "boundary" | "error" | "info";
        text: string;
        /** More about it, behind an info icon. */
        info?: string;
     }
   /** An Agent's session notice (e.g. hook output): shown apart from its reply. */
   | {
        type: "agent_notice";
        id: string;
        severity: string;
        title: string;
        description: string | null;
     }
   /** An Agent called a Frontend Tool. `render_ui` input is re-validated on the client. */
   | {
        type: "frontend_tool";
        id: string;
        /** ms epoch of the call. */
        ts: number;
        tool: string;
        callId: string;
        path: string;
        input: unknown;
        /** Local images the input names: src -> the core's copy (relative to `frontend/`). */
        files: Record<string, string>;
        /** Set for known tools: the validated input, or why it failed. Unknown tools: null. */
        render: { ok: true; value: RenderUiInput } | { ok: false; errors: string[] } | null;
     }
   /** Files the Agent changed during a Turn; opens the diff scoped to that Turn. */
   | {
        type: "changes";
        id: string;
        turnId: string;
        fromTree: string;
        toTree: string;
        files: FileChange[];
     };

/**
 * What a subagent runs as. `model`: the one its call asked for, else the Thread's model at that
 * time (`modelInherited`). `effort`: the Thread's effort at that time.
 */
export type SubagentMeta = {
   type: string | null;
   model: string | null;
   modelInherited: boolean;
   effort: string | null;
};

/** One version of a plan the Agent asked to approve (Plan Mode). Its `permission` item has the same `requestId`. */
export type PlanEntry = {
   requestId: string;
   /** 1, 2, ... in the order the Thread's plans arrived. */
   version: number;
   markdown: string;
   title: string | null;
   steps: number | null;
   /** The plan this one revises (the one before, unless that was approved): its `requestId`. */
   prev: string | null;
   /** "revised": answered with the reject option ("Keep planning"). */
   status: "pending" | "approved" | "revised" | "dismissed";
   /** The option the request was answered with. */
   optionId: string | null;
   /** The mode the Agent was in before Plan Mode (the last mode value that was not "plan"). */
   modeBefore: string | null;
   /** The chosen option also cleared the context. */
   clearsContext: boolean;
   /** ms epoch of the request and of the answer. */
   requestedAt: number;
   resolvedAt: number | null;
   /** Plan comments sent between the previous version and this one. */
   commentsSent: number;
};

export type ToolCallRef = {
   toolCallId?: string;
   title?: string;
   kind?: string;
   content?: ContentBlock[];
};

export type Usage = { used: number; size: number };

/** A shell command the Agent left running in the background. `label`: its tool call's title, else the job id. */
/** `since`: when the job went to the background (ms). */
export type BackgroundJobInfo = { id: string; label: string; since: number };

export type ChatState = {
   items: Item[];
   /** The running Turn, if any. */
   turnId: string | null;
   /** ms epoch the running Turn started. */
   turnStartedAt: number | null;
   mainThreadId: string | null;
   taskList: TaskEntry[];
   configOptions: ConfigOption[];
   /** The last value of the mode config option that was not "plan" (the mode to go back to after a plan). */
   lastMode: string | null;
   /** The plans the Agent asked to approve, oldest first. */
   plans: PlanEntry[];
   /** The Agent's asking mode (core's `side_mode`): where a new Side Thread starts. Null: unknown. */
   sideMode: string | null;
   commands: SlashCommand[];
   usage: Usage | null;
   title: string | null;
   process: { state: string; message: string | null } | null;
   /** The Agent can never restore this Thread's Agent Session: only ContinueWithSummary works. */
   readOnly: boolean;
   /** Restoring the Agent Session failed, and nothing has backed the Thread since. */
   recovery: {
      retryable: boolean;
      errors: string[];
      transcript: TranscriptSize | null;
   } | null;
   /** Restoring the Agent Session is being tried again. */
   restoring: { attempt: number; of: number } | null;
   /** The last Turn ended with stop_reason "error" (cleared by the next Turn). */
   lastTurnErrored: boolean;
   /** The Session is archived: prompting is disabled until it is unarchived. */
   archived: boolean;
   /** What the Agent accepts in a prompt; null until its process has started. */
   promptCaps: { image: boolean; embeddedContext: boolean } | null;
   /** The Session State (ADR 0015), rebuilt from `StateChanged` (every Thread: it is per Session). */
   uiState: unknown;
   /**
    * Shared Artifacts attached to the Session (ADR 0024), in attach order, from `ArtifactAttached` and
    * `ArtifactDetached`. `ts`: when it was attached.
    */
   sharedAttached: readonly { id: string; ts: number }[];
   /**
    * Side Threads by id (ADR 0018). Each is a full ChatState of its own Thread (`threads` empty), so
    * the message list and prompt box render it like the Main Thread. The Main Thread's state is this
    * object itself; `threadState` reaches either.
    */
   threads: Record<string, ChatState>;
   /** Main + Side Threads for menus and tab titles (`threadsOf`, folded). Main state only. */
   threadList: readonly ThreadInfo[];
   /** Side Threads: where in the Main Thread this one forked (null: fresh, or the Main Thread). */
   forkedFrom: ForkPoint | null;
   /** This is a Side Thread's state. */
   side: boolean;
   /** How the Thread's first Agent Session started; null until it has (it starts with the first prompt). */
   startBoundary: Boundary | null;
   /** Background jobs still running, oldest first. They end with `BackgroundJobEnded` or when the Agent process stops. */
   backgroundJobs: readonly BackgroundJobInfo[];
};

export const initialState = (): ChatState => ({
   items: [],
   turnId: null,
   turnStartedAt: null,
   mainThreadId: null,
   taskList: [],
   configOptions: [],
   lastMode: null,
   plans: [],
   sideMode: null,
   commands: [],
   usage: null,
   title: null,
   process: null,
   readOnly: false,
   recovery: null,
   restoring: null,
   lastTurnErrored: false,
   archived: false,
   promptCaps: null,
   uiState: {},
   sharedAttached: [],
   threads: {},
   threadList: [],
   forkedFrom: null,
   side: false,
   startBoundary: null,
   backgroundJobs: [],
});

/** The state of a Thread: the Main Thread is `state` itself. Null for an unknown id. */
export function threadState(state: ChatState, threadId: string | null): ChatState | null {
   if (threadId === null || threadId === state.mainThreadId) return state;
   return state.threads[threadId] ?? null;
}

type Tool = Extract<Item, { type: "tool" }>;

/**
 * Mutable scratch space for one batch. `d` is a shallow copy of the state (safe to mutate);
 * `items` is copied lazily, once. Lookup indexes are built on first use and kept in sync, so
 * a batch costs O(items + events) instead of O(items * events).
 */
type Ctx = {
   d: ChatState;
   owned: boolean;
   tools: Map<string, number> | null;
   perms: Map<string, number> | null;
   /** Side Thread contexts touched in this batch (their `d` goes into `d.threads`). */
   sides: Map<string, Ctx> | null;
   threadsOwned: boolean;
};

const newCtx = (d: ChatState): Ctx => ({
   d,
   owned: false,
   tools: null,
   perms: null,
   sides: null,
   threadsOwned: false,
});

function own(c: Ctx): Item[] {
   if (!c.owned) {
      c.d.items = c.d.items.slice();
      c.owned = true;
   }
   return c.d.items;
}

function push(c: Ctx, item: Item) {
   own(c).push(item);
}

function toolIndex(c: Ctx): Map<string, number> {
   if (!c.tools) {
      c.tools = new Map();
      c.d.items.forEach((i, n) => i.type === "tool" && c.tools!.set(i.id, n));
   }
   return c.tools;
}

function permIndex(c: Ctx): Map<string, number> {
   if (!c.perms) {
      c.perms = new Map();
      c.d.items.forEach((i, n) => i.type === "permission" && c.perms!.set(i.requestId, n));
   }
   return c.perms;
}

/** The subagent (its starting tool call) an item belongs to, when that call is known. */
function subagentOf(it: Item, idx: Map<string, number>): string | null {
   const parent =
      it.type === "tool"
         ? it.report == null
            ? it.parent
            : null
         : it.type === "agent" || it.type === "thought"
           ? it.parent
           : null;
   return parent && idx.has(parent) ? parent : null;
}

/**
 * Adds a chunk to the last message or thought of its type.
 * - A subagent's chunk (`parent`) joins that subagent's last item when it is of the same type, else
 *   starts a new one. Its steps render in order inside the subagent.
 * - The Thread's own chunk looks past a running subagent's items: they arrive between the parent's
 *   chunks but render inside the subagent, so they must not split the text. A subagent's report
 *   still does: text after it is a new reply.
 */
function appendText(
   c: Ctx,
   type: "agent" | "thought",
   text: string,
   id: string,
   ts: number,
   parent: string | null,
) {
   const items = own(c);
   const idx = toolIndex(c);
   const task = parent !== null ? idx.get(parent) : undefined;
   if (parent !== null && task !== undefined) {
      for (let n = items.length - 1; n > task; n--) {
         const it = items[n]!;
         if (subagentOf(it, idx) !== parent) continue;
         if (it.type === type) {
            items[n] = { ...it, text: it.text + text };
            return;
         }
         break;
      }
      items.push({ type, id, text, ts, parent });
      return;
   }
   let n = items.length - 1;
   while (n >= 0 && subagentOf(items[n]!, idx) !== null) n--;
   const last = items[n];
   if (last && last.type === type) items[n] = { ...last, text: last.text + text };
   else items.push({ type, id, text, ts, parent: null });
}

/** A subagent's type, model and effort, from its call, else from the Thread's current options. */
function subagentMeta(d: ChatState, agentType: string | null, model: string | null): SubagentMeta {
   const g = groupConfigOptions(d.configOptions);
   const effort = g.effort ?? d.configOptions.find((o) => o.category === "thought_level");
   const threadModel = g.model ? valueName(g.model) : null;
   return {
      type: agentType,
      model: model ?? threadModel,
      modelInherited: model == null && threadModel != null,
      effort: effort ? valueName(effort) : null,
   };
}

const ended = (status: string | null | undefined) => status === "completed" || status === "failed";

/** Puts the Turn's duration on its last agent message (none if the Turn produced no text). */
function stampDuration(c: Ctx, durationMs: number) {
   const items = c.d.items;
   for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i]!;
      if (it.type === "user") return;
      if (it.type === "agent" && !it.parent) {
         own(c)[i] = { ...it, durationMs };
         return;
      }
   }
}

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
   const k = e.kind;
   if (k.type === "StateChanged") {
      try {
         d.uiState = applyStatePatch(d.uiState, k.ops);
      } catch {
         // The core applied this patch; a failure here means our rules drifted. Keep the last state.
      }
      return;
   }
   // Shared Artifacts are Session-level. Their state is never folded here: Views read it from the
   // artifact (ADR 0024 addendum), so `ArtifactStateChanged` never touches `uiState`.
   if (k.type === "ArtifactAttached" || k.type === "ArtifactDetached") {
      const rest = d.sharedAttached.filter((x) => x.id !== k.id);
      d.sharedAttached =
         k.type === "ArtifactAttached" ? [...rest, { id: k.id, ts: e.ts_ms }] : rest;
      return;
   }
   if (k.type === "ArtifactStateChanged") return;
   d.threadList = stepThreads(d.threadList, e);
   // The Agent process is gone, and its background jobs with it: in every Thread.
   if (k.type === "AgentProcessState" && agentGone(k.state)) {
      for (const [id, t] of Object.entries(d.threads))
         if (t.backgroundJobs.length > 0) sideCtx(c, id).d.backgroundJobs = [];
   }
   if (k.type === "ThreadStarted" && k.main && !d.mainThreadId) d.mainThreadId = e.thread_id;
   // Side Threads fold into their own state; everything else (Main Thread, Session-level) into this one.
   if (e.thread_id && d.mainThreadId && e.thread_id !== d.mainThreadId) {
      applySide(c, e.thread_id, e);
      return;
   }
   applyThread(c, e);
}

function applySide(c: Ctx, threadId: string, e: Event) {
   applyThread(sideCtx(c, threadId), e);
}

/** The batch context of a Side Thread; its state (safe to mutate) is already in `c.d.threads`. */
function sideCtx(c: Ctx, threadId: string): Ctx {
   c.sides ??= new Map();
   let sc = c.sides.get(threadId);
   if (!sc) {
      sc = newCtx({ ...(c.d.threads[threadId] ?? initialState()) });
      c.sides.set(threadId, sc);
   }
   if (!c.threadsOwned) {
      c.d.threads = { ...c.d.threads };
      c.threadsOwned = true;
   }
   c.d.threads[threadId] = sc.d;
   return sc;
}

/** Folds one Event into one Thread's state (`c.d`). */
function applyThread(c: Ctx, e: Event) {
   const d = c.d;
   const k = e.kind;

   const id = `e${e.seq}`;
   const notice = (level: "boundary" | "error" | "info", text: string) =>
      push(c, { type: "notice", id, level, text });
   switch (k.type) {
      case "TurnStarted":
         d.turnId = k.turn_id;
         d.turnStartedAt = e.ts_ms;
         d.lastTurnErrored = false;
         push(c, {
            type: "user",
            id,
            text: k.text,
            ts: e.ts_ms,
            attachments: k.attachments ?? [],
            context: k.context ?? null,
            from: k.origin
               ? {
                    sessionId: k.origin.session_id,
                    title: k.origin.title,
                    subSession: k.origin.kind === "sub_session",
                 }
               : null,
         });
         return;
      case "AgentCapabilities":
         d.promptCaps = { image: k.image, embeddedContext: k.embedded_context };
         return;
      case "TurnEnded":
         if (d.turnStartedAt !== null) stampDuration(c, e.ts_ms - d.turnStartedAt);
         d.turnId = null;
         d.turnStartedAt = null;
         d.lastTurnErrored = k.stop_reason === "error";
         if (k.stop_reason !== "end_turn")
            notice(k.stop_reason === "error" ? "error" : "info", `Turn stopped: ${k.stop_reason}`);
         return;
      case "AgentMessageChunk":
         appendText(c, "agent", k.text, id, e.ts_ms, k.parent_tool_call_id ?? null);
         return;
      case "AgentThoughtChunk":
         appendText(c, "thought", k.text, id, e.ts_ms, k.parent_tool_call_id ?? null);
         return;
      case "ToolCall": {
         const idx = toolIndex(c);
         const existing = idx.get(k.tool_call_id);
         const prev = existing !== undefined ? (d.items[existing] as Tool) : null;
         const facts = toolFacts({
            kind: k.kind,
            title: k.title,
            harnessTool: k.harness_tool,
            rawInput: k.raw_input,
         });
         const subagentPrompt = k.subagent?.prompt ?? facts.subagentPrompt;
         const item: Tool = {
            type: "tool",
            id: k.tool_call_id,
            title: k.title,
            kind: k.kind,
            status: k.status,
            content: asBlocks(k.content),
            locations: k.locations,
            rawInput: k.raw_input,
            rawOutput: null,
            parent:
               k.parent_tool_call_id ??
               (existing !== undefined ? (d.items[existing] as Tool).parent : null),
            background: existing !== undefined ? (d.items[existing] as Tool).background : false,
            report: k.report ?? null,
            harnessTool: k.harness_tool ?? null,
            subagentPrompt,
            subagentMeta:
               prev?.subagentMeta ??
               (subagentPrompt != null
                  ? subagentMeta(
                       d,
                       k.subagent?.agent_type ?? facts.subagentType,
                       k.subagent?.model ?? facts.subagentModel,
                    )
                  : null),
            ts: prev?.ts ?? e.ts_ms,
            endedAt: prev?.endedAt ?? (ended(k.status) ? e.ts_ms : null),
            commitMessage: k.commit_message ?? facts.commitMessage,
            ...(existing !== undefined &&
               (d.items[existing] as Tool).approval && {
                  approval: (d.items[existing] as Tool).approval,
               }),
         };
         if (existing !== undefined) own(c)[existing] = item;
         else {
            idx.set(item.id, own(c).length);
            push(c, item);
         }
         return;
      }
      case "ToolCallUpdate": {
         const idx = toolIndex(c);
         const at = idx.get(k.tool_call_id);
         const prev = at !== undefined ? (d.items[at] as Tool) : null;
         const base: Tool = prev ?? {
            type: "tool",
            id: k.tool_call_id,
            title: "Tool call",
            kind: null,
            status: null,
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
            ts: e.ts_ms,
            endedAt: null,
            commitMessage: null,
         };
         const facts = toolFacts({
            kind: k.kind ?? base.kind,
            title: k.title ?? base.title,
            harnessTool: k.harness_tool ?? base.harnessTool,
            rawInput: k.raw_input,
         });
         const subagentPrompt = k.subagent?.prompt ?? facts.subagentPrompt ?? base.subagentPrompt;
         const next: Tool = {
            ...base,
            title: k.title ?? base.title,
            kind: k.kind ?? base.kind,
            status: k.status ?? base.status,
            content: k.content != null ? asBlocks(k.content) : base.content,
            locations: k.locations ?? base.locations,
            rawInput: k.raw_input ?? base.rawInput,
            rawOutput: k.raw_output ?? base.rawOutput,
            parent: k.parent_tool_call_id ?? base.parent,
            background: k.background || base.background,
            harnessTool: k.harness_tool ?? base.harnessTool,
            subagentPrompt,
            subagentMeta:
               base.subagentMeta ??
               (subagentPrompt != null
                  ? subagentMeta(
                       d,
                       k.subagent?.agent_type ?? facts.subagentType,
                       k.subagent?.model ?? facts.subagentModel,
                    )
                  : null),
            endedAt: base.endedAt ?? (ended(k.status) ? e.ts_ms : null),
            commitMessage: k.commit_message ?? facts.commitMessage ?? base.commitMessage,
         };
         if (at === undefined) {
            idx.set(next.id, own(c).length);
            push(c, next);
         } else own(c)[at] = next;
         const job = k.background_job;
         if (job && !d.backgroundJobs.some((j) => j.id === job.id)) {
            const label = next.title !== "Tool call" ? next.title : job.id;
            d.backgroundJobs = [...d.backgroundJobs, { id: job.id, label, since: e.ts_ms }];
         }
         return;
      }
      case "BackgroundJobEnded":
         d.backgroundJobs = d.backgroundJobs.filter((j) => j.id !== k.job_id);
         return;
      case "TaskListUpdated":
         d.taskList = k.entries;
         return;
      case "ConfigOptionsChanged":
         if (Array.isArray(k.options)) {
            d.configOptions = k.options as ConfigOption[];
            const mode = d.configOptions.find((o) => o.category === "mode")?.currentValue;
            if (mode && mode !== "plan") d.lastMode = mode;
         }
         d.sideMode = k.side_mode ?? null;
         return;
      case "AvailableCommandsChanged":
         d.commands = k.commands;
         return;
      case "UsageUpdated": {
         const u = k.usage as { used?: number; size?: number } | null;
         if (typeof u?.used === "number" && typeof u?.size === "number")
            d.usage = { used: u.used, size: u.size };
         return;
      }
      case "SessionInfoUpdated":
         if (k.title) d.title = k.title;
         return;
      case "AgentProcessState": {
         const wasTurn = d.turnId !== null || d.lastTurnErrored;
         d.process = { state: k.state, message: k.message };
         if (agentGone(k.state) && d.backgroundJobs.length > 0) d.backgroundJobs = [];
         // A stop needs no action: the header's status dot shows it.
         if (k.state === "stopped") return;
         if ((k.state === "failed" || k.state === "exited") && wasTurn) {
            d.lastTurnErrored = false;
            // The message may hold multi-line agent stderr after a blank line (rendered as Details).
            notice(
               "error",
               k.message
                  ? `Agent process ended unexpectedly\n\n${k.message}`
                  : "Agent process ended unexpectedly",
            );
         } else if (k.state === "failed" && k.message) {
            notice("error", `Agent failed\n\n${k.message}`);
         }
         return;
      }
      case "ThreadStarted":
         if (!k.main) {
            d.side = true;
            d.forkedFrom = k.forked_from ?? null;
         }
         return;
      case "ThreadReadOnly": {
         const retryable = k.retryable ?? false;
         d.readOnly = !retryable;
         d.recovery = { retryable, errors: k.errors ?? [], transcript: k.transcript ?? null };
         d.restoring = null;
         return;
      }
      case "AgentSessionRestoring":
         d.restoring = { attempt: k.attempt, of: k.of };
         return;
      case "AgentSessionStarted":
         d.readOnly = false;
         d.recovery = null;
         d.restoring = null;
         if (d.side && d.startBoundary === null) {
            // A Side Thread's list opens with how it started.
            d.startBoundary = k.boundary;
            if (k.boundary === "forked")
               notice(
                  "boundary",
                  d.forkedFrom
                     ? `Forked from main at turn ${d.forkedFrom.turn}`
                     : "Forked from main",
               );
            else if (k.boundary === "initial")
               notice(
                  "boundary",
                  d.forkedFrom
                     ? "Started with a summary of main"
                     : "Started fresh, without the conversation",
               );
            else notice("boundary", boundaryText(k.boundary));
            return;
         }
         d.startBoundary ??= k.boundary;
         // Show a boundary only when what the Agent knows changed.
         if (["initial", "forked", "resumed", "loaded"].includes(k.boundary)) return;
         push(c, {
            type: "notice",
            id,
            level: "boundary",
            text: boundaryText(k.boundary),
            ...(k.boundary === "continued_with_summary" && {
               info: transcriptInfo(k.transcript ?? null),
            }),
         });
         return;
      case "WorkspaceChanged":
         if (k.files.length === 0) return;
         push(c, {
            type: "changes",
            id,
            turnId: k.turn_id,
            fromTree: k.from_tree,
            toTree: k.to_tree,
            files: k.files,
         });
         return;
      case "FrontendToolOutput": {
         let render: Extract<Item, { type: "frontend_tool" }>["render"] = null;
         if (k.tool === RENDER_UI) {
            const r = renderUiSchema.validate(k.input);
            render = r.valid
               ? { ok: true, value: withSourceRoot(k.input as RenderUiInput) }
               : { ok: false, errors: formatErrors(r.errors, k.input) };
         }
         push(c, {
            type: "frontend_tool",
            id,
            ts: e.ts_ms,
            tool: k.tool,
            callId: k.call_id,
            path: k.path,
            input: k.input,
            files: k.files ?? {},
            render,
         });
         return;
      }
      case "AgentNotice":
         push(c, {
            type: "agent_notice",
            id,
            severity: k.severity,
            title: k.title,
            description: k.description,
         });
         return;
      // The Agent's own commits and pushes are Trace steps already; the notice is for the user's.
      case "GitCommitted": {
         if (k.by === "agent") return;
         const [subject = "", ...rest] = k.message.trim().split("\n");
         push(c, {
            type: "notice",
            id,
            level: "info",
            text: `You committed ${k.commit.slice(0, 7)} ${subject.trim()}`,
            ...(rest.some((l) => l.trim()) && { info: k.message.trim() }),
         });
         return;
      }
      case "GitPushed":
         if (k.by === "agent") return;
         notice("info", `You pushed ${k.branch} to origin`);
         return;
      case "SessionArchived":
         d.archived = k.archived;
         notice("info", k.archived ? "Session archived" : "Session unarchived");
         return;
      case "AuthRequired":
         push(c, { type: "auth", id, message: k.message, methods: k.methods });
         return;
      case "Error":
         notice("error", k.message);
         return;
      case "PermissionRequested": {
         const idx = permIndex(c);
         idx.set(k.request_id, own(c).length);
         let stepId: string | null = null;
         if (k.harness_tool) {
            for (let n = d.items.length - 1; n >= 0; n--) {
               const t = d.items[n]!;
               if (
                  t.type === "tool" &&
                  t.harnessTool === k.harness_tool &&
                  t.status !== "completed" &&
                  t.status !== "failed"
               ) {
                  stepId = t.id;
                  break;
               }
            }
         }
         const call = (k.tool_call ?? {}) as ToolCallRef;
         const facts = toolFactsOfCall(k.tool_call, k.harness_tool);
         const plan = k.plan ?? facts.plan;
         if (plan) addPlan(c, k.request_id, plan, e.ts_ms);
         push(c, {
            type: "permission",
            id,
            requestId: k.request_id,
            toolCall: call,
            harnessTool: k.harness_tool ?? null,
            plan,
            commitMessage: k.commit_message ?? facts.commitMessage,
            frontendTool: k.frontend_tool ?? facts.frontendTool,
            stepId,
            options: k.options,
            resolved: false,
         });
         return;
      }
      case "PermissionResolved": {
         const at = permIndex(c).get(k.request_id);
         const i = at !== undefined ? d.items[at] : undefined;
         if (!i || i.type !== "permission") return;
         const option = i.options.find((o) => o.option_id === k.option_id);
         const kind = option?.kind ?? "";
         if (i.plan) {
            d.plans = d.plans.map((p) =>
               p.requestId === k.request_id
                  ? {
                       ...p,
                       status:
                          k.option_id === null
                             ? "dismissed"
                             : kind.startsWith("reject")
                               ? "revised"
                               : kind.startsWith("allow")
                                 ? "approved"
                                 : "dismissed",
                       optionId: k.option_id,
                       clearsContext: !!option?.clears_context,
                       resolvedAt: e.ts_ms,
                    }
                  : p,
            );
         }
         if (i.stepId && k.option_id !== null) {
            const ti = toolIndex(c).get(i.stepId);
            const tool = ti !== undefined ? d.items[ti] : undefined;
            if (tool?.type === "tool") {
               const approval: Tool["approval"] = kind.startsWith("reject")
                  ? "denied"
                  : !kind.startsWith("allow")
                    ? undefined
                    : k.by === "policy"
                      ? k.rule_id
                         ? "rule"
                         : "auto"
                      : "you";
               if (approval) own(c)[ti!] = { ...tool, approval };
            }
         }
         if (k.by !== "policy") own(c)[at!] = { ...i, resolved: true };
         else {
            own(c)[at!] = {
               ...i,
               resolved: true,
               auto: { allowed: kind.startsWith("allow"), ruleId: k.rule_id ?? null },
            };
         }
         return;
      }
      case "PermissionRuleAdded":
         notice(
            "info",
            `Remembered for ${k.rule.scope.type === "global" ? "all Sessions" : "this session"}: ${describeRule(k.rule)}`,
         );
         return;
   }
}

/** A new plan version. Counts the plan comments sent since the version it revises. */
function addPlan(c: Ctx, requestId: string, markdown: string, ts: number) {
   const d = c.d;
   const last = d.plans.at(-1);
   const prev = last && last.status !== "approved" ? last : null;
   let commentsSent = 0;
   if (prev) {
      const from = permIndex(c).get(prev.requestId) ?? d.items.length;
      for (let n = from + 1; n < d.items.length; n++) {
         const it = d.items[n]!;
         if (it.type !== "user") continue;
         commentsSent += parseReviewComments(it.text).comments.filter(
            (x) => x.kind === "quote" && x.source === "plan",
         ).length;
      }
   }
   d.plans = [
      ...d.plans,
      {
         requestId,
         version: d.plans.length + 1,
         markdown,
         title: planTitle(markdown),
         steps: planSteps(markdown),
         prev: prev?.requestId ?? null,
         status: "pending",
         optionId: null,
         modeBefore: d.lastMode,
         clearsContext: false,
         requestedAt: ts,
         resolvedAt: null,
         commentsSent,
      },
   ];
}

/** The Agent process no longer runs (its background jobs ended with it). */
const agentGone = (state: string) =>
   state === "stopped" || state === "exited" || state === "failed";

function transcriptInfo(t: TranscriptSize | null): string {
   const got = !t
      ? "a transcript of this conversation"
      : t.kept_turns < t.total_turns
        ? `the last ${t.kept_turns} of ${t.total_turns} turns`
        : `all ${t.total_turns} turns`;
   return `The earlier session could not be reopened, so a new agent session started. It got ${got}, without tool inputs, tool outputs or its earlier thoughts.`;
}

export function boundaryText(b: string): string {
   switch (b) {
      case "resumed":
         return "Agent session resumed";
      case "loaded":
         return "Agent session reloaded";
      case "continued_with_summary":
         return "Continued from transcript";
      case "reseeded":
         return "New Agent session started with the earlier context";
      case "agent_switched":
         return "Switched to a different Agent in a new session";
      default:
         return `New Agent session (${b.replace(/_/g, " ")})`;
   }
}

function asBlocks(v: unknown): ContentBlock[] {
   return Array.isArray(v) ? (v as ContentBlock[]) : [];
}

/** Text of an ACP tool content block, if it carries any. */
export function blockText(b: ContentBlock): string | null {
   if (b.type === "content") {
      const c = b.content as { type?: string; text?: string } | undefined;
      return c?.type === "text" && typeof c.text === "string" ? c.text : null;
   }
   return null;
}

/** e.g. "allow `echo hi`", "deny all edit", "allow everything". */
export function describeRule(r: PermissionRule): string {
   const target = r.pattern
      ? `\`${r.pattern}\``
      : r.tool_kind
        ? `all ${r.tool_kind}`
        : "everything";
   return `${r.decision} ${target}`;
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
