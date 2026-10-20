import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import express from "express";
import cors from "cors";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest, SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js";
import { createMcpServer, SERVER_INFO } from "./mcp.js";

export interface AppOptions {
  /** Extra browser origins allowed besides localhost, for example a tunnel hostname. */
  allowedOrigins?: string[];
  /** Log one line per MCP request with its latency (Alexa+ budget: 500 ms round trip). */
  log?: boolean;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function rpcError(res: Response, status: number, code: number, message: string) {
  res.status(status).json({ jsonrpc: "2.0", error: { code, message }, id: null });
}

export function createApp(opts: AppOptions = {}) {
  const extra = new Set(opts.allowedOrigins ?? []);
  const originAllowed = (origin: string) => {
    if (extra.has(origin)) return true;
    try {
      return LOCAL_HOSTS.has(new URL(origin).hostname);
    } catch {
      return false;
    }
  };

  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const app = express();

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", ...SERVER_INFO, protocolVersions: SUPPORTED_PROTOCOL_VERSIONS, sessions: sessions.size });
  });

  // Streamable HTTP spec: servers MUST validate Origin and answer 403 when it is not allowed.
  app.use("/mcp", (req, res, next) => {
    const origin = req.header("origin");
    if (origin && !originAllowed(origin)) return rpcError(res, 403, -32000, `Forbidden: origin ${origin} is not allowed`);
    next();
  });
  app.use(
    "/mcp",
    cors({
      origin: (origin, cb) => cb(null, !origin || originAllowed(origin)),
      allowedHeaders: ["content-type", "accept", "authorization", "mcp-session-id", "mcp-protocol-version", "last-event-id"],
      exposedHeaders: ["Mcp-Session-Id", "Mcp-Protocol-Version"],
      methods: ["GET", "POST", "DELETE", "OPTIONS"],
    }),
  );
  if (opts.log) {
    app.use("/mcp", (req, res, next) => {
      const t0 = performance.now();
      res.on("finish", () => console.log(`${req.method} /mcp ${res.statusCode} ${(performance.now() - t0).toFixed(1)}ms`));
      next();
    });
  }
  app.use("/mcp", express.json({ limit: "1mb" }));

  async function handlePost(req: Request, res: Response) {
    const sid = req.header("mcp-session-id");
    if (sid) {
      const transport = sessions.get(sid);
      if (!transport) return rpcError(res, 404, -32001, "Session not found");
      return transport.handleRequest(req, res, req.body);
    }
    if (isInitializeRequest(req.body)) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        onsessioninitialized: (id) => void sessions.set(id, transport),
      });
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };
      await createMcpServer().connect(transport);
      return transport.handleRequest(req, res, req.body);
    }
    // Alexa+ rebuilds context itself and does not hold an MCP session id, so a request
    // with no session header is served statelessly instead of rejected.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const server = createMcpServer();
    res.on("close", () => void transport.close().then(() => server.close()));
    await server.connect(transport);
    return transport.handleRequest(req, res, req.body);
  }

  app.post("/mcp", (req, res) => {
    handlePost(req, res).catch((err) => {
      console.error("mcp request failed:", err instanceof Error ? err.message : err);
      if (!res.headersSent) rpcError(res, 500, -32603, "Internal server error");
    });
  });

  const sessionOnly = (req: Request, res: Response) => {
    const transport = sessions.get(req.header("mcp-session-id") ?? "");
    if (!transport) {
      res.set("Allow", "POST").status(405).end();
      return;
    }
    transport.handleRequest(req, res).catch(() => !res.headersSent && rpcError(res, 500, -32603, "Internal server error"));
  };
  app.get("/mcp", sessionOnly);
  app.delete("/mcp", sessionOnly);

  return {
    app,
    sessions,
    async close() {
      await Promise.all([...sessions.values()].map((t) => t.close()));
    },
  };
}
