import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, Search } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger, cn } from "@harness/ui";

export type PickItem = {
  key: string;
  content: ReactNode;
  onSelect: () => void;
  /** Heading shown above the first item of each section. */
  section?: string;
  /** Divider above (e.g. a trailing "Choose another…" action). */
  separated?: boolean;
  selected?: boolean;
  disabled?: boolean;
};

/**
 * A combobox: a trigger that opens a popover with an optional filter field and a list driven by
 * arrow keys and Enter. Filtering is the caller's (it passes the filtered `items`).
 */
export function Picker({
  open, onOpenChange, trigger, items, search, header, empty = "Nothing found", hint, label,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  trigger: ReactNode;
  items: PickItem[];
  search?: { value: string; onChange: (v: string) => void; placeholder: string; mono?: boolean };
  /** Above the list, under the filter (e.g. filter chips). */
  header?: ReactNode;
  empty?: ReactNode;
  /** Muted line under the list. */
  hint?: ReactNode;
  label: string;
}) {
  const [active, setActive] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const enabled = items.map((it, i) => (it.disabled ? -1 : i)).filter((i) => i >= 0);
  const firstSelected = items.findIndex((it) => it.selected && !it.disabled);

  // Start on the selected item when opening, on the first match while filtering.
  useEffect(() => {
    if (open) setActive(search?.value ? (enabled[0] ?? 0) : firstSelected >= 0 ? firstSelected : (enabled[0] ?? 0));
  }, [open, search?.value, items.length]);

  useEffect(() => {
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const move = (d: 1 | -1) => {
    if (!enabled.length) return;
    const at = enabled.indexOf(active);
    setActive(enabled[(at + d + enabled.length) % enabled.length]!);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      move(e.key === "ArrowDown" ? 1 : -1);
    } else if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) {
      const it = items[active];
      if (it && !it.disabled) {
        e.preventDefault();
        it.onSelect();
      }
    }
  };

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent matchTrigger className="flex max-h-[min(26rem,var(--radix-popover-content-available-height))] flex-col p-0" onKeyDown={onKeyDown}>
        {search && (
          <div className="flex items-center gap-2 border-b px-2.5">
            <Search className="size-4 shrink-0 text-muted-foreground" />
            <input
              autoFocus
              aria-label={search.placeholder}
              value={search.value}
              onChange={(e) => search.onChange(e.target.value)}
              placeholder={search.placeholder}
              className={cn("h-9 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground", search.mono && "font-mono text-[13px]")}
            />
          </div>
        )}
        {header}
        <div ref={list} role="listbox" aria-label={label} tabIndex={search ? undefined : -1} className="min-h-0 flex-1 overflow-y-auto p-1 outline-none">
          {items.length === 0 && <div className="px-3 py-6 text-center text-sm text-muted-foreground">{empty}</div>}
          {items.map((it, i) => (
            <div key={it.key}>
              {it.separated && <div className="-mx-1 my-1 h-px bg-border" />}
              {it.section && it.section !== items[i - 1]?.section && (
                <div className="px-2 pb-1 pt-2 text-xs font-medium text-muted-foreground">{it.section}</div>
              )}
              <button
                type="button"
                role="option"
                aria-selected={!!it.selected}
                data-index={i}
                disabled={it.disabled}
                tabIndex={-1}
                onMouseMove={() => active !== i && !it.disabled && setActive(i)}
                onClick={it.onSelect}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none disabled:opacity-50",
                  i === active && "bg-accent text-accent-foreground",
                )}
              >
                {it.content}
              </button>
            </div>
          ))}
        </div>
        {hint && <div className="border-t px-3 py-2 text-xs text-muted-foreground">{hint}</div>}
      </PopoverContent>
    </Popover>
  );
}

/** The closed state of a picker, one line like an input: icon, title, muted subtitle, chevron. Forwards trigger props. */
export function FieldButton({
  icon, title, subtitle, placeholder, className, ...props
}: { icon: ReactNode; title?: ReactNode; subtitle?: ReactNode; placeholder?: string } & Omit<React.ComponentProps<"button">, "title">) {
  return (
    <button
      type="button"
      className={cn(
        "flex h-9 w-full min-w-0 items-center gap-2 rounded-md border border-input bg-transparent px-3 text-left text-sm shadow-xs outline-none transition-colors hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:ring-2 data-[state=open]:ring-ring disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <span className="flex shrink-0 text-muted-foreground [&_svg]:size-4">{icon}</span>
      <span className="flex min-w-0 flex-1 items-baseline gap-2">
        {title ? <span className="min-w-0 truncate">{title}</span> : <span className="text-muted-foreground">{placeholder}</span>}
        {subtitle && <span className="min-w-0 shrink-[10] truncate text-xs text-muted-foreground">{subtitle}</span>}
      </span>
      <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
    </button>
  );
}
