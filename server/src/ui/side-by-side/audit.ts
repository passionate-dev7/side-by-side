import type { DotWaiver, OfferCard, OffersView, Traveler } from "../../domain.js";
import { money } from "./format.js";

/** Pure text for the flight card, kept apart from the DOM so the arithmetic on the card can be tested. */

const seatFeeList = (o: OfferCard, cur: string) =>
  o.seatLines.filter((l) => l.fee > 0).map((l) => `${l.seat} ${money(l.fee, cur)}`).join(", ");

/** Base fare, each seat fee, what the DOT waiver took off. The family total sits beside it. */
export function breakdown(o: OfferCard, cur: string, lowestFare = false): string {
  const fare = `${lowestFare ? "Lowest fare" : "Fare"} ${money(o.fare, cur)}`;
  if (o.together !== "TOGETHER") return fare;
  if (o.waiver.applies) return `${fare} + seats ${money(0, cur)}${o.waivedFees > 0 ? `, ${money(o.waivedFees, cur)} waived` : ""}`;
  const paid = o.seatLines.filter((l) => l.fee > 0);
  // Three or more seats at one price read as one phrase; the card has one line for them.
  if (paid.length > 2 && paid.every((l) => l.fee === paid[0].fee)) return `${fare} + ${paid.length} seats at ${money(paid[0].fee, cur)}`;
  const list = seatFeeList(o, cur);
  return `${fare} + seats ${money(o.seatFees, cur)}${list ? ` (${list})` : ""}`;
}

/** Where the card stands in the ranking, which is by family total. */
export function rankNote(o: OfferCard, best: number | null, cur: string): string {
  if (o.togetherTotal === null) return "Not together";
  if (best === null || o.togetherTotal <= best) return "Lowest family total";
  return `+${money(Math.round((o.togetherTotal - best) * 100) / 100, cur)} over the lowest total`;
}

export function checkedLabel(v: Pick<OffersView, "evaluated" | "searched" | "moreAvailable">): string {
  return `${v.evaluated} of ${v.searched}${v.moreAvailable ? "+" : ""} fares checked`;
}

/** The dashboard's conditions in a few words, for the ones this booking meets. */
const MET: Record<string, string> = {
  same_reservation: "Everyone on one booking",
  adjacent_in_class: "Adjacent seats open in cabin",
  layout_possible: "Each child fits by an adult",
  seats_untouched: "Airline assigns the seats",
};

/** Why the seats cost $0: the children the commitment covers, then each DOT condition this booking meets. Empty when the waiver does not apply. */
export function whyFree(w: DotWaiver, party: Pick<Traveler, "name" | "age">[], childMaxAge = 13): string[] {
  if (!w.applies) return [];
  const kids = party.filter((t) => t.age <= childMaxAge);
  const covered = `${kids.map((k) => `${k.name} ${k.age}`).join(", ")} ${kids.length > 1 ? "are" : "is"} ${childMaxAge} or under`;
  return [covered, ...w.conditions.filter((c) => c.met === true && MET[c.id]).map((c) => MET[c.id])];
}
