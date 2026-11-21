import { Button, cn, Input, Tooltip } from "@harness/ui";
import { Plus, X } from "lucide-react";
import { type KeyboardEvent, useRef, useState } from "react";
import { FIELD_CHIP } from "./chips";

/** Rules of ADR 0029 (as the core's `clean_props`). */
const MAX_PROPS = 16;
const KEY = /^[a-z0-9_-]{1,32}$/;

/** Why the key is refused (null: it is fine). */
function propKeyError(key: string): string | null {
   return KEY.test(key) ? null : "Key: 1 to 32 characters of a-z, 0-9, _ and -.";
}

/** Why the value (trimmed) is refused (null: it is fine). */
function propValueError(value: string): string | null {
   const v = value.trim();
   return v && [...v].length <= 64 && !/[\r\n]/.test(v)
      ? null
      : "Value: 1 to 64 characters on one line.";
}

/**
 * A task's Properties (ADR 0029): one line per key with its value. A click on a value edits it in place (Enter or
 * blur saves, Esc cancels); × removes the key; Add property asks for a key and a value. Each change sends the whole
 * new map (`onChange`), checked first by the core's rules.
 */
export function PropsField({
   props,
   onChange,
}: {
   props: Readonly<Record<string, string>>;
   onChange: (props: Record<string, string>) => void;
}) {
   const [editing, setEditing] = useState<string | null>(null);
   const [adding, setAdding] = useState(false);
   const entries = Object.entries(props).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
   const set = (key: string, value: string) => onChange({ ...props, [key]: value.trim() });
   const remove = (key: string) => {
      const next = { ...props };
      delete next[key];
      onChange(next);
   };
   return (
      <div className="flex flex-col gap-1.5">
         {entries.length > 0 && (
            <div className="grid grid-cols-[6rem_minmax(0,1fr)] items-center gap-x-2 gap-y-1.5 text-xs">
               {entries.map(([key, value]) => (
                  <PropLine
                     key={key}
                     name={key}
                     value={value}
                     editing={editing === key}
                     onEdit={(on) => setEditing(on ? key : null)}
                     onSave={(v) => {
                        setEditing(null);
                        if (v.trim() !== value) set(key, v);
                     }}
                     onRemove={() => remove(key)}
                  />
               ))}
            </div>
         )}
         {adding ? (
            <AddProp
               taken={(k) => Object.hasOwn(props, k)}
               onAdd={(k, v) => {
                  setAdding(false);
                  set(k, v);
               }}
               onCancel={() => setAdding(false)}
            />
         ) : entries.length < MAX_PROPS ? (
            <Button
               size="sm"
               variant="ghost"
               className="h-6 self-start gap-1 px-1.5 text-xs font-normal text-muted-foreground hover:text-foreground [&_svg]:size-3"
               onClick={() => setAdding(true)}
            >
               <Plus /> Add property
            </Button>
         ) : (
            <p className="text-xs text-muted-foreground/70">{MAX_PROPS} properties at most.</p>
         )}
      </div>
   );
}

function PropLine({
   name,
   value,
   editing,
   onEdit,
   onSave,
   onRemove,
}: {
   name: string;
   value: string;
   editing: boolean;
   onEdit: (on: boolean) => void;
   onSave: (value: string) => void;
   onRemove: () => void;
}) {
   const [draft, setDraft] = useState(value);
   const [error, setError] = useState<string | null>(null);
   /** The edit ended (saved or cancelled): a late blur does nothing. */
   const ended = useRef(false);
   const end = (save: boolean) => {
      ended.current = true;
      setError(null);
      if (save) onSave(draft);
      else onEdit(false);
   };
   const save = () => {
      const e = propValueError(draft);
      setError(e);
      if (!e) end(true);
   };
   return (
      <>
         <span className="flex h-6 items-center truncate text-muted-foreground" title={name}>
            {name}
         </span>
         <div className="group/prop flex min-w-0 flex-col gap-0.5">
            <div className="flex min-w-0 items-center gap-1">
               {editing ? (
                  <Input
                     autoFocus
                     aria-label={`Value of ${name}`}
                     value={draft}
                     maxLength={200}
                     onChange={(e) => setDraft(e.target.value)}
                     onKeyDown={(e) => {
                        if (e.key === "Enter") {
                           e.preventDefault();
                           save();
                        } else if (e.key === "Escape") {
                           e.preventDefault();
                           end(false);
                        }
                     }}
                     // A blur saves a valid value and drops a refused one.
                     onBlur={() => !ended.current && end(!propValueError(draft))}
                     className="h-6 rounded-md px-2 text-xs"
                  />
               ) : (
                  <button
                     type="button"
                     aria-label={`Edit ${name}: ${value}`}
                     className={cn(FIELD_CHIP, "min-w-0")}
                     onClick={() => {
                        setDraft(value);
                        setError(null);
                        ended.current = false;
                        onEdit(true);
                     }}
                  >
                     <span className="truncate">{value}</span>
                  </button>
               )}
               <Tooltip content={`Remove ${name}`}>
                  <button
                     type="button"
                     aria-label={`Remove ${name}`}
                     className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground opacity-0 hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover/prop:opacity-100"
                     // Keep the value's input focused, so its blur does not save first.
                     onMouseDown={(e) => e.preventDefault()}
                     onClick={onRemove}
                  >
                     <X className="size-3" />
                  </button>
               </Tooltip>
            </div>
            {error && (
               <span role="alert" className="text-[11px] text-destructive">
                  {error}
               </span>
            )}
         </div>
      </>
   );
}

/** A key and a value; Enter adds them (when both are fine), Esc cancels. */
function AddProp({
   taken,
   onAdd,
   onCancel,
}: {
   taken: (key: string) => boolean;
   onAdd: (key: string, value: string) => void;
   onCancel: () => void;
}) {
   const [key, setKey] = useState("");
   const [value, setValue] = useState("");
   const [error, setError] = useState<string | null>(null);
   const submit = () => {
      const k = key.trim();
      const e =
         propKeyError(k) ??
         (taken(k) ? `This task already has ${k}.` : null) ??
         propValueError(value);
      setError(e);
      if (!e) onAdd(k, value);
   };
   const keys = (e: KeyboardEvent) => {
      if (e.key === "Enter") {
         e.preventDefault();
         submit();
      } else if (e.key === "Escape") {
         e.preventDefault();
         onCancel();
      }
   };
   return (
      <div className="flex flex-col gap-1">
         <div className="grid grid-cols-[6rem_minmax(0,1fr)_auto] items-center gap-x-2">
            <Input
               autoFocus
               aria-label="Property key"
               placeholder="key"
               value={key}
               maxLength={64}
               onChange={(e) => setKey(e.target.value)}
               onKeyDown={keys}
               className="h-6 rounded-md px-2 text-xs"
            />
            <Input
               aria-label="Property value"
               placeholder="value"
               value={value}
               maxLength={200}
               onChange={(e) => setValue(e.target.value)}
               onKeyDown={keys}
               className="h-6 rounded-md px-2 text-xs"
            />
            <div className="flex items-center gap-0.5">
               <Button size="sm" className="h-6 px-2 text-xs" onClick={submit}>
                  Add
               </Button>
               <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-xs text-muted-foreground"
                  onClick={onCancel}
               >
                  Cancel
               </Button>
            </div>
         </div>
         {error && (
            <span role="alert" className="text-[11px] text-destructive">
               {error}
            </span>
         )}
      </div>
   );
}
