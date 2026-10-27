import { describe, expect, it } from "vitest";
import type { AppEvent } from "./generated";
import { HarnessClient } from "./client";
import { MockTransport } from "./mock";

describe("MockTransport app events", () => {
  it("emits SessionsChanged / AgentsChanged and stops after unsubscribe", async () => {
    const client = new HarnessClient(new MockTransport([], []));
    const got: AppEvent[] = [];
    const off = await client.subscribeApp((e) => got.push(e));
    const id = await client.createSession({ folder: "/tmp/x", agentId: "codex", frontendId: "chat" });
    await client.archiveSession(id);
    await client.addCustomAgent({ name: "Mine", command: "x", args: [], env: {} });
    expect(got.map((e) => e.type)).toEqual(["SessionsChanged", "SessionsChanged", "AgentsChanged"]);
    off();
    await client.deleteSession(id);
    expect(got).toHaveLength(3);
  });
});
