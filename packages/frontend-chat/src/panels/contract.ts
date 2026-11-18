import type { SessionApi, SharedArtifactMeta, ViewVariant } from "@harness/api";
import type { ComponentType, LazyExoticComponent } from "react";
import type { ChatState } from "../state/reducer";

/** The panel contract: what a panel is, and what the host gives it. Imports no `shell/` or `features/`. */

/** A typed handle to a panel. `T` is what the panel can be opened at (`void`: nothing). */
export type PanelRef<T = void> = { readonly id: string; readonly _target?: (t: T) => void };

/** Where a panel starts. The dock maps it to a Zone; another layout maps it to its own first place. */
export type PlacementHint = { edge: "left" | "right" | "bottom"; end?: boolean };

/** `absent`: no icon, the panel keeps its place. `icon`: an icon, but nothing to show. `ready`: can show. */
export type PanelStatus = {
   presence: "absent" | "icon" | "ready";
   badge?: number;
   dot?: boolean;
   tip?: string;
};

/** What the host gives every panel. Changes identity only when one of its inputs does. */
export type PanelCtx = {
   api: SessionApi;
   state: ChatState;
   variant: ViewVariant;
   /** Shows a panel, at `target` when it takes one. */
   // biome-ignore lint/suspicious/noConfusingVoidType: `void` is the "no target" marker of a PanelRef
   open: <T>(ref: PanelRef<T>, ...target: [T] extends [void] ? [] : [T]) => void;
   hide: (ref: PanelRef<never>) => void;
   isOpen: (ref: PanelRef<never>) => boolean;
   /** The Main Thread's message list; null in a Frontend without one. */
   chat: {
      toRow(rowId: string, pick?: (row: Element) => Element | null | undefined): void;
      toStep(stepId: string): void;
   } | null;
   host: {
      /** Opens a Shared Artifact outside the Session (the host app). */
      openShared?: (id: string) => void;
      gitRefresh?: () => void;
      /** Meta of every Shared Artifact by id (titles, "N sessions"); missing while loading. */
      sharedMetas?: ReadonlyMap<string, SharedArtifactMeta>;
      /** Shows the panel of the Shared Artifact `id` (when one of the Session's panels shows it). */
      showShared?: (id: string) => void;
      /** Opens the dialog that starts a Session from task `taskId` (ADR 0028). Absent: no such button. */
      startFromTask?: (taskId: string) => void;
      /** Opens the host's All tasks view, at task `taskId` when given. Absent: no such button. */
      openTasks?: (taskId?: string) => void;
   };
};

/** One panel's view of its own place in the layout. */
export type PanelSelf<T = void> = {
   id: string;
   /** Open in the layout now (whether or not it can show). */
   open: boolean;
   /** Open at least once in this View. */
   opened: boolean;
   show(): void;
   hide(): void;
   /** Read it through `usePanelTarget`. */
   target: { value: T; seq: number } | null;
};

/** What a panel's `Body` gets. */
export type PanelBodyProps<M, T = void> = { model: M; ctx: PanelCtx; self: PanelSelf<T> };
type Body<M, T> = ComponentType<PanelBodyProps<M, T>>;

/** A panel: one value, built by `definePanel` in its feature folder. It is also the panel's typed handle. */
export type PanelDef<M = unknown, T = void> = PanelRef<T> & {
   label: string;
   icon: ComponentType<{ className?: string }>;
   placement: PlacementHint;
   shortcut?: { keys: string[]; match: (e: KeyboardEvent) => boolean };
   expandable?: boolean;
   /** `whenOpen` (default): mounted while open. `afterFirstOpen`: stays mounted once opened. `whileReady`: mounted while it can show. */
   mount?: "whenOpen" | "afterFirstOpen" | "whileReady";
   /** Shown in the Quick Overlay (default false). */
   overlay?: boolean;
   /** A hook that runs on every render, open or not: derived data, state that must survive hiding, auto-open effects. */
   useModel: (ctx: PanelCtx, self: PanelSelf<T>) => M;
   status: (model: M) => PanelStatus;
   /** Icon click while closed (default `self.show()`). */
   activate?: (model: M, self: PanelSelf<T>) => void;
   /** Opened at a target in a View that cannot show it. */
   fallback?: (ctx: PanelCtx, target: T) => void;
   Body: Body<M, T> | LazyExoticComponent<Body<M, T>>;
};

export const definePanel = <M, T = void>(d: PanelDef<M, T>) => d;

/** One panel of a family. Its id is `${prefix}:${key}`. */
export type FamilyInstance = {
   key: string;
   label: string;
   /** None: the host picks one for the place the panel is in. */
   icon?: PanelDef["icon"];
   placement: PlacementHint;
   status: PanelStatus;
   /** Shown in the Quick Overlay (default false). */
   overlay?: boolean;
   expandable?: boolean;
};

/**
 * Panels the Agent creates at runtime (the render_ui panels). Ids are `${prefix}:${key}`. One model for the
 * family; its instances are listed from it, mounted while open, and share one `Body`, told which instance it is.
 * An instance that goes away keeps its place in the layout and comes back there.
 */
export type PanelFamily<M = unknown> = {
   prefix: string;
   useModel: (ctx: PanelCtx) => M;
   instances: (model: M) => FamilyInstance[];
   Body: ComponentType<{ model: M; ctx: PanelCtx; self: PanelSelf; instance: string }>;
};

export const definePanelFamily = <M>(f: PanelFamily<M>) => f;
