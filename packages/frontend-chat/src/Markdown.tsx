import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { lazy, Suspense } from "react";
import { AnsiText } from "./AnsiText";
import { Expandable } from "./Expandable";
import { rehypeInlineCode } from "./inlineCode";

/** mermaid is large: loaded with the first diagram. */
const Mermaid = lazy(() => import("./Mermaid").then((m) => ({ default: m.Mermaid })));

type Hast = { type: string; value?: string; tagName?: string; properties?: { className?: unknown }; children?: Hast[] };
const textOf = (n: Hast): string => n.value ?? (n.children ?? []).map(textOf).join("");

/** ```mermaid fences become diagrams and ```ansi fences terminal output; other code stays as is. */
const components: import("react-markdown").Components = {
  pre({ node, children, ...props }) {
    const code = (node as Hast | undefined)?.children?.[0];
    const cls = Array.isArray(code?.properties?.className) ? (code.properties.className as string[]) : [];
    if (code && cls.includes("language-mermaid")) {
      return (
        <Suspense fallback={<div className="h-24 animate-pulse rounded-md bg-muted" />}>
          <Mermaid source={textOf(code).replace(/\n$/, "")} />
        </Suspense>
      );
    }
    if (code && cls.includes("language-ansi")) {
      return <pre {...props}><code><AnsiText text={textOf(code).replace(/\n$/, "")} /></code></pre>;
    }
    return <pre {...props}>{children}</pre>;
  },
  // Tables look like render_ui's Table (utilities beat typeset's component layer; cell content keeps typeset).
  // break-word, not typeset's `anywhere`: columns keep whole words instead of splitting them.
  table({ node: _, ...props }) {
    const table = (
      <div className="overflow-x-auto rounded-md border">
        <table {...props} className="m-0 w-full max-w-none border-b-0 [overflow-wrap:break-word]" />
      </div>
    );
    return (
      <Expandable label="table" className="mt-(--typeset-flow)" expanded={<div className="typeset typeset-chat min-h-0 overflow-auto p-8 pt-12">{table}</div>}>
        {table}
      </Expandable>
    );
  },
  thead: ({ node: _, ...props }) => <thead {...props} className="bg-muted/50" />,
  th: ({ node: _, ...props }) => <th {...props} className="px-3 py-2 font-medium" />,
  td: ({ node: _, ...props }) => <td {...props} className="px-3 py-2" />,
};
import { cn } from "@harness/ui";

/** Code blocks with a language, and inline code (see `inlineCode.ts`), get highlight.js tokens, colored by the shared
 * code theme (`@harness/ui`). */
const highlight: import("react-markdown").Options["rehypePlugins"] = [[rehypeHighlight, { detect: false, plainText: ["mermaid", "ansi"] }], rehypeInlineCode];

/** `breaks`: single newlines become line breaks (user prompts are typed that way). */
export function Markdown({ children, className, breaks }: { children: string; className?: string; breaks?: boolean }) {
  return (
    <div className={cn("typeset typeset-chat", className)}>
      <ReactMarkdown remarkPlugins={breaks ? [remarkGfm, remarkBreaks] : [remarkGfm]} rehypePlugins={highlight} components={components}>{children}</ReactMarkdown>
    </div>
  );
}
