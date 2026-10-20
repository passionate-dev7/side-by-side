import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { createApp } from "../src/app.js";

let http: Server;
let handle: ReturnType<typeof createApp>;
let base: string;

beforeAll(async () => {
  handle = createApp();
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
    expect(r.json.result.serverInfo.name).toBe("alexa-mcp-base");
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
    expect(l.json.result.tools.map((t: { name: string }) => t.name)).toContain("world_clock");
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
    const r = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "world_clock", arguments: { timezone: "Asia/Tokyo" } } });
    expect(r.status).toBe(200);
    expect(r.json.result.structuredContent.timezone).toBe("Asia/Tokyo");
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

describe("tools through the SDK client", () => {
  it("tools/list exposes world_clock with its MCP Apps UI resource", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const clock = tools.find((t) => t.name === "world_clock")!;
    expect(clock).toBeDefined();
    expect((clock._meta as { ui: { resourceUri: string } }).ui.resourceUri).toBe("ui://alexa-base/world-clock.html");
    expect(clock.inputSchema.properties).toHaveProperty("timezone");
    await client.close();
  });

  it("tools/call returns structured content plus a spoken text mirror, under the 500 ms budget", async () => {
    const client = await connect();
    const t0 = performance.now();
    const res = await client.callTool({ name: "world_clock", arguments: { timezone: "Asia/Tokyo" } });
    const ms = performance.now() - t0;
    const sc = res.structuredContent as { timezone: string; utcOffset: string; iso: string };
    expect(res.isError).toBeFalsy();
    expect(sc.timezone).toBe("Asia/Tokyo");
    expect(sc.utcOffset).toBe("GMT+09:00");
    expect(Math.abs(Date.now() - Date.parse(sc.iso))).toBeLessThan(5000);
    expect((res.content as Array<{ text: string }>)[0].text).toMatch(/^It is .+ in Tokyo, on .+\.$/);
    expect(ms).toBeLessThan(500);
    await client.close();
  });

  it("resources/read returns the 768x480 view with the MCP Apps mime type", async () => {
    const client = await connect();
    const { contents } = await client.readResource({ uri: "ui://alexa-base/world-clock.html" });
    expect(contents[0].mimeType).toBe(RESOURCE_MIME_TYPE);
    const html = (contents[0] as { text: string }).text;
    expect(html).toContain("width:768px");
    expect(html).toContain("height:480px");
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

  it("an invalid time zone returns a structured, speakable error instead of nothing", async () => {
    const client = await connect();
    const res = await client.callTool({ name: "world_clock", arguments: { timezone: "Mars/Olympus" } });
    expect(res.isError).toBe(true);
    expect((res.structuredContent as { error: string }).error).toBe("invalid_timezone");
    expect((res.content as Array<{ text: string }>)[0].text).toMatch(/Mars\/Olympus/);
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
