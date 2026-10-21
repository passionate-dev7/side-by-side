import { describe, expect, it } from "vitest";
import { DEMO, headline, MIN_HOLD_MS, pickOffer, planMs, speechMs } from "../src/demo";

describe("scripted demo plan", () => {
  it("runs 60 to 90 seconds, so a recording needs no cuts", () => {
    expect(planMs()).toBeGreaterThanOrEqual(60_000);
    expect(planMs()).toBeLessThanOrEqual(90_000);
  });

  it("walks the whole journey in order: family, search, seats, a flight with no adjacent seats, booking, the airline moving a child, the later checks", () => {
    const names = DEMO.map((s) => s.call?.name ?? `airline ${s.airline}`);
    expect(names).toEqual(["save_family", "find_family_flights", "show_seats", "show_seats", "book_together", "airline assigns-seats", "still_together", "airline moves-child", "still_together"]);
    expect(DEMO.filter((s) => s.call?.name === "show_seats").map((s) => s.call?.iata)).toEqual(["B6", "UA"]);
  });

  it("holds every screen long enough to read, and confirms the booking only after the form has been on screen", () => {
    for (const s of DEMO) expect(s.holdMs).toBeGreaterThanOrEqual(MIN_HOLD_MS);
    expect(DEMO.find((s) => s.call?.name === "book_together")!.confirmAfterMs).toBeGreaterThanOrEqual(3000);
  });

  it("picks a flight by carrier from the latest search and refuses a carrier that is not in it", () => {
    const offers = [{ offerId: "a", airline: { iata: "DL" } }, { offerId: "b", airline: { iata: "B6" } }];
    expect(pickOffer(offers, "B6")).toBe("b");
    expect(() => pickOffer(offers, "UA")).toThrowError(/no UA flight/);
  });

  it("speaks the headline: whole sentences up to the word limit, at least the first, so a long answer does not run the recording over", () => {
    const long = "Dad 12B, Mum 12D, Mia 12A, Leo 12C. Everyone has a family neighbor. JetBlue seats your child beside an adult at no fee, so seats cost nothing. Total $812. Delta has the lowest fare at $760, but $850 for your family to sit together. JetBlue is the lowest family total at $812.";
    expect(headline(long)).toBe("Dad 12B, Mum 12D, Mia 12A, Leo 12C. Everyone has a family neighbor. JetBlue seats your child beside an adult at no fee, so seats cost nothing. Total $812.");
    expect(headline(long, 5)).toBe("Dad 12B, Mum 12D, Mia 12A, Leo 12C.");
    expect(headline("One sentence that is longer than the limit by a good margin indeed.", 3)).toBe("One sentence that is longer than the limit by a good margin indeed.");
    expect(headline("")).toBe("");
  });

  it("estimates speech at a calm pace", () => {
    expect(speechMs("one two three four five six seven eight nine ten")).toBe(3448);
    expect(speechMs("")).toBe(0);
  });
});
