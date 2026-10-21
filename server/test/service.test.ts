import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { OffersView } from "../src/domain.js";
import { bookTogether, createCtx, findFamilyFlights, moveTraveler, saveFamily, showSeats, stillTogether, type Ctx, type Elicit } from "../src/service.js";
import { openStore } from "../src/store.js";
import { buildGrid } from "../src/seatmap.js";
import { evaluateAssignment } from "../src/solver.js";
import { FakeDuffel, NOW, SCENARIOS, type Scenario } from "./fixtures/fake-duffel.js";

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

let fake: FakeDuffel;
let ctx: Ctx;

function fresh(store = openStore(":memory:")) {
  fake = new FakeDuffel();
  ctx = createCtx({ duffel: fake, store, now: () => NOW, poll: { attempts: 4, delayMs: 1 } });
}
beforeEach(() => {
  fresh();
});

async function searched(): Promise<OffersView> {
  saveFamily(ctx, FAMILY);
  return findFamilyFlights(ctx, SEARCH);
}

describe("save_family", () => {
  it("stores the party and tells the traveler which children will be kept beside an adult", () => {
    const v = saveFamily(ctx, FAMILY);
    expect(v.party.map((t) => [t.name, t.role])).toEqual([["Dad", "adult"], ["Mum", "adult"], ["Mia", "child"], ["Leo", "child"]]);
    expect(v.voice).toMatch(/Mia and Leo beside an adult/);
    expect(v.missingForBooking).toEqual([]);
    expect(ctx.store.getFamily("default")!.members).toHaveLength(4);
  });
  it("lists what is still missing for booking", () => {
    const v = saveFamily(ctx, { travelers: [{ name: "Dad", age: 40 }, { name: "Mia", age: 6 }] });
    expect(v.missingForBooking).toContain("Mia's date of birth");
    expect(v.missingForBooking).toContain("contact email");
  });
  it("rejects a party with no adult, a lap infant and duplicate names", () => {
    expect(() => saveFamily(ctx, { travelers: [{ name: "Mia", age: 6 }] })).toThrowError(/18 or older/);
    expect(() => saveFamily(ctx, { travelers: [{ name: "Dad", age: 40 }, { name: "Baby", age: 1 }] })).toThrowError(/Lap infants/);
    expect(() => saveFamily(ctx, { travelers: [{ name: "Sam", age: 40 }, { name: "sam", age: 6 }] })).toThrowError(/Two travelers/);
  });
});

describe("find_family_flights", () => {
  it("ranks by together-total: JetBlue $0 seats under the DOT guarantee, Delta +$90, United cannot seat the family", async () => {
    const v = await searched();
    expect(v.testMode).toBe(true);
    expect(v.searched).toBe(4);
    const by = Object.fromEntries(v.offers.map((o) => [o.airline.iata, o]));
    expect(v.offers.map((o) => o.airline.iata)).toEqual(["B6", "DL", "ZZ", "UA"]);

    expect(by.B6).toMatchObject({ guarantee: true, seatFees: 0, togetherTotal: 812, together: "TOGETHER", deltaVsCheapestFare: 52 });
    expect(by.DL).toMatchObject({ guarantee: false, seatFees: 90, togetherTotal: 850, together: "TOGETHER", deltaVsCheapestFare: 90 });
    expect(by.ZZ).toMatchObject({ guarantee: false, seatFees: 0, togetherTotal: 1010, airline: { dotFeeFreeAdjacent: null } });
    expect(by.UA).toMatchObject({ together: "NOT_TOGETHER", togetherTotal: null, deltaVsCheapestFare: null });
    expect(by.UA.airline.dotFeeFreeAdjacent).toBe(false);
    expect(v.voice).toMatch(/JetBlue/);
  });

  it("labels the offer, seat map, DOT rule and booking, and says how many offers were evaluated", async () => {
    const v = await searched();
    expect(v.provenance).toEqual({
      source: "fixture",
      offer: "test",
      seatMap: "test",
      rule: { listed: true, url: "https://www.transportation.gov/airconsumer/airline-family-seating-dashboard", readOn: "2026-10-21", dashboardUpdated: "2025-09-05" },
      booking: { mode: "test", placed: false },
    });
    expect([v.searched, v.evaluated, v.moreAvailable]).toEqual([4, 4, false]);
  });

  it("evaluated counts only flights whose seat map was read; a flight without one is not ranked", async () => {
    saveFamily(ctx, FAMILY);
    fake.noSeatMap.add("off_united");
    const v = await findFamilyFlights(ctx, SEARCH);
    expect([v.searched, v.evaluated]).toEqual([4, 3]);
    expect(v.offers.map((o) => o.airline.iata)).not.toContain("UA");
    expect(v.voice).not.toMatch(/United/);
  });

  it("says when more fares exist than were evaluated", async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ ...SCENARIOS[1], id: `off_many_${i}`, fare: 700 + i }));
    fake = new FakeDuffel(many);
    ctx = createCtx({ duffel: fake, store: openStore(":memory:"), now: () => NOW });
    saveFamily(ctx, FAMILY);
    const v = await findFamilyFlights(ctx, SEARCH);
    expect([v.searched, v.evaluated, v.moreAvailable]).toEqual([10, 10, true]);
  });

  it("the label follows the data's mode, never a constant", async () => {
    fake.live = true;
    const v = await searched();
    expect(v.testMode).toBe(false);
    expect(v.provenance).toMatchObject({ offer: "live", seatMap: "live", booking: { mode: "live" } });
    const seats = await showSeats(ctx, "off_delta");
    expect(seats.provenance).toMatchObject({ offer: "live", seatMap: "live" });
  });

  it("the cheapest fare is not the cheapest way to sit together", async () => {
    const v = await searched();
    const cheapestFare = [...v.offers].sort((a, b) => a.fare - b.fare)[0];
    const best = v.offers[0];
    expect(cheapestFare.airline.iata).toBe("DL");
    expect(best.airline.iata).toBe("B6");
    expect(best.togetherTotal!).toBeLessThan(cheapestFare.togetherTotal!);
  });

  it("the seat map shows the lowest fare and the family total side by side, and names who wins", async () => {
    await searched();
    const jb = await showSeats(ctx, "off_jetblue");
    expect(jb.comparison!.cheapestFareLoses).toBe(true);
    const by = Object.fromEntries(jb.comparison!.rows.map((r) => [r.airline.iata, r]));
    expect(by.DL).toMatchObject({ fare: 760, seatFees: 90, familyTotal: 850, tags: ["cheapest-fare"] });
    expect(by.B6).toMatchObject({ fare: 812, seatFees: 0, guarantee: true, familyTotal: 812, tags: ["this-flight", "lowest-total"] });
    expect(jb.voice).toMatch(/Delta has the lowest fare at \$760, but \$850 for your family to sit together\. JetBlue is the lowest family total at \$812\./);

    const dl = await showSeats(ctx, "off_delta");
    const dlBy = Object.fromEntries(dl.comparison!.rows.map((r) => [r.airline.iata, r]));
    expect(dlBy.DL.tags).toEqual(["cheapest-fare", "this-flight"]);
    expect(dlBy.B6.tags).toEqual(["lowest-total"]);
    expect(dl.voice).toMatch(/JetBlue is the lowest family total at \$812/);
  });

  it("the comparison follows a hand edit: a paid parent move on JetBlue ends the $0 shortcut and the family total rises", async () => {
    await searched();
    await showSeats(ctx, "off_jetblue");
    const moved = await moveTraveler(ctx, { offerId: "off_jetblue", traveler: "Dad", position: "aisle" });
    const row = moved.comparison!.rows.find((r) => r.tags.includes("this-flight"))!;
    expect(row.familyTotal).toBe(moved.togetherTotal);
    expect(row.seatFees).toBe(moved.seatFees);
  });

  it("when the lowest fare cannot seat the family at all, the comparison says so instead of pricing it", async () => {
    fake = new FakeDuffel([SCENARIOS[2], SCENARIOS[0]]);
    ctx = createCtx({ duffel: fake, store: openStore(":memory:"), now: () => NOW });
    saveFamily(ctx, FAMILY);
    await findFamilyFlights(ctx, SEARCH);
    const jb = await showSeats(ctx, "off_jetblue");
    const ua = jb.comparison!.rows.find((r) => r.airline.iata === "UA")!;
    expect(ua).toMatchObject({ fare: 795, familyTotal: null, seatFees: null, tags: ["cheapest-fare"] });
    expect(jb.comparison!.cheapestFareLoses).toBe(true);
    expect(jb.voice).toMatch(/United has the lowest fare at \$795, but your family cannot sit together on it/);
  });

  it("a search with one result has nothing to compare", async () => {
    fake = new FakeDuffel([SCENARIOS[0]]);
    ctx = createCtx({ duffel: fake, store: openStore(":memory:"), now: () => NOW });
    saveFamily(ctx, FAMILY);
    await findFamilyFlights(ctx, SEARCH);
    expect((await showSeats(ctx, "off_jetblue")).comparison).toBeNull();
  });

  it("fails clearly with no saved family and with no Duffel token, and calls nothing", async () => {
    await expect(findFamilyFlights(ctx, SEARCH)).rejects.toMatchObject({ code: "family_missing" });
    const noToken = createCtx({ duffel: null, store: openStore(":memory:"), now: () => NOW });
    saveFamily(noToken, FAMILY);
    await expect(findFamilyFlights(noToken, SEARCH)).rejects.toMatchObject({ code: "duffel_not_configured" });
    expect(fake.calls).toEqual([]);
  });
});

const col = (d: string) => d.replace(/^\d+/, "");
const rowNo = (d: string) => parseInt(d, 10);

function onlyFlights(scenarios: Scenario[]) {
  fake = new FakeDuffel(scenarios);
  ctx = createCtx({ duffel: fake, store: openStore(":memory:"), now: () => NOW, poll: { attempts: 3, delayMs: 1 } });
  saveFamily(ctx, FAMILY);
}

describe("a child is never booked without an adjacent adult", () => {
  it("a plan that seats Mia and Leo only beside each other is refused and creates no order", async () => {
    await searched();
    await showSeats(ctx, "off_duffel_airways");
    const plan = ctx.store.getPlan("default", "off_duffel_airways")!;
    ctx.store.savePlan("default", { ...plan, customized: true, assignments: { mia: "10B", leo: "10C", dad: "10D", mum: "10E" } });
    const err = await bookTogether(ctx, { offerId: "off_duffel_airways", confirmed: true }, null).catch((e) => e);
    expect(err).toMatchObject({ code: "not_together" });
    expect(err.message).toMatch(/Mia: Seat 10B has no adult beside it/);
    expect(err.message).toMatch(/Leo: Seat 10C has no adult beside it/);
    expect(fake.orders.size).toBe(0);
    expect(fake.calls).not.toContain("createOrder");
    // control: the same cabin books once the children touch an adult
    ctx.store.savePlan("default", { ...plan, customized: true, assignments: { mia: "10B", dad: "10C", mum: "10D", leo: "10E" } });
    await expect(bookTogether(ctx, { offerId: "off_duffel_airways", confirmed: true }, null)).resolves.toMatchObject({ kind: "booked" });
  });

  it("a child left without any seat in the plan is refused", async () => {
    await searched();
    await showSeats(ctx, "off_duffel_airways");
    const plan = ctx.store.getPlan("default", "off_duffel_airways")!;
    const { mia: _mia, ...rest } = plan.assignments;
    ctx.store.savePlan("default", { ...plan, assignments: rest });
    await expect(bookTogether(ctx, { offerId: "off_duffel_airways", confirmed: true }, null)).rejects.toMatchObject({ code: "not_together" });
    expect(fake.orders.size).toBe(0);
  });

  it("the DOT guarantee does not book a flight with no adjacent seats: JetBlue with every pair taken is refused", async () => {
    onlyFlights([{ ...SCENARIOS[0], taken: (d) => !["A", "D"].includes(col(d)) || rowNo(d) % 2 === 0 }]);
    const found = await findFamilyFlights(ctx, SEARCH);
    expect(found.offers[0]).toMatchObject({ together: "NOT_TOGETHER", guarantee: false, togetherTotal: null });
    const err = await bookTogether(ctx, { offerId: "off_jetblue", confirmed: true }, null).catch((e) => e);
    expect(err).toMatchObject({ code: "no_adjacent_seats" });
    expect(fake.orders.size).toBe(0);
    expect(fake.calls).not.toContain("createOrder");
  });
});

describe("no adjacent seats on the flight", () => {
  it("says so plainly, seats nobody, prices nothing, and offers the flights that do seat the family, cheapest total first", async () => {
    await searched();
    const v = await showSeats(ctx, "off_united");
    expect(v.together).toBe("NOT_TOGETHER");
    expect(v.assignments).toEqual([]);
    expect(v.togetherTotal).toBeNull();
    expect(v.noAdjacent).toMatchObject({ headline: "No adjacent seats on this flight", reason: "No two open seats are side by side." });
    expect(v.noAdjacent!.alternatives.map((a) => [a.airline.iata, a.familyTotal])).toEqual([["B6", 812], ["DL", 850]]);
    expect(v.voice).toBe("There are no adjacent seats on United UA102 for Mia and Leo to sit beside an adult. JetBlue seats everyone together for $812.");
  });

  it("with no other flight that works, it says that instead of inventing an alternative", async () => {
    onlyFlights([SCENARIOS[2]]);
    await findFamilyFlights(ctx, SEARCH);
    const v = await showSeats(ctx, "off_united");
    expect(v.noAdjacent!.alternatives).toEqual([]);
    expect(v.voice).toMatch(/no adjacent seats on United UA100/);
    expect(v.voice).toMatch(/No other flight in this search seats your family together\.$/);
  });

  it("a flight that works never carries the finding", async () => {
    await searched();
    expect((await showSeats(ctx, "off_delta")).noAdjacent).toBeNull();
  });

  it("book_together on it is refused with the same words and no order", async () => {
    await searched();
    const err = await bookTogether(ctx, { offerId: "off_united", confirmed: true }, null).catch((e) => e);
    expect(err).toMatchObject({ code: "no_adjacent_seats" });
    expect(err.voice).toMatch(/^I did not book\. There are no adjacent seats on United UA102/);
    expect(fake.orders.size).toBe(0);
  });
});

describe("a DOT-listed carrier does not get $0 seats unless the dashboard's conditions hold", () => {
  const JB = SCENARIOS[0];
  const fares = async () => (await findFamilyFlights(ctx, SEARCH)).offers[0];

  it("ranking states the waiver per carrier: JetBlue applies, Delta has no commitment, an unlisted carrier is not assumed", async () => {
    const v = await searched();
    const by = Object.fromEntries(v.offers.map((o) => [o.airline.iata, o.waiver.code]));
    expect(by).toEqual({ B6: "applies", DL: "carrier_no_commitment", ZZ: "carrier_not_listed", UA: "carrier_no_commitment" });
  });

  it("no traveler 13 or under: JetBlue's seats are not waived and are paid for, even though the carrier is listed", async () => {
    onlyFlights([JB]);
    saveFamily(ctx, { travelers: [{ name: "Dad", age: 40, gender: "m", bornOn: "1986-03-02" }, { name: "Zoe", age: 14, gender: "f", bornOn: "2012-05-11" }], familyName: "Rivera", email: "family@example.com", phoneNumber: "+12125550123" });
    const card = await fares();
    expect(card).toMatchObject({ guarantee: false, seatFees: 36, togetherTotal: 848, waivedFees: 0 });
    expect(card.waiver).toMatchObject({ applies: false, code: "no_young_child" });
    expect(card.seatLines).toEqual([{ traveler: "Dad", seat: expect.any(String), fee: 18 }, { traveler: "Zoe", seat: expect.any(String), fee: 18 }]);
    await showSeats(ctx, "off_jetblue");
    const booked = await bookTogether(ctx, { offerId: "off_jetblue", confirmed: true }, null);
    expect(booked).toMatchObject({ strategy: "seat-services", total: 848 });
    // control: a child of 13 on the same flight is covered and costs the fare only
    onlyFlights([JB]);
    saveFamily(ctx, { travelers: [{ name: "Dad", age: 40 }, { name: "Zoe", age: 13 }] });
    expect(await fares()).toMatchObject({ guarantee: true, seatFees: 0, togetherTotal: 812, waivedFees: 36 });
  });

  it("seats chosen by hand end the waiver: moving a parent on JetBlue makes the seats paid and the view says why", async () => {
    onlyFlights([JB]);
    await findFamilyFlights(ctx, SEARCH);
    const before = await showSeats(ctx, "off_jetblue");
    expect(before.waiver.code).toBe("applies");
    expect(before.seatLines).toEqual([]);
    const moved = await moveTraveler(ctx, { offerId: "off_jetblue", traveler: "Dad", position: "aisle" });
    expect(moved.waiver).toMatchObject({ applies: false, code: "seats_chosen" });
    expect(moved.guarantee).toBe(false);
    expect(moved.seatFees).toBe(72);
    expect(moved.seatLines.map((l) => l.fee)).toEqual([18, 18, 18, 18]);
    expect(moved.togetherTotal).toBe(884);
    const booked = await bookTogether(ctx, { offerId: "off_jetblue", confirmed: true }, null);
    expect(booked).toMatchObject({ strategy: "seat-services", total: 884 });
    expect(fake.orders.get(booked.orderId)!.total).toBe(884);
  });

  const splitEconomy = { ...JB, taken: (d: string) => !["A", "D"].includes(col(d)) || rowNo(d) % 2 === 0, premium: { rows: 6, layout: [3, 3], cabinClass: "premium_economy" as const } };

  it("adjacent seats exist only in another cabin: an economy fare gets no $0 seats and no priced seating", async () => {
    onlyFlights([splitEconomy]);
    const card = await fares();
    expect(card).toMatchObject({ together: "NOT_TOGETHER", guarantee: false, togetherTotal: null, seatFees: 0 });
    expect(card.waiver).toMatchObject({ applies: false, code: "no_seating" });
    expect(card.waiver.conditions.find((c) => c.id === "adjacent_in_class")!.met).toBe(false);
    await expect(bookTogether(ctx, { offerId: "off_jetblue", confirmed: true }, null)).rejects.toMatchObject({ code: "no_adjacent_seats" });
    expect(fake.orders.size).toBe(0);
  });

  it("control: the same plane sold in premium economy seats the family there and the waiver applies", async () => {
    onlyFlights([splitEconomy]);
    const card = (await findFamilyFlights(ctx, { ...SEARCH, cabin: "premium_economy" })).offers[0];
    expect(card).toMatchObject({ together: "TOGETHER", guarantee: true, seatFees: 0, togetherTotal: 812 });
    const seats = await showSeats(ctx, "off_jetblue");
    expect(seats.assignments.every((a) => rowNo(a.seat) > 30)).toBe(true);
  });

  it("a Basic fare is not excluded: the dashboard row covers all fare types", async () => {
    onlyFlights([{ ...JB, fareBrand: "Basic" }]);
    expect(fake.offers.size).toBe(0);
    const card = await fares();
    expect(fake.offers.get("off_jetblue")!.summary.fareBrand).toBe("Basic");
    expect(card.waiver).toMatchObject({ applies: true, code: "applies" });
    expect(card.waiver.reason).toMatch(/all fare types/);
  });
});

describe("a carrier that is not on the DOT dashboard is not fee-free", () => {
  const QQ: Scenario = { id: "off_nowhere", airline: { name: "Nowhere Air", iata: "QQ" }, fare: 500, layout: [3, 3], rows: 30, taken: () => false, fee: () => 18 };

  it("pays every seat fee, shows no guarantee, and books seat services at fare plus fees", async () => {
    onlyFlights([QQ]);
    const found = await findFamilyFlights(ctx, SEARCH);
    expect(found.offers[0]).toMatchObject({ guarantee: false, seatFees: 72, togetherTotal: 572, airline: { dotFeeFreeAdjacent: null } });
    expect(found.provenance.rule.listed).toBe(false);
    const seats = await showSeats(ctx, "off_nowhere");
    expect(seats).toMatchObject({ guarantee: false, seatFees: 72, togetherTotal: 572 });
    const booked = await bookTogether(ctx, { offerId: "off_nowhere", confirmed: true }, null);
    expect(booked.strategy).toBe("seat-services");
    expect(booked.total).toBe(572);
    expect(booked.provenance.rule.listed).toBe(false);
    expect(fake.orders.get(booked.orderId)!.total).toBe(572);
  });

  it("control: the same flight under a carrier that is on the dashboard and guarantees it costs the fare only", async () => {
    onlyFlights([{ ...QQ, airline: { name: "JetBlue", iata: "B6" } }]);
    const found = await findFamilyFlights(ctx, SEARCH);
    expect(found.offers[0]).toMatchObject({ guarantee: true, seatFees: 0, togetherTotal: 500 });
  });
});

describe("show_seats and move_traveler", () => {
  it("proposes seats where every child has an adult beside them and puts the family names on the seats", async () => {
    await searched();
    const v = await showSeats(ctx, "off_delta");
    expect(v.together).toBe("TOGETHER");
    expect(v.provenance).toMatchObject({ source: "fixture", offer: "test", seatMap: "test", rule: { listed: true }, booking: { mode: "test", placed: false } });
    expect(v.seatFees).toBe(90);
    expect(v.togetherTotal).toBe(850);
    expect(v.rows).toHaveLength(6);
    const named = v.rows.flatMap((r) => r.cells).filter((c) => c.kind === "seat" && c.travelerId);
    expect(named).toHaveLength(4);
    const grid = buildGrid(fake.offers.get("off_delta")!.map);
    const party = ctx.store.getFamily("default")!.members.map((m, i) => ({ id: m.id, passengerId: `pas_${i}`, age: m.age }));
    expect(evaluateAssignment(grid, party, v.assignments.map((a) => ({ memberId: a.travelerId, seat: a.seat }))).together).toBe(true);
  });

  it("United: NOT_TOGETHER with a reason per child and no invented seats", async () => {
    await searched();
    const v = await showSeats(ctx, "off_united");
    expect(v.together).toBe("NOT_TOGETHER");
    expect(v.assignments).toEqual([]);
    expect(v.violations.length).toBeGreaterThan(0);
    expect(v.togetherTotal).toBeNull();
  });

  it("moving a child away from every adult flips the verdict to NOT_TOGETHER and names the child", async () => {
    await searched();
    await showSeats(ctx, "off_duffel_airways");
    const v = await moveTraveler(ctx, { offerId: "off_duffel_airways", traveler: "Mia", seat: "30F" });
    expect(v.together).toBe("NOT_TOGETHER");
    expect(v.violations.map((x) => x.travelerId)).toContain("mia");
    expect(v.togetherTotal).toBeNull();
  });

  it("moves a parent to the aisle by position and keeps the children beside an adult", async () => {
    await searched();
    await showSeats(ctx, "off_duffel_airways");
    const v = await moveTraveler(ctx, { offerId: "off_duffel_airways", traveler: "Dad", position: "aisle" });
    expect(v.together).toBe("TOGETHER");
    const dad = v.assignments.find((a) => a.travelerId === "dad")!.seat;
    expect(buildGrid(fake.offers.get("off_duffel_airways")!.map).seats.get(dad)!.aisle).toBe(true);
  });

  it("swaps with whoever holds the target seat instead of double-booking it", async () => {
    await searched();
    const before = await showSeats(ctx, "off_duffel_airways");
    const miaSeat = before.assignments.find((a) => a.travelerId === "mia")!.seat;
    const dadSeat = before.assignments.find((a) => a.travelerId === "dad")!.seat;
    const after = await moveTraveler(ctx, { offerId: "off_duffel_airways", traveler: "Dad", seat: miaSeat });
    expect(after.assignments.find((a) => a.travelerId === "dad")!.seat).toBe(miaSeat);
    expect(after.assignments.find((a) => a.travelerId === "mia")!.seat).toBe(dadSeat);
    expect(new Set(after.assignments.map((a) => a.seat)).size).toBe(after.assignments.length);
  });

  it("rejects an unknown traveler and a seat that is not on the plane", async () => {
    await searched();
    await showSeats(ctx, "off_delta");
    await expect(moveTraveler(ctx, { offerId: "off_delta", traveler: "Grandma", seat: "14A" })).rejects.toMatchObject({ code: "unknown_traveler" });
    await expect(moveTraveler(ctx, { offerId: "off_delta", traveler: "Dad", seat: "99Z" })).rejects.toMatchObject({ code: "unknown_seat" });
  });

  it("refuses a taken seat and says so", async () => {
    await searched();
    await showSeats(ctx, "off_delta");
    const v = await moveTraveler(ctx, { offerId: "off_delta", traveler: "Dad", seat: "1A" });
    expect(v.together).toBe("NOT_TOGETHER");
    expect(v.violations.map((x) => x.reason).join(" ")).toMatch(/taken/);
  });
});

describe("book_together", () => {
  it("JetBlue default plan: books under the airline guarantee, pays the fare only, and waits for the booking reference", async () => {
    await searched();
    await showSeats(ctx, "off_jetblue");
    fake.confirmAfterPolls = 3;
    const v = await bookTogether(ctx, { offerId: "off_jetblue", confirmed: true }, null);
    expect(v.strategy).toBe("airline-guarantee");
    expect(v.bookingReference).toBe("FXT4KQ");
    expect(v.total).toBe(812);
    expect(v.testMode).toBe(true);
    expect(v.provenance).toMatchObject({ source: "fixture", booking: { mode: "test", placed: true } });
    expect(fake.orders.size).toBe(1);
    expect(fake.calls.filter((c) => c.startsWith("getOrder")).length).toBeGreaterThanOrEqual(3);
    expect(ctx.store.getOrder("default", v.orderId)).not.toBeNull();
  });

  it("Delta: books four seat services whose seats pass the adjacency check on the airline's own seat map, and pays fare plus $90", async () => {
    await searched();
    await showSeats(ctx, "off_delta");
    const v = await bookTogether(ctx, { offerId: "off_delta", confirmed: true }, null);
    expect(v.strategy).toBe("seat-services");
    expect(v.total).toBe(850);
    expect(v.seats.every((s) => s.seat)).toBe(true);
    // post-condition read back from the order, judged against the original seat map
    const order = fake.orders.get(v.orderId)!;
    const members = ctx.store.getFamily("default")!.members;
    const party = members.map((m, i) => ({ id: m.id, passengerId: `pas_${i}`, age: m.age }));
    const grid = buildGrid(fake.offers.get("off_delta")!.map);
    const seats = members.map((m, i) => ({ memberId: m.id, seat: order.seats[`pas_${i}`]! }));
    expect(seats.every((s) => s.seat)).toBe(true);
    expect(evaluateAssignment(grid, party, seats).together).toBe(true);
  });

  it("refuses to book when the family would not sit together, and creates no order", async () => {
    await searched();
    await showSeats(ctx, "off_duffel_airways");
    await moveTraveler(ctx, { offerId: "off_duffel_airways", traveler: "Mia", seat: "30F" });
    await expect(bookTogether(ctx, { offerId: "off_duffel_airways", confirmed: true }, null)).rejects.toMatchObject({ code: "not_together" });
    expect(fake.orders.size).toBe(0);
    expect(fake.calls).not.toContain("createOrder");
  });

  const sellSeat = (offerId: string, seat: string) => {
    for (const cabin of fake.offers.get(offerId)!.map.cabins)
      for (const r of cabin.rows) for (const s of r.sections) for (const el of s.elements) if (el.type === "seat" && el.designator === seat) el.available_services = [];
  };

  it("refuses when a planned seat was sold after the search, using the live seat map", async () => {
    await searched();
    const shown = await showSeats(ctx, "off_duffel_airways");
    sellSeat("off_duffel_airways", shown.assignments[0].seat);
    await expect(bookTogether(ctx, { offerId: "off_duffel_airways", confirmed: true }, null)).rejects.toMatchObject({ code: "not_together" });
    expect(fake.orders.size).toBe(0);
  });

  it("when the sale leaves no block of adjacent seats at all, the refusal says so and names a flight that works", async () => {
    await searched();
    const shown = await showSeats(ctx, "off_delta");
    sellSeat("off_delta", shown.assignments[0].seat);
    const err = await bookTogether(ctx, { offerId: "off_delta", confirmed: true }, null).catch((e) => e);
    expect(err).toMatchObject({ code: "no_adjacent_seats" });
    expect(err.voice).toMatch(/no adjacent seats on Delta DL101 for Mia and Leo/);
    expect(err.voice).toMatch(/JetBlue seats everyone together for \$812/);
    expect(fake.orders.size).toBe(0);
    expect(fake.calls).not.toContain("createOrder");
  });

  it("an expired fare returns a structured error, never a fake success", async () => {
    await searched();
    await showSeats(ctx, "off_delta");
    fake.expired.add("off_delta");
    await expect(bookTogether(ctx, { offerId: "off_delta", confirmed: true }, null)).rejects.toMatchObject({ code: "offer_expired" });
    expect(fake.orders.size).toBe(0);
  });

  it("an order that never gets a booking reference is reported as pending, not booked", async () => {
    await searched();
    await showSeats(ctx, "off_jetblue");
    fake.confirmAfterPolls = 999;
    await expect(bookTogether(ctx, { offerId: "off_jetblue", confirmed: true }, null)).rejects.toMatchObject({ code: "order_pending" });
    expect(ctx.store.latestOrder("default")).toBeNull();
  });

  it("asks for confirmation: no confirmation and no elicitation means no order", async () => {
    await searched();
    await showSeats(ctx, "off_jetblue");
    await expect(bookTogether(ctx, { offerId: "off_jetblue", confirmed: false }, null)).rejects.toMatchObject({ code: "confirmation_required" });
    const decline: Elicit = async () => ({ action: "decline" });
    await expect(bookTogether(ctx, { offerId: "off_jetblue", confirmed: false }, decline)).rejects.toMatchObject({ code: "not_confirmed" });
    expect(fake.orders.size).toBe(0);
  });

  it("collects missing passenger details by elicitation, saves them, then books", async () => {
    saveFamily(ctx, { travelers: [{ name: "Dad", age: 40 }, { name: "Mia", age: 6 }] });
    await findFamilyFlights(ctx, SEARCH);
    await showSeats(ctx, "off_jetblue");
    await expect(bookTogether(ctx, { offerId: "off_jetblue", confirmed: true }, null)).rejects.toMatchObject({ code: "missing_passenger_details" });
    expect(fake.orders.size).toBe(0);

    let asked: string[] = [];
    const elicit: Elicit = async (_msg, props) => {
      asked = Object.keys(props);
      if (props.confirm) return { action: "accept", content: { confirm: true } };
      return { action: "accept", content: { dad_born_on: "1986-03-02", dad_gender: "m", mia_born_on: "2020-05-11", mia_gender: "f", family_name: "Rivera", email: "family@example.com", phone_number: "+12125550123" } };
    };
    const v = await bookTogether(ctx, { offerId: "off_jetblue", confirmed: false }, elicit);
    expect(asked).toEqual(["confirm"]);
    expect(v.bookingReference).toBe("FXT4KQ");
    expect(ctx.store.getFamily("default")!.members.find((m) => m.id === "mia")!.bornOn).toBe("2020-05-11");
  });

  it("the payment must equal fare plus services: a wrong amount from the product code would fail in the fixture", async () => {
    await searched();
    await showSeats(ctx, "off_delta");
    // Duffel rejects any payment that is not fare plus the bought seat services.
    await expect(fake.createOrder({ offerId: "off_delta", passengers: ctx.store.getFamily("default")!.members.map((m, i) => ({ passengerId: `pas_${i}`, title: "mr", givenName: m.name, familyName: "R", bornOn: "1990-01-01", gender: "m", email: "a@b.co", phoneNumber: "+1212" })), serviceIds: [], amount: "1.00", currency: "USD" })).rejects.toMatchObject({ code: "payment_amount_mismatch" });
  });
});

describe("still_together (a new session, state read from the store)", () => {
  it("answers yes with the seats, then no with the row change once the airline moves a child", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sbs-"));
    const path = join(dir, "state.db");
    fresh(openStore(path));
    await searched();
    await showSeats(ctx, "off_delta");
    const booked = await bookTogether(ctx, { offerId: "off_delta", confirmed: true }, null);

    // next day: a different ctx and an empty in-memory cache, same database file
    ctx = createCtx({ duffel: fake, store: openStore(path), now: () => new Date("2026-10-22T09:00:00Z") });
    const yes = await stillTogether(ctx);
    expect(yes.together).toBe(true);
    expect(yes.changes).toEqual([]);
    expect(yes.voice).toMatch(/^Yes/);
    expect(yes.provenance).toMatchObject({ source: "fixture", booking: { mode: "test", placed: true } });

    const mia = ctx.store.getOrder("default", booked.orderId)!.passengerIds.mia;
    const from = booked.seats.find((s) => s.name === "Mia")!.seat;
    fake.airlineMovesSeat(booked.orderId, mia, "30F");
    const no = await stillTogether(ctx);
    expect(no.together).toBe(false);
    expect(no.changes).toEqual([{ name: "Mia", from, to: "30F", via: ["order", "airline-change"] }]);
    expect(no.voice).toMatch(/^No\. Mia moved from .* to 30F\. Mia is no longer beside an adult/);
    expect(no.voice).toMatch(/waiting for your response/);
  });

  async function bookedDelta() {
    await searched();
    await showSeats(ctx, "off_delta");
    const booked = await bookTogether(ctx, { offerId: "off_delta", confirmed: true }, null);
    const stored = ctx.store.getOrder("default", booked.orderId)!;
    return { booked, stored, seat: (name: string) => booked.seats.find((s) => s.name === name)!.seat!, pid: (id: string) => stored.passengerIds[id] };
  }

  it("airline moves a child away: the view names the child, her old and new seat, and offers seats that put her beside an adult again", async () => {
    const { booked, seat, pid } = await bookedDelta();
    fake.airlineMovesSeat(booked.orderId, pid("mia"), "30F");
    const s = await stillTogether(ctx);
    expect(s.together).toBe(false);
    expect(s.provenance).toMatchObject({ source: "fixture", offer: "test", booking: { mode: "test", placed: true } });
    expect(s.affected).toEqual([{ name: "Mia", role: "child", seat: "30F", from: seat("Mia"), reason: "Seat 30F has no adult beside it." }]);
    expect(s.changes).toEqual([{ name: "Mia", from: seat("Mia"), to: "30F", via: ["order", "airline-change"] }]);
    expect(s.seats.find((x) => x.name === "Mia")!.seat).toBe("30F");
    expect(s.airlineChanges).toEqual({ open: 1, scheduleChanged: false });
    expect(s.reseat).toMatchObject({ status: "proposal", guaranteeApplies: false });
    const offer = s.reseat;
    if (offer?.status !== "proposal") throw new Error("expected a proposal");
    expect(offer.moves).toHaveLength(1);
    expect(offer.moves[0]).toMatchObject({ name: "Mia", from: "30F" });
    // the proposed seat really puts every child beside an adult on the airline's own seat map
    const grid = buildGrid(fake.offers.get("off_delta")!.map);
    const members = ctx.store.getFamily("default")!.members;
    const party = members.map((m, i) => ({ id: m.id, passengerId: `pas_${i}`, age: m.age }));
    const after = members.map((m) => ({ memberId: m.id, seat: m.name === "Mia" ? offer.moves[0].to : seat(m.name) }));
    expect(evaluateAssignment(grid, party, after, { adjacencyOnly: true }).together).toBe(true);
    expect(s.voice).toMatch(/^No\. Mia moved from \S+ to 30F\. Mia is no longer beside an adult\. I can see seats that put everyone together again: Mia to \S+\./);
    expect(s.voice).toMatch(/Ask Delta to make that change\./);
    expect(s.voice).toMatch(/Delta sent a change to your booking and is waiting for your response\./);
  });

  it("control: the airline swaps two parents and the children still have an adult beside them, so nothing is flagged", async () => {
    const { booked, seat, pid } = await bookedDelta();
    fake.airlineMovesSeat(booked.orderId, pid("dad"), seat("Mum"));
    fake.airlineMovesSeat(booked.orderId, pid("mum"), seat("Dad"));
    const s = await stillTogether(ctx);
    expect(s.together).toBe(true);
    expect(s.affected).toEqual([]);
    expect(s.reseat).toBeNull();
    expect(s.changes.map((c) => c.name).sort()).toEqual(["Dad", "Mum"]);
    expect(s.voice).toMatch(/^Yes, you are still sitting together, although seats moved/);
  });

  it("a change the airline has proposed but the order does not show yet still flags the child, and says it is a pending change", async () => {
    const { booked, seat, pid } = await bookedDelta();
    fake.airlineProposesSeat(booked.orderId, pid("leo"), "30A");
    const s = await stillTogether(ctx);
    expect(fake.orders.get(booked.orderId)!.seats[pid("leo")]).toBe(seat("Leo"));
    expect(s.together).toBe(false);
    expect(s.affected.map((a) => a.name)).toEqual(["Leo"]);
    expect(s.changes).toEqual([{ name: "Leo", from: seat("Leo"), to: "30A", via: ["airline-change"] }]);
  });

  it("when the airline's seat map no longer answers, it says so and still names the child and who to ask", async () => {
    const { booked, pid } = await bookedDelta();
    fake.airlineMovesSeat(booked.orderId, pid("mia"), "30F");
    fake.noSeatMap.add("off_delta");
    const s = await stillTogether(ctx);
    expect(s.affected.map((a) => a.name)).toEqual(["Mia"]);
    expect(s.reseat).toEqual({ status: "unavailable", reason: "Delta no longer shows a seat map for this booking." });
    expect(s.voice).toMatch(/Delta no longer shows a seat map for this booking\. Ask Delta to seat Mia beside an adult\./);
  });

  it("under a carrier that guarantees adjacent seats the offer says the commitment covers it at no fee", async () => {
    await searched();
    await showSeats(ctx, "off_jetblue");
    const booked = await bookTogether(ctx, { offerId: "off_jetblue", confirmed: true }, null);
    const stored = ctx.store.getOrder("default", booked.orderId)!;
    // JetBlue assigns seats after booking, and puts Mia away from every adult
    Object.assign(fake.orders.get(booked.orderId)!.seats, { [stored.passengerIds.dad]: "12A", [stored.passengerIds.mum]: "12B", [stored.passengerIds.leo]: "12C", [stored.passengerIds.mia]: "28F" });
    const s = await stillTogether(ctx);
    expect(s.affected.map((a) => a.name)).toEqual(["Mia"]);
    expect(s.reseat).toMatchObject({ status: "proposal", guaranteeApplies: true });
    expect(s.voice).toMatch(/JetBlue's family seating commitment covers a child beside an adult at no fee, so ask them to make that change\./);
    expect(s.voice).not.toMatch(/seat fees/);
  });

  it("an order under the airline guarantee with no seats yet is not reported as together", async () => {
    await searched();
    await showSeats(ctx, "off_jetblue");
    await bookTogether(ctx, { offerId: "off_jetblue", confirmed: true }, null);
    const s = await stillTogether(ctx);
    expect(s.together).toBe(false);
    expect(s.seats.every((x) => x.seat === null)).toBe(true);
    expect(s.voice).toMatch(/has not assigned seats/);
  });

  it("no booking yet is a structured error", async () => {
    await expect(stillTogether(ctx)).rejects.toMatchObject({ code: "no_booking" });
  });
});
