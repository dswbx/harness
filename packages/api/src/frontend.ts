import type { ComponentType } from "react";
import type { SessionApi } from "./client";
import type { FrontendManifest } from "./generated";

/** What a Frontend package exports: its Manifest and the View that renders a Session. */
export interface Frontend {
   manifest: FrontendManifest;
   /**
    * Host Session header slots a View may portal into (else it shows its own header): `toolbar` for actions (right),
    * `indicator` for one small status dot on the host's Session info icon, `status` for what that state means (at
    * the top of the info menu; it exists only while the menu is open), `menu` for entries of the header's gear menu (it exists
    * only while that menu is open; entries are `MenuButton`s, which close it).
    */
   View: ComponentType<{
      api: SessionApi;
      toolbar?: HTMLElement | null;
      status?: HTMLElement | null;
      indicator?: HTMLElement | null;
      menu?: HTMLElement | null;
   }>;
}
