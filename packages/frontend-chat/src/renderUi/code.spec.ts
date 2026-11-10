import { s } from "jsonv-ts";
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
