import type { HarnessClient } from "@harness/api";
import { errText, openExternalLink } from "@harness/api";
import {
   Button,
   Dialog,
   DialogContent,
   DialogDescription,
   DialogFooter,
   DialogHeader,
   DialogTitle,
   Input,
   Textarea,
} from "@harness/ui";
import { useState } from "react";
import { getImportedThemes, setImportedThemes } from "./appearance";
import { fromCss, fromRegistryItem, registryUrl, themeId } from "./importTheme";

/** Where themes come from: browse, make your own, then copy the link. */
const TWEAKCN = "https://tweakcn.com/editor/theme";

/** Paste a tweakcn link (fetched by the core) or theme CSS; the theme is stored and selected. */
export function ImportThemeDialog({
   client,
   onImported,
}: {
   client: HarnessClient;
   onImported: (id: string) => void;
}) {
   const [open, setOpen] = useState(false);
   const [text, setText] = useState("");
   const [name, setName] = useState("");
   const [busy, setBusy] = useState(false);
   const [error, setError] = useState<string | null>(null);
   let url: string | null = null;
   try {
      url = registryUrl(text);
   } catch {
      /* shown on import */
   }
   const isCss = !!text.trim() && !/^\s*https?:/i.test(text);

   const submit = async () => {
      setBusy(true);
      setError(null);
      try {
         const u = registryUrl(text);
         const theme = u ? fromRegistryItem(await client.fetchJson(u), u) : fromCss(text, name);
         const all = getImportedThemes();
         const id = themeId(theme.label, (x) => Object.hasOwn(all, x));
         await setImportedThemes({ ...all, [id]: theme });
         onImported(id);
         setOpen(false);
         setText("");
         setName("");
      } catch (e) {
         setError(errText(e));
      } finally {
         setBusy(false);
      }
   };

   return (
      <>
         <Button
            size="sm"
            variant="outline"
            className="h-8 text-xs"
            onClick={() => {
               setError(null);
               setOpen(true);
            }}
         >
            Import…
         </Button>
         <Dialog open={open} onOpenChange={setOpen}>
            <DialogContent className="sm:max-w-lg" data-keep-escape>
               <DialogHeader>
                  <DialogTitle>Import theme</DialogTitle>
                  <DialogDescription>
                     Paste a tweakcn theme link (from Share, or the{" "}
                     <code className="font-mono">shadcn add</code> URL in Code), or the theme's CSS
                     (<code className="font-mono">:root</code> and{" "}
                     <code className="font-mono">.dark</code>).{" "}
                     <a
                        href={TWEAKCN}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(e) => openExternalLink(e, TWEAKCN)}
                        className="underline underline-offset-2 hover:text-foreground"
                     >
                        Find or make themes on tweakcn
                     </a>
                  </DialogDescription>
               </DialogHeader>
               <Textarea
                  autoFocus
                  aria-label="Theme link or CSS"
                  placeholder={
                     "https://tweakcn.com/themes/…\n\nor\n\n:root {\n  --background: oklch(…);\n  …\n}"
                  }
                  value={text}
                  spellCheck={false}
                  onChange={(e) => setText(e.target.value)}
                  className="max-h-72 min-h-32 font-mono text-xs"
               />
               {isCss && (
                  <Input
                     aria-label="Theme name"
                     placeholder="Theme name"
                     value={name}
                     onChange={(e) => setName(e.target.value)}
                     className="h-8 text-xs"
                  />
               )}
               {error && <p className="text-xs text-destructive">{error}</p>}
               <DialogFooter>
                  <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
                     Cancel
                  </Button>
                  <Button
                     size="sm"
                     disabled={busy || !text.trim() || (isCss && !name.trim())}
                     onClick={() => void submit()}
                  >
                     {busy ? "Importing…" : url ? "Fetch and import" : "Import"}
                  </Button>
               </DialogFooter>
            </DialogContent>
         </Dialog>
      </>
   );
}
