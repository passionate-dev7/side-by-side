/**
 * U.S. DOT Airline Family Seating Dashboard.
 * Row: "Guarantees adjacent seats for a child 13 or under and an accompanying adult at no additional cost for all fare types".
 * Source: https://www.transportation.gov/airconsumer/airline-family-seating-dashboard
 * Read live 2026-10-21 (page table columns in order: Alaska, Allegiant, American, Delta, Frontier, Hawaiian, JetBlue, Southwest, United
 * = Yes, No, Yes, No, Yes, Yes, Yes, No, No). The dashboard's own last-updated date is 2025-09-05.
 * Each guarantee is "subject to limited conditions": child and adult on the same reservation, adjacent seats available at booking,
 * and seats chosen for everyone or for no one. The solver and book_together enforce the same conditions.
 */
export const DOT_SOURCE = {
  url: "https://www.transportation.gov/airconsumer/airline-family-seating-dashboard",
  readOn: "2026-10-21",
  dashboardUpdated: "2025-09-05",
} as const;

export const DOT_CHILD_MAX_AGE = 13;

const DOT_TABLE: Record<string, boolean> = {
  AS: true, // Alaska
  G4: false, // Allegiant
  AA: true, // American
  DL: false, // Delta
  F9: true, // Frontier
  HA: true, // Hawaiian
  B6: true, // JetBlue
  WN: false, // Southwest
  UA: false, // United
};

/** true/false as listed by DOT, null when the carrier is not on the dashboard (no guarantee is assumed). */
export function dotFeeFreeAdjacent(iata: string): boolean | null {
  const v = DOT_TABLE[iata.toUpperCase()];
  return v === undefined ? null : v;
}
