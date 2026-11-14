import { type SlashCommand, sameRepo } from "@harness/api";
import { type RefObject, useMemo, useState } from "react";
import { repoToken } from "../prRefs/prMenu";
import { usePrRefs } from "../prRefs/prRefs";
import { leadingCommand, matchCommands, withSideThreadCommand } from "./commands";
import type { CaretToken, MenuKey, PromptEditorHandle } from "./PromptEditor";
import { type PrMenu, usePrMenu } from "./PromptMenu";

/**
 * The menus above the box: "/" commands, else PRs for the `#` token at the caret (one at a time).
 * `text`: the editor's plain text. `commands`: the Agent's slash commands. Escape closes a menu until
 * its key changes (the text for "/", the token for "#").
 */
export function usePromptMenus({
   text,
   commands: agentCommands,
   threadId,
   onSideThread,
   editor,
}: {
   text: string;
   commands: SlashCommand[];
   threadId: string | null;
   onSideThread: unknown;
   editor: RefObject<PromptEditorHandle | null>;
}) {
   const [sel, setSel] = useState(0);
   // The `#` token at the caret (for the PR menu).
   const [token, setToken] = useState<CaretToken | null>(null);
   // The menu closed with Escape: its key (the text for "/", the token for "#"); a change opens it again.
   const [closedAt, setClosedAt] = useState<string | null>(null);
   const commands = useMemo(
      () => (threadId || !onSideThread ? agentCommands : withSideThreadCommand(agentCommands)),
      [agentCommands, threadId, onSideThread],
   );
   const all = useMemo(() => matchCommands(commands, text), [commands, text]);
   const used = useMemo(() => leadingCommand(commands, text), [commands, text]);
   const refs = usePrRefs();
   const prMenu = usePrMenu(all.length ? null : (token?.text ?? null), refs);
   // One menu at a time: "/" commands, else PRs for a `#` token.
   const menu:
      | { kind: "slash"; key: string; items: SlashCommand[] }
      | { kind: "pr"; key: string; menu: PrMenu }
      | null = all.length
      ? { kind: "slash", key: `/${text}`, items: all }
      : prMenu && token
        ? { kind: "pr", key: `#${token.nodeKey}:${token.start}:${token.text}`, menu: prMenu }
        : null;
   const open = menu && closedAt !== menu.key ? menu : null;
   const count = !open ? 0 : open.kind === "slash" ? open.items.length : open.menu.rows.length;
   const index = Math.min(sel, Math.max(0, count - 1));

   const pick = (c: SlashCommand) => editor.current?.setText(`/${c.name} `);
   // A PR becomes a chip (`#N` in the Session's repo, else `owner/repo#N`); a repo turns the token into `owner/repo#`.
   const pickPr = (i: number) => {
      const row = open?.kind === "pr" ? open.menu.rows[i] : undefined;
      if (!row || !token) return;
      if (row.kind === "repo")
         return editor.current?.replaceToken(token, { text: repoToken(row.hit) });
      const key = { repo: row.pr.repo, number: row.pr.number };
      const own = refs?.ctx.sessionRepo && sameRepo(refs.ctx.sessionRepo, key.repo);
      editor.current?.replaceToken(token, {
         pr: key,
         typed: own ? `#${key.number}` : `${key.repo.owner}/${key.repo.name}#${key.number}`,
      });
   };
   const onMenuKey = (k: MenuKey) => {
      if (!open) return;
      if (k === "down") setSel((index + 1) % count);
      else if (k === "up") setSel((index + count - 1) % count);
      else if (k === "close") setClosedAt(open.key);
      else if (open.kind === "slash") pick(open.items[index]!);
      else pickPr(index);
   };
   const onToken = (t: CaretToken | null) =>
      setToken((cur) =>
         cur?.text === t?.text && cur?.start === t?.start && cur?.nodeKey === t?.nodeKey ? cur : t,
      );
   /** The editor's text changed to `t`: a new text starts at the first row, with the menu open. */
   const onTextChange = (t: string) => {
      if (t !== text) {
         setSel(0);
         setClosedAt(null);
      }
   };
   return {
      open,
      count,
      index,
      used,
      refs,
      setSel,
      pick,
      pickPr,
      onMenuKey,
      onToken,
      onTextChange,
   };
}
