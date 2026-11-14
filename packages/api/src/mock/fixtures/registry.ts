import type { RegistryAgent } from "../../generated";

export const MOCK_REGISTRY: Omit<RegistryAgent, "installed_version">[] = [
   {
      id: "claude-acp",
      name: "Claude",
      version: "1.2.0",
      description: "Anthropic's Claude Code agent",
      icon: null,
      website: "https://claude.com",
      install_method: "npx",
   },
   {
      id: "codex-acp",
      name: "Codex",
      version: "0.9.1",
      description: "OpenAI's Codex CLI agent",
      icon: null,
      website: "https://openai.com/codex",
      install_method: "binary",
   },
   {
      id: "opencode",
      name: "OpenCode",
      version: "0.5.0",
      description: "Open source coding agent",
      icon: null,
      website: "https://opencode.ai",
      install_method: "npx",
   },
   {
      id: "windows-only",
      name: "Windows Only Agent",
      version: "1.0.0",
      description: "No build for this Mac",
      icon: null,
      website: null,
      install_method: null,
   },
];
