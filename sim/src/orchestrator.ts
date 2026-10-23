import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { LlmResponse, Msg, ToolCall, ToolDef, ToolResult } from "../server/llm";
import { eventLog } from "./log";
import { textOf, visibleToModel } from "./mcp";
import { speakable } from "./speakable";

export const MAX_STEPS = 6;

/** The device persona, then the connected server's Agent Skill when it serves one. */
export function systemPrompt(today: string, skill: string | null = null): string {
  const persona = [
    "You are Alexa+ running on an Echo Show in a family's kitchen. A parent is talking to you.",
    "Speak in short, plain sentences. Your words are read aloud, so use no markdown, no lists, no symbols and no emoji.",
    "Call a tool for anything about flights, seats, prices, bookings, the family or the time. Never guess.",
    "The family may already be saved from an earlier conversation. For a flight request, call find_family_flights first: it reports when no family is saved, and only then ask who is traveling.",
    "Never invent prices, seats, flight numbers, airlines or booking references. Say only what a tool result contains.",
    "When you quote a price, quote the together total, which is the fare plus any seat fees, and name the airline it belongs to.",
    "When a tool puts a screen on the display, say one short sentence about what it shows and offer the next step.",
    "If a tool reports a problem, tell the parent plainly what went wrong.",
    "Some tools answer with a state that says they are still working, such as reading seat maps or confirming a booking. The screen updates itself. When the parent later asks about that work, call the same tool again first and answer from the finished result.",
    `Today is ${today}.`,
  ].join(" ");
  return skill ? `${persona}\n\nThe connected server's skill. Follow it:\n\n${skill}` : persona;
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

/** A tool answer whose work outlives the call: the flight search and the booking report these while they run. */
export function isPending(result: CallToolResult): boolean {
  const status = (result.structuredContent as { status?: unknown } | undefined)?.status;
  return status === "searching" || status === "booking";
}

/**
 * The view polls a tool until its work is done, and the model never sees those polls. When the finished answer
 * arrives, it replaces the newest stale "still working" result for that tool, so the next turn reasons from
 * what the screen shows instead of from "no offers yet". Returns whether a stale result was replaced.
 */
export function settlePending(history: Msg[], name: string, result: CallToolResult): boolean {
  if (isPending(result)) return false;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role !== "tool") continue;
    const stale = m.results.find((r) => r.name === name && r.pending);
    if (stale) {
      stale.text = modelTextOf(result);
      stale.pending = undefined;
      return true;
    }
  }
  return false;
}

export class LlmError extends Error {}

async function complete(system: string, messages: Msg[], tools: ToolDef[], model: string | null): Promise<LlmResponse> {
  const row = eventLog.add({ source: "llm", label: "POST /api/llm", note: model ?? undefined });
  const t0 = performance.now();
  let res: Response;
  try {
    res = await fetch("/api/llm", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ system, messages, tools }) });
  } catch (e) {
    const msg = `Could not reach the Echo Show client's LLM proxy: ${e instanceof Error ? e.message : String(e)}`;
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
    const raw = await complete(deps.system, history, deps.tools, deps.model);
    const out = { ...raw, text: speakable(raw.text) };
    history.push({ role: "assistant", text: out.text, toolCalls: out.toolCalls });
    if (!out.toolCalls.length) return { text: out.text, complete: true };
    const results: ToolResult[] = [];
    for (const call of out.toolCalls) {
      deps.onToolStart(call);
      results.push(await deps.runTool(call));
    }
    history.push({ role: "tool", results });
    const waiting = results.find((r) => r.pending);
    if (waiting) {
      const text = speakable(waiting.pending!);
      history.push({ role: "assistant", text, toolCalls: [] });
      return { text, complete: true };
    }
  }
  return { text: "", complete: false };
}
