import { lazy, Suspense, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { AnsiText } from "./AnsiText";
import { Expandable } from "./Expandable";
import { rehypeInlineCode, useGuessInlineCode } from "./inlineCode";
import { PrChip, usePrRefs } from "./prRefs";
import { rehypePrRefs } from "./rehypePrRefs";

/** mermaid is large: loaded with the first diagram. */
const Mermaid = lazy(() => import("./Mermaid").then((m) => ({ default: m.Mermaid })));

type Hast = {
   type: string;
   value?: string;
   tagName?: string;
   properties?: { className?: unknown; dataPrRef?: unknown; dataRaw?: unknown };
   children?: Hast[];
};
const textOf = (n: Hast): string => n.value ?? (n.children ?? []).map(textOf).join("");

/** ```mermaid fences become diagrams and ```ansi fences terminal output; other code stays as is. */
const components: import("react-markdown").Components = {
   pre({ node, children, ...props }) {
      const code = (node as Hast | undefined)?.children?.[0];
      const cls = Array.isArray(code?.properties?.className)
         ? (code.properties.className as string[])
         : [];
      if (code && cls.includes("language-mermaid")) {
         return (
            <div className="chat-wide" data-artifact="diagram">
               <Suspense fallback={<div className="h-24 animate-pulse rounded-md bg-muted" />}>
                  <Mermaid source={textOf(code).replace(/\n$/, "")} />
               </Suspense>
            </div>
         );
      }
      if (code && cls.includes("language-ansi")) {
         return (
            <pre {...props} className="chat-wide">
               <code>
                  <AnsiText text={textOf(code).replace(/\n$/, "")} />
               </code>
            </pre>
         );
      }
      return (
         <pre {...props} className="chat-wide">
            {children}
         </pre>
      );
   },
   // Tables look like render_ui's Table (utilities beat typeset's component layer; cell content keeps typeset).
   // break-word, not typeset's `anywhere`: columns keep whole words instead of splitting them.
   table({ node: _, ...props }) {
      const table = (
         <div className="overflow-x-auto rounded-md border">
            <table
               {...props}
               className="m-0 w-full max-w-none border-b-0 [overflow-wrap:break-word]"
            />
         </div>
      );
      return (
         <Expandable
            label="table"
            className="chat-wide mt-(--typeset-flow)"
            data-artifact="table"
            expanded={
               <div className="typeset typeset-chat min-h-0 overflow-auto p-8 pt-12">{table}</div>
            }
         >
            {table}
         </Expandable>
      );
   },
   thead: ({ node: _, ...props }) => <thead {...props} className="bg-muted/50" />,
   th: ({ node: _, ...props }) => <th {...props} className="px-3 py-2 font-medium" />,
   td: ({ node: _, ...props }) => <td {...props} className="px-3 py-2" />,
   // PR refs marked by `rehypePrRefs`.
   span({ node, ...props }) {
      const p = (node as Hast | undefined)?.properties;
      if (typeof p?.dataPrRef === "string")
         return <PrChip refKey={p.dataPrRef} raw={String(p.dataRaw ?? "")} />;
      return <span {...props} />;
   },
};

import { cn } from "@harness/ui";

type Plugins = NonNullable<import("react-markdown").Options["rehypePlugins"]>;
const block: Plugins[number] = [rehypeHighlight, { detect: false, plainText: ["mermaid", "ansi"] }];
/** Code blocks with a language, and inline code (see `inlineCode.ts`; guessing per Settings), get highlight.js tokens,
 * colored by the shared code theme (`@harness/ui`). */
const inline = {
   guess: [rehypeInlineCode, { guess: true }],
   marked: [rehypeInlineCode, { guess: false }],
} satisfies Record<string, Plugins[number]>;

/** `breaks`: single newlines become line breaks (user prompts are typed that way). */
export function Markdown({
   children,
   className,
   breaks,
}: {
   children: string;
   className?: string;
   breaks?: boolean;
}) {
   const guess = useGuessInlineCode();
   // PR refs become chips (inside a Session's `PrRefProvider`) before inline code turns into spans.
   const prCtx = usePrRefs()?.ctx;
   const plugins = useMemo<Plugins>(
      () => [
         block,
         ...(prCtx ? [[rehypePrRefs, { ctx: prCtx }] as Plugins[number]] : []),
         inline[guess ? "guess" : "marked"],
      ],
      [guess, prCtx],
   );
   return (
      <div className={cn("typeset typeset-chat", className)}>
         <ReactMarkdown
            remarkPlugins={breaks ? [remarkGfm, remarkBreaks] : [remarkGfm]}
            rehypePlugins={plugins}
            components={components}
         >
            {children}
         </ReactMarkdown>
      </div>
   );
}

const INLINE = ["p", "strong", "em", "del", "code", "a"];
const inlineComponents: import("react-markdown").Components = {
   p: ({ children }) => <>{children}</>,
   a: ({ children }) => <span className="underline">{children}</span>,
   code: ({ children }) => <code className="font-mono">{children}</code>,
};

/** One line of inline Markdown (code, bold, italic; links as text); other blocks become their text. */
export function InlineMarkdown({ children }: { children: string }) {
   return (
      <ReactMarkdown
         remarkPlugins={[remarkGfm]}
         allowedElements={INLINE}
         unwrapDisallowed
         components={inlineComponents}
      >
         {children.replace(/\s*\n\s*/g, " ")}
      </ReactMarkdown>
   );
}
