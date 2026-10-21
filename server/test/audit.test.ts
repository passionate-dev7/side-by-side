import { describe, expect, it } from "vitest";
import type { OfferCard } from "../src/domain.js";
import { breakdown, checkedLabel } from "../src/ui/side-by-side/audit.js";

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
  });
  it("a card that cannot seat the family shows the fare and no seat fee", () => {
    expect(breakdown(card({ together: "NOT_TOGETHER", togetherTotal: null }), "USD")).toBe("Fare $812");
  });
  it("says how many fares were checked, with a plus when more exist", () => {
    expect(checkedLabel({ evaluated: 10, searched: 23, moreAvailable: false })).toBe("10 of 23 fares checked");
    expect(checkedLabel({ evaluated: 10, searched: 200, moreAvailable: true })).toBe("10 of 200+ fares checked");
  });
});
