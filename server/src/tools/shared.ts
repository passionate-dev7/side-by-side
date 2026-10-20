import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { View } from "../domain.js";
import { ToolError, type Ctx, type Elicit } from "../service.js";

export const SEATS_UI_URI = "ui://side-by-side/seats.html";

/** Every product tool answers with a View in structuredContent and a spoken mirror in content. A tool never returns nothing. */
export function respond(view: View): CallToolResult {
  return {
    content: [{ type: "text", text: view.voice }],
    structuredContent: view as unknown as Record<string, unknown>,
    ...(view.kind === "error" ? { isError: true } : {}),
  };
}

export async function guarded(run: () => Promise<View> | View): Promise<CallToolResult> {
  try {
    return respond(await run());
  } catch (e) {
    if (e instanceof ToolError) return respond(e.view());
    console.error("tool failed:", e instanceof Error ? e.message : e);
    return respond({ kind: "error", code: "internal_error", message: "Something went wrong inside the add-on.", voice: "Something went wrong on my side. I have not changed anything." });
  }
}

/** Elicitation is only possible on a session whose client declared the capability. */
export function elicitorFor(server: McpServer): Elicit | null {
  if (!server.server.getClientCapabilities()?.elicitation) return null;
  return (message, properties, required) =>
    server.server.elicitInput({ message, requestedSchema: { type: "object", properties: properties as never, required } });
}

export type ToolModule = (server: McpServer, ctx: Ctx) => void;
