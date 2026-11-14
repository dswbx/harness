import type { InitialConfigType } from "@lexical/react/LexicalComposer";
import { PROMPT_NODES } from "../promptMarkdown";

const theme: InitialConfigType["theme"] = {
   paragraph: "m-0",
   text: {
      bold: "font-semibold",
      italic: "italic",
      strikethrough: "line-through",
      code: "rounded bg-muted px-1 font-mono text-[0.9em]",
   },
   code: "code-colors my-1 block [tab-size:4] overflow-x-auto whitespace-pre rounded-md border bg-background/60 p-2 font-mono text-xs data-[language]:before:mb-1 data-[language]:before:block data-[language]:before:select-none data-[language]:before:text-[0.65rem] data-[language]:before:text-muted-foreground data-[language]:before:content-[attr(data-language)]",
   // Preflight sets `list-style: none` on ul/ol; markers come from these. Nested lists sit in a wrapper li (`nested.listitem`)
   // whose own marker is hidden; the inner list shows its depth's marker.
   list: {
      ul: "pl-5",
      ol: "list-decimal pl-5",
      ulDepth: ["list-disc", "list-[circle]", "list-[square]"],
      listitem: "my-0.5",
      nested: { listitem: "list-none" },
   },
   // A code token's highlight type is already its highlight.js classes (see promptCodeHighlight.ts).
   codeHighlight: new Proxy<Record<string, string>>({}, { get: (_, type) => type }),
   link: "text-primary underline underline-offset-2",
   quote: "my-1 border-l-2 pl-3 text-muted-foreground",
};

export const config: InitialConfigType = {
   namespace: "prompt",
   theme,
   nodes: PROMPT_NODES,
   onError: (e) => {
      throw e;
   },
};
