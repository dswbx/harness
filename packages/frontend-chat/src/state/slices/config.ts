import type { Event } from "@harness/api";
import type { Ctx } from "../draft";
import type { ConfigOption } from "../types";

/** Config options, slash commands, the asking mode, and the last non-plan mode. */
export function configSlice(c: Ctx, e: Event) {
   const d = c.d;
   const k = e.kind;
   switch (k.type) {
      case "ConfigOptionsChanged":
         if (Array.isArray(k.options)) {
            d.configOptions = k.options as ConfigOption[];
            const mode = d.configOptions.find((o) => o.category === "mode")?.currentValue;
            if (mode && mode !== "plan") d.lastMode = mode;
         }
         d.sideMode = k.side_mode ?? null;
         return;
      case "AvailableCommandsChanged":
         d.commands = k.commands;
         return;
   }
}
