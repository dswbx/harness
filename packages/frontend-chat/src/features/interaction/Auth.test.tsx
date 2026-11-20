import type { SessionApi } from "@harness/api";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Item } from "../../state/reducer";
import { OpenTerminal } from "../terminal/openTerminal";
import { AuthCard, resetAuthFlows } from "./Auth";

afterEach(() => {
   cleanup();
   resetAuthFlows();
});

type Auth = Extract<Item, { type: "auth" }>;

const item = (over: Partial<Auth> = {}): Auth => ({
   type: "auth",
   id: "e5",
   message: "The Agent needs you to sign in first.",
   methods: [
      { id: "sub", name: "Subscription", description: "Use your plan", kind: "terminal" },
      { id: "key", name: "API key", description: null, kind: "agent" },
   ],
   resend: { text: "fix the bug", attachments: [] },
   ...over,
});

function setup() {
   const api = {
      sessionId: "s1",
      authInTerminal: vi.fn(() => Promise.resolve(7)),
      terminalClose: vi.fn(() => Promise.resolve()),
      openAuthTerminal: vi.fn(() => Promise.resolve()),
      authenticate: vi.fn(() => Promise.resolve()),
      prompt: vi.fn(() => Promise.resolve()),
   };
   const open = vi.fn();
   const view = (i: Auth) => (
      <OpenTerminal.Provider value={open}>
         <AuthCard item={i} api={api as unknown as SessionApi} threadId="main" side={false} />
      </OpenTerminal.Provider>
   );
   const r = render(view(item()));
   return { api, open, rerender: (i: Auth) => r.rerender(view(i)) };
}

const finished = (outcome: "signed_in" | "failed" | "cancelled", exitCode: number | null) =>
   item({ finished: { id: "e9", methodId: "sub", methodName: "Subscription", outcome, exitCode } });

describe("AuthCard", () => {
   it("lists each method with its description", () => {
      setup();
      expect(screen.getByRole("button", { name: "Subscription" })).toBeTruthy();
      expect(screen.getByText("Use your plan")).toBeTruthy();
   });

   it("names the Agent in the title, with a fallback", () => {
      const { rerender } = setup();
      expect(screen.getByText("Sign in to continue")).toBeTruthy();
      rerender(item({ agentName: "Claude" }));
      expect(screen.getByText("Sign in to Claude")).toBeTruthy();
   });

   it("runs a terminal method in a Terminal tab and shows it, then waits", async () => {
      const { api, open } = setup();
      fireEvent.click(screen.getByRole("button", { name: "Subscription" }));
      await screen.findByText("Waiting for sign-in…");
      expect(api.authInTerminal).toHaveBeenCalledWith("sub", null);
      expect(open).toHaveBeenCalledWith(7);
   });

   it("Cancel closes the tab; Terminal.app is the fallback", async () => {
      const { api } = setup();
      fireEvent.click(screen.getByRole("button", { name: "Subscription" }));
      fireEvent.click(await screen.findByRole("button", { name: "Open in Terminal.app instead" }));
      expect(api.terminalClose).toHaveBeenCalledWith(7);
      await waitFor(() => expect(api.openAuthTerminal).toHaveBeenCalledWith("sub"));
      expect(await screen.findByText(/Terminal opened/)).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: "Subscription" }));
      fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
      expect(api.terminalClose).toHaveBeenLastCalledWith(7);
      expect(screen.getByRole("button", { name: "Subscription" })).toBeTruthy();
   });

   it("on sign-in, sends the refused message again", async () => {
      const { api, rerender } = setup();
      fireEvent.click(screen.getByRole("button", { name: "Subscription" }));
      await screen.findByText("Waiting for sign-in…");
      rerender(finished("signed_in", 0));
      expect(
         await screen.findByText("Signed in with Subscription. Resent your message."),
      ).toBeTruthy();
      expect(api.prompt).toHaveBeenCalledWith("fix the bug", [], null);
   });

   it("on failure, shows the exit code and Try again", async () => {
      const { api, rerender } = setup();
      fireEvent.click(screen.getByRole("button", { name: "Subscription" }));
      await screen.findByText("Waiting for sign-in…");
      rerender(finished("failed", 1));
      expect(await screen.findByText(/did not finish \(exit code 1\)/)).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      await waitFor(() => expect(api.authInTerminal).toHaveBeenCalledTimes(2));
      expect(api.prompt).not.toHaveBeenCalled();
   });
});
