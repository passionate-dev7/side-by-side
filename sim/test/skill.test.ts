import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { systemPrompt } from "../src/orchestrator";

const skill = readFileSync(new URL("../../skills/side-by-side/SKILL.md", import.meta.url), "utf8").replace(/^---[\s\S]*?---\n/, "");

describe("system prompt with the server's Agent Skill", () => {
  it("keeps the Echo Show persona and carries the skill's rules", () => {
    const p = systemPrompt("Friday, October 23, 2026", skill);
    expect(p).toMatch(/^You are Alexa\+ running on an Echo Show/);
    expect(p).toContain("Today is Friday, October 23, 2026.");
    expect(p).toContain("Nobody under 15 is placed in an exit row");
    expect(p).toContain("Every child aged 13 or under is seated directly beside an adult");
  });

  it("without a skill, the persona stands alone", () => {
    expect(systemPrompt("Friday, October 23, 2026")).not.toContain("exit row");
  });
});
