import { describe, expect, it } from "vitest";
import { DOT_CONDITIONS } from "../src/dot.js";
import { evaluateWaiver, type WaiverInput } from "../src/waiver.js";

const ok: WaiverInput = { iata: "B6", airlineName: "JetBlue", ages: [40, 38, 6, 9], seatingExists: true, seatsChosenByHand: false, cabinClass: "economy" };
const met = (w: ReturnType<typeof evaluateWaiver>, id: string) => w.conditions.find((c) => c.id === id)!.met;

describe("DOT fee waiver: every dashboard condition that can be checked at booking has to hold", () => {
  it("applies to a listed carrier, a child 13 or under, one reservation, seats open in the selected class, seats left to the airline", () => {
    const w = evaluateWaiver(ok);
    expect(w).toMatchObject({ applies: true, code: "applies" });
    expect(w.reason).toBe("JetBlue commits to fee-free adjacent seats for a child 13 or under, all fare types. One reservation, seats open in economy.");
    expect(w.conditions.map((c) => c.id)).toEqual(DOT_CONDITIONS.map((c) => c.id));
    expect([met(w, "same_reservation"), met(w, "adjacent_in_class"), met(w, "layout_possible"), met(w, "seats_untouched")]).toEqual([true, true, true, true]);
    expect(met(w, "no_downgauge")).toBeNull();
  });

  const cases: Array<[string, Partial<WaiverInput>, string, RegExp]> = [
    ["a carrier the dashboard says does not commit", { iata: "DL", airlineName: "Delta" }, "carrier_no_commitment", /Delta does not commit/],
    ["a carrier that is not on the dashboard", { iata: "ZZ", airlineName: "Duffel Airways" }, "carrier_not_listed", /not on the DOT family seating dashboard/],
    ["a party whose youngest traveler is 14", { ages: [40, 14] }, "no_young_child", /Nobody is 13 or under/],
    ["a flight with no seating that puts the child beside an adult in the selected class", { seatingExists: false }, "no_seating", /No adjacent seats are open in economy/],
    ["seats chosen by hand", { seatsChosenByHand: true }, "seats_chosen", /chosen by hand/],
  ];
  for (const [name, change, code, reason] of cases) {
    it(`does not apply to ${name}`, () => {
      const w = evaluateWaiver({ ...ok, ...change });
      expect(w.applies).toBe(false);
      expect(w.code).toBe(code);
      expect(w.reason).toMatch(reason);
    });
  }

  it("a 13 year old is covered and a 14 year old is not: the line is the dashboard's, not ours", () => {
    expect(evaluateWaiver({ ...ok, ages: [40, 13] }).applies).toBe(true);
    expect(evaluateWaiver({ ...ok, ages: [40, 14] }).applies).toBe(false);
  });

  it("reports which condition failed, so the reason is auditable", () => {
    expect(met(evaluateWaiver({ ...ok, seatingExists: false }), "adjacent_in_class")).toBe(false);
    expect(met(evaluateWaiver({ ...ok, seatsChosenByHand: true }), "seats_untouched")).toBe(false);
  });

  it("does not exclude a fare type: the dashboard row says all fare types", () => {
    expect(evaluateWaiver({ ...ok, cabinClass: "economy" }).reason).toMatch(/all fare types/);
  });
});
