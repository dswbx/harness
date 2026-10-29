import { useEffect, useRef, useState } from "react";
import { Bot, Plug, Search, Shield } from "lucide-react";
import type { HarnessClient } from "@harness/api";
import { Dialog, DialogContent, DialogDescription, DialogTitle, Input, cn } from "@harness/ui";
import { AgentsPanel } from "./AgentsPanel";
import { McpPanel } from "./McpPanel";
import { PermissionsPanel } from "./PermissionsPanel";

export type SettingsSection = "permissions" | "agents" | "mcp";

const NAV: { id: SettingsSection; label: string; icon: typeof Shield }[] = [
  { id: "permissions", label: "Permissions", icon: Shield },
  { id: "agents", label: "Agents", icon: Bot },
  { id: "mcp", label: "MCP servers", icon: Plug },
];

/** Permission rules, Agents and MCP servers in one modal with a sidebar. */
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
  const [query, setQuery] = useState("");
  const search = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) setQuery("");
  }, [open]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      search.current?.focus();
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[640px] max-h-[85vh] max-w-5xl flex-col gap-0 overflow-hidden p-0" onKeyDown={onKeyDown}>
        <div className="flex shrink-0 items-center gap-4 border-b bg-muted/30 py-3 pl-4 pr-12">
          <DialogTitle className="w-44 shrink-0 text-base">Settings</DialogTitle>
          <DialogDescription className="sr-only">Permission rules, Agents and MCP servers.</DialogDescription>
          <div className="relative w-full max-w-[420px]">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input ref={search} className="h-8 pl-8" placeholder="Search rules, Agents, servers" aria-label="Search settings" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
        </div>
        <div className="flex min-h-0 flex-1">
          <nav className="flex w-52 shrink-0 flex-col border-r bg-muted/30 p-2">
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
            {section === "permissions" && <PermissionsPanel client={client} sessionId={sessionId} agentsVersion={agentsVersion} query={query} />}
            {section === "agents" && <AgentsPanel client={client} version={agentsVersion} onChanged={onAgentsChanged} query={query} />}
            {section === "mcp" && <McpPanel client={client} onChanged={onMcpChanged} query={query} />}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
