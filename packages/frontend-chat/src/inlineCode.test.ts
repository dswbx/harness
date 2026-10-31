import { expect, test } from "vitest";
import { FALLBACK, inlineLanguage, messageLanguage } from "./inlineCode";

type Node = Parameters<typeof messageLanguage>[0];
const text = (value: string): Node => ({ type: "text", value });
const el = (tagName: string, children: Node[], className?: string[]): Node => ({ type: "element", tagName, properties: className ? { className } : {}, children });
const block = (lang: string) => el("pre", [el("code", [text("x")], ["hljs", `language-${lang}`])]);
const msg = (...children: Node[]): Node => ({ type: "root", children: [el("p", children)] });

test("code-like inline code takes the guess; names, paths and keys stay plain", () => {
  for (const t of ["useAuth.updatePassword(input: string)", 'updatePassword("x")', "{ email, password }", "(a) => a", "x = 1"]) {
    expect(inlineLanguage(t, "rust").lang).toBe("rust");
  }
  expect(inlineLanguage("f(x)").lang).toBe(FALLBACK);
  for (const t of ["email", "use-auth.ts", "auth.user.password.change", "entityUpdate", "cargo test -p harness-core", "src/api.rs:42"]) {
    expect(inlineLanguage(t)).toEqual({ lang: null, code: t });
  }
});

test("{:lang} names the language and is stripped, guessing or not", () => {
  expect(inlineLanguage("{:rust}let x = 1;")).toEqual({ lang: "rust", code: "let x = 1;" });
  expect(inlineLanguage("{:bash}ls -la", null)).toEqual({ lang: "bash", code: "ls -la" });
  expect(inlineLanguage("{:plain}f(x)")).toEqual({ lang: null, code: "f(x)" });
  expect(inlineLanguage("{:nope}f(x)")).toEqual({ lang: null, code: "f(x)" });
  expect(inlineLanguage("f(x)", null)).toEqual({ lang: null, code: "f(x)" });
});

test("a message's language: its code blocks, else the file extensions it mentions", () => {
  expect(messageLanguage(msg(text("no hint here"), el("code", [text("f(x)")])))).toBeNull();
  expect(messageLanguage(msg(text("in session.rs and host.rs, not app.ts")))).toBe("rust");
  expect(messageLanguage(msg(el("code", [text("use-auth.ts")]), text(" calls it")))).toBe("typescript");
  // Code blocks beat extensions; shell and data blocks and files are no hint.
  expect(messageLanguage({ type: "root", children: [block("python"), block("bash"), block("bash"), el("p", [text("a.rs b.rs")])] })).toBe("python");
  expect(messageLanguage({ type: "root", children: [block("bash"), block("json"), el("p", [text("Cargo.toml, notes.md, main.go")])] })).toBe("go");
  // A snippet's member access is not a file.
  expect(messageLanguage(msg(el("code", [text("config.go()")])))).toBeNull();
});
