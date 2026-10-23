import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  ElicitRequestSchema,
  type CallToolResult,
  type ElicitRequest,
  type ElicitResult,
  type JSONRPCMessage,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { eventLog } from "./log";

export const MCP_APPS_MIME = "text/html;profile=mcp-app";
export const MCP_APPS_EXTENSION = "io.modelcontextprotocol/ui";

type Id = string | number;
interface Flight {
  row: number;
  t0: number;
  method: string;
  note?: string;
  params?: unknown;
}

const isRequest = (m: JSONRPCMessage): m is JSONRPCMessage & { method: string; id: Id } => "method" in m && "id" in m;
const isNotification = (m: JSONRPCMessage): m is JSONRPCMessage & { method: string } => "method" in m && !("id" in m);
const isResponse = (m: JSONRPCMessage): m is JSONRPCMessage & { id: Id } => !("method" in m) && "id" in m;

function noteFor(method: string, params: unknown): string | undefined {
  const p = (params ?? {}) as Record<string, unknown>;
  if (method === "tools/call" && typeof p.name === "string") return p.name;
  if (method === "resources/read" && typeof p.uri === "string") return p.uri;
  if (method === "initialize" && typeof p.protocolVersion === "string") return `requests ${p.protocolVersion}`;
  return undefined;
}

const clip = (v: unknown, n = 900): string => {
  const s = JSON.stringify(v);
  return s.length > n ? `${s.slice(0, n)} ...` : s;
};

/**
 * Streamable HTTP transport that times every JSON-RPC exchange. Latency is measured from send() to the
 * matching response message, so streamed (SSE) replies are timed to completion, not to first byte.
 */
class WireTransport extends StreamableHTTPClientTransport {
  /** Fires for every successful tools/call answer, whoever asked (the model or a view). */
  onToolResult?: (name: string, args: Record<string, unknown>, result: CallToolResult) => void;
  private out = new Map<Id, Flight>();
  private inn = new Map<Id, Flight>();

  override async start(): Promise<void> {
    const upstream = this.onmessage;
    this.onmessage = (m) => {
      this.observeIn(m);
      upstream?.(m);
    };
    await super.start();
  }

  override async send(message: JSONRPCMessage, options?: Parameters<StreamableHTTPClientTransport["send"]>[1]): Promise<void> {
    this.observeOut(message);
    try {
      await super.send(message, options);
    } catch (e) {
      if (isRequest(message)) {
        const f = this.out.get(message.id);
        if (f) {
          this.out.delete(message.id);
          eventLog.update(f.row, { status: "error", ms: Math.round(performance.now() - f.t0), detail: e instanceof Error ? e.message : String(e) });
        }
      }
      throw e;
    }
  }

  private observeOut(m: JSONRPCMessage): void {
    if (isRequest(m)) {
      const note = noteFor(m.method, (m as { params?: unknown }).params);
      const row = eventLog.add({ source: "mcp", label: m.method, note });
      this.out.set(m.id, { row, t0: performance.now(), method: m.method, note, params: (m as { params?: unknown }).params });
    } else if (isNotification(m)) {
      eventLog.add({ source: "mcp", label: m.method, status: "ok" });
    } else if (isResponse(m)) {
      const f = this.inn.get(m.id);
      if (!f) return;
      this.inn.delete(m.id);
      const err = "error" in m;
      eventLog.update(f.row, { status: err ? "error" : "ok", ms: Math.round(performance.now() - f.t0), detail: clip(err ? (m as { error: unknown }).error : (m as { result: unknown }).result) });
    }
  }

  private observeIn(m: JSONRPCMessage): void {
    if (isResponse(m)) {
      const f = this.out.get(m.id);
      if (!f) return;
      this.out.delete(m.id);
      const err = "error" in m;
      const result = err ? undefined : ((m as { result: Record<string, unknown> }).result ?? {});
      const toolFailed = result?.isError === true;
      if (f.method === "tools/call" && result && !err) {
        const p = (f.params ?? {}) as { name?: unknown; arguments?: Record<string, unknown> };
        if (typeof p.name === "string") this.onToolResult?.(p.name, p.arguments ?? {}, result as unknown as CallToolResult);
      }
      const note =
        f.method === "initialize" && typeof result?.protocolVersion === "string" ? `protocol ${result.protocolVersion}`
        : f.method === "tools/list" && Array.isArray(result?.tools) ? `${result.tools.length} tools: ${(result.tools as Array<{ name: string }>).map((t) => t.name).join(", ")}`
        : f.method === "prompts/get" && Array.isArray(result?.messages) ? `Agent Skill loaded as the system prompt`
        : undefined;
      eventLog.update(f.row, {
        status: err || toolFailed ? "error" : "ok",
        ms: Math.round(performance.now() - f.t0),
        ...(note ? { note } : {}),
        detail: clip(err ? (m as { error: unknown }).error : result),
      });
    } else if (isRequest(m)) {
      const row = eventLog.add({ source: "mcp", label: `server asks ${m.method}`, note: "server to client" });
      if (m.method === "elicitation/create") {
        for (const f of this.out.values()) eventLog.update(f.row, { excluded: true, note: `${f.note ?? ""} (includes form wait)`.trim() });
      }
      this.inn.set(m.id, { row, t0: performance.now(), method: m.method });
    } else if (isNotification(m)) {
      eventLog.add({ source: "mcp", label: `server sends ${m.method}`, status: "ok" });
    }
  }
}

export interface McpHandlers {
  onElicit(params: ElicitRequest["params"]): Promise<ElicitResult>;
  onToolResult(name: string, args: Record<string, unknown>, result: CallToolResult): void;
  onClosed(reason: string): void;
}

export interface McpConnection {
  client: Client;
  protocolVersion: string;
  serverName: string;
  serverVersion: string;
  sessionId: string | null;
  tools: Tool[];
  /** The server's Agent Skill (prompt "side-by-side"), loaded at connect; null when the server serves none. */
  skill: string | null;
  close(): Promise<void>;
}

export const SKILL_PROMPT = "side-by-side";

export async function connectMcp(url: string, handlers: McpHandlers): Promise<McpConnection> {
  let endpoint: URL;
  try {
    endpoint = new URL(url);
  } catch {
    throw new Error(`"${url}" is not a valid URL.`);
  }
  const transport = new WireTransport(endpoint);
  transport.onToolResult = handlers.onToolResult;
  const client = new Client(
    { name: "Side by Side on Echo Show", version: "0.1.0" },
    { capabilities: { elicitation: {}, extensions: { [MCP_APPS_EXTENSION]: { mimeTypes: [MCP_APPS_MIME] } } } },
  );
  client.setRequestHandler(ElicitRequestSchema, (req) => handlers.onElicit(req.params));
  client.onerror = (e) => eventLog.add({ source: "sys", label: "client error", note: e.message.slice(0, 90), status: "error", detail: e.message });
  client.onclose = () => handlers.onClosed("The server closed the connection.");

  try {
    await client.connect(transport);
    const tools: Tool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined);
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    let skill: string | null = null;
    if (client.getServerCapabilities()?.prompts) {
      const { prompts } = await client.listPrompts();
      if (prompts.some((p) => p.name === SKILL_PROMPT)) {
        const got = await client.getPrompt({ name: SKILL_PROMPT });
        skill = got.messages.map((m) => (m.content.type === "text" ? m.content.text : "")).join("\n").trim() || null;
      }
    }
    const info = client.getServerVersion();
    return {
      client,
      protocolVersion: transport.protocolVersion ?? "unknown",
      serverName: info?.name ?? "unknown server",
      serverVersion: info?.version ?? "",
      sessionId: transport.sessionId ?? null,
      tools,
      skill,
      close: () => client.close(),
    };
  } catch (e) {
    await client.close().catch(() => undefined);
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(msg === "Failed to fetch" ? `Failed to fetch ${endpoint.href}. The server is not running, or it refused this origin (CORS).` : msg);
  }
}

export function resourceUriOf(tool: Tool | undefined): string | null {
  const meta = tool?._meta as { ui?: { resourceUri?: unknown }; [k: string]: unknown } | undefined;
  const v = meta?.ui?.resourceUri ?? meta?.["ui/resourceUri"];
  return typeof v === "string" ? v : null;
}

export function visibleToModel(tool: Tool): boolean {
  const vis = (tool._meta as { ui?: { visibility?: unknown } } | undefined)?.ui?.visibility;
  return !Array.isArray(vis) || vis.includes("model");
}

export function textOf(result: CallToolResult): string {
  return (result.content ?? []).map((c) => (c.type === "text" ? c.text : "")).filter(Boolean).join(" ").trim();
}
