import type { ComponentType } from "react";
import type { FrontendManifest } from "./generated";
import type { SessionApi } from "./client";

/** What a Frontend package exports: its Manifest and the View that renders a Session. */
export interface Frontend {
  manifest: FrontendManifest;
  /** `toolbar`: the host's Session header slot; a View may portal its own actions into it (else it shows its own header). */
  View: ComponentType<{ api: SessionApi; toolbar?: HTMLElement | null }>;
}
