import { afterEach, describe, expect, it, vi } from "vitest";
import { isPending, runTurn, settlePending } from "../src/orchestrator";
import { speakable } from "../src/speakable";
import type { Msg } from "../server/llm";

describe("speakable: markdown never reaches the speaker or the caption", () => {
  const cases: Array<[string, string, string]> = [
    ["bold", "**JetBlue** seats you for **$812**.", "JetBlue seats you for $812."],
    ["bullets become sentences", "Here are your seats:\n- Dad 14A\n- Mia 14B\n\nTotal is $812.", "Here are your seats: Dad 14A. Mia 14B. Total is $812."],
    ["numbered lists and headings", "## Flights\n1. JetBlue $812\n2) Delta $850", "Flights JetBlue $812. Delta $850."],
    ["a table", "| Airline | Total |\n|---|---|\n| JetBlue | $812 |", "Airline, Total JetBlue, $812"],
    ["links, code, italics, strikethrough", "See [the dashboard](https://www.transportation.gov/x) for `DL` *only* and ~~never~~ _always_.", "See the dashboard for DL only and never always."],
    ["emoji", "Booked ✈️ and done 🎉", "Booked and done"],
    ["a fenced block", "Try:\n```\nsave_family\n```\nDone.", "Try: save_family Done."],
    ["escapes", "Price is \\$812 \\* total", "Price is $812 * total"],
    ["a rule and a quote", "> Sit together\n---\nYes.", "Sit together Yes."],
  ];
  for (const [name, input, expected] of cases) it(name, () => expect(speakable(input)).toBe(expected));

  it("leaves a clean reply exactly as it was, including snake_case names, prices and apostrophes", () => {
    for (const clean of [
      "JetBlue seats your family together for $812, 52 more than the cheapest fare.",
      "Mia's seat is 14B. Say save_family to start over.",
      "Tools save_family and find_family_flights keep their underscores.",
      "Dad 14A, Mum 22D, Mia 14B, Leo 22E. Total $850.",
      "A * B is not emphasis when it has spaces",
    ]) expect(speakable(clean)).toBe(clean);
  });

  it("is idempotent and total: empty, only markup, and already-clean text", () => {
    expect(speakable("")).toBe("");
    expect(speakable("---")).toBe("");
    expect(speakable("**")).toBe("**");
    for (const [, input] of cases) expect(speakable(speakable(input))).toBe(speakable(input));
  });

  it("no output of the sample set contains a markdown marker", () => {
    expect(cases.length).toBeGreaterThan(5);
    for (const [, input] of cases) expect(speakable(input)).not.toMatch(/\*\*|__|`|^#|\]\(|^\s*[-*]\s|\|/m);
  });
});

describe("runTurn speaks and records the stripped reply", () => {
  afterEach(() => vi.unstubAllGlobals());
  const stubLlm = (...replies: Array<{ text: string; toolCalls: unknown[] }>) => {
    const queue = [...replies];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(queue.shift()), { status: 200, headers: { "content-type": "application/json" } })));
  };
  const deps = { system: "s", tools: [], model: null, onToolStart: () => undefined, runTool: async () => ({ id: "1", name: "x", text: "", isError: false }) };

  it("a markdown final answer comes back as plain sentences, and so does the model's own history", async () => {
    stubLlm({ text: "**Yes.** Your seats:\n- Mia 14B\n- Leo 22E", toolCalls: [] });
    const history: Msg[] = [];
    const out = await runTurn(history, "are we together", deps);
    expect(out).toEqual({ text: "Yes. Your seats: Mia 14B. Leo 22E.", complete: true });
    expect(history.at(-1)).toMatchObject({ role: "assistant", text: "Yes. Your seats: Mia 14B. Leo 22E." });
  });

  it("the answer after a tool call is stripped too", async () => {
    stubLlm({ text: "", toolCalls: [{ id: "1", name: "still_together", arguments: {} }] }, { text: "## Result\n**Not together.** Mia is in `30F`.", toolCalls: [] });
    const out = await runTurn([], "are we together", deps);
    expect(out.text).toBe("Result Not together. Mia is in 30F.");
  });
});

describe("work that outlives a call", () => {
  afterEach(() => vi.unstubAllGlobals());
  const searching = { structuredContent: { kind: "offers", status: "searching", offers: [] }, content: [{ type: "text" as const, text: "I am searching." }] };
  const ready = { structuredContent: { kind: "offers", status: "ready", offers: [{ offerId: "off_1" }] }, content: [{ type: "text" as const, text: "Duffel Airways is best." }] };

  it("a searching answer ends the turn on the tool's spoken line and never polls the model again", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ text: "", toolCalls: [{ id: "1", name: "find_family_flights", arguments: {} }] }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const runTool = async () => ({ id: "1", name: "find_family_flights", text: "x", isError: false, pending: "I am searching. The screen fills in." });
    const out = await runTurn([], "find flights", { system: "s", tools: [], model: null, onToolStart: () => undefined, runTool });
    expect(out).toEqual({ text: "I am searching. The screen fills in.", complete: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("the finished answer replaces the stale searching result in the model's history", () => {
    expect(isPending(searching)).toBe(true);
    expect(isPending(ready)).toBe(false);
    const history: Msg[] = [
      { role: "user", text: "find flights" },
      { role: "tool", results: [{ id: "1", name: "find_family_flights", text: "I am searching.", isError: false, pending: "I am searching." }] },
    ];
    expect(settlePending(history, "find_family_flights", searching)).toBe(false);
    expect((history[1] as { results: Array<{ text: string }> }).results[0].text).toBe("I am searching.");
    expect(settlePending(history, "find_family_flights", ready)).toBe(true);
    expect(settlePending(history, "find_family_flights", ready)).toBe(false);
    const r = (history[1] as { results: Array<{ text: string; pending?: string }> }).results[0];
    expect(r.text).toContain("off_1");
    expect(r.pending).toBeUndefined();
  });
});
