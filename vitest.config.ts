import { defineConfig } from "vitest/config";

const roots = ["packages/**/src/**", "app/src/**", "scripts/**"];

export default defineConfig({
   test: {
      projects: [
         {
            test: {
               name: "node",
               include: roots.map((r) => `${r}/*.test.ts`),
               exclude: ["**/node_modules/**", "**/*.bench.test.*"],
               environment: "node",
            },
         },
         {
            test: {
               name: "dom",
               include: roots.map((r) => `${r}/*.test.tsx`),
               exclude: ["**/node_modules/**", "**/*.bench.test.*"],
               environment: "happy-dom",
            },
         },
         {
            // Timing tests: alone on the machine (`bun run test` runs this project after the others), one file at a time (`--no-file-parallelism`).
            // A `.tsx` bench says `@vitest-environment happy-dom`.
            test: {
               name: "bench",
               include: roots.flatMap((r) => [`${r}/*.bench.test.ts`, `${r}/*.bench.test.tsx`]),
               environment: "node",
            },
         },
      ],
   },
});
