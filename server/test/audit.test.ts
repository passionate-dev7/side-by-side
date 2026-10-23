import { describe, expect, it } from "vitest";
import type { OfferCard } from "../src/domain.js";
import { breakdown, checkedLabel, rankNote, whyFree } from "../src/ui/side-by-side/audit.js";
import { evaluateWaiver } from "../src/waiver.js";

const waiver = (applies: boolean) => ({ applies, code: applies ? "applies" : "carrier_no_commitment", reason: "", summary: "", conditions: [] }) as OfferCard["waiver"];
const card = (over: Partial<OfferCard>): OfferCard => ({
  offerId: "x", airline: { name: "X", iata: "XX", dotFeeFreeAdjacent: null }, departingAt: "", arrivingAt: "", stops: 0, durationMinutes: null, fare: 812, seatFees: 0, guarantee: false,
  waiver: waiver(false), seatLines: [], waivedFees: 0, togetherTotal: 812, together: "TOGETHER", deltaVsCheapestFare: 0, ...over,
});

describe("flight card arithmetic text", () => {
  it("a waived card shows the fare, $0 seats and what the waiver took off", () => {
    expect(breakdown(card({ waiver: waiver(true), guarantee: true, waivedFees: 72 }), "USD")).toBe("Fare $812 + seats $0, $72 waived");
  });
  it("a paid card lists each seat fee beside its seat and the sum", () => {
    const c = card({ fare: 760, seatFees: 90, togetherTotal: 850, seatLines: [{ traveler: "Mum", seat: "22D", fee: 45 }, { traveler: "Leo", seat: "22E", fee: 45 }, { traveler: "Dad", seat: "14A", fee: 0 }] });
    expect(breakdown(c, "USD")).toBe("Fare $760 + seats $90 (22D $45, 22E $45)");
    const four = card({ fare: 327, seatFees: 80, seatLines: ["30J", "28C", "30H", "30K"].map((seat) => ({ traveler: "x", seat, fee: 20 })) });
    expect(breakdown(four, "USD")).toBe("Fare $327 + 4 seats at $20");
  });
  it("a card that cannot seat the family shows the fare and no seat fee", () => {
    expect(breakdown(card({ together: "NOT_TOGETHER", togetherTotal: null }), "USD")).toBe("Fare $812");
  });
  it("the lowest fare is named as such, and the rank is against the lowest family total", () => {
    expect(breakdown(card({ fare: 760, seatFees: 90, seatLines: [{ traveler: "Mum", seat: "22D", fee: 45 }, { traveler: "Leo", seat: "22E", fee: 45 }] }), "USD", true)).toBe("Lowest fare $760 + seats $90 (22D $45, 22E $45)");
    expect(rankNote(card({ togetherTotal: 812 }), 812, "USD")).toBe("Lowest family total");
    expect(rankNote(card({ togetherTotal: 850 }), 812, "USD")).toBe("+$38 over the lowest total");
    expect(rankNote(card({ together: "NOT_TOGETHER", togetherTotal: null }), 812, "USD")).toBe("Not together");
  });
  it("says how many fares were checked, with a plus when more exist", () => {
    expect(checkedLabel({ evaluated: 10, searched: 23, moreAvailable: false })).toBe("10 of 23 fares checked");
    expect(checkedLabel({ evaluated: 10, searched: 200, moreAvailable: true })).toBe("10 of 200+ fares checked");
  });
});

describe("why the seats are $0", () => {
  const family = [
    { name: "Dad", age: 40 },
    { name: "Mum", age: 38 },
    { name: "Mia", age: 6 },
    { name: "Leo", age: 9 },
  ];
  const input = { ages: family.map((m) => m.age), seatingExists: true, seatsChosenByHand: false, cabinClass: "economy" };

  it("JetBlue lists the children it covers with their ages, then every DOT condition the booking meets", () => {
    const lines = whyFree(evaluateWaiver({ ...input, iata: "B6", airlineName: "JetBlue" }), family);
    expect(lines.length).toBeGreaterThanOrEqual(4);
    expect(lines[0]).toBe("Mia 6, Leo 9 are 13 or under");
    expect(lines).toContain("Airline assigns the seats");
  });

  it("Delta, with no commitment, lists nothing", () => {
    expect(whyFree(evaluateWaiver({ ...input, iata: "DL", airlineName: "Delta" }), family)).toEqual([]);
  });

  it("a condition that is not met is not listed", () => {
    const w = evaluateWaiver({ ...input, iata: "B6", airlineName: "JetBlue" });
    const off = { ...w, conditions: w.conditions.map((c) => (c.id === "same_reservation" ? { ...c, met: false } : c)) };
    expect(whyFree(w, family)).toContain("Everyone on one booking");
    expect(whyFree(off, family)).not.toContain("Everyone on one booking");
  });
});
