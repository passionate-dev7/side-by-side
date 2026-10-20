import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { register as registerWorldClock } from "./world-clock.js";

/** Product tools drop in here: each module exports register(server). */
export const toolModules: Array<(server: McpServer) => void> = [registerWorldClock];
