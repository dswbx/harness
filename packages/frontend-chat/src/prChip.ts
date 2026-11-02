/**
 * Popover state of a PR chip. `hover`: the mouse (or focus) is on the chip or its popover. `pinned`: opened by click or
 * Enter/Space, stays open until a click outside, Esc or another click on the chip. `dismissed`: closed by Esc or a
 * click outside while the prompt caret is still next to the chip (else `active` would keep it open).
 */
export type ChipPopover = { hover: boolean; pinned: boolean; dismissed: boolean };
export type ChipPopoverAction =
  | { type: "hover"; on: boolean }
  | { type: "toggle" }
  | { type: "close" }
  /** The prompt caret left the chip: the next time it comes back the popover opens again. */
  | { type: "inactive" };

export const closedChip: ChipPopover = { hover: false, pinned: false, dismissed: false };

export function chipPopover(s: ChipPopover, a: ChipPopoverAction): ChipPopover {
  switch (a.type) {
    case "hover":
      return s.hover === a.on ? s : { ...s, hover: a.on };
    case "toggle":
      return s.pinned ? { hover: false, pinned: false, dismissed: true } : { ...s, pinned: true, dismissed: false };
    case "close":
      return { hover: false, pinned: false, dismissed: true };
    case "inactive":
      return s.dismissed ? { ...s, dismissed: false } : s;
  }
}

/** `active`: the prompt caret is next to the chip. */
export const chipOpen = (s: ChipPopover, active: boolean) => s.hover || s.pinned || (active && !s.dismissed);

/** What a click on a chip does: Cmd/Ctrl+click opens the PR on GitHub, a plain click pins the popover. */
export const chipClick = (e: { metaKey: boolean; ctrlKey: boolean }): "open" | "pin" => (e.metaKey || e.ctrlKey ? "open" : "pin");
