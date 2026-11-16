import { cn } from "@harness/ui";
import { type ReactNode, useState } from "react";
import { AnsiText } from "../markdown/AnsiText";
import { CopyButton, Frame, LinkButton, useWrapCode, WrapButton } from "../markdown/CodeBlock";
import { Highlighted } from "../markdown/Highlighted";

export { Frame };

/** Lines shown before "Show all". */
const FOLD = 14;

/** Code in a step body, framed like the chat's code blocks: a header (label, meta, wrap, copy) over highlighted code. */
export function CodeFrame({
   label,
   meta,
   code,
   lang,
   command,
   href,
}: {
   label: string;
   meta?: ReactNode;
   code: string;
   lang?: string;
   /** A shell command shown as `$ command` above the code (its output). */
   command?: string;
   /** A link shown in the header as an open button. */
   href?: string;
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
               {href && <LinkButton href={href} />}
               <WrapButton />
               <CopyButton text={code} />
            </>
         }
      >
         {command && (
            <CodeText
               code={`$ ${command}`}
               lang="console"
               className={cn(CODE, "[&_pre]:max-h-none", wrap && WRAP_PRE, code && "border-b")}
            />
         )}
         {code && (
            <CodeText
               code={shown}
               lang={lang}
               className={cn(CODE, "[&_pre]:max-h-none", wrap && WRAP_PRE)}
            />
         )}
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

/**
 * The code, highlighted, as the chat's code blocks show it. It does not go through Markdown (as a fence),
 * so a line of backticks in the code cannot end it early. `ansi` is terminal output with color codes.
 */
function CodeText({ code, lang, className }: { code: string; lang?: string; className?: string }) {
   return (
      <div className={cn("typeset typeset-chat", className)}>
         <pre className="chat-wide">
            {lang === "ansi" ? (
               <code>
                  <AnsiText text={code} />
               </code>
            ) : (
               <code className={lang ? `hljs language-${lang}` : undefined}>
                  <Highlighted lang={lang} text={code} />
                  {"\n"}
               </code>
            )}
         </pre>
      </div>
   );
}

/** Borderless code inside the frame, the size of the chat's code blocks. */
const CODE = "[&_pre]:m-0 [&_pre]:rounded-none [&_pre]:border-0";
/** `WRAP`, on the `pre` inside. */
const WRAP_PRE = "[&_pre]:whitespace-pre-wrap [&_pre]:[overflow-wrap:anywhere]";
