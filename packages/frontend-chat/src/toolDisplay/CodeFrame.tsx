import { cn } from "@harness/ui";
import { Check, Copy } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Markdown } from "../Markdown";

/** Lines shown before "Show all". */
const FOLD = 14;

/** Code in a step body, framed like the chat's code blocks: a header (label, meta, copy) over highlighted code. */
export function CodeFrame({
   label,
   meta,
   code,
   lang,
}: {
   label: string;
   meta?: ReactNode;
   code: string;
   lang?: string;
}) {
   const [all, setAll] = useState(false);
   const [copied, setCopied] = useState(false);
   const lines = code.split("\n");
   const folded = !all && lines.length > FOLD + 2;
   const shown = folded ? lines.slice(0, FOLD).join("\n") : code;
   const copy = () =>
      void navigator.clipboard.writeText(code).then(
         () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
         },
         () => {},
      );
   return (
      <Frame
         label={label}
         meta={meta}
         action={
            <button
               type="button"
               aria-label="Copy"
               className="ml-auto flex hover:text-foreground"
               onClick={copy}
            >
               {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            </button>
         }
      >
         <Markdown className={cn(CODE, "[&_pre]:max-h-none")}>
            {"````" + (lang ?? "") + "\n" + shown + "\n````"}
         </Markdown>
         {folded && (
            <button
               type="button"
               className="w-full border-t px-3 py-1 text-left font-mono text-ui-sm text-muted-foreground hover:text-foreground"
               onClick={() => setAll(true)}
            >
               … {lines.length - FOLD} more lines
            </button>
         )}
      </Frame>
   );
}

/** Borderless code inside the frame, the size of the chat's code blocks. */
const CODE = "[&_pre]:m-0 [&_pre]:rounded-none [&_pre]:border-0";

export function Frame({
   label,
   meta,
   action,
   children,
}: {
   label: ReactNode;
   meta?: ReactNode;
   action?: ReactNode;
   children: ReactNode;
}) {
   return (
      <div className="overflow-hidden rounded-lg border bg-card text-card-foreground">
         <div className="flex min-w-0 items-center gap-2 border-b px-2.5 py-1 font-mono text-ui-sm text-muted-foreground">
            <span className="min-w-0 truncate">{label}</span>
            {meta && <span className="shrink-0">{meta}</span>}
            {action}
         </div>
         {children}
      </div>
   );
}
