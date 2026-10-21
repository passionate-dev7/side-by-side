/**
 * Shapes shared by the tools (producers) and the MCP Apps view (consumer).
 * Every product tool returns one of the `View` variants as `structuredContent`,
 * discriminated by `kind`, plus a spoken text mirror in `content`.
 */

export type Role = "adult" | "child";
export type SeatPreference = "aisle" | "window";

export interface Traveler {
  id: string;
  name: string;
  age: number;
  role: Role;
  seatPreference?: SeatPreference;
}

export type SeatFlag = "exit_row" | "extra_legroom" | "bassinet";

export type Cell =
  | { kind: "seat"; designator: string; state: "free" | "taken"; fee: number | null; travelerId: string | null; flags: SeatFlag[] }
  | { kind: "aisle" }
  | { kind: "blank" };

export interface SeatRow {
  row: number;
  cells: Cell[];
}

export interface AirlineInfo {
  name: string;
  iata: string;
  /** DOT Airline Family Seating Dashboard: true = fee-free adjacent seating for a child 13 or under, false = no, null = carrier not listed. */
  dotFeeFreeAdjacent: boolean | null;
}

export type TogetherStatus = "TOGETHER" | "NOT_TOGETHER";

export type WaiverCode = "applies" | "carrier_not_listed" | "carrier_no_commitment" | "no_young_child" | "no_seating" | "seats_chosen";

/** Whether the U.S. DOT fee-free family seating commitment applies to an offer, and why, condition by condition. */
export interface DotWaiver {
  applies: boolean;
  code: WaiverCode;
  /** One sentence in the dashboard's terms. */
  reason: string;
  /** The same finding in a few words, for a flight card. */
  summary: string;
  /** The dashboard's conditions for seat-assigning airlines. met = null when it cannot be known before departure. */
  conditions: Array<{ id: string; text: string; met: boolean | null }>;
}

/** One seat the family pays for on an offer. */
export interface SeatLine {
  traveler: string;
  seat: string;
  fee: number;
}

export type DataMode = "live" | "test";

/**
 * Where each fact on a card came from. "duffel" is the Duffel Flights API (mode follows the token: duffel_test_ = test,
 * duffel_live_ = live). "fixture" is the in-memory emulator used for demos without a token; it is always test and is never an airline.
 */
export interface Provenance {
  source: "duffel" | "fixture";
  offer: DataMode;
  seatMap: DataMode;
  /** The DOT family seating table. `listed` is false when this carrier is not on the dashboard, so no guarantee is assumed. */
  rule: { listed: boolean; url: string; readOn: string; dashboardUpdated: string };
  /** Mode a booking is made in. `placed` is true once an order exists. */
  booking: { mode: DataMode; placed: boolean };
}

export interface OfferCard {
  offerId: string;
  airline: AirlineInfo;
  departingAt: string;
  arrivingAt: string;
  stops: number;
  durationMinutes: number | null;
  fare: number;
  /** Seat fees to sit together. 0 when the DOT guarantee applies or free adjacent seats exist. */
  seatFees: number;
  guarantee: boolean;
  waiver: DotWaiver;
  /** Each seat the family pays for, empty when the waiver applies. */
  seatLines: SeatLine[];
  /** What the seats would have cost without the waiver, 0 when nothing was waived. */
  waivedFees: number;
  togetherTotal: number | null;
  together: TogetherStatus;
  /** togetherTotal minus the cheapest fare among all offers searched. */
  deltaVsCheapestFare: number | null;
}

/** Result of save_family: who is traveling, shown as a party card. */
export interface FamilyView {
  kind: "family";
  party: Traveler[];
  /** Fields still needed before booking, for example "Mia's date of birth". */
  missingForBooking: string[];
  voice: string;
}

export interface OffersView {
  kind: "offers";
  testMode: boolean;
  currency: string;
  route: { origin: string; destination: string; departureDate: string; returnDate: string | null };
  party: Traveler[];
  offers: OfferCard[];
  /** "searching": seat maps are still being read, and `offers` holds what has priced so far. Ask again, or let the view refresh. */
  status: "searching" | "ready";
  /** Seat maps read so far, of the fares chosen for reading. */
  checking: { done: number; of: number };
  /** The arguments that repeat this search; a repeat returns the same search, not a new one. */
  query: { origin: string; destination: string; departure_date: string; cabin: string };
  /** How many offers the search returned. */
  searched: number;
  /** How many of those had their seat map read and the seating solved before ranking. */
  evaluated: number;
  /** True when the search had more offers than it returned, so the list is the cheapest fares and not every fare. */
  moreAvailable: boolean;
  provenance: Provenance;
  voice: string;
}

export type FareTag = "cheapest-fare" | "this-flight" | "lowest-total";

/** One flight in the fare versus family-total comparison. */
export interface FareRow {
  offerId: string;
  airline: AirlineInfo;
  flightNumber: string | null;
  fare: number;
  /** Seat fees to sit together: 0 under the DOT guarantee, null when this flight cannot seat the family together. */
  seatFees: number | null;
  guarantee: boolean;
  /** fare + seatFees, or null when the family cannot sit together on this flight. */
  familyTotal: number | null;
  tags: FareTag[];
}

/**
 * Fare and family total side by side for the flights that matter: the lowest fare of the search, this flight, and the
 * lowest family total. One flight can carry several tags. `cheapestFareLoses` is true when the lowest fare is not the
 * lowest family total.
 */
export interface FareComparison {
  rows: FareRow[];
  cheapestFareLoses: boolean;
}

/** Another flight of the same search that does seat the family together. */
export interface Alternative {
  offerId: string;
  airline: AirlineInfo;
  flightNumber: string | null;
  departingAt: string;
  fare: number;
  familyTotal: number;
}

/**
 * Set when the flight's open seats cannot put every child beside an adult. This is a finding about the seat map
 * (read at `provenance`), not a failure to search.
 */
export interface NoAdjacentSeats {
  headline: string;
  reason: string;
  alternatives: Alternative[];
}

export interface SeatMapView {
  kind: "seat-map";
  offerId: string;
  testMode: boolean;
  airline: AirlineInfo;
  route: { origin: string; destination: string; departingAt: string; flightNumber: string | null };
  currency: string;
  travelers: Traveler[];
  assignments: Array<{ travelerId: string; seat: string; fee: number }>;
  /** Window of up to 6 rows around the party. Aisles are explicit cells. */
  rows: SeatRow[];
  together: TogetherStatus;
  violations: Array<{ travelerId: string; reason: string }>;
  fare: number;
  seatFees: number;
  guarantee: boolean;
  waiver: DotWaiver;
  seatLines: SeatLine[];
  waivedFees: number;
  togetherTotal: number | null;
  comparison: FareComparison | null;
  noAdjacent: NoAdjacentSeats | null;
  provenance: Provenance;
  voice: string;
}

export interface BookedView {
  kind: "booked";
  orderId: string;
  bookingReference: string;
  testMode: boolean;
  airline: AirlineInfo;
  route: { origin: string; destination: string; departingAt: string };
  currency: string;
  total: number;
  seats: Array<{ name: string; seat: string | null }>;
  /** "seat-services" = seats bought in the order. "airline-guarantee" = no seat fee paid; the carrier seats the family together under the DOT policy. */
  strategy: "seat-services" | "airline-guarantee";
  provenance: Provenance;
  voice: string;
}

export interface SeatChange {
  name: string;
  from: string | null;
  to: string | null;
  /** "order": the order's seats differ from those booked. "airline-change": an unanswered airline-initiated change record carries the move. */
  via: Array<"order" | "airline-change">;
}

/** A traveler who needs an adult beside them and no longer has one. */
export interface AffectedTraveler {
  name: string;
  role: Role;
  seat: string | null;
  /** Where they sat when booked. */
  from: string | null;
  reason: string;
}

/**
 * Offer to seat the family together again, computed from the airline's seat map for the booked offer when it still answers.
 * The family's own seats cost nothing to keep. A proposal is not a purchase.
 */
export type Reseat =
  | { status: "proposal"; moves: Array<{ name: string; from: string | null; to: string; fee: number }>; fee: number; currency: string; guaranteeApplies: boolean }
  | { status: "unavailable"; reason: string };

export interface StatusView {
  kind: "together-status";
  orderId: string;
  bookingReference: string;
  airline: AirlineInfo;
  together: boolean;
  seats: Array<{ name: string; seat: string | null }>;
  changes: SeatChange[];
  affected: AffectedTraveler[];
  reseat: Reseat | null;
  /** Airline-initiated changes still waiting for the traveler's answer. */
  airlineChanges: { open: number; scheduleChanged: boolean };
  checkedAt: string;
  provenance: Provenance;
  voice: string;
}

export interface ErrorView {
  kind: "error";
  code: string;
  message: string;
  voice: string;
}

export type View = FamilyView | OffersView | SeatMapView | BookedView | StatusView | ErrorView;
