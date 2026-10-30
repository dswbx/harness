import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { cn } from "@harness/ui";

/** Code blocks with a language get highlight.js tokens, colored by the shared code theme (`@harness/ui`). */
const highlight: import("react-markdown").Options["rehypePlugins"] = [[rehypeHighlight, { detect: false }]];

/** `breaks`: single newlines become line breaks (user prompts are typed that way). */
export function Markdown({ children, className, breaks }: { children: string; className?: string; breaks?: boolean }) {
  return (
    <div className={cn("typeset typeset-chat", className)}>
      <ReactMarkdown remarkPlugins={breaks ? [remarkGfm, remarkBreaks] : [remarkGfm]} rehypePlugins={highlight}>{children}</ReactMarkdown>
    </div>
  );
}
