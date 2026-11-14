const MAX_ERRORS = 5;

/** The deepest object on `pointer` with a string `type`. */
function nodeType(input: unknown, pointer: string): string | undefined {
   let found: string | undefined;
   let cur: unknown = input;
   const tokens = [null, ...pointer.split("/").slice(1)];
   for (const raw of tokens) {
      if (raw !== null) {
         const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
         cur = cur && typeof cur === "object" ? (cur as Record<string, unknown>)[key] : undefined;
      }
      const t = (cur as { type?: unknown } | null | undefined)?.type;
      if (typeof t === "string") found = t;
   }
   return found;
}

/** Validation errors as `path (NodeType): message`: one per path, at most 5, then `(N more)`. */
export function formatErrors(
   errors: readonly { instanceLocation: string; error: string }[],
   input: unknown,
): string[] {
   const seen = new Set<string>();
   const all: string[] = [];
   for (const e of errors) {
      const path = e.instanceLocation.replace(/^#/, "");
      if (seen.has(path)) continue;
      seen.add(path);
      const ty = nodeType(input, path);
      all.push(`${path}${ty ? ` (${ty})` : ""}: ${e.error}`);
   }
   const out = all.slice(0, MAX_ERRORS);
   if (all.length > MAX_ERRORS) out.push(`(${all.length - MAX_ERRORS} more)`);
   return out;
}

/** One `formatErrors` line, short enough for one line in the chat: the allowed values of an enum are cut
 * (the node type list is ~30 names). `/root/type (Diagram): Expected enum: [...]` → `/root/type: "Diagram" is not a known component type`. */
export function shortError(line: string): string {
   const m = /^(\S+?)(?: \((.*)\))?: Expected enum: \[.*\]$/.exec(line);
   if (!m) return line;
   // The bracket names the node's type: the bad value itself only when the path is that `type`.
   const [, path, node] = m;
   if (path!.endsWith("/type") && node) return `${path}: "${node}" is not a known component type`;
   return `${path}${node ? ` (${node})` : ""}: not an allowed value`;
}
