/**
 * The scripted demo: one family's journey from the first request to the later "are we still sitting together?", paced
 * for a screen recording. The script plays the parent and calls the tools in the order Alexa+ would choose them; every
 * screen, wire row and spoken line is the real product response.
 */

export interface OfferRef {
  offerId: string;
  airline: { iata: string };
}

export interface DemoStep {
  /** What the parent says. Typed onto the caption as if heard. */
  say: string;
  /** The tool Alexa+ calls for it. `iata` picks a flight from the latest search by carrier, never by position. */
  call?: { name: string; args?: Record<string, unknown>; iata?: string };
  /** The demo airline acts before this step's call: it seats the family after booking, or moves a child. */
  airline?: "assigns-seats" | "moves-child";
  /** How long the confirmation form stays on screen before the script says yes. */
  confirmAfterMs?: number;
  /** Time the screen is held for the viewer once the answer is up. */
  holdMs: number;
}

export const DEMO_DATE = "2026-11-25";
export const TYPE_MS = 28;
export const MIN_HOLD_MS = 3500;

export const DEMO: DemoStep[] = [
  { say: "We are Dad 40, Mum 38, Mia 6 and Leo 9.", call: { name: "save_family", args: {
    travelers: [
      { name: "Dad", age: 40, gender: "m", born_on: "1986-03-02" },
      { name: "Mum", age: 38, gender: "f", born_on: "1988-07-19" },
      { name: "Mia", age: 6, gender: "f", born_on: "2020-05-11" },
      { name: "Leo", age: 9, gender: "m", born_on: "2017-01-30" },
    ],
    family_name: "Rivera", email: "family@example.com", phone_number: "+12125550123",
  } }, holdMs: 6500 },
  { say: "Find us flights from JFK to MCO on November 25th, kids next to us.", call: { name: "find_family_flights", args: { origin: "JFK", destination: "MCO", departure_date: DEMO_DATE } }, holdMs: 10000 },
  { say: "Show me the seats on JetBlue.", call: { name: "show_seats", iata: "B6" }, holdMs: 10000 },
  { say: "And United?", call: { name: "show_seats", iata: "UA" }, holdMs: 7000 },
  { say: "Book the JetBlue one.", call: { name: "book_together", iata: "B6" }, confirmAfterMs: 3500, holdMs: 8000 },
  { say: "", airline: "assigns-seats", holdMs: 3500 },
  { say: "Are we still sitting together?", call: { name: "still_together" }, holdMs: 9000 },
  { say: "", airline: "moves-child", holdMs: 3500 },
  { say: "Are we still sitting together?", call: { name: "still_together" }, holdMs: 11000 },
];

export const typingMs = (s: string): number => s.length * TYPE_MS;

/** Planned running time: typing, forms, holds. Speech that runs longer than a hold extends it. */
export function planMs(plan: readonly DemoStep[] = DEMO): number {
  return plan.reduce((t, s) => t + typingMs(s.say) + (s.confirmAfterMs ?? 0) + s.holdMs, 0);
}

export function pickOffer(offers: readonly OfferRef[], iata: string): string {
  const hit = offers.find((o) => o.airline.iata === iata);
  if (!hit) throw new Error(`The latest search has no ${iata} flight to pick.`);
  return hit.offerId;
}

const WORDS = (s: string) => s.split(/\s+/).filter(Boolean).length;

/**
 * Alexa speaks the headline and the screen carries the rest: whole sentences of the tool's spoken line, up to `max`
 * words, never fewer than the first sentence.
 */
export function headline(text: string, max = 34): string {
  const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);
  const out: string[] = [];
  let words = 0;
  for (const s of sentences) {
    if (out.length && words + WORDS(s) > max) break;
    out.push(s);
    words += WORDS(s);
  }
  return out.join(" ");
}

/** Spoken time of a line at a calm pace, so a hold never cuts the voice off. */
export const speechMs = (text: string): number => Math.round((text.split(/\s+/).filter(Boolean).length / 2.9) * 1000);
