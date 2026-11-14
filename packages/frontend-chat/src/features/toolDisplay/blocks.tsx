import { toolDetail } from "@harness/api";
import { useMemo } from "react";
import { blockText, type ContentBlock } from "../../state/reducer";
import { DiffViewer } from "../changes/DiffViewer";
import { diffLines, splitPatch, unifiedPatch } from "../changes/diff";
import { languageOf } from "../markdown/highlight";
import { Markdown } from "../markdown/Markdown";
import { CodeFrame, Frame } from "./CodeFrame";
import { jsonTail, parseFence } from "./fence";
import type { Tool } from "./group";

/** `+a -d`, green and red. */
export function PlusMinus({ add, del }: { add: number; del: number }) {
   return (
      <>
         <span className="text-emerald-500">+{add}</span>{" "}
         <span className="text-red-400">-{del}</span>
      </>
   );
}

export function Diff({
   path,
   oldText,
   newText,
}: {
   path: string;
   oldText?: string | null;
   newText: string;
}) {
   const file = useMemo(
      () => splitPatch(unifiedPatch(path, oldText, newText))[0],
      [path, oldText, newText],
   );
   const stat = useMemo(() => {
      let add = 0;
      let del = 0;
      for (const l of diffLines(oldText, newText)) l.op === "+" ? add++ : l.op === "-" && del++;
      return <PlusMinus add={add} del={del} />;
   }, [oldText, newText]);
   return (
      <Frame label={path} meta={stat}>
         {file && <DiffViewer file={file} mode="unified" wrap />}
      </Frame>
   );
}

/** One content block of a call. `tool` names the file a fenced Read output belongs to. */
export function Block({ b, tool }: { b: ContentBlock; tool?: Tool }) {
   if (b.type === "diff") {
      return (
         <Diff
            path={String(b.path)}
            oldText={b.oldText as string | null}
            newText={String(b.newText ?? "")}
         />
      );
   }
   if (b.type === "terminal") {
      return <div className="text-xs text-muted-foreground">Terminal {String(b.terminalId)}</div>;
   }
   const text = blockText(b);
   if (text != null) {
      const detail = tool ? toolDetail(tool) : null;
      const fence = parseFence(text, detail?.read?.lineNumbered);
      if (!fence) {
         // MCP results are often JSON, or a sentence ending in JSON: show that part as code.
         const j = jsonTail(text);
         if (!j) return <Markdown className={STEP_TEXT}>{text}</Markdown>;
         return (
            <>
               {j.prose && <Markdown className={STEP_TEXT}>{j.prose}</Markdown>}
               <CodeFrame label="json" code={j.json} lang="json" />
            </>
         );
      }
      const command = detail?.command;
      if (command)
         // Plain output: `console` highlighting reads output lines starting with `#` or `$` as commands.
         return <CodeFrame label="console" code={fence.code} command={command} />;
      const path = detail?.read?.path;
      const lines = fence.from != null ? `lines ${fence.from}–${fence.to}` : undefined;
      return (
         <CodeFrame
            label={path?.split("/").pop() ?? (fence.lang || "output")}
            meta={lines}
            code={fence.code}
            lang={fence.lang || (path ? (languageOf(path) ?? "plaintext") : "")}
         />
      );
   }
   return (
      <pre className="overflow-auto rounded bg-muted p-2 text-code">
         {JSON.stringify(b, null, 2)}
      </pre>
   );
}

/** Prose in a step body (prompts, reports): the step size, not the chat's. */
export const STEP_TEXT = "[--typeset-size:calc(var(--chat-font-size,14px)*0.93)]";
