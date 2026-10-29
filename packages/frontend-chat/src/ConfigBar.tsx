import { useMemo } from "react";
import { Brain, ChevronDown, Info, MoreHorizontal, Shield, Zap } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuSwitchItem,
  DropdownMenuTrigger,
  HoverTip,
  cn,
} from "@harness/ui";
import { chipLabel, fastOn, groupConfigOptions, isToggle, toggleKind, valueName } from "./configGroups";
import type { ConfigOption } from "./reducer";

type OnChange = (id: string, value: string) => void;

const trigger =
  "inline-flex h-7 max-w-56 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-accent data-[state=open]:text-foreground";

/** Footer controls for the Agent's config options: Mode, Model chip, and a "More options" menu. */
export function ConfigBar({ options, onChange }: { options: ConfigOption[]; onChange: OnChange }) {
  const g = useMemo(() => groupConfigOptions(options), [options]);
  const label = chipLabel(g);
  return (
    <>
      {g.mode && (
        <DropdownMenu>
          <DropdownMenuTrigger className={trigger} aria-label={`${g.mode.name}: ${valueName(g.mode)}`}>
            <Shield className="size-3.5 shrink-0" />
            <span className="truncate">{valueName(g.mode)}</span>
            <ChevronDown className="size-3 shrink-0 opacity-60" />
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" className="w-72">
            <OptionHeader o={g.mode} />
            <Values o={g.mode} onChange={onChange} />
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {g.model && label && (
        <DropdownMenu>
          <DropdownMenuTrigger className={trigger} aria-label={`${g.model.name}: ${label}`}>
            <span className="truncate">{label}</span>
            {fastOn(g) && <Zap className="size-3.5 shrink-0 fill-yellow-400 text-yellow-400" aria-label="Fast mode on" />}
            <ChevronDown className="size-3 shrink-0 opacity-60" />
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" className="w-64">
            <OptionHeader o={g.model} />
            <Values o={g.model} onChange={onChange} />
            {(g.effort || g.chipSubmenus.length > 0 || g.chipToggles.length > 0) && <DropdownMenuSeparator />}
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
          <DropdownMenuTrigger className={trigger} aria-label="More options" title="More options">
            <MoreHorizontal className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" className="w-64">
            {g.more.map((o) => (
              <OptionRow key={o.id} o={o} onChange={onChange} />
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </>
  );
}

/** Menu header: option name, its description behind an "i" icon. */
function OptionHeader({ o, name }: { o: ConfigOption; name?: string }) {
  return (
    <DropdownMenuLabel className="flex items-center gap-1.5">
      <span>{name ?? o.name}</span>
      {o.description && (
        <HoverTip content={o.description} side="top" align="start">
          <span role="img" aria-label={o.description} className="text-muted-foreground/70 hover:text-foreground">
            <Info className="size-3.5" />
          </span>
        </HoverTip>
      )}
    </DropdownMenuLabel>
  );
}

/** Radio list of an option's values (name + description, check on the current one). */
function Values({ o, onChange }: { o: ConfigOption; onChange: OnChange }) {
  return (
    <DropdownMenuRadioGroup value={o.currentValue} onValueChange={(v) => v !== o.currentValue && onChange(o.id, v)}>
      {o.options.map((v) => (
        <HoverTip key={v.value} content={v.description}>
          <DropdownMenuRadioItem value={v.value} aria-description={v.description ?? undefined}>
            <span className="truncate">{v.name}</span>
          </DropdownMenuRadioItem>
        </HoverTip>
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
    <HoverTip content={o.description}>
      <DropdownMenuSwitchItem
        checked={o.currentValue === t.on}
        onCheckedChange={(c) => onChange(o.id, c ? t.on : t.off)}
        onSelect={(e) => e.preventDefault()}
        aria-description={o.description ?? undefined}
      >
        {kind === "fast" && <Zap className={cn("size-4", o.currentValue === t.on ? "text-yellow-400" : "text-muted-foreground")} />}
        {kind === "think" && <Brain className="size-4 text-muted-foreground" />}
        <span className="truncate">{o.name}</span>
      </DropdownMenuSwitchItem>
    </HoverTip>
  );
}

/** Submenu row: name left, current value right; radio items inside. */
function OptionSub({ o, label, onChange }: { o: ConfigOption; label?: string; onChange: OnChange }) {
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
