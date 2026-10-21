// Proof of one full model turn on the Bedrock mantle provider: the model must call save_family, then find_family_flights,
// against the real MCP tools served by the fixture server (strict fake Duffel). Run: npx tsx sim/scripts/mantle-turn.ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AddressInfo } from "node:net";
import { createApp } from "../../server/src/app.js";
import { createCtx } from "../../server/src/service.js";
import { openStore } from "../../server/src/store.js";
import { FakeDuffel } from "../../server/test/fixtures/fake-duffel.js";
import { selectProvider, type Msg, type ToolResult } from "../server/llm.ts";

const sel = selectProvider({ ...process.env, LLM_PROVIDER: undefined });
if (!sel.provider) throw new Error(sel.error);
const provider = sel.provider;
if (provider.id !== "bedrock-mantle") throw new Error(`default provider is ${provider.id}, expected bedrock-mantle`);

const ctx = createCtx({ duffel: new FakeDuffel(), store: openStore(":memory:"), poll: { attempts: 5, delayMs: 300 } });
const { app } = createApp(ctx, { log: false, allowedOrigins: [] });
const server = app.listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const client = new Client({ name: "mantle-turn", version: "0.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`)));

const visible = (await client.listTools()).tools.filter((t) => {
  const vis = (t._meta as { ui?: { visibility?: unknown } } | undefined)?.ui?.visibility;
  return !Array.isArray(vis) || vis.includes("model");
});
const tools = visible.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema as Record<string, unknown> }));
const system = "You are Alexa+ on an Echo Show. Call a tool for anything about flights or the family. Never guess. Speak in short plain sentences, no markdown. Today is 2026-10-21.";
const history: Msg[] = [{ role: "user", text: "We are the Lopez family: me Maria 38, my husband Diego 41, and our kids Sofia who is 6 and Mateo who is 4. Save us, then find our flights from JFK to MCO on 2026-12-15." }];

const called: string[] = [];
let final = "";
for (let step = 0; step < 6 && !final; step++) {
  const out = await provider.complete({ system, messages: history, tools });
  history.push({ role: "assistant", text: out.text, toolCalls: out.toolCalls });
  if (!out.toolCalls.length) { final = out.text; break; }
  const results: ToolResult[] = [];
  for (const c of out.toolCalls) {
    called.push(c.name);
    const r = (await client.callTool({ name: c.name, arguments: c.arguments })) as CallToolResult;
    const text = [(r.content ?? []).map((x) => (x.type === "text" ? x.text : "")).join(" "), r.structuredContent ? JSON.stringify(r.structuredContent) : ""].filter(Boolean).join("\n");
    console.log(`tool ${c.name} args=${JSON.stringify(c.arguments).slice(0, 160)} isError=${!!r.isError}`);
    results.push({ id: c.id, name: c.name, text, isError: !!r.isError });
  }
  history.push({ role: "tool", results });
}
await client.close();
server.close();

const iSave = called.indexOf("save_family"), iFind = called.indexOf("find_family_flights");
console.log(`provider=${provider.id} model=${provider.model} calls=${called.join(" > ")}`);
console.log(`final: ${final}`);
if (iSave < 0 || iFind < 0 || iSave > iFind) throw new Error("FAIL: expected save_family before find_family_flights");
if (!final) throw new Error("FAIL: no final spoken answer");
const toolMsgs = history.filter((m): m is Extract<Msg, { role: "tool" }> => m.role === "tool").flatMap((m) => m.results);
if (toolMsgs.some((r) => r.isError)) throw new Error("FAIL: a tool call returned an error");
console.log("PASS");
