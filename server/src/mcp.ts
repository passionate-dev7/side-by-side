import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toolModules } from "./tools/index.js";

export const SERVER_INFO = { name: "alexa-mcp-base", version: "0.1.0" };

/** One McpServer per session. Tools and UI resources come from ./tools. */
export function createMcpServer(): McpServer {
  const server = new McpServer(SERVER_INFO);
  for (const register of toolModules) register(server);
  return server;
}
