import type { SlashCommand } from "@harness/api";

export function matchCommands(commands: SlashCommand[], text: string): SlashCommand[] {
  if (!text.startsWith("/") || /\s/.test(text)) return [];
  const q = text.slice(1).toLowerCase();
  const name = (c: SlashCommand) => c.name.toLowerCase();
  // Prefix matches first, then other substring matches; each group keeps the Agent's order.
  const prefix = commands.filter((c) => name(c).startsWith(q));
  const rest = commands.filter((c) => !name(c).startsWith(q) && name(c).includes(q));
  return [...prefix, ...rest].slice(0, 8);
}
