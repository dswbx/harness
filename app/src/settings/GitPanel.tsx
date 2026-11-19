import type { BranchPrefix, HarnessClient } from "@harness/api";
import { Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@harness/ui";
import { useEffect, useState } from "react";
import { useReportError } from "../platform/toast";
import { SectionHeader } from "./SectionHeader";

const DEFAULT = ".harness";

/** Settings > Git: where new Worktrees go and what new branches are called. */
export function GitPanel({ client }: { client: HarnessClient }) {
   return (
      <div>
         <SectionHeader title="Git" description="How Sessions use git." />
         <WorktreeFolder client={client} />
         <BranchPrefixSetting client={client} />
      </div>
   );
}

function WorktreeFolder({ client }: { client: HarnessClient }) {
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
      const prev = saved;
      setSaved(v);
      client.setWorktreeDir(v === DEFAULT ? null : v).catch((e) => {
         // The core never stored it: show what it still has.
         setSaved(prev);
         setDir(prev ?? DEFAULT);
         report("Could not save the Worktree folder", e);
      });
   };
   if (saved === undefined) return null;
   return (
      <section>
         <h3 className="text-sm font-medium">Worktrees</h3>
         <p className="mb-3 text-sm text-muted-foreground">
            Where new Worktrees go. Each Session gets its own folder in it. Existing Worktrees stay
            where they are.
         </p>
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
      </section>
   );
}

type Saved = { prefix: BranchPrefix; resolved: string };

function BranchPrefixSetting({ client }: { client: HarnessClient }) {
   const report = useReportError();
   const [saved, setSaved] = useState<Saved | undefined>(undefined);
   const [custom, setCustom] = useState("");
   const load = () =>
      client.getBranchPrefix().then(
         (s) => {
            setSaved(s);
            if (s.prefix.type === "custom") setCustom(s.prefix.prefix);
         },
         (e) => report("Could not load the branch prefix", e),
      );
   // biome-ignore lint/correctness/useExhaustiveDependencies: load once per client
   useEffect(() => {
      load();
   }, [client]);
   const save = (prefix: BranchPrefix) => {
      client.setBranchPrefix(prefix.type === "harness" ? null : prefix).then(load, (e) => {
         // The core never stored it: show what it still has.
         if (saved?.prefix.type === "custom") setCustom(saved.prefix.prefix);
         report("Could not save the branch prefix", e);
      });
   };
   if (saved === undefined) return null;
   const type = saved.prefix.type;
   const example = `${saved.resolved ? `${saved.resolved}/` : ""}fix-login-1a2b3c`;
   return (
      <section className="mt-8">
         <h3 className="text-sm font-medium">Branches</h3>
         <p className="mb-3 text-sm text-muted-foreground">
            What new Worktree branches start with. A branch you name yourself stays as you named it.
         </p>
         <label className="grid max-w-lg grid-cols-1 gap-1.5 text-sm">
            <span className="text-muted-foreground">Prefix</span>
            <Select
               value={type}
               onValueChange={(v) =>
                  save(
                     v === "custom"
                        ? // Starts from the prefix new branches get now.
                          { type: "custom", prefix: saved.resolved }
                        : { type: v as "harness" | "github_user" },
                  )
               }
            >
               <SelectTrigger aria-label="Branch prefix">
                  <SelectValue />
               </SelectTrigger>
               <SelectContent>
                  <SelectItem value="harness">harness</SelectItem>
                  <SelectItem value="github_user">GitHub username</SelectItem>
                  <SelectItem value="custom">Custom</SelectItem>
               </SelectContent>
            </Select>
         </label>
         {type === "custom" && (
            <label className="mt-3 grid max-w-lg grid-cols-1 gap-1.5 text-sm">
               <span className="text-muted-foreground">Custom prefix</span>
               <Input
                  className="font-mono text-xs"
                  value={custom}
                  placeholder="none"
                  onChange={(e) => setCustom(e.target.value)}
                  onBlur={() => save({ type: "custom", prefix: custom })}
                  onKeyDown={(e) => e.key === "Enter" && save({ type: "custom", prefix: custom })}
               />
            </label>
         )}
         <p className="mt-2 max-w-lg text-xs text-muted-foreground">
            New branches look like <code className="font-mono">{example}</code>.
            {type === "github_user" && " Uses harness while no GitHub user is signed in."}
            {type === "custom" && " Leave it empty for no prefix."}
         </p>
      </section>
   );
}
