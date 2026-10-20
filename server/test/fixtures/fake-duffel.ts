import type { SeatMap } from "@duffel/api/types";
import { DuffelApiError, type DuffelPort, type OfferSummary, type OrderDetail, type OrderPassengerInput, type SearchRequest } from "../../src/duffel.js";
import { makeSeatMap } from "./seatmap.js";

/**
 * FIXTURE ONLY. A strict in-memory stand-in for the Duffel API, used by tests and by `npm run fixture`.
 * It is not a mock that says yes: it enforces Duffel's order rules (payment must equal fare plus services, services
 * must exist and be unused, passengers must match the offer request, expired offers are refused) so a wrong call from
 * the product code fails here the way it would fail against Duffel. Shapes follow https://duffel.com/docs/api and the
 * official @duffel/api types. It proves our logic; it says nothing about real airline inventory or Duffel behaviour.
 */

export const NOW = new Date("2026-10-21T12:00:00Z");

interface FakeOffer {
  summary: OfferSummary;
  map: SeatMap;
  /** service id -> { seat, passengerId, amount } */
  services: Map<string, { seat: string; passengerId: string; amount: number }>;
}

interface FakeOrder {
  id: string;
  offerId: string;
  seats: Record<string, string | null>;
  total: number;
  pendingChanges: Array<{ id: string; createdAt: string }>;
  confirmAfterPolls: number;
  polls: number;
}

export interface Scenario {
  id: string;
  airline: { name: string; iata: string };
  fare: number;
  layout: number[];
  rows: number;
  /** Seats that are taken. */
  taken?: (d: string) => boolean;
  /** Fee for a free seat. */
  fee?: (d: string) => number;
}

const rowOf = (d: string) => parseInt(d, 10);
const col = (d: string) => d.replace(/^\d+/, "");

/** Every seat taken except the ones listed, so adjacency is exactly what the test intends. */
const onlyFree = (free: string[]) => (d: string) => !free.includes(d);

export const SCENARIOS: Scenario[] = [
  {
    id: "off_jetblue",
    airline: { name: "JetBlue", iata: "B6" },
    fare: 812,
    layout: [3, 3],
    rows: 30,
    // Adjacent free seats exist but each costs $18, so only the DOT fee-free policy makes this $0.
    taken: (d) => rowOf(d) < 12 || (rowOf(d) > 20 && col(d) !== "A"),
    fee: () => 18,
  },
  {
    id: "off_delta",
    airline: { name: "Delta", iata: "DL" },
    fare: 760,
    layout: [3, 3],
    rows: 30,
    // One free pair (14A,14B) and one pair that costs $27 a seat (22D,22E): together costs $54 more.
    taken: onlyFree(["14A", "14B", "22D", "22E", "5C", "9F", "17A", "26D"]),
    fee: (d) => (d === "22D" || d === "22E" ? 27 : 0),
  },
  {
    id: "off_united",
    airline: { name: "United", iata: "UA" },
    fare: 795,
    layout: [3, 3],
    rows: 30,
    // No two open seats are side by side anywhere on the plane.
    taken: (d) => !["A", "D"].includes(col(d)) || rowOf(d) % 2 === 0,
    fee: () => 30,
  },
  {
    id: "off_duffel_airways",
    airline: { name: "Duffel Airways", iata: "ZZ" },
    fare: 1010,
    layout: [3, 3],
    rows: 30,
    taken: (d) => rowOf(d) % 7 === 0 && col(d) === "B",
    fee: () => 0,
  },
];

export class FakeDuffel implements DuffelPort {
  readonly offers = new Map<string, FakeOffer>();
  readonly orders = new Map<string, FakeOrder>();
  readonly calls: string[] = [];
  private requestPassengerIds: string[] = [];
  private seq = 0;
  /** Offers whose expiry has passed. */
  readonly expired = new Set<string>();
  /** Polls before an order shows a booking reference. */
  confirmAfterPolls = 1;

  constructor(private readonly scenarios: Scenario[] = SCENARIOS) {}

  async searchOffers(req: SearchRequest) {
    this.calls.push("searchOffers");
    this.requestPassengerIds = req.passengers.map((_, i) => `pas_${i}`);
    this.offers.clear();
    const offers: OfferSummary[] = [];
    for (const sc of this.scenarios) {
      const map = makeSeatMap({
        rows: sc.rows,
        layout: sc.layout,
        passengerIds: this.requestPassengerIds,
        taken: Array.from({ length: sc.rows * sc.layout.reduce((a, b) => a + b, 0) }, (_, k) => {
          const per = sc.layout.reduce((a, b) => a + b, 0);
          return `${Math.floor(k / per) + 1}${"ABCDEFGHJK"[k % per]}`;
        }).filter((d) => sc.taken?.(d)),
        fee: sc.fee,
        segmentId: `seg_${sc.id}`,
      });
      const services = new Map<string, { seat: string; passengerId: string; amount: number }>();
      for (const cabin of map.cabins) {
        for (const r of cabin.rows) {
          for (const sec of r.sections) {
            for (const el of sec.elements) {
              if (el.type === "seat") {
                for (const s of el.available_services) services.set(s.id, { seat: el.designator, passengerId: s.passenger_id, amount: Number(s.total_amount) });
              }
            }
          }
        }
      }
      const summary: OfferSummary = {
        id: sc.id,
        totalAmount: sc.fare,
        currency: "USD",
        airline: sc.airline,
        flightNumber: `${sc.airline.iata}${100 + this.scenarios.indexOf(sc)}`,
        origin: req.origin,
        destination: req.destination,
        departingAt: `${req.departureDate}T09:15:00`,
        arrivingAt: `${req.departureDate}T12:05:00`,
        durationMinutes: 170,
        sliceId: `sli_${sc.id}`,
        segmentId: `seg_${sc.id}`,
        passengerIds: this.requestPassengerIds,
        expiresAt: "2026-10-21T12:30:00Z",
        liveMode: false,
      };
      this.offers.set(sc.id, { summary, map, services });
      offers.push(summary);
    }
    return { offers: offers.slice(0, req.limit), liveMode: false };
  }

  async seatMaps(offerId: string) {
    this.calls.push(`seatMaps:${offerId}`);
    const o = this.offers.get(offerId);
    if (!o) throw new DuffelApiError("not_found", "offer not found", 404);
    // Seats bought by existing orders are gone from the live map.
    const bought = new Set<string>();
    for (const ord of this.orders.values()) if (ord.offerId === offerId) Object.values(ord.seats).forEach((s) => s && bought.add(s));
    if (bought.size === 0) return [o.map];
    return [
      {
        ...o.map,
        cabins: o.map.cabins.map((c) => ({
          ...c,
          rows: c.rows.map((r) => ({
            sections: r.sections.map((sec) => ({
              elements: sec.elements.map((el) => (el.type === "seat" && bought.has(el.designator) ? { ...el, available_services: [] } : el)),
            })),
          })),
        })),
      },
    ];
  }

  async createOrder(input: { offerId: string; passengers: OrderPassengerInput[]; serviceIds: string[]; amount: string; currency: string }) {
    this.calls.push("createOrder");
    const o = this.offers.get(input.offerId);
    if (!o) throw new DuffelApiError("not_found", "offer not found", 404);
    if (this.expired.has(input.offerId)) throw new DuffelApiError("offer_no_longer_available", "The offer is no longer available", 422);
    const ids = new Set(o.summary.passengerIds);
    if (input.passengers.length !== ids.size || input.passengers.some((p) => !ids.has(p.passengerId))) {
      throw new DuffelApiError("validation_error", "passengers do not match the offer request", 422);
    }
    for (const p of input.passengers) {
      if (!p.bornOn || !p.email || !p.phoneNumber || !p.givenName || !p.familyName) throw new DuffelApiError("validation_error", "passenger details incomplete", 422);
    }
    const seats: Record<string, string | null> = Object.fromEntries([...ids].map((i) => [i, null]));
    let services = 0;
    const seen = new Set<string>();
    for (const sid of input.serviceIds) {
      const svc = o.services.get(sid);
      if (!svc) throw new DuffelApiError("validation_error", `unknown service ${sid}`, 422);
      if (seen.has(sid)) throw new DuffelApiError("validation_error", `service ${sid} used twice`, 422);
      seen.add(sid);
      if (seats[svc.passengerId]) throw new DuffelApiError("validation_error", "two seats for one passenger", 422);
      if (Object.values(seats).includes(svc.seat)) throw new DuffelApiError("validation_error", `seat ${svc.seat} sold twice`, 422);
      seats[svc.passengerId] = svc.seat;
      services += svc.amount;
    }
    const expected = o.summary.totalAmount + services;
    if (Math.abs(Number(input.amount) - expected) > 0.001 || input.currency !== "USD") {
      throw new DuffelApiError("payment_amount_mismatch", `payment ${input.amount} ${input.currency} does not equal order total ${expected.toFixed(2)} USD`, 422);
    }
    const id = `ord_fixture_${++this.seq}`;
    this.orders.set(id, { id, offerId: input.offerId, seats, total: expected, pendingChanges: [], confirmAfterPolls: this.confirmAfterPolls, polls: 0 });
    return { orderId: id };
  }

  async getOrder(orderId: string): Promise<OrderDetail> {
    this.calls.push(`getOrder:${orderId}`);
    const ord = this.orders.get(orderId);
    if (!ord) throw new DuffelApiError("not_found", "order not found", 404);
    const o = this.offers.get(ord.offerId)!;
    ord.polls++;
    return {
      id: ord.id,
      bookingReference: ord.polls >= ord.confirmAfterPolls ? "FXT4KQ" : null,
      totalAmount: ord.total,
      currency: "USD",
      liveMode: false,
      airline: o.summary.airline,
      origin: o.summary.origin,
      destination: o.summary.destination,
      departingAt: o.summary.departingAt,
      flightNumber: o.summary.flightNumber,
      seats: { ...ord.seats },
      pendingChanges: [...ord.pendingChanges],
    };
  }

  /** Simulates an airline-initiated change: the carrier reassigns a seat after booking. */
  airlineMovesSeat(orderId: string, passengerId: string, newSeat: string) {
    const ord = this.orders.get(orderId)!;
    ord.seats[passengerId] = newSeat;
    ord.pendingChanges.push({ id: `aic_${++this.seq}`, createdAt: NOW.toISOString() });
  }
}
