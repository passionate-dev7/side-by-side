import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDuffelPort, DuffelApiError } from "../src/duffel.js";
import { makeSeatMap } from "./fixtures/seatmap.js";

/**
 * Runs the real @duffel/api SDK through our adapter against a local HTTP server that answers in Duffel's documented
 * JSON shapes. It checks what the adapter actually puts on the wire (paths, query, body, auth header) and how it reads
 * the responses. It cannot say anything about the live Duffel service.
 */

interface Seen { method: string; url: string; auth: string | undefined; version: string | undefined; body: any }
const seen: Seen[] = [];
let http: Server;
let base: string;
let listAfter: string | null = null;

const place = (iata: string) => ({ iata_code: iata, name: iata, type: "airport", id: `arp_${iata}` });
const segment = {
  id: "seg_1", origin: place("JFK"), destination: place("MCO"), departing_at: "2026-11-25T09:15:00", arriving_at: "2026-11-25T12:05:00",
  marketing_carrier: { iata_code: "B6", name: "JetBlue" }, marketing_carrier_flight_number: "101", passengers: [],
};
const offer = {
  id: "off_1", total_amount: "812.00", total_currency: "USD", live_mode: false, expires_at: "2026-10-21T12:30:00Z",
  owner: { iata_code: "B6", name: "JetBlue" }, passengers: [{ id: "pas_a" }, { id: "pas_b" }],
  slices: [{ id: "sli_1", duration: "PT2H50M", segments: [segment] }],
};

beforeAll(async () => {
  http = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const s: Seen = { method: req.method!, url: req.url!, auth: req.headers.authorization, version: req.headers["duffel-version"] as string, body: raw ? JSON.parse(raw) : null };
      seen.push(s);
      const send = (status: number, data: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(data));
      const path = s.url.split("?")[0].replace(/\/$/, "");
      if (path === "/air/offer_requests") return send(201, { data: { id: "orq_1", live_mode: false, passengers: [{ id: "pas_a", type: "adult" }, { id: "pas_b", age: 6 }], slices: [], offers: [] } });
      if (path === "/air/offers") return send(200, { data: [offer, { ...offer, id: "off_conn", slices: [{ ...offer.slices[0], segments: [segment, { ...segment, id: "seg_2" }] }] }], meta: { limit: 10, before: null, after: listAfter } });
      if (path === "/air/seat_maps") {
        if (s.url.includes("off_nomap")) return send(404, { meta: { status: 404, request_id: "r" }, errors: [{ type: "invalid_request_error", title: "Not found", message: "no seat map", code: "not_found" }] });
        return send(200, { data: [makeSeatMap({ rows: 3, layout: [3, 3], passengerIds: ["pas_a", "pas_b"] })] });
      }
      if (path === "/air/orders" && req.method === "POST") {
        if (s.body.data.selected_offers[0] === "off_gone") return send(422, { meta: { status: 422, request_id: "r" }, errors: [{ type: "invalid_state_error", title: "Offer no longer available", message: "The offer is no longer available", code: "offer_no_longer_available" }] });
        return send(201, { data: { id: "ord_1" } });
      }
      if (path === "/air/orders/ord_1") {
        return send(200, { data: { id: "ord_1", booking_reference: "ABC123", total_amount: "830.00", total_currency: "USD", live_mode: false, owner: { iata_code: "B6", name: "JetBlue" },
          passengers: [{ id: "pas_a" }, { id: "pas_b" }],
          slices: [{ segments: [{ ...segment, passengers: [{ passenger_id: "pas_a", seat: { designator: "2A", disclosures: [], name: null } }, { passenger_id: "pas_b" }] }] }] } });
      }
      if (path === "/air/airline_initiated_changes") return send(200, { data: [{ id: "aic_1", order_id: "ord_1", action_taken: null, created_at: "2026-10-22T00:00:00Z",
        removed: [{ segments: [{ ...segment, passengers: [{ passenger_id: "pas_a", seat: { designator: "2A" } }, { passenger_id: "pas_b", seat: { designator: "2B" } }] }] }],
        added: [{ segments: [{ ...segment, departing_at: "2026-11-25T09:40:00", passengers: [{ passenger_id: "pas_a", seat: { designator: "2A" } }, { passenger_id: "pas_b", seat: { designator: "19F" } }] }] }] }, { id: "aic_2", order_id: "ord_1", action_taken: null, created_at: "2026-10-23T00:00:00Z",
        removed: [{ segments: [{ ...segment, passengers: [{ passenger_id: "pas_a", seat: { designator: "2A" } }] }] }],
        added: [{ segments: [{ ...segment, passengers: [{ passenger_id: "pas_a", seat: { designator: "3A" } }] }] }] },
      { id: "aic_0", order_id: "ord_1", action_taken: "accepted", created_at: "2026-10-20T00:00:00Z" }] });
      return send(404, { meta: { status: 404, request_id: "r" }, errors: [{ type: "x", title: "x", message: `unrouted ${s.method} ${s.url}`, code: "not_found" }] });
    });
  });
  await new Promise<void>((ok) => http.listen(0, "127.0.0.1", () => ok()));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});
afterAll(() => new Promise((ok) => http.close(ok)));

describe("Duffel adapter over the real SDK", () => {
  const port = () => createDuffelPort("duffel_test_not_a_real_token", base);

  it("searchOffers sends one adult and one aged child, direct only, no inline offers; keeps only single-segment offers", async () => {
    seen.length = 0;
    const r = await port().searchOffers({ origin: "JFK", destination: "MCO", departureDate: "2026-11-25", cabin: "economy", passengers: [{ age: 40 }, { age: 6 }], limit: 10 });
    const create = seen.find((s) => s.url.startsWith("/air/offer_requests"))!;
    expect(create.url).toContain("return_offers=false");
    expect(create.auth).toBe("Bearer duffel_test_not_a_real_token");
    expect(create.version).toBe("v2");
    expect(create.body.data.passengers).toEqual([{ type: "adult" }, { age: 6 }]);
    expect(create.body.data.max_connections).toBe(0);
    expect(create.body.data.slices[0]).toMatchObject({ origin: "JFK", destination: "MCO", departure_date: "2026-11-25" });
    const list = seen.find((s) => s.url.startsWith("/air/offers"))!;
    expect(list.url).toMatch(/offer_request_id=orq_1/);
    expect(list.url).toMatch(/sort=total_amount/);
    expect(r.offers.map((o) => o.id)).toEqual(["off_1"]);
    expect(r.offers[0]).toMatchObject({ totalAmount: 812, airline: { iata: "B6" }, flightNumber: "B6101", durationMinutes: 170, passengerIds: ["pas_a", "pas_b"], segmentId: "seg_1", liveMode: false });
    expect(r.liveMode).toBe(false);
    expect(r.moreAvailable).toBe(false);
    expect(port().source).toBe("duffel");
  });

  it("searchOffers reports moreAvailable when Duffel holds a next page of offers", async () => {
    listAfter = "cursor_next";
    try {
      const r = await port().searchOffers({ origin: "JFK", destination: "MCO", departureDate: "2026-11-25", cabin: "economy", passengers: [{ age: 40 }], limit: 10 });
      expect(r.moreAvailable).toBe(true);
    } finally {
      listAfter = null;
    }
  });

  it("seatMaps returns the maps, and an empty list when the airline has none", async () => {
    expect((await port().seatMaps("off_1")).length).toBe(1);
    expect(await port().seatMaps("off_nomap")).toEqual([]);
  });

  it("createOrder posts an instant order with the seat services and a balance payment of the exact amount", async () => {
    seen.length = 0;
    const r = await port().createOrder({
      offerId: "off_1", serviceIds: ["ase_1", "ase_2"], amount: "830.00", currency: "USD",
      passengers: [{ passengerId: "pas_a", title: "mr", givenName: "Dad", familyName: "Rivera", bornOn: "1986-03-02", gender: "m", email: "a@b.co", phoneNumber: "+12125550123" }],
    });
    expect(r.orderId).toBe("ord_1");
    const body = seen.find((s) => s.method === "POST" && s.url === "/air/orders")!.body.data;
    expect(body).toMatchObject({ type: "instant", selected_offers: ["off_1"], services: [{ id: "ase_1", quantity: 1 }, { id: "ase_2", quantity: 1 }], payments: [{ type: "balance", amount: "830.00", currency: "USD" }] });
    expect(body.passengers[0]).toMatchObject({ id: "pas_a", given_name: "Dad", family_name: "Rivera", born_on: "1986-03-02", gender: "m", title: "mr" });
  });

  it("maps a Duffel error to DuffelApiError with the API's own code", async () => {
    const err = await port().createOrder({ offerId: "off_gone", serviceIds: [], amount: "1.00", currency: "USD", passengers: [] }).catch((e) => e);
    expect(err).toBeInstanceOf(DuffelApiError);
    expect(err.code).toBe("offer_no_longer_available");
    expect(err.status).toBe(422);
  });

  it("getOrder reads the booking reference, per-passenger seats (null when unassigned) and only unanswered airline changes", async () => {
    const o = await port().getOrder("ord_1");
    expect(o.bookingReference).toBe("ABC123");
    expect(o.seats).toEqual({ pas_a: "2A", pas_b: null });
    expect(o.pendingChanges).toEqual([
      { id: "aic_1", createdAt: "2026-10-22T00:00:00Z", seatChanges: [{ passengerId: "pas_b", from: "2B", to: "19F" }], scheduleChanged: true },
      { id: "aic_2", createdAt: "2026-10-23T00:00:00Z", seatChanges: [{ passengerId: "pas_a", from: "2A", to: "3A" }], scheduleChanged: false },
    ]);
    expect(o.totalAmount).toBe(830);
  });
});
