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

/**
 * `/btw <question>` is ours: the Main prompt box starts a Side Thread with it (ADR 0018). It always wins over an
 * Agent command of the same name (Claude Code has its own `/btw`), so the Agent's is dropped from the list.
 */
export const BTW = "btw";
export const withSideThreadCommand = (commands: SlashCommand[]): SlashCommand[] => [
  { name: BTW, description: "Ask in a side thread; the Main Thread never sees it", hint: "<question>" },
  ...commands.filter((c) => c.name !== BTW),
];

/** The question of a `/btw ` message (exact prefix, then text), else null. */
export function btwQuestion(markdown: string): string | null {
  const m = /^\/btw (.+)$/s.exec(markdown.trim());
  return m?.[1]?.trim() || null;
}
