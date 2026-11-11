import type { OverlayPosition } from "@harness/api";
import { errText, inTauri } from "@harness/api";
import { Button, cn, Input } from "@harness/ui";
import { useEffect, useState } from "react";
import { getOverlaySettings, type OverlayConfig, setOverlaySettings } from "./overlayHost";
import { SectionHeader } from "./SectionHeader";

const POSITIONS: { id: OverlayPosition; label: string; hint: string }[] = [
   { id: "cursor", label: "At the mouse", hint: "Opens where the pointer is" },
   { id: "bottom", label: "Bottom center", hint: "Opens above the Dock of that screen" },
];

/** Settings > Quick overlay: the global shortcut and where the prompt opens (ADR 0022). */
export function OverlayPanel() {
   const [settings, setSettings] = useState<OverlayConfig | null>(null);
   const [shortcut, setShortcut] = useState("");
   const [error, setError] = useState<string | null>(null);
   useEffect(() => {
      if (!inTauri()) return;
      getOverlaySettings().then(
         (st) => {
            setSettings(st.settings);
            setShortcut(st.settings.shortcut);
            setError(st.shortcut_error);
         },
         (e) => setError(errText(e)),
      );
   }, []);
   const save = (next: OverlayConfig) =>
      setOverlaySettings(next).then(
         (st) => {
            setSettings(st.settings);
            setShortcut(st.settings.shortcut);
            setError(null);
         },
         (e) => setError(errText(e)),
      );
   if (!inTauri())
      return (
         <SectionHeader
            title="Quick overlay"
            description="Only in the desktop app: a global shortcut opens a floating prompt that starts a Quick Session."
         />
      );
   if (!settings) return error ? <p className="text-sm text-destructive">{error}</p> : null;
   const changed = shortcut.trim() !== settings.shortcut;
   return (
      <div>
         <SectionHeader
            title="Quick overlay"
            description="A global shortcut opens a floating prompt over any app. Sending starts a Quick Session that stays on top as a small chat."
         />
         <form
            className="grid max-w-lg grid-cols-1 gap-1.5 text-sm"
            onSubmit={(e) => {
               e.preventDefault();
               if (shortcut.trim()) void save({ ...settings, shortcut: shortcut.trim() });
            }}
         >
            <span className="text-muted-foreground">Shortcut</span>
            <div className="flex gap-2">
               <Input
                  className="font-mono text-xs"
                  value={shortcut}
                  onChange={(e) => setShortcut(e.target.value)}
                  aria-label="Shortcut"
                  placeholder="Alt+Space"
               />
               <Button type="submit" variant="outline" disabled={!changed || !shortcut.trim()}>
                  Save
               </Button>
            </div>
            <span className="text-xs text-muted-foreground">
               For example Alt+Space or CmdOrCtrl+Shift+K. Another app (Raycast, Alfred) may already
               use it.
            </span>
            {error && (
               <p role="alert" className="text-xs text-destructive">
                  {error}
               </p>
            )}
         </form>
         <div
            role="radiogroup"
            aria-label="Opens"
            className="mt-5 grid max-w-lg grid-cols-1 gap-1.5"
         >
            <span className="text-sm text-muted-foreground">Opens</span>
            {POSITIONS.map((p) => {
               const on = settings.position === p.id;
               return (
                  <button
                     key={p.id}
                     role="radio"
                     aria-checked={on}
                     onClick={() => void save({ ...settings, position: p.id })}
                     className={cn(
                        "flex items-center gap-3 rounded-md border px-3 py-2 text-left text-sm",
                        on
                           ? "border-primary bg-primary/10"
                           : "hover:bg-accent hover:text-accent-foreground",
                     )}
                  >
                     <span
                        className={cn(
                           "grid size-4 shrink-0 place-items-center rounded-full border border-muted-foreground/50",
                           on && "border-primary",
                        )}
                     >
                        {on && <span className="size-2 rounded-full bg-primary" />}
                     </span>
                     <span className="flex-1 font-medium">{p.label}</span>
                     <span className="text-xs text-muted-foreground">{p.hint}</span>
                  </button>
               );
            })}
         </div>
         <div className="mt-5 grid max-w-lg grid-cols-1 gap-1.5 text-sm">
            <label className="flex items-center gap-3">
               <button
                  type="button"
                  role="switch"
                  aria-checked={settings.window_context}
                  onClick={() =>
                     void save({ ...settings, window_context: !settings.window_context })
                  }
                  className={cn(
                     "relative h-4 w-7 shrink-0 rounded-full transition-colors",
                     settings.window_context ? "bg-primary" : "bg-muted-foreground/30",
                  )}
               >
                  <span
                     className={cn(
                        "absolute top-0.5 size-3 rounded-full bg-background transition-all",
                        settings.window_context ? "left-3.5" : "left-0.5",
                     )}
                  />
               </button>
               <span className="font-medium">Include window context</span>
            </label>
            <span className="text-xs text-muted-foreground">
               A new prompt shows the app you were in as a chip (with Accessibility on: its window
               title and selected text; for browsers, Finder and iTerm2: the page or folder). It is
               sent with your first message unless you remove the chip.
            </span>
         </div>
      </div>
   );
}
