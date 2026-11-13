import { cn, Tooltip } from "@harness/ui";
import { Check, Copy, WrapText } from "lucide-react";
import { type ReactNode, useState } from "react";
import { localPref } from "./localPref";

/** Per-viewer choice (Settings > Appearance, or any code block's wrap button), off by default. */
const wrapPref = localPref("harness.chat.wrapCode", false);
export const setWrapCode = wrapPref.set;
/** Whether code blocks wrap long lines instead of scrolling sideways. */
export const useWrapCode = wrapPref.use;

/** For a `pre` that follows the wrap choice. */
export const WRAP = "whitespace-pre-wrap [overflow-wrap:anywhere]";

const BUTTON =
   "flex size-6 items-center justify-center rounded-[5px] hover:bg-muted hover:text-foreground";

/** Copies `text`; a check for a moment after, in the same place (nothing shifts). */
/** `label`: what it copies, for screen readers (default "Copy"). */
export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
   const [copied, setCopied] = useState(false);
   const copy = () =>
      void navigator.clipboard.writeText(text).then(
         () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
         },
         () => {},
      );
   return (
      <button
         type="button"
         aria-label={copied ? "Copied" : label}
         className={cn(BUTTON, copied && "text-emerald-500 hover:text-emerald-500")}
         onClick={copy}
      >
         {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </button>
   );
}

/** Flips the wrap choice for every code block. */
export function WrapButton() {
   const wrap = useWrapCode();
   return (
      <Tooltip content={wrap ? "Don't wrap lines" : "Wrap lines"}>
         <button
            type="button"
            aria-label="Wrap lines"
            aria-pressed={wrap}
            className={cn(BUTTON, wrap && "bg-muted text-foreground")}
            onClick={() => setWrapCode(!wrap)}
         >
            <WrapText className="size-3.5" />
         </button>
      </Tooltip>
   );
}

/** Code in a frame: a header (label, meta, actions) over the code. Tool steps and message code blocks share it. */
export function Frame({
   label,
   meta,
   action,
   className,
   children,
}: {
   label: ReactNode;
   meta?: ReactNode;
   action?: ReactNode;
   className?: string;
   children: ReactNode;
}) {
   return (
      <div
         className={cn("overflow-hidden rounded-lg border bg-card text-card-foreground", className)}
      >
         <div className="flex min-w-0 items-center gap-2 border-b py-0.5 pr-1 pl-2.5 font-mono text-ui-sm text-muted-foreground">
            <span className="min-w-0 truncate">{label}</span>
            {meta && <span className="shrink-0">{meta}</span>}
            {action && <span className="ml-auto flex shrink-0 items-center gap-0.5">{action}</span>}
         </div>
         {children}
      </div>
   );
}

/** A message's code block: its language, wrap and copy over the code. */
export function CodeBlock({
   lang,
   text,
   children,
}: {
   lang: string | null;
   text: string;
   children: ReactNode;
}) {
   const wrap = useWrapCode();
   return (
      <Frame
         label={lang ?? "text"}
         className="chat-wide mt-(--typeset-flow)"
         action={
            <>
               <WrapButton />
               <CopyButton text={text} />
            </>
         }
      >
         <pre className={cn("m-0 rounded-none", wrap && WRAP)}>{children}</pre>
      </Frame>
   );
}
