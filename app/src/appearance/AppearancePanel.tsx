import { type FrontendToggle, type HarnessClient, panelWindowsReopen } from "@harness/api";
import {
   Button,
   cn,
   Input,
   Select,
   SelectContent,
   SelectItem,
   SelectTrigger,
   SelectValue,
} from "@harness/ui";
import { Minus, Plus } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { frontendToggles } from "../platform/frontends";
import { useReportError } from "../platform/toast";
import { SectionHeader } from "../settings/SectionHeader";
import {
   type Appearance,
   CODE_FONT_SIZE_MAX,
   CODE_FONT_SIZE_MIN,
   CUSTOM_FONT_MAX,
   clampFontSize,
   cleanFont,
   DEFAULT_APPEARANCE,
   FLOWS,
   FONT_SIZE_MAX,
   FONT_SIZE_MIN,
   type FontOption,
   getAppearance,
   isDarkMode,
   LEADINGS,
   MODES,
   MONO_FONTS,
   previewAppearance,
   type RhythmOption,
   revertPreview,
   SANS_FONTS,
   setAppearance,
   TERMINAL_FONT_SIZE_MAX,
   TERMINAL_FONT_SIZE_MIN,
} from "./appearance";
import { ImportedThemes } from "./ImportedThemes";

import { ImportThemeDialog } from "./ImportThemeDialog";
import { Row } from "./Row";
import { ThemePicker } from "./ThemePicker";

/** A titled block of rows. */
function Group({ title, children }: { title: string; children: React.ReactNode }) {
   return (
      <section aria-label={title} className="border-t pt-5 first:border-t-0 first:pt-0">
         <h3 className="mb-3 text-sm font-semibold">{title}</h3>
         <div className="grid grid-cols-[7rem_1fr] items-center gap-x-4 gap-y-3">{children}</div>
      </section>
   );
}

function FontRow({
   label,
   id,
   value,
   custom,
   placeholder,
   fonts,
   onChange,
   defaultLabel = "Theme default",
}: {
   label: string;
   id: string;
   value: string;
   custom: string;
   placeholder: string;
   fonts: FontOption[];
   onChange: (patch: { choice?: string; custom?: string }) => void;
   /** Label of the "theme" choice. */
   defaultLabel?: string;
}) {
   return (
      <Row label={label} htmlFor={id}>
         <Select value={value} onValueChange={(v) => onChange({ choice: v })}>
            <SelectTrigger id={id} className="h-8 w-72 shrink-0 text-xs">
               <SelectValue />
            </SelectTrigger>
            <SelectContent>
               <SelectItem value="theme">{defaultLabel}</SelectItem>
               <SelectItem value="system">System</SelectItem>
               {fonts.map((f) => (
                  <SelectItem key={f.id} value={f.id}>
                     {f.label}
                  </SelectItem>
               ))}
               <SelectItem value="custom">Custom…</SelectItem>
            </SelectContent>
         </Select>
         {value === "custom" && (
            <Input
               className="h-8 max-w-72 text-xs"
               aria-label={`${label} family`}
               placeholder={placeholder}
               maxLength={CUSTOM_FONT_MAX}
               spellCheck={false}
               value={custom}
               onChange={(e) => onChange({ custom: cleanFont(e.target.value) })}
            />
         )}
      </Row>
   );
}

function RhythmRow({
   label,
   id,
   value,
   options,
   onChange,
}: {
   label: string;
   id: string;
   value: string;
   options: RhythmOption[];
   onChange: (id: string) => void;
}) {
   return (
      <Row label={label} htmlFor={id}>
         <Select value={value} onValueChange={onChange}>
            <SelectTrigger id={id} className="h-8 w-44 shrink-0 text-xs">
               <SelectValue />
            </SelectTrigger>
            <SelectContent>
               {options.map((o) => (
                  <SelectItem key={o.id} value={o.id}>
                     {o.label} ({o.value})
                  </SelectItem>
               ))}
            </SelectContent>
         </Select>
      </Row>
   );
}

/** Chat Frontend: highlight unmarked code-like inline code in the message's language (stored by the Frontend itself). */
/** A labelled on/off switch. */
function Toggle({
   id,
   on,
   onChange,
   children,
}: {
   id: string;
   on: boolean;
   onChange: (on: boolean) => void;
   children: React.ReactNode;
}) {
   return (
      <label className="flex items-center gap-2 text-xs">
         <button
            id={id}
            type="button"
            role="switch"
            aria-checked={on}
            onClick={() => onChange(!on)}
            className={cn(
               "relative h-4 w-7 shrink-0 rounded-full transition-colors",
               on ? "bg-primary" : "bg-muted-foreground/30",
            )}
         >
            <span
               className={cn(
                  "absolute top-0.5 size-3 rounded-full bg-background transition-all",
                  on ? "left-3.5" : "left-0.5",
               )}
            />
         </button>
         <span>{children}</span>
      </label>
   );
}

function ToggleRow({ toggle }: { toggle: FrontendToggle }) {
   const on = toggle.useValue();
   return (
      <Row label={toggle.label} htmlFor={toggle.id} help={toggle.help}>
         <Toggle id={toggle.id} on={on} onChange={toggle.set}>
            {toggle.toggleLabel}
         </Toggle>
      </Row>
   );
}

/** The switch rows the Frontends offer for `group`. */
function FrontendToggles({ group }: { group: FrontendToggle["group"] }) {
   return frontendToggles(group).map((t) => <ToggleRow key={t.id} toggle={t} />);
}

const reopenStore = panelWindowsReopen();

/** App setting: reopen the panel windows on launch (ADR 0032). */
function ReopenPanelWindowsRow() {
   const on = useSyncExternalStore(reopenStore.subscribe, reopenStore.get);
   return (
      <Row
         label="Panel windows"
         htmlFor="reopen-panel-windows"
         help="Off: panels in their own window dock back when Harness starts."
      >
         <Toggle id="reopen-panel-windows" on={on} onChange={(v) => reopenStore.set(v)}>
            Reopen panel windows on launch
         </Toggle>
      </Row>
   );
}

/** px stepper: typing, arrows, +/- buttons, clamped to min..max (FONT_SIZE_MIN..MAX by default), with Reset. */
function SizeField({
   id,
   label,
   value,
   fallback,
   onChange,
   min = FONT_SIZE_MIN,
   max = FONT_SIZE_MAX,
}: {
   id: string;
   label: string;
   value: number;
   fallback: number;
   onChange: (n: number) => void;
   min?: number;
   max?: number;
}) {
   const [text, setText] = useState<string | null>(null);
   const set = (n: number) => {
      setText(null);
      if (Number.isFinite(n)) onChange(clampFontSize(n, min, max));
   };
   return (
      <>
         <div className="flex items-center gap-1">
            <Button
               size="icon"
               variant="outline"
               className="size-8"
               aria-label={`Decrease ${label}`}
               disabled={value <= min}
               onClick={() => set(value - 1)}
            >
               <Minus />
            </Button>
            <div className="relative">
               <Input
                  id={id}
                  inputMode="numeric"
                  className="h-8 w-16 pl-2 pr-7 text-right text-xs tabular-nums"
                  value={text ?? String(value)}
                  onChange={(e) => {
                     const v = e.target.value.replace(/[^\d]/g, "").slice(0, 2);
                     setText(v);
                     const n = Number(v);
                     if (v && n >= min && n <= max) onChange(n);
                  }}
                  onBlur={() => text !== null && set(text ? Number(text) : value)}
                  onKeyDown={(e) => {
                     if (e.key === "ArrowUp" || e.key === "ArrowDown") {
                        e.preventDefault();
                        set(value + (e.key === "ArrowUp" ? 1 : -1));
                     } else if (e.key === "Enter") {
                        e.currentTarget.blur();
                     }
                  }}
               />
               <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                  px
               </span>
            </div>
            <Button
               size="icon"
               variant="outline"
               className="size-8"
               aria-label={`Increase ${label}`}
               disabled={value >= max}
               onClick={() => set(value + 1)}
            >
               <Plus />
            </Button>
         </div>
         <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-xs"
            disabled={value === fallback}
            onClick={() => set(fallback)}
         >
            Reset
         </Button>
      </>
   );
}

/** Theme, text, chat and terminal settings in groups. Changes apply and save right away. */
export function AppearancePanel({ client }: { client: HarnessClient }) {
   const [a, setA] = useState<Appearance>(getAppearance);
   const report = useReportError();
   const update = (patch: Partial<Appearance>) => {
      const next = { ...a, ...patch };
      setA(next);
      setAppearance(next).catch((e) => {
         setA(getAppearance()); // rolled back
         report("Could not save the appearance", e);
      });
   };
   // Leaving the panel mid-preview restores the saved theme.
   useEffect(() => revertPreview, []);
   const isDark = isDarkMode(a.mode, window);

   return (
      <div className="text-sm">
         <SectionHeader
            title="Appearance"
            description="Theme, fonts and text sizes for all windows."
         />

         <div className="grid gap-5">
            <Group title="Theme">
               <Row label="Mode">
                  <div
                     role="group"
                     aria-label="Mode"
                     className="inline-flex shrink-0 rounded-md border p-0.5"
                  >
                     {MODES.map((m) => (
                        <button
                           key={m}
                           aria-pressed={a.mode === m}
                           onClick={() => update({ mode: m })}
                           className={cn(
                              "rounded px-2.5 py-1 text-xs capitalize",
                              a.mode === m
                                 ? "bg-accent font-medium text-accent-foreground"
                                 : "text-muted-foreground hover:bg-accent/50",
                           )}
                        >
                           {m}
                        </button>
                     ))}
                  </div>
               </Row>
               <Row label="Theme">
                  <ThemePicker
                     value={a.theme}
                     isDark={isDark}
                     onPreview={(theme) => previewAppearance({ ...a, theme })}
                     onCommit={(theme) => update({ theme })}
                     onRevert={revertPreview}
                  />
                  <ImportThemeDialog client={client} onImported={(theme) => update({ theme })} />
               </Row>
               <ImportedThemes
                  current={a.theme}
                  onRemoved={() => update({ theme: DEFAULT_APPEARANCE.theme })}
               />
            </Group>
            <Group title="Text">
               <FontRow
                  label="Font"
                  id="font-sans"
                  value={a.font}
                  custom={a.customFont}
                  placeholder="Avenir Next, sans-serif"
                  fonts={SANS_FONTS}
                  onChange={({ choice, custom }) =>
                     update(custom === undefined ? { font: choice } : { customFont: custom })
                  }
               />
               <FontRow
                  label="Mono font"
                  id="font-mono"
                  value={a.mono}
                  custom={a.customMono}
                  placeholder="Berkeley Mono, monospace"
                  fonts={MONO_FONTS}
                  onChange={({ choice, custom }) =>
                     update(custom === undefined ? { mono: choice } : { customMono: custom })
                  }
               />
               <Row label="UI font size" htmlFor="font-size">
                  <SizeField
                     id="font-size"
                     label="UI font size"
                     value={a.fontSize}
                     fallback={DEFAULT_APPEARANCE.fontSize}
                     onChange={(fontSize) => update({ fontSize })}
                  />
               </Row>
               <Row
                  label="Code font size"
                  htmlFor="code-font-size"
                  help="Code blocks, diffs and file contents. Not inline code."
               >
                  <SizeField
                     id="code-font-size"
                     label="code font size"
                     value={a.codeFontSize}
                     fallback={DEFAULT_APPEARANCE.codeFontSize}
                     min={CODE_FONT_SIZE_MIN}
                     max={CODE_FONT_SIZE_MAX}
                     onChange={(codeFontSize) => update({ codeFontSize })}
                  />
               </Row>
            </Group>
            <Group title="Chat">
               <Row label="Font size" htmlFor="chat-font-size">
                  <SizeField
                     id="chat-font-size"
                     label="chat font size"
                     value={a.chatFontSize}
                     fallback={DEFAULT_APPEARANCE.chatFontSize}
                     onChange={(chatFontSize) => update({ chatFontSize })}
                  />
               </Row>
               <RhythmRow
                  label="Leading"
                  id="chat-leading"
                  value={a.leading}
                  options={LEADINGS}
                  onChange={(leading) => update({ leading })}
               />
               <RhythmRow
                  label="Flow"
                  id="chat-flow"
                  value={a.flow}
                  options={FLOWS}
                  onChange={(flow) => update({ flow })}
               />
               <FrontendToggles group="chat" />
            </Group>
            <Group title="Terminal">
               <FontRow
                  label="Font"
                  id="terminal-font"
                  value={a.terminalFont}
                  custom={a.customTerminalFont}
                  placeholder="Iosevka, monospace"
                  fonts={MONO_FONTS}
                  defaultLabel="Mono font"
                  onChange={({ choice, custom }) =>
                     update(
                        custom === undefined
                           ? { terminalFont: choice }
                           : { customTerminalFont: custom },
                     )
                  }
               />
               <Row label="Font size" htmlFor="terminal-font-size">
                  <SizeField
                     id="terminal-font-size"
                     label="terminal font size"
                     value={a.terminalFontSize}
                     fallback={DEFAULT_APPEARANCE.terminalFontSize}
                     min={TERMINAL_FONT_SIZE_MIN}
                     max={TERMINAL_FONT_SIZE_MAX}
                     onChange={(terminalFontSize) => update({ terminalFontSize })}
                  />
               </Row>
               <FrontendToggles group="terminal" />
            </Group>
            <Group title="Windows">
               <ReopenPanelWindowsRow />
            </Group>
         </div>
      </div>
   );
}
