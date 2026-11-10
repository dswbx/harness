import { cn } from "@harness/ui";
import { s } from "jsonv-ts";
import { InlineMarkdown as Md } from "../InlineMarkdown";
import { Markdown } from "../Markdown";
import { IconOf, type Renderers, tip, tones } from "./runtime";
import { type Entry, icon, mono, tone, tooltip } from "./shared";

/** Text: Markdown, Text, Badge, KeyValue. */

export const specs = {
   Markdown: {
      description:
         "Markdown text. A ```mermaid fence draws a diagram; a ```ansi fence shows terminal colors.",
      children: false,
      props: s.object({ text: s.string() }),
      example: {
         node: {
            type: "Markdown",
            props: {
               text: "**Bold**, `code` and a [link](https://example.com).\n\n```mermaid\nflowchart LR\n  Client --> API --> DB[(Postgres)]\n  API --> Cache\n```",
            },
         },
      },
   },
   Text: {
      description:
         "Short plain text: a label, a number, an arrow or a caption between other components. No Markdown (use Markdown for prose).",
      children: false,
      props: s.object({
         text: s.anyOf([s.string(), s.number()]),
         tone: tone.optional(),
         mono: mono.optional(),
         size: s.string({ enum: ["xs", "sm", "md", "lg"], description: "Default md." }).optional(),
         muted: s.boolean().optional(),
         weight: s.string({ enum: ["normal", "medium", "bold"] }).optional(),
         tooltip: tooltip.optional(),
      }),
      example: {
         node: {
            type: "Stack",
            props: { direction: "horizontal", fill: false, align: "center", gap: "sm" },
            children: [
               {
                  type: "Card",
                  props: { title: "Zürich HB", description: "dep 07:33", variant: "compact" },
               },
               {
                  type: "Stack",
                  props: { align: "center", gap: "sm" },
                  children: [
                     { type: "Text", props: { text: "3h 17m", size: "xs", muted: true } },
                     { type: "Text", props: { text: "→", size: "lg", muted: true } },
                  ],
               },
               {
                  type: "Card",
                  props: {
                     title: "Milano Centrale",
                     description: "arr 10:50 · dep 11:15",
                     variant: "compact",
                  },
               },
               {
                  type: "Stack",
                  props: { align: "center", gap: "sm" },
                  children: [
                     {
                        type: "Text",
                        props: {
                           text: "2h 55m",
                           size: "xs",
                           muted: true,
                           tooltip: "Frecciarossa 9531, coach 6",
                        },
                     },
                     { type: "Text", props: { text: "→", size: "lg", muted: true } },
                  ],
               },
               {
                  type: "Card",
                  props: {
                     title: "Roma Termini",
                     description: "arr 14:10",
                     variant: "compact",
                     tone: "success",
                  },
               },
            ],
         },
      },
   },
   KeyValue: {
      description: "Label/value rows; a value can take a `tone`, `mono` and a `tooltip`.",
      children: false,
      props: s.object({
         items: s.array(
            s.object({
               label: s.string(),
               value: s.string(),
               tone: tone.optional(),
               mono: mono.optional(),
               tooltip: tooltip.optional(),
            }),
         ),
      }),
      example: {
         node: {
            type: "KeyValue",
            props: {
               items: [
                  { label: "Environment", value: "production", tone: "success" },
                  {
                     label: "Release",
                     value: "v4.2.0",
                     mono: true,
                     tooltip: "Tagged Oct 30 by @ana",
                  },
                  { label: "Error rate", value: "2.4%", tone: "warning" },
                  { label: "Duration", value: "3m 41s" },
               ],
            },
         },
      },
   },
   Badge: {
      description: "A short label, e.g. a status.",
      children: false,
      props: s.object({
         text: s.string(),
         tone: tone.optional(),
         icon: icon.optional(),
         tooltip: tooltip.optional(),
      }),
      example: {
         node: {
            type: "Stack",
            props: { direction: "horizontal", gap: "sm" },
            children: [
               {
                  type: "Badge",
                  props: {
                     text: "passing",
                     tone: "success",
                     icon: "check",
                     tooltip: "48 of 48 tests",
                  },
               },
               { type: "Badge", props: { text: "1 flaky", tone: "warning" } },
               { type: "Badge", props: { text: "draft" } },
            ],
         },
      },
   },
} as const satisfies Record<string, Entry>;

const textSize = { xs: "text-ui-xs", sm: "text-ui-sm", md: "text-ui", lg: "text-ui-lg" } as const;

export const renderers = {
   Markdown: ({ node }) => {
      return <Markdown>{String(node.props.text ?? "")}</Markdown>;
   },
   Text: ({ node }) => {
      const p = node.props;
      const t = tones[p.tone ?? "neutral"];
      return tip(
         p.tooltip,
         <span
            className={cn(
               "min-w-0 break-words",
               p.tooltip && "underline decoration-dotted underline-offset-2",
               textSize[p.size ?? "md"],
               p.mono && "font-mono",
               p.weight === "medium" ? "font-medium" : p.weight === "bold" && "font-semibold",
               p.muted && "text-muted-foreground",
               p.tone && p.tone !== "neutral" && t.fg,
            )}
         >
            {String(p.text ?? "")}
         </span>,
         true,
      );
   },
   KeyValue: ({ node }) => {
      return (
         <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
            {(node.props.items ?? []).map((it, i) => (
               <div key={i} className="contents">
                  <dt className="text-muted-foreground">
                     <Md>{it.label}</Md>
                  </dt>
                  <dd
                     className={cn(
                        "min-w-0 break-words",
                        it.mono && "font-mono",
                        it.tone && it.tone !== "neutral" && tones[it.tone].fg,
                     )}
                  >
                     {it.tooltip ? (
                        tip(
                           it.tooltip,
                           <span className="underline decoration-dotted underline-offset-2">
                              <Md>{it.value}</Md>
                           </span>,
                           true,
                        )
                     ) : (
                        <Md>{it.value}</Md>
                     )}
                  </dd>
               </div>
            ))}
         </dl>
      );
   },
   Badge: ({ node }) => {
      const t = tones[node.props.tone ?? "neutral"];
      return tip(
         node.props.tooltip,
         <span
            className={cn(
               "inline-flex w-fit items-center gap-1 rounded-full border px-2 py-0.5 text-ui-sm font-medium",
               t.box,
               t.fg,
            )}
         >
            {node.props.icon && <IconOf name={node.props.icon} className="size-3" />}
            {String(node.props.text ?? "")}
         </span>,
         true,
      );
   },
} satisfies Renderers;
