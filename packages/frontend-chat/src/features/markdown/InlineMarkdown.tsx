import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * `rich`: links open in a new tab, `code` is a chip, for a UI's own text (render_ui, table cells).
 * `quiet`: links read as underlined text (the host sits in a click target), newlines become spaces,
 * for a one-line preview such as a review comment chip.
 */
export type InlineVariant = "rich" | "quiet";

const RICH: Components = {
   p: ({ children }) => <>{children}</>,
   code: ({ children }) => (
      <code className="rounded bg-muted px-[0.3em] py-[0.1em] font-mono text-[0.85em]">
         {children}
      </code>
   ),
   strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
   a: ({ href, children }) => (
      <a
         href={href}
         target="_blank"
         rel="noreferrer"
         className="text-sky-600 underline underline-offset-2 dark:text-sky-400"
      >
         {children}
      </a>
   ),
};

const QUIET: Components = {
   p: ({ children }) => <>{children}</>,
   a: ({ children }) => <span className="underline">{children}</span>,
   code: ({ children }) => <code className="font-mono">{children}</code>,
};

const ELEMENTS: Record<InlineVariant, string[]> = {
   rich: ["p", "code", "strong", "em", "del", "a", "br"],
   quiet: ["p", "strong", "em", "del", "code", "a"],
};

/**
 * One line of inline Markdown (`code`, **bold**, *italic*, ~~strike~~, links): block syntax renders
 * as its text, so a cell or chip keeps its shape.
 */
export function InlineMarkdown({
   children,
   variant = "rich",
}: {
   children: unknown;
   variant?: InlineVariant;
}) {
   const raw = children == null ? "" : String(children);
   const quiet = variant === "quiet";
   // Skip the parser for plain text (most cells).
   if (!quiet && !/[`*_~[]/.test(raw)) return <>{raw}</>;
   return (
      <ReactMarkdown
         remarkPlugins={[remarkGfm]}
         allowedElements={ELEMENTS[variant]}
         unwrapDisallowed
         components={quiet ? QUIET : RICH}
      >
         {quiet ? raw.replace(/\s*\n\s*/g, " ") : raw}
      </ReactMarkdown>
   );
}
