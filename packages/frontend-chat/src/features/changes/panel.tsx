import { GitCompare } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { definePanel, type PanelBodyProps } from "../../panels/contract";
import { usePanelTarget } from "../../panels/usePanelTarget";
import { ALL_CHANGES, DiffPanel, type DiffScope } from "./DiffPanel";

export type ChangesModel = {
   /** The Workspace is a git repository. */
   git: boolean;
   scope: DiffScope;
   setScope: (s: DiffScope) => void;
   /** Changes whenever the Session log says the Workspace may have changed. */
   refreshKey: string;
};

/** The Workspace's diff, opened at a scope. Without a repository it has no icon (but keeps its place). */
export const changesPanel = definePanel<ChangesModel, DiffScope>({
   id: "changes",
   label: "Changes",
   icon: GitCompare,
   placement: { edge: "right" },
   useModel: ({ api, state }, self) => {
      const [scope, setScope] = useState<DiffScope>(ALL_CHANGES);
      // Opened at a scope, it shows that one (also while hidden: the scope outlives the panel's body).
      usePanelTarget(self, setScope);
      const [git, setGit] = useState(false);
      const turnRunning = state.turnId !== null;
      // The folder can become a repository later (`git init`): look again after each Turn, and for a
      // terminal command every 20s and on focus, until it is one.
      // biome-ignore lint/correctness/useExhaustiveDependencies: turnRunning triggers the check.
      useEffect(() => {
         let off = false;
         const check = () => {
            if (document.hidden) return;
            api.workspace().then(
               (w) => !off && setGit(!!w?.repo_root),
               () => {},
            );
         };
         check();
         if (git) {
            return () => {
               off = true;
            };
         }
         const timer = setInterval(check, 20_000);
         window.addEventListener("focus", check);
         return () => {
            off = true;
            clearInterval(timer);
            window.removeEventListener("focus", check);
         };
      }, [api, turnRunning, git]);
      // One pass over the items per batch (as the View did before).
      const changeCount = useMemo(
         () => state.items.reduce((n, i) => n + (i.type === "changes" ? 1 : 0), 0),
         [state.items],
      );
      const refreshKey = `${changeCount}:${turnRunning}`;
      return useMemo(() => ({ git, scope, setScope, refreshKey }), [git, scope, refreshKey]);
   },
   status: (m) => ({ presence: m.git ? "ready" : "absent" }),
   Body: ({ model, ctx }: PanelBodyProps<ChangesModel, DiffScope>) => (
      <DiffPanel
         api={ctx.api}
         scope={model.scope}
         onScope={model.setScope}
         refreshKey={model.refreshKey}
         onRefresh={ctx.host.gitRefresh}
      />
   ),
});
