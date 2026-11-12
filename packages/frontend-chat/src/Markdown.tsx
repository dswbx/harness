import { type ComponentProps, createContext, lazy, Suspense, useContext, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { AnsiText } from "./AnsiText";
import { markdownTitle } from "./artifacts";
import { CodeBlock } from "./CodeBlock";
import { Expandable } from "./Expandable";
import { fileName, markdownTableRows, tableFormats } from "./exportFormats";
import { FileRefLink, useFileRefs } from "./FileRef";
import { rehypeFileRefs } from "./fileRefs";
import { rehypeInlineCode, useGuessInlineCode } from "./inlineCode";
import { PrChip, usePrRefs } from "./prRefs";
import { rehypePrRefs } from "./rehypePrRefs";

/** mermaid is large: loaded with the first diagram. */
const Mermaid = lazy(() => import("./Mermaid").then((m) => ({ default: m.Mermaid })));

type Hast = {
   type: string;
   value?: string;
   tagName?: string;
   properties?: {
      className?: unknown;
      dataPrRef?: unknown;
      dataRaw?: unknown;
      dataFileRef?: unknown;
   };
   children?: Hast[];
};
const textOf = (n: Hast): string => n.value ?? (n.children ?? []).map(textOf).join("");

/** ```mermaid fences become diagrams and ```ansi fences terminal output; other code gets a frame (`CodeBlock`). */
type Components = import("react-markdown").Components;
type PreProps = import("react-markdown").ExtraProps & ComponentProps<"pre">;

function Pre({ node, children, ...props }: PreProps) {
   const code = (node as Hast | undefined)?.children?.[0];
   const cls = Array.isArray(code?.properties?.className)
      ? (code.properties.className as string[])
      : [];
   if (code && cls.includes("language-mermaid")) {
      return (
         <div className="chat-wide" data-artifact="diagram">
            <Suspense fallback={<div className="h-24 animate-pulse rounded-md bg-muted" />}>
               <MermaidInMarkdown source={textOf(code).replace(/\n$/, "")} />
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
   const lang = cls.find((c) => c.startsWith("language-"))?.slice(9) ?? null;
   return (
      <CodeBlock lang={lang} text={code ? textOf(code).replace(/\n$/, "") : ""}>
         {children}
      </CodeBlock>
   );
}

/** The Markdown being rendered: a table's downloads use its source. `title`: names what it shows, when given. */
const MarkdownText = createContext<{ text: string; title?: string }>({ text: "" });

/** The artifact title of a diagram or table here, which names its downloads. */
function useArtifactTitle(kind: "diagram" | "table", source: string) {
   const { text, title } = useContext(MarkdownText);
   return useMemo(() => title ?? markdownTitle(text, kind, source), [title, text, kind, source]);
}

function MermaidInMarkdown({ source }: { source: string }) {
   return <Mermaid source={source} title={useArtifactTitle("diagram", source)} />;
}

// Tables look like render_ui's Table (utilities beat typeset's component layer; cell content keeps typeset).
// break-word, not typeset's `anywhere`: columns keep whole words instead of splitting them.
function MarkdownTable({ node, ...props }: ComponentProps<"table"> & { node?: unknown }) {
   const { text } = useContext(MarkdownText);
   const at = (node as { position?: { start: { offset?: number }; end: { offset?: number } } })
      ?.position;
   const source = at ? text.slice(at.start.offset, at.end.offset) : "";
   const title = useArtifactTitle("table", source);
   const name = fileName(title ?? "table");
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
         title={title}
         className="chat-wide mt-(--typeset-flow)"
         data-artifact="table"
         expanded={
            <div className="typeset typeset-chat min-h-0 overflow-auto p-8 pt-12">{table}</div>
         }
         formats={(png) => [
            png(<div className="typeset typeset-chat">{table}</div>),
            ...tableFormats(name, markdownTableRows(source), source),
         ]}
      >
         {table}
      </Expandable>
   );
}

const components: Components = {
   pre: Pre,
   table: MarkdownTable,
   thead: ({ node: _, ...props }) => <thead {...props} className="bg-muted/50" />,
   th: ({ node: _, ...props }) => <th {...props} className="px-3 py-2 font-medium" />,
   td: ({ node: _, ...props }) => <td {...props} className="px-3 py-2" />,
   // Task list boxes: always controlled, so a box that becomes checked on re-render does not warn.
   input: ({ node: _, checked, ...props }) =>
      props.type === "checkbox" ? (
         <input {...props} checked={!!checked} readOnly />
      ) : (
         <input {...props} />
      ),
   // PR refs marked by `rehypePrRefs`.
   span({ node, ...props }) {
      const p = (node as Hast | undefined)?.properties;
      if (typeof p?.dataPrRef === "string")
         return <PrChip refKey={p.dataPrRef} raw={String(p.dataRaw ?? "")} />;
      return <span {...props} />;
   },
   // File refs marked by `rehypeFileRefs` (a popover of the file's lines inside a Session's `FileRefProvider`).
   code({ node, ...props }) {
      const ref = (node as Hast | undefined)?.properties?.dataFileRef;
      if (typeof ref === "string")
         return (
            <FileRefLink refKey={ref}>
               <code {...props} />
            </FileRefLink>
         );
      return <code {...props} />;
   },
   a({ node, ...props }) {
      const ref = (node as Hast | undefined)?.properties?.dataFileRef;
      if (typeof ref === "string")
         return (
            <FileRefLink refKey={ref} fallback={<a {...props} />}>
               <span className="font-medium">{props.children}</span>
            </FileRefLink>
         );
      // Web links open outside the app (a new tab; in Tauri the opener sends `_blank` to the browser).
      if (/^(https?:|mailto:)/i.test(props.href ?? ""))
         return <a {...props} target="_blank" rel="noreferrer" />;
      return <a {...props} />;
   },
};

/** Code blocks without the frame, for code that is framed already (`CodeFrame`). */
const plainCodeComponents: Components = {
   ...components,
   pre(props: PreProps) {
      const cls = (props.node as Hast | undefined)?.children?.[0]?.properties?.className;
      if (Array.isArray(cls) && cls.some((c) => c === "language-mermaid" || c === "language-ansi"))
         return <Pre {...props} />;
      const { node: _, ...rest } = props;
      return <pre {...rest} className="chat-wide" />;
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

/**
 * Raw HTML for file-backed panels (ADR 0023): parsed, then cut down to the default sanitize schema
 * (GitHub's) plus `<details open>`/`<summary>`. No scripts, styles, frames or event handlers.
 */
const sanitizeSchema = {
   ...defaultSchema,
   tagNames: [...(defaultSchema.tagNames ?? []), "details", "summary"],
   attributes: {
      ...defaultSchema.attributes,
      details: [...(defaultSchema.attributes?.details ?? []), "open"],
   },
};
const rawHtml: Plugins = [rehypeRaw, [rehypeSanitize, sanitizeSchema]];

/** `breaks`: single newlines become line breaks (user prompts are typed that way). `plainCode`: code blocks without
 * their frame (language, wrap, copy). */
export function Markdown({
   children,
   className,
   breaks,
   plainCode,
   title,
   html,
}: {
   children: string;
   /** Allow raw HTML, sanitized (`sanitizeSchema`); otherwise raw HTML is dropped. */
   html?: boolean;
   /** What this shows, if not to be found from the text before it: names downloads. */
   title?: string;
   className?: string;
   breaks?: boolean;
   plainCode?: boolean;
}) {
   const guess = useGuessInlineCode();
   // PR refs become chips (inside a Session's `PrRefProvider`) before inline code turns into spans.
   const prCtx = usePrRefs()?.ctx;
   // File refs are marked (inside a Session's `FileRefProvider`) before inline code is highlighted.
   const fileRefs = !!useFileRefs();
   const plugins = useMemo<Plugins>(
      () => [
         ...(html ? rawHtml : []),
         block,
         ...(prCtx ? [[rehypePrRefs, { ctx: prCtx }] as Plugins[number]] : []),
         ...(fileRefs ? [rehypeFileRefs] : []),
         inline[guess ? "guess" : "marked"],
      ],
      [guess, prCtx, fileRefs, html],
   );
   const context = useMemo(() => ({ text: children, title }), [children, title]);
   return (
      <div className={cn("typeset typeset-chat", className)}>
         <MarkdownText.Provider value={context}>
            <ReactMarkdown
               remarkPlugins={breaks ? [remarkGfm, remarkBreaks] : [remarkGfm]}
               rehypePlugins={plugins}
               components={plainCode ? plainCodeComponents : components}
            >
               {children}
            </ReactMarkdown>
         </MarkdownText.Provider>
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
