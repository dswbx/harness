import type { HarnessClient } from "@harness/api";
import { Input } from "@harness/ui";
import { useEffect, useState } from "react";
import { SectionHeader } from "./SectionHeader";
import { useReportError } from "./toast";

const DEFAULT = ".harness";

/** Settings > Worktrees: the folder new Worktrees go in. */
export function WorktreesPanel({ client }: { client: HarnessClient }) {
   const report = useReportError();
   const [saved, setSaved] = useState<string | undefined>(undefined);
   const [dir, setDir] = useState("");
   useEffect(() => {
      client.getWorktreeDir().then(
         (d) => {
            setSaved(d);
            setDir(d);
         },
         (e) => report("Could not load the Worktree folder", e),
      );
   }, [client, report]);
   const save = (d: string) => {
      const v = d.trim() || DEFAULT;
      setDir(v);
      if (v === saved) return;
      setSaved(v);
      client
         .setWorktreeDir(v === DEFAULT ? null : v)
         .catch((e) => report("Could not save the Worktree folder", e));
   };
   if (saved === undefined) return null;
   return (
      <div>
         <SectionHeader
            title="Worktrees"
            description="Where new Worktrees go. Each Session gets its own folder in it. Existing Worktrees stay where they are."
         />
         <label className="grid max-w-lg grid-cols-1 gap-1.5 text-sm">
            <span className="text-muted-foreground">Folder</span>
            <Input
               className="font-mono text-xs"
               value={dir}
               placeholder={DEFAULT}
               onChange={(e) => setDir(e.target.value)}
               onBlur={() => save(dir)}
               onKeyDown={(e) => e.key === "Enter" && save(dir)}
            />
         </label>
         <p className="mt-2 max-w-lg text-xs text-muted-foreground">
            A relative path is inside the repository (Harness hides it from git status). An absolute
            path or one that starts with <code className="font-mono">~</code> is one folder for all
            repositories.
         </p>
         {saved !== DEFAULT && (
            <button
               className="mt-3 text-xs text-muted-foreground hover:text-foreground"
               onClick={() => save(DEFAULT)}
            >
               Reset to {DEFAULT}
            </button>
         )}
      </div>
   );
}
