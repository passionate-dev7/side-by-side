import type { OfferCard, OffersView } from "../../domain.js";
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
