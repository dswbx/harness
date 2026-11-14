import type { ComponentType, RawNode, RenderUiInput } from "./types";

/**
 * A file-backed item (`source`, ADR 0023) as a node that names its file: Markdown for `.md`, Html
 * for `.html`, the internal `SourceTree` for `.json` (a render_ui tree). So every place that shows a `root` (chat rows, live areas, panels, artifacts) shows
 * the file. The renderer reads it; the log keeps only the name, so replay shows the file as it is
 * now. The node schemas have no `source` prop, so only this makes such a node.
 */
export function withSourceRoot(v: RenderUiInput): RenderUiInput {
   if (v.root || typeof v.source !== "string") return v;
   const shared = sharedRef(v.source);
   if (shared) return { ...v, root: sharedNode(shared) };
   if (v.source.endsWith(".json")) return { ...v, root: sourceTreeNode(v.source) };
   const type = v.source.endsWith(".html") ? "Html" : "Markdown";
   return { ...v, root: { type, props: { source: v.source } } };
}

/** The Shared Artifact id in a `source` of `shared:<id>` (ADR 0024), else null. */
export function sharedRef(source: unknown): string | null {
   return typeof source === "string" && source.startsWith("shared:")
      ? source.slice("shared:".length) || null
      : null;
}

/**
 * The internal node that shows a Shared Artifact (ADR 0024): not in the catalog, so only the reducer
 * makes one (the Agent sends `source: "shared:<id>"`). The renderer reads the artifact and shows it by kind.
 */
export const sharedNode = (id: string): RawNode => ({
   type: "Shared" as ComponentType,
   props: { id },
});

/** The Shared Artifact a node shows, when it is the internal `Shared` node. */
export function sharedNodeId(n: RawNode): string | null {
   return (n.type as string) === "Shared" && typeof n.props?.id === "string" ? n.props.id : null;
}

/**
 * The internal node that shows a `.json` panel source: a render_ui tree (`{"root": node}`) read from
 * the file and bound to the Session State. Not in the catalog, so only the reducer makes one.
 */
export const sourceTreeNode = (source: string): RawNode => ({
   type: "SourceTree" as ComponentType,
   props: { source },
});

/** The `.json` source a node shows, when it is the internal `SourceTree` node. */
export function sourceTreeName(n: RawNode): string | null {
   return (n.type as string) === "SourceTree" && typeof n.props?.source === "string"
      ? n.props.source
      : null;
}
