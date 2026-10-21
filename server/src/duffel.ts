import { Duffel, DuffelError } from "@duffel/api";
import type { AirlineInitiatedChange, Offer, Order, OrderSlice, SeatMap } from "@duffel/api/types";

/**
 * Duffel Flights API port. The adapter below uses the official @duffel/api SDK, so request and response shapes are
 * checked by the compiler against Duffel's published types. Docs:
 *   offer requests  https://duffel.com/docs/api/offer-requests/create-offer-request
 *   offers          https://duffel.com/docs/api/offers/get-offers
 *   seat maps       https://duffel.com/docs/api/seat-maps/get-seat-maps
 *   orders          https://duffel.com/docs/api/orders/create-order
 *   airline changes https://duffel.com/docs/api/airline-initiated-changes
 * Test mode is selected by the token (duffel_test_...), not by the code. The token is read from DUFFEL_ACCESS_TOKEN
 * by name in config.ts and is never logged.
 */

export type CabinClass = "economy" | "premium_economy" | "business" | "first";

export interface SearchRequest {
  origin: string;
  destination: string;
  departureDate: string;
  cabin: CabinClass;
  /** Order preserved in the response `passengerIds`. */
  passengers: Array<{ age: number }>;
  limit: number;
}

export interface OfferSummary {
  id: string;
  totalAmount: number;
  currency: string;
  airline: { name: string; iata: string };
  flightNumber: string | null;
  origin: string;
  destination: string;
  departingAt: string;
  arrivingAt: string;
  durationMinutes: number | null;
  sliceId: string;
  segmentId: string;
  /** Cabin class the offer sells (economy, premium_economy, business, first). */
  cabinClass: string | null;
  /** The airline's name for the fare, for example "Basic". */
  fareBrand: string | null;
  /** Duffel passenger ids in the same order as the request passengers. */
  passengerIds: string[];
  expiresAt: string;
  liveMode: boolean;
}

export interface OrderPassengerInput {
  passengerId: string;
  title: "mr" | "ms" | "mrs" | "miss" | "dr";
  givenName: string;
  familyName: string;
  bornOn: string;
  gender: "m" | "f";
  email: string;
  phoneNumber: string;
}

export interface OrderDetail {
  id: string;
  bookingReference: string | null;
  totalAmount: number;
  currency: string;
  liveMode: boolean;
  airline: { name: string; iata: string };
  origin: string;
  destination: string;
  departingAt: string;
  flightNumber: string | null;
  /** Duffel passenger id -> assigned seat designator, null when the airline has not assigned one. */
  seats: Record<string, string | null>;
  /** Airline-initiated changes the traveler has not answered yet, with the seat moves each one carries. */
  pendingChanges: PendingChange[];
}

export interface PendingChange {
  id: string;
  createdAt: string;
  /** Per passenger, the seat before and after the airline's change (null = no seat). Only passengers whose seat differs. */
  seatChanges: Array<{ passengerId: string; from: string | null; to: string | null }>;
  /** True when a segment's departure or arrival time differs between the removed and added itinerary. */
  scheduleChanged: boolean;
}

export interface DuffelPort {
  /** "duffel" talks to the Duffel API; "fixture" is the in-memory emulator and is reported as such on every card. */
  readonly source: "duffel" | "fixture";
  /** `moreAvailable` is true when Duffel holds more offers than `limit` returned. */
  searchOffers(req: SearchRequest): Promise<{ offers: OfferSummary[]; liveMode: boolean; moreAvailable: boolean }>;
  /** Empty array when the airline publishes no seat map for this offer. */
  seatMaps(offerId: string): Promise<SeatMap[]>;
  createOrder(input: {
    offerId: string;
    passengers: OrderPassengerInput[];
    serviceIds: string[];
    amount: string;
    currency: string;
  }): Promise<{ orderId: string }>;
  getOrder(orderId: string): Promise<OrderDetail>;
}

export class DuffelApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number | undefined,
  ) {
    super(message);
  }
}

function wrap(err: unknown): never {
  if (err instanceof DuffelError) {
    const first = err.errors?.[0];
    throw new DuffelApiError(first?.code ?? "duffel_error", first?.message ?? err.message, err.status);
  }
  throw err;
}

const minutes = (iso: string | null | undefined): number | null => {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?$/.exec(iso ?? "");
  return m ? Number(m[1] ?? 0) * 1440 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0) : null;
};

function summarize(o: Omit<Offer, "available_services"> | Offer, passengerIds: string[]): OfferSummary {
  const slice = o.slices[0];
  const seg = slice.segments[0];
  return {
    id: o.id,
    totalAmount: Number(o.total_amount),
    currency: o.total_currency,
    airline: { name: o.owner.name, iata: o.owner.iata_code ?? "" },
    flightNumber: seg.marketing_carrier?.iata_code ? `${seg.marketing_carrier.iata_code}${seg.marketing_carrier_flight_number}` : null,
    origin: seg.origin.iata_code ?? "",
    destination: seg.destination.iata_code ?? "",
    departingAt: seg.departing_at,
    arrivingAt: seg.arriving_at,
    durationMinutes: minutes(slice.duration),
    sliceId: slice.id,
    segmentId: seg.id,
    cabinClass: seg.passengers?.[0]?.cabin_class ?? null,
    fareBrand: slice.fare_brand_name ?? null,
    passengerIds,
    expiresAt: o.expires_at,
    liveMode: o.live_mode,
  };
}

function seatsOf(order: Order): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const p of order.passengers) out[p.id] = null;
  for (const seg of order.slices[0]?.segments ?? []) {
    for (const sp of seg.passengers) if (sp.passenger_id) out[sp.passenger_id] = sp.seat?.designator ?? null;
  }
  return out;
}

function seatsBySlices(slices: OrderSlice[]): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const sl of slices) for (const seg of sl.segments) for (const p of seg.passengers) if (p.passenger_id) out.set(p.passenger_id, p.seat?.designator ?? null);
  return out;
}

/** Reads what an airline-initiated change does to seats and times from its removed (before) and added (after) itineraries. */
export function pendingChangeOf(c: AirlineInitiatedChange): PendingChange {
  const before = seatsBySlices(c.removed ?? []);
  const after = seatsBySlices(c.added ?? []);
  const seatChanges = [...after].filter(([pid, to]) => (before.get(pid) ?? null) !== to).map(([passengerId, to]) => ({ passengerId, from: before.get(passengerId) ?? null, to }));
  const times = (slices: OrderSlice[]) => slices.flatMap((sl) => sl.segments.map((s) => `${s.departing_at}>${s.arriving_at}`)).join("|");
  return { id: c.id, createdAt: c.created_at, seatChanges, scheduleChanged: times(c.removed ?? []) !== times(c.added ?? []) };
}

export function createDuffelPort(token: string, basePath?: string): DuffelPort {
  const duffel = new Duffel({ token, ...(basePath ? { basePath } : {}) });
  return {
    source: "duffel",
    async searchOffers(req) {
      try {
        const created = await duffel.offerRequests.create({
          slices: [{ origin: req.origin, destination: req.destination, departure_date: req.departureDate, arrival_time: null, departure_time: null }],
          passengers: req.passengers.map((p) => (p.age >= 18 ? { type: "adult" as const } : { age: p.age })),
          cabin_class: req.cabin,
          max_connections: 0,
          return_offers: false,
        });
        const passengerIds = created.data.passengers.map((p) => p.id);
        const listed = await duffel.offers.list({ offer_request_id: created.data.id, sort: "total_amount", max_connections: 0, limit: req.limit });
        const offers = listed.data
          .filter((o) => o.slices.length === 1 && o.slices[0].segments.length === 1)
          .map((o) => summarize(o, passengerIds));
        return { offers, liveMode: created.data.live_mode, moreAvailable: Boolean(listed.meta?.after) };
      } catch (e) {
        return wrap(e);
      }
    },

    async seatMaps(offerId) {
      try {
        return (await duffel.seatMaps.get({ offer_id: offerId })).data;
      } catch (e) {
        if (e instanceof DuffelError && e.status === 404) return [];
        return wrap(e);
      }
    },

    async createOrder(input) {
      try {
        const res = await duffel.orders.create({
          type: "instant",
          selected_offers: [input.offerId],
          passengers: input.passengers.map((p) => ({
            id: p.passengerId,
            title: p.title,
            given_name: p.givenName,
            family_name: p.familyName,
            born_on: p.bornOn,
            gender: p.gender,
            email: p.email,
            phone_number: p.phoneNumber,
          })),
          services: input.serviceIds.map((id) => ({ id, quantity: 1 })),
          payments: [{ type: "balance", amount: input.amount, currency: input.currency }],
        });
        return { orderId: res.data.id };
      } catch (e) {
        return wrap(e);
      }
    },

    async getOrder(orderId) {
      try {
        const o = (await duffel.orders.get(orderId)).data;
        const seg = o.slices[0].segments[0];
        const changes: AirlineInitiatedChange[] = (await duffel.airlineInitiatedChanges.list(orderId)).data;
        return {
          id: o.id,
          bookingReference: o.booking_reference || null,
          totalAmount: Number(o.total_amount),
          currency: o.total_currency,
          liveMode: o.live_mode,
          airline: { name: o.owner.name, iata: o.owner.iata_code ?? "" },
          origin: seg.origin.iata_code ?? "",
          destination: seg.destination.iata_code ?? "",
          departingAt: seg.departing_at,
          flightNumber: `${seg.marketing_carrier.iata_code}${seg.marketing_carrier_flight_number}`,
          seats: seatsOf(o),
          pendingChanges: changes.filter((c) => c.action_taken === null).map(pendingChangeOf),
        };
      } catch (e) {
        return wrap(e);
      }
    },
  };
}
