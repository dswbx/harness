import { expect, test } from "vitest";
import { inlineLanguage } from "./inlineCode";

test("code-like inline code is TypeScript; names, paths and keys stay plain", () => {
  for (const t of ["useAuth.updatePassword(input: string)", 'updatePassword("x")', "{ email, password }", "(a) => a", "x = 1"]) {
    expect(inlineLanguage(t).lang).toBe("typescript");
  }
  for (const t of ["email", "use-auth.ts", "auth.user.password.change", "entityUpdate", "cargo test -p harness-core", "src/api.rs:42"]) {
    expect(inlineLanguage(t)).toEqual({ lang: null, code: t });
  }
});

test("{:lang} names the language and is stripped", () => {
  expect(inlineLanguage("{:rust}let x = 1;")).toEqual({ lang: "rust", code: "let x = 1;" });
  expect(inlineLanguage("{:bash}ls -la")).toEqual({ lang: "bash", code: "ls -la" });
  expect(inlineLanguage("{:plain}f(x)")).toEqual({ lang: null, code: "f(x)" });
  expect(inlineLanguage("{:nope}f(x)")).toEqual({ lang: null, code: "f(x)" });
});
