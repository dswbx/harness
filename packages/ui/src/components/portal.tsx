import type * as React from "react";
import { createPortal } from "react-dom";

/** Renders children into `container` (e.g. a host-provided toolbar slot); renders `fallback` while there is none. */
function Portal({ container, children, fallback = null }: { container: Element | null | undefined; children: React.ReactNode; fallback?: React.ReactNode }) {
  return container ? createPortal(children, container) : fallback;
}

export { Portal };
