import { createContext } from "react";

/** The Turn waits for the user (a permission or plan is pending): background subagents stop showing as running. */
export const WaitingForUser = createContext(false);
