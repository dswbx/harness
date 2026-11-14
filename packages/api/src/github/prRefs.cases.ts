// One table of PR ref inputs for every consumer's tests, so they cannot drift apart: the finder (`findPrRefs`), the
// chat's chips and the References (both from the rendered Markdown), the prompt's import and the `#` menu.
import type { PrRefContext } from "./prRefs";

export const CASE_CTX: PrRefContext = {
   sessionRepo: { owner: "dswbx", name: "harness" },
   knownRepos: [{ repo: { owner: "supabase", name: "spark" }, sessions: 1, score: 1, last_ms: 0 }],
};

export type RefCase = {
   text: string;
   /** `findPrRefs` on the text as typed: the raw text of each explicit ref. */
   plain: string[];
   /** Rendered as Markdown: the key of each PR chip (and Reference), in order. */
   chips: string[];
   /** The prompt's import grammar (`owner/repo#N`, before its code and link checks): raw text of each match. */
   qualified: string[];
   /** References (its own line scanner, not the rendered tree) differs: the PR keys it finds, and why. */
   references?: { chips: string[]; why: string };
   /** The prompt's Markdown import (the grammar plus its code and link checks) differs from `qualified`: what it chips. */
   prompt?: { chips: string[]; why: string };
};

/** What the prompt's `#` menu makes of a token at the caret (`null`: no menu), with `CASE_CTX`. */
export const MENU_CASES: { token: string; mode: string | null }[] = [
   { token: "#", mode: "recent" },
   { token: "#2", mode: "number" },
   { token: "#sp", mode: "title" },
   { token: "#fixes", mode: "title" },
   { token: "#fix the bug", mode: null },
   { token: "spark#s", mode: "title" },
   { token: "spark#17", mode: "number" },
   { token: "supabase/spark#17", mode: "exact" },
   { token: "supabase/spark#17s", mode: "title" },
   { token: "sp#", mode: "recent" },
   { token: "nosuchrepo#1", mode: null },
   { token: "foo.bar/baz#1", mode: null },
   { token: "a#b#c", mode: null },
   { token: "no hash", mode: null },
];

const S = "supabase/spark#17";
const U = "https://github.com/supabase/spark/pull/17";
const none = { plain: [], chips: [], qualified: [] };
const both = (raw: string, key = S) => ({ plain: [raw], chips: [key], qualified: [raw] });
/** In the text but not a ref once rendered (code, headings, links): only the text-level grammars see it. */
const textOnly = (raw: string) => ({ plain: [raw], chips: [], qualified: [raw] });
const url = (text: string, raw = text) => ({
   text,
   plain: [raw],
   chips: [S],
   qualified: [] as string[],
});

export const REF_CASES: Record<string, RefCase> = {
   "ends at punctuation": { text: `see ${S}.`, ...both(S) },
   "ends at a comma": { text: `see ${S}, ok`, ...both(S) },
   "in parentheses": { text: `(${S})`, ...both(S) },
   "word characters after": { text: `${S}x`, ...none },
   "dot before the owner": { text: `foo.${S}`, ...none },
   "decimal after": { text: "x supabase/spark#3.5", ...none },
   "bare number": { text: "see #5", ...none },
   "known repo name": {
      text: "word#12 and spark#12",
      plain: ["spark#12"],
      chips: ["supabase/spark#12"],
      qualified: [],
   },
   "PR prefix": { text: "PR #5.", plain: ["#5"], chips: ["dswbx/harness#5"], qualified: [] },
   "PR glued": { text: "PR#5", plain: ["PR#5"], chips: ["dswbx/harness#5"], qualified: [] },
   zero: { text: "supabase/spark#0", ...none },
   "unsafe number": { text: "supabase/spark#99999999999999999999", ...none },
   "inline code": { text: `\`${S}\``, ...none },
   "double-backtick code": { text: `\`\`a\`b ${S}\`\``, ...none },
   "indented code": {
      text: `    ${S}`,
      ...textOnly(S),
      references: {
         chips: [S],
         why: "the References scanner reads lines, and has no rule for indented code",
      },
   },
   "fenced code": {
      text: `\`\`\`\n${S}\n\`\`\``,
      ...textOnly(S),
      prompt: { chips: [], why: "the prompt never chips inside a code block" },
   },
   "fence in a quote": {
      text: `> \`\`\`\n> ${S}\n> \`\`\``,
      ...textOnly(S),
      references: {
         chips: [S],
         why: "the References scanner reads lines, and has no rule for a fence inside a quote",
      },
   },
   "fence in a list": {
      text: `- \`\`\`\n  ${S}\n  \`\`\``,
      ...textOnly(S),
      references: {
         chips: [S],
         why: "the References scanner reads lines, and has no rule for a fence inside a list item",
      },
   },
   "setext heading": {
      text: `Title ${S}\n===`,
      ...textOnly(S),
      references: {
         chips: [S],
         why: "the References scanner reads lines, and has no rule for setext headings",
      },
   },
   heading: { text: `# ${S}`, ...textOnly(S) },
   "heading in a quote": {
      text: `> # ${S}`,
      ...textOnly(S),
      references: {
         chips: [S],
         why: "the References scanner reads lines, and has no rule for a heading inside a quote",
      },
   },
   "inside a named link": { text: `[x ${S}](https://x.dev)`, ...textOnly(S) },
   bold: {
      text: `**${S}**`,
      plain: [],
      chips: [S],
      qualified: [],
      references: { chips: [], why: "the scanner sees the ref glued to `**`, no boundary" },
      prompt: {
         chips: [S],
         why: "the import runs on the formatted text node, where the ref starts at a boundary",
      },
   },
   emphasis: {
      text: `_${S}_`,
      plain: [],
      chips: [S],
      qualified: [],
      references: { chips: [], why: "the scanner sees the ref glued to `_`, no boundary" },
      prompt: {
         chips: [S],
         why: "the import runs on the formatted text node, where the ref starts at a boundary",
      },
   },
   "pull URL": { ...url(U) },
   "pull URL, sentence end": { ...url(`${U}.`, U) },
   "pull URL, files": { ...url(`${U}/files`) },
   "pull URL, fragment": { ...url(`${U}#issuecomment-1`) },
   "pull URL, parentheses": { text: `(${U})`, plain: [U], chips: [S], qualified: [] },
   "pull URL, query": { text: `${U}?w=1`, ...none },
   "issue URL": { text: "https://github.com/supabase/spark/issues/17", ...none },
   "other host": { text: "https://ghe.corp.com/supabase/spark/pull/17", ...none },
   "angle autolink": { text: `<${U}>`, plain: [], chips: [S], qualified: [] },
   "quoted URL": { text: `"${U}"`, plain: [], chips: [S], qualified: [] },
   "named link to a PR": { text: `[the PR](${U})`, plain: [U], chips: [], qualified: [] },
   "link whose text is the URL": { text: `[${U}](${U})`, plain: [U], chips: [S], qualified: [] },
   "fragment on another URL": { text: "https://x.com/a#3", ...none },
};
