import { cn } from "@harness/ui";
import { InlineMarkdown as Md } from "../InlineMarkdown";
import { Markdown } from "../Markdown";
import { IconOf, type Renderers, tip, tones } from "./runtime";
import { SourceMarkdown } from "./source";

export * from "./text.spec";

/** Renderers of this group; its specs (schema, description, example) are in `text.spec.ts`. */
const textSize = { xs: "text-ui-xs", sm: "text-ui-sm", md: "text-ui", lg: "text-ui-lg" } as const;

export const renderers = {
   Markdown: ({ node }) => {
      // A file-backed panel (`source`): the reducer turns it into a Markdown node naming the file.
      const source = (node.props as { source?: unknown }).source;
      if (typeof source === "string") return <SourceMarkdown name={source} />;
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
