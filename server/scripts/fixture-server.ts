// FIXTURE SERVER. Real product tools and real MCP transport, backed by the strict in-memory Duffel stand-in
// from test/fixtures. For UI work and demos without a Duffel token. The product server (src/index.ts) never imports this.
import { createApp } from "../src/app.js";
import { createCtx } from "../src/service.js";
import { openStore } from "../src/store.js";
import { FakeDuffel } from "../test/fixtures/fake-duffel.js";
import { mountFixtureRoutes } from "../test/fixtures/fixture-routes.js";

const port = Number(process.env.PORT ?? 8790);
const fake = new FakeDuffel();
const ctx = createCtx({ duffel: fake, store: openStore(":memory:"), poll: { attempts: 5, delayMs: 300 } });
const { app } = createApp(ctx, { log: true, allowedOrigins: (process.env.ALLOWED_ORIGINS ?? "").split(",").filter(Boolean) });
mountFixtureRoutes(app, ctx, fake);
app.listen(port, "127.0.0.1", () => console.log(`FIXTURE MCP server on http://127.0.0.1:${port}/mcp (fake Duffel, in-memory state, offers JetBlue/Delta/United/Duffel Airways; airline control at /fixture)`));
