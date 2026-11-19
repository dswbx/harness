import type { InstructionsScope } from "@harness/api";
import { createContext } from "react";

/** Opens the host's Settings at these Custom Instructions. Null: the host cannot; offer nothing. */
export const OpenInstructions = createContext<((scope: InstructionsScope) => void) | null>(null);
