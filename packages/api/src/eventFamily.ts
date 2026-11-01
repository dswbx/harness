import type { EventKind } from "./generated";

/** Event kinds by family, for log viewers' filters (ADR 0012, shared helper). Typed, so a new kind must be placed. */
const FAMILY: Record<EventKind["type"], string> = {
  TurnStarted: "Messages", TurnEnded: "Messages", AgentMessageChunk: "Messages", AgentThoughtChunk: "Messages",
  ToolCall: "Tools", ToolCallUpdate: "Tools", TaskListUpdated: "Tools", FrontendToolOutput: "Tools",
  PermissionRequested: "Permissions", PermissionResolved: "Permissions", PermissionRuleAdded: "Permissions",
  AgentSessionStarted: "Agent", AgentProcessState: "Agent", AgentCapabilities: "Agent", AuthRequired: "Agent",
  ModeChanged: "Agent", ConfigOptionsChanged: "Agent", AvailableCommandsChanged: "Agent", UsageUpdated: "Agent",
  AgentNotice: "Agent", AgentUpdate: "Agent",
  SessionCreated: "Session", SessionStatusChanged: "Session", ThreadStarted: "Session", ThreadReadOnly: "Session",
  SessionInfoUpdated: "Session", StateChanged: "Session", SessionArchived: "Session", WorkspaceChanged: "Session",
  GitCommitted: "Session", GitPushed: "Session",
  Error: "Errors",
};

/** The family an Event kind belongs to ("Messages", "Tools", …); "Other" for kinds this build does not know. */
export function eventFamily(type: string): string {
  return (FAMILY as Record<string, string>)[type] ?? "Other";
}
