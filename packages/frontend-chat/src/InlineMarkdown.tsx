import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const INLINE = ["p", "code", "strong", "em", "del", "a", "br"];

const components: Components = {
  p: ({ children }) => <>{children}</>,
  code: ({ children }) => <code className="rounded bg-muted px-[0.3em] py-[0.1em] font-mono text-[0.85em]">{children}</code>,
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer" className="text-sky-600 underline underline-offset-2 dark:text-sky-400">
      {children}
    </a>
  ),
};

/**
 * One line of inline Markdown (`code`, **bold**, *italic*, ~~strike~~, links) for short text such
 * as table cells: block syntax renders as its text, so a cell keeps its shape.
 */
export function InlineMarkdown({ children }: { children: unknown }) {
  const text = children == null ? "" : String(children);
  // Skip the parser for plain text (most cells).
  if (!/[`*_~[]/.test(text)) return <>{text}</>;
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} allowedElements={INLINE} unwrapDisallowed components={components}>
      {text}
    </ReactMarkdown>
  );
}
