import { createContext, useContext, useEffect } from "react";

/**
 * A step to open in the chat (e.g. a click in the Subagents panel): the steps from its row's down to it
 * (`placeSteps`). `nonce` changes on every request, so the same step opens again after the user closed it.
 */
export type OpenStepRequest = { path: string[]; nonce: number };

export const OpenStep = createContext<OpenStepRequest | null>(null);

/**
 * Calls `open` when the request names step `id`: on the request, and on mount (the virtual list renders
 * the row only after the jump scrolls to it).
 */
export function useOpenStep(id: string, open: () => void) {
   const req = useContext(OpenStep);
   const hit = !!req?.path.includes(id);
   // biome-ignore lint/correctness/useExhaustiveDependencies: a new nonce is a new request.
   useEffect(() => {
      if (hit) open();
   }, [hit, req?.nonce]);
}
