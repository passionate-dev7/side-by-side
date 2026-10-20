import type {} from "@duffel/api";
import type { SeatMap } from "@duffel/api/types";
import type { Cell, SeatRow } from "./domain.js";

/**
 * Seat map model built from Duffel `GET /air/seat_maps?offer_id=...`.
 * Shapes: https://duffel.com/docs/api/seat-maps/schema
 * A seat with an empty `available_services` list is unavailable. Services are per passenger,
 * so availability and fee are looked up per Duffel passenger id. Money is kept in minor units.
 */

export interface GridSeat {
  designator: string;
  row: number;
  section: number;
  /** Index of this seat among the elements of its section. */
  pos: number;
  /** Next to the cabin edge. */
  window: boolean;
  /** Next to an aisle. */
  aisle: boolean;
  name: string | null;
  /** Exit-row seats: nobody under 15 may sit here (14 CFR 121.585). Detected from the seat name or disclosures. */
  exitRow: boolean;
  /** passenger id -> fee in minor units. Absent key = not bookable for that passenger. */
  fees: Map<string, number>;
  /** passenger id -> Duffel service id to buy this seat for that passenger. */
  serviceIds: Map<string, string>;
}

export type GridElement = { type: "seat"; seat: GridSeat } | { type: "other"; kind: string };

export interface GridRow {
  /** Printed row number, or null for rows without seats (galley, exit-row spacer, lavatory). */
  number: number | null;
  sections: GridElement[][];
}

export interface Grid {
  segmentId: string;
  sliceId: string;
  currency: string;
  rows: GridRow[];
  seats: Map<string, GridSeat>;
}

const EXIT = /exit/i;

function toMinor(amount: string): number {
  const n = Number(amount);
  if (!Number.isFinite(n) || n < 0) throw new Error(`seat fee ${amount} is not a non-negative amount`);
  return Math.round(n * 100);
}

export function buildGrid(map: SeatMap): Grid {
  const seats = new Map<string, GridSeat>();
  const rows: GridRow[] = [];
  let currency: string | null = null;

  for (const cabin of map.cabins) {
    for (const r of cabin.rows) {
      const lastSection = r.sections.length - 1;
      let number: number | null = null;
      const sections: GridElement[][] = r.sections.map((sec, si) => {
        const lastPos = sec.elements.length - 1;
        return sec.elements.map((el, pos): GridElement => {
          // restricted_seat_general cannot be booked as a general seat, so it is treated as a non-seat that breaks adjacency.
          if (el.type !== "seat") return { type: "other", kind: el.type };
          const m = /^(\d+)/.exec(el.designator);
          const rowNum = m ? Number(m[1]) : NaN;
          if (!Number.isFinite(rowNum)) throw new Error(`seat designator ${el.designator} has no row number`);
          number = rowNum;
          const fees = new Map<string, number>();
          const serviceIds = new Map<string, string>();
          for (const s of el.available_services) {
            if (currency && currency !== s.total_currency) throw new Error(`seat map mixes currencies ${currency} and ${s.total_currency}`);
            currency = s.total_currency;
            fees.set(s.passenger_id, toMinor(s.total_amount));
            serviceIds.set(s.passenger_id, s.id);
          }
          const seat: GridSeat = {
            designator: el.designator,
            row: rowNum,
            section: si,
            pos,
            window: (si === 0 && pos === 0) || (si === lastSection && pos === lastPos),
            aisle: (si > 0 && pos === 0) || (si < lastSection && pos === lastPos),
            name: el.name ?? null,
            exitRow: EXIT.test(el.name ?? "") || el.disclosures.some((d) => EXIT.test(d)),
            fees,
            serviceIds,
          };
          seats.set(seat.designator, seat);
          return { type: "seat", seat };
        });
      });
      rows.push({ number, sections });
    }
  }
  return { segmentId: map.segment_id, sliceId: map.slice_id, currency: currency ?? "USD", rows, seats };
}

/** Seats next to this one in the same row section, with no aisle, gap or other element between. */
export function neighbours(grid: Grid, seat: GridSeat): GridSeat[] {
  const row = grid.rows.find((r) => r.number === seat.row && r.sections[seat.section]?.some((e) => e.type === "seat" && e.seat === seat));
  const sec = row?.sections[seat.section];
  if (!sec) return [];
  const out: GridSeat[] = [];
  for (const p of [seat.pos - 1, seat.pos + 1]) {
    const el = sec[p];
    if (el && el.type === "seat") out.push(el.seat);
  }
  return out;
}

export function feeOf(seat: GridSeat | undefined, passengerId: string): number | null {
  if (!seat) return null;
  const f = seat.fees.get(passengerId);
  return f === undefined ? null : f;
}

/**
 * Up to `count` seat rows to draw: every row holding an assigned seat first, then the rows around them, in cabin order.
 * Rows need not be consecutive when the party is split far apart; a gap in the row numbers is a visible break.
 */
export function viewRows(
  grid: Grid,
  occupant: Map<string, string>,
  assigned: string[],
  count = 6,
): SeatRow[] {
  const seatRows = grid.rows.filter((r) => r.number !== null);
  if (seatRows.length === 0) return [];
  const idx = [
    ...new Set(
      assigned
        .map((d) => grid.seats.get(d))
        .filter((s): s is GridSeat => !!s)
        .map((s) => seatRows.findIndex((r) => r.number === s.row))
        .filter((i) => i >= 0),
    ),
  ].sort((x, y) => x - y);
  const chosen = new Set(idx.slice(0, count));
  for (let radius = 1; chosen.size < count && radius < seatRows.length; radius++) {
    for (const i of idx) {
      for (const j of [i - radius, i + radius]) if (j >= 0 && j < seatRows.length && chosen.size < count) chosen.add(j);
    }
  }
  if (chosen.size < count) for (let i = 0; i < seatRows.length && chosen.size < count; i++) chosen.add(i);
  return [...chosen].sort((x, y) => x - y).map((i) => seatRows[i]).map((r) => ({
    row: r.number!,
    cells: r.sections.flatMap((sec, si): Cell[] => {
      const cells = sec.map((el): Cell => {
        if (el.type !== "seat") return { kind: "blank" };
        const taken = el.seat.fees.size === 0;
        const flags: Array<"exit_row"> = el.seat.exitRow ? ["exit_row"] : [];
        const minFee = taken ? null : Math.min(...el.seat.fees.values()) / 100;
        return {
          kind: "seat",
          designator: el.seat.designator,
          state: taken ? "taken" : "free",
          fee: minFee,
          travelerId: occupant.get(el.seat.designator) ?? null,
          flags,
        };
      });
      return si === 0 ? cells : [{ kind: "aisle" }, ...cells];
    }),
  }));
}

/** Row -> sections -> seat designators in order. Enough to judge adjacency after the live seat map is gone. */
export type Layout = Record<string, string[][]>;

export function layoutOf(grid: Grid): Layout {
  const out: Layout = {};
  for (const r of grid.rows) {
    if (r.number === null) continue;
    out[String(r.number)] = r.sections.map((sec) => sec.map((e) => (e.type === "seat" ? e.seat.designator : "")));
  }
  return out;
}

/** Rebuilds a grid from a stored layout. Every seat counts as bookable, so only adjacency rules can fail. */
export function gridFromLayout(layout: Layout): Grid {
  const seats = new Map<string, GridSeat>();
  const rows: GridRow[] = Object.entries(layout)
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([num, secs]) => {
      const last = secs.length - 1;
      return {
        number: Number(num),
        sections: secs.map((sec, si) =>
          sec.map((d, pos): GridElement => {
            if (!d) return { type: "other", kind: "empty" };
            const seat: GridSeat = {
              designator: d, row: Number(num), section: si, pos,
              window: (si === 0 && pos === 0) || (si === last && pos === sec.length - 1),
              aisle: (si > 0 && pos === 0) || (si < last && pos === sec.length - 1),
              name: null, exitRow: false, fees: new Map(), serviceIds: new Map(),
            };
            seats.set(d, seat);
            return { type: "seat", seat };
          }),
        ),
      };
    });
  return { segmentId: "", sliceId: "", currency: "USD", rows, seats };
}
