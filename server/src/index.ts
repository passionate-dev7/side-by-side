import { createApp } from "./app.js";

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "127.0.0.1";
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);

const { app } = createApp({ allowedOrigins, log: true });
app.listen(port, host, () => console.log(`MCP server on http://${host}:${port}/mcp (health: /health)`));
