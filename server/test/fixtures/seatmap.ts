import type {} from "@duffel/api";
import type { SeatMap } from "@duffel/api/types";

/**
 * Test fixture generator. Output follows Duffel's documented seat map schema
 * (https://duffel.com/docs/api/seat-maps/schema), checked by the compiler against the official @duffel/api types.
 * It is test data only: product code never builds a seat map itself.
 */
export interface SeatMapSpec {
  rows: number;
  /** Seats per section, for example [3, 3] or [2, 4, 2]. */
  layout: number[];
  passengerIds: string[];
  taken?: Iterable<string>;
  /** Fee in major units for a seat designator. Defaults to 0. */
  fee?: (designator: string) => number;
  /** Rows whose seats are exit-row seats (named "Exit row seat"). */
  exitRows?: number[];
  currency?: string;
  segmentId?: string;
}

const LETTERS = "ABCDEFGHJK";

export function makeSeatMap(spec: SeatMapSpec): SeatMap {
  const taken = new Set(spec.taken ?? []);
  const exit = new Set(spec.exitRows ?? []);
  const currency = spec.currency ?? "USD";
  let svc = 0;
  const rows = Array.from({ length: spec.rows }, (_, r) => {
    const rowNum = r + 1;
    let col = 0;
    return {
      sections: spec.layout.map((count) => ({
        elements: Array.from({ length: count }, () => {
          const designator = `${rowNum}${LETTERS[col++]}`;
          const available = !taken.has(designator);
          return {
            type: "seat" as const,
            designator,
            name: exit.has(rowNum) ? "Exit row seat" : undefined,
            disclosures: exit.has(rowNum) ? ["Exit row: passengers must be 15 or older."] : [],
            available_services: available
              ? spec.passengerIds.map((pid) => ({
                  id: `ase_${designator}_${pid}_${svc++}`,
                  passenger_id: pid,
                  total_amount: (spec.fee ? spec.fee(designator) : 0).toFixed(2),
                  total_currency: currency,
                }))
              : [],
          };
        }),
      })),
    };
  });
  return {
    id: "sea_fixture",
    slice_id: "sli_fixture",
    segment_id: spec.segmentId ?? "seg_fixture",
    cabins: [{ deck: 0, cabin_class: "economy", wings: null, aisles: spec.layout.length - 1, rows }],
  };
}
