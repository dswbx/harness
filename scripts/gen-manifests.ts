// Writes each Frontend's manifest.json from its TS tool definitions (jsonv-ts schemas -> JSON Schema)
// and its instructions.md (sent to the Agent in <harness_context>).
// `--check` fails when a committed manifest.json is out of date.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const check = process.argv.includes("--check");
let stale = 0;

for (const pkg of readdirSync("packages").filter((d) => d.startsWith("frontend-"))) {
  const dir = resolve("packages", pkg);
  const manifestPath = join(dir, "manifest.json");
  if (!existsSync(manifestPath)) continue;
  const toolsPath = join(dir, "src/tools.ts");
  const tools: { name: string; description: string; schema: unknown }[] = existsSync(toolsPath)
    ? (await import(toolsPath)).frontendTools
    : [];
  const instructionsPath = join(dir, "instructions.md");
  const instructions = existsSync(instructionsPath) ? readFileSync(instructionsPath, "utf8").trim() : undefined;
  const current = JSON.parse(readFileSync(manifestPath, "utf8"));
  const next = {
    ...current,
    instructions,
    frontend_tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: JSON.parse(JSON.stringify(t.schema)),
    })),
  };
  const text = JSON.stringify(next, null, 2) + "\n";
  if (check) {
    if (readFileSync(manifestPath, "utf8") !== text) {
      console.error(`${manifestPath} is out of date: run bun run gen-manifests`);
      stale++;
    }
  } else {
    writeFileSync(manifestPath, text);
  }
}
if (stale) process.exit(1);
console.log(check ? "manifests up to date" : "manifests written");
