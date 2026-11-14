import type { AgentInfo } from "@harness/api";

/** One line on an installed Agent's last conformance check. */
export function checkLine(a: AgentInfo): { text: string; ok: boolean } | null {
   const c = a.install?.check;
   if (!c) return null;
   if (c.passed) {
      return {
         ok: true,
         text: c.auth_required
            ? `v${c.version} check passed (sign-in needed)`
            : `v${c.version} check passed`,
      };
   }
   const first = (c.error ?? "").split("\n")[0];
   return { ok: false, text: `Update to v${c.version} was refused, check failed: ${first}` };
}

/** `KEY=VALUE` lines of the custom Agent form's environment field: blank lines skipped, the key trimmed, the value kept as typed. Throws for a line without a key. */
export function parseEnvLines(text: string): Record<string, string> {
   const env: Record<string, string> = {};
   for (const line of text.split("\n")) {
      const l = line.trim();
      if (!l) continue;
      const i = l.indexOf("=");
      if (i < 1) throw new Error(`Invalid env line "${l}", expected KEY=VALUE`);
      env[l.slice(0, i).trim()] = l.slice(i + 1);
   }
   return env;
}
