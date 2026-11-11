import type { AgentSwitch } from "@harness/api";
import {
   cn,
   DropdownMenu,
   DropdownMenuContent,
   DropdownMenuItem,
   DropdownMenuLabel,
   DropdownMenuRadioGroup,
   DropdownMenuRadioItem,
   DropdownMenuSeparator,
   DropdownMenuSub,
   DropdownMenuSubContent,
   DropdownMenuSubTrigger,
   DropdownMenuSwitchItem,
   DropdownMenuTrigger,
   Tooltip,
} from "@harness/ui";
import {
   Bot,
   Brain,
   ChevronDown,
   Info,
   MoreHorizontal,
   Shield,
   SlidersHorizontal,
   Zap,
} from "lucide-react";
import { useMemo } from "react";
import {
   type ConfigGroups,
   chipLabel,
   fastOn,
   groupConfigOptions,
   isToggle,
   toggleKind,
   valueName,
} from "./configGroups";
import type { ConfigOption } from "./reducer";

type OnChange = (id: string, value: string) => void;

/** Where the menus open: above the prompt box, or below it (the Quick overlay's draft, ADR 0022). Radix flips a menu with no room. */
export type MenuSide = "top" | "bottom";

const trigger =
   "inline-flex h-7 max-w-56 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground outline-none hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-accent data-[state=open]:text-accent-foreground";

/** Footer controls for the Agent's config options: Mode, Model chip, and a "More options" menu. */
export function ConfigBar({
   options,
   onChange,
   compact = false,
   modeOnly = false,
   agentSwitch,
   side = "top",
}: {
   options: ConfigOption[];
   onChange: OnChange;
   /** Narrow prompt box: everything in one "Options" menu. */
   compact?: boolean;
   /** Only the Mode picker (Side Threads own just their mode). */
   modeOnly?: boolean;
   /** Quick overlay: one Agent > model menu, then the Mode chip (same before and after send). */
   agentSwitch?: AgentSwitch;
   side?: MenuSide;
}) {
   const g = useMemo(() => groupConfigOptions(options), [options]);
   const label = chipLabel(g);
   if (modeOnly)
      return g.mode ? (
         <ModePicker o={g.mode} onChange={onChange} compact={compact} side={side} />
      ) : null;
   if (agentSwitch)
      return (
         <>
            <AgentModelMenu
               g={g}
               label={label}
               agentSwitch={agentSwitch}
               onChange={onChange}
               side={side}
            />
            {g.mode && <ModePicker o={g.mode} onChange={onChange} compact side={side} />}
         </>
      );
   if (compact) return <CompactBar g={g} label={label} onChange={onChange} side={side} />;
   return (
      <>
         {g.mode && <ModePicker o={g.mode} onChange={onChange} side={side} />}
         {g.model && label && (
            <DropdownMenu>
               <DropdownMenuTrigger className={trigger} aria-label={`${g.model.name}: ${label}`}>
                  <span className="truncate">{label}</span>
                  {fastOn(g) && (
                     <Zap
                        className="size-3.5 shrink-0 fill-yellow-400 text-yellow-400"
                        aria-label="Fast mode on"
                     />
                  )}
                  <ChevronDown className="size-3 shrink-0 opacity-60" />
               </DropdownMenuTrigger>
               <DropdownMenuContent side={side} align="start" className="w-64">
                  <OptionHeader o={g.model} />
                  <Values o={g.model} onChange={onChange} />
                  {(g.effort || g.chipSubmenus.length > 0 || g.chipToggles.length > 0) && (
                     <DropdownMenuSeparator />
                  )}
                  {g.effort && <OptionSub o={g.effort} label="Effort" onChange={onChange} />}
                  {g.chipSubmenus.map((o) => (
                     <OptionSub key={o.id} o={o} onChange={onChange} />
                  ))}
                  {g.chipToggles.map((o) => (
                     <OptionRow key={o.id} o={o} onChange={onChange} />
                  ))}
               </DropdownMenuContent>
            </DropdownMenu>
         )}
         {g.more.length > 0 && (
            <DropdownMenu>
               <Tooltip content="More options">
                  <DropdownMenuTrigger className={trigger} aria-label="More options">
                     <MoreHorizontal className="size-4" />
                  </DropdownMenuTrigger>
               </Tooltip>
               <DropdownMenuContent side={side} align="start" className="w-64">
                  {g.more.map((o) => (
                     <OptionRow key={o.id} o={o} onChange={onChange} />
                  ))}
               </DropdownMenuContent>
            </DropdownMenu>
         )}
      </>
   );
}

/** The Mode chip with its values menu. */
function ModePicker({
   o,
   onChange,
   compact = false,
   side,
}: {
   o: ConfigOption;
   onChange: OnChange;
   compact?: boolean;
   side: MenuSide;
}) {
   return (
      <DropdownMenu>
         <DropdownMenuTrigger
            className={cn(trigger, compact && "max-w-32 min-w-0")}
            aria-label={`${o.name}: ${valueName(o)}`}
         >
            <Shield className="size-3.5 shrink-0" />
            <span className="truncate">{valueName(o)}</span>
            <ChevronDown className="size-3 shrink-0 opacity-60" />
         </DropdownMenuTrigger>
         <DropdownMenuContent side={side} align="start" className="w-72">
            <OptionHeader o={o} />
            <Values o={o} onChange={onChange} />
         </DropdownMenuContent>
      </DropdownMenu>
   );
}

/**
 * Agents at the first level; the current Agent's submenu has its models (and effort). Another
 * Agent's models are known only once it runs, so picking it replaces the draft Session.
 */
function AgentModelMenu({
   g,
   label,
   agentSwitch,
   onChange,
   side,
}: {
   g: ConfigGroups;
   label: string | null;
   agentSwitch: AgentSwitch;
   onChange: OnChange;
   side: MenuSide;
}) {
   const current = agentSwitch.agents.find((a) => a.id === agentSwitch.current);
   const name = current?.name ?? "Agent";
   return (
      <DropdownMenu>
         <DropdownMenuTrigger
            className={cn(trigger, "min-w-0")}
            aria-label={label ? `Agent and model: ${name}, ${label}` : `Agent: ${name}`}
         >
            <Bot className="size-3.5 shrink-0" />
            <span className="truncate">
               {name}
               {label && <span className="opacity-70"> · {label}</span>}
            </span>
            {fastOn(g) && (
               <Zap
                  className="size-3.5 shrink-0 fill-yellow-400 text-yellow-400"
                  aria-label="Fast mode on"
               />
            )}
            <ChevronDown className="size-3 shrink-0 opacity-60" />
         </DropdownMenuTrigger>
         <DropdownMenuContent side={side} align="start" className="w-72">
            <DropdownMenuLabel>Agent</DropdownMenuLabel>
            {agentSwitch.agents.map((a) =>
               a.id === agentSwitch.current ? (
                  <DropdownMenuSub key={a.id}>
                     <DropdownMenuSubTrigger>
                        <span className="flex-1 truncate font-medium">{a.name}</span>
                        <span className="max-w-28 truncate text-xs text-muted-foreground">
                           {label ?? "Starting..."}
                        </span>
                     </DropdownMenuSubTrigger>
                     <DropdownMenuSubContent className="w-60">
                        {g.model ? (
                           <>
                              <OptionHeader o={g.model} />
                              <Values o={g.model} onChange={onChange} />
                           </>
                        ) : (
                           <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                              The models show once the Agent has started.
                           </DropdownMenuLabel>
                        )}
                        {g.effort && (
                           <>
                              <DropdownMenuSeparator />
                              <OptionSub o={g.effort} label="Effort" onChange={onChange} />
                           </>
                        )}
                        {g.chipToggles.map((o) => (
                           <OptionRow key={o.id} o={o} onChange={onChange} />
                        ))}
                     </DropdownMenuSubContent>
                  </DropdownMenuSub>
               ) : (
                  <DropdownMenuItem
                     key={a.id}
                     disabled={agentSwitch.locked}
                     onSelect={() => agentSwitch.onPick(a.id)}
                  >
                     <span className="flex-1 truncate">{a.name}</span>
                     <span className="text-xs text-muted-foreground">
                        {agentSwitch.locked ? "Close to switch Agent" : "Pick to load models"}
                     </span>
                  </DropdownMenuItem>
               ),
            )}
         </DropdownMenuContent>
      </DropdownMenu>
   );
}

/** One menu with all options as rows: Mode, Model (+ Effort), the model's own options, then the rest. */
function CompactBar({
   g,
   label,
   onChange,
   side,
}: {
   g: ConfigGroups;
   label: string | null;
   onChange: OnChange;
   side: MenuSide;
}) {
   if (!g.mode && !g.model && g.more.length === 0) return null;
   return (
      <DropdownMenu>
         <Tooltip content="Options">
            <DropdownMenuTrigger
               className={cn(trigger, "max-w-40 min-w-0")}
               aria-label={label ? `Options: ${label}` : "Options"}
            >
               <SlidersHorizontal className="size-3.5 shrink-0" />
               {label && <span className="truncate">{label}</span>}
               {fastOn(g) && (
                  <Zap
                     className="size-3.5 shrink-0 fill-yellow-400 text-yellow-400"
                     aria-label="Fast mode on"
                  />
               )}
               <ChevronDown className="size-3 shrink-0 opacity-60" />
            </DropdownMenuTrigger>
         </Tooltip>
         <DropdownMenuContent side={side} align="start" className="w-64">
            {g.mode && <OptionSub o={g.mode} onChange={onChange} />}
            {g.model && <OptionSub o={g.model} onChange={onChange} />}
            {g.effort && <OptionSub o={g.effort} label="Effort" onChange={onChange} />}
            {g.chipSubmenus.map((o) => (
               <OptionSub key={o.id} o={o} onChange={onChange} />
            ))}
            {g.chipToggles.map((o) => (
               <OptionRow key={o.id} o={o} onChange={onChange} />
            ))}
            {g.more.length > 0 && (g.mode || g.model) && <DropdownMenuSeparator />}
            {g.more.map((o) => (
               <OptionRow key={o.id} o={o} onChange={onChange} />
            ))}
         </DropdownMenuContent>
      </DropdownMenu>
   );
}

/** Menu header: option name, its description behind an "i" icon. */
function OptionHeader({ o, name }: { o: ConfigOption; name?: string }) {
   return (
      <DropdownMenuLabel className="flex items-center gap-1.5">
         <span>{name ?? o.name}</span>
         {o.description && (
            <Tooltip content={o.description} side="top" align="start">
               <span
                  role="img"
                  aria-label={o.description}
                  className="text-muted-foreground/70 hover:text-foreground"
               >
                  <Info className="size-3.5" />
               </span>
            </Tooltip>
         )}
      </DropdownMenuLabel>
   );
}

/** Radio list of an option's values (name + description, check on the current one). */
function Values({ o, onChange }: { o: ConfigOption; onChange: OnChange }) {
   return (
      <DropdownMenuRadioGroup
         value={o.currentValue}
         onValueChange={(v) => v !== o.currentValue && onChange(o.id, v)}
      >
         {o.options.map((v) => (
            <Tooltip key={v.value} content={v.description} side="right">
               <DropdownMenuRadioItem value={v.value} aria-description={v.description ?? undefined}>
                  <span className="truncate">{v.name}</span>
               </DropdownMenuRadioItem>
            </Tooltip>
         ))}
      </DropdownMenuRadioGroup>
   );
}

/** Switch row for on/off options, else a submenu row. */
function OptionRow({ o, onChange }: { o: ConfigOption; onChange: OnChange }) {
   const t = isToggle(o);
   if (!t) return <OptionSub o={o} onChange={onChange} />;
   const kind = toggleKind(o);
   return (
      <Tooltip content={o.description} side="right">
         <DropdownMenuSwitchItem
            checked={o.currentValue === t.on}
            onCheckedChange={(c) => onChange(o.id, c ? t.on : t.off)}
            onSelect={(e) => e.preventDefault()}
            aria-description={o.description ?? undefined}
         >
            {kind === "fast" && (
               <Zap
                  className={cn(
                     "size-4",
                     o.currentValue === t.on ? "text-yellow-400" : "text-muted-foreground",
                  )}
               />
            )}
            {kind === "think" && <Brain className="size-4 text-muted-foreground" />}
            <span className="truncate">{o.name}</span>
         </DropdownMenuSwitchItem>
      </Tooltip>
   );
}

/** Submenu row: name left, current value right; radio items inside. */
function OptionSub({
   o,
   label,
   onChange,
}: {
   o: ConfigOption;
   label?: string;
   onChange: OnChange;
}) {
   return (
      <DropdownMenuSub>
         <DropdownMenuSubTrigger aria-description={o.description ?? undefined}>
            <span className="flex-1 truncate">{label ?? o.name}</span>
            <span className="max-w-28 truncate text-xs text-muted-foreground">{valueName(o)}</span>
         </DropdownMenuSubTrigger>
         <DropdownMenuSubContent className="w-60">
            <OptionHeader o={o} />
            <Values o={o} onChange={onChange} />
         </DropdownMenuSubContent>
      </DropdownMenuSub>
   );
}
