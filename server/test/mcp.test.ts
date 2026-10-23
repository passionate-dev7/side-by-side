import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createApp } from "../src/app.js";
import { createCtx } from "../src/service.js";
import { openStore } from "../src/store.js";
import { FakeDuffel, NOW } from "./fixtures/fake-duffel.js";
import { toolModules } from "../src/tools/index.js";

let http: Server;
let handle: ReturnType<typeof createApp>;
let base: string;

beforeAll(async () => {
  handle = createApp(createCtx({ duffel: new FakeDuffel(), store: openStore(":memory:"), now: () => NOW, poll: { attempts: 3, delayMs: 1 } }));
  await new Promise<void>((ok) => {
    http = handle.app.listen(0, "127.0.0.1", () => ok());
  });
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await handle.close();
  await new Promise((ok) => http.close(ok));
});

const ACCEPT = "application/json, text/event-stream";

/** Raw JSON-RPC over Streamable HTTP; parses either a JSON body or the first SSE data event. */
async function rpc(body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: ACCEPT, ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const data = res.headers.get("content-type")?.includes("text/event-stream")
    ? text.split("\n").find((l) => l.startsWith("data: "))?.slice(6)
    : text;
  return { status: res.status, headers: res.headers, json: data ? JSON.parse(data) : undefined };
}

const init = (protocolVersion: string) => ({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion, capabilities: { roots: { listChanged: true } }, clientInfo: { name: "Alexa+ MCP Client", version: "test" } },
});

async function connect() {
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  return client;
}

describe("protocol negotiation", () => {
  it.each(["2025-11-25", "2025-03-26"])("initialize with %s echoes that version and issues a session", async (v) => {
    const r = await rpc(init(v));
    expect(r.status).toBe(200);
    expect(r.json.result.protocolVersion).toBe(v);
    expect(r.json.result.serverInfo.name).toBe("side-by-side");
    expect(r.json.result.capabilities.tools).toBeDefined();
    expect(r.headers.get("mcp-session-id")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("an unknown version is negotiated down to the latest supported one", async () => {
    const r = await rpc(init("1999-01-01"));
    expect(r.json.result.protocolVersion).toBe("2025-11-25");
  });

  it("a 2025-03-26 session can list tools with that protocol header", async () => {
    const i = await rpc(init("2025-03-26"));
    const sid = i.headers.get("mcp-session-id")!;
    const headers = { "mcp-session-id": sid, "mcp-protocol-version": "2025-03-26" };
    expect((await rpc({ jsonrpc: "2.0", method: "notifications/initialized" }, headers)).status).toBe(202);
    const l = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, headers);
    expect(l.json.result.tools.map((t: { name: string }) => t.name)).toContain("find_family_flights");
  });

  it("rejects an unsupported MCP-Protocol-Version header on a later request", async () => {
    const sid = (await rpc(init("2025-11-25"))).headers.get("mcp-session-id")!;
    const r = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { "mcp-session-id": sid, "mcp-protocol-version": "1999-01-01" });
    expect(r.status).toBe(400);
    expect(r.json.error.message).toMatch(/Unsupported protocol version/);
  });
});

describe("sessions", () => {
  it("answers 404 for an unknown session id", async () => {
    const r = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { "mcp-session-id": "nope" });
    expect(r.status).toBe(404);
  });

  it("serves a request with no session and no initialize (Alexa+ style) statelessly", async () => {
    const r = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "save_family", arguments: { travelers: [{ name: "Dad", age: 40 }, { name: "Mia", age: 6 }] } } });
    expect(r.status).toBe(200);
    expect(r.json.result.structuredContent.kind).toBe("family");
  });

  it("closing the client removes the session", async () => {
    const client = new Client({ name: "test-client", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`));
    await client.connect(transport);
    const before = handle.sessions.size;
    expect(before).toBeGreaterThan(0);
    await transport.terminateSession();
    await client.close();
    expect(handle.sessions.size).toBe(before - 1);
  });
});

const SEATS_URI = "ui://side-by-side/seats.html";
const PRODUCT_TOOLS = ["save_family", "find_family_flights", "show_seats", "move_traveler", "book_together", "still_together"];
const save = (client: Client) =>
  client.callTool({
    name: "save_family",
    arguments: { travelers: [{ name: "Dad", age: 40 }, { name: "Mum", age: 38 }, { name: "Mia", age: 6 }, { name: "Leo", age: 9 }] },
  });

describe("the Agent Skill as an MCP prompt", () => {
  it("prompts/list offers side-by-side with the SKILL.md description, and prompts/get returns the skill's rules", async () => {
    const client = await connect();
    const { prompts } = await client.listPrompts();
    const p = prompts.find((x) => x.name === "side-by-side");
    expect(p?.description).toMatch(/^Book family flights where every child sits next to a parent\./);
    const got = await client.getPrompt({ name: "side-by-side" });
    const text = (got.messages[0].content as { type: "text"; text: string }).text;
    expect(text).toContain("Nobody under 15 is placed in an exit row");
    expect(text).not.toMatch(/^---/);
    await client.close();
  });
});

describe("tools through the SDK client", () => {
  it("tools/list exposes the six product tools, each bound to the MCP Apps seat view, with short honest descriptions", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    for (const name of PRODUCT_TOOLS) {
      const t = tools.find((x) => x.name === name)!;
      expect(t, name).toBeDefined();
      expect((t._meta as { ui: { resourceUri: string } }).ui.resourceUri).toBe(SEATS_URI);
      expect(t.description!.length).toBeLessThanOrEqual(300);
    }
    const find = tools.find((t) => t.name === "find_family_flights")!;
    expect(Object.keys(find.inputSchema.properties!).sort()).toEqual(["cabin", "departure_date", "destination", "origin"]);
    expect(toolModules.length).toBeGreaterThan(0);
    await client.close();
  });

  it("tools/call returns structured content plus a spoken text mirror, under the 500 ms budget", async () => {
    const client = await connect();
    const t0 = performance.now();
    const res = await save(client);
    const ms = performance.now() - t0;
    const sc = res.structuredContent as { kind: string; party: Array<{ name: string; role: string }> };
    expect(res.isError).toBeFalsy();
    expect(sc.kind).toBe("family");
    expect(sc.party.map((p) => p.role)).toEqual(["adult", "adult", "child", "child"]);
    expect((res.content as Array<{ text: string }>)[0].text).toMatch(/Mia and Leo beside an adult/);
    expect(ms).toBeLessThan(500);
    await client.close();
  });

  it("resources/read returns the 768x480 view with the MCP Apps mime type", async () => {
    const client = await connect();
    const { contents } = await client.readResource({ uri: SEATS_URI });
    expect(contents[0].mimeType).toBe(RESOURCE_MIME_TYPE);
    const html = (contents[0] as { text: string }).text;
    expect(html).toContain("768px");
    expect(html).toContain("480px");
    await client.close();
  });

  it("an unknown tool is an error, not a silent success", async () => {
    const client = await connect();
    const outcome = await client.callTool({ name: "no_such_tool", arguments: {} }).then(
      (r) => ({ isError: r.isError, text: JSON.stringify(r.content) }),
      (e: Error) => ({ isError: true, text: e.message }),
    );
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toMatch(/no_such_tool/);
    await client.close();
  });

  it("bad input is rejected by the declared schema instead of being guessed at", async () => {
    const client = await connect();
    const res = await client.callTool({ name: "save_family", arguments: { travelers: [{ name: "Baby", age: 1 }] } });
    expect(res.isError).toBe(true);
    const bad = await client.callTool({ name: "find_family_flights", arguments: { origin: "New York", destination: "MCO", departure_date: "tomorrow" } });
    expect(bad.isError).toBe(true);
    await client.close();
  });

  it("an optional argument sent as null reads as absent, as language models send it", async () => {
    const client = await connect();
    const res = await client.callTool({ name: "still_together", arguments: { order_id: null } });
    expect((res.structuredContent as { code: string }).code).toBe("no_booking");
    await client.close();
  });

  it("a tool that cannot proceed still answers with a structured, speakable error", async () => {
    const client = await connect();
    const res = await client.callTool({ name: "show_seats", arguments: { offer_id: "off_that_does_not_exist" } });
    expect(res.isError).toBe(true);
    expect((res.structuredContent as { kind: string; code: string }).kind).toBe("error");
    expect((res.content as Array<{ text: string }>)[0].text.length).toBeGreaterThan(10);
    await client.close();
  });

  it("books over the wire: search, seat map, move, then book with elicitation for details and a confirm", async () => {
    const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: { elicitation: {} } });
    const asked: string[][] = [];
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      const props = (req.params as unknown as { requestedSchema: { properties: Record<string, unknown> } }).requestedSchema.properties;
      asked.push(Object.keys(props));
      if ("confirm" in props) return { action: "accept", content: { confirm: true } };
      return { action: "accept", content: { dad_born_on: "1986-03-02", dad_gender: "m", mum_born_on: "1988-07-19", mum_gender: "f", mia_born_on: "2020-05-11", mia_gender: "f", leo_born_on: "2017-01-30", leo_gender: "m", family_name: "Rivera", email: "family@example.com", phone_number: "+12125550123" } };
    });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    await save(client);

    const found = await client.callTool({ name: "find_family_flights", arguments: { origin: "jfk", destination: "MCO", departure_date: "2026-11-25" } });
    const offers = (found.structuredContent as { offers: Array<{ offerId: string; airline: { iata: string }; togetherTotal: number | null }> }).offers;
    expect(offers.map((o) => o.airline.iata)).toEqual(["B6", "DL", "NK", "UA"]);

    const seats = await client.callTool({ name: "show_seats", arguments: { offer_id: "off_delta" } });
    expect((seats.structuredContent as { together: string }).together).toBe("TOGETHER");
    const moved = await client.callTool({ name: "move_traveler", arguments: { offer_id: "off_delta", traveler: "Mia", seat: "1A" } });
    expect((moved.structuredContent as { together: string }).together).toBe("NOT_TOGETHER");
    const refused = await client.callTool({ name: "book_together", arguments: { offer_id: "off_delta" } });
    expect(refused.isError).toBe(true);
    expect((refused.structuredContent as { code: string }).code).toBe("not_together");
    expect(asked).toEqual([]);

    await client.callTool({ name: "show_seats", arguments: { offer_id: "off_spirit" } });
    const booked = await client.callTool({ name: "book_together", arguments: { offer_id: "off_spirit" } });
    expect(booked.isError).toBeFalsy();
    const sc = booked.structuredContent as { kind: string; bookingReference: string; total: number; testMode: boolean };
    expect(sc).toMatchObject({ kind: "booked", bookingReference: "FXT4KQ", total: 1010, testMode: true });
    expect(asked).toHaveLength(2);
    expect(asked[1]).toEqual(["confirm"]);

    const still = await client.callTool({ name: "still_together", arguments: {} });
    expect((still.structuredContent as { kind: string; together: boolean }).together).toBe(true);
    await client.close();
  });
});

describe("http surface", () => {
  it("health reports both protocol versions", async () => {
    const h = await (await fetch(`${base}/health`)).json();
    expect(h.status).toBe("ok");
    expect(h.protocolVersions).toEqual(expect.arrayContaining(["2025-11-25", "2025-03-26"]));
  });

  it("403 for a foreign Origin, even on a preflight", async () => {
    const post = await rpc(init("2025-11-25"), { origin: "https://evil.example" });
    expect(post.status).toBe(403);
    const pre = await fetch(`${base}/mcp`, { method: "OPTIONS", headers: { origin: "https://evil.example", "access-control-request-method": "POST" } });
    expect(pre.status).toBe(403);
  });

  it("allows a localhost Origin and exposes Mcp-Session-Id to the browser", async () => {
    const r = await rpc(init("2025-11-25"), { origin: "http://localhost:5173" });
    expect(r.status).toBe(200);
    expect(r.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    expect(r.headers.get("access-control-expose-headers")).toMatch(/Mcp-Session-Id/i);
  });
});
