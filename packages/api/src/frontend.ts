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

/** What a Frontend package exports: its Manifest and the View that renders a Session. */
export interface Frontend {
   manifest: FrontendManifest;
   /**
    * Host Session header slots a View may portal into (else it shows its own header): `toolbar` for actions (right),
    * `status` for state badges (left, after the title), `menu` for entries of the header's gear menu (it exists
    * only while that menu is open; entries are `MenuButton`s, which close it).
    */
   View: ComponentType<{
      api: SessionApi;
      toolbar?: HTMLElement | null;
      status?: HTMLElement | null;
      menu?: HTMLElement | null;
   }>;
   /**
    * Answers one request. The host mounts it apart from the View, as the Session may not be on screen, and only
    * for as long as it takes. It can render off screen but shows nothing.
    */
   Request?: ComponentType<FrontendRequestProps>;
}
