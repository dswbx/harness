import { describe, expect, it } from "vitest";
import { fromForm, type Form, type Row } from "./settings";

const row = (key: string, value: string, secret = false, stored = false): Row => ({ key, value, secret, stored });
const form = (o: Partial<Form> = {}): Form => ({ id: "", name: "S", kind: "stdio", command: "npx", args: "", url: "", rows: [], ...o });

describe("fromForm", () => {
  it("stdio: splits args on whitespace, trims command and name", () => {
    const { server } = fromForm(form({ name: " GH ", command: " npx ", args: "  -y   pkg\t--flag " }));
    expect(server.name).toBe("GH");
    expect(server.transport).toEqual({ type: "stdio", command: "npx", args: ["-y", "pkg", "--flag"], env: {} });
  });
  it("http: url and headers, ignores command/args", () => {
    const { server } = fromForm(form({ kind: "http", url: " https://x/mcp ", command: "ignored", rows: [row("Accept", "json")] }));
    expect(server.transport).toEqual({ type: "http", url: "https://x/mcp", headers: { Accept: "json" } });
  });
  it("stdio rows go to env", () => {
    const { server } = fromForm(form({ rows: [row("A", "1")] }));
    expect(server.transport).toMatchObject({ env: { A: "1" } });
  });
  it("skips blank keys", () => {
    const { server, secrets } = fromForm(form({ rows: [row("", "x"), row("  ", "y", true)] }));
    expect(server.transport).toMatchObject({ env: {} });
    expect(server.secret_keys).toEqual([]);
    expect(secrets).toEqual({});
  });
  it("secret rows go to secrets and secret_keys, not env/headers", () => {
    const { server, secrets } = fromForm(form({ rows: [row("PLAIN", "p"), row("TOKEN", "t", true)] }));
    expect(server.transport).toMatchObject({ env: { PLAIN: "p" } });
    expect((server.transport as { env: object }).env).not.toHaveProperty("TOKEN");
    expect(server.secret_keys).toEqual(["TOKEN"]);
    expect(secrets).toEqual({ TOKEN: "t" });
  });
  it("secret rows not in headers for http", () => {
    const { server } = fromForm(form({ kind: "http", url: "u", rows: [row("Authorization", "Bearer x", true)] }));
    expect(server.transport).toEqual({ type: "http", url: "u", headers: {} });
    expect(server.secret_keys).toEqual(["Authorization"]);
  });
  it("stored secret with empty value keeps key, adds no secret", () => {
    const { server, secrets } = fromForm(form({ rows: [row("TOKEN", "", true, true)] }));
    expect(server.secret_keys).toEqual(["TOKEN"]);
    expect(secrets).toEqual({});
  });
  it("trims keys", () => {
    const { server, secrets } = fromForm(form({ rows: [row(" A ", "1"), row(" S ", "v", true)] }));
    expect(server.transport).toMatchObject({ env: { A: "1" } });
    expect(server.secret_keys).toEqual(["S"]);
    expect(secrets).toEqual({ S: "v" });
  });
  it("keeps id", () => expect(fromForm(form({ id: "abc" })).server.id).toBe("abc"));
});
