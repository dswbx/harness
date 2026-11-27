import type { ComponentType, ReactNode } from "react";
import type { HarnessClient } from "../client/app";
import type { GitSource, SessionApi } from "../client/client";
import type {
   AppEvent,
   AttachmentInput,
   FrontendManifest,
   InstructionsScope,
   SessionStatus,
   SharedArtifactMeta,
} from "../generated";
import type { DiffScope } from "../platform/diffWindow";

/** A call of a Frontend Tool with `replies`: the Frontend answers it, and the Agent gets the answer. */
export type FrontendRequest = Extract<AppEvent, { type: "FrontendRequest" }>;
/** `onDone`: the answer is sent, this can unmount. */
export type FrontendRequestProps = {
   api: SessionApi;
   request: FrontendRequest;
   onDone: () => void;
};

/**
 * The Agent > model menu of a Quick Session not used yet (the Quick overlay's draft, or one started from the
 * main window's Quick group). Before the first message the user can pick another Agent (the draft Session is
 * replaced); after it the overlay keeps the menu but `locked`, the main window drops it.
 */
export type AgentSwitch = {
   agents: { id: string; name: string }[];
   current: string;
   /** The Session has started: other Agents show disabled (close the overlay to switch). */
   locked?: boolean;
   /** The host replaces the draft Session with one of this Agent. */
   onPick: (agentId: string) => void;
};

/**
 * What the user is looking at in another app while the Quick overlay is open (ADR 0022 Phase 3), as a
 * removable chip in the prompt box. While the chip shows, each message sends `attachment` with it (the
 * typed text stays as it is); nothing is sent once removed.
 */
export type PromptContext = {
   /** Short, e.g. "Chrome · github.com/dswbx/harness/pull/52". */
   label: string;
   /** All details, for the tooltip. */
   detail?: string;
   /** Sent with each message while the chip shows (a Markdown file). */
   attachment: AttachmentInput;
   onRemove: () => void;
   /** A small link in the chip, e.g. "Allow more context". */
   action?: { label: string; onClick: () => void };
};

/** Widths (logical px) of what the Quick overlay's View shows left and right of its chat: open panels and stripes. */
export type PanelWidth = { left: number; right: number };

/**
 * The Quick overlay's chat geometry (logical px): the chat card's fixed width, and the room the window has
 * beside it now (`room`, granted by the host after `onPanelWidth`). The View draws a side's panels only once
 * the room is there, and never sizes the card from the window's width.
 */
export type OverlayFrame = { card: number; room: PanelWidth };

/** `full`: a main or pop-out window. `overlay`: the Quick overlay's small floating window (ADR 0022). */
export type ViewVariant = "full" | "overlay";

/** A Folder Diff window: `folder` (absolute) at `scope`, read through `git`. */
export type FolderDiffProps = { folder: string; git: GitSource; scope: DiffScope };

/**
 * A Shared Artifact in the host's main pane, without a Session (ADR 0024). Everything the host owns
 * (picking a Session, creating one, the window controls) comes in as a callback or a node.
 */
export type SharedViewProps = {
   client: HarnessClient;
   id: string;
   /** For Session titles in "Attached in"; Sessions not listed show as "Session". */
   sessions: readonly { id: string; title: string }[];
   onOpenSession: (sessionId: string) => void;
   /** "Attach to Session...": the host asks which Session. */
   onAttach: () => void;
   /** "New Session with it": the host creates a Session, then attaches the artifact. */
   onNewSession: () => void;
   onRenamed?: (meta: SharedArtifactMeta) => void;
   onDeleted?: (id: string) => void;
   /** Opens the artifact's folder in the user's editor; default: shows it in the file manager. */
   onOpenInEditor?: (dir: string) => void;
   /** Before the title in the header, e.g. the host's window controls when its sidebar is hidden. */
   leading?: ReactNode;
};

/**
 * The host's All tasks view (ADR 0028) in its main pane: every task, filtered and grouped, with the selected
 * one in a preview. The selection is the host's (it opens the view at a task); the rest is the Frontend's.
 */
export type TasksViewProps = {
   client: HarnessClient;
   /** The task in the preview; null: none, the list takes the full width. */
   selected: string | null;
   onSelect: (taskId: string | null) => void;
   /** For origin Session titles and their status dot; a Session not listed shows as deleted. */
   sessions: readonly { id: string; title: string; status?: SessionStatus }[];
   onOpenSession: (sessionId: string) => void;
   /** Starts a Session from a task (the host's dialog). Absent: the view offers none. */
   onStartFromTask?: (taskId: string) => void;
   /** Before the title in the header, e.g. the host's window controls when its sidebar is hidden. */
   leading?: ReactNode;
};

/**
 * A preference of a Frontend, drawn by the host's Settings > Appearance as a switch row in `group`:
 * `chat` (how Sessions read) or `terminal`. The value lives in the Frontend (`useValue`, `set`).
 */
export type FrontendToggle = {
   id: string;
   group: "chat" | "terminal";
   label: string;
   /** Text of the switch itself. */
   toggleLabel: string;
   help?: string;
   useValue: () => boolean;
   set: (on: boolean) => void;
};

/** A Markdown text editor a Frontend lends the host (Settings > Instructions). */
export type MarkdownEditorProps = {
   /** The text it starts with; mount it again (a new `key`) to load another. */
   initial: string;
   /** Markdown after each change. */
   onChange: (markdown: string) => void;
   placeholder?: string;
   /** Accessible name. */
   label?: string;
};

/** What a Frontend package exports: its Manifest and the View that renders a Session. */
export interface Frontend {
   manifest: FrontendManifest;
   /**
    * Host Session header slots a View may portal into (else it shows its own header): `toolbar` for actions (right),
    * `indicator` for one small status dot on the host's Session info icon, `status` for what that state means (at
    * the top of the info menu; it exists only while the menu is open), `menu` for entries of the header's gear menu (it exists
    * only while that menu is open; entries are `MenuButton`s, which close it). `onGitRefresh` reloads the host's git info
    * (the header's branch and PR); call it when the user asks the View to refresh.
    */
   View: ComponentType<{
      api: SessionApi;
      toolbar?: HTMLElement | null;
      status?: HTMLElement | null;
      indicator?: HTMLElement | null;
      menu?: HTMLElement | null;
      onGitRefresh?: () => void;
      /**
       * `overlay`: no header of its own (the host draws it), only side panel zones (ADR 0022 Phase 2);
       * before the first message, only the prompt box. Default `full`.
       */
      variant?: ViewVariant;
      /** Overlay only: wraps the chat column in the host's card (header, border, resize grip). Panels and stripes stay outside it. */
      chatFrame?: (chat: ReactNode) => ReactNode;
      /** Overlay only: the room the panels and stripes want beside the chat; the host widens its window by that much. */
      onPanelWidth?: (width: PanelWidth) => void;
      /** Overlay only: the chat card's width and the room beside it. */
      overlayFrame?: OverlayFrame;
      /** Shown as a two-level Agent > model menu in the prompt box (a Quick Session not used yet). */
      agentSwitch?: AgentSwitch;
      /** Quick overlay only: a context chip in the prompt box; each message sends its attachment. */
      context?: PromptContext;
      /**
       * Opens a Shared Artifact without a Session (ADR 0024), e.g. the app's Shared Artifact view.
       * Absent: the View offers no "Open outside Session".
       */
      onOpenShared?: (id: string) => void;
      /**
       * Opens another Session by id (a sub session from its parent's trace, or the parent from a child's
       * "from" label). Absent: those show as plain text.
       */
      onOpenSession?: (sessionId: string) => void;
      /** Opens the host's All tasks view (ADR 0028), at a task when given. Absent: the View offers none. */
      onOpenTasks?: (taskId?: string) => void;
      /** Opens the host's Settings at these Custom Instructions. Absent: the View offers no "Edit instructions". */
      onOpenInstructions?: (scope: InstructionsScope) => void;
      /** Starts a Session from a task (the host's dialog). Absent: the View offers none. */
      onStartFromTask?: (taskId: string) => void;
      /**
       * The host's Sessions, for live Session titles (a task's origin and linked Sessions, a panel window's
       * session chip with the folder's name); a Session not listed shows as deleted. Absent: the titles the
       * tasks stored.
       */
      sessions?: readonly {
         id: string;
         title: string;
         status?: SessionStatus;
         folder?: string;
         quick?: boolean;
      }[];
   }>;
   /**
    * Answers one request. The host mounts it apart from the View, as the Session may not be on screen, and only
    * for as long as it takes. It can render off screen but shows nothing.
    */
   Request?: ComponentType<FrontendRequestProps>;
   /** Renders a Shared Artifact in the host's main pane. Absent: the host opens none with this Frontend. */
   SharedView?: ComponentType<SharedViewProps>;
   /** Renders a Folder Diff window: the diff of a folder's repository, with no Session (no comments). Absent: the host shows a notice. */
   FolderDiff?: ComponentType<FolderDiffProps>;
   /** Renders the All tasks view in the host's main pane. Absent: the host has no such view. */
   TasksView?: ComponentType<TasksViewProps>;
   /** Its preferences, as rows in Settings > Appearance. Absent: none. */
   toggles?: FrontendToggle[];
   /** A catalog page of what the Agent can render (Settings > UI components). Absent: no such page. */
   Gallery?: ComponentType;
   /** Its Markdown editor (the prompt box's, Enter makes a new line), for the host's own text fields. Absent: a plain text area. */
   MarkdownEditor?: ComponentType<MarkdownEditorProps>;
}
