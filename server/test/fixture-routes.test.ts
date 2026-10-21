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

describe("fee-free booking: the airline assigns seats, then moves a child", () => {
  const f2 = new FakeDuffel();
  const c2 = createCtx({ duffel: f2, store: openStore(":memory:"), now: () => NOW, poll: { attempts: 3, delayMs: 1 } });
  let s2: typeof server;
  let b2 = "";
  beforeAll(async () => {
    const { app } = createApp(c2);
    mountFixtureRoutes(app, c2, f2);
    await new Promise<void>((ok) => (s2 = app.listen(0, "127.0.0.1", () => ok())));
    b2 = `http://127.0.0.1:${(s2.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise((ok) => s2.close(ok)));
  const hit = (path: string, body: unknown = {}) => fetch(`${b2}/fixture/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("assigning seats is not a change; the assigned seats become the baseline; a later move is reported against them", async () => {
    saveFamily(c2, {
      travelers: [
        { name: "Dad", age: 40, gender: "m", bornOn: "1986-03-02" }, { name: "Mum", age: 38, gender: "f", bornOn: "1988-07-19" },
        { name: "Mia", age: 6, gender: "f", bornOn: "2020-05-11" }, { name: "Leo", age: 9, gender: "m", bornOn: "2017-01-30" },
      ],
      familyName: "Rivera", email: "family@example.com", phoneNumber: "+12125550123",
    });
    await findFamilyFlights(c2, { origin: "JFK", destination: "MCO", departureDate: "2026-11-25", cabin: "economy" });
    await showSeats(c2, "off_jetblue");
    const booked = await bookTogether(c2, { offerId: "off_jetblue", confirmed: true }, null);
    expect(booked.strategy).toBe("airline-guarantee");

    expect((await stillTogether(c2)).voice).toMatch(/has not assigned seats yet/);
    expect((await hit("airline-moves-seat", { traveler: "Grandma" })).status).toBe(400);
    const assigned = await hit("airline-assigns-seats");
    expect(assigned.status).toBe(200);
    expect((await hit("airline-assigns-seats")).status).toBe(409);

    const yes = await stillTogether(c2);
    expect(yes).toMatchObject({ together: true, changes: [], affected: [] });
    expect(yes.voice).toMatch(/^Yes\./);
    const mia = yes.seats.find((s) => s.name === "Mia")!.seat!;
    expect(c2.store.latestOrder("default")!.seats.mia).toBe(mia);

    const moved = await hit("airline-moves-seat", { traveler: "Mia", seat: "30F" });
    expect(await moved.json()).toMatchObject({ moved: "Mia", from: mia, to: "30F" });
    const no = await stillTogether(c2);
    expect(no.together).toBe(false);
    expect(no.changes).toEqual([{ name: "Mia", from: mia, to: "30F", via: ["order", "airline-change"] }]);
    expect(no.affected.map((a) => [a.name, a.from, a.seat])).toEqual([["Mia", mia, "30F"]]);
  });

  it("the move route seats the family first when the airline has not, so one click after booking works", async () => {
    const f3 = new FakeDuffel();
    const c3 = createCtx({ duffel: f3, store: openStore(":memory:"), now: () => NOW, poll: { attempts: 3, delayMs: 1 } });
    const { app } = createApp(c3);
    mountFixtureRoutes(app, c3, f3);
    const srv = await new Promise<typeof server>((ok) => { const s = app.listen(0, "127.0.0.1", () => ok(s)); });
    try {
      saveFamily(c3, { travelers: [{ name: "Dad", age: 40, gender: "m", bornOn: "1986-03-02" }, { name: "Mia", age: 6, gender: "f", bornOn: "2020-05-11" }], familyName: "Rivera", email: "family@example.com", phoneNumber: "+12125550123" });
      await findFamilyFlights(c3, { origin: "JFK", destination: "MCO", departureDate: "2026-11-25", cabin: "economy" });
      await showSeats(c3, "off_jetblue");
      await bookTogether(c3, { offerId: "off_jetblue", confirmed: true }, null);
      const r = await fetch(`http://127.0.0.1:${(srv.address() as AddressInfo).port}/fixture/airline-moves-seat`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      expect(await r.json()).toMatchObject({ moved: "Mia", to: "30F" });
      const s = await stillTogether(c3);
      expect(s.affected.map((a) => a.name)).toEqual(["Mia"]);
      expect(s.voice).toMatch(/^No\. Mia is in 30F, not beside an adult\./);
    } finally {
      await new Promise((ok) => srv.close(ok));
    }
  });
});
