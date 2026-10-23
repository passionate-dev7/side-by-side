import type { SeatMap } from "@duffel/api/types";
import type {
  AirlineInfo,
  Alternative,
  BookedView,
  ErrorView,
  FamilyView,
  FareComparison,
  FareRow,
  NoAdjacentSeats,
  AffectedTraveler,
  DotWaiver,
  SeatLine,
  OfferCard,
  OffersView,
  Reseat,
  SeatChange,
  Provenance,
  SeatMapView,
  StatusCabin,
  StatusView,
  Traveler,
  TogetherStatus,
} from "./domain.js";
import { DuffelApiError, type CabinClass, type DuffelPort, type OfferSummary } from "./duffel.js";
import { DOT_CHILD_MAX_AGE, DOT_SOURCE, dotFeeFreeAdjacent } from "./dot.js";
import { evaluateWaiver } from "./waiver.js";
import { mapLimit, within } from "./jobs.js";
import { buildGrid, gridFromLayout, layoutOf, viewRows, type Grid, type Layout } from "./seatmap.js";
import { evaluateAssignment, isAdjacencyFinding, solveSeating, type PartyMember, type Solution } from "./solver.js";
import type { BookedOrder, Family, FamilyMember, Plan, Store } from "./store.js";

/** Domain logic behind the tools. Everything that decides seats, prices or booking is plain code here. */

export class ToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly voice: string = message,
  ) {
    super(message);
  }
  view(): ErrorView {
    return { kind: "error", code: this.code, message: this.message, voice: this.voice };
  }
}

/** The offers of one search, shared by reference so any of them can see the others. */
interface SearchRecord {
  offerIds: string[];
}

interface OfferEntry {
  search?: SearchRecord;
  summary: OfferSummary;
  maps?: { raw: SeatMap[]; grid: Grid; solution: Solution; price: Price; fetchedAt: number };
}

/** One search, shared by every repeat of it. Seat maps are read in the background; the tool answers with what is ready. */
interface SearchJob {
  key: string;
  input: FindInput;
  startedAt: number;
  status: "searching" | "ready" | "failed";
  liveMode: boolean;
  moreAvailable: boolean;
  found: number;
  toCheck: number;
  checked: number;
  currency: string;
  cheapestFare: number;
  /** Entries whose seat map was read and priced. */
  entries: OfferEntry[];
  error?: ToolError;
  done: Promise<void>;
}

/** An order being placed. It outlives the tool call; the view and the next call read its state. */
interface BookingJob {
  offerId: string;
  status: "booking" | "confirmed" | "failed";
  /** What is shown while the order is placed. */
  pending: BookedView;
  view?: BookedView;
  error?: ToolError;
  /** The airline accepted the order but has not issued a reference: a retry resumes this order instead of placing another. */
  orderId?: string;
  reported: boolean;
  done: Promise<void>;
}

export interface Ctx {
  duffel: DuffelPort | null;
  store: Store;
  account: string;
  now: () => Date;
  /** Seat maps older than this are refetched before showing or moving seats. */
  seatMapTtlMs: number;
  offers: Map<string, OfferEntry>;
  /** Poll settings for order confirmation. */
  poll: { attempts: number; delayMs: number };
  /** How long a tool waits for background work before it answers with what it has. Alexa+ allows a tool 500 ms. */
  budgetMs: number;
  /** Seat map requests in flight at once during a search. */
  seatMapConcurrency: number;
  /** A finished search is reused for this long, and never past the expiry of any of its offers. */
  searchTtlMs: number;
  searches: Map<string, SearchJob>;
  /** Bookings by offer: a repeat of book_together for the same offer returns this one and never places a second order. */
  bookings: Map<string, BookingJob>;
  /** The last live reading of each booked order, served while the next one is under way. */
  statusCache: Map<string, StatusView>;
  refreshing: Map<string, Promise<StatusView>>;
  /** A reading this young is served as it is, without asking the airline again. */
  statusFreshMs: number;
}

export function createCtx(parts: Pick<Ctx, "duffel" | "store"> & Partial<Ctx>): Ctx {
  return {
    account: "default",
    now: () => new Date(),
    seatMapTtlMs: 5 * 60_000,
    offers: new Map(),
    poll: { attempts: 20, delayMs: 1000 },
    budgetMs: 200,
    seatMapConcurrency: 4,
    searchTtlMs: 120_000,
    searches: new Map(),
    bookings: new Map(),
    statusCache: new Map(),
    refreshing: new Map(),
    statusFreshMs: 3000,
    ...parts,
  };
}

const money = (n: number, currency: string) => (currency === "USD" ? `$${Number.isInteger(n) ? n : n.toFixed(2)}` : `${n.toFixed(2)} ${currency}`);
const seatList = (assign: Array<{ name: string; seat: string | null }>) => assign.map((a) => `${a.name} ${a.seat ?? "no seat yet"}`).join(", ");

function duffelOrThrow(ctx: Ctx): DuffelPort {
  if (!ctx.duffel) {
    throw new ToolError(
      "duffel_not_configured",
      "Flight search is not connected. Set DUFFEL_ACCESS_TOKEN to a Duffel test token (duffel_test_...) in the server environment.",
      "Flight search is not connected yet.",
    );
  }
  return ctx.duffel;
}

function wrapDuffel<T>(p: Promise<T>): Promise<T> {
  return p.catch((e: unknown) => {
    if (e instanceof DuffelApiError) {
      if (e.code === "offer_no_longer_available" || e.code === "offer_expired") {
        throw new ToolError("offer_expired", "That fare is no longer available.", "That fare is gone. Let me search again.");
      }
      throw new ToolError("duffel_error", `Duffel returned ${e.code}: ${e.message}`, "The airline booking service said no. I have not booked anything.");
    }
    throw e;
  });
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export const toTraveler = (m: FamilyMember): Traveler => ({
  id: m.id,
  name: m.name,
  age: m.age,
  role: m.age >= 18 ? "adult" : "child",
  ...(m.seatPreference ? { seatPreference: m.seatPreference } : {}),
});

function requireFamily(ctx: Ctx): Family {
  const f = ctx.store.getFamily(ctx.account);
  if (!f || f.members.length === 0) {
    throw new ToolError("family_missing", "No family is saved yet. Save who is traveling first.", "Tell me who is traveling first, with their ages.");
  }
  return f;
}

// ---------------------------------------------------------------------------------------------------------------
// save_family

export interface SaveFamilyInput {
  travelers: Array<{ name: string; age: number; seatPreference?: "aisle" | "window"; bornOn?: string; gender?: "m" | "f" }>;
  familyName?: string;
  email?: string;
  phoneNumber?: string;
}

export function saveFamily(ctx: Ctx, input: SaveFamilyInput): FamilyView {
  const names = new Set<string>();
  const members: FamilyMember[] = input.travelers.map((t) => {
    const key = t.name.trim().toLowerCase();
    if (names.has(key)) throw new ToolError("duplicate_name", `Two travelers are called ${t.name}.`, `I have two travelers called ${t.name}. Give one a different name.`);
    names.add(key);
    if (t.age < 2) {
      throw new ToolError("lap_infant_unsupported", `${t.name} is under 2. Lap infants are not supported yet.`, `${t.name} is under two. I can only seat travelers who are two or older.`);
    }
    return {
      id: slug(t.name) || `t${names.size}`,
      name: t.name.trim(),
      age: t.age,
      ...(t.seatPreference ? { seatPreference: t.seatPreference } : {}),
      ...(t.bornOn ? { bornOn: t.bornOn } : {}),
      ...(t.gender ? { gender: t.gender } : {}),
    };
  });
  if (!members.some((m) => m.age >= 18)) {
    throw new ToolError("no_adult", "At least one traveler must be 18 or older.", "I need at least one adult on the booking.");
  }
  const family: Family = { members, ...(input.familyName ? { familyName: input.familyName } : {}), ...(input.email ? { email: input.email } : {}), ...(input.phoneNumber ? { phoneNumber: input.phoneNumber } : {}) };
  ctx.store.saveFamily(ctx.account, family);
  // A new party is a new trip: earlier searches and finished bookings no longer describe it. A booking in flight keeps going.
  ctx.searches.clear();
  for (const [offerId, job] of ctx.bookings) if (job.status !== "booking") ctx.bookings.delete(offerId);
  const party = members.map(toTraveler);
  const kids = party.filter((t) => t.role === "child");
  const missingForBooking = [
    ...members.flatMap((m) => [...(m.bornOn ? [] : [`${m.name}'s date of birth`]), ...(m.gender ? [] : [`${m.name}'s gender`])]),
    ...(family.familyName ? [] : ["family name"]),
    ...(family.email ? [] : ["contact email"]),
    ...(family.phoneNumber ? [] : ["contact phone"]),
  ];
  return {
    kind: "family",
    party,
    missingForBooking,
    voice: `Saved ${party.map((t) => `${t.name}, ${t.age}`).join("; ")}. ${kids.length ? `I will keep ${kids.map((k) => k.name).join(" and ")} beside an adult.` : "Everyone is an adult."}`,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// shared seating helpers

const partyFor = (family: Family, passengerIds: string[]): PartyMember[] =>
  family.members.map((m, i) => ({ id: m.id, passengerId: passengerIds[i], age: m.age, ...(m.seatPreference ? { seatPreference: m.seatPreference } : {}) }));

function provenanceOf(ctx: Ctx, iata: string, liveMode: boolean, placed: boolean): Provenance {
  const mode = liveMode ? "live" : "test";
  return {
    source: ctx.duffel?.source ?? "duffel",
    offer: mode,
    seatMap: mode,
    rule: { listed: dotFeeFreeAdjacent(iata) !== null, url: DOT_SOURCE.url, readOn: DOT_SOURCE.readOn, dashboardUpdated: DOT_SOURCE.dashboardUpdated },
    booking: { mode, placed },
  };
}

function airlineInfo(a: { name: string; iata: string }): AirlineInfo {
  return { name: a.name, iata: a.iata, dotFeeFreeAdjacent: dotFeeFreeAdjacent(a.iata) };
}

const expired = (ctx: Ctx, o: OfferSummary) => ctx.now() >= new Date(o.expiresAt);

/**
 * A cached seat map prices only while its offer is alive and the map is younger than the TTL. Once the offer has expired
 * the map belongs to a fare that can no longer be bought, so nothing is priced from it.
 */
function usable(ctx: Ctx, entry: OfferEntry): boolean {
  return !!entry.maps && !expired(ctx, entry.summary) && ctx.now().getTime() - entry.maps.fetchedAt < ctx.seatMapTtlMs;
}

async function loadMaps(ctx: Ctx, entry: OfferEntry, family: Family, force = false): Promise<NonNullable<OfferEntry["maps"]> | null> {
  if (expired(ctx, entry.summary)) throw new ToolError("offer_expired", "That fare has expired.", "That fare expired. Let me search again.");
  if (usable(ctx, entry) && !force) return entry.maps!;
  const raw = await wrapDuffel(duffelOrThrow(ctx).seatMaps(entry.summary.id));
  const map = raw.find((m) => m.segment_id === entry.summary.segmentId) ?? raw[0];
  if (!map) return null;
  const grid = buildGrid(map, { cabinClass: entry.summary.cabinClass });
  const solution = solveSeating(grid, partyFor(family, entry.summary.passengerIds));
  entry.maps = { raw, grid, solution, price: priceOffer(entry.summary, solution, family), fetchedAt: ctx.now().getTime() };
  return entry.maps;
}

function entryFor(ctx: Ctx, offerId: string): OfferEntry {
  const e = ctx.offers.get(offerId);
  if (!e) throw new ToolError("offer_unknown", `I no longer have offer ${offerId}.`, "I lost that fare. Let me search again.");
  return e;
}

/** What it costs the family to sit together on one offer, from its solved seat map and the DOT table. */
interface Price {
  together: boolean;
  waiver: DotWaiver;
  guarantee: boolean;
  seatFees: number;
  waivedFees: number;
  seatLines: SeatLine[];
  total: number | null;
}

const waiverFor = (o: OfferSummary, family: Family, seatingExists: boolean, seatsChosenByHand: boolean): DotWaiver =>
  evaluateWaiver({ iata: o.airline.iata, airlineName: o.airline.name, ages: family.members.map((m) => m.age), seatingExists, seatsChosenByHand, cabinClass: o.cabinClass });

function priceOffer(o: OfferSummary, solution: Solution, family: Family): Price {
  const together = solution.status === "TOGETHER";
  const waiver = waiverFor(o, family, together, false);
  const fee = together ? solution.fee / 100 : 0;
  const nameOf = new Map(family.members.map((m) => [m.id, m.name]));
  return {
    together,
    waiver,
    guarantee: waiver.applies,
    seatFees: waiver.applies ? 0 : fee,
    waivedFees: waiver.applies ? fee : 0,
    seatLines: together && !waiver.applies ? solution.assignments.map((a) => ({ traveler: nameOf.get(a.memberId)!, seat: a.seat, fee: a.fee / 100 })) : [],
    total: together ? Math.round((o.totalAmount + (waiver.applies ? 0 : fee)) * 100) / 100 : null,
  };
}

function fareRow(entry: OfferEntry): Omit<FareRow, "tags"> {
  const o = entry.summary;
  const p = entry.maps?.price ?? null;
  return {
    offerId: o.id,
    airline: airlineInfo(o.airline),
    flightNumber: o.flightNumber,
    fare: o.totalAmount,
    seatFees: p?.together ? p.seatFees : null,
    guarantee: p?.guarantee ?? false,
    familyTotal: p?.total ?? null,
    seatMap: !!entry.maps,
  };
}

/** The lowest fare and the lowest family total of this offer's search beside this flight. `now` is this flight as the family has it seated right now. */
function compareFares(ctx: Ctx, entry: OfferEntry, now: { seatFees: number | null; guarantee: boolean; total: number | null }): FareComparison | null {
  const siblings = (entry.search?.offerIds ?? []).map((id) => ctx.offers.get(id)).filter((e): e is OfferEntry => !!e);
  if (siblings.length < 2) return null;
  const rowOf = (e: OfferEntry) => (e === entry ? { ...fareRow(e), seatFees: now.seatFees, guarantee: now.guarantee, familyTotal: now.total } : fareRow(e));
  const all = siblings.map(rowOf);
  const cheapest = all.reduce((a, b) => (b.fare < a.fare ? b : a));
  const priced = all.filter((r) => r.familyTotal !== null);
  const lowest = priced.length ? priced.reduce((a, b) => (b.familyTotal! < a.familyTotal! ? b : a)) : null;
  const tagged: Record<string, FareRow> = {};
  const add = (r: Omit<FareRow, "tags"> | null, tag: FareRow["tags"][number]) => {
    if (!r) return;
    (tagged[r.offerId] ??= { ...r, tags: [] }).tags.push(tag);
  };
  add(cheapest, "cheapest-fare");
  add(rowOf(entry), "this-flight");
  add(lowest, "lowest-total");
  const rows = Object.values(tagged).sort((a, b) => a.fare - b.fare);
  // A fare whose seat map was not read has no family total to lose by: only a priced fare can be beaten.
  return { rows, cheapestFareLoses: !!lowest && lowest.offerId !== cheapest.offerId && cheapest.seatMap && (cheapest.familyTotal === null || lowest.familyTotal! < cheapest.familyTotal) };
}

// ---------------------------------------------------------------------------------------------------------------
// find_family_flights

export interface FindInput {
  origin: string;
  destination: string;
  departureDate: string;
  cabin: CabinClass;
}

/** Seat maps are read for this many of the cheapest direct fares. */
const SEARCH_LIMIT = 10;
/** Offers fetched per search so the list can say how many fares exist (Duffel returns at most 200 per page). */
const SEARCH_FETCH = 200;

const familyKey = (family: Family) => family.members.map((m) => `${m.id}:${m.age}:${m.seatPreference ?? ""}`).join(",");
const searchKey = (input: FindInput, family: Family) => `${input.origin}|${input.destination}|${input.departureDate}|${input.cabin}|${familyKey(family)}`;

function reusable(ctx: Ctx, job: SearchJob): boolean {
  if (job.status === "failed") return false;
  if (job.status === "searching") return true;
  const fresh = ctx.now().getTime() - job.startedAt < ctx.searchTtlMs;
  return fresh && job.entries.every((e) => !expired(ctx, e.summary));
}

async function runSearch(ctx: Ctx, job: SearchJob, family: Family): Promise<void> {
  const duffel = duffelOrThrow(ctx);
  const input = job.input;
  const res = await wrapDuffel(duffel.searchOffers({ ...input, passengers: family.members.map((m) => ({ age: m.age })), limit: SEARCH_FETCH }));
  if (res.offers.length === 0) {
    throw new ToolError("no_offers", `No direct flights found from ${input.origin} to ${input.destination} on ${input.departureDate}.`, `I found no direct flights from ${input.origin} to ${input.destination} on that date.`);
  }
  const checked = res.offers.slice(0, SEARCH_LIMIT);
  const search: SearchRecord = { offerIds: checked.map((o) => o.id) };
  for (const o of checked) ctx.offers.set(o.id, { summary: o, search });
  Object.assign(job, { found: res.offers.length, toCheck: checked.length, liveMode: res.liveMode, moreAvailable: res.moreAvailable, currency: res.offers[0].currency, cheapestFare: Math.min(...res.offers.map((o) => o.totalAmount)) });

  // Seat maps are read in parallel, a few at a time, and each priced offer is visible to the next answer as soon as it lands.
  await mapLimit(checked, ctx.seatMapConcurrency, async (o) => {
    const entry = ctx.offers.get(o.id)!;
    try {
      if (await loadMaps(ctx, entry, family)) job.entries.push(entry);
    } catch (e) {
      if (!(e instanceof ToolError)) throw e;
    } finally {
      job.checked++;
    }
  });
  if (job.entries.length === 0) {
    throw new ToolError("no_seat_maps", "None of the flights publish a seat map, so I cannot check seating.", "None of those airlines share a seat map, so I cannot check where your family would sit.");
  }
  job.status = "ready";
}

function startSearch(ctx: Ctx, input: FindInput, family: Family, key: string): SearchJob {
  const job: SearchJob = { key, input, startedAt: ctx.now().getTime(), status: "searching", liveMode: false, moreAvailable: false, found: 0, toCheck: 0, checked: 0, currency: "USD", cheapestFare: 0, entries: [], done: Promise.resolve() };
  job.done = runSearch(ctx, job, family).catch((e: unknown) => {
    job.status = "failed";
    job.error = e instanceof ToolError ? e : new ToolError("internal_error", "Something went wrong inside the add-on.", "Something went wrong on my side. I have not changed anything.");
    if (!(e instanceof ToolError)) console.error("search failed:", e instanceof Error ? e.message : e);
  });
  ctx.searches.set(key, job);
  return job;
}

/** The ranked offers of a search as far as it has got. */
function offersView(ctx: Ctx, job: SearchJob, family: Family): OffersView {
  const input = job.input;
  const cards: OfferCard[] = job.entries.map((entry) => {
    const o = entry.summary;
    const { together, guarantee, seatFees, total, waiver, seatLines, waivedFees } = entry.maps!.price;
    return {
      offerId: o.id,
      airline: airlineInfo(o.airline),
      departingAt: o.departingAt,
      arrivingAt: o.arrivingAt,
      stops: 0,
      durationMinutes: o.durationMinutes,
      fare: o.totalAmount,
      seatFees,
      guarantee,
      waiver,
      seatLines,
      waivedFees,
      togetherTotal: total,
      together: (together ? "TOGETHER" : "NOT_TOGETHER") as TogetherStatus,
      deltaVsCheapestFare: total === null ? null : Math.round((total - job.cheapestFare) * 100) / 100,
    };
  });
  cards.sort((a, b) => {
    if ((a.together === "TOGETHER") !== (b.together === "TOGETHER")) return a.together === "TOGETHER" ? -1 : 1;
    return (a.togetherTotal ?? a.fare) - (b.togetherTotal ?? b.fare) || a.fare - b.fare || a.offerId.localeCompare(b.offerId);
  });
  const top = cards.slice(0, 5);
  const currency = job.currency;
  const searching = job.status === "searching";

  let voice: string;
  if (!top.length) {
    voice = job.found
      ? `I found ${job.found} direct fares and I am reading seat maps on the ${job.toCheck} cheapest. The screen fills in as each one comes back.`
      : `I am searching ${input.origin} to ${input.destination}. The screen fills in as the fares come back.`;
  } else {
    const best = top[0];
    const cheapestCard = cards.find((c) => c.fare === Math.min(...cards.map((x) => x.fare)));
    voice =
      best.together === "TOGETHER"
        ? `${searching ? "So far, " : ""}${best.airline.name} is the best way to sit together: ${money(best.togetherTotal!, currency)} total${best.guarantee ? `, and ${best.airline.name} seats a child beside an adult at no fee` : best.seatFees > 0 ? `, including ${money(best.seatFees, currency)} in seat fees` : ""}.` +
          (cheapestCard && cheapestCard.offerId !== best.offerId ? ` The cheapest fare is ${cheapestCard.airline.name} at ${money(cheapestCard.fare, currency)}${cheapestCard.together === "TOGETHER" ? `, ${money(cheapestCard.togetherTotal! - cheapestCard.fare, currency)} more to sit together` : ", but your family cannot sit together on it"}.` : "")
        : searching ? "No flight so far lets the whole family sit together." : "No flight lets the whole family sit together on that day.";
    voice += searching ? ` I am still reading seat maps, ${job.checked} of ${job.toCheck} done, and the screen updates as they land.` : cards.length < job.found || job.moreAvailable ? ` I read seat maps for ${cards.length} of ${job.found}${job.moreAvailable ? "+" : ""} fares, cheapest first.` : "";
  }

  return {
    kind: "offers",
    testMode: !job.liveMode,
    currency,
    route: { origin: input.origin, destination: input.destination, departureDate: input.departureDate, returnDate: null },
    party: family.members.map(toTraveler),
    offers: top,
    status: searching ? "searching" : "ready",
    checking: { done: job.checked, of: job.toCheck },
    query: { origin: input.origin, destination: input.destination, departure_date: input.departureDate, cabin: input.cabin },
    searched: job.found,
    evaluated: cards.length,
    moreAvailable: job.moreAvailable,
    provenance: provenanceOf(ctx, top[0]?.airline.iata ?? "", job.liveMode, false),
    voice,
  };
}

/**
 * Starts the search (or joins the one already running or finished for the same trip and family), waits up to the budget,
 * and answers with the best ranked offers that are ready. A search that is still reading seat maps says so, and a repeat
 * of the same call returns the same search with more of it done.
 */
export async function findFamilyFlights(ctx: Ctx, input: FindInput): Promise<OffersView> {
  const family = requireFamily(ctx);
  duffelOrThrow(ctx);
  const key = searchKey(input, family);
  let job = ctx.searches.get(key);
  if (job?.status === "failed") {
    ctx.searches.delete(key);
    throw job.error!;
  }
  if (!job || !reusable(ctx, job)) job = startSearch(ctx, input, family, key);
  await within(job.done, ctx.budgetMs);
  if (job.status === "failed") {
    ctx.searches.delete(key);
    throw job.error!;
  }
  return offersView(ctx, job, family);
}

// ---------------------------------------------------------------------------------------------------------------
// seat views

/** Other flights of this offer's search that seat the whole family together, cheapest family total first. */
function alternativesTo(ctx: Ctx, entry: OfferEntry): Alternative[] {
  const out: Alternative[] = [];
  for (const id of entry.search?.offerIds ?? []) {
    const e = ctx.offers.get(id);
    if (!e || e === entry) continue;
    const row = fareRow(e);
    if (row.familyTotal === null) continue;
    out.push({ offerId: row.offerId, airline: row.airline, flightNumber: row.flightNumber, departingAt: e.summary.departingAt, fare: row.fare, familyTotal: row.familyTotal });
  }
  return out.sort((a, b) => a.familyTotal - b.familyTotal || a.fare - b.fare || a.offerId.localeCompare(b.offerId)).slice(0, 2);
}

/** An honest "no adjacent seats" finding with the flights that do work, or null when the seat map does not support that finding. */
function noAdjacentFor(ctx: Ctx, entry: OfferEntry): NoAdjacentSeats | null {
  const sol = entry.maps?.solution;
  if (!sol || sol.status !== "NOT_TOGETHER" || !isAdjacencyFinding(sol.cause)) return null;
  return {
    headline: "No adjacent seats on this flight",
    reason: sol.cause === "no_adjacent_pair" ? "No two open seats are side by side." : "Not enough open seats side by side for every child to have an adult beside them.",
    alternatives: alternativesTo(ctx, entry),
  };
}

function noAdjacentSpeech(o: OfferSummary, family: Family, na: NoAdjacentSeats): string {
  const kids = family.members.filter((m) => m.age <= DOT_CHILD_MAX_AGE).map((m) => m.name);
  const flight = [o.airline.name, o.flightNumber].filter(Boolean).join(" ");
  const alt = na.alternatives[0];
  return (
    `There are no adjacent seats on ${flight}${kids.length ? ` for ${kids.join(" and ")} to sit beside an adult` : ""}. ` +
    (alt ? `${alt.airline.name} seats everyone together for ${money(alt.familyTotal, o.currency)}.` : "No other flight in this search seats your family together.")
  );
}

/** One spoken sentence when the lowest fare is not the lowest family total. */
function fareNote(c: FareComparison | null, currency: string): string {
  if (!c?.cheapestFareLoses) return "";
  const lo = c.rows.find((r) => r.tags.includes("cheapest-fare"))!;
  const best = c.rows.find((r) => r.tags.includes("lowest-total"))!;
  if (lo.offerId === best.offerId) return "";
  const loTotal = lo.familyTotal === null ? "your family cannot sit together on it" : `${money(lo.familyTotal, currency)} for your family to sit together`;
  return ` ${lo.airline.name} has the lowest fare at ${money(lo.fare, currency)}, but ${loTotal}. ${best.airline.name} is the lowest family total at ${money(best.familyTotal!, currency)}.`;
}

function buildSeatView(ctx: Ctx, entry: OfferEntry, family: Family, plan: Plan): SeatMapView {
  const maps = entry.maps!;
  const o = entry.summary;
  const party = partyFor(family, o.passengerIds);
  const assignments = Object.entries(plan.assignments).map(([memberId, seat]) => ({ memberId, seat }));
  const ev = evaluateAssignment(maps.grid, party, assignments);
  const feasible = maps.solution.status === "TOGETHER";
  const waiver = waiverFor(o, family, feasible, plan.customized);
  const guarantee = waiver.applies;
  const payable = guarantee ? 0 : ev.fee / 100;
  const travelers = family.members.map(toTraveler);
  const nameOf = new Map(family.members.map((m) => [m.id, m.name]));
  const occupant = new Map(Object.entries(plan.assignments).map(([m, s]) => [s, m]));
  const together = ev.together;
  const total = together ? Math.round((o.totalAmount + payable) * 100) / 100 : null;
  const comparison = compareFares(ctx, entry, { seatFees: together ? payable : null, guarantee, total });

  const noAdjacent = noAdjacentFor(ctx, entry);

  const placed = assignments.map((a) => `${nameOf.get(a.memberId)} ${a.seat}`).join(", ");
  const voice = together
    ? `${placed}. Everyone has a family neighbor. ${guarantee ? `${o.airline.name} seats your child beside an adult at no fee, so seats cost nothing.` : payable > 0 ? `Seats cost ${money(payable, o.currency)}.` : "The seats are free."} Total ${money(total!, o.currency)}.${fareNote(comparison, o.currency)}`
    : noAdjacent
      ? noAdjacentSpeech(o, family, noAdjacent)
      : `Not together yet. ${ev.violations.map((v) => `${nameOf.get(v.memberId)}: ${v.reason}`).join(" ")}`;

  return {
    kind: "seat-map",
    offerId: o.id,
    testMode: !o.liveMode,
    airline: airlineInfo(o.airline),
    route: { origin: o.origin, destination: o.destination, departingAt: o.departingAt, flightNumber: o.flightNumber },
    currency: o.currency,
    travelers,
    assignments: assignments.map((a) => ({ travelerId: a.memberId, seat: a.seat, fee: (maps.grid.seats.get(a.seat)?.fees.get(o.passengerIds[family.members.findIndex((m) => m.id === a.memberId)]) ?? 0) / 100 })),
    rows: viewRows(maps.grid, occupant, Object.values(plan.assignments)),
    together: together ? "TOGETHER" : "NOT_TOGETHER",
    violations: ev.violations.map((v) => ({ travelerId: v.memberId, reason: v.reason })),
    fare: o.totalAmount,
    seatFees: payable,
    guarantee,
    waiver,
    seatLines: guarantee ? [] : assignments.map((a) => ({ traveler: nameOf.get(a.memberId)!, seat: a.seat, fee: (maps.grid.seats.get(a.seat)?.fees.get(o.passengerIds[family.members.findIndex((m) => m.id === a.memberId)]) ?? 0) / 100 })),
    waivedFees: guarantee ? ev.fee / 100 : 0,
    togetherTotal: total,
    comparison,
    noAdjacent,
    provenance: provenanceOf(ctx, o.airline.iata, o.liveMode, false),
    voice,
  };
}

export async function showSeats(ctx: Ctx, offerId: string): Promise<SeatMapView> {
  const family = requireFamily(ctx);
  const entry = entryFor(ctx, offerId);
  const maps = await loadMaps(ctx, entry, family);
  if (!maps) throw new ToolError("no_seat_map", "This airline does not publish a seat map for the flight.", "This airline does not share a seat map, so I cannot check seating.");

  let plan = ctx.store.getPlan(ctx.account, offerId);
  if (!plan) {
    plan = {
      offerId,
      assignments: maps.solution.status === "TOGETHER" ? Object.fromEntries(maps.solution.assignments.map((a) => [a.memberId, a.seat])) : {},
      customized: false,
      updatedAt: ctx.now().toISOString(),
    };
    ctx.store.savePlan(ctx.account, plan);
  }
  return buildSeatView(ctx, entry, family, plan);
}

export interface MoveInput {
  offerId: string;
  traveler: string;
  seat?: string;
  position?: "aisle" | "window";
}

export async function moveTraveler(ctx: Ctx, input: MoveInput): Promise<SeatMapView> {
  const family = requireFamily(ctx);
  const entry = entryFor(ctx, input.offerId);
  const maps = await loadMaps(ctx, entry, family);
  if (!maps) throw new ToolError("no_seat_map", "No seat map for this flight.", "I do not have a seat map for that flight.");
  if (!ctx.store.getPlan(ctx.account, input.offerId)) await showSeats(ctx, input.offerId);
  const current = ctx.store.getPlan(ctx.account, input.offerId)!;

  const wanted = input.traveler.trim().toLowerCase();
  const matches = family.members.filter((m) => m.name.toLowerCase() === wanted || m.name.toLowerCase().startsWith(wanted));
  if (matches.length !== 1) {
    throw new ToolError("unknown_traveler", `No single traveler matches "${input.traveler}". Travelers: ${family.members.map((m) => m.name).join(", ")}.`, `I do not know who ${input.traveler} is. I have ${family.members.map((m) => m.name).join(", ")}.`);
  }
  const mover = matches[0];
  const party = partyFor(family, entry.summary.passengerIds);

  const attempt = (seat: string): Plan["assignments"] => {
    const next = { ...current.assignments };
    const holder = Object.entries(next).find(([, s]) => s === seat)?.[0];
    const previous = next[mover.id];
    next[mover.id] = seat;
    if (holder && holder !== mover.id) {
      if (previous) next[holder] = previous;
      else delete next[holder];
    }
    return next;
  };
  const check = (a: Plan["assignments"]) => evaluateAssignment(maps.grid, party, Object.entries(a).map(([memberId, seat]) => ({ memberId, seat })));

  let nextAssignments: Plan["assignments"];
  if (input.seat) {
    const seat = input.seat.trim().toUpperCase();
    if (!maps.grid.seats.has(seat)) throw new ToolError("unknown_seat", `Seat ${seat} is not on this plane.`, `There is no seat ${seat} on this plane.`);
    nextAssignments = attempt(seat);
  } else {
    const pos = input.position!;
    const rowOf = maps.grid.seats.get(current.assignments[mover.id] ?? "")?.row ?? 0;
    const candidates = [...maps.grid.seats.values()]
      .filter((s) => (pos === "aisle" ? s.aisle : s.window) && s.fees.size > 0)
      .sort((a, b) => Math.abs(a.row - rowOf) - Math.abs(b.row - rowOf) || a.row - b.row || a.designator.localeCompare(b.designator));
    const found = candidates.find((s) => check(attempt(s.designator)).together);
    if (!found) {
      throw new ToolError("no_seat_keeps_family_together", `No ${pos} seat keeps everyone beside a family member.`, `There is no ${pos} seat for ${mover.name} that keeps the children beside an adult.`);
    }
    nextAssignments = attempt(found.designator);
  }

  const plan: Plan = { ...current, assignments: nextAssignments, customized: true, updatedAt: ctx.now().toISOString() };
  ctx.store.savePlan(ctx.account, plan);
  return buildSeatView(ctx, entry, family, plan);
}

// ---------------------------------------------------------------------------------------------------------------
// book_together

export interface ElicitResult {
  action: "accept" | "decline" | "cancel";
  content?: Record<string, unknown>;
}
export type Elicit = (message: string, properties: Record<string, unknown>, required: string[]) => Promise<ElicitResult>;

function titleFor(m: FamilyMember): "mr" | "ms" | "miss" {
  return m.gender === "m" ? "mr" : m.age >= 18 ? "ms" : "miss";
}

const toolError = (e: unknown): ToolError =>
  e instanceof ToolError ? e : new ToolError("internal_error", "Something went wrong inside the add-on.", "Something went wrong on my side. I have not changed anything.");

/** Waits up to the budget for a booking. Confirmed answers with the reference, failed raises once, otherwise the booking state. */
async function settleBooking(ctx: Ctx, job: BookingJob, budgetMs = ctx.budgetMs): Promise<BookedView> {
  if (Number.isFinite(budgetMs)) await within(job.done, budgetMs);
  else await job.done;
  if (job.status === "failed") {
    job.reported = true;
    throw job.error!;
  }
  return job.status === "confirmed" ? job.view! : job.pending;
}

/**
 * Places the order and waits for the airline's reference. Runs after the family has said yes, so it re-reads the live seat
 * map once more: seats can be taken between the search and the booking, and a total that moved is never charged.
 */
async function runBooking(ctx: Ctx, job: BookingJob, family: Family, entry: OfferEntry, plan: Plan, expected: { strategy: BookedView["strategy"]; total: number }): Promise<BookedView> {
  const duffel = duffelOrThrow(ctx);
  const o = entry.summary;
  let orderId = job.orderId;
  let layout: Layout | null = null;

  if (!orderId) {
    const maps = await loadMaps(ctx, entry, family, true);
    if (!maps) throw new ToolError("no_seat_map", "No seat map for this flight.", "I cannot check seats on that flight.");
    const noAdjacent = noAdjacentFor(ctx, entry);
    if (noAdjacent) {
      throw new ToolError("no_adjacent_seats", `Not booked. ${noAdjacent.headline}: ${noAdjacent.reason}`, `I did not book. ${noAdjacentSpeech(o, family, noAdjacent)}`);
    }
    const ev = evaluateAssignment(maps.grid, partyFor(family, o.passengerIds), Object.entries(plan.assignments).map(([memberId, seat]) => ({ memberId, seat })));
    if (!ev.together) {
      const nameOf = new Map(family.members.map((m) => [m.id, m.name]));
      const why = ev.violations.map((v) => `${nameOf.get(v.memberId)}: ${v.reason}`).join(" ");
      throw new ToolError("not_together", `Not booked. The family would not sit together. ${why}`, `I did not book. ${why}`);
    }
    const waiver = waiverFor(o, family, maps.solution.status === "TOGETHER", plan.customized);
    const strategy: BookedView["strategy"] = waiver.applies ? "airline-guarantee" : "seat-services";
    const total = Math.round((o.totalAmount + (strategy === "seat-services" ? ev.fee / 100 : 0)) * 100) / 100;
    if (strategy !== expected.strategy || total !== expected.total) {
      throw new ToolError("price_changed", `Not booked. The total moved from ${money(expected.total, o.currency)} to ${money(total, o.currency)} since you agreed.`, `I did not book. The price moved from ${money(expected.total, o.currency)} to ${money(total, o.currency)}. Ask me again if you still want it.`);
    }
    const serviceIds =
      strategy === "seat-services"
        ? Object.entries(plan.assignments).map(([memberId, seat]) => {
            const idx = family.members.findIndex((m) => m.id === memberId);
            const id = maps.grid.seats.get(seat)?.serviceIds.get(o.passengerIds[idx]);
            if (!id) throw new ToolError("seat_unavailable", `Seat ${seat} cannot be booked.`, `Seat ${seat} is no longer available.`);
            return id;
          })
        : [];
    layout = layoutOf(maps.grid);
    const created = await wrapDuffel(
      duffel.createOrder({
        offerId: o.id,
        passengers: family.members.map((m, i) => ({
          passengerId: o.passengerIds[i],
          title: titleFor(m),
          givenName: m.name,
          familyName: family.familyName!,
          bornOn: m.bornOn!,
          gender: m.gender!,
          email: family.email!,
          phoneNumber: family.phoneNumber!,
        })),
        serviceIds,
        amount: total.toFixed(2),
        currency: o.currency,
      }),
    );
    orderId = created.orderId;
    job.orderId = orderId;
  }

  // An accepted order request is not a booking. Wait for the airline's booking reference.
  let detail = await wrapDuffel(duffel.getOrder(orderId));
  for (let i = 1; !detail.bookingReference && i < ctx.poll.attempts; i++) {
    await new Promise((r) => setTimeout(r, ctx.poll.delayMs));
    detail = await wrapDuffel(duffel.getOrder(orderId));
  }
  if (!detail.bookingReference) {
    throw new ToolError("order_pending", `Order ${orderId} was accepted but has no booking reference yet.`, "The order is still pending with the airline. I have not got a booking reference yet.");
  }

  const seatsByMember: Record<string, string | null> = {};
  const passengerIds: Record<string, string> = {};
  family.members.forEach((m, i) => {
    passengerIds[m.id] = o.passengerIds[i];
    seatsByMember[m.id] = detail.seats[o.passengerIds[i]] ?? null;
  });

  const booked: BookedOrder = {
    orderId,
    bookingReference: detail.bookingReference,
    offerId: o.id,
    strategy: expected.strategy,
    passengerIds,
    seats: seatsByMember,
    layout: layout ?? (entry.maps ? layoutOf(entry.maps.grid) : {}),
    members: family.members,
    airline: o.airline,
    cabinClass: o.cabinClass,
    route: { origin: o.origin, destination: o.destination, departingAt: o.departingAt },
    currency: detail.currency,
    total: detail.totalAmount,
    liveMode: detail.liveMode,
    createdAt: ctx.now().toISOString(),
  };
  ctx.store.saveOrder(ctx.account, booked);

  const seats = family.members.map((m) => ({ name: m.name, seat: seatsByMember[m.id] }));
  return {
    kind: "booked",
    offerId: o.id,
    status: "confirmed",
    orderId: booked.orderId,
    bookingReference: booked.bookingReference,
    testMode: !booked.liveMode,
    airline: airlineInfo(o.airline),
    route: booked.route,
    currency: booked.currency,
    total: booked.total,
    seats,
    strategy: expected.strategy,
    provenance: provenanceOf(ctx, o.airline.iata, booked.liveMode, true),
    voice: `Booked. Reference ${booked.bookingReference.split("").join(" ")}. ${expected.strategy === "seat-services" ? seatList(seats) + "." : `${o.airline.name} will seat your child beside an adult at no fee.`} Total ${money(booked.total, booked.currency)}.`,
  };
}

export async function bookTogether(ctx: Ctx, input: { offerId: string; confirmed: boolean }, elicit: Elicit | null): Promise<BookedView> {
  // A repeat for the same offer is a question about the booking, never a second order.
  const existing = ctx.bookings.get(input.offerId);
  if (existing && existing.status !== "failed") return settleBooking(ctx, existing);
  if (existing?.status === "failed" && !existing.reported) {
    existing.reported = true;
    throw existing.error!;
  }
  // The airline accepted that order and had no reference yet: a retry resumes it rather than placing a second one.
  const resume = existing?.status === "failed" ? existing.orderId : undefined;

  let family = requireFamily(ctx);
  duffelOrThrow(ctx);
  const entry = entryFor(ctx, input.offerId);
  const o = entry.summary;

  if (expired(ctx, o)) throw new ToolError("offer_expired", "That fare has expired.", "That fare expired. Let me search again.");

  // Cheap checks first, from the seat map the search already read. The live re-read happens after the family says yes.
  const maps = await loadMaps(ctx, entry, family);
  if (!maps) throw new ToolError("no_seat_map", "No seat map for this flight.", "I cannot check seats on that flight.");
  const noAdjacent = noAdjacentFor(ctx, entry);
  if (noAdjacent) {
    throw new ToolError("no_adjacent_seats", `Not booked. ${noAdjacent.headline}: ${noAdjacent.reason}`, `I did not book. ${noAdjacentSpeech(o, family, noAdjacent)}`);
  }
  const plan = ctx.store.getPlan(ctx.account, o.id);
  if (!plan) throw new ToolError("no_plan", "No seats have been chosen for this fare yet.", "Let me show you the seats first.");

  const party = partyFor(family, o.passengerIds);
  const ev = evaluateAssignment(maps.grid, party, Object.entries(plan.assignments).map(([memberId, seat]) => ({ memberId, seat })));
  if (!ev.together) {
    const nameOf = new Map(family.members.map((m) => [m.id, m.name]));
    const why = ev.violations.map((v) => `${nameOf.get(v.memberId)}: ${v.reason}`).join(" ");
    throw new ToolError("not_together", `Not booked. The family would not sit together. ${why}`, `I did not book. ${why}`);
  }

  const waiver = waiverFor(o, family, maps.solution.status === "TOGETHER", plan.customized);
  const strategy: BookedView["strategy"] = waiver.applies ? "airline-guarantee" : "seat-services";
  const seatFee = strategy === "seat-services" ? ev.fee / 100 : 0;
  const total = Math.round((o.totalAmount + seatFee) * 100) / 100;

  // Passenger details the airline requires. Ask for what is missing instead of guessing.
  const missing: Array<{ key: string; label: string; member?: FamilyMember; field: string }> = [];
  for (const m of family.members) {
    if (!m.bornOn) missing.push({ key: `${m.id}_born_on`, label: `${m.name}'s date of birth`, member: m, field: "bornOn" });
    if (!m.gender) missing.push({ key: `${m.id}_gender`, label: `${m.name}'s gender on the passport`, member: m, field: "gender" });
  }
  if (!family.familyName) missing.push({ key: "family_name", label: "Family name", field: "familyName" });
  if (!family.email) missing.push({ key: "email", label: "Contact email", field: "email" });
  if (!family.phoneNumber) missing.push({ key: "phone_number", label: "Contact phone number with country code", field: "phoneNumber" });

  if (missing.length) {
    if (!elicit) {
      throw new ToolError("missing_passenger_details", `Passenger details are missing: ${missing.map((m) => m.label).join(", ")}. Save them with save_family.`, `I need ${missing.map((m) => m.label).join(", ")} before I can book.`);
    }
    const props: Record<string, unknown> = {};
    for (const m of missing) {
      props[m.key] =
        m.field === "bornOn" ? { type: "string", format: "date", title: m.label }
        : m.field === "gender" ? { type: "string", enum: ["m", "f"], enumNames: ["Male", "Female"], title: m.label }
        : m.field === "email" ? { type: "string", format: "email", title: m.label }
        : { type: "string", title: m.label };
    }
    const r = await elicit("The airline needs a few passenger details to book.", props, missing.map((m) => m.key));
    if (r.action !== "accept" || !r.content) {
      throw new ToolError("details_declined", "Passenger details were not provided.", "Okay, I have not booked anything.");
    }
    const next: Family = { ...family, members: family.members.map((m) => ({ ...m })) };
    for (const m of missing) {
      const v = r.content[m.key];
      if (typeof v !== "string" || !v.trim()) throw new ToolError("details_incomplete", `${m.label} was empty.`, `${m.label} was missing, so I have not booked.`);
      if (m.member) {
        const target = next.members.find((x) => x.id === m.member!.id)!;
        if (m.field === "bornOn") target.bornOn = v.trim();
        else target.gender = v === "f" ? "f" : "m";
      } else (next as unknown as Record<string, string>)[m.field] = v.trim();
    }
    ctx.store.saveFamily(ctx.account, next);
    family = next;
  }

  // Confirm the spend.
  const summary = `Book ${family.members.length} seats on ${o.airline.name} ${o.flightNumber ?? ""} ${o.origin} to ${o.destination} for ${money(total, o.currency)}?`;
  if (elicit) {
    const r = await elicit(summary, { confirm: { type: "boolean", title: "Book these seats now" } }, ["confirm"]);
    if (r.action !== "accept" || r.content?.confirm !== true) throw new ToolError("not_confirmed", "Booking was not confirmed.", "Okay, I have not booked anything.");
  } else if (!input.confirmed) {
    throw new ToolError("confirmation_required", `${summary} Call again with confirmed true to book.`, `${summary} Say yes to book it.`);
  }

  // From here the airline's clock runs, not ours: answer with the booking state and finish the order in the background.
  const planned = family.members.map((m) => ({ name: m.name, seat: strategy === "seat-services" ? (plan.assignments[m.id] ?? null) : null }));
  const flight = `${o.airline.name} ${o.flightNumber ?? ""}`.trim();
  const job: BookingJob = {
    offerId: o.id,
    status: "booking",
    pending: {
      kind: "booked",
      offerId: o.id,
      status: "booking",
      orderId: null,
      bookingReference: null,
      testMode: !o.liveMode,
      airline: airlineInfo(o.airline),
      route: { origin: o.origin, destination: o.destination, departingAt: o.departingAt },
      currency: o.currency,
      total,
      seats: planned,
      strategy,
      provenance: provenanceOf(ctx, o.airline.iata, o.liveMode, false),
      voice: `I am booking ${flight} for ${money(total, o.currency)} now. The reference comes back in a few seconds and the screen shows it. Ask me again if you want it read out.`,
    },
    ...(resume ? { orderId: resume } : {}),
    reported: false,
    done: Promise.resolve(),
  };
  job.done = runBooking(ctx, job, family, entry, plan, { strategy, total }).then(
    (view) => {
      job.view = view;
      job.status = "confirmed";
    },
    (e: unknown) => {
      job.status = "failed";
      job.error = toolError(e);
      if (!(e instanceof ToolError)) console.error("booking failed:", e instanceof Error ? e.message : e);
    },
  );
  ctx.bookings.set(o.id, job);
  return settleBooking(ctx, job);
}

// ---------------------------------------------------------------------------------------------------------------
// still_together

/** Seats of a booked order's seat map that let the whole family sit together again, keeping what they already hold at no cost. */
async function proposeReseat(ctx: Ctx, stored: BookedOrder, current: Record<string, string | null>, currency: string): Promise<Reseat> {
  const duffel = duffelOrThrow(ctx);
  let raw: SeatMap[];
  try {
    raw = await duffel.seatMaps(stored.offerId);
  } catch (e) {
    if (e instanceof DuffelApiError) return { status: "unavailable", reason: `${stored.airline.name} did not return its seat map for this booking (${e.code}).` };
    throw e;
  }
  const map = raw[0];
  if (!map) return { status: "unavailable", reason: `${stored.airline.name} no longer shows a seat map for this booking.` };
  const grid = buildGrid(map, { cabinClass: stored.cabinClass });
  const party: PartyMember[] = stored.members.map((m) => ({ id: m.id, passengerId: stored.passengerIds[m.id], age: m.age }));
  for (const m of stored.members) {
    const held = current[m.id];
    const seat = held ? grid.seats.get(held) : undefined;
    if (seat) seat.fees.set(stored.passengerIds[m.id], 0);
  }
  const sol = solveSeating(grid, party);
  if (sol.status !== "TOGETHER") return { status: "unavailable", reason: "No open seats on this flight put every child beside an adult." };
  const nameOf = new Map(stored.members.map((m) => [m.id, m.name]));
  const moves = sol.assignments
    .filter((a) => a.seat !== current[a.memberId])
    .map((a) => ({ name: nameOf.get(a.memberId)!, from: current[a.memberId] ?? null, to: a.seat, fee: a.fee / 100 }));
  const fee = Math.round(moves.reduce((t, m) => t + m.fee, 0) * 100) / 100;
  return { status: "proposal", moves, fee, currency, guaranteeApplies: dotFeeFreeAdjacent(stored.airline.iata) === true };
}

/** The rows of the booked cabin that hold the family now, each flagged traveler's former seat and any proposed seat. */
function statusCabin(grid: Grid, stored: BookedOrder, current: Record<string, string | null>, affected: AffectedTraveler[], reseat: Reseat | null): StatusCabin | undefined {
  const idOf = new Map(stored.members.map((m) => [m.name, m.id]));
  const occupant = new Map(stored.members.filter((m) => current[m.id]).map((m) => [current[m.id]!, m.id]));
  const former = affected.filter((a) => a.from && a.from !== a.seat).map((a) => ({ travelerId: idOf.get(a.name)!, seat: a.from! }));
  const proposed = reseat?.status === "proposal" ? reseat.moves.map((m) => m.to) : [];
  const window = [...occupant.keys(), ...former.map((f) => f.seat), ...proposed].filter((d) => grid.seats.has(d));
  if (!window.length) return undefined;
  const distinct = new Set(window.map((d) => grid.seats.get(d)!.row)).size;
  // Two rows of context around a short window, never fewer rows than the window needs.
  const rows = viewRows(grid, occupant, window, Math.max(distinct, Math.min(distinct + 2, 5)));
  return { rows, travelers: stored.members.map(toTraveler), former, proposed };
}

/** One live reading of a booked order against the seats it was booked with. Slow: it asks the airline. */
async function liveStatus(ctx: Ctx, stored: BookedOrder): Promise<StatusView> {
  const duffel = duffelOrThrow(ctx);
  const detail = await wrapDuffel(duffel.getOrder(stored.orderId));
  const party: PartyMember[] = stored.members.map((m) => ({ id: m.id, passengerId: stored.passengerIds[m.id], age: m.age }));

  // What the airline says now. An unanswered airline-initiated change that moves a seat counts as the airline's decision.
  const proposed = new Map<string, { from: string | null; to: string | null }>();
  for (const ch of detail.pendingChanges) for (const sc of ch.seatChanges) proposed.set(sc.passengerId, { from: sc.from, to: sc.to });
  const current: Record<string, string | null> = {};
  for (const m of stored.members) {
    const pid = stored.passengerIds[m.id];
    current[m.id] = proposed.has(pid) ? proposed.get(pid)!.to : (detail.seats[pid] ?? null);
  }

  const changes: SeatChange[] = [];
  for (const m of stored.members) {
    const pid = stored.passengerIds[m.id];
    const via: SeatChange["via"] = [];
    // A first assignment under a fee-free commitment (no seat bought, then the airline assigns) is not a move.
    if (stored.seats[m.id] === null) continue;
    if (stored.seats[m.id] !== (detail.seats[pid] ?? null)) via.push("order");
    if (proposed.has(pid) && stored.seats[m.id] !== proposed.get(pid)!.to) via.push("airline-change");
    if (via.length) changes.push({ name: m.name, from: stored.seats[m.id] ?? null, to: current[m.id], via });
  }

  const unassigned = stored.members.filter((m) => current[m.id] === null);
  const grid = gridFromLayout(stored.layout);
  const known = stored.members.filter((m) => current[m.id] && grid.seats.has(current[m.id]!));
  const ev = evaluateAssignment(grid, party.filter((p) => known.some((k) => k.id === p.id)), known.map((m) => ({ memberId: m.id, seat: current[m.id]! })), { adjacencyOnly: true });
  const together = unassigned.length === 0 && known.length === stored.members.length && ev.together;

  const seats = stored.members.map((m) => ({ name: m.name, seat: current[m.id] }));
  const nameOf = new Map(stored.members.map((m) => [m.id, m.name]));
  const byId = new Map(stored.members.map((m) => [m.id, m]));
  const affected: AffectedTraveler[] = ev.violations
    .filter((v) => v.reason.includes("no adult"))
    .map((v) => ({ name: nameOf.get(v.memberId)!, role: toTraveler(byId.get(v.memberId)!).role, seat: current[v.memberId], from: stored.seats[v.memberId] ?? null, reason: v.reason }));

  // Seats the airline assigned after a fee-free booking become the baseline later checks are measured against.
  const unseated = stored.members.some((m) => stored.seats[m.id] === null);
  if (stored.strategy === "airline-guarantee" && unseated && stored.members.every((m) => detail.seats[stored.passengerIds[m.id]]) && together) {
    ctx.store.saveOrder(ctx.account, { ...stored, seats: Object.fromEntries(stored.members.map((m) => [m.id, detail.seats[stored.passengerIds[m.id]]])) });
  }

  const reseat = !together && unassigned.length === 0 && affected.length ? await proposeReseat(ctx, stored, current, detail.currency) : null;
  const cabin = statusCabin(grid, stored, current, affected, reseat);
  const airlineChanges = { open: detail.pendingChanges.length, scheduleChanged: detail.pendingChanges.some((c) => c.scheduleChanged) };

  let voice: string;
  if (unassigned.length) {
    voice = `${stored.airline.name} has not assigned seats yet for ${unassigned.map((m) => m.name).join(" and ")}. ${stored.strategy === "airline-guarantee" ? `Under its family seating policy it must seat a child beside an adult at no fee, and I will check again.` : "I will check again."}`;
  } else if (together) {
    voice = changes.length ? `Yes, you are still sitting together, although seats moved: ${changes.map((c) => `${c.name} ${c.from ?? "none"} to ${c.to}`).join(", ")}.` : `Yes. ${seatList(seats)}. Nothing has changed.`;
  } else {
    const alone = affected.map((a) => a.name);
    voice = changes.length
      ? `No. ${changes.map((c) => `${c.name} moved from ${c.from ?? "none"} to ${c.to}`).join(", ")}.${alone.length ? ` ${alone.join(" and ")} ${alone.length > 1 ? "are" : "is"} no longer beside an adult.` : ""}`
      : `No. ${affected.map((a) => `${a.name} is in ${a.seat}, not beside an adult`).join(". ")}.`;
    if (reseat?.status === "proposal") {
      const how = reseat.moves.map((m) => `${m.name} to ${m.to}`).join(", ");
      voice += ` I can see seats that put everyone together again: ${how}. ${
        reseat.guaranteeApplies
          ? `${stored.airline.name}'s family seating commitment covers a child beside an adult at no fee, so ask them to make that change.`
          : `${reseat.fee > 0 ? `That is ${money(reseat.fee, reseat.currency)} in seat fees. ` : "There is no seat fee. "}Ask ${stored.airline.name} to make that change.`
      }`;
    } else if (reseat) {
      voice += ` ${reseat.reason} Ask ${stored.airline.name} to seat ${affected.map((a) => a.name).join(" and ")} beside an adult.`;
    }
  }
  if (airlineChanges.open) voice += ` ${stored.airline.name} ${airlineChanges.scheduleChanged ? "also changed the itinerary and" : "sent a change to your booking and"} is waiting for your response.`;

  return {
    kind: "together-status",
    orderId: stored.orderId,
    bookingReference: stored.bookingReference,
    airline: airlineInfo(stored.airline),
    together,
    seats,
    changes,
    affected,
    reseat,
    cabin,
    airlineChanges,
    checkedAt: ctx.now().toISOString(),
    refreshing: false,
    provenance: provenanceOf(ctx, stored.airline.iata, detail.liveMode, true),
    voice,
  };
}

const ago = (ms: number) => {
  const s = Math.max(1, Math.round(ms / 1000));
  return s < 90 ? `${s} seconds ago` : `${Math.round(s / 60)} minutes ago`;
};

/** What is known of an order with no live reading yet: the seats it was booked with. */
function bookedStatus(ctx: Ctx, stored: BookedOrder): StatusView {
  const seats = stored.members.map((m) => ({ name: m.name, seat: stored.seats[m.id] ?? null }));
  const seated = seats.every((s) => s.seat);
  return {
    kind: "together-status",
    orderId: stored.orderId,
    bookingReference: stored.bookingReference,
    airline: airlineInfo(stored.airline),
    together: seated,
    seats,
    changes: [],
    affected: [],
    reseat: null,
    airlineChanges: { open: 0, scheduleChanged: false },
    checkedAt: stored.createdAt,
    refreshing: true,
    provenance: provenanceOf(ctx, stored.airline.iata, stored.liveMode, true),
    voice: seated
      ? `You booked ${seatList(seats)}. I am checking with ${stored.airline.name} for changes and the screen updates when it answers.`
      : `You are booked on ${stored.airline.name}, reference ${stored.bookingReference}. I am checking with them for seats and the screen updates when it answers.`,
  };
}

/**
 * The still-together check, answered inside the budget. A fresh reading is started (or joined) every time; if it lands in
 * time it is the answer, otherwise the last reading is returned marked as refreshing, with how old it is, and the next
 * call or the view picks up the fresh one.
 */
export async function checkTrip(ctx: Ctx, orderId?: string, opts: { budgetMs?: number; fresh?: boolean } = {}): Promise<StatusView | BookedView> {
  const budgetMs = opts.budgetMs ?? ctx.budgetMs;
  duffelOrThrow(ctx);
  const stored = orderId ? ctx.store.getOrder(ctx.account, orderId) : ctx.store.latestOrder(ctx.account);
  if (!stored) {
    const placing = [...ctx.bookings.values()].find((j) => j.status === "booking");
    if (placing && !orderId) return settleBooking(ctx, placing, budgetMs);
    throw new ToolError("no_booking", "No booked trip found.", "I do not see a booked trip yet.");
  }
  const id = stored.orderId;
  const known = ctx.statusCache.get(id);
  if (known && !opts.fresh && ctx.now().getTime() - new Date(known.checkedAt).getTime() < ctx.statusFreshMs) return known;
  let reading = ctx.refreshing.get(id);
  if (!reading) {
    reading = liveStatus(ctx, stored).then((v) => {
      ctx.statusCache.set(id, v);
      return v;
    });
    const mine = reading;
    const clear = () => {
      if (ctx.refreshing.get(id) === mine) ctx.refreshing.delete(id);
    };
    mine.then(clear, clear);
    ctx.refreshing.set(id, mine);
  }
  const r = Number.isFinite(budgetMs) ? await within(reading, budgetMs) : { done: true as const, value: await reading };
  if (r.done) return r.value;
  const last = ctx.statusCache.get(id);
  if (!last) return bookedStatus(ctx, stored);
  return { ...last, refreshing: true, voice: `As of ${ago(ctx.now().getTime() - new Date(last.checkedAt).getTime())}: ${last.voice} I am checking again.` };
}

/** The same check for callers that need the reading itself: waits for the fresh one. */
export async function stillTogether(ctx: Ctx, orderId?: string): Promise<StatusView> {
  const v = await checkTrip(ctx, orderId, { budgetMs: Number.POSITIVE_INFINITY, fresh: true });
  if (v.kind !== "together-status") throw new ToolError("booking_in_progress", "The booking is still being placed.", "Your booking is still being confirmed.");
  return v;
}
