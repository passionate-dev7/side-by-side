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
  rule: { listed: boolean; readOn: string; dashboardUpdated: string };
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
  togetherTotal: number | null;
  comparison: FareComparison | null;
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

export interface StatusView {
  kind: "together-status";
  orderId: string;
  bookingReference: string;
  together: boolean;
  seats: Array<{ name: string; seat: string | null }>;
  changes: Array<{ name: string; from: string | null; to: string | null }>;
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
