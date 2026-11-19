import { errText } from "@harness/api";
import { Button, Input, Popover, PopoverAnchor, PopoverContent } from "@harness/ui";
import { type ReactNode, useEffect, useId, useState } from "react";
import { IconPicker } from "./IconPicker";

/** Longest title the core keeps. */
const MAX_TITLE = 80;

/**
 * Rename a panel and pick its icon, in a popover anchored at the panel header's title (`children`).
 * `title` and `icon` are what the panel shows now; `agent` is what the Agent set when the user changed
 * either (`null` when not changed). `onSave(title, icon)` gets `null` for a value that is the Agent's own
 * (non-shared) or unchanged. A shared panel passes `shared`: its name and icon are the artifact's
 * everywhere, so there is no "Use Agent's".
 */
export function EditPanelPopover({
   id: slotId,
   open,
   onOpenChange,
   title,
   icon,
   agent,
   shared = false,
   onSave,
   children,
}: {
   /** The panel's id: what the header shows when the Agent gave no title. */
   id: string;
   open: boolean;
   onOpenChange: (open: boolean) => void;
   title: string;
   icon: string | null;
   agent: { title: string | null; icon: string | null } | null;
   shared?: boolean;
   onSave: (title: string | null, icon: string | null) => Promise<void>;
   children: ReactNode;
}) {
   const [value, setValue] = useState(title);
   const [picked, setPicked] = useState<string | null>(icon);
   const [error, setError] = useState<string | null>(null);
   const [busy, setBusy] = useState(false);
   const id = useId();
   useEffect(() => {
      if (open) {
         setValue(title);
         setPicked(icon);
         setError(null);
      }
   }, [open, title, icon]);

   const clean = value.split(/\s+/).filter(Boolean).join(" ").slice(0, MAX_TITLE);
   // What "unchanged" means: the Agent's value when the user changed it before, else what shows now.
   const baseTitle = agent ? (agent.title ?? slotId) : title;
   const baseIcon = agent ? agent.icon : icon;
   const run = (go: () => Promise<void>) => {
      setBusy(true);
      go().then(
         () => {
            setBusy(false);
            onOpenChange(false);
         },
         (e) => {
            setBusy(false);
            setError(errText(e));
         },
      );
   };
   const save = () => {
      if (busy || !clean) return;
      if (shared) return run(() => onSave(clean, picked));
      run(() => onSave(clean === baseTitle ? null : clean, picked === baseIcon ? null : picked));
   };
   return (
      <Popover open={open} onOpenChange={onOpenChange} modal>
         <PopoverAnchor asChild>
            <span className="min-w-0">{children}</span>
         </PopoverAnchor>
         <PopoverContent
            align="start"
            className="w-72 p-3"
            onOpenAutoFocus={(e) => {
               e.preventDefault();
               const input = (e.currentTarget as HTMLElement | null)?.querySelector("input");
               input?.focus();
               input?.select();
            }}
         >
            <div className="flex flex-col gap-3">
               <div className="flex flex-col gap-1.5">
                  <label htmlFor={`${id}-title`} className="text-xs font-medium">
                     Title
                  </label>
                  <Input
                     id={`${id}-title`}
                     value={value}
                     maxLength={MAX_TITLE}
                     onChange={(e) => setValue(e.target.value)}
                     onKeyDown={(e) => {
                        if (e.key === "Enter") {
                           e.preventDefault();
                           save();
                        }
                     }}
                  />
                  {agent?.title && (
                     <p className="text-xs text-muted-foreground">
                        Agent called it “{agent.title}”
                     </p>
                  )}
               </div>
               <IconPicker labelId={`${id}-icon`} picked={picked} onPick={setPicked} />
               {error && <p className="text-xs text-destructive">{error}</p>}
               <div className="flex items-center gap-2">
                  {!shared && (
                     <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy || !agent}
                        onClick={() => run(() => onSave(null, null))}
                     >
                        Use Agent's
                     </Button>
                  )}
                  <div className="ml-auto flex gap-2">
                     <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
                        Cancel
                     </Button>
                     <Button size="sm" disabled={busy || !clean} onClick={save}>
                        Save
                     </Button>
                  </div>
               </div>
            </div>
         </PopoverContent>
      </Popover>
   );
}
