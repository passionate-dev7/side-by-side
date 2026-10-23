import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Ctx } from "./service.js";
import { toolModules } from "./tools/index.js";

export const SERVER_INFO = { name: "side-by-side", version: "0.1.0" };

/** The Agent Skill, read once at startup: the frontmatter's name and description, and the body a host loads as instructions. */
export function readSkill(path = fileURLToPath(new URL("../../skills/side-by-side/SKILL.md", import.meta.url))): { name: string; description: string; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(readFileSync(path, "utf8"));
  if (!m) throw new Error(`${path} has no frontmatter.`);
  const field = (k: string) => new RegExp(`^${k}:\\s*(.+)$`, "m").exec(m[1])?.[1].trim();
  const name = field("name");
  const description = field("description");
  if (!name || !description) throw new Error(`${path} frontmatter needs name and description.`);
  return { name, description, body: m[2].trim() };
}

export const SKILL = readSkill();

/** One McpServer per session. Tools and UI resources come from ./tools; the Agent Skill is served as a prompt. */
export function createMcpServer(ctx: Ctx): McpServer {
  const server = new McpServer(SERVER_INFO);
  for (const register of toolModules) register(server, ctx);
  server.registerPrompt(SKILL.name, { title: "Side by Side", description: SKILL.description }, () => ({
    description: SKILL.description,
    messages: [{ role: "user", content: { type: "text", text: SKILL.body } }],
  }));
  return server;
}
