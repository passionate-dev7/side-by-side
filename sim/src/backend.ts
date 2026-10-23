import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { MCP_APPS_MIME, type McpConnection } from "./mcp";

export interface ResourceHtml {
  html: string;
  prefersBorder: boolean;
}

/** What the Echo Show client needs from a tool provider. The real implementation is the MCP client. */
export interface Backend {
  readonly kind: "mcp" | "dev";
  /** Passed to AppBridge so the view's tools/call and resources/read are forwarded to the server. */
  readonly client: Client | null;
  readonly tools: Tool[];
  callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
  readResource(uri: string): Promise<ResourceHtml>;
  close(): Promise<void>;
}

const TOOL_TIMEOUT_MS = 10 * 60_000; // a tool may wait on an elicitation form the family is filling in

export function mcpBackend(conn: McpConnection): Backend {
  return {
    kind: "mcp",
    client: conn.client,
    tools: conn.tools,
    async callTool(name, args) {
      return (await conn.client.callTool({ name, arguments: args }, undefined, { timeout: TOOL_TIMEOUT_MS })) as CallToolResult;
    },
    async readResource(uri) {
      const res = await conn.client.readResource({ uri });
      const item = res.contents[0];
      if (!item) throw new Error(`resources/read ${uri} returned no contents.`);
      if (item.mimeType && !item.mimeType.startsWith("text/html")) throw new Error(`${uri} has mimeType ${item.mimeType}, expected ${MCP_APPS_MIME}.`);
      const html = "text" in item && typeof item.text === "string" ? item.text : "blob" in item && typeof item.blob === "string" ? new TextDecoder().decode(Uint8Array.from(atob(item.blob), (c) => c.charCodeAt(0))) : null;
      if (html === null) throw new Error(`${uri} had neither text nor blob content.`);
      const ui = (item._meta as { ui?: { prefersBorder?: boolean } } | undefined)?.ui;
      return { html, prefersBorder: ui?.prefersBorder ?? true };
    },
    close: () => conn.close(),
  };
}
