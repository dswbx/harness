import { formatAge, type ThreadInfo } from "@harness/api";
import {
   Dialog,
   DialogContent,
   DialogDescription,
   DialogHeader,
   DialogTitle,
   ScrollArea,
} from "@harness/ui";

/** Every Side Thread of the Session, newest activity first; a click opens its tab again. */
export function PastChats({
   open,
   onOpenChange,
   chats,
   openIds,
   onPick,
}: {
   open: boolean;
   onOpenChange: (open: boolean) => void;
   chats: ThreadInfo[];
   /** Tabs open now. */
   openIds: readonly string[];
   onPick: (id: string) => void;
}) {
   const now = Date.now();
   return (
      <Dialog open={open} onOpenChange={onOpenChange}>
         <DialogContent className="max-w-md gap-3">
            <DialogHeader>
               <DialogTitle>Past side chats</DialogTitle>
               <DialogDescription>
                  Closed chats stay in the Session. Pick one to open it again.
               </DialogDescription>
            </DialogHeader>
            {chats.length === 0 ? (
               <p className="py-6 text-center text-sm text-muted-foreground">No side chats yet.</p>
            ) : (
               <ScrollArea className="-mx-2 max-h-[60vh]" viewportClassName="max-h-[inherit]">
                  <ul className="flex flex-col gap-0.5 px-2">
                     {chats.map((c) => (
                        <li key={c.id}>
                           <button
                              type="button"
                              className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground"
                              onClick={() => {
                                 onPick(c.id);
                                 onOpenChange(false);
                              }}
                           >
                              <span className="min-w-0 flex-1 truncate">
                                 {c.title ?? "Side chat"}
                              </span>
                              {openIds.includes(c.id) && (
                                 <span className="shrink-0 text-xs text-muted-foreground">
                                    Open
                                 </span>
                              )}
                              <span className="shrink-0 text-xs tabular-nums text-muted-foreground/70">
                                 {formatAge(c.lastAt, now)}
                              </span>
                           </button>
                        </li>
                     ))}
                  </ul>
               </ScrollArea>
            )}
         </DialogContent>
      </Dialog>
   );
}
