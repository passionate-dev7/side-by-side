import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { bookTogether, createCtx, findFamilyFlights, saveFamily, showSeats, stillTogether } from "../src/service.js";
import { openStore } from "../src/store.js";
import { FakeDuffel, NOW } from "./fixtures/fake-duffel.js";
import { mountFixtureRoutes } from "./fixtures/fixture-routes.js";

const fake = new FakeDuffel();
const ctx = createCtx({ duffel: fake, store: openStore(":memory:"), now: () => NOW, poll: { attempts: 3, delayMs: 1 } });
let server: ReturnType<ReturnType<typeof createApp>["app"]["listen"]>;
let base = "";

beforeAll(async () => {
  const { app } = createApp(ctx);
  mountFixtureRoutes(app, ctx, fake);
  await new Promise<void>((ok) => (server = app.listen(0, "127.0.0.1", () => ok())));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise((ok) => server.close(ok)));

const post = (body: unknown) => fetch(`${base}/fixture/airline-moves-seat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("fixture airline control (emulator only)", () => {
  it("says it is an emulator", async () => {
    expect(await (await fetch(`${base}/fixture`)).json()).toMatchObject({ fixture: true, emulator: "FakeDuffel" });
  });

  it("refuses before there is an order, then moves Mia and still_together reports her", async () => {
    expect((await post({ traveler: "Mia", seat: "30F" })).status).toBe(409);
    saveFamily(ctx, {
      travelers: [
        { name: "Dad", age: 40, gender: "m", bornOn: "1986-03-02" }, { name: "Mum", age: 38, gender: "f", bornOn: "1988-07-19" },
        { name: "Mia", age: 6, gender: "f", bornOn: "2020-05-11" }, { name: "Leo", age: 9, gender: "m", bornOn: "2017-01-30" },
      ],
      familyName: "Rivera", email: "family@example.com", phoneNumber: "+12125550123",
    });
    await findFamilyFlights(ctx, { origin: "JFK", destination: "MCO", departureDate: "2026-11-25", cabin: "economy" });
    await showSeats(ctx, "off_delta");
    await bookTogether(ctx, { offerId: "off_delta", confirmed: true }, null);
    expect((await stillTogether(ctx)).together).toBe(true);

    expect((await post({ traveler: "Grandma", seat: "30F" })).status).toBe(400);
    expect((await post({ traveler: "Mia", seat: "nope" })).status).toBe(400);
    const ok = await post({ traveler: "mia", seat: "30f" });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ moved: "Mia", to: "30F" });

    const s = await stillTogether(ctx);
    expect(s.together).toBe(false);
    expect(s.affected.map((a) => a.name)).toEqual(["Mia"]);
  });

  it("with no body it moves the first child to 30F", async () => {
    const r = await post({});
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ moved: "Mia", to: "30F" });
  });
});
