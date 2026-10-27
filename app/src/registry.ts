import type { Frontend } from "@harness/api";
import { frontend as chat } from "@harness/frontend-chat";
import { frontend as inspector } from "@harness/frontend-inspector";

/** Static Frontend registry: Session.frontend_id -> Frontend module. */
export const registry: Record<string, Frontend> = {
  [chat.manifest.id]: chat,
  [inspector.manifest.id]: inspector,
};
