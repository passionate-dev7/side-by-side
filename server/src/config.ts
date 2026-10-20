import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createDuffelPort } from "./duffel.js";
import { createCtx, type Ctx } from "./service.js";
import { openStore } from "./store.js";

/** Reads configuration by env var NAME. The Duffel token value is passed straight to the SDK and never logged. */
export function ctxFromEnv(env: NodeJS.ProcessEnv = process.env): Ctx {
  const path = env.STORE_PATH ?? "data/side-by-side.db";
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const token = env.DUFFEL_ACCESS_TOKEN;
  return createCtx({
    duffel: token ? createDuffelPort(token, env.DUFFEL_BASE_URL) : null,
    store: openStore(path),
  });
}
