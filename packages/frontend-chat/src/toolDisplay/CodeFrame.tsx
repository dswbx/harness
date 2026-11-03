import { cn } from "@harness/ui";
import { type ReactNode, useState } from "react";
import { CopyButton, Frame, useWrapCode, WrapButton } from "../CodeBlock";
import { Markdown } from "../Markdown";

export { Frame };

/** Lines shown before "Show all". */
const FOLD = 14;

/** Code in a step body, framed like the chat's code blocks: a header (label, meta, wrap, copy) over highlighted code. */
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
   const wrap = useWrapCode();
   const lines = code.split("\n");
   const folded = !all && lines.length > FOLD + 2;
   const shown = folded ? lines.slice(0, FOLD).join("\n") : code;
   return (
      <Frame
         label={label}
         meta={meta}
         action={
            <>
               <WrapButton />
               <CopyButton text={code} />
            </>
         }
      >
         <Markdown plainCode className={cn(CODE, "[&_pre]:max-h-none", wrap && WRAP_PRE)}>
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
/** `WRAP`, on the `pre` inside. */
const WRAP_PRE = "[&_pre]:whitespace-pre-wrap [&_pre]:[overflow-wrap:anywhere]";
