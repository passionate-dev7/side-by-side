import type { BookedView, ErrorView, FamilyView, OfferCard, OffersView, StatusView } from "../../domain.js";
import { h, type Child } from "./dom.js";
import { checkedAt, clock, day, money, partyLine, stops } from "./format.js";
import { provenanceStrip, sourceTag } from "./provenance.js";

export interface Ctx {
  /** Calls a server tool, presents its result, and resolves false (after showing a toast) when it failed. */
  run(name: string, args: Record<string, unknown>): Promise<boolean>;
  toast(message: string): void;
}

export function screen(kind: string, ...kids: Child[]): HTMLElement {
  return h("main", { class: "screen is-in", "data-kind": kind }, ...kids);
}

export function head(title: string, side: Child[] = [], hero = false): HTMLElement {
  return h("header", { class: "head" }, h("h1", { class: hero ? "title hero" : "title" }, title), h("div", { class: "head-side" }, ...side));
}

export function chip(tone: "ok" | "warn" | "accent", text: string, dot = false): HTMLElement {
  return h("span", { class: `chip ${tone}` }, dot ? h("i") : null, text);
}

function offerRow(o: OfferCard, v: OffersView, ctx: Ctx): HTMLElement {
  const meta = `${clock(o.departingAt)} to ${clock(o.arrivingAt)} · ${stops(o.stops)}`;
  const priced = o.togetherTotal !== null;
  const delta =
    !priced ? "Seats not priced"
    : o.deltaVsCheapestFare === null ? ""
    : o.deltaVsCheapestFare <= 0 ? "Cheapest together"
    : `+${money(o.deltaVsCheapestFare, v.currency)} vs cheapest`;
  const btn = h(
    "button",
    { class: "offer", type: "button", "data-offer": o.offerId },
    h("div", { class: "offer-main" }, h("div", { class: "airline" }, o.airline.name), h("div", { class: "times" }, meta)),
    h(
      "div",
      { class: "offer-chips" },
      o.together === "TOGETHER" ? chip("ok", "Together", true) : chip("warn", "Not together", true),
      o.guarantee ? chip("accent", "$0 seat fee") : null,
    ),
    h("div", { class: "offer-price" }, h("div", { class: "total" }, money(priced ? (o.togetherTotal as number) : o.fare, v.currency)), h("div", { class: "delta" }, delta)),
  );
  btn.addEventListener("click", async () => {
    if (btn.getAttribute("aria-busy") === "true") return;
    btn.setAttribute("aria-busy", "true");
    const ok = await ctx.run("show_seats", { offer_id: o.offerId });
    if (!ok) btn.removeAttribute("aria-busy");
  });
  return btn;
}

export function evaluatedLine(v: OffersView): string {
  const n = (k: number) => `${k} direct fare${k === 1 ? "" : "s"}`;
  const of = v.evaluated === v.searched ? n(v.evaluated) : `${v.evaluated} of ${n(v.searched)}`;
  return `Seat maps read and seating solved for ${of}${v.moreAvailable ? ", cheapest first. More fares exist." : "."}`;
}

export function offersScreen(v: OffersView, ctx: Ctx): HTMLElement {
  const sub = [day(v.route.departureDate), partyLine(v.party)].filter(Boolean).join(" · ");
  return screen(
    "offers",
    head(`${v.route.origin} to ${v.route.destination}`, [h("span", { class: "sub" }, sub), sourceTag(v.provenance)]),
    h("section", { class: "offers", "aria-label": "Flights ranked by cost to sit together" }, ...v.offers.map((o) => offerRow(o, v, ctx))),
    h("footer", { class: "foot-prov" }, h("p", { class: "evaluated" }, evaluatedLine(v)), provenanceStrip(v.provenance)),
  );
}

function seatItem(name: string, seat: string | null, trailing?: Child): HTMLElement {
  return h("li", {}, h("span", {}, name), seat ? h("span", { class: "seatno" }, seat) : h("span", { class: "seatno none" }, trailing ?? "No seat yet"));
}

export function bookedScreen(v: BookedView): HTMLElement {
  const flight = `${v.airline.name} · ${v.route.origin} to ${v.route.destination} · ${day(v.route.departingAt)}, ${clock(v.route.departingAt)}`;
  const strategy = v.strategy === "seat-services" ? "Seats are booked for everyone." : "No seat fee. The airline seats the family together.";
  return screen(
    "booked",
    head("Booked", [sourceTag(v.provenance)]),
    h(
      "section",
      { class: "split" },
      h("div", { class: "stack" }, h("div", { class: "label" }, "Booking reference"), h("div", { class: "ref" }, v.bookingReference), h("div", { class: "flight" }, flight), h("div", { class: "big" }, `Total ${money(v.total, v.currency)}`)),
      h("ul", { class: "who", "aria-label": "Seats by traveler" }, ...v.seats.map((s) => seatItem(s.name, s.seat))),
    ),
    h("footer", { class: "foot-prov" }, h("p", { class: "evaluated" }, strategy), provenanceStrip(v.provenance)),
  );
}

export function statusScreen(v: StatusView): HTMLElement {
  const moved = v.changes.length > 0;
  const title = v.together ? "Still sitting together" : "Your seats changed";
  const list = moved
    ? v.changes.map((c) => h("li", {}, h("span", {}, c.name), h("span", { class: "change" }, c.from ?? "No seat", " to ", h("b", {}, c.to ?? "no seat"))))
    : v.seats.map((s) => seatItem(s.name, s.seat));
  return screen(
    "together-status",
    head(title, [v.together ? chip("ok", "Together", true) : chip("warn", "Not together", true), sourceTag(v.provenance)]),
    h(
      "section",
      { class: "split" },
      h("div", { class: "stack" }, h("div", { class: "label" }, "Booking reference"), h("div", { class: "ref" }, v.bookingReference), h("div", { class: "flight" }, moved ? "Seat changes since you booked" : "No seat changes since you booked")),
      h("ul", { class: "who", "aria-label": moved ? "Seat changes" : "Seats by traveler" }, ...list),
    ),
    h("footer", { class: "foot-prov" }, h("p", { class: "evaluated" }, `Checked ${checkedAt(v.checkedAt)}`), provenanceStrip(v.provenance)),
  );
}

export function familyScreen(v: FamilyView): HTMLElement {
  const need = v.missingForBooking;
  const missing = need.length ? `Still needed to book: ${need.slice(0, 3).join(", ")}${need.length > 3 ? ` and ${need.length - 3} more` : ""}.` : "";
  return screen(
    "family",
    head("Your party", [h("span", { class: "sub" }, partyLine(v.party))]),
    h(
      "section",
      { class: "party", "aria-label": "Travelers" },
      ...v.party.map((t) =>
        h("div", { class: "person" }, h("span", { class: `trav ${t.role === "child" ? "is-child" : "is-adult"}` }, t.name), h("span", { class: "label" }, `${t.role === "child" ? "Child" : "Adult"}, age ${t.age}`)),
      ),
    ),
    missing ? h("footer", { class: "note" }, missing) : h("span"),
  );
}

export function errorScreen(v: Pick<ErrorView, "code" | "message">): HTMLElement {
  return screen("error", head("That did not go through"), h("section", { class: "wait" }, h("p", { class: "big" }, v.message), h("p", { class: "code" }, v.code)), h("span"));
}

export function waitingScreen(message: string | null, detail: string | null): HTMLElement {
  return screen(
    "waiting",
    head("Getting your trip ready"),
    h("section", { class: "wait", role: "status" }, h("div", { class: "pulse", "aria-hidden": "true" }, h("span"), h("span"), h("span")), h("p", { class: "big" }, message ?? "Waiting for the trip details."), detail ? h("p", { class: "label" }, detail) : null),
    h("span"),
  );
}
