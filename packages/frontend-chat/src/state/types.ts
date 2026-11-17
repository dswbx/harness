import type {
   Attachment,
   AuthMethodInfo,
   Boundary,
   FileChange,
   ForkPoint,
   HarnessResult,
   LineCommentState,
   PermissionOption,
   SlashCommand,
   SubSessionReport,
   TaskEntry,
   ThreadInfo,
   ToolDetail,
   TranscriptSize,
} from "@harness/api";

export type ContentBlock = Record<string, unknown>;

/** A node of a decoded `render_ui` tree, as far as the reducer and the slot split read it. */
export type DecodedNode = {
   type: string;
   props?: Record<string, unknown>;
   children?: DecodedNode[];
   on?: unknown;
   visible?: unknown;
};

/**
 * What the reducer and `features/renderUi/slots.ts` read from a validated `render_ui` input. The
 * real type (`RenderUiInput`) lives in `features/renderUi`, which asserts it is assignable to this.
 */
export type DecodedRenderUi = {
   root?: DecodedNode;
   source?: string;
   id?: string;
   placement?: "inline" | "top" | "bottom" | "left" | "right";
   title?: string;
   icon?: string;
   remove?: boolean;
};

/**
 * Validates the input of a Frontend Tool call. `null`: not a tool it knows (the Item keeps no
 * `render`). Injected into the reducer, so `state/` does not import a Frontend's catalog.
 */
export type ToolDecoder = (
   tool: string,
   input: unknown,
) => { ok: true; value: DecodedRenderUi } | { ok: false; errors: string[] } | null;

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
        from: {
           sessionId: string;
           title: string;
           subSession: boolean;
           /** Harness news about Sub Sessions: shown instead of the text (written for the Agent). */
           reports: SubSessionReport[];
        } | null;
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
        /** The core's typed facts of this call (`toolDetail` derives them from the raw fields when absent: old logs). */
        detail?: ToolDetail;
        /** What a Harness tool call did, typed by the core (`harnessResult` reads the output text on old logs). */
        harnessResult?: HarnessResult;
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
        /** Set on the chat row (`chatRows`) of a pending approval: the step it stands in for, for its preview. */
        step?: Extract<Item, { type: "tool" }>;
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
        render: { ok: true; value: DecodedRenderUi } | { ok: false; errors: string[] } | null;
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
   /** The mode to go back to after the plan: the core's `mode_before` on the request (old logs: the last non-plan mode seen, `ChatState.lastMode`). */
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
   /**
    * Where the Task List shows once its Turn ended: before the item at this index (`items.length`:
    * after all). Set to `items.length` when it changes, and to the closing agent message when its Turn ends.
    */
   taskListAt: number;
   /** The running Turn the Task List last changed in; null once that Turn ended. */
   taskListTurn: string | null;
   configOptions: ConfigOption[];
   /**
    * Old logs only: the last mode announced that was not the plan mode, for plan requests without
    * the core's `mode_before` (see `rememberMode`).
    */
   lastMode: string | null;
   /**
    * Names of modes by id, from the typed `mode` of mode Events (core): for Agents with legacy
    * modes, which have no config option to name them. Absent until one is seen.
    */
   modeNames?: Record<string, string>;
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
   /** Review Comments on diff and file lines (ADR 0027), in the order added, from the `Comment*` Events. */
   lineComments: readonly LineCommentState[];
   /**
    * Side Threads by id (ADR 0018). Each is a full ChatState of its own Thread (`threads` empty), so
    * the message list and prompt box render it like the Main Thread. The Main Thread's state is this
    * object itself.
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

export type Tool = Extract<Item, { type: "tool" }>;
