import { useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@harness/ui";
import { THEMES, filterThemes, stepIndex, swatch } from "./appearance/appearance";

function Dots({ theme, isDark }: { theme: string; isDark: boolean }) {
  return (
    <span className="flex shrink-0 -space-x-1" aria-hidden>
      {swatch(theme, isDark).map((c, i) => (
        <span key={i} className="size-3.5 rounded-full border border-border" style={{ background: c }} />
      ))}
    </span>
  );
}

const NAV_KEYS = new Set(["ArrowUp", "ArrowDown", "Home", "End"]);

/**
 * Theme dropdown with a filter. Arrow keys / hover preview a theme (no save); Enter or click saves;
 * Escape, Tab or a click outside reverts. On the closed trigger, ArrowUp/Down step and save directly.
 * Escape inside is marked with `data-keep-escape` so the Settings dialog does not close.
 */
export function ThemePicker({ value, isDark, onPreview, onCommit, onRevert }: {
  value: string;
  isDark: boolean;
  onPreview: (id: string) => void;
  onCommit: (id: string) => void;
  onRevert: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [hi, setHi] = useState(-1);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();
  const items = filterThemes(THEMES, filter);
  const current = THEMES.find((t) => t.id === value) ?? THEMES[0]!;
  const optId = (i: number) => `${id}-opt-${i}`;

  const close = (revert: boolean, refocus = true) => {
    if (revert) onRevert();
    setOpen(false);
    if (refocus) trigger.current?.focus();
  };
  const commit = (i: number) => {
    const t = items[i];
    if (t) onCommit(t.id);
    close(!t);
  };
  const move = (i: number) => {
    setHi(i);
    const t = items[i];
    if (t) onPreview(t.id);
  };

  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => !root.current?.contains(e.target as Node) && close(true, false);
    document.addEventListener("pointerdown", down, true);
    return () => document.removeEventListener("pointerdown", down, true);
  });

  useEffect(() => {
    if (open && hi >= 0) list.current?.querySelector(`#${CSS.escape(optId(hi))}`)?.scrollIntoView({ block: "nearest" });
  }, [open, hi]);

  const toggle = () => {
    if (open) return close(true);
    setFilter("");
    setHi(THEMES.findIndex((t) => t.id === value));
    setOpen(true);
  };

  const onTriggerKey = (e: React.KeyboardEvent) => {
    if (open || !NAV_KEYS.has(e.key)) return;
    e.preventDefault();
    const t = THEMES[stepIndex(THEMES.findIndex((t) => t.id === value), e.key, THEMES.length)];
    if (t && t.id !== value) onCommit(t.id);
  };

  const onFilterKey = (e: React.KeyboardEvent) => {
    if (NAV_KEYS.has(e.key)) {
      e.preventDefault();
      move(stepIndex(hi, e.key, items.length));
    } else if (e.key === "Enter") {
      e.preventDefault();
      commit(hi);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close(true);
    } else if (e.key === "Tab") {
      close(true, false);
    }
  };

  return (
    <div ref={root} className="relative w-72" data-keep-escape={open || undefined}>
      <button
        ref={trigger}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Theme: ${current.label}`}
        onClick={toggle}
        onKeyDown={onTriggerKey}
        className="flex h-8 w-full items-center gap-2 rounded-md border border-input bg-background px-2.5 text-left text-xs shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Dots theme={current.id} isDark={isDark} />
        <span className="min-w-0 flex-1 truncate">{current.label}</span>
        <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
      </button>
      {open && (
        <div className="absolute left-0 right-0 top-full z-50 mt-1 overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md">
          <input
            autoFocus
            role="combobox"
            aria-expanded
            aria-controls={`${id}-list`}
            aria-activedescendant={hi >= 0 && items[hi] ? optId(hi) : undefined}
            aria-autocomplete="list"
            aria-label="Filter themes"
            placeholder="Filter themes"
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value);
              const next = filterThemes(THEMES, e.target.value);
              setHi(Math.max(0, next.findIndex((t) => t.id === value)));
            }}
            onKeyDown={onFilterKey}
            className="h-8 w-full border-b bg-transparent px-2.5 text-xs outline-none placeholder:text-muted-foreground"
          />
          <div ref={list} id={`${id}-list`} role="listbox" aria-label="Themes" className="max-h-80 overflow-y-auto p-1">
            {items.length === 0 && <p className="px-2 py-1.5 text-xs text-muted-foreground">No matching themes.</p>}
            {items.map((t, i) => (
              <div
                key={t.id}
                id={optId(i)}
                role="option"
                aria-selected={t.id === value}
                onMouseDown={(e) => e.preventDefault()}
                onMouseMove={() => i !== hi && move(i)}
                onClick={() => commit(i)}
                className={cn("flex cursor-default items-center gap-2 rounded px-2 py-1.5 text-xs", i === hi && "bg-accent text-accent-foreground")}
              >
                <Dots theme={t.id} isDark={isDark} />
                <span className="min-w-0 flex-1 truncate">{t.label}</span>
                {t.id === value && <Check className="size-3.5 shrink-0" />}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
