import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Ctx } from "./service.js";
import { toolModules } from "./tools/index.js";

export const SERVER_INFO = { name: "side-by-side", version: "0.1.0" };

/** One McpServer per session. Tools and UI resources come from ./tools. */
export function createMcpServer(ctx: Ctx): McpServer {
  const server = new McpServer(SERVER_INFO);
  for (const register of toolModules) register(server, ctx);
  return server;
}
