import type { ComponentType } from "react";
import type { FrontendManifest } from "./generated";
import type { SessionApi } from "./client";

/** What a Frontend package exports: its Manifest and the View that renders a Session. */
export interface Frontend {
  manifest: FrontendManifest;
  /**
   * Host Session header slots a View may portal into (else it shows its own header): `toolbar` for actions (right),
   * `status` for state badges (left, after the title), `menu` for entries of the header's gear menu (it exists
   * only while that menu is open; entries are `MenuButton`s, which close it).
   */
  View: ComponentType<{ api: SessionApi; toolbar?: HTMLElement | null; status?: HTMLElement | null; menu?: HTMLElement | null }>;
}
