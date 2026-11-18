import { createContext } from "react";

/** Shows task `id` (the Tasks panel at that task). Null: the host cannot; task rows in the chat stay plain text. */
export const OpenTask = createContext<((id: string) => void) | null>(null);
