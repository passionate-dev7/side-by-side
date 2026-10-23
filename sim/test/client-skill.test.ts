import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../../server/src/app";
import { createCtx } from "../../server/src/service";
import { openStore } from "../../server/src/store";
import { FakeDuffel, NOW } from "../../server/test/fixtures/fake-duffel";

// The Echo Show client end to end: its own MCP client connects to the real server over Streamable HTTP, and the system
// prompt it sends to the model on a turn is captured at the /api/llm boundary.

let http: Server;
let handle: ReturnType<typeof createApp>;
const systems: string[] = [];

beforeAll(async () => {
  handle = createApp(createCtx({ duffel: new FakeDuffel(), store: openStore(":memory:"), now: () => NOW, poll: { attempts: 3, delayMs: 1 } }));
  await new Promise<void>((ok) => {
    http = handle.app.listen(0, "127.0.0.1", () => ok());
  });
  const store = new Map<string, string>();
  vi.stubGlobal("window", {});
  vi.stubGlobal("location", { search: `?mcp=http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp` });
  vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) });
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/llm/status") return Response.json({ provider: "test", model: "test-model", error: null });
    if (url === "/api/llm") {
      systems.push(JSON.parse(String(init!.body)).system);
      return Response.json({ text: "Hello from the kitchen.", toolCalls: [] });
    }
    return realFetch(input, init);
  });
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await handle.close();
  await new Promise((ok) => http.close(ok));
});

describe("the Echo Show client loads the served Agent Skill into its system prompt", () => {
  it("after connect, a turn's system prompt carries the persona and the skill the server served as prompt side-by-side", async () => {
    const { sim } = await import("../src/sim");
    await sim.connect();
    expect(sim.getSnapshot().conn.status).toBe("connected");
    sim.toggleMute();
    await sim.submit("Hello");
    expect(sim.getSnapshot().caption?.text).toBe("Hello from the kitchen.");
    expect(systems).toHaveLength(1);
    expect(systems[0]).toMatch(/^You are Alexa\+ running on an Echo Show/);
    expect(systems[0]).toContain("Nobody under 15 is placed in an exit row");
    expect(systems[0]).toContain("Every child aged 13 or under is seated directly beside an adult");
    await sim.disconnect();
  });
});
