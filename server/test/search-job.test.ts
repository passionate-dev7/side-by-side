import { beforeEach, describe, expect, it } from "vitest";
import type { OffersView } from "../src/domain.js";
import { createCtx, findFamilyFlights, saveFamily, showSeats, type Ctx } from "../src/service.js";
import { openStore } from "../src/store.js";
import { FakeDuffel, NOW, SCENARIOS } from "./fixtures/fake-duffel.js";

const FAMILY = {
  travelers: [
    { name: "Dad", age: 40, gender: "m" as const, bornOn: "1986-03-02" },
    { name: "Mum", age: 38, gender: "f" as const, bornOn: "1988-07-19" },
    { name: "Mia", age: 6, gender: "f" as const, bornOn: "2020-05-11" },
    { name: "Leo", age: 9, gender: "m" as const, bornOn: "2017-01-30" },
  ],
  familyName: "Rivera",
  email: "family@example.com",
  phoneNumber: "+12125550123",
};
const SEARCH = { origin: "JFK", destination: "MCO", departureDate: "2026-11-25", cabin: "economy" as const };

let fake: FakeDuffel;
let ctx: Ctx;
let clock = NOW.getTime();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jobOf = () => [...ctx.searches.values()][0];

function setup(scenarios = SCENARIOS, parts: Partial<Ctx> = {}) {
  clock = NOW.getTime();
  fake = new FakeDuffel(scenarios);
  ctx = createCtx({ duffel: fake, store: openStore(":memory:"), now: () => new Date(clock), poll: { attempts: 3, delayMs: 1 }, ...parts });
  saveFamily(ctx, FAMILY);
}
beforeEach(() => setup());

describe("find_family_flights answers within the budget and finishes in the background", () => {
  it("slow seat maps: the first answer says it is still reading, a repeat joins the same search and returns the finished ranking", async () => {
    setup(SCENARIOS, { budgetMs: 15 });
    fake.delay.seatMaps = () => 200;
    const t0 = performance.now();
    const first = await findFamilyFlights(ctx, SEARCH);
    expect(performance.now() - t0).toBeLessThan(150);
    expect(first).toMatchObject({ status: "searching", offers: [], evaluated: 0, searched: 4, checking: { done: 0, of: 4 } });
    expect(first.voice).toMatch(/I found 4 direct fares and I am reading seat maps on the 4 cheapest/);
    expect(first.query).toEqual({ origin: "JFK", destination: "MCO", departure_date: "2026-11-25", cabin: "economy" });

    const again = await findFamilyFlights(ctx, SEARCH);
    expect(fake.calls.filter((c) => c === "searchOffers")).toHaveLength(1);
    await jobOf().done;
    const done = await findFamilyFlights(ctx, SEARCH);
    expect(done).toMatchObject({ status: "ready", evaluated: 4, checking: { done: 4, of: 4 } });
    expect(done.offers.map((o) => o.airline.iata)).toEqual(["B6", "DL", "NK", "UA"]);
    expect(again.status).toBe("searching");
    expect(fake.calls.filter((c) => c === "searchOffers")).toHaveLength(1);
  });

  it("partial answer: the offers that have priced are ranked and spoken, 'so far', before the rest land", async () => {
    setup(SCENARIOS, { budgetMs: 80 });
    fake.delay.seatMaps = (id) => (id === "off_jetblue" ? 5 : 500);
    const v = await findFamilyFlights(ctx, SEARCH);
    expect(v.status).toBe("searching");
    expect(v.offers.map((o) => o.airline.iata)).toEqual(["B6"]);
    expect(v.evaluated).toBe(1);
    expect(v.voice).toMatch(/^So far, JetBlue is the best way to sit together: \$812 total/);
    expect(v.voice).toMatch(/still reading seat maps, 1 of 4 done/);
    await jobOf().done;
    expect((await findFamilyFlights(ctx, SEARCH)).offers.map((o) => o.airline.iata)).toEqual(["B6", "DL", "NK", "UA"]);
  });

  it("seat map requests run in parallel under a cap", async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ ...SCENARIOS[1], id: `off_many_${i}`, fare: 700 + i }));
    setup(many, { seatMapConcurrency: 3, budgetMs: 2000 });
    fake.delay.seatMaps = () => 15;
    const v = await findFamilyFlights(ctx, SEARCH);
    expect(v).toMatchObject({ status: "ready", searched: 12, evaluated: 10 });
    expect(fake.peakSeatMaps).toBe(3);
    expect(fake.calls.filter((c) => c.startsWith("seatMaps:"))).toHaveLength(10);
  });

  it("a failed search is reported once and the next call starts a new one", async () => {
    setup([]);
    await expect(findFamilyFlights(ctx, SEARCH)).rejects.toMatchObject({ code: "no_offers" });
    expect(ctx.searches.size).toBe(0);
  });

  it("a failure that lands after the budget is raised by the next call", async () => {
    setup(SCENARIOS, { budgetMs: 5 });
    SCENARIOS.forEach((s) => fake.noSeatMap.add(s.id));
    fake.delay.seatMaps = () => 30;
    expect((await findFamilyFlights(ctx, SEARCH)).status).toBe("searching");
    await jobOf().done;
    await expect(findFamilyFlights(ctx, SEARCH)).rejects.toMatchObject({ code: "no_seat_maps" });
    expect(ctx.searches.size).toBe(0);
  });
});

describe("a cached seat map never prices an offer that has expired", () => {
  it("once the offer's expiry has passed, show_seats refuses and does not call the airline or price from the cache", async () => {
    await findFamilyFlights(ctx, SEARCH);
    expect((await showSeats(ctx, "off_delta")).togetherTotal).toBe(850);
    const calls = fake.calls.length;
    clock = new Date("2026-10-21T12:30:01Z").getTime();
    await expect(showSeats(ctx, "off_delta")).rejects.toMatchObject({ code: "offer_expired" });
    expect(fake.calls.length).toBe(calls);
  });

  it("the search itself is not reused after any of its offers expired: the same call searches again", async () => {
    await findFamilyFlights(ctx, SEARCH);
    await findFamilyFlights(ctx, SEARCH);
    expect(fake.calls.filter((c) => c === "searchOffers")).toHaveLength(1);
    clock = new Date("2026-10-21T12:30:01Z").getTime();
    fake.expiresAt = "2026-10-21T13:30:00Z";
    const later: OffersView = await findFamilyFlights(ctx, SEARCH);
    expect(fake.calls.filter((c) => c === "searchOffers")).toHaveLength(2);
    expect(later.status).toBe("ready");
  });

  it("a search that is still inside its TTL is not reused once its offers expired", async () => {
    fake.expiresAt = "2026-10-21T12:01:00Z";
    await findFamilyFlights(ctx, SEARCH);
    clock += 90_000;
    fake.expiresAt = "2026-10-21T13:00:00Z";
    await findFamilyFlights(ctx, SEARCH);
    expect(fake.calls.filter((c) => c === "searchOffers")).toHaveLength(2);
  });

  it("a map older than the TTL but with a live offer is read again, not trusted", async () => {
    await findFamilyFlights(ctx, SEARCH);
    await showSeats(ctx, "off_delta");
    const reads = () => fake.calls.filter((c) => c === "seatMaps:off_delta").length;
    expect(reads()).toBe(1);
    clock += 4 * 60_000;
    await showSeats(ctx, "off_delta");
    expect(reads()).toBe(1);
    clock += 2 * 60_000;
    await showSeats(ctx, "off_delta");
    expect(reads()).toBe(2);
  });

  it("a finished search is reused inside its TTL and replaced after it", async () => {
    await findFamilyFlights(ctx, SEARCH);
    clock += 119_000;
    await findFamilyFlights(ctx, SEARCH);
    expect(fake.calls.filter((c) => c === "searchOffers")).toHaveLength(1);
    clock += 2_000;
    await findFamilyFlights(ctx, SEARCH);
    expect(fake.calls.filter((c) => c === "searchOffers")).toHaveLength(2);
  });
});
