import type { HarnessClient } from "@harness/api";
import {
   cn,
   Dialog,
   DialogContent,
   DialogDescription,
   DialogTitle,
   ResizeHandles,
   ScrollArea,
   useMovableResizable,
} from "@harness/ui";
import { Bot, Code, GitBranch, Info, LayoutGrid, Palette, Plug, Shield, Zap } from "lucide-react";
import { useRef } from "react";
import { AppearancePanel } from "../appearance/AppearancePanel";
import { gallery } from "../platform/frontends";
import { AboutPanel } from "./AboutPanel";
import { AgentsPanel } from "./AgentsPanel";
import { EditorPanel } from "./EditorPanel";
import { GitPanel } from "./GitPanel";
import { McpPanel } from "./McpPanel";
import { OverlayPanel } from "./OverlayPanel";
import { PermissionsPanel } from "./PermissionsPanel";
import { frameStore, type SettingsSection } from "./settingsStore";

export type { SettingsSection };

/** Smallest box the dialog resizes to. */
const MIN = { w: 640, h: 420 };
/** Size when nothing is stored. */
const initialSize = (view: { w: number; h: number }) => ({
   w: Math.min(1100, Math.round(view.w * 0.9)),
   h: Math.min(760, Math.round(view.h * 0.85)),
});

const NAV: { id: SettingsSection; label: string; icon: typeof Shield }[] = [
   { id: "appearance", label: "Appearance", icon: Palette },
   { id: "editor", label: "Editor", icon: Code },
   { id: "git", label: "Git", icon: GitBranch },
   { id: "overlay", label: "Quick overlay", icon: Zap },
   { id: "permissions", label: "Permissions", icon: Shield },
   { id: "agents", label: "Agents", icon: Bot },
   { id: "mcp", label: "MCP servers", icon: Plug },
   { id: "components", label: "UI components", icon: LayoutGrid },
   { id: "about", label: "About", icon: Info },
];

/** Appearance, Permission rules, Agents, MCP servers and About in one modal with a sidebar. */
export function SettingsDialog({
   client,
   open,
   onOpenChange,
   section: wanted,
   onSectionChange,
   sessionId,
   busy,
   agentsVersion,
   onAgentsChanged,
   onMcpChanged,
}: {
   client: HarnessClient;
   open: boolean;
   onOpenChange: (o: boolean) => void;
   section: SettingsSection;
   onSectionChange: (s: SettingsSection) => void;
   /** Currently selected Session, if any (enables the "this session" rule scope). */
   sessionId: string | null;
   /** An Agent is working: restarting to update is blocked. */
   busy: boolean;
   agentsVersion: number;
   onAgentsChanged: () => void;
   onMcpChanged: () => void;
}) {
   const nav = useRef<HTMLElement>(null);
   const Gallery = gallery();
   // A remembered "UI components" in a build without the gallery.
   const section = wanted === "components" && !Gallery ? "appearance" : wanted;
   const frame = useMovableResizable({
      store: frameStore,
      initial: initialSize,
      min: MIN,
      active: open,
   });

   return (
      <Dialog open={open} onOpenChange={onOpenChange}>
         <DialogContent
            // Placed by `frame` (moved by the header, resized from the edges), not centered.
            className="flex max-w-none translate-x-0 translate-y-0 flex-col gap-0 p-0"
            style={frame.style}
            // Land on the active nav item.
            onOpenAutoFocus={(e) => {
               e.preventDefault();
               nav.current?.querySelector<HTMLElement>('[aria-current="page"]')?.focus();
            }}
            // Popups inside (theme picker) handle Escape themselves.
            onEscapeKeyDown={(e) =>
               (e.target as Element | null)?.closest?.("[data-keep-escape]") && e.preventDefault()
            }
         >
            <ResizeHandles {...frame.resize} />
            {/* Clips the content to the rounded box; the resize handles stay outside it. */}
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[inherit]">
               <div
                  {...frame.dragProps}
                  className="flex shrink-0 cursor-grab select-none items-center gap-4 border-b bg-muted/30 py-3 pl-4 pr-12"
               >
                  <DialogTitle className="w-44 shrink-0 text-base">Settings</DialogTitle>
                  <DialogDescription className="sr-only">
                     Appearance, Editor, Git, Quick overlay, Permission rules, Agents, MCP servers,
                     UI components and About.
                  </DialogDescription>
               </div>
               <div className="flex min-h-0 flex-1">
                  <nav ref={nav} className="flex w-52 shrink-0 flex-col border-r bg-muted/30 p-2">
                     <div className="grid gap-0.5">
                        {NAV.filter((n) => n.id !== "components" || Gallery).map(
                           ({ id, label, icon: Icon }) => (
                              <button
                                 key={id}
                                 aria-current={section === id ? "page" : undefined}
                                 onClick={() => onSectionChange(id)}
                                 className={cn(
                                    "flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm",
                                    section === id
                                       ? "bg-accent font-medium text-accent-foreground"
                                       : "text-muted-foreground hover:bg-accent/50",
                                 )}
                              >
                                 <Icon className="size-4" /> {label}
                              </button>
                           ),
                        )}
                     </div>
                     <div className="flex-1" />
                     <p className="px-2.5 py-1 text-xs text-muted-foreground">
                        Changes save right away.
                     </p>
                  </nav>
                  <ScrollArea className="min-h-0 min-w-0 flex-1">
                     <div className="p-6">
                        {section === "appearance" && <AppearancePanel client={client} />}
                        {section === "editor" && <EditorPanel client={client} />}
                        {section === "git" && <GitPanel client={client} />}
                        {section === "overlay" && <OverlayPanel />}
                        {section === "permissions" && (
                           <PermissionsPanel
                              client={client}
                              sessionId={sessionId}
                              agentsVersion={agentsVersion}
                           />
                        )}
                        {section === "agents" && (
                           <AgentsPanel
                              client={client}
                              version={agentsVersion}
                              onChanged={onAgentsChanged}
                           />
                        )}
                        {section === "mcp" && <McpPanel client={client} onChanged={onMcpChanged} />}
                        {section === "components" && Gallery && <Gallery />}
                        {section === "about" && <AboutPanel busy={busy} />}
                     </div>
                  </ScrollArea>
               </div>
            </div>
         </DialogContent>
      </Dialog>
   );
}
