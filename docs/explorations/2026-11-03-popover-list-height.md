# Popover lists: a flex column gives the ScrollArea viewport no definite height

2026-11-03. Chrome 142 (Tauri WebKit not tested), @radix-ui/react-scroll-area 1.x, Tailwind v4.

**Observed:** The Composer's branch picker (`app/src/Picker.tsx`) was `PopoverContent` as `flex flex-col max-h-[...]` with the `ScrollArea` as `min-h-0 flex-1`. With 30 branches the root was 303px tall but Radix's viewport (`height: 100%`) measured 951px: the last rows were clipped under the hint and nothing scrolled. The popover's height is auto capped by a max height, so it is not definite, so a flex item's post-flexing size is not definite either, and the viewport's percentage height resolves to auto.

Switching the content to `grid grid-rows-[auto_minmax(0,1fr)_auto]` fixed it: the `minmax(0,1fr)` track is re-resolved against the container's max height (CSS Grid §12.7.1), a grid area is definite, and the viewport gets 303px with 951px of scroll height.

**Assumed / unverified:** The same applies to any `ScrollArea` as a flex item inside a max-height container without a definite height. `max-h-[inherit]` on the viewport (the AGENTS.md rule) is the other way out when the root itself carries the max height.

**Open questions:** Whether WebKit in Tauri resolves the grid track the same way (the Flexbox spec allows treating the flexed size as definite, Chrome does not here).
