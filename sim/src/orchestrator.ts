import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { LlmResponse, Msg, ToolCall, ToolDef, ToolResult } from "../server/llm";
import { eventLog } from "./log";
import { textOf, visibleToModel } from "./mcp";

export const MAX_STEPS = 6;

export function systemPrompt(today: string): string {
  return [
    "You are Alexa+ running on an Echo Show in a family's kitchen. A parent is talking to you.",
    "Speak in short, plain sentences. Your words are read aloud, so use no markdown, no lists, no symbols and no emoji.",
    "Call a tool for anything about flights, seats, prices, bookings, the family or the time. Never guess.",
    "Never invent prices, seats, flight numbers, airlines or booking references. Say only what a tool result contains.",
    "When you quote a price, quote the together total, which is the fare plus any seat fees, and name the airline it belongs to.",
    "When a tool puts a screen on the display, say one short sentence about what it shows and offer the next step.",
    "If a tool reports a problem, tell the parent plainly what went wrong.",
    `Today is ${today}.`,
  ].join(" ");
}

export function toToolDefs(tools: Tool[]): ToolDef[] {
  return tools.filter(visibleToModel).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema as Record<string, unknown> }));
}

/** The text a model sees for a tool result: the spoken mirror, then the structured payload. */
export function modelTextOf(result: CallToolResult): string {
  const parts = [textOf(result)];
  if (result.structuredContent !== undefined) parts.push(JSON.stringify(result.structuredContent));
  return parts.filter(Boolean).join("\n");
}

export class LlmError extends Error {}

async function complete(system: string, messages: Msg[], tools: ToolDef[], model: string | null): Promise<LlmResponse> {
  const row = eventLog.add({ source: "llm", label: "POST /api/llm", note: model ?? undefined });
  const t0 = performance.now();
  let res: Response;
  try {
    res = await fetch("/api/llm", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ system, messages, tools }) });
  } catch (e) {
    const msg = `Could not reach the simulator's LLM proxy: ${e instanceof Error ? e.message : String(e)}`;
    eventLog.update(row, { status: "error", ms: Math.round(performance.now() - t0), detail: msg });
    throw new LlmError(msg);
  }
  const ms = Math.round(performance.now() - t0);
  const body = (await res.json().catch(() => null)) as (LlmResponse & { error?: string }) | null;
  if (!res.ok || !body || typeof body.text !== "string") {
    const msg = body?.error ?? `LLM proxy returned HTTP ${res.status}`;
    eventLog.update(row, { status: "error", ms, detail: msg });
    throw new LlmError(msg);
  }
  eventLog.update(row, {
    status: "ok",
    ms,
    detail: body.toolCalls.length ? `tool calls: ${body.toolCalls.map((c) => c.name).join(", ")}` : `reply: ${body.text.length} characters`,
  });
  return body;
}

export interface TurnDeps {
  system: string;
  tools: ToolDef[];
  model: string | null;
  runTool(call: ToolCall): Promise<ToolResult>;
  onToolStart(call: ToolCall): void;
}

export interface TurnOutcome {
  text: string;
  /** false when the loop ended without the model giving a final answer. */
  complete: boolean;
}

/** One user turn: model -> tools -> model, up to MAX_STEPS model calls. History is mutated in place. */
export async function runTurn(history: Msg[], userText: string, deps: TurnDeps): Promise<TurnOutcome> {
  history.push({ role: "user", text: userText });
  for (let step = 0; step < MAX_STEPS; step++) {
    const out = await complete(deps.system, history, deps.tools, deps.model);
    history.push({ role: "assistant", text: out.text, toolCalls: out.toolCalls });
    if (!out.toolCalls.length) return { text: out.text, complete: true };
    const results: ToolResult[] = [];
    for (const call of out.toolCalls) {
      deps.onToolStart(call);
      results.push(await deps.runTool(call));
    }
    history.push({ role: "tool", results });
  }
  return { text: "", complete: false };
}
