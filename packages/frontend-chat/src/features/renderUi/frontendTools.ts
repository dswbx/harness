import { s } from "jsonv-ts";
import { andList, catalogText, parents, renderUiJson } from "./schema";
import { ICONS } from "./shared";

export const RENDER_UI = "render_ui";

export const VIEW_ARTIFACT = "view_artifact";

export const frontendTools: {
   name: string;
   description: string;
   schema: unknown;
   replies?: boolean;
}[] = [
   {
      name: VIEW_ARTIFACT,
      description:
         "See an artifact as the user sees it, as a PNG image, to check your work: a diagram, table or render_ui item shown in this conversation, or Mermaid or HTML you pass here, which the user does not see. " +
         "Without arguments: the newest artifact. `id`: a render_ui id (see harness_info) or an artifact key. `kind`: the newest of that kind. " +
         "The result also has Mermaid syntax errors and the script errors of Html frames. Uses the app's current theme. The app window must be open.",
      schema: s.object({
         id: s.string().optional(),
         kind: s.string({ enum: ["ui", "diagram", "table"] }).optional(),
         mermaid: s.string({ description: "Mermaid source to draw" }).optional(),
         html: s
            .string({ description: "HTML to draw, in the same sandboxed frame as render_ui Html" })
            .optional(),
         width: s.number({ description: "Width in CSS pixels (default 900)" }).optional(),
      }),
      replies: true,
   },
   {
      name: RENDER_UI,
      description:
         "Show rich, optionally interactive content to the user: cards, grids, lists, tables, charts, diffs, file links, timelines, traces, logs, images, stats, tabs, steppers, accordions, choices, checkboxes, inputs, buttons. " +
         `Input: {"root": node, "placement"?, "id"?, "title"?, "icon"?}, or "source" instead of "root": the name of a file you wrote in panels_dir (harness_info) that updates when you edit it; use it for panels you change often. A .md file shows as Markdown (<details>/<summary> work), a .html file as an Html node (same frame and bridge), a .json file as a tree: {"root": node}, the same root you would pass here (no local images; check errors in harness_info after edits). A node is {"type", "props", "children"?, "on"?, "visible"?}; only ${andList(parents)} take children.\n` +
         "Placement: inline in the chat (default) or a live area: top, bottom, or a panel at the left or right (needs an id and a title, an icon is optional; right opens in the top right zone, left in the top left; the user can move it). " +
         'A call with the same id replaces that item; {"id", "remove": true} removes it.\n' +
         'Session State: any prop can be {"$state": "/path"}, {"$template": "Branch: ${/setup/branch}"} or {"$computed": "count", "args": {"values": {"$state": "/checks"}, "eq": true}} (also "length" and "sum") and updates when the state changes (change it with state_patch). ' +
         'Choice and Input write the user\'s input with {"$bindState": "/path"}. ' +
         'on.press/change/submit/finish run actions: {"action": "setState"|"pushState", "params": {"statePath", "value"}}, {"action": "removeState", "params": {"statePath", "index"?}}, ' +
         '{"action": "sendMessage", "params": {"text"}} (sends the text to you as the user\'s next message; text can be a $template), ' +
         '{"action": "js", "params": {"statePath", "code"}} (runs JavaScript, an expression or a function body with return, with `state` in scope, and writes its result to statePath; actions in a list see the writes before them). ' +
         "JavaScript ($js, js) runs sandboxed in the app without you, e.g. a calculator or a converter: no DOM, network or timers, 50 ms at most, JSON in and out. " +
         '"visible" shows a node only when the state says so, e.g. {"$state": "/setup/target"} (picked) or {"$state": "/setup/step", "eq": 2}. ' +
         "The user's state changes do not reach you by themselves: add a sendMessage when you must react.\n" +
         'Data from state: Repeat renders its children per item of a state array; inside, {"$item": "field"}, {"$index": true}, "${field}" in a $template, {"$bindItem": "field"}, visible {"$item": "field", "eq"?}; in actions, statePath {"$item": "field"} and removeState index {"$index": true}. When the data changes, patch the state instead of sending the tree again. Repeat inside Accordion or Tabs gives one item; use `repeat` on the parent: {"repeat": {"statePath": "/tickets", "title": "name"}} and one child as the template.\n' +
         "Layout: compose generic parts (Stack with direction, align, justify, wrap, fill; Card variants; Text for short labels, numbers and arrows between parts; Table cells and KeyValue values with a tone) instead of asking for a special component.\n" +
         "Keep related parts in one item: Tabs for parts in any order, a Stepper for steps in order (a setup, a review, a quiz). A Choice whose pick can be checked takes `answer`, `result` and `explanation`.\n" +
         "Html: only for diagrams and custom visuals the catalog cannot show (architecture diagrams, annotated drawings); it runs in a sandboxed frame with the app's theme colors as CSS variables. " +
         'Attributes: data-state="/path" (shows the value as text), data-visible=\'{"$state": "/path", "eq": "x"}\' (same syntax as visible), data-on-click=\'<action or array>\' and data-on-change (run actions), data-bind="/path" on input, select and textarea (two-way; writes on change: blur, Enter or toggle). ' +
         "Scripts get window.harness: `state` (the whole Session State, replaced on each change), `get(path)` (the value at a JSON Pointer, e.g. get('/arch/selected')), `subscribe(fn)` (calls fn(state) at once and after each change; returns an unsubscribe function), `patch(ops)` (JSON Patch ops, e.g. [{op: 'replace', path: '/arch/selected', value: 'api'}]; replace also creates missing keys), `send(text)` (a user message to you), `run(actions)` (render_ui actions, as in on.press). " +
         "Prefer get and subscribe over keeping your own copy. Set data in the state with state_patch first, then draw from it in subscribe; patch the state later instead of sending new HTML. Leave height out: the frame fits its content.\n" +
         "Short text props (table cells and headings, KeyValue, List items, Choice labels, Card descriptions) take inline Markdown: `code`, **bold**, *italic*, links.\n" +
         "Use it for results, status, comparisons, screenshots, decisions you need from the user, or guided tasks, instead of a long plain message.\n" +
         `Icons (the icon prop): ${ICONS.join(", ")}.\nComponents:\n` +
         catalogText(),
      schema: renderUiJson,
   },
];
