import type { ChatState } from "./types";

/** A permission (or plan) waits for the user: the Turn is open but the Agent is not working. */
export const waitsForUser = (s: Pick<ChatState, "turnId" | "items">) =>
   s.turnId !== null && s.items.some((i) => i.type === "permission" && !i.resolved && !i.auto);
