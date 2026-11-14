// The one grammar of PR references in text, as regex source strings. Every place that recognizes a ref builds on these
// (`findPrRefs`, the prompt's import and `#` menu, the chat's chips and the References), so an edge (a boundary, a
// number, a URL form) changes here once. Pure.

/** GitHub owners have no dots (so `x.com/a#3` is no ref); repo names may. */
export const OWNER = String.raw`[\w-]+`;
export const NAME = String.raw`[\w.-]+`;
/** A PR number: positive, and small enough to be a safe integer. */
export const NUMBER = String.raw`0*[1-9]\d{0,14}`;

/** A ref starts at the start, after whitespace or `(` ... */
export const REF_START = String.raw`(?<=^|[\s(])`;
/** ... and ends at the end, whitespace, closing brackets/quotes or punctuation not followed by a word (`#3.5` is no
 * ref). So `https://x.com/a#3` and `a/b#3x` stay text. */
export const REF_END = String.raw`(?=$|\s|[.,;:!?](?!\w)|[)\]}'"])`;

/** `https://github.com/owner/repo/pull/N`, optionally `/files` and the like, optionally a `#fragment`. Groups: owner,
 * repo, number. */
export const PR_URL = String.raw`https?://(?:www\.)?github\.com/(${OWNER})/(${NAME})/pull/(${NUMBER})(?:/[\w/-]*)?(?:#[\w-]*)?`;
/** `#17`, `spark#17`, `supabase/spark#17`. Groups: owner, name, number. */
export const SHORT_REF = `(?:(?:(${OWNER})/)?(${NAME}))?#(${NUMBER})`;
/** `owner/repo#17` only. Groups: owner, repo, number. */
export const QUALIFIED_REF = `(${OWNER})/(${NAME})#(${NUMBER})`;
/** What the `#` menu reads at the caret: `#`, `#fix`, `spark#1`, `owner/repo#17`. Groups: owner, name, short, query. */
export const MENU_TOKEN = String.raw`^(?:(${OWNER})/(${NAME})|(${NAME}))?#([^#\s]*)$`;
/** The number in any PR URL (any host: for a number typed or pasted into a picker). */
export const PULL_PATH = String.raw`/pull/(\d+)`;
