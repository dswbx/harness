import { createContext } from "react";

/** Shows Terminal tab `id` (opens the Terminal panel at it). Null: the View has no Terminal panel. */
export const OpenTerminal = createContext<((id: number) => void) | null>(null);
