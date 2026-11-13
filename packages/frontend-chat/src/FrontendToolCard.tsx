import { ImageOff } from "lucide-react";
import { useState } from "react";
import { uiTitle } from "./artifacts";
import { Expandable } from "./Expandable";
import { fileName, uiFormats } from "./exportFormats";
import { RenderUi, type UiEnv } from "./RenderUi";
import type { Item } from "./reducer";
import { quotableAttrs } from "./SelectionComment";
import { CodeFrame } from "./toolDisplay/CodeFrame";
import { type RawNode, shortError } from "./tools";

type FT = Extract<Item, { type: "frontend_tool" }>;

const raw = (v: unknown) => JSON.stringify(v, null, 2);

/**
 * `view`: what to show for a `render_ui` call with an id (its latest content), if not its own.
 * `threadId`/`side`: the Thread it is in, so a comment on selected text goes to that Thread's prompt box.
 */
export function FrontendToolRow({
   item,
   env,
   view,
   threadId,
   side,
}: {
   item: FT;
   env: UiEnv;
   view?: { root: RawNode; files: Record<string, string> };
   threadId: string;
   side: boolean;
}) {
   if (item.render?.ok) {
      const shown =
         view ??
         (item.render.value.root ? { root: item.render.value.root, files: item.files } : null);
      if (!shown) return null;
      const title = uiTitle(shown.root, item.render.value.title);
      return (
         <Expandable
            label="view"
            title={title}
            className="chat-wide"
            formats={(png) => [png(), ...uiFormats(fileName(title), shown.root)]}
         >
            <div {...quotableAttrs(threadId, side, { source: "artifact", label: title })}>
               <RenderUi
                  root={shown.root}
                  env={{ ...env, files: shown.files, item: item.render.value.id ?? item.callId }}
               />
            </div>
         </Expandable>
      );
   }
   if (item.render && !item.render.ok)
      return <InvalidView item={item} errors={item.render.errors} />;
   return (
      <details className="rounded-lg border bg-card text-sm">
         <summary className="cursor-pointer px-3 py-2 text-xs">
            Frontend tool <span className="font-mono">{item.tool}</span>
         </summary>
         <pre className="max-h-64 overflow-auto border-t bg-muted p-2 text-code">
            {raw(item.input)}
         </pre>
      </details>
   );
}

/** A view whose input the Frontend rejected. The Agent already got the error from the core, so for the user this is
 * only "a view is missing": one quiet line, the error and input behind Details. */
function InvalidView({ item, errors }: { item: FT; errors: readonly string[] }) {
   const [open, setOpen] = useState(false);
   const [input, setInput] = useState(false);
   const name = viewName(item.input);
   return (
      <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-ui-sm text-amber-800 dark:text-amber-200/80">
         <div className="flex items-center gap-2">
            <ImageOff className="size-3.5 shrink-0 text-amber-500" aria-hidden />
            <span className="min-w-0 flex-1">
               {name ? `View “${name}” could not be shown` : "A view could not be shown"}
            </span>
            <button
               type="button"
               aria-expanded={open}
               onClick={() => setOpen(!open)}
               className="shrink-0 underline underline-offset-2 opacity-80 hover:opacity-100"
            >
               {open ? "Hide" : "Details"}
            </button>
         </div>
         {open && (
            <div className="mt-1.5 flex flex-col gap-1 pl-5.5 font-mono text-muted-foreground">
               {errors.map((e) => (
                  <div key={e} className="[overflow-wrap:anywhere]">
                     {shortError(e)}
                  </div>
               ))}
               <button
                  type="button"
                  aria-expanded={input}
                  onClick={() => setInput(!input)}
                  className="self-start hover:text-foreground"
               >
                  Input {input ? "▾" : "›"}
               </button>
               {input && <CodeFrame label="input" code={raw(item.input)} lang="json" />}
            </div>
         )}
      </div>
   );
}

/** A name for the view the call meant to show: its title, else its id. */
function viewName(input: unknown): string | null {
   const i = input as {
      title?: unknown;
      id?: unknown;
      root?: { props?: { title?: unknown } };
   } | null;
   const n = i?.title ?? i?.root?.props?.title ?? i?.id;
   return typeof n === "string" && n ? n : null;
}
