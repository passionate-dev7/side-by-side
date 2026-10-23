import { describe, expect, it } from "vitest";
import { wireSteps, type LogRow } from "../src/log";

let n = 0;
const row = (over: Partial<LogRow> & Pick<LogRow, "label">): LogRow => ({ id: ++n, at: 1000 + n, source: "mcp", status: "ok", ...over });

describe("wire steps: the handshake and every tool call", () => {
  const rows: LogRow[] = [
    row({ label: "connect", source: "sys", note: "http://127.0.0.1:8790/mcp" }),
    row({ label: "initialize", note: "protocol 2025-11-25", ms: 14 }),
    row({ label: "notifications/initialized" }),
    row({ label: "tools/list", note: "6 tools: save_family, find_family_flights", ms: 6 }),
    row({ label: "prompts/get", note: "Agent Skill loaded as the system prompt", ms: 3 }),
    row({ label: "POST /api/llm", source: "llm", ms: 900 }),
    row({ label: "tools/call", note: "save_family", ms: 9 }),
    row({ label: "tools/call", note: "book_together", ms: 4210, excluded: true }),
    row({ label: "tools/list", source: "sys", note: "not on the wire" }),
    row({ label: "resources/read", note: "ui://side-by-side/seats.html", ms: 3 }),
    row({ label: "tools/call", note: "find_family_flights", status: "pending" }),
  ];

  it("keeps initialize, initialized, tools/list and each tools/call in order with the protocol, tool count, tool name and latency", () => {
    const steps = wireSteps(rows);
    expect(steps.map((s) => [s.method, s.subject, s.ms])).toEqual([
      ["initialize", "protocol 2025-11-25", 14],
      ["notifications/initialized", "", undefined],
      ["tools/list", "6 tools: save_family, find_family_flights", 6],
      ["prompts/get", "Agent Skill loaded as the system prompt", 3],
      ["tools/call", "save_family", 9],
      ["tools/call", "book_together", 4210],
      ["tools/call", "find_family_flights", undefined],
    ]);
  });

  it("drops model calls, system rows and other MCP methods, and flags a call that includes a form wait and one still pending", () => {
    const steps = wireSteps(rows);
    expect(steps.some((s) => (s.method as string) === "resources/read" || (s.method as string) === "POST /api/llm" || (s.method as string) === "connect")).toBe(false);
    expect(steps.find((s) => s.subject === "book_together")!.formWait).toBe(true);
    expect(steps.find((s) => s.subject === "save_family")!.formWait).toBe(false);
    expect(steps.at(-1)!.status).toBe("pending");
  });

  it("an empty log has no steps, so a panel built on it shows the empty message and not a table of nothing", () => {
    expect(wireSteps([])).toEqual([]);
  });
});
