// FIXTURE SERVER. Real product tools and real MCP transport, backed by the strict in-memory Duffel stand-in
// from test/fixtures. For UI work and demos without a Duffel token. The product server (src/index.ts) never imports this.
import { createApp } from "../src/app.js";
import { createFixtureCtx } from "../test/fixtures/fixture-ctx.js";
import { mountFixtureRoutes } from "../test/fixtures/fixture-routes.js";

const port = Number(process.env.PORT ?? 8790);
const { ctx, fake } = createFixtureCtx();
// FIXTURE_DELAY_MS gives every airline call that much network time, to watch the screens fill in as seat maps land.
const wait = Number(process.env.FIXTURE_DELAY_MS ?? 0);
if (wait > 0) fake.delay = { search: wait, order: wait, seatMaps: () => wait };
const { app } = createApp(ctx, { log: true, allowedOrigins: (process.env.ALLOWED_ORIGINS ?? "").split(",").filter(Boolean) });
mountFixtureRoutes(app, ctx, fake);
app.listen(port, "127.0.0.1", () => console.log(`FIXTURE MCP server on http://127.0.0.1:${port}/mcp (fake Duffel, in-memory state, offers JetBlue/Delta/United/Spirit; airline control at /fixture)`));
