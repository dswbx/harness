export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : typeof err === "string" ? err : JSON.stringify(err);
}

/**
 * Splits an error text into a headline and optional details at the first blank line
 * (the core appends "Agent output (stderr): ..." after one). Newlines are kept as is.
 */
export function splitDetails(text: string): { head: string; details: string | null } {
  const m = /\r?\n[ \t]*\r?\n/.exec(text);
  if (!m) return { head: text.trimEnd(), details: null };
  const details = text.slice(m.index + m[0].length).trim();
  return { head: text.slice(0, m.index).trimEnd(), details: details || null };
}
