import {
   baseName,
   type HarnessClient,
   type InstructionsEntry,
   type InstructionsScope,
   inTauri,
   pickFolderDialog,
} from "@harness/api";
import { Button, cn, ScrollArea, Textarea } from "@harness/ui";
import { FolderGit2, Globe } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { markdownEditor } from "../platform/frontends";
import { useReportError } from "../platform/toast";

/** How long typing must pause before the text saves. */
const SAVE_DELAY_MS = 600;

const keyOf = (s: InstructionsScope) => (s.type === "global" ? "global" : `repo:${s.path}`);
const lineCount = (text: string) => (text.trim() ? text.trim().split("\n").length : 0);

/** The entry for `want`: the same path, else a repository of the same folder name, else Global. */
function pick(
   entries: InstructionsEntry[],
   want: InstructionsScope | null,
): InstructionsEntry | undefined {
   if (want?.type === "repo") {
      const name = baseName(want.path);
      return (
         entries.find((e) => keyOf(e.scope) === keyOf(want)) ??
         entries.find((e) => e.scope.type === "repo" && e.name === name) ??
         entries[0]
      );
   }
   return entries[0];
}

type SaveState = "saved" | "saving" | "error";

/**
 * Settings > Instructions: the user's Custom Instructions, Global and per repository. Sent with the Harness context on
 * the first prompt of each Agent Session; saved in the Harness data folder, never in the repository.
 */
export function InstructionsPanel({
   client,
   scope: wanted,
}: {
   client: HarnessClient;
   /** The scope to show first (from "Edit … instructions" in the Harness context); else Global. */
   scope: InstructionsScope | null;
}) {
   const report = useReportError();
   const [entries, setEntries] = useState<InstructionsEntry[] | null>(null);
   const [selected, setSelected] = useState<InstructionsScope | null>(null);
   const load = useCallback(
      (want: InstructionsScope | null) =>
         client.listInstructions().then(
            (list) => {
               setEntries(list);
               setSelected((cur) => pick(list, cur ?? want)?.scope ?? null);
            },
            (e) => report("Could not load the instructions", e),
         ),
      [client, report],
   );
   useEffect(() => {
      setSelected(null);
      void load(wanted);
   }, [load, wanted]);

   const entry = entries && selected && entries.find((e) => keyOf(e.scope) === keyOf(selected));
   const onSaved = (scope: InstructionsScope, text: string) =>
      setEntries(
         (list) =>
            list?.map((e) =>
               keyOf(e.scope) === keyOf(scope) ? { ...e, lines: lineCount(text) } : e,
            ) ?? null,
      );
   const relink = async (e: InstructionsEntry) => {
      if (e.scope.type !== "repo") return;
      const to = await pickFolderDialog();
      if (!to) return;
      try {
         await client.moveInstructions(e.scope.path, to);
         setSelected(null);
         await load(null);
      } catch (err) {
         report("Could not move the instructions", err);
      }
   };

   if (!entries) return null;
   const repos = entries.filter((e) => e.scope.type === "repo");
   return (
      <div className="flex min-h-0 flex-1">
         <ScrollArea className="w-60 shrink-0 border-r">
            <div className="grid gap-0.5 p-2">
               <div className="px-2.5 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  Scope
               </div>
               {entries.slice(0, 1).map((e) => (
                  <ScopeButton
                     key="global"
                     entry={e}
                     active={!!entry && keyOf(entry.scope) === "global"}
                     onClick={() => setSelected(e.scope)}
                  />
               ))}
               <div className="px-2.5 pb-1 pt-3 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  Repositories
               </div>
               {repos.length === 0 && (
                  <p className="px-2.5 py-1 text-xs text-muted-foreground">
                     Repositories of your Sessions show here.
                  </p>
               )}
               {repos.map((e) => (
                  <ScopeButton
                     key={keyOf(e.scope)}
                     entry={e}
                     active={!!entry && keyOf(entry.scope) === keyOf(e.scope)}
                     onClick={() => setSelected(e.scope)}
                  />
               ))}
            </div>
         </ScrollArea>
         {entry && (
            <ScopeEditor
               key={keyOf(entry.scope)}
               client={client}
               entry={entry}
               onSaved={onSaved}
               onRelink={inTauri() ? () => void relink(entry) : undefined}
            />
         )}
      </div>
   );
}

function ScopeButton({
   entry,
   active,
   onClick,
}: {
   entry: InstructionsEntry;
   active: boolean;
   onClick: () => void;
}) {
   const Icon = entry.scope.type === "global" ? Globe : FolderGit2;
   const note = !entry.folder_exists
      ? "folder not found"
      : entry.lines
        ? `${entry.lines} ${entry.lines === 1 ? "line" : "lines"}`
        : "none";
   return (
      <button
         type="button"
         aria-current={active ? "true" : undefined}
         title={entry.scope.type === "repo" ? entry.scope.path : undefined}
         onClick={onClick}
         className={cn(
            "flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm",
            active ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
         )}
      >
         <Icon className="size-4 shrink-0 text-muted-foreground" />
         <span className={cn("min-w-0 flex-1 truncate", active && "font-medium")}>
            {entry.name}
         </span>
         <span
            className={cn(
               "shrink-0 text-xs",
               entry.folder_exists ? "text-muted-foreground" : "text-amber-600 dark:text-amber-500",
            )}
         >
            {note}
         </span>
      </button>
   );
}

/** One scope's text: loads it, saves it after typing pauses and when it goes away. */
function ScopeEditor({
   client,
   entry,
   onSaved,
   onRelink,
}: {
   client: HarnessClient;
   entry: InstructionsEntry;
   onSaved: (scope: InstructionsScope, text: string) => void;
   onRelink?: () => void;
}) {
   const report = useReportError();
   const { scope } = entry;
   const [initial, setInitial] = useState<string | null>(null);
   const [state, setState] = useState<SaveState>("saved");
   const pending = useRef<string | null>(null);
   const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
   const saved = useRef(onSaved);
   saved.current = onSaved;

   useEffect(() => {
      client.getInstructions(scope).then(setInitial, (e) => {
         report("Could not load the instructions", e);
      });
   }, [client, scope, report]);

   const flush = useCallback(() => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      const text = pending.current;
      if (text === null) return;
      pending.current = null;
      setState("saving");
      client.setInstructions(scope, text).then(
         () => {
            saved.current(scope, text);
            if (pending.current === null) setState("saved");
         },
         (e) => {
            setState("error");
            report("Could not save the instructions", e);
         },
      );
   }, [client, scope, report]);
   // Save what is left when the scope changes or Settings closes.
   useEffect(() => flush, [flush]);

   const change = (text: string) => {
      pending.current = text;
      setState("saving");
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(flush, SAVE_DELAY_MS);
   };

   const Editor = markdownEditor();
   const global = scope.type === "global";
   return (
      <ScrollArea className="min-h-0 min-w-0 flex-1">
         <div className="flex min-h-full flex-col p-6">
            <h2 className="text-lg font-semibold">
               {global ? "Global instructions" : `${entry.name} instructions`}
            </h2>
            {global ? (
               <p className="text-sm text-muted-foreground">
                  Sent to every Agent, in every Session, on the first prompt.
               </p>
            ) : (
               <p className="text-sm text-muted-foreground">
                  <span className="font-mono text-xs">{scope.path}</span>
                  <br />
                  Sent to Agents in Sessions of this repository, on the first prompt. Every Worktree
                  uses it.
               </p>
            )}
            <p className="mb-3 text-sm text-muted-foreground">
               Only you see it. Saved in the Harness data folder, never in the repository.
            </p>
            {!entry.folder_exists && (
               <div className="mb-3 flex items-center gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
                  <span className="flex-1">The folder was not found. It was moved or deleted.</span>
                  {onRelink && (
                     <Button size="sm" variant="outline" onClick={onRelink}>
                        Choose its new folder…
                     </Button>
                  )}
               </div>
            )}
            {initial === null ? null : Editor ? (
               <div className="flex min-h-48 flex-1 flex-col rounded-xl border bg-card px-3 py-2.5 focus-within:border-ring/50 dark:focus-within:border-border">
                  <Editor
                     initial={initial}
                     onChange={change}
                     label={global ? "Global instructions" : `${entry.name} instructions`}
                     placeholder={
                        global
                           ? "For example: Answer briefly. Ask before you add a dependency."
                           : "For example: Run the tests before you say a change is done."
                     }
                  />
               </div>
            ) : (
               <Textarea
                  className="min-h-48 flex-1 font-mono text-sm"
                  defaultValue={initial}
                  onChange={(e) => change(e.target.value)}
               />
            )}
            <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
               <span className={cn(state === "error" && "text-destructive")}>
                  {state === "saving" ? "Saving…" : state === "error" ? "Not saved" : "Saved"}
               </span>
               <span>·</span>
               <span>Applies to new Sessions and Threads.</span>
            </div>
         </div>
      </ScrollArea>
   );
}
