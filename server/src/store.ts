import { DatabaseSync } from "node:sqlite";
import type { Layout } from "./seatmap.js";

/**
 * Cross-session state: the saved family, seat plans and booked orders.
 * Alexa+ rebuilds context from the customer's account, so everything is keyed by an account id.
 * Locally the account is "default"; hosted, it comes from the OAuth subject.
 */

export interface FamilyMember {
  id: string;
  name: string;
  age: number;
  seatPreference?: "aisle" | "window";
  bornOn?: string;
  gender?: "m" | "f";
  givenName?: string;
}

export interface Family {
  familyName?: string;
  email?: string;
  phoneNumber?: string;
  members: FamilyMember[];
}

export interface Plan {
  offerId: string;
  /** memberId -> seat designator */
  assignments: Record<string, string>;
  /** true once the family moved someone by hand, so the default airline-guarantee shortcut no longer applies. */
  customized: boolean;
  updatedAt: string;
}

export interface BookedOrder {
  orderId: string;
  bookingReference: string;
  offerId: string;
  strategy: "seat-services" | "airline-guarantee";
  /** memberId -> Duffel passenger id used on the order */
  passengerIds: Record<string, string>;
  /** memberId -> seat designator at booking time (null under the airline guarantee until the airline assigns) */
  seats: Record<string, string | null>;
  layout: Layout;
  members: FamilyMember[];
  airline: { name: string; iata: string };
  /** Cabin class the order was sold in. */
  cabinClass?: string | null;
  route: { origin: string; destination: string; departingAt: string };
  currency: string;
  total: number;
  liveMode: boolean;
  createdAt: string;
}

export interface Store {
  getFamily(account: string): Family | null;
  saveFamily(account: string, family: Family): void;
  getPlan(account: string, offerId: string): Plan | null;
  savePlan(account: string, plan: Plan): void;
  saveOrder(account: string, order: BookedOrder): void;
  /** By the airline's order id or by the booking reference. */
  getOrder(account: string, orderId: string): BookedOrder | null;
  latestOrder(account: string): BookedOrder | null;
}

export function openStore(path: string): Store {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS family (account TEXT PRIMARY KEY, json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS plans (account TEXT NOT NULL, offer_id TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY (account, offer_id));
    CREATE TABLE IF NOT EXISTS orders (account TEXT NOT NULL, order_id TEXT NOT NULL, created_at TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY (account, order_id));
  `);
  const one = <T>(sql: string, ...args: string[]): T | null => {
    const row = db.prepare(sql).get(...args) as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as T) : null;
  };
  return {
    getFamily: (a) => one<Family>("SELECT json FROM family WHERE account = ?", a),
    saveFamily: (a, f) => void db.prepare("INSERT OR REPLACE INTO family (account, json) VALUES (?, ?)").run(a, JSON.stringify(f)),
    getPlan: (a, o) => one<Plan>("SELECT json FROM plans WHERE account = ? AND offer_id = ?", a, o),
    savePlan: (a, p) => void db.prepare("INSERT OR REPLACE INTO plans (account, offer_id, json) VALUES (?, ?, ?)").run(a, p.offerId, JSON.stringify(p)),
    saveOrder: (a, o) =>
      void db.prepare("INSERT OR REPLACE INTO orders (account, order_id, created_at, json) VALUES (?, ?, ?, ?)").run(a, o.orderId, o.createdAt, JSON.stringify(o)),
    // A parent says the six-letter booking reference, not the airline's order id: either finds the order.
    getOrder: (a, id) =>
      one<BookedOrder>("SELECT json FROM orders WHERE account = ? AND (order_id = ? OR upper(json_extract(json, '$.bookingReference')) = upper(?)) ORDER BY created_at DESC LIMIT 1", a, id, id),
    latestOrder: (a) => one<BookedOrder>("SELECT json FROM orders WHERE account = ? ORDER BY created_at DESC LIMIT 1", a),
  };
}
