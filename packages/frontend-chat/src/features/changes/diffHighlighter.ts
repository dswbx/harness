import { type DiffFileHighlighter, processAST } from "@git-diff-view/react";
import { highlight, isLanguage } from "../markdown/highlight";

/**
 * Hands git-diff-view the chat's highlighter (`highlight.ts`), so the diff does not compile a second set of
 * grammars at runtime. The library's own highlighter module is still bundled (it is its fallback).
 */
let maxLines = 2000;
let ignore: (string | RegExp)[] = [];

export const diffHighlighter: DiffFileHighlighter = {
   // The name shows in the view's markup (`data-highlighter`).
   name: "lowlight",
   type: "class",
   get maxLineToIgnoreSyntax() {
      return maxLines;
   },
   setMaxLineToIgnoreSyntax: (v) => {
      maxLines = v;
   },
   get ignoreSyntaxHighlightList() {
      return ignore;
   },
   setIgnoreSyntaxHighlightList: (v) => {
      ignore = v;
   },
   // The view takes undefined as "no syntax" (its own highlighter returns it too), though its type says otherwise.
   getAST: (raw, fileName, lang) => {
      const skip =
         fileName && ignore.some((i) => (i instanceof RegExp ? i.test(fileName) : fileName === i));
      return (skip ? undefined : (highlight(raw, lang) ?? undefined)) as never;
   },
   processAST,
   hasRegisteredCurrentLang: isLanguage,
};
