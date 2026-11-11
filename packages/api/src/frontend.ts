import type { ComponentType } from "react";
import type { SessionApi } from "./client";
import type { AppEvent, FrontendManifest } from "./generated";

/** A call of a Frontend Tool with `replies`: the Frontend answers it, and the Agent gets the answer. */
export type FrontendRequest = Extract<AppEvent, { type: "FrontendRequest" }>;
/** `onDone`: the answer is sent, this can unmount. */
export type FrontendRequestProps = {
   api: SessionApi;
   request: FrontendRequest;
   onDone: () => void;
};

/**
 * The Quick overlay's Agent > model menu. Before the first message the user can pick another Agent
 * (the draft Session is replaced); after it the menu stays the same but is `locked`.
 */
export type AgentSwitch = {
   agents: { id: string; name: string }[];
   current: string;
   /** The Session has started: other Agents show disabled (close the overlay to switch). */
   locked?: boolean;
   /** The host replaces the draft Session with one of this Agent. */
   onPick: (agentId: string) => void;
};

/** `full`: a main or pop-out window. `overlay`: the Quick overlay's small floating window (ADR 0022). */
export type ViewVariant = "full" | "overlay";

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
       * `overlay`: no Panels or Stripes and no header of its own (the host draws it); before the
       * first message, only the prompt box. Default `full`.
       */
      variant?: ViewVariant;
      /** Shown as a two-level Agent > model menu in the prompt box (Quick overlay only). */
      agentSwitch?: AgentSwitch;
   }>;
   /**
    * Answers one request. The host mounts it apart from the View, as the Session may not be on screen, and only
    * for as long as it takes. It can render off screen but shows nothing.
    */
   Request?: ComponentType<FrontendRequestProps>;
}
