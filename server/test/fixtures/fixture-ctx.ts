import { createCtx, type Ctx } from "../../src/service.js";
import { openStore } from "../../src/store.js";
import { FakeDuffel } from "./fake-duffel.js";

/** FIXTURE ONLY. The wiring `npm run fixture` serves: the emulator and the product share one clock, the real one unless a test pins it. */
export function createFixtureCtx(now: () => Date = () => new Date()): { ctx: Ctx; fake: FakeDuffel } {
  const fake = new FakeDuffel(undefined, now);
  const ctx = createCtx({ duffel: fake, store: openStore(":memory:"), now, poll: { attempts: 5, delayMs: 300 } });
  return { ctx, fake };
}
