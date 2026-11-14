import { announcedMode, type Event } from "@harness/api";
import type { Ctx } from "../draft";
import type { ConfigOption } from "../types";

/** Config options, slash commands, the asking mode, and (old logs only) the last non-plan mode. */
export function configSlice(c: Ctx, e: Event) {
   const d = c.d;
   const k = e.kind;
   switch (k.type) {
      case "ConfigOptionsChanged":
         if (Array.isArray(k.options)) {
            d.configOptions = k.options as ConfigOption[];
         }
         d.sideMode = k.side_mode ?? null;
         rememberMode(c, e);
         return;
      case "ModeChanged":
         rememberMode(c, e);
         return;
      case "AvailableCommandsChanged":
         d.commands = k.commands;
         return;
   }
}

/**
 * Old logs: the plan permission request has no `mode_before`, so remember the last non-plan mode
 * announced by Events without the core's typed `mode`. New logs never read it.
 */
function rememberMode(c: Ctx, e: Event) {
   const m = announcedMode(e.kind);
   if (m?.legacy && !m.mode.plan) c.d.lastMode = m.mode.id;
}
