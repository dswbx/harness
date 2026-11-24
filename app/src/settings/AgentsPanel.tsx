import {
   type AgentInfo,
   errText,
   type HarnessClient,
   isCommandError,
   type RegistryAgent,
} from "@harness/api";
import {
   Button,
   Dialog,
   DialogContent,
   DialogDescription,
   DialogFooter,
   DialogHeader,
   DialogTitle,
} from "@harness/ui";
import { useCallback, useEffect, useState } from "react";
import { CustomAgentForm } from "./agents/CustomAgentForm";
import { InstalledList } from "./agents/InstalledList";
import { RegistryList } from "./agents/RegistryList";
import { SubSessionLimit } from "./agents/SubSessionLimit";
import { SectionHeader } from "./SectionHeader";

/** Installed Agents, the ACP Registry, Custom Agents, and the Sub Session limit. */
export function AgentsPanel({
   client,
   onChanged,
   version = 0,
}: {
   client: HarnessClient;
   /** Called after the installed list changed. */
   onChanged?: () => void;
   /** Bumps when the core reports AgentsChanged: reloads the lists while mounted. */
   version?: number;
}) {
   const [agents, setAgents] = useState<AgentInfo[]>([]);
   const [registry, setRegistry] = useState<RegistryAgent[]>([]);
   const [refreshing, setRefreshing] = useState(false);
   const [installing, setInstalling] = useState<Set<string>>(new Set());
   const [errors, setErrors] = useState<Record<string, string>>({});
   const [listError, setListError] = useState<string | null>(null);
   const [unverified, setUnverified] = useState<{ id: string; name: string } | null>(null);
   const [toRemove, setToRemove] = useState<AgentInfo | null>(null);
   const [removeError, setRemoveError] = useState<string | null>(null);

   const load = useCallback(
      async (refresh: boolean) => {
         setListError(null);
         try {
            const [a, r] = await Promise.all([client.listAgents(), client.listRegistry(refresh)]);
            setAgents(a);
            setRegistry(r);
         } catch (e) {
            setListError(errText(e));
         }
      },
      [client],
   );

   useEffect(() => {
      void load(false);
   }, [load, version]);

   const refresh = async () => {
      setRefreshing(true);
      await load(true);
      setRefreshing(false);
   };

   const install = async (id: string, allowUnverified = false) => {
      setInstalling((s) => new Set(s).add(id));
      setErrors((e) => ({ ...e, [id]: "" }));
      try {
         await client.installAgent(id, allowUnverified);
         await load(false);
         onChanged?.();
      } catch (e) {
         const message = errText(e);
         if (!allowUnverified && isCommandError(e, "policy_denied")) {
            // Ask before retrying without a checksum to verify against.
            setUnverified({ id, name: registry.find((r) => r.id === id)?.name ?? id });
         } else {
            setErrors((x) => ({ ...x, [id]: message }));
         }
      } finally {
         setInstalling((s) => {
            const n = new Set(s);
            n.delete(id);
            return n;
         });
      }
   };

   const act = async (regId: string, run: () => Promise<unknown>) => {
      setErrors((e) => ({ ...e, [regId]: "" }));
      try {
         await run();
         await load(false);
         onChanged?.();
      } catch (e) {
         setErrors((x) => ({ ...x, [regId]: errText(e) }));
      }
   };

   const remove = async () => {
      if (!toRemove) return;
      try {
         await client.removeAgent(toRemove.id);
         setToRemove(null);
         await load(false);
         onChanged?.();
      } catch (e) {
         setRemoveError(errText(e));
      }
   };

   return (
      <>
         <SectionHeader
            title="Agents"
            description="Install Agents from the ACP Registry or add your own."
         />
         <div className="grid gap-6 text-sm">
            {listError && (
               <p role="alert" className="text-destructive">
                  {listError}
               </p>
            )}

            <InstalledList
               client={client}
               agents={agents}
               registry={registry}
               installing={installing}
               errors={errors}
               act={act}
               install={install}
               onRemove={(a) => {
                  setToRemove(a);
                  setRemoveError(null);
               }}
            />

            <RegistryList
               registry={registry}
               installing={installing}
               errors={errors}
               refreshing={refreshing}
               refresh={refresh}
               install={install}
            />

            <CustomAgentForm
               client={client}
               onAdded={async () => {
                  await load(false);
                  onChanged?.();
               }}
            />

            <SubSessionLimit client={client} />
         </div>
         <Dialog open={unverified !== null} onOpenChange={(o) => !o && setUnverified(null)}>
            <DialogContent>
               <DialogHeader>
                  <DialogTitle>Install without verification?</DialogTitle>
                  <DialogDescription>
                     The ACP Registry lists no checksum for "{unverified?.name}", so the Harness
                     cannot check that the download is the file its author published. Only continue
                     if you trust the source. The download will run on your Mac with your
                     permissions.
                  </DialogDescription>
               </DialogHeader>
               <DialogFooter>
                  <Button variant="outline" onClick={() => setUnverified(null)}>
                     Cancel
                  </Button>
                  <Button
                     variant="destructive"
                     onClick={() => {
                        const id = unverified?.id;
                        setUnverified(null);
                        if (id) void install(id, true);
                     }}
                  >
                     Install unverified
                  </Button>
               </DialogFooter>
            </DialogContent>
         </Dialog>
         <Dialog open={toRemove !== null} onOpenChange={(o) => !o && setToRemove(null)}>
            <DialogContent>
               <DialogHeader>
                  <DialogTitle>Remove Agent?</DialogTitle>
                  <DialogDescription>
                     "{toRemove?.name}" will be removed. Existing Sessions keep their own copy of
                     its launch settings.
                  </DialogDescription>
               </DialogHeader>
               {removeError && (
                  <p role="alert" className="text-sm text-destructive">
                     {removeError}
                  </p>
               )}
               <DialogFooter>
                  <Button variant="outline" onClick={() => setToRemove(null)}>
                     Cancel
                  </Button>
                  <Button variant="destructive" onClick={() => void remove()}>
                     Remove
                  </Button>
               </DialogFooter>
            </DialogContent>
         </Dialog>
      </>
   );
}
