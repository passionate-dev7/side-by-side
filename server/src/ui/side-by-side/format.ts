import type { Traveler } from "../../domain.js";

export function money(amount: number, currency: string): string {
  const whole = Number.isInteger(amount);
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      minimumFractionDigits: whole ? 0 : 2,
      maximumFractionDigits: whole ? 0 : 2,
    }).format(amount);
  } catch {
    return `${amount} ${currency}`;
  }
}

/** Airline times are local wall-clock strings; read the digits, never convert zones. */
export function clock(iso: string): string {
  const m = /T(\d{2}):(\d{2})/.exec(iso);
  if (!m) return iso;
  const h24 = Number(m[1]);
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${m[2]} ${h24 < 12 ? "AM" : "PM"}`;
}

export function day(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }).format(d);
}

export function duration(minutes: number | null): string | null {
  if (minutes === null) return null;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export function stops(n: number): string {
  return n === 0 ? "Nonstop" : n === 1 ? "1 stop" : `${n} stops`;
}

export function partyLine(party: Traveler[]): string {
  const kids = party.filter((t) => t.role === "child").length;
  const adults = party.length - kids;
  const part = (n: number, one: string, many: string) => (n === 0 ? null : `${n} ${n === 1 ? one : many}`);
  return [part(adults, "adult", "adults"), part(kids, "child", "children")].filter(Boolean).join(", ");
}

export function checkedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", month: "short", day: "numeric" }).format(d);
}

/** "14C" -> "C". Falls back to the whole designator if it has no row prefix. */
export function seatLetter(designator: string): string {
  const m = /^\d+([A-Z]+)$/i.exec(designator);
  return m ? m[1].toUpperCase() : designator;
}
