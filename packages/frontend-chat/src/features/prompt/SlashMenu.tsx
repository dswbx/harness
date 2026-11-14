import type { SlashCommand } from "@harness/api";
import { cn, Tooltip } from "@harness/ui";
import type { MenuSide } from "./ConfigBar";
import { PromptMenu } from "./PromptMenu";

/** The "/" command list above the box; `index` is the highlighted row. */
export function SlashMenu({
   items,
   index,
   side,
   onHover,
   onPick,
}: {
   items: SlashCommand[];
   index: number;
   side: MenuSide;
   onHover: (i: number) => void;
   onPick: (c: SlashCommand) => void;
}) {
   return (
      <PromptMenu label="Commands" className="w-72" side={side}>
         {items.map((c, i) => (
            <Tooltip
               key={c.name}
               content={c.description}
               side="right"
               open={i === index && !!c.description}
            >
               <button
                  ref={i === index ? (el) => el?.scrollIntoView({ block: "nearest" }) : undefined}
                  role="option"
                  aria-selected={i === index}
                  aria-description={c.description || undefined}
                  className={cn(
                     "flex w-full items-baseline gap-2 rounded-md px-2 py-1.5 text-left text-sm",
                     i === index && "bg-accent text-accent-foreground",
                  )}
                  onMouseMove={() => i !== index && onHover(i)}
                  onClick={() => onPick(c)}
               >
                  <span className="shrink-0">/{c.name}</span>
                  {c.hint && (
                     <span className="min-w-0 truncate text-xs text-muted-foreground">
                        {c.hint}
                     </span>
                  )}
               </button>
            </Tooltip>
         ))}
      </PromptMenu>
   );
}
