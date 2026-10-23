import type { BookedView, Cell, ErrorView, FamilyView, OfferCard, OffersView, StatusCabin, StatusView } from "../../domain.js";
import { h, type Child } from "./dom.js";
import { checkedAt, clock, day, money, partyLine, seatLetter, stops } from "./format.js";
import { breakdown, checkedLabel, rankNote } from "./audit.js";
import { sourceLine } from "./provenance.js";

export interface Ctx {
  /** Calls a server tool, presents its result, and resolves false (after showing a toast) when it failed. */
  run(name: string, args: Record<string, unknown>): Promise<boolean>;
  toast(message: string): void;
}

export function screen(kind: string, ...kids: Child[]): HTMLElement {
  return h("main", { class: "screen is-in", "data-kind": kind }, ...kids);
}

export function head(title: string, side: Child[] = [], hero = false, subline?: string): HTMLElement {
  const h1 = h("h1", { class: hero ? "title hero" : "title" }, title);
  return h("header", { class: "head" }, subline ? h("div", { class: "head-main" }, h1, h("p", { class: "subline" }, subline)) : h1, h("div", { class: "head-side" }, ...side));
}

export function chip(tone: "ok" | "warn" | "accent" | "muted", text: string, dot = false): HTMLElement {
  return h("span", { class: `chip ${tone}` }, dot ? h("i") : null, text);
}

function offerRow(o: OfferCard, v: OffersView, ctx: Ctx): HTMLElement {
  const meta = `${clock(o.departingAt)} to ${clock(o.arrivingAt)} · ${stops(o.stops)}`;
  const priced = o.togetherTotal !== null;
  const lowestFare = o.fare === Math.min(...v.offers.map((x) => x.fare));
  const delta = rankNote(o, v.offers.find((x) => x.togetherTotal !== null)?.togetherTotal ?? null, v.currency);
  const btn = h(
    "button",
    { class: `offer${priced ? "" : " is-apart"}`, type: "button", "data-offer": o.offerId },
    h("div", { class: "o-id" }, h("span", { class: "airline" }, o.airline.name), h("span", { class: "times" }, meta)),
    h("div", { class: "total" }, money(priced ? (o.togetherTotal as number) : o.fare, v.currency)),
    h("div", { class: "o-sum" }, breakdown(o, v.currency, lowestFare && v.offers.length > 1)),
    h("div", { class: "delta" }, delta),
    h("div", { class: `o-why${o.waiver.applies ? " yes" : ""}` }, h("b", {}, o.waiver.applies ? "DOT waiver" : "No DOT waiver"), ` ${o.waiver.summary}`),
  );
  btn.addEventListener("click", async () => {
    if (btn.getAttribute("aria-busy") === "true") return;
    btn.setAttribute("aria-busy", "true");
    const ok = await ctx.run("show_seats", { offer_id: o.offerId });
    if (!ok) btn.removeAttribute("aria-busy");
  });
  return btn;
}

export function offersScreen(v: OffersView, ctx: Ctx): HTMLElement {
  const sub = [day(v.route.departureDate).replace(/^\w+, /, ""), partyLine(v.party)].filter(Boolean).join(" · ");
  return screen(
    "offers",
    head(`${v.route.origin} to ${v.route.destination}`, [v.status === "searching" ? chip("accent", `Reading seats ${v.checking.done} of ${v.checking.of || "..."}`) : chip("muted", checkedLabel(v))], false, sub),
    v.offers.length
      ? h("section", { class: "offers", "aria-label": "Flights ranked by cost to sit together" }, ...v.offers.map((o) => offerRow(o, v, ctx)))
      : h("section", { class: "wait", role: "status" }, pulse(), h("p", { class: "big" }, v.searched ? `Reading seat maps on the ${v.checking.of} cheapest of ${v.searched} fares` : "Searching fares"), h("p", { class: "label" }, "Each flight appears here as its seats are priced.")),
    h("footer", { class: "foot-prov" }, sourceLine(v.provenance)),
  );
}

function seatItem(name: string, seat: string | null, trailing?: Child): HTMLElement {
  return h("li", {}, h("span", {}, name), seat ? h("span", { class: "seatno" }, seat) : h("span", { class: "seatno none" }, trailing ?? "No seat yet"));
}

export function bookedScreen(v: BookedView): HTMLElement {
  const flight = `${v.route.origin} to ${v.route.destination} · ${day(v.route.departingAt).replace(/^\w+, /, "")}, ${clock(v.route.departingAt)}`;
  const placing = v.status === "booking";
  const waived = v.strategy === "airline-guarantee";
  const right = waived
    ? h(
        "div",
        { class: "stack seated", "aria-label": "Travelers" },
        h("div", { class: "chips" }, ...v.seats.map((s) => h("span", { class: "trav" }, h("span", { class: "nm" }, s.name)))),
        h("div", { class: "label" }, "Seat fees"),
        h("div", { class: "big" }, h("b", { class: "yes" }, "$0"), ` ${v.airline.name} seats the children beside an adult, by the day before the flight.`),
      )
    : h("ul", { class: "who", "aria-label": "Seats by traveler" }, ...v.seats.map((s) => seatItem(s.name, s.seat)));
  return screen(
    "booked",
    head(placing ? `Booking on ${v.airline.name}` : `Booked on ${v.airline.name}`, placing ? [chip("accent", `Confirming with ${v.airline.name}`)] : []),
    h("section", { class: "split" }, h("div", { class: "stack" }, h("div", { class: "label" }, "Booking reference"), placing ? h("div", { class: "ref-wait", role: "status" }, pulse(), h("span", {}, "On its way")) : h("div", { class: "ref" }, v.bookingReference ?? ""), h("div", { class: "flight" }, flight), h("div", { class: "big" }, `Total ${money(v.total, v.currency)}`)), right),
    h("footer", { class: "foot-prov" }, sourceLine(v.provenance)),
  );
}

function statusTitle(v: StatusView): string {
  if (v.affected.length) return `${v.affected.map((a) => a.name).join(" and ")} ${v.affected.length > 1 ? "are" : "is"} no longer beside an adult`;
  if (v.together) return v.changes.length ? "Still together, seats moved" : "Still sitting together";
  return v.seats.some((s) => !s.seat) ? "Seats not assigned yet" : "Your seats changed";
}

/** The airline has not assigned seats yet and nothing has moved: the family is waiting, not apart. */
const awaitingSeats = (v: StatusView): boolean => !v.together && !v.affected.length && !v.changes.length && v.seats.some((s) => !s.seat);

function reseatLine(v: StatusView): string {
  const r = v.reseat;
  const who = v.airline.name;
  if (!r) return `${awaitingSeats(v) && v.airline.dotFeeFreeAdjacent ? `${who} seats each child beside an adult at no fee. ` : ""}Checked ${checkedAt(v.checkedAt)}${v.refreshing ? ". Checking again." : ""}`;
  if (r.status === "unavailable") return `${r.reason} Ask ${who} to seat ${v.affected.map((a) => a.name).join(" and ")} beside an adult.`;
  const moves = r.moves.map((m) => `${m.name} to ${m.to}`).join(", ");
  return r.guaranteeApplies ? `Proposed: ${moves}. ${who} commits to this at no fee. Ask them to make the change.` : `Proposed: ${moves}${r.fee > 0 ? `, ${money(r.fee, r.currency)} in seat fees` : ", no seat fee"}. Ask ${who} to make the change.`;
}

/** The booked cabin, read-only: chips where the family sits now, a dashed ghost where a flagged traveler sat, proposed seats outlined. */
function statusCabin(c: StatusCabin, flagged: Set<string>): HTMLElement {
  const byId = new Map(c.travelers.map((t) => [t.id, t]));
  const ghost = new Map(c.former.map((f) => [f.seat, byId.get(f.travelerId)]));
  const proposed = new Set(c.proposed);
  const tight = c.rows.some((r) => r.cells.filter((x) => x.kind === "seat").length >= 8);
  const cell = (x: Cell): HTMLElement => {
    if (x.kind !== "seat") return h("span", { class: x.kind, "aria-hidden": "true" });
    const t = x.travelerId ? byId.get(x.travelerId) : undefined;
    const was = ghost.get(x.designator);
    const cls = `seat${t ? " is-mine" : was ? " is-former" : " is-taken"}${proposed.has(x.designator) ? " is-proposed" : ""}`;
    const label = t ? `${t.name}, seat ${x.designator}${flagged.has(t.name) ? ", needs an adult beside them" : ""}` : was ? `Seat ${x.designator}, where ${was.name} sat` : `Seat ${x.designator}`;
    const chipOf = (who: NonNullable<typeof t>, extra: string) =>
      h("span", { class: `trav ${who.role === "child" ? "is-child" : "is-adult"}${who.name.length >= 7 ? " is-xlong" : who.name.length >= 4 ? " is-long" : ""}${extra}` }, h("span", { class: "nm" }, who.name));
    return h("div", { class: cls, "data-seat": x.designator, "aria-label": `${label}${proposed.has(x.designator) ? ", proposed" : ""}` }, t ? chipOf(t, flagged.has(t.name) ? " is-flagged" : "") : was ? chipOf(was, " is-ghost") : h("span", {}, seatLetter(x.designator)));
  };
  return h(
    "section",
    { class: `cabin${tight ? " tight" : ""} read-only`, "aria-label": "Your seats on the booked flight" },
    ...c.rows.flatMap((r, i) => {
      const prev = c.rows[i - 1];
      const gap = prev && r.row - prev.row > 1 ? [h("div", { class: "skip", role: "separator", "aria-label": `rows ${prev.row + 1} to ${r.row - 1} not shown` }, h("span", {}, prev.row + 1 === r.row - 1 ? `row ${prev.row + 1}` : `rows ${prev.row + 1} to ${r.row - 1}`))] : [];
      const cols = r.cells.map((x) => (x.kind === "aisle" ? (tight ? "10px" : "16px") : "minmax(0, 1fr)")).join(" ");
      return [...gap, h("div", { class: "row", style: `--cols: ${cols}` }, h("span", { class: "rownum" }, String(r.row)), ...r.cells.map(cell))];
    }),
  );
}

export function statusScreen(v: StatusView): HTMLElement {
  const bad = new Set(v.affected.map((a) => a.name));
  const moved = new Map(v.changes.map((c) => [c.name, c]));
  const rows = v.seats.map((s) => {
    const c = moved.get(s.name);
    const flagged = bad.has(s.name);
    return h(
      "li",
      { class: flagged ? "bad" : c ? "moved" : "" },
      h("span", {}, s.name),
      c ? h("span", { class: "change" }, c.from ?? "No seat", " to ", h("b", {}, c.to ?? "none")) : s.seat ? h("span", { class: "seatno" }, s.seat) : h("span", { class: "seatno none" }, "No seat yet"),
    );
  });
  const list = h("ul", { class: `who${v.cabin ? " compact" : ""}`, "aria-label": v.changes.length ? "Seats, with changes" : "Seats by traveler" }, ...rows);
  const ref = v.affected.length
    ? h("div", { class: "label ref-line" }, `${v.airline.name} · booking `, h("b", {}, v.bookingReference))
    : h("div", { class: "stack" }, h("div", { class: "label" }, "Booking reference"), h("div", { class: "ref" }, v.bookingReference), v.cabin ? null : h("div", { class: "flight" }, v.changes.length ? "Seat changes since you booked" : "No seat changes since you booked"));
  const left = v.affected.length
    ? h(
        "div",
        { class: "stack" },
        h("div", { class: "label" }, "Needs an adult beside them"),
        ...v.affected.map((a) => h("div", { class: "flag-row" }, h("span", { class: "trav is-child is-flagged" }, h("span", { class: "nm" }, a.name)), h("span", { class: "flag-seat" }, a.from ?? "No seat", " to ", h("b", {}, a.seat ?? "none")))),
        ref,
      )
    : ref;
  const body = v.cabin
    ? h("section", { class: "status-map" }, statusCabin(v.cabin, bad), h("div", { class: "side" }, v.affected.length ? ref : left, list))
    : h("section", { class: "split" }, left, list);
  return screen(
    "together-status",
    head(statusTitle(v), [v.together ? chip("ok", "Together", true) : awaitingSeats(v) ? chip("accent", "Seats pending", true) : chip("warn", "Not together", true)]),
    body,
    h("footer", { class: "foot-prov" }, h("p", { class: "evaluated" }, ...(reseatLine(v).startsWith("Proposed: ") ? [h("b", {}, "Proposed"), reseatLine(v).slice("Proposed".length)] : [reseatLine(v)])), sourceLine(v.provenance)),
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

const pulse = () => h("div", { class: "pulse", "aria-hidden": "true" }, h("span"), h("span"), h("span"));

export function waitingScreen(message: string | null, detail: string | null): HTMLElement {
  return screen(
    "waiting",
    head("Getting your trip ready"),
    h("section", { class: "wait", role: "status" }, pulse(), h("p", { class: "big" }, message ?? "Waiting for the trip details."), detail ? h("p", { class: "label" }, detail) : null),
    h("span"),
  );
}
