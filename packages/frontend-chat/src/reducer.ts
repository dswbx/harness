import { renderUiSchema, RENDER_UI, type RenderUiInput } from "./tools";
import { applyStatePatch, stepThreads, type ThreadInfo, type Attachment, type AuthMethodInfo, type Boundary, type Event, type ForkPoint, type FileChange, type PermissionOption, type PermissionRule, type SlashCommand, type TaskEntry } from "@harness/api";

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
  | { type: "user"; id: string; text: string; ts: number; attachments: Attachment[]; context: string | null }
  /** `durationMs`: on the last agent message of a finished Turn, how long the Turn took. */
  | { type: "agent"; id: string; text: string; ts: number; durationMs?: number }
  | { type: "thought"; id: string; text: string; ts: number }
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
    }
  | {
      type: "permission";
      id: string;
      requestId: string;
      toolCall: ToolCallRef;
      /** The Harness MCP tool the request is for, when it is one. */
      harnessTool: string | null;
      options: PermissionOption[];
      resolved: boolean;
      /** Set when the core answered via the Permission Policy (no actionable card). */
      auto?: { allowed: boolean; ruleId: string | null; /** Denied because the Side Thread is read-only. */ readOnlyThread?: boolean };
    }
  /** The Agent refuses to start a session until the user signs in. */
  | { type: "auth"; id: string; message: string; methods: AuthMethodInfo[] }
  | { type: "notice"; id: string; level: "boundary" | "error" | "info"; text: string }
  /** An Agent's session notice (e.g. hook output): shown apart from its reply. */
  | { type: "agent_notice"; id: string; severity: string; title: string; description: string | null }
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
  | { type: "changes"; id: string; turnId: string; fromTree: string; toTree: string; files: FileChange[] };

export type ToolCallRef = {
  toolCallId?: string;
  title?: string;
  kind?: string;
  rawInput?: Record<string, unknown>;
  content?: ContentBlock[];
};

export type Usage = { used: number; size: number };

export type ChatState = {
  items: Item[];
  /** The running Turn, if any. */
  turnId: string | null;
  /** ms epoch the running Turn started. */
  turnStartedAt: number | null;
  mainThreadId: string | null;
  taskList: TaskEntry[];
  configOptions: ConfigOption[];
  commands: SlashCommand[];
  usage: Usage | null;
  title: string | null;
  process: { state: string; message: string | null } | null;
  /** Main Thread cannot continue its Agent Session; only ContinueWithSummary works. */
  readOnly: boolean;
  /** The last Turn ended with stop_reason "error" (cleared by the next Turn). */
  lastTurnErrored: boolean;
  /** The Session is archived: prompting is disabled until it is unarchived. */
  archived: boolean;
  /** What the Agent accepts in a prompt; null until its process has started. */
  promptCaps: { image: boolean; embeddedContext: boolean } | null;
  /** The Session State (ADR 0015), rebuilt from `StateChanged` (every Thread: it is per Session). */
  uiState: unknown;
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
  /** Side Threads: the Agent may write (starts false). */
  writable: boolean;
  /** How the Thread's first Agent Session started; null until it has (it starts with the first prompt). */
  startBoundary: Boundary | null;
};

export const initialState = (): ChatState => ({
  items: [],
  turnId: null,
  turnStartedAt: null,
  mainThreadId: null,
  taskList: [],
  configOptions: [],
  commands: [],
  usage: null,
  title: null,
  process: null,
  readOnly: false,
  lastTurnErrored: false,
  archived: false,
  promptCaps: null,
  uiState: {},
  threads: {},
  threadList: [],
  forkedFrom: null,
  writable: true,
  startBoundary: null,
});

/** The state of a Thread: the Main Thread is `state` itself. Null for an unknown id. */
export function threadState(state: ChatState, threadId: string | null): ChatState | null {
  if (threadId === null || threadId === state.mainThreadId) return state;
  return state.threads[threadId] ?? null;
}

/** Plan Mode approval: a permission request for a `switch_mode` tool call carrying a plan. */
export function planOf(toolCall: ToolCallRef): string | null {
  const plan = toolCall.rawInput?.plan;
  return toolCall.kind === "switch_mode" && typeof plan === "string" ? plan : null;
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

const newCtx = (d: ChatState): Ctx => ({ d, owned: false, tools: null, perms: null, sides: null, threadsOwned: false });

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

function appendText(c: Ctx, type: "agent" | "thought", text: string, id: string, ts: number) {
  const items = own(c);
  const last = items[items.length - 1];
  if (last && last.type === type) items[items.length - 1] = { ...last, text: last.text + text };
  else items.push({ type, id, text, ts });
}

/** Puts the Turn's duration on its last agent message (none if the Turn produced no text). */
function stampDuration(c: Ctx, durationMs: number) {
  const items = c.d.items;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    if (it.type === "user") return;
    if (it.type === "agent") {
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
  d.threadList = stepThreads(d.threadList, e);
  if (k.type === "ThreadStarted" && k.main && !d.mainThreadId) d.mainThreadId = e.thread_id;
  // Side Threads fold into their own state; everything else (Main Thread, Session-level) into this one.
  if (e.thread_id && d.mainThreadId && e.thread_id !== d.mainThreadId) {
    applySide(c, e.thread_id, e);
    return;
  }
  applyThread(c, e);
}

function applySide(c: Ctx, threadId: string, e: Event) {
  c.sides ??= new Map();
  let sc = c.sides.get(threadId);
  if (!sc) {
    sc = newCtx({ ...(c.d.threads[threadId] ?? { ...initialState(), writable: false }) });
    c.sides.set(threadId, sc);
  }
  applyThread(sc, e);
  if (!c.threadsOwned) {
    c.d.threads = { ...c.d.threads };
    c.threadsOwned = true;
  }
  c.d.threads[threadId] = sc.d;
}

/** Folds one Event into one Thread's state (`c.d`). */
function applyThread(c: Ctx, e: Event) {
  const d = c.d;
  const k = e.kind;

  const id = `e${e.seq}`;
  const notice = (level: "boundary" | "error" | "info", text: string) => push(c, { type: "notice", id, level, text });
  switch (k.type) {
    case "TurnStarted":
      d.turnId = k.turn_id;
      d.turnStartedAt = e.ts_ms;
      d.lastTurnErrored = false;
      push(c, { type: "user", id, text: k.text, ts: e.ts_ms, attachments: k.attachments ?? [], context: k.context ?? null });
      return;
    case "AgentCapabilities":
      d.promptCaps = { image: k.image, embeddedContext: k.embedded_context };
      return;
    case "TurnEnded":
      if (d.turnStartedAt !== null) stampDuration(c, e.ts_ms - d.turnStartedAt);
      d.turnId = null;
      d.turnStartedAt = null;
      d.lastTurnErrored = k.stop_reason === "error";
      if (k.stop_reason !== "end_turn") notice(k.stop_reason === "error" ? "error" : "info", `Turn stopped: ${k.stop_reason}`);
      return;
    case "AgentMessageChunk":
      appendText(c, "agent", k.text, id, e.ts_ms);
      return;
    case "AgentThoughtChunk":
      appendText(c, "thought", k.text, id, e.ts_ms);
      return;
    case "ToolCall": {
      const idx = toolIndex(c);
      const existing = idx.get(k.tool_call_id);
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
        parent: k.parent_tool_call_id ?? (existing !== undefined ? (d.items[existing] as Tool).parent : null),
        background: existing !== undefined ? (d.items[existing] as Tool).background : false,
        report: k.report ?? null,
        harnessTool: k.harness_tool ?? null,
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
        type: "tool", id: k.tool_call_id, title: "Tool call", kind: null, status: null,
        content: [], locations: null, rawInput: null, rawOutput: null, parent: null, background: false, report: null, harnessTool: null,
      };
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
      };
      if (at === undefined) {
        idx.set(next.id, own(c).length);
        push(c, next);
      } else own(c)[at] = next;
      return;
    }
    case "TaskListUpdated":
      d.taskList = k.entries;
      return;
    case "ConfigOptionsChanged":
      if (Array.isArray(k.options)) d.configOptions = k.options as ConfigOption[];
      return;
    case "AvailableCommandsChanged":
      d.commands = k.commands;
      return;
    case "UsageUpdated": {
      const u = k.usage as { used?: number; size?: number } | null;
      if (typeof u?.used === "number" && typeof u?.size === "number") d.usage = { used: u.used, size: u.size };
      return;
    }
    case "SessionInfoUpdated":
      if (k.title) d.title = k.title;
      return;
    case "AgentProcessState": {
      const wasTurn = d.turnId !== null || d.lastTurnErrored;
      d.process = { state: k.state, message: k.message };
      if (k.state === "stopped") {
        // Archived/deleted stops are explained by SessionArchived; only idle needs a hint.
        if (k.message === "archived" || k.message === "deleted") return;
        notice("info", "Agent stopped while idle; it restarts on your next message");
        return;
      }
      if ((k.state === "failed" || k.state === "exited") && wasTurn) {
        d.lastTurnErrored = false;
        // The message may hold multi-line agent stderr after a blank line (rendered as Details).
        notice("error", k.message ? `Agent process ended unexpectedly\n\n${k.message}` : "Agent process ended unexpectedly");
      } else if (k.state === "failed" && k.message) {
        notice("error", `Agent failed\n\n${k.message}`);
      }
      return;
    }
    case "ThreadStarted":
      if (!k.main) d.forkedFrom = k.forked_from ?? null;
      return;
    case "ThreadWritableChanged":
      d.writable = k.writable;
      return;
    case "ThreadReadOnly":
      d.readOnly = true;
      return;
    case "AgentSessionStarted":
      d.startBoundary ??= k.boundary;
      // The Side Thread header says how it started; `initial` is no boundary.
      if (k.boundary === "initial" || k.boundary === "forked") return;
      if (k.boundary === "continued_with_summary") d.readOnly = false;
      notice("boundary", boundaryText(k.boundary));
      return;
    case "WorkspaceChanged":
      if (k.files.length === 0) return;
      push(c, { type: "changes", id, turnId: k.turn_id, fromTree: k.from_tree, toTree: k.to_tree, files: k.files });
      return;
    case "FrontendToolOutput": {
      let render: Extract<Item, { type: "frontend_tool" }>["render"] = null;
      if (k.tool === RENDER_UI) {
        const r = renderUiSchema.validate(k.input);
        render = r.valid
          ? { ok: true, value: k.input as RenderUiInput }
          : { ok: false, errors: r.errors.map((x) => `${x.instanceLocation} ${x.error}`) };
      }
      push(c, { type: "frontend_tool", id, ts: e.ts_ms, tool: k.tool, callId: k.call_id, path: k.path, input: k.input, files: k.files ?? {}, render });
      return;
    }
    case "AgentNotice":
      push(c, { type: "agent_notice", id, severity: k.severity, title: k.title, description: k.description });
      return;
    case "GitCommitted":
      notice("info", `Committed ${k.commit.slice(0, 7)}: ${k.message}`);
      return;
    case "GitPushed":
      notice("info", `Pushed ${k.branch}`);
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
      push(c, { type: "permission", id, requestId: k.request_id, toolCall: (k.tool_call ?? {}) as ToolCallRef, harnessTool: k.harness_tool ?? null, options: k.options, resolved: false });
      return;
    }
    case "PermissionResolved": {
      const at = permIndex(c).get(k.request_id);
      const i = at !== undefined ? d.items[at] : undefined;
      if (!i || i.type !== "permission") return;
      if (k.by !== "policy" && k.by !== "read_only_thread") own(c)[at!] = { ...i, resolved: true };
      else {
        const kind = i.options.find((o) => o.option_id === k.option_id)?.kind ?? "";
        own(c)[at!] = { ...i, resolved: true, auto: { allowed: kind.startsWith("allow"), ruleId: k.rule_id ?? null, ...(k.by === "read_only_thread" && { readOnlyThread: true }) } };
      }
      return;
    }
    case "PermissionRuleAdded":
      notice("info", `Remembered for this session: ${describeRule(k.rule)}`);
      return;
  }
}

export function boundaryText(b: string): string {
  switch (b) {
    case "resumed": return "Agent session resumed";
    case "loaded": return "Agent session reloaded";
    case "continued_with_summary": return "Continued in a new Agent session with a summary";
    case "reseeded": return "New Agent session started with the earlier context";
    case "agent_switched": return "Switched to a different Agent in a new session";
    default: return `New Agent session (${b.replace(/_/g, " ")})`;
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
  const target = r.pattern ? `\`${r.pattern}\`` : r.tool_kind ? `all ${r.tool_kind}` : "everything";
  return `${r.decision} ${target}`;
}

/** Readable title for Harness MCP permission requests; null for other requests. */
export function permissionTitle(toolCall: ToolCallRef, harnessTool: string | null = null): string | null {
  const input = toolCall.rawInput ?? {};
  switch (toolCall.kind) {
    case "git_push":
      return "Push branch to origin?";
    case "git_commit": {
      const msg = typeof input.message === "string" ? input.message : null;
      return msg ? `Commit all changes: "${msg}"?` : "Commit all changes?";
    }
    case "frontend_tool": {
      // The core titles these "Frontend tool: <name>".
      const name = /^Frontend tool:\s*(.+)$/.exec(toolCall.title ?? "")?.[1] ?? harnessTool;
      return name ? `Let the Agent use Frontend tool ${name}?` : "Let the Agent use a Frontend tool?";
    }
    default:
      return null;
  }
}
