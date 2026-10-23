import { mkdtempSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { BookedView, OffersView, SeatMapView, StatusView } from "../src/domain.js";
import { createCtx } from "../src/service.js";
import { openStore } from "../src/store.js";
import { FakeDuffel, NOW } from "./fixtures/fake-duffel.js";
import { mountFixtureRoutes } from "./fixtures/fixture-routes.js";

/**
 * One journey over the real MCP transport, the way a family uses it: search, the ranked total equals fare plus seat fees,
 * book, the booking reaches its terminal state, the airline moves a child, and a later session on a restarted server
 * (same database file) detects it.
 */

const dir = mkdtempSync(join(tmpdir(), "sbs-e2e-"));
const dbPath = join(dir, "state.db");
const fake = new FakeDuffel();
const servers: Server[] = [];

async function start(): Promise<{ base: string; ctx: ReturnType<typeof createCtx> }> {
  const ctx = createCtx({ duffel: fake, store: openStore(dbPath), now: () => NOW, poll: { attempts: 5, delayMs: 1 } });
  const { app } = createApp(ctx);
  mountFixtureRoutes(app, ctx, fake);
  const server = await new Promise<Server>((ok) => {
    const s = app.listen(0, "127.0.0.1", () => ok(s));
  });
  servers.push(server);
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, ctx };
}

async function client(base: string): Promise<Client> {
  const c = new Client({ name: "e2e", version: "0.0.0" }, { capabilities: { elicitation: {} } });
  c.setRequestHandler(ElicitRequestSchema, async () => ({ action: "accept", content: { confirm: true } }));
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  return c;
}

const call = async <T>(c: Client, name: string, args: Record<string, unknown>) => {
  const r = await c.callTool({ name, arguments: args });
  return { isError: r.isError === true, view: r.structuredContent as T, voice: (r.content as Array<{ text: string }>)[0].text };
};

afterAll(async () => {
  await Promise.all(servers.map((s) => new Promise((ok) => s.close(ok))));
});

describe("family journey, end to end over MCP", () => {
  let first: { base: string; ctx: ReturnType<typeof createCtx> };
  let booked: BookedView;
  let ranked: OffersView;

  beforeAll(async () => {
    first = await start();
  });

  it("search ranks by family total, and each card's total is its fare plus its listed seat fees", async () => {
    const c = await client(first.base);
    await call(c, "save_family", {
      travelers: [
        { name: "Dad", age: 40, gender: "m", born_on: "1986-03-02" },
        { name: "Mum", age: 38, gender: "f", born_on: "1988-07-19" },
        { name: "Mia", age: 6, gender: "f", born_on: "2020-05-11" },
        { name: "Leo", age: 9, gender: "m", born_on: "2017-01-30" },
      ],
      family_name: "Rivera",
      email: "family@example.com",
      phone_number: "+12125550123",
    });
    const found = await call<OffersView>(c, "find_family_flights", { origin: "JFK", destination: "MCO", departure_date: "2026-11-25" });
    ranked = found.view;
    expect(ranked.offers.map((o) => o.airline.iata)).toEqual(["B6", "DL", "NK", "UA"]);
    expect([ranked.evaluated, ranked.searched]).toEqual([4, 4]);
    expect(new Set(ranked.offers.map((o) => o.departingAt)).size).toBe(4);
    expect(ranked.offers.map((o) => o.togetherTotal)).toEqual([812, 850, 1010, null]);
    const priced = ranked.offers.filter((o) => o.togetherTotal !== null);
    expect(priced.length).toBe(3);
    expect(priced.map((o) => o.togetherTotal)).toEqual([...priced.map((o) => o.togetherTotal!)].sort((a, b) => a - b));
    for (const o of priced) {
      const fees = o.seatLines.reduce((t, l) => t + l.fee, 0);
      expect(Math.round((o.fare + fees) * 100) / 100).toBe(o.togetherTotal);
    }
    await c.close();
  });

  it("Delta: the seat map's total equals the ranked total, and booking pays exactly that and reaches a booking reference", async () => {
    const c = await client(first.base);
    const delta = ranked.offers.find((o) => o.airline.iata === "DL")!;
    expect(delta).toMatchObject({ fare: 760, seatFees: 90, togetherTotal: 850, waiver: { code: "carrier_no_commitment" } });
    const seats = await call<SeatMapView>(c, "show_seats", { offer_id: delta.offerId });
    expect(seats.view).toMatchObject({ together: "TOGETHER", fare: 760, seatFees: 90, togetherTotal: 850 });

    const b = await call<BookedView>(c, "book_together", { offer_id: delta.offerId });
    expect(b.isError).toBe(false);
    booked = b.view;
    expect(booked).toMatchObject({ kind: "booked", strategy: "seat-services", bookingReference: "FXT4KQ", total: delta.togetherTotal });

    // terminal state, read from the order itself and from the stored booking, not from the tool's answer
    const order = await fake.getOrder(booked.orderId!);
    expect(order.bookingReference).toBe("FXT4KQ");
    expect(order.totalAmount).toBe(delta.togetherTotal);
    expect(Object.values(order.seats).every((s) => s !== null)).toBe(true);
    expect(first.ctx.store.getOrder("default", booked.orderId!)).toMatchObject({ bookingReference: "FXT4KQ", strategy: "seat-services" });

    const same = await call<StatusView>(c, "still_together", {});
    expect(same.view).toMatchObject({ together: true, changes: [], affected: [] });
    await c.close();
  });

  it("the airline moves Mia; a new session on a restarted server detects it and names her, her old seat, her new seat and a re-seat", async () => {
    const before = booked.seats.find((s) => s.name === "Mia")!.seat!;
    const moved = await fetch(`${first.base}/fixture/airline-moves-seat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ traveler: "Mia", seat: "30F" }) });
    expect(await moved.json()).toMatchObject({ moved: "Mia", from: before, to: "30F" });

    const second = await start();
    expect(second.ctx).not.toBe(first.ctx);
    const c = await client(second.base);
    const later = await call<StatusView>(c, "still_together", {});
    expect(later.view.together).toBe(false);
    expect(later.view.affected).toEqual([{ name: "Mia", role: "child", seat: "30F", from: before, reason: "Seat 30F has no adult beside it." }]);
    expect(later.view.changes).toEqual([{ name: "Mia", from: before, to: "30F", via: ["order", "airline-change"] }]);
    expect(later.view.reseat).toMatchObject({ status: "proposal" });
    expect(later.voice).toMatch(/Mia is no longer beside an adult/);
    await c.close();
  });

  it("control: without the airline's move the same later session says the family is together, so the detection above is the move's doing", async () => {
    const fresh = new FakeDuffel();
    const ctx = createCtx({ duffel: fresh, store: openStore(":memory:"), now: () => NOW, poll: { attempts: 5, delayMs: 1 } });
    const { app } = createApp(ctx);
    const server = await new Promise<Server>((ok) => {
      const s = app.listen(0, "127.0.0.1", () => ok(s));
    });
    servers.push(server);
    const c = await client(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    await call(c, "save_family", { travelers: [{ name: "Dad", age: 40, gender: "m", born_on: "1986-03-02" }, { name: "Mia", age: 6, gender: "f", born_on: "2020-05-11" }], family_name: "Rivera", email: "family@example.com", phone_number: "+12125550123" });
    await call(c, "find_family_flights", { origin: "JFK", destination: "MCO", departure_date: "2026-11-25" });
    await call(c, "show_seats", { offer_id: "off_delta" });
    await call(c, "book_together", { offer_id: "off_delta" });
    const s = await call<StatusView>(c, "still_together", {});
    expect(s.view).toMatchObject({ together: true, affected: [] });
    await c.close();
  });
});
