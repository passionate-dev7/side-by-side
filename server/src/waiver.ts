import { DOT_CHILD_MAX_AGE, DOT_CONDITIONS, dotCarrierName, dotFeeFreeAdjacent, type DotConditionId } from "./dot.js";
import type { DotWaiver, WaiverCode } from "./domain.js";

/**
 * Decides whether the U.S. DOT fee-free family seating commitment applies to one offer, and says why in the dashboard's own
 * terms. The commitment is the carrier's, for a child 13 or under, with the dashboard's conditions. $0 seats are shown
 * only when every condition that can be checked at booking is met.
 *
 * What is checked here, by dashboard condition:
 *   same_reservation   true by construction: the whole party is booked in one order
 *   adjacent_in_class  the seating found uses only seats of the offer's cabin class (the grid drops other cabins)
 *   seats_untouched    the adult has not chosen or changed seats by hand
 *   layout_possible    a seating exists, found by the solver on the open seats
 *   no_downgauge       cannot be known before departure, reported as null
 * The commitment itself: the carrier is listed with a yes, and at least one traveler is 13 or under.
 */

export interface WaiverInput {
  iata: string;
  airlineName: string;
  ages: number[];
  /** The solver found a seating that puts every child beside an adult in the offer's cabin. */
  seatingExists: boolean;
  /** The adult moved someone by hand, so the seats are no longer the airline's assignment. */
  seatsChosenByHand: boolean;
  cabinClass: string | null;
}

const CABIN = { economy: "economy", premium_economy: "premium economy", business: "business", first: "first" } as Record<string, string>;

export function evaluateWaiver(i: WaiverInput): DotWaiver {
  const listed = dotFeeFreeAdjacent(i.iata);
  const youngChildren = i.ages.filter((a) => a <= DOT_CHILD_MAX_AGE).length;
  const cabin = (i.cabinClass && CABIN[i.cabinClass]) || "the selected class";

  let code: WaiverCode;
  let reason: string;
  let summary: string;
  if (listed === null) {
    code = "carrier_not_listed";
    reason = `${i.airlineName} is not on the DOT family seating dashboard, so no fee waiver is assumed.`;
    summary = "Not on the DOT dashboard, so no waiver is assumed";
  } else if (listed === false) {
    code = "carrier_no_commitment";
    reason = `${dotCarrierName(i.iata) ?? i.airlineName} does not commit to fee-free family seating on the DOT dashboard.`;
    summary = `${dotCarrierName(i.iata) ?? i.airlineName} does not commit to fee-free family seating`;
  } else if (youngChildren === 0) {
    code = "no_young_child";
    reason = `Nobody is ${DOT_CHILD_MAX_AGE} or under, so the DOT commitment has no child to cover.`;
    summary = `Nobody is ${DOT_CHILD_MAX_AGE} or under`;
  } else if (!i.seatingExists) {
    code = "no_seating";
    reason = `No adjacent seats are open in ${cabin} on this flight, so there is nothing to waive.`;
    summary = `No adjacent seats open in ${cabin}`;
  } else if (i.seatsChosenByHand) {
    code = "seats_chosen";
    reason = "Seats were chosen by hand. The DOT commitment covers seats the airline assigns.";
    summary = "Seats chosen by hand";
  } else {
    code = "applies";
    reason = `${dotCarrierName(i.iata) ?? i.airlineName} commits to fee-free adjacent seats for a child ${DOT_CHILD_MAX_AGE} or under, all fare types. One reservation, seats open in ${cabin}.`;
    summary = `${dotCarrierName(i.iata) ?? i.airlineName} commits to fee-free seats for a child ${DOT_CHILD_MAX_AGE} or under, all fares`;
  }

  const met = (id: DotConditionId): boolean | null => {
    switch (id) {
      case "same_reservation": return true;
      case "adjacent_in_class": return i.seatingExists;
      case "layout_possible": return i.seatingExists;
      case "seats_untouched": return !i.seatsChosenByHand;
      case "no_downgauge": return null;
    }
  };
  return { applies: code === "applies", code, reason, summary, conditions: DOT_CONDITIONS.map((c) => ({ id: c.id, text: c.text, met: met(c.id) })) };
}
