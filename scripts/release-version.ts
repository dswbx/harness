// Next CalVer release version from git tags: v{year}.{month}.{n}, n counting up within the month
// (Europe/Zurich). Prints the version, and writes `version`/`tag` to $GITHUB_OUTPUT in CI.
import { appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Zurich", year: "numeric", month: "numeric" }).formatToParts(new Date());
const year = Number(parts.find((p) => p.type === "year")!.value);
const month = Number(parts.find((p) => p.type === "month")!.value);

const prefix = `v${year}.${month}.`;
const taken = execFileSync("git", ["tag", "--list", `${prefix}*`], { encoding: "utf8" })
  .split("\n")
  .map((t) => t.slice(prefix.length))
  .filter((n) => /^\d+$/.test(n))
  .map(Number);
const version = `${year}.${month}.${taken.length ? Math.max(...taken) + 1 : 0}`;

console.log(version);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\ntag=v${version}\n`);
