import { defineConfig } from "vitest/config";

const roots = ["packages/**/src/**", "app/src/**", "scripts/**"];

export default defineConfig({
   test: {
      projects: [
         {
            test: {
               name: "node",
               include: roots.map((r) => `${r}/*.test.ts`),
               environment: "node",
            },
         },
         {
            test: {
               name: "dom",
               include: roots.map((r) => `${r}/*.test.tsx`),
               environment: "happy-dom",
            },
         },
      ],
   },
});
