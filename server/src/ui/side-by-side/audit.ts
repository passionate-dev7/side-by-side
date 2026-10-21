import type { OfferCard, OffersView } from "../../domain.js";
import { money } from "./format.js";

/** Pure text for the flight card, kept apart from the DOM so the arithmetic on the card can be tested. */

const seatFeeList = (o: OfferCard, cur: string) =>
  o.seatLines.filter((l) => l.fee > 0).map((l) => `${l.seat} ${money(l.fee, cur)}`).join(", ");

/** Base fare, each seat fee, what the DOT waiver took off. The family total sits beside it. */
export function breakdown(o: OfferCard, cur: string): string {
  if (o.together !== "TOGETHER") return `Fare ${money(o.fare, cur)}`;
  if (o.waiver.applies) return `Fare ${money(o.fare, cur)} + seats $0${o.waivedFees > 0 ? `, ${money(o.waivedFees, cur)} waived` : ""}`;
  const list = seatFeeList(o, cur);
  return `Fare ${money(o.fare, cur)} + seats ${money(o.seatFees, cur)}${list ? ` (${list})` : ""}`;
}

export function checkedLabel(v: Pick<OffersView, "evaluated" | "searched" | "moreAvailable">): string {
  return `${v.evaluated} of ${v.searched}${v.moreAvailable ? "+" : ""} fares checked`;
}
