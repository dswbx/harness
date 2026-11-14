import type { Editor, HarnessClient, SessionSummary } from "@harness/api";
import { inTauri } from "@harness/api";
import {
   Button,
   cn,
   DropdownMenu,
   DropdownMenuContent,
   DropdownMenuItem,
   DropdownMenuSeparator,
   DropdownMenuShortcut,
   DropdownMenuTrigger,
   Tooltip,
} from "@harness/ui";
import {
   AppWindow,
   Code,
   Copy,
   FolderOpen,
   Info,
   MoreHorizontal,
   Settings,
   Split,
   Zap,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { useReportError } from "../platform/toast";
import { SessionDetails } from "../sessions/SessionDetails";
import { editorName } from "../settings/editorName";
import { type GitRef, GitRefButton } from "./GitRefButton";

/** Room for the macOS traffic lights (overlay title bar, `trafficLightPosition` in tauri.conf.json: y centers them in the 52px header). */
export const trafficLights = inTauri();

const iconBtn =
   "size-7 text-muted-foreground hover:text-accent-foreground data-[state=open]:bg-accent data-[state=open]:text-accent-foreground";

/**
 * The one header above a Session's View: title, info popover, actions menu, and a slot the Frontend
 * fills with its own actions (`toolbarRef`), and one after the title for its state badges (`statusRef`). At the
 * far right a gear menu: Settings, and entries the Frontend adds to `menuRef` (it exists while the menu is open).
 * `leading` sits left of the title (traffic lights, sidebar toggle). A Sub Session's title is a
 * breadcrumb after its `parent`, which `onOpenParent` opens.
 */
export function SessionHeader({
   client,
   session,
   git,
   leading,
   onOpenWindow,
   onChooseEditor,
   toolbarRef,
   statusRef,
   indicatorRef,
   menuRef,
   onOpenSettings,
   parent,
   onOpenParent,
}: {
   client: HarnessClient;
   session: SessionSummary;
   /** The parent Session of a Sub Session, when it is still listed. */
   parent?: SessionSummary;
   onOpenParent?: () => void;
   /** Branch, counts and PR; none outside a repository. */
   git?: GitRef;
   leading?: ReactNode;
   onOpenWindow?: () => void;
   /** Opens Settings at the editor choice (no editor chosen yet). */
   onChooseEditor?: () => void;
   toolbarRef: (el: HTMLDivElement | null) => void;
   statusRef?: (el: HTMLDivElement | null) => void;
   indicatorRef?: (el: HTMLSpanElement | null) => void;
   menuRef?: (el: HTMLDivElement | null) => void;
   /** Opens Settings; without it the gear menu has no Settings entry. */
   onOpenSettings?: () => void;
}) {
   const report = useReportError();
   const reveal = () =>
      import("@tauri-apps/plugin-opener")
         .then(({ revealItemInDir }) => revealItemInDir(session.folder))
         .catch((e) => report("Could not reveal folder", e));
   const copy = () =>
      navigator.clipboard.writeText(session.folder).catch((e) => report("Could not copy path", e));
   // Read when the menu opens, so a change in Settings shows at once.
   const [editor, setEditor] = useState<Editor | null | undefined>(undefined);
   const loadEditor = (open: boolean) =>
      open && void client.getEditor().then(setEditor, () => setEditor(null));
   // The Frontend's entries are portaled in from another React tree, so the menu cannot see their clicks: close on a native one.
   const [gearOpen, setGearOpen] = useState(false);
   const [gearItems, setGearItems] = useState<HTMLDivElement | null>(null);
   const gearItemsRef = useCallback(
      (el: HTMLDivElement | null) => {
         setGearItems(el);
         menuRef?.(el);
      },
      [menuRef],
   );
   useEffect(() => {
      if (!gearItems) return;
      const onClick = (e: MouseEvent) =>
         (e.target as Element).closest("[data-menu-close]") && setGearOpen(false);
      gearItems.addEventListener("click", onClick);
      return () => gearItems.removeEventListener("click", onClick);
   }, [gearItems]);
   const openInEditor = () =>
      editor
         ? client.openInEditor(session.id).catch((e) => report("Could not open the editor", e))
         : onChooseEditor?.();
   return (
      <header
         data-tauri-drag-region
         className="flex h-13 shrink-0 items-center gap-1 border-b pl-4 pr-1.5"
      >
         {leading}
         {/* Not a drag region, so the title can be selected and copied. */}
         <h1 className="mr-1 flex min-w-0 items-center gap-1.5 text-sm font-semibold">
            {parent && (
               <>
                  <button
                     onClick={onOpenParent}
                     title={`Open ${parent.title}`}
                     className="min-w-0 max-w-[45%] shrink truncate rounded font-normal text-muted-foreground hover:text-foreground"
                  >
                     {parent.title}
                  </button>
                  <span aria-hidden className="shrink-0 font-normal text-muted-foreground">
                     ›
                  </span>
               </>
            )}
            <span className="min-w-0 cursor-text select-text truncate">{session.title}</span>
         </h1>
         <DropdownMenu>
            <DropdownMenuTrigger asChild>
               <Tooltip content="Session info" side="bottom">
                  <Button
                     size="icon"
                     variant="ghost"
                     className={cn(iconBtn, "relative")}
                     aria-label="Session info"
                  >
                     <Info />
                     <span
                        ref={indicatorRef}
                        className="absolute right-0.5 top-0.5 flex empty:hidden"
                     />
                  </Button>
               </Tooltip>
            </DropdownMenuTrigger>
            <DropdownMenuContent
               align="start"
               className="w-96 p-3 text-sm"
               onCloseAutoFocus={(e) => e.preventDefault()}
            >
               <div ref={statusRef} className="mb-2.5 border-b pb-2.5 empty:hidden" />
               <SessionDetails s={session} parent={parent} />
            </DropdownMenuContent>
         </DropdownMenu>
         <DropdownMenu onOpenChange={loadEditor}>
            <DropdownMenuTrigger asChild>
               <Tooltip content="Session actions" side="bottom">
                  <Button
                     size="icon"
                     variant="ghost"
                     className={iconBtn}
                     aria-label="Session actions"
                  >
                     <MoreHorizontal />
                  </Button>
               </Tooltip>
            </DropdownMenuTrigger>
            <DropdownMenuContent
               align="start"
               className="w-56"
               onCloseAutoFocus={(e) => e.preventDefault()}
            >
               {onOpenWindow && (
                  <>
                     <DropdownMenuItem onSelect={onOpenWindow}>
                        <AppWindow /> Open in new window
                     </DropdownMenuItem>
                     <DropdownMenuSeparator />
                  </>
               )}
               {(editor || onChooseEditor) && (
                  <DropdownMenuItem onSelect={() => void openInEditor()}>
                     <Code /> {editor ? `Open in ${editorName(editor)}` : "Open in editor…"}
                  </DropdownMenuItem>
               )}
               <DropdownMenuItem onSelect={() => void copy()}>
                  <Copy /> Copy path
               </DropdownMenuItem>
               {inTauri() && (
                  <DropdownMenuItem onSelect={() => void reveal()}>
                     <FolderOpen /> Reveal in Finder
                  </DropdownMenuItem>
               )}
            </DropdownMenuContent>
         </DropdownMenu>
         <div data-tauri-drag-region className="h-full min-w-4 flex-1" />
         {git && <GitRefButton client={client} session={session} git={git} />}
         {session.quick && (
            <span className="flex shrink-0 items-center gap-1.5 px-1.5 text-xs text-muted-foreground">
               <Zap className="size-3" />
               Quick Session
            </span>
         )}
         {session.parent && (
            <span className="flex shrink-0 items-center gap-1.5 px-1.5 text-xs text-muted-foreground">
               <Split className="size-3" />
               Sub session
            </span>
         )}
         <div ref={toolbarRef} className="flex items-center gap-1" />
         <DropdownMenu open={gearOpen} onOpenChange={setGearOpen}>
            <DropdownMenuTrigger asChild>
               <Tooltip content="Layout and settings" side="bottom">
                  <Button
                     size="icon"
                     variant="ghost"
                     className={iconBtn}
                     aria-label="Layout and settings"
                  >
                     <Settings />
                  </Button>
               </Tooltip>
            </DropdownMenuTrigger>
            <DropdownMenuContent
               align="end"
               className="w-56"
               onCloseAutoFocus={(e) => e.preventDefault()}
            >
               <div ref={gearItemsRef} className="peer flex flex-col empty:hidden" />
               {onOpenSettings && (
                  <>
                     <DropdownMenuSeparator className="hidden peer-[:not(:empty)]:block" />
                     <DropdownMenuItem onSelect={onOpenSettings}>
                        <Settings /> Settings… <DropdownMenuShortcut>⌘,</DropdownMenuShortcut>
                     </DropdownMenuItem>
                  </>
               )}
            </DropdownMenuContent>
         </DropdownMenu>
      </header>
   );
}
