import { baseName, formatAge, inTauri } from "@harness/api";
import { cn } from "@harness/ui";
import { Folder, FolderPlus, Zap } from "lucide-react";
import { matchesWords, type RecentFolder, tildify } from "./composer";
import { FieldButton, Picker, type PickItem } from "./Picker";
import { Label } from "./parts";

export function FolderField({
   recent,
   recentBranch,
   folder,
   noFolder,
   folderOpen,
   setFolderOpen,
   folderQuery,
   setFolderQuery,
   pickFolder,
   pickNoFolder,
   browse,
}: {
   recent: RecentFolder[];
   recentBranch: Record<string, string | null>;
   folder: string;
   noFolder: boolean;
   folderOpen: boolean;
   setFolderOpen: (o: boolean) => void;
   folderQuery: string;
   setFolderQuery: (q: string) => void;
   pickFolder: (p: string) => void;
   pickNoFolder: () => void;
   browse: () => Promise<void>;
}) {
   // ---- Folder list
   const fq = folderQuery.trim();
   const folderItems: PickItem[] = [
      ...(fq.startsWith("/") && !recent.some((r) => r.path === fq.replace(/\/+$/, ""))
         ? [
              {
                 key: "typed",
                 onSelect: () => pickFolder(fq),
                 content: (
                    <>
                       <Folder className="size-4 shrink-0 text-muted-foreground" />
                       <span className="truncate">
                          Use <span className="font-mono text-[13px]">{fq}</span>
                       </span>
                    </>
                 ),
              },
           ]
         : []),
      ...(matchesWords(fq, "no folder", "quick session")
         ? [
              {
                 key: "no-folder",
                 selected: noFolder,
                 onSelect: pickNoFolder,
                 content: (
                    <>
                       <Zap
                          className={cn(
                             "size-4 shrink-0",
                             noFolder ? "text-primary" : "text-muted-foreground",
                          )}
                       />
                       <span className="flex-1">No folder</span>
                       <span className="shrink-0 text-xs text-muted-foreground">Quick Session</span>
                    </>
                 ),
              },
           ]
         : []),
      ...recent
         .filter((r) => matchesWords(fq, baseName(r.path), r.path))
         .map((r): PickItem => {
            const b = recentBranch[r.path];
            return {
               key: r.path,
               section: "Recent",
               selected: r.path === folder,
               onSelect: () => pickFolder(r.path),
               content: (
                  <>
                     <Folder
                        className={cn(
                           "size-4 shrink-0",
                           r.path === folder ? "text-primary" : "text-muted-foreground",
                        )}
                     />
                     <span className="flex min-w-0 flex-1 items-baseline gap-2">
                        <span className="shrink-0">{baseName(r.path)}</span>
                        <span className="min-w-0 truncate text-xs text-muted-foreground">
                           {tildify(r.path)}
                        </span>
                     </span>
                     {b === null ? (
                        <span className="shrink-0 text-xs text-muted-foreground">no git</span>
                     ) : (
                        b && (
                           <span className="max-w-32 shrink-0 truncate font-mono text-[11px] text-muted-foreground">
                              {b}
                           </span>
                        )
                     )}
                     <span className="w-14 shrink-0 text-right text-xs text-muted-foreground">
                        {formatAge(r.at)}
                     </span>
                  </>
               ),
            };
         }),
      ...(inTauri()
         ? [
              {
                 key: "browse",
                 separated: true,
                 onSelect: () => void browse(),
                 content: (
                    <>
                       <FolderPlus className="size-4 shrink-0 text-muted-foreground" />
                       <span className="flex-1">Choose another folder…</span>
                       <kbd className="rounded border px-1 font-sans text-[11px] text-muted-foreground">
                          ⌘O
                       </kbd>
                    </>
                 ),
              },
           ]
         : []),
   ];

   return (
      <div className="grid gap-2">
         <Label>Workspace</Label>
         <Picker
            label="Recent folders"
            open={folderOpen}
            onOpenChange={(o) => {
               setFolderOpen(o);
               if (!o) setFolderQuery("");
            }}
            search={{
               value: folderQuery,
               onChange: setFolderQuery,
               placeholder: "Filter recent folders or type a path",
            }}
            items={folderItems}
            empty={recent.length ? "No folder matches" : "No recent folders yet"}
            trigger={
               <FieldButton
                  icon={noFolder ? <Zap /> : <Folder />}
                  title={noFolder ? "No folder" : folder ? baseName(folder) : undefined}
                  subtitle={noFolder ? "Quick Session" : folder ? tildify(folder) : undefined}
                  placeholder="Choose a folder"
               />
            }
         />
      </div>
   );
}
