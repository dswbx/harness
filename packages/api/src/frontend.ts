import type { ComponentType } from "react";
import type { FrontendManifest } from "./generated";
import type { SessionApi } from "./client";

/** What a Frontend package exports: its Manifest and the View that renders a Session. */
export interface Frontend {
  manifest: FrontendManifest;
  View: ComponentType<{ api: SessionApi }>;
}
