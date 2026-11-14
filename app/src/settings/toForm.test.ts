import type { McpServerDef } from "@harness/api";
import { describe, expect, it } from "vitest";
import { fromForm, toForm } from "./settings";

describe("toForm", () => {
   it("a stdio server: command, args joined by spaces, env as plain rows", () => {
      const s: McpServerDef = {
         id: "fs",
         name: "Files",
         transport: { type: "stdio", command: "npx", args: ["-y", "pkg"], env: { A: "1" } },
      };
      expect(toForm(s)).toEqual({
         id: "fs",
         name: "Files",
         kind: "stdio",
         command: "npx",
         args: "-y pkg",
         url: "",
         rows: [{ key: "A", value: "1", secret: false, stored: false }],
      });
   });

   it("an http server: url, headers as plain rows, no command", () => {
      const s: McpServerDef = {
         id: "h",
         name: "Web",
         transport: { type: "http", url: "https://x.dev/mcp", headers: { Accept: "json" } },
      };
      expect(toForm(s)).toEqual({
         id: "h",
         name: "Web",
         kind: "http",
         command: "",
         args: "",
         url: "https://x.dev/mcp",
         rows: [{ key: "Accept", value: "json", secret: false, stored: false }],
      });
   });

   it("optional parts missing: no args, no env, no id", () => {
      const f = toForm({ name: "X", transport: { type: "stdio", command: "x" } } as McpServerDef);
      expect(f).toMatchObject({ id: "", args: "", rows: [] });
      expect(toForm({ id: "u", name: "U", transport: { type: "http", url: "u" } }).rows).toEqual(
         [],
      );
   });

   it("secret keys become stored rows with no value, after the plain ones; their values are left out of the plain rows", () => {
      const f = toForm({
         id: "s",
         name: "S",
         transport: { type: "stdio", command: "x", env: { PLAIN: "p", TOKEN: "leaked?" } },
         secret_keys: ["TOKEN", "OTHER"],
      });
      expect(f.rows).toEqual([
         { key: "PLAIN", value: "p", secret: false, stored: false },
         { key: "TOKEN", value: "", secret: true, stored: true },
         { key: "OTHER", value: "", secret: true, stored: true },
      ]);
   });

   it("round trips through fromForm: secrets stay out of the definition and are not re-sent", () => {
      const s: McpServerDef = {
         id: "s",
         name: "S",
         transport: { type: "http", url: "https://x", headers: { A: "1" } },
         secret_keys: ["TOKEN"],
      };
      const { server, secrets } = fromForm(toForm(s));
      expect(server).toEqual(s);
      expect(secrets).toEqual({});
   });
});
