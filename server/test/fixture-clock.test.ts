import { describe, expect, it } from "vitest";
import type { OffersView } from "../src/domain.js";
import { bookTogether, findFamilyFlights, saveFamily, showSeats, type Ctx } from "../src/service.js";
import { createFixtureCtx } from "./fixtures/fixture-ctx.js";

/** `npm run fixture` runs on the real clock, so the demo journey must work on any day it is run, not only on the emulator's fixed date. */

function family(now?: () => Date) {
  const fx = createFixtureCtx(now);
  saveFamily(fx.ctx, {
    travelers: [
      { name: "Dad", age: 40, gender: "m", bornOn: "1986-03-02" },
      { name: "Mum", age: 38, gender: "f", bornOn: "1988-07-19" },
      { name: "Mia", age: 6, gender: "f", bornOn: "2020-05-11" },
      { name: "Leo", age: 9, gender: "m", bornOn: "2017-01-30" },
    ],
    familyName: "Rivera",
    email: "family@example.com",
    phoneNumber: "+12125550123",
  });
  return fx;
}

async function search(ctx: Ctx): Promise<OffersView> {
  const input = { origin: "JFK", destination: "MCO", departureDate: "2026-11-25", cabin: "economy" as const };
  let view = await findFamilyFlights(ctx, input);
  for (let i = 0; i < 50 && view.status !== "ready"; i++) {
    await new Promise((r) => setTimeout(r, 20));
    view = await findFamilyFlights(ctx, input);
  }
  return view;
}

describe("the fixture server on today's clock", () => {
  it("finds and ranks the four flights, JetBlue first at $812 together", async () => {
    const view = await search(family().ctx);
    expect(view.status).toBe("ready");
    expect(view.offers).toHaveLength(4);
    expect(view.offers[0].togetherTotal).toBe(812);
  });

  it("a second run on the same server seats the family again: seats held by the last run's order are not on the new search", async () => {
    let t = Date.now();
    const { ctx, fake } = family(() => new Date(t));
    await search(ctx);
    await showSeats(ctx, "off_jetblue");
    expect((await bookTogether(ctx, { offerId: "off_jetblue", confirmed: true }, null)).status).toBe("confirmed");
    const [orderId] = fake.orders.keys();
    fake.airlineAssignsSeats(orderId, { pas_0: "12A", pas_1: "12B", pas_2: "12C", pas_3: "12D" });
    t += 10 * 60_000;
    expect(fake.calls.filter((c) => c === "searchOffers")).toHaveLength(1);
    await search(ctx);
    expect(fake.calls.filter((c) => c === "searchOffers")).toHaveLength(2);
    expect((await showSeats(ctx, "off_jetblue")).togetherTotal).toBe(812);
  });
});
