import { createContext } from "react";

/**
 * True inside a `ContextMenuContent`, false inside a `DropdownMenuContent`. The item-level `DropdownMenu*`
 * parts read it and render the context-menu part there, so one item list can fill both kinds of menu.
 */
export const InContextMenu = createContext(false);
