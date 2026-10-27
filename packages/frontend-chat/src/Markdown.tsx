import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@harness/ui";

export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cn("prose-harness", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
}
