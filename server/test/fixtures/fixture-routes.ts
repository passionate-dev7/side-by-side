import cors from "cors";
import express, { type Express } from "express";
import type { Ctx } from "../../src/service.js";
import type { FakeDuffel } from "./fake-duffel.js";

/**
 * FIXTURE ONLY. Control surface of the Duffel emulator, mounted by `npm run fixture` and never by the product server.
 * It lets a demo play the airline: GET /fixture says the server is an emulator, POST /fixture/airline-moves-seat moves a
 * traveler's seat on the latest order and records the airline-initiated change, exactly as FakeDuffel does in tests.
 */
export function mountFixtureRoutes(app: Express, ctx: Ctx, fake: FakeDuffel): void {
  const local = cors({ origin: (o, cb) => cb(null, !o || /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(o)) });
  app.use("/fixture", local);
  app.get("/fixture", (_req, res) => res.json({ fixture: true, emulator: "FakeDuffel", note: "In-memory emulator of the Duffel API. Not an airline." }));
  app.post("/fixture/airline-moves-seat", express.json(), (req, res) => {
    const { traveler, seat } = (req.body ?? {}) as { traveler?: unknown; seat?: unknown };
    const order = ctx.store.latestOrder(ctx.account);
    if (!order) return void res.status(409).json({ error: "no booked order yet" });
    // Omitted: the first child on the order, moved to the back of the cabin.
    const member = traveler === undefined ? order.members.find((m) => m.age <= 13) : order.members.find((m) => typeof traveler === "string" && m.name.toLowerCase() === traveler.toLowerCase());
    if (!member) return void res.status(400).json({ error: `no traveler ${String(traveler)}`, travelers: order.members.map((m) => m.name) });
    const target = seat === undefined ? "30F" : seat;
    if (typeof target !== "string" || !/^\d{1,2}[A-Za-z]$/.test(target)) return void res.status(400).json({ error: "seat must look like 30F" });
    const before = fake.orders.get(order.orderId)?.seats[order.passengerIds[member.id]] ?? null;
    fake.airlineMovesSeat(order.orderId, order.passengerIds[member.id], target.toUpperCase());
    res.json({ moved: member.name, from: before, to: target.toUpperCase(), orderId: order.orderId });
  });
}
