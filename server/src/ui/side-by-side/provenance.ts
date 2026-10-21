import type { Provenance } from "../../domain.js";
import { h } from "./dom.js";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function shortDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}` : iso;
}

/** One quiet line at the foot of a screen: where the seating rule comes from. */
export function sourceLine(p: Provenance): HTMLElement {
  const rule = p.rule.listed ? `U.S. DOT family seating dashboard, updated ${shortDate(p.rule.dashboardUpdated)}` : "Carrier not on the U.S. DOT family seating dashboard";
  return h("div", { class: "prov", title: `${p.rule.url} (read ${p.rule.readOn})` }, `Airline seat maps · ${rule}`);
}
