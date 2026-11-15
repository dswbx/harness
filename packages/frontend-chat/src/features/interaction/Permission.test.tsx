import type { SessionApi } from "@harness/api";
import { TooltipProvider } from "@harness/ui";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Item } from "../../state/reducer";
import { PermissionCard } from "./Permission";

afterEach(cleanup);

type Perm = Extract<Item, { type: "permission" }>;

const item = (over: Partial<Perm> = {}): Perm => ({
   type: "permission",
   id: "p1",
   requestId: "r1",
   toolCall: { toolCallId: "t1", title: "bun test", kind: "execute" },
   harnessTool: null,
   plan: null,
   commitMessage: null,
   frontendTool: null,
   stepId: "t1",
   step: {
      type: "tool",
      id: "t1",
      title: "bun test",
      kind: "execute",
      status: "pending",
      content: [],
      locations: null,
      rawInput: { command: "bun test\nbun run lint" },
      rawOutput: null,
      parent: null,
      background: false,
      report: null,
      harnessTool: null,
      subagentPrompt: null,
      subagentMeta: null,
      ts: 0,
      endedAt: null,
      commitMessage: null,
      detail: { command: "bun test\nbun run lint" },
   },
   options: [
      { option_id: "once", name: "Allow", kind: "allow_once" },
      { option_id: "always", name: "Always allow", kind: "allow_always" },
      { option_id: "no", name: "Reject", kind: "reject_once" },
   ],
   resolved: false,
   ...over,
});

const mount = (p: Perm) => {
   const resolvePermission = vi.fn(() => Promise.resolve());
   render(
      <TooltipProvider>
         <PermissionCard item={p} api={{ resolvePermission } as unknown as SessionApi} />
      </TooltipProvider>,
   );
   return resolvePermission;
};

describe("PermissionCard", () => {
   it("asks with the kind's verb and previews the command", () => {
      mount(item());
      expect(screen.getByText("Run command?")).toBeTruthy();
      expect(screen.getByText("command")).toBeTruthy();
      expect(screen.getByText(/bun run lint/)).toBeTruthy();
   });

   it("Allow answers once; Deny answers the reject option", () => {
      const resolve = mount(item());
      fireEvent.click(screen.getByRole("button", { name: "Allow" }));
      expect(resolve).toHaveBeenLastCalledWith("r1", "once", false);
      fireEvent.click(screen.getByRole("button", { name: "Deny" }));
      expect(resolve).toHaveBeenLastCalledWith("r1", "no", false);
   });

   it("picking 'Always, this Session' relabels Allow, the next click answers", () => {
      const resolve = mount(item());
      fireEvent.keyDown(screen.getByRole("button", { name: "More ways to allow" }), {
         key: "Enter",
      });
      fireEvent.click(screen.getByRole("menuitemradio", { name: /Always, this Session/ }));
      expect(resolve).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Allow · always" }));
      expect(resolve).toHaveBeenCalledWith("r1", "always", false);
   });
});
