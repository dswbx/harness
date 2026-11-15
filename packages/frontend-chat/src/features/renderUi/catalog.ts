import * as charts from "./charts.spec";
import * as code from "./code.spec";
import * as data from "./data.spec";
import * as disclosure from "./disclosure.spec";
import * as forms from "./forms.spec";
import * as layout from "./layout.spec";
import * as media from "./media.spec";
import type { Entry } from "./shared";
import * as text from "./text.spec";

/**
 * The component groups, one `<group>.spec.ts` each (spec, schema and example; the renderer is
 * `<group>.tsx`). The one list: the catalog is their specs together, in this order. A group needs a
 * renderer in `RenderUi.tsx` (a type error there when it has none). Specs stay React-free
 * (`specs.test.ts`).
 */
export const GROUPS = {
   layout: layout.specs,
   text: text.specs,
   code: code.specs,
   media: media.specs,
   charts: charts.specs,
   data: data.specs,
   forms: forms.specs,
   disclosure: disclosure.specs,
};
export type GroupName = keyof typeof GROUPS;

export type UnionToIntersection<U> = (U extends unknown ? (x: U) => void : never) extends (
   x: infer I,
) => void
   ? I
   : never;

/**
 * Order of the components in the schema and the tool description. Fixed so manifest.json stays
 * stable; a new component needs no entry here (it follows the listed ones, in group order).
 */
export const ORDER = [
   "Stack",
   "Card",
   "Markdown",
   "Text",
   "Repeat",
   "KeyValue",
   "Table",
   "Badge",
   "Code",
   "Image",
   "Carousel",
   "Stat",
   "Progress",
   "Choice",
   "Input",
   "Button",
   "Popover",
   "Tabs",
   "Stepper",
   "Diff",
   "List",
   "Checkbox",
   "Switch",
   "Accordion",
   "Timeline",
   "Chart",
   "Grid",
   "Log",
   "Trace",
   "FileLink",
   "PullRequest",
   "Html",
] as string[];
const rank = (n: string) => {
   const i = ORDER.indexOf(n);
   return i < 0 ? ORDER.length : i;
};
const merged = Object.assign({}, ...Object.values(GROUPS)) as UnionToIntersection<
   (typeof GROUPS)[GroupName]
>;

/** The `render_ui` components. Add one to a group in `renderUi/`, with its example. */
export const components = Object.fromEntries(
   Object.entries(merged).sort(([a], [b]) => rank(a) - rank(b)),
) as typeof merged satisfies Record<string, Entry>;

export type Components = typeof components;
