import { useRef } from "react";
import { Bot, Code, LayoutGrid, Palette, Plug, Shield } from "lucide-react";
import { RenderUiGallery } from "@harness/frontend-chat";
import type { HarnessClient } from "@harness/api";
import { Dialog, DialogContent, DialogDescription, DialogTitle, cn } from "@harness/ui";
import { AgentsPanel } from "./AgentsPanel";
import { AppearancePanel } from "./AppearancePanel";
import { EditorPanel } from "./EditorPanel";
import { McpPanel } from "./McpPanel";
import { PermissionsPanel } from "./PermissionsPanel";

export type SettingsSection = "appearance" | "editor" | "permissions" | "agents" | "mcp" | "components";

const NAV: { id: SettingsSection; label: string; icon: typeof Shield }[] = [
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "editor", label: "Editor", icon: Code },
  { id: "permissions", label: "Permissions", icon: Shield },
  { id: "agents", label: "Agents", icon: Bot },
  { id: "mcp", label: "MCP servers", icon: Plug },
  { id: "components", label: "UI components", icon: LayoutGrid },
];

/** Appearance, Permission rules, Agents and MCP servers in one modal with a sidebar. */
export function SettingsDialog({
  client, open, onOpenChange, section, onSectionChange, sessionId, agentsVersion, onAgentsChanged, onMcpChanged,
}: {
  client: HarnessClient;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  section: SettingsSection;
  onSectionChange: (s: SettingsSection) => void;
  /** Currently selected Session, if any (enables the "this session" rule scope). */
  sessionId: string | null;
  agentsVersion: number;
  onAgentsChanged: () => void;
  onMcpChanged: () => void;
}) {
  const nav = useRef<HTMLElement>(null);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[640px] max-h-[85vh] max-w-5xl flex-col gap-0 overflow-hidden p-0"
        // Land on the active nav item.
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          nav.current?.querySelector<HTMLElement>('[aria-current="page"]')?.focus();
        }}
        // Popups inside (theme picker) handle Escape themselves.
        onEscapeKeyDown={(e) => (e.target as Element | null)?.closest?.("[data-keep-escape]") && e.preventDefault()}
      >
        <div className="flex shrink-0 items-center gap-4 border-b bg-muted/30 py-3 pl-4 pr-12">
          <DialogTitle className="w-44 shrink-0 text-base">Settings</DialogTitle>
          <DialogDescription className="sr-only">Appearance, Editor, Permission rules, Agents, MCP servers and UI components.</DialogDescription>
        </div>
        <div className="flex min-h-0 flex-1">
          <nav ref={nav} className="flex w-52 shrink-0 flex-col border-r bg-muted/30 p-2">
            <div className="grid gap-0.5">
              {NAV.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  aria-current={section === id ? "page" : undefined}
                  onClick={() => onSectionChange(id)}
                  className={cn("flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm", section === id ? "bg-accent font-medium" : "text-muted-foreground hover:bg-accent/50")}
                >
                  <Icon className="size-4" /> {label}
                </button>
              ))}
            </div>
            <div className="flex-1" />
            <p className="px-2.5 py-1 text-xs text-muted-foreground">Changes save right away.</p>
          </nav>
          <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-6">
            {section === "appearance" && <AppearancePanel client={client} />}
            {section === "editor" && <EditorPanel client={client} />}
            {section === "permissions" && <PermissionsPanel client={client} sessionId={sessionId} agentsVersion={agentsVersion} />}
            {section === "agents" && <AgentsPanel client={client} version={agentsVersion} onChanged={onAgentsChanged} />}
            {section === "mcp" && <McpPanel client={client} onChanged={onMcpChanged} />}
            {section === "components" && <RenderUiGallery />}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
