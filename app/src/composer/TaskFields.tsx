import { type HarnessClient, TASK_STATUS_LABEL, type TaskStatus } from "@harness/api";
import {
   Checkbox,
   Select,
   SelectContent,
   SelectItem,
   SelectTrigger,
   SelectValue,
   Textarea,
} from "@harness/ui";
import { ListTodo } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { type StartTask, type TaskParts, transcriptLabel } from "./composer";
import { Label } from "./parts";

/** The task the Session starts from (board "StartSession"). */
export function TaskCard({ task }: { task: StartTask }) {
   return (
      <div className="flex items-start gap-2.5 rounded-lg border bg-muted/40 px-3 py-2.5">
         <ListTodo className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
         <div className="min-w-0">
            <div className="truncate font-medium">{task.title}</div>
            <div className="truncate text-xs text-muted-foreground">
               {[task.id, task.detail].filter(Boolean).join(" · ")}
            </div>
         </div>
      </div>
   );
}

export function PromptField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
   const id = useId();
   return (
      <div className="grid gap-1">
         <label htmlFor={id}>
            <Label>Prompt</Label>
         </label>
         <Textarea
            id={id}
            rows={4}
            className="max-h-48 resize-none"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="What should the Agent do? Empty: start without a prompt."
         />
      </div>
   );
}

/** The origin Session's note and transcript, for their labels: none until loaded or when the Session is gone. */
function useOriginInfo(client: HarnessClient, sessionId: string | null) {
   const [info, setInfo] = useState<{ note: boolean; transcript: string | null } | null>(null);
   useEffect(() => {
      setInfo(null);
      if (!sessionId) return;
      let off = false;
      Promise.all([
         client
            .sessionApi(sessionId)
            .readNote()
            .then((n) => n.content.trim() !== "")
            .catch(() => false),
         client
            .transcriptSize(sessionId)
            .then((t) => (t.size.total_turns > 0 ? transcriptLabel(t.size, t.chars) : null))
            .catch(() => null),
      ]).then(([note, transcript]) => !off && setInfo({ note, transcript }));
      return () => {
         off = true;
      };
   }, [client, sessionId]);
   return info;
}

/** "Task context to include": the parts of the task the first prompt gets. */
export function TaskContextField({
   client,
   task,
   parts,
   setParts,
}: {
   client: HarnessClient;
   task: StartTask;
   parts: TaskParts;
   setParts: (f: (p: TaskParts) => TaskParts) => void;
}) {
   const origin = useOriginInfo(client, task.origin?.sessionId ?? null);
   const none = (why: string) => <span className="text-muted-foreground">({why})</span>;
   const rows: { key: keyof TaskParts; label: string; extra?: React.ReactNode; off?: boolean }[] = [
      { key: "summary", label: "Title, status, upstream link" },
      {
         key: "body_and_assets",
         label: "Description and assets",
         extra: task.assets
            ? none(`${task.assets} file${task.assets === 1 ? "" : "s"}`)
            : !task.hasBody && none("empty"),
         off: !task.hasBody && !task.assets,
      },
      {
         key: "parent_and_siblings",
         label: "Parent topic and sibling tasks",
         extra: !task.hasParent && none("no parent"),
         off: !task.hasParent,
      },
      {
         key: "origin_note",
         label: "Note from origin session",
         extra: !task.origin ? none("no session") : origin && !origin.note && none("empty"),
         off: !task.origin || (origin !== null && !origin.note),
      },
      {
         key: "origin_transcript",
         label: "Summary of origin session chat",
         extra: !task.origin ? none("no session") : origin && none(origin.transcript ?? "no turns"),
         off: !task.origin || (origin !== null && !origin.transcript),
      },
   ];
   return (
      <fieldset className="grid gap-1">
         <legend className="contents">
            <Label>Task context to include</Label>
         </legend>
         {rows.map((r) => (
            <label
               key={r.key}
               className="flex min-h-7 items-center gap-2.5 text-[13px] has-[button:disabled]:opacity-60"
            >
               <Checkbox
                  checked={parts[r.key] && !r.off}
                  disabled={r.off}
                  onCheckedChange={(v) => setParts((p) => ({ ...p, [r.key]: v === true }))}
               />
               <span>
                  {r.label} {r.extra}
               </span>
            </label>
         ))}
      </fieldset>
   );
}

const KEEP = "keep";
const STATUSES = Object.keys(TASK_STATUS_LABEL) as TaskStatus[];

/** "Set status": set once when the Session starts, never set back. */
export function SetStatusField({
   current,
   value,
   onChange,
}: {
   current: TaskStatus;
   value: TaskStatus | null;
   onChange: (s: TaskStatus | null) => void;
}) {
   return (
      <div className="grid gap-1">
         <Label>Set task status</Label>
         <Select
            value={value ?? KEEP}
            onValueChange={(v) => onChange(v === KEEP ? null : (v as TaskStatus))}
         >
            <SelectTrigger className="h-8 w-full" aria-label="Set task status">
               <SelectValue />
            </SelectTrigger>
            <SelectContent>
               <SelectItem value={KEEP}>Keep {TASK_STATUS_LABEL[current]}</SelectItem>
               {STATUSES.filter((s) => s !== current).map((s) => (
                  <SelectItem key={s} value={s}>
                     {TASK_STATUS_LABEL[s]}
                  </SelectItem>
               ))}
            </SelectContent>
         </Select>
      </div>
   );
}
