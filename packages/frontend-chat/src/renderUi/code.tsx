import { cn, Tooltip } from "@harness/ui";
import { s } from "jsonv-ts";
import { FileCode } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { AnsiText } from "../AnsiText";
import { DiffViewer } from "../DiffViewer";
import { splitPatch } from "../diff";
import { Markdown } from "../Markdown";
import { Diff as FileDiff } from "../ToolCard";
import type { UiNode } from "../tools";
import { PullRequest } from "../UiPullRequest";
import { type Renderers, useEnv } from "./runtime";
import type { Entry } from "./shared";

/** Code and git: Code, Diff, Log, FileLink, PullRequest. */

export const specs = {
   Code: {
      description: "A code block.",
      children: false,
      props: s.object({ code: s.string(), language: s.string().optional() }),
      example: {
         node: {
            type: "Code",
            props: { language: "rust", code: 'let s = std::fs::read_to_string("data.txt")?;' },
         },
      },
   },
   Diff: {
      description:
         "A code diff, highlighted. Give `patch` (a unified git diff; several files are fine) or `path` with `old` and `new` text. File names open the file in the user's editor.",
      children: false,
      props: s.object({
         patch: s.string().optional(),
         path: s.string().optional(),
         old: s.string().optional(),
         new: s.string().optional(),
      }),
      example: {
         node: {
            type: "Diff",
            props: {
               path: "src/config.ts",
               old: "export const retries = 3;\nexport const timeoutMs = 1000;\n",
               new: "export const retries = 5;\nexport const timeoutMs = 1000;\nexport const backoff = true;\n",
            },
         },
      },
   },
   Log: {
      description:
         "Terminal or log output with its ANSI colors, in a scrolling box that starts at the end. `title` names it, e.g. the command.",
      children: false,
      props: s.object({ text: s.string(), title: s.string().optional() }),
      example: {
         node: {
            type: "Log",
            props: {
               title: "bun test",
               text: "\u001b[1mbun test\u001b[0m v1.3\n\u001b[32m✓\u001b[0m users > creates a user \u001b[2m[3ms]\u001b[0m\n\u001b[31m✗\u001b[0m users > rejects a duplicate email\n  \u001b[31mexpected 409, got 500\u001b[0m\n\n \u001b[32m1 pass\u001b[0m\n \u001b[31m1 fail\u001b[0m",
            },
         },
      },
   },
   FileLink: {
      description:
         "A link that opens a file of the workspace, at a line, in the user's editor. `path` is relative to the workspace (or absolute inside it).",
      children: false,
      props: s.object({
         path: s.string(),
         line: s.number().optional(),
         label: s.string().optional(),
      }),
      example: {
         node: {
            type: "Stack",
            props: { direction: "horizontal", gap: "sm" },
            children: [
               { type: "FileLink", props: { path: "src/api/users.ts", line: 42 } },
               { type: "FileLink", props: { path: "README.md", label: "Setup notes" } },
            ],
         },
      },
   },
   PullRequest: {
      description:
         "A GitHub pull request: state, title, branches, +/- stats, checks, review. variant: summary (default), card or compact.",
      children: false,
      props: s.object({
         repo: s.string({ description: "owner/name" }),
         number: s.number(),
         title: s.string(),
         state: s.string({ enum: ["open", "draft", "merged", "closed"] }),
         url: s.string({ description: "Link to the PR." }).optional(),
         head: s.string({ description: "Branch name." }).optional(),
         base: s.string({ description: "Branch name." }).optional(),
         author: s.string().optional(),
         updated: s.string({ description: 'E.g. "2m ago".' }).optional(),
         additions: s.number().optional(),
         deletions: s.number().optional(),
         files: s.number().optional(),
         commits: s.number().optional(),
         checks: s
            .object({
               passed: s.number(),
               pending: s.number().optional(),
               failed: s.number().optional(),
            })
            .optional(),
         review: s
            .string({ enum: ["approved", "changes_requested", "required", "none"] })
            .optional(),
         labels: s.array(s.string()).optional(),
         note: s.string({ description: 'E.g. "Merged into main 2h ago".' }).optional(),
         variant: s
            .string({ enum: ["summary", "card", "compact"], description: "Default summary." })
            .optional(),
      }),
      example: {
         node: {
            type: "Stack",
            props: { gap: "sm" },
            children: [
               {
                  type: "PullRequest",
                  props: {
                     repo: "acme/shop",
                     number: 482,
                     title: "Fix empty cart total",
                     state: "open",
                     url: "https://github.com/acme/shop/pull/482",
                     head: "fix/cart-total",
                     base: "main",
                     additions: 42,
                     deletions: 7,
                     files: 3,
                     checks: { passed: 8, pending: 1 },
                     review: "required",
                  },
               },
               {
                  type: "PullRequest",
                  props: {
                     repo: "acme/shop",
                     number: 479,
                     title: "Add order export",
                     state: "merged",
                     head: "feat/export",
                     base: "main",
                     additions: 310,
                     deletions: 12,
                     files: 9,
                     checks: { passed: 9 },
                     review: "approved",
                     variant: "card",
                     author: "dswbx",
                     updated: "2h ago",
                     commits: 4,
                     labels: ["feature"],
                     url: "https://github.com/acme/shop/pull/479",
                     note: "Merged into main 2h ago",
                  },
               },
               {
                  type: "PullRequest",
                  props: {
                     repo: "acme/shop",
                     number: 490,
                     title: "WIP: new checkout",
                     state: "draft",
                     additions: 120,
                     deletions: 30,
                     checks: { passed: 5, failed: 1 },
                     variant: "compact",
                  },
               },
            ],
         },
      },
   },
} as const satisfies Record<string, Entry>;

/** A workspace path that opens in the user's editor; plain text where nothing can open it. */
function OpenFile({
   path,
   line,
   label,
   className,
}: {
   path: string;
   line?: number;
   label?: string;
   className?: string;
}) {
   const env = useEnv();
   const [error, setError] = useState<string | null>(null);
   const text = label ?? `${path}${line ? `:${line}` : ""}`;
   if (!env.open) return <span className={cn("font-mono", className)}>{text}</span>;
   return (
      <Tooltip content={error ?? `Open ${path}${line ? ` at line ${line}` : ""} in your editor`}>
         <button
            type="button"
            onClick={() =>
               env.open!(path, line).then(
                  () => setError(null),
                  (e) => setError(e instanceof Error ? e.message : String(e)),
               )
            }
            className={cn(
               "inline-flex min-w-0 items-center gap-1 font-mono underline-offset-2 hover:underline",
               error ? "text-destructive" : "text-sky-600 dark:text-sky-400",
               className,
            )}
         >
            <span className="truncate">{text}</span>
         </button>
      </Tooltip>
   );
}

function DiffBlock({ node }: { node: Extract<UiNode, { type: "Diff" }> }) {
   const p = node.props;
   const files = useMemo(() => (p.patch ? splitPatch(p.patch) : []), [p.patch]);
   if (!p.patch) {
      return p.path && p.new != null ? (
         <div className="grid grid-cols-1 gap-1">
            <OpenFile path={p.path} className="w-fit text-ui-sm" />
            <FileDiff path={p.path} oldText={p.old ?? null} newText={p.new} />
         </div>
      ) : null;
   }
   return (
      <div className="grid grid-cols-1 gap-2">
         {files.map((f) => (
            <div key={f.path} className="overflow-hidden rounded border">
               <div className="flex gap-2 border-b bg-muted px-2 py-1 font-mono text-ui-sm text-muted-foreground">
                  <span className="flex min-w-0 flex-1">
                     <OpenFile path={f.path} />
                  </span>
                  <span className="text-emerald-600 dark:text-emerald-400">+{f.additions}</span>
                  <span className="text-destructive">-{f.deletions}</span>
               </div>
               <DiffViewer file={f} mode="unified" wrap />
            </div>
         ))}
         {files.length === 0 && <Markdown>{"```diff\n" + p.patch + "\n```"}</Markdown>}
      </div>
   );
}

function LogBox({ node }: { node: Extract<UiNode, { type: "Log" }> }) {
   const [el, setEl] = useState<HTMLPreElement | null>(null);
   const text = String(node.props.text ?? "");
   // Starts at the end, like a terminal.
   useEffect(() => {
      if (el) el.scrollTop = el.scrollHeight;
   }, [el, text]);
   return (
      <div className="overflow-hidden rounded-md border">
         {node.props.title && (
            <div className="border-b bg-muted px-2 py-1 font-mono text-ui-sm text-muted-foreground">
               {node.props.title}
            </div>
         )}
         <pre
            ref={setEl}
            className="max-h-72 overflow-auto bg-muted/40 p-2 font-mono text-ui-sm leading-relaxed whitespace-pre-wrap break-words"
         >
            <AnsiText text={text} />
         </pre>
      </div>
   );
}

export const renderers = {
   Code: ({ node }) => {
      return (
         <Markdown>
            {"```" + (node.props.language ?? "") + "\n" + String(node.props.code ?? "") + "\n```"}
         </Markdown>
      );
   },
   Diff: ({ node }) => {
      return <DiffBlock node={node} />;
   },
   Log: ({ node }) => {
      return <LogBox node={node} />;
   },
   FileLink: ({ node }) => {
      return (
         <span className="inline-flex w-fit max-w-full items-center gap-1.5 text-ui">
            <FileCode className="size-4 shrink-0 text-muted-foreground" />
            <OpenFile path={node.props.path} line={node.props.line} label={node.props.label} />
         </span>
      );
   },
   PullRequest: ({ node }) => {
      return <PullRequest node={node} />;
   },
} satisfies Renderers;
