import type { SessionApi, ViewVariant } from "@harness/api";
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
   host: { openShared?: (id: string) => void; gitRefresh?: () => void };
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

type Body<M, T> = ComponentType<{ model: M; ctx: PanelCtx; self: PanelSelf<T> }>;

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

/** Panels the Agent creates at runtime. Ids are `${prefix}:${key}`. */
export type PanelFamily<M = unknown> = {
   prefix: string;
   useModel: (ctx: PanelCtx) => M;
   instances: (model: M) => (Omit<
      PanelDef<unknown>,
      "id" | "useModel" | "status" | "Body" | "icon" | "_target"
   > & {
      key: string;
      status: PanelStatus;
      icon?: PanelDef["icon"];
      Body: ComponentType<{ ctx: PanelCtx; self: PanelSelf }>;
   })[];
};
