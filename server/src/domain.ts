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

export interface OffersView {
  kind: "offers";
  testMode: boolean;
  currency: string;
  route: { origin: string; destination: string; departureDate: string; returnDate: string | null };
  party: Traveler[];
  offers: OfferCard[];
  /** How many offers were priced for seating before ranking. */
  searched: number;
  voice: string;
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
  voice: string;
}

export interface ErrorView {
  kind: "error";
  code: string;
  message: string;
  voice: string;
}

export type View = OffersView | SeatMapView | BookedView | StatusView | ErrorView;
