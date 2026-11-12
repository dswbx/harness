import { beforeAll, describe, expect, it, vi } from "vitest";
import type { PendingAttachment } from "./attachments";
import { clearDraft, getDraft, setDraft, updateDraftAttachments } from "./drafts";
import type { PromptSnapshot } from "./promptMarkdown";

const snap = { root: { children: [], type: "root" } } as unknown as PromptSnapshot;
const file = { id: "a", name: "a.txt" } as PendingAttachment;

beforeAll(() => {
   const m = new Map<string, string>();
   vi.stubGlobal("localStorage", {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k),
   });
});

describe("drafts", () => {
   it("keeps a draft per composer and drops it when empty", () => {
      setDraft("s1", snap);
      expect(getDraft("s1")).toEqual(snap);
      expect(getDraft("s1#t1")).toBeNull();
      setDraft("s1", null);
      expect(getDraft("s1")).toBeNull();
   });
   it("clearDraft drops text and attachments", () => {
      setDraft("s2", snap);
      let seen: PendingAttachment[] = [];
      updateDraftAttachments("s2", () => [file]);
      updateDraftAttachments("s2", (cur) => ((seen = cur), cur));
      expect(seen).toEqual([file]);
      clearDraft("s2");
      expect(getDraft("s2")).toBeNull();
      updateDraftAttachments("s2", (cur) => ((seen = cur), cur));
      expect(seen).toEqual([]);
   });
});
