import { beforeEach, describe, expect, it } from "vitest";
import type { BookedView, StatusView } from "../src/domain.js";
import { bookTogether, checkTrip, createCtx, findFamilyFlights, saveFamily, showSeats, stillTogether, type Ctx, type Elicit } from "../src/service.js";
import { openStore } from "../src/store.js";
import { FakeDuffel, NOW } from "./fixtures/fake-duffel.js";

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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let fake: FakeDuffel;
let ctx: Ctx;
const noAsking: Elicit = async () => {
  throw new Error("a repeat must not ask the family again");
};

beforeEach(async () => {
  fake = new FakeDuffel();
  ctx = createCtx({ duffel: fake, store: openStore(":memory:"), now: () => NOW, poll: { attempts: 3, delayMs: 1 }, budgetMs: 15 });
  saveFamily(ctx, FAMILY);
  await findFamilyFlights(ctx, SEARCH);
  await showSeats(ctx, "off_delta");
});

const job = (offerId = "off_delta") => ctx.bookings.get(offerId)!;

describe("book_together answers with the booking state and finishes the order in the background", () => {
  it("a slow airline: the call returns the booking within the budget, the repeat returns the reference, and one order is placed", async () => {
    fake.delay.order = 80;
    const t0 = performance.now();
    const first = await bookTogether(ctx, { offerId: "off_delta", confirmed: true }, null);
    expect(performance.now() - t0).toBeLessThan(70);
    expect(first).toMatchObject({ kind: "booked", status: "booking", orderId: null, bookingReference: null, strategy: "seat-services", total: 850, offerId: "off_delta" });
    expect(first.seats.every((s) => s.seat)).toBe(true);
    expect(first.voice).toMatch(/^I am booking Delta DL101 for \$850 now/);
    expect(ctx.store.latestOrder("default")).toBeNull();

    const during = await bookTogether(ctx, { offerId: "off_delta", confirmed: false }, noAsking);
    expect(during.status).toBe("booking");

    await job().done;
    const after = await bookTogether(ctx, { offerId: "off_delta", confirmed: false }, noAsking);
    expect(after).toMatchObject({ status: "confirmed", bookingReference: "FXT4KQ", total: 850 });
    expect(after.orderId).toBe(fake.orders.keys().next().value);
    expect(fake.calls.filter((c) => c === "createOrder")).toHaveLength(1);
    expect(ctx.store.latestOrder("default")).toMatchObject({ bookingReference: "FXT4KQ" });
    expect(ctx.store.getOrder("default", "fxt4kq")?.orderId).toBe(after.orderId);
    expect(ctx.store.getOrder("default", "ZZZZZZ")).toBeNull();
  });

  it("saving the family again starts a fresh trip: finished bookings and searches are forgotten, a booking in flight is not", async () => {
    await bookTogether(ctx, { offerId: "off_delta", confirmed: true }, null);
    expect(ctx.bookings.size).toBe(1);
    expect(ctx.searches.size).toBe(1);
    saveFamily(ctx, FAMILY);
    expect(ctx.bookings.size).toBe(0);
    expect(ctx.searches.size).toBe(0);
    fake.delay.order = 80;
    await findFamilyFlights(ctx, SEARCH);
    await showSeats(ctx, "off_jetblue");
    await bookTogether(ctx, { offerId: "off_jetblue", confirmed: true }, null);
    expect(job("off_jetblue").status).toBe("booking");
    saveFamily(ctx, FAMILY);
    expect(ctx.bookings.size).toBe(1);
    await job("off_jetblue").done;
  });

  it("a fast airline answers with the confirmed booking in the same call", async () => {
    const v = await bookTogether(ctx, { offerId: "off_delta", confirmed: true }, null);
    expect(v).toMatchObject({ status: "confirmed", bookingReference: "FXT4KQ" });
  });

  it("a seat sold after the family said yes fails the booking in the background; it is reported once and no order exists", async () => {
    fake.delay.seatMaps = () => 40;
    const first = await bookTogether(ctx, { offerId: "off_delta", confirmed: true }, null);
    expect(first.status).toBe("booking");
    const seat = ctx.store.getPlan("default", "off_delta")!.assignments.mia;
    for (const cabin of fake.offers.get("off_delta")!.map.cabins)
      for (const r of cabin.rows) for (const s of r.sections) for (const el of s.elements) if (el.type === "seat" && el.designator === seat) el.available_services = [];
    await job().done;
    await expect(bookTogether(ctx, { offerId: "off_delta", confirmed: false }, null)).rejects.toMatchObject({ code: "no_adjacent_seats" });
    expect(fake.orders.size).toBe(0);
    expect(fake.calls).not.toContain("createOrder");
  });

  it("a total that moved after the family agreed is never charged", async () => {
    fake.delay.seatMaps = () => 40;
    const first = await bookTogether(ctx, { offerId: "off_delta", confirmed: true }, null);
    expect(first).toMatchObject({ status: "booking", total: 850 });
    const seats = Object.values(ctx.store.getPlan("default", "off_delta")!.assignments);
    for (const cabin of fake.offers.get("off_delta")!.map.cabins)
      for (const r of cabin.rows) for (const s of r.sections) for (const el of s.elements) if (el.type === "seat" && seats.includes(el.designator)) for (const svc of el.available_services) svc.total_amount = "60.00";
    await job().done;
    const err = await bookTogether(ctx, { offerId: "off_delta", confirmed: false }, null).catch((e) => e);
    expect(err).toMatchObject({ code: "price_changed" });
    expect(err.voice).toMatch(/The price moved from \$850 to \$1,?[0-9]{3}/);
    expect(fake.orders.size).toBe(0);
  });

  it("an order the airline accepted but has not confirmed is resumed on retry, never placed twice", async () => {
    fake.confirmAfterPolls = 999;
    await expect(bookTogether(ctx, { offerId: "off_delta", confirmed: true }, null)).rejects.toMatchObject({ code: "order_pending" });
    expect(fake.orders.size).toBe(1);
    const [id, order] = [...fake.orders.entries()][0];
    order.confirmAfterPolls = 1;
    const v = await bookTogether(ctx, { offerId: "off_delta", confirmed: true }, null);
    expect(v).toMatchObject({ status: "confirmed", orderId: id, bookingReference: "FXT4KQ" });
    expect(fake.calls.filter((c) => c === "createOrder")).toHaveLength(1);
  });

  it("a failure that was reported lets the next call start a new attempt, and the airline's refusal places no order", async () => {
    fake.expired.add("off_delta");
    await expect(bookTogether(ctx, { offerId: "off_delta", confirmed: true }, null)).rejects.toMatchObject({ code: "offer_expired" });
    expect(fake.orders.size).toBe(0);
    fake.expired.delete("off_delta");
    const v = await bookTogether(ctx, { offerId: "off_delta", confirmed: true }, null);
    expect(v).toMatchObject({ status: "confirmed", bookingReference: "FXT4KQ" });
    expect(fake.calls.filter((c) => c === "createOrder")).toHaveLength(2);
    expect(fake.orders.size).toBe(1);
  });
});

describe("still_together serves the last reading while a fresh one is read", () => {
  async function booked(): Promise<BookedView> {
    const v = await bookTogether(ctx, { offerId: "off_delta", confirmed: true }, null);
    await stillTogether(ctx);
    return v;
  }

  it("slow airline: the answer is the last reading marked as refreshing, then the next call has the fresh one", async () => {
    const b = await booked();
    ctx.now = () => new Date(NOW.getTime() + 4000);
    const mia = ctx.store.getOrder("default", b.orderId!)!.passengerIds.mia;
    fake.airlineMovesSeat(b.orderId!, mia, "30F");
    fake.delay.order = 60;
    const t0 = performance.now();
    const stale = (await checkTrip(ctx)) as StatusView;
    expect(performance.now() - t0).toBeLessThan(55);
    expect(stale).toMatchObject({ kind: "together-status", refreshing: true, together: true });
    expect(stale.voice).toMatch(/^As of \d+ seconds ago: Yes\./);
    expect(stale.voice).toMatch(/I am checking again\.$/);

    await ctx.refreshing.get(b.orderId!);
    const fresh = (await checkTrip(ctx)) as StatusView;
    expect(fresh).toMatchObject({ refreshing: false, together: false });
    expect(fresh.affected.map((a) => a.name)).toEqual(["Mia"]);
  });

  it("calls made while a reading is under way share it: one read of the order, not one per call", async () => {
    const b = await booked();
    ctx.now = () => new Date(NOW.getTime() + 4000);
    fake.delay.order = 60;
    const before = fake.calls.filter((c) => c.startsWith("getOrder")).length;
    await Promise.all([checkTrip(ctx), checkTrip(ctx), checkTrip(ctx)]);
    await ctx.refreshing.get(b.orderId!);
    expect(fake.calls.filter((c) => c.startsWith("getOrder")).length - before).toBe(1);
  });

  it("no earlier reading: the answer is what the booking says, marked as refreshing, and the reading still lands", async () => {
    const b = await bookTogether(ctx, { offerId: "off_delta", confirmed: true }, null);
    fake.delay.order = 60;
    const v = (await checkTrip(ctx)) as StatusView;
    expect(v).toMatchObject({ refreshing: true, together: true, bookingReference: "FXT4KQ" });
    expect(v.voice).toMatch(/^You booked Dad \S+, Mum \S+, Mia \S+, Leo \S+\. I am checking with Delta/);
    await ctx.refreshing.get(b.orderId!);
    expect(((await checkTrip(ctx)) as StatusView).refreshing).toBe(false);
  });

  it("a reading that fails is not cached and the next call tries again", async () => {
    const b = await booked();
    const saved = [...fake.orders];
    fake.orders.clear();
    ctx.statusCache.clear();
    await expect(checkTrip(ctx)).rejects.toMatchObject({ code: "duffel_error" });
    expect(ctx.statusCache.size).toBe(0);
    saved.forEach(([k, v]) => fake.orders.set(k, v));
    expect(((await checkTrip(ctx)) as StatusView).together).toBe(true);
    expect(b.status).toBe("confirmed");
  });

  it("while the booking is still being placed and no order is stored, the answer is the booking state", async () => {
    fake.delay.order = 80;
    await bookTogether(ctx, { offerId: "off_delta", confirmed: true }, null);
    const v = await checkTrip(ctx);
    expect(v).toMatchObject({ kind: "booked", status: "booking" });
    await expect(checkTrip(ctx, "ord_other")).rejects.toMatchObject({ code: "no_booking" });
    await job().done;
    expect((await checkTrip(ctx)).kind).toBe("together-status");
  });

  it("a reading younger than the freshness window is served as it is; an older one starts a new reading", async () => {
    let clock = NOW.getTime();
    ctx.now = () => new Date(clock);
    const b = await booked();
    const reads = () => fake.calls.filter((c) => c.startsWith("getOrder")).length;
    const n = reads();
    await checkTrip(ctx);
    expect(reads()).toBe(n);
    clock += 4000;
    await checkTrip(ctx);
    expect(reads()).toBeGreaterThan(n);
    expect(b.status).toBe("confirmed");
  });

  it("stillTogether waits for the fresh reading, so callers that need the truth get it", async () => {
    const b = await booked();
    const mia = ctx.store.getOrder("default", b.orderId!)!.passengerIds.mia;
    fake.airlineMovesSeat(b.orderId!, mia, "30F");
    fake.delay.order = 60;
    const v = await stillTogether(ctx);
    expect(v).toMatchObject({ refreshing: false, together: false });
    await sleep(0);
  });
});
