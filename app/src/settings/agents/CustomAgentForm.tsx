import { errText, type HarnessClient } from "@harness/api";
import { Button, Input, Textarea } from "@harness/ui";
import { useState } from "react";
import { parseEnvLines } from "../agents";
import { heading } from "./heading";

/** Add a Custom Agent: a command with args and env. */
export function CustomAgentForm({
   client,
   onAdded,
}: {
   client: HarnessClient;
   /** Called after the Agent was added (the lists reload). */
   onAdded: () => Promise<void>;
}) {
   const [name, setName] = useState("");
   const [command, setCommand] = useState("");
   const [args, setArgs] = useState("");
   const [env, setEnv] = useState("");
   const [customError, setCustomError] = useState<string | null>(null);
   const [adding, setAdding] = useState(false);

   const addCustom = async () => {
      setAdding(true);
      setCustomError(null);
      try {
         const envMap = parseEnvLines(env);
         await client.addCustomAgent({
            name: name.trim(),
            command: command.trim(),
            args: args.split(/\s+/).filter(Boolean),
            env: envMap,
         });
         setName("");
         setCommand("");
         setArgs("");
         setEnv("");
         await onAdded();
      } catch (e) {
         setCustomError(errText(e));
      } finally {
         setAdding(false);
      }
   };

   return (
      <section className="grid gap-2">
         <h3 className={heading}>Add Custom Agent</h3>
         <div className="grid gap-2">
            <label className="grid gap-1">
               Name
               <Input value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="grid gap-1">
               Command (absolute path)
               <Input
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  placeholder="/usr/local/bin/my-agent"
               />
            </label>
            <label className="grid gap-1">
               Args
               <Input
                  value={args}
                  onChange={(e) => setArgs(e.target.value)}
                  placeholder="--acp --verbose"
               />
            </label>
            <label className="grid gap-1">
               Env (KEY=VALUE per line)
               <Textarea rows={3} value={env} onChange={(e) => setEnv(e.target.value)} />
            </label>
            {customError && (
               <p role="alert" className="text-destructive">
                  {customError}
               </p>
            )}
            <div className="flex justify-end">
               <Button
                  disabled={adding || !name.trim() || !command.trim()}
                  onClick={() => void addCustom()}
               >
                  Add Agent
               </Button>
            </div>
         </div>
      </section>
   );
}
