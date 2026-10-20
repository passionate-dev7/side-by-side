import { BedrockRuntimeClient, ConverseCommand, type Message as BedrockMessage } from "@aws-sdk/client-bedrock-runtime";
import type { IncomingMessage, ServerResponse } from "node:http";

export interface ToolDef { name: string; description?: string; inputSchema: Record<string, unknown> }
export interface ToolCall { id: string; name: string; arguments: Record<string, unknown> }
export interface ToolResult { id: string; name: string; text: string; isError: boolean }
export type Msg =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; toolCalls: ToolCall[] }
  | { role: "tool"; results: ToolResult[] };
export interface LlmRequest { system: string; messages: Msg[]; tools: ToolDef[] }
export interface LlmResponse { text: string; toolCalls: ToolCall[] }
export interface LlmProvider { id: "anthropic" | "openai" | "bedrock"; model: string; complete(req: LlmRequest): Promise<LlmResponse> }

type Env = Record<string, string | undefined>;
const MAX_TOKENS = 1024;

async function postJson(label: string, url: string, headers: Record<string, string>, body: unknown) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${label} HTTP ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

/** Keys are read from env by NAME inside each provider and never returned, logged or echoed. */
function anthropic(env: Env): LlmProvider {
  const model = env.LLM_MODEL ?? "claude-haiku-4-5";
  const base = env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com";
  return {
    id: "anthropic",
    model,
    async complete({ system, messages, tools }) {
      const wire = messages.map((m) =>
        m.role === "user"
          ? { role: "user", content: m.text }
          : m.role === "assistant"
            ? { role: "assistant", content: [...(m.text ? [{ type: "text", text: m.text }] : []), ...m.toolCalls.map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: c.arguments }))] }
            : { role: "user", content: m.results.map((r) => ({ type: "tool_result", tool_use_id: r.id, content: r.text, is_error: r.isError })) },
      );
      const out = await postJson("anthropic", `${base}/v1/messages`, { "x-api-key": env.ANTHROPIC_API_KEY!, "anthropic-version": "2023-06-01" }, {
        model, max_tokens: MAX_TOKENS, system, messages: wire,
        tools: tools.map((t) => ({ name: t.name, description: t.description ?? "", input_schema: t.inputSchema })),
      });
      const blocks = out.content as Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }>;
      return {
        text: blocks.filter((b) => b.type === "text").map((b) => b.text).join(" ").trim(),
        toolCalls: blocks.filter((b) => b.type === "tool_use").map((b) => ({ id: b.id!, name: b.name!, arguments: b.input ?? {} })),
      };
    },
  };
}

/** Any OpenAI-compatible chat completions endpoint: OpenAI, OpenRouter, a local gateway. */
function openai(env: Env): LlmProvider {
  const openrouter = !env.OPENAI_API_KEY && !!env.OPENROUTER_API_KEY;
  const base = env.OPENAI_BASE_URL ?? (openrouter ? "https://openrouter.ai/api/v1" : "https://api.openai.com/v1");
  const key = env.OPENAI_API_KEY ?? env.OPENROUTER_API_KEY!;
  const model = env.LLM_MODEL ?? (openrouter ? "anthropic/claude-haiku-4.5" : "gpt-4o-mini");
  return {
    id: "openai",
    model,
    async complete({ system, messages, tools }) {
      const wire: unknown[] = [{ role: "system", content: system }];
      for (const m of messages) {
        if (m.role === "user") wire.push({ role: "user", content: m.text });
        else if (m.role === "assistant")
          wire.push({
            role: "assistant",
            content: m.text || null,
            ...(m.toolCalls.length && { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.arguments) } })) }),
          });
        else for (const r of m.results) wire.push({ role: "tool", tool_call_id: r.id, content: r.text });
      }
      const out = await postJson("openai-compatible", `${base}/chat/completions`, { authorization: `Bearer ${key}` }, {
        model, max_tokens: MAX_TOKENS, messages: wire,
        ...(tools.length && { tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description ?? "", parameters: t.inputSchema } })) }),
      });
      const msg = out.choices?.[0]?.message;
      if (!msg) throw new Error(`openai-compatible: response had no choices: ${JSON.stringify(out).slice(0, 300)}`);
      return {
        text: (msg.content ?? "").trim(),
        toolCalls: (msg.tool_calls ?? []).map((c: { id: string; function: { name: string; arguments: string } }) => ({
          id: c.id, name: c.function.name, arguments: c.function.arguments ? JSON.parse(c.function.arguments) : {},
        })),
      };
    },
  };
}

/** AWS SDK Converse. Region and profile come from AWS_REGION and AWS_PROFILE; AWS_BEARER_TOKEN_BEDROCK is picked up by the SDK. */
function bedrock(env: Env): LlmProvider {
  const model = env.LLM_MODEL ?? env.BEDROCK_MODEL_ID ?? "us.anthropic.claude-haiku-4-5-20251001-v1:0";
  const client = new BedrockRuntimeClient({ region: env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? "us-east-1" });
  return {
    id: "bedrock",
    model,
    async complete({ system, messages, tools }) {
      const wire: BedrockMessage[] = messages.map((m): BedrockMessage =>
        m.role === "user"
          ? { role: "user", content: [{ text: m.text }] }
          : m.role === "assistant"
            ? { role: "assistant", content: [...(m.text ? [{ text: m.text }] : []), ...m.toolCalls.map((c) => ({ toolUse: { toolUseId: c.id, name: c.name, input: c.arguments as never } }))] }
            : { role: "user", content: m.results.map((r) => ({ toolResult: { toolUseId: r.id, status: r.isError ? ("error" as const) : ("success" as const), content: [{ text: r.text }] } })) },
      );
      const out = await client.send(new ConverseCommand({
        modelId: model, system: [{ text: system }], messages: wire, inferenceConfig: { maxTokens: MAX_TOKENS },
        ...(tools.length && { toolConfig: { tools: tools.map((t) => ({ toolSpec: { name: t.name, description: t.description ?? "", inputSchema: { json: t.inputSchema as never } } })) } }),
      }));
      const blocks = out.output?.message?.content ?? [];
      return {
        text: blocks.map((b) => b.text ?? "").join(" ").trim(),
        toolCalls: blocks.filter((b) => b.toolUse).map((b) => ({ id: b.toolUse!.toolUseId!, name: b.toolUse!.name!, arguments: (b.toolUse!.input ?? {}) as Record<string, unknown> })),
      };
    },
  };
}

const KNOWN_NAMES = ["LLM_PROVIDER", "LLM_MODEL", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "OPENAI_BASE_URL", "AWS_BEARER_TOKEN_BEDROCK", "AWS_ACCESS_KEY_ID", "AWS_PROFILE", "AWS_REGION"];

/** Picks the provider from env var NAMES that are present. LLM_PROVIDER forces one. */
export function selectProvider(env: Env = process.env): { provider?: LlmProvider; presentNames: string[]; error?: string } {
  const presentNames = KNOWN_NAMES.filter((n) => env[n]);
  const forced = env.LLM_PROVIDER;
  const has = {
    anthropic: !!env.ANTHROPIC_API_KEY,
    openai: !!(env.OPENAI_API_KEY || env.OPENROUTER_API_KEY),
    bedrock: !!(env.AWS_BEARER_TOKEN_BEDROCK || env.AWS_ACCESS_KEY_ID || env.AWS_PROFILE),
  };
  const make = { anthropic, openai, bedrock };
  const id = (forced as keyof typeof make | undefined) ?? (["anthropic", "openai", "bedrock"] as const).find((k) => has[k]);
  if (!id || !(id in make)) return { presentNames, error: "No LLM credentials found. Set ANTHROPIC_API_KEY, OPENAI_API_KEY (or OPENROUTER_API_KEY, optionally OPENAI_BASE_URL), or AWS_BEARER_TOKEN_BEDROCK / AWS_PROFILE for Bedrock." };
  if (!has[id]) return { presentNames, error: `LLM_PROVIDER=${id} but its credential env var is not set.` };
  return { provider: make[id](env), presentNames };
}

async function readJson(req: IncomingMessage): Promise<LlmRequest> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** Connect-style middleware: GET /api/llm/status and POST /api/llm. */
export function llmMiddleware(req: IncomingMessage, res: ServerResponse, next: () => void) {
  const send = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  if (req.url === "/api/llm/status" && req.method === "GET") {
    const sel = selectProvider();
    return send(200, { provider: sel.provider?.id ?? null, model: sel.provider?.model ?? null, envNamesPresent: sel.presentNames, error: sel.error ?? null });
  }
  if (req.url === "/api/llm" && req.method === "POST") {
    const sel = selectProvider();
    if (!sel.provider) return send(503, { error: sel.error });
    readJson(req)
      .then((body) => sel.provider!.complete(body))
      .then((out) => send(200, out))
      .catch((e: Error) => send(502, { error: `${sel.provider!.id}: ${e.message}` }));
    return;
  }
  next();
}
