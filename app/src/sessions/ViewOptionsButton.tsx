import { cn, Popover, PopoverContent, PopoverTrigger, ScrollArea, Tooltip } from "@harness/ui";
import { Check, ListFilter } from "lucide-react";
import { DEFAULT_VIEW, type ViewOptions, viewChanges } from "./sessionGroups";

const OPTIONS: { key: keyof ViewOptions; label: string; opts: [string, string][] }[] = [
   {
      key: "sort",
      label: "SORT BY",
      opts: [
         ["recent", "Recent activity"],
         ["created", "Created"],
      ],
   },
   {
      key: "display",
      label: "DISPLAY",
      opts: [
         ["condensed", "Condensed"],
         ["detail", "Detail"],
      ],
   },
   {
      key: "group",
      label: "GROUP BY",
      opts: [
         ["none", "None"],
         ["folder", "Folder"],
         ["date", "Date"],
      ],
   },
];

/** Sort, display and grouping, in the style of the Session Log's filter popover. */
export function ViewOptionsButton({
   view,
   onChange,
}: {
   view: ViewOptions;
   onChange: (v: Partial<ViewOptions>) => void;
}) {
   const changed = viewChanges(view);
   return (
      <Popover>
         <Tooltip content="View options" side="bottom">
            <PopoverTrigger
               aria-label={changed ? `View options, ${changed} changed` : "View options"}
               className={cn(
                  "grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground data-[state=open]:bg-accent [&_svg]:size-4",
                  changed > 0 && "bg-accent text-accent-foreground",
               )}
            >
               <ListFilter />
            </PopoverTrigger>
         </Tooltip>
         <PopoverContent
            align="end"
            className="w-64 p-0 text-[13px]"
            onOpenAutoFocus={(e) => e.preventDefault()}
         >
            <ScrollArea
               className="max-h-[min(32rem,var(--radix-popover-content-available-height))]"
               viewportClassName="max-h-[inherit] p-1"
            >
               {OPTIONS.map((o, i) => (
                  <div key={o.key}>
                     {i > 0 && <div className="my-1 h-px bg-border" />}
                     <div className="flex items-center justify-between px-2 pt-1 pb-1">
                        <span className="text-[11px] font-semibold tracking-wide text-muted-foreground">
                           {o.label}
                        </span>
                        {i === 0 && (
                           <button
                              className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-40"
                              disabled={!changed}
                              onClick={() => onChange(DEFAULT_VIEW)}
                           >
                              Reset
                           </button>
                        )}
                     </div>
                     {o.opts.map(([value, label]) => (
                        <button
                           key={value}
                           aria-pressed={view[o.key] === value}
                           onClick={() => onChange({ [o.key]: value })}
                           className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left hover:bg-accent hover:text-accent-foreground"
                        >
                           <span className="flex w-3.5 shrink-0">
                              {view[o.key] === value && <Check className="size-3.5" />}
                           </span>
                           {label}
                        </button>
                     ))}
                  </div>
               ))}
            </ScrollArea>
         </PopoverContent>
      </Popover>
   );
}
