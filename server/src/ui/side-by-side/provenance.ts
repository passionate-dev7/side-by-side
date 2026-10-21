import type { Provenance } from "../../domain.js";
import { h } from "./dom.js";

const mode = (m: "live" | "test") => h("b", { class: `mode ${m}` }, m === "live" ? "LIVE" : "TEST");

/** Header tag: names what produced the data, so a fixture can never be read as an airline. */
export function sourceTag(p: Provenance): HTMLElement {
  const live = p.offer === "live";
  const text = live ? "Live · Duffel" : p.source === "fixture" ? "Test · fixture" : "Test · Duffel";
  return h("span", { class: `tag${live ? " live" : ""}`, "data-source": p.source, "data-mode": p.offer, title: p.source === "fixture" ? "In-memory emulator of the Duffel API. Not an airline." : live ? "Duffel live mode" : "Duffel test mode: no real tickets, no real money" }, text);
}

/** One line that labels the offer, the seat map, the guarantee rule and the booking. Every card carries it. */
export function provenanceStrip(p: Provenance): HTMLElement {
  const rule = p.rule.listed ? `DOT ${p.rule.dashboardUpdated}` : "Not on DOT list";
  const facet = (name: string, ...value: Array<Node | string>) => h("span", { class: "pf" }, h("i", {}, name), ...value);
  return h(
    "div",
    { class: "prov", role: "group", "aria-label": "Where this data comes from" },
    facet("Offer", mode(p.offer)),
    facet("Seats", mode(p.seatMap)),
    facet("Rule", h("b", { class: `mode ${p.rule.listed ? "live" : "none"}`, title: `U.S. DOT Airline Family Seating Dashboard, updated ${p.rule.dashboardUpdated}, read ${p.rule.readOn}` }, rule)),
    facet(p.booking.placed ? "Booked" : "Booking", mode(p.booking.mode), p.booking.placed ? "" : " not placed"),
  );
}
