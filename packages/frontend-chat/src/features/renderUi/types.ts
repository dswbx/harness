import type { Static } from "jsonv-ts";
import type { Components } from "./catalog";
import type { ICONS } from "./shared";

export type ComponentType = keyof Components;

/** An action an event runs (json-render's built-ins plus `sendMessage`). */
/** A state path, or `{ $item: "field" }` for a field of the current Repeat item. */
export type StatePath = string | { $item: string };
export type UiAction =
   | { action: "setState"; params: { statePath: StatePath; value: unknown } }
   | { action: "pushState"; params: { statePath: StatePath; value: unknown } }
   | { action: "removeState"; params: { statePath: StatePath; index?: number | { $index: true } } }
   | { action: "sendMessage"; params: { text: unknown } }
   | { action: "js"; params: { statePath: StatePath; code: string } };
type On = Partial<Record<"press" | "change" | "submit" | "finish", UiAction | UiAction[]>>;

/** A node as the Agent sends it: props may hold `$state`/`$template`/`$bindState` expressions. */
/** json-render's visibility conditions: truthy `$state` (or a Repeat's `$item`/`$index`), with `eq`/`neq`/`not`; `$and`/`$or`. */
type Cond = { eq?: unknown; neq?: unknown; not?: boolean };
export type Visible =
   | boolean
   | ({ $state: string } & Cond)
   | ({ $item: string } & Cond)
   | ({ $index: true } & Cond)
   | { $and: Visible[] }
   | { $or: Visible[] };
export type RawNode = {
   type: ComponentType;
   props?: Record<string, unknown>;
   children?: RawNode[];
   on?: On;
   visible?: Visible;
};
/** A node after binding: plain props, and the state paths its bound props write to. */
export type UiNode = {
   [K in ComponentType]: {
      type: K;
      props: Static<Components[K]["props"]>;
      children?: UiNode[];
      on?: On;
      visible?: Visible;
      bindings: Record<string, string>;
   };
}[ComponentType];

/**
 * Built-in `$computed` functions (json-render's syntax; it registers its own by name).
 * `count`: entries of `values` (array or object) equal to `eq` (default true). `length`: all entries.
 * `sum`: numbers in `values`.
 */
export const COMPUTED = ["count", "length", "sum"] as const;

export const PLACEMENTS = ["inline", "top", "bottom", "left", "right"] as const;
export type Placement = (typeof PLACEMENTS)[number];
export type RenderUiInput = {
   root?: RawNode;
   /** A file-backed panel (ADR 0023): a `.md`, `.html` or `.json` file in the Session's `panels_dir`, instead of `root`. */
   source?: string;
   id?: string;
   placement?: Placement;
   title?: string;
   icon?: (typeof ICONS)[number];
   remove?: boolean;
};
