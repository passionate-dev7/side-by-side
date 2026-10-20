// FIXTURE SERVER. Real product tools and real MCP transport, backed by the strict in-memory Duffel stand-in
// from test/fixtures. For UI work and demos without a Duffel token. The product server (src/index.ts) never imports this.
import { createApp } from "../src/app.js";
import { createCtx } from "../src/service.js";
import { openStore } from "../src/store.js";
import { FakeDuffel } from "../test/fixtures/fake-duffel.js";

const port = Number(process.env.PORT ?? 8787);
const ctx = createCtx({ duffel: new FakeDuffel(), store: openStore(":memory:"), poll: { attempts: 5, delayMs: 300 } });
const { app } = createApp(ctx, { log: true, allowedOrigins: (process.env.ALLOWED_ORIGINS ?? "").split(",").filter(Boolean) });
app.listen(port, "127.0.0.1", () => console.log(`FIXTURE MCP server on http://127.0.0.1:${port}/mcp (fake Duffel, in-memory state, offers JetBlue/Delta/United/Duffel Airways)`));
