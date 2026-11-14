import { createContext } from "react";

/** Opens another Session (a sub session or its parent) in the host. Null: the host cannot; show plain text. */
export const OpenSession = createContext<((sessionId: string) => void) | null>(null);
