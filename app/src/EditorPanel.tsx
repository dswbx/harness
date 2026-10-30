import { useEffect, useState } from "react";
import type { Editor, HarnessClient } from "@harness/api";
import { Input, cn } from "@harness/ui";
import { SectionHeader } from "./SectionHeader";
import { useReportError } from "./toast";

const CHOICES: { type: Editor["type"]; label: string; hint: string }[] = [
  { type: "vscode", label: "VS Code", hint: "vscode://file/…" },
  { type: "cursor", label: "Cursor", hint: "cursor://file/…" },
  { type: "windsurf", label: "Windsurf", hint: "windsurf://file/…" },
  { type: "zed", label: "Zed", hint: "zed://file/…" },
  { type: "custom", label: "Custom URL", hint: "Your editor's URL, with {path} and {line}" },
  { type: "system", label: "System default app", hint: "Opens files without a line" },
];

/** Settings > Editor: what "Open in editor" (the Session menu, file links in Agent output) uses. */
export function EditorPanel({ client }: { client: HarnessClient }) {
  const report = useReportError();
  const [editor, setEditor] = useState<Editor | null | undefined>(undefined);
  const [template, setTemplate] = useState("");
  useEffect(() => {
    client.getEditor().then((e) => {
      setEditor(e);
      if (e?.type === "custom") setTemplate(e.template);
    }, (e) => report("Could not load the editor setting", e));
  }, [client, report]);
  const save = (e: Editor | null) => {
    setEditor(e);
    client.setEditor(e).catch((err) => report("Could not save the editor", err));
  };
  const pick = (type: Editor["type"]) => save(type === "custom" ? { type, template: template || "idea://open?file={path}&line={line}" } : { type });
  if (editor === undefined) return null;
  return (
    <div>
      <SectionHeader title="Editor" description="Opens a Session's folder from its menu, and files at a line from links in Agent output. Only files inside the Session's folder open." />
      <div role="radiogroup" className="grid max-w-lg grid-cols-1 gap-1.5">
        {CHOICES.map((c) => {
          const on = editor?.type === c.type;
          return (
            <button
              key={c.type}
              role="radio"
              aria-checked={on}
              onClick={() => pick(c.type)}
              className={cn("flex items-center gap-3 rounded-md border px-3 py-2 text-left text-sm", on ? "border-primary bg-primary/10" : "hover:bg-accent")}
            >
              <span className={cn("grid size-4 shrink-0 place-items-center rounded-full border border-muted-foreground/50", on && "border-primary")}>
                {on && <span className="size-2 rounded-full bg-primary" />}
              </span>
              <span className="flex-1 font-medium">{c.label}</span>
              <span className="font-mono text-xs text-muted-foreground">{c.hint}</span>
            </button>
          );
        })}
      </div>
      {editor?.type === "custom" && (
        <label className="mt-3 grid max-w-lg grid-cols-1 gap-1.5 text-sm">
          <span className="text-muted-foreground">URL template</span>
          <Input
            className="font-mono text-xs"
            value={template}
            onChange={(e) => setTemplate(e.target.value)}
            onBlur={() => template.trim() && save({ type: "custom", template: template.trim() })}
          />
        </label>
      )}
      {editor && (
        <button className="mt-3 text-xs text-muted-foreground hover:text-foreground" onClick={() => save(null)}>
          Clear choice
        </button>
      )}
    </div>
  );
}
