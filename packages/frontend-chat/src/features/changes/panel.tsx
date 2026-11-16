import {
   onSessionForgotten,
   type Stored,
   storedValue,
   useGitStatus,
   useStoredValue,
} from "@harness/api";
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
   /** A Turn changed files since the panel was last open. */
   unseen: boolean;
};

// The last Turn's changes the user saw (its item id), per Session: kept across reloads and windows.
const seenStores = new Map<string, Stored<string | null>>();
onSessionForgotten((id) => void seenStores.delete(id));
const seenStore = (sessionId: string) => {
   let s = seenStores.get(sessionId);
   if (!s) {
      s = storedValue<string | null>({
         key: `harness.changes.seen.${sessionId}`,
         scope: { session: sessionId },
         parse: (raw) => raw || null,
         serialize: (v) => v ?? "",
      });
      seenStores.set(sessionId, s);
   }
   return s;
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
      const turnRunning = state.turnId !== null;
      // The folder can become a repository later (`git init`): the store looks again after each Turn, and for
      // a terminal command every 20s and on focus, until it is one.
      const git = useGitStatus(api, { status: false, refreshKey: turnRunning }).isRepo === true;
      // One pass over the items per batch (as the View did before).
      const { changeCount, lastChange } = useMemo(() => {
         let n = 0;
         let last: string | null = null;
         for (const i of state.items) {
            if (i.type !== "changes") continue;
            n++;
            if (i.files.length) last = i.id;
         }
         return { changeCount: n, lastChange: last };
      }, [state.items]);
      const refreshKey = `${changeCount}:${turnRunning}`;
      const store = seenStore(api.sessionId);
      const seen = useStoredValue(store);
      // Open: whatever it shows counts as seen.
      useEffect(() => {
         if (self.open && lastChange && lastChange !== seen) store.set(lastChange);
      }, [self.open, lastChange, seen, store]);
      const unseen = !self.open && lastChange !== null && lastChange !== seen;
      return useMemo(
         () => ({ git, scope, setScope, refreshKey, unseen }),
         [git, scope, refreshKey, unseen],
      );
   },
   status: (m) => ({ presence: m.git ? "ready" : "absent", dot: m.unseen }),
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
