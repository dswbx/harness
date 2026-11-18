import { type TaskUpstream, upstreamId } from "@harness/api";
import {
   Button,
   cn,
   Input,
   noAutocorrect,
   Popover,
   PopoverContent,
   PopoverTrigger,
} from "@harness/ui";
import { Link2, Pencil } from "lucide-react";
import { useState } from "react";
import { FIELD_CHIP } from "./chips";

const host = (url: string) => {
   try {
      return new URL(url).hostname.replace(/^www\./, "");
   } catch {
      return null;
   }
};

/** What a link shows as: its tracker id (`HAR-42`, `#12`), else its label, else its host. */
export const upstreamText = (u: TaskUpstream) =>
   upstreamId(u.url) ?? (u.label || host(u.url) || u.url);

/** The task's item in another tracker: a link chip, edited (URL and label) in a popover. */
export function UpstreamField({
   upstream,
   onChange,
}: {
   upstream: TaskUpstream | null;
   onChange: (upstream: TaskUpstream | null) => void;
}) {
   const [open, setOpen] = useState(false);
   const [url, setUrl] = useState("");
   const [label, setLabel] = useState("");
   const edit = (o: boolean) => {
      if (o) {
         setUrl(upstream?.url ?? "");
         setLabel(upstream?.label ?? "");
      }
      setOpen(o);
   };
   const save = () => {
      const u = url.trim();
      setOpen(false);
      if (!u) return upstream && onChange(null);
      if (u === upstream?.url && (label.trim() || null) === (upstream.label || null)) return;
      onChange({ url: u, label: label.trim() || null });
   };
   return (
      <div className="flex min-w-0 items-center gap-1.5">
         {upstream && (
            <a
               href={upstream.url}
               target="_blank"
               rel="noreferrer"
               className={cn(FIELD_CHIP, "text-sky-600 dark:text-sky-400")}
               title={upstream.url}
            >
               <Link2 className="size-3" />
               <span className="truncate">{upstreamText(upstream)}</span>
            </a>
         )}
         {upstream && host(upstream.url) && (
            <span className="truncate text-xs text-muted-foreground">{host(upstream.url)}</span>
         )}
         <Popover open={open} onOpenChange={edit}>
            <PopoverTrigger
               className={
                  upstream
                     ? "grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                     : cn(FIELD_CHIP, "text-muted-foreground")
               }
               aria-label={upstream ? "Edit link" : "Add link"}
            >
               {upstream ? (
                  <Pencil className="size-3" />
               ) : (
                  <>
                     <Link2 className="size-3" />
                     Add link
                  </>
               )}
            </PopoverTrigger>
            <PopoverContent className="w-72 p-2">
               <form
                  className="flex flex-col gap-2"
                  onSubmit={(e) => {
                     e.preventDefault();
                     save();
                  }}
               >
                  <Input
                     {...noAutocorrect}
                     autoFocus
                     aria-label="Link"
                     placeholder="https://linear.app/…"
                     value={url}
                     onChange={(e) => setUrl(e.target.value)}
                     className="h-8"
                  />
                  <Input
                     {...noAutocorrect}
                     aria-label="Label"
                     placeholder="Label (optional)"
                     value={label}
                     onChange={(e) => setLabel(e.target.value)}
                     className="h-8"
                  />
                  <div className="flex justify-end gap-1.5">
                     {upstream && (
                        <Button
                           type="button"
                           variant="ghost"
                           size="sm"
                           className="mr-auto"
                           onClick={() => {
                              setOpen(false);
                              onChange(null);
                           }}
                        >
                           Remove
                        </Button>
                     )}
                     <Button type="submit" size="sm">
                        Save
                     </Button>
                  </div>
               </form>
            </PopoverContent>
         </Popover>
      </div>
   );
}
