import { DOT_CHILD_MAX_AGE } from "./dot.js";
import { feeOf, neighbours, type Grid, type GridElement, type GridSeat } from "./seatmap.js";

/**
 * Deterministic family seating solver. No model is involved.
 *
 * Rule enforced (DOT Airline Family Seating Dashboard conditions, same reservation, adjacent seats at booking):
 *   every child aged 13 or under must have an adult (18+) seated directly beside them, same row, no aisle between.
 * Safety rule: nobody under 15 sits in an exit row (14 CFR 121.585).
 *
 * Objective, compared lexicographically: lowest total seat fee, then fewest separate blocks of seats,
 * then fewest unmet aisle/window preferences. Remaining ties go to the first solution in a fixed scan order
 * (longest blocks first, front rows first), so the same input always yields the same seats.
 */

export interface PartyMember {
  id: string;
  /** Duffel passenger id the seat service is bought for. */
  passengerId: string;
  age: number;
  seatPreference?: "aisle" | "window";
}

export interface SeatAssignment {
  memberId: string;
  seat: string;
  /** Minor units. */
  fee: number;
}

export type Solution =
  | { status: "TOGETHER"; assignments: SeatAssignment[]; fee: number; blocks: number; unmetPreferences: number; exact: boolean }
  | { status: "NOT_TOGETHER"; reasons: Array<{ memberId: string | null; reason: string }> };

export const isGuardian = (m: PartyMember) => m.age >= 18;
export const needsGuardian = (m: PartyMember) => m.age <= DOT_CHILD_MAX_AGE;
const barredFromExit = (m: PartyMember) => m.age < 15;

const NODE_BUDGET = 3_000_000;

interface Slot {
  elements: GridSeat[];
}

function buildSlots(grid: Grid, maxLen: number): Slot[] {
  const slots: Slot[] = [];
  const open = (e: GridElement): e is Extract<GridElement, { type: "seat" }> => e.type === "seat" && e.seat.fees.size > 0;
  for (let L = maxLen; L >= 1; L--) {
    for (const row of grid.rows) {
      if (row.number === null) continue;
      for (const sec of row.sections) {
        for (let s = 0; s + L <= sec.length; s++) {
          const run = sec.slice(s, s + L);
          if (run.every(open)) {
            slots.push({ elements: run.map((e) => e.seat) });
          }
        }
      }
    }
  }
  return slots;
}

function* subsetsContaining(first: number, pool: number[], size: number): Generator<number[]> {
  const others = pool.filter((i) => i !== first);
  function* rec(from: number, need: number, acc: number[]): Generator<number[]> {
    if (need === 0) {
      yield acc;
      return;
    }
    for (let i = from; i <= others.length - need; i++) yield* rec(i + 1, need - 1, [...acc, others[i]]);
  }
  for (const rest of rec(0, size - 1, [])) yield [first, ...rest];
}

function* permutations<T>(items: T[]): Generator<T[]> {
  if (items.length <= 1) {
    yield items;
    return;
  }
  for (let i = 0; i < items.length; i++) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const p of permutations(rest)) yield [items[i], ...p];
  }
}

export function solveSeating(grid: Grid, party: PartyMember[]): Solution {
  const n = party.length;
  if (n === 0) return { status: "NOT_TOGETHER", reasons: [{ memberId: null, reason: "No travelers to seat." }] };

  const reasons: Array<{ memberId: string | null; reason: string }> = [];
  if (party.some(needsGuardian) && !party.some(isGuardian)) {
    for (const m of party.filter(needsGuardian)) reasons.push({ memberId: m.id, reason: "No adult on this booking to sit beside them." });
    return { status: "NOT_TOGETHER", reasons };
  }

  const allSeats = [...grid.seats.values()];
  const minFee: number[] = party.map((m) => {
    let best = Infinity;
    for (const s of allSeats) {
      if (barredFromExit(m) && s.exitRow) continue;
      const f = feeOf(s, m.passengerId);
      if (f !== null && f < best) best = f;
    }
    return best;
  });
  party.forEach((m, i) => {
    if (minFee[i] === Infinity) reasons.push({ memberId: m.id, reason: "No bookable seat is left for them on this flight." });
  });
  if (reasons.length) return { status: "NOT_TOGETHER", reasons };

  const slots = buildSlots(grid, n);
  if (party.some(needsGuardian) && !slots.some((s) => s.elements.length >= 2)) {
    return {
      status: "NOT_TOGETHER",
      reasons: party.filter(needsGuardian).map((m) => ({ memberId: m.id, reason: "No two open seats are side by side on this flight." })),
    };
  }
  const fullMask = (1 << n) - 1;
  const anyPrefs = party.some((m) => m.seatPreference);

  type Key = [number, number, number];
  const cmp = (a: Key, b: Key) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  let bestKey: Key | null = null;
  let best: SeatAssignment[] = [];
  let nodes = 0;
  let exhausted = false;

  const used = new Set<string>();
  const current: SeatAssignment[] = [];

  const minRemaining = (mask: number) => {
    let s = 0;
    for (let i = 0; i < n; i++) if (!(mask & (1 << i))) s += minFee[i];
    return s;
  };

  function dfs(mask: number, fee: number, blocks: number, unmet: number) {
    if (exhausted) return;
    if (++nodes > NODE_BUDGET) {
      exhausted = true;
      return;
    }
    const complete = mask === fullMask;
    if (complete) {
      const key: Key = [fee, blocks, unmet];
      if (!bestKey || cmp(key, bestKey) < 0) {
        bestKey = key;
        best = current.map((a) => ({ ...a }));
      }
      return;
    }
    if (bestKey) {
      const lower: Key = [fee + minRemaining(mask), blocks + 1, anyPrefs ? unmet : 0];
      // An unfinished state needs at least one more block, so it can only win by strictly beating the best key.
      if (cmp(lower, bestKey) >= 0) return;
    }
    let first = 0;
    while (mask & (1 << first)) first++;
    const pool: number[] = [];
    for (let i = 0; i < n; i++) if (!(mask & (1 << i))) pool.push(i);

    for (const slot of slots) {
      const L = slot.elements.length;
      if (L > pool.length) continue;
      if (slot.elements.some((s) => used.has(s.designator))) continue;
      for (const subset of subsetsContaining(first, pool, L)) {
        for (const order of permutations(subset)) {
          let podFee = 0;
          let podUnmet = 0;
          let ok = true;
          for (let p = 0; p < L && ok; p++) {
            const m = party[order[p]];
            const seat = slot.elements[p];
            const f = feeOf(seat, m.passengerId);
            if (f === null || (barredFromExit(m) && seat.exitRow)) {
              ok = false;
              break;
            }
            podFee += f;
            if (m.seatPreference === "aisle" && !seat.aisle) podUnmet++;
            if (m.seatPreference === "window" && !seat.window) podUnmet++;
            if (needsGuardian(m)) {
              const left = p > 0 && isGuardian(party[order[p - 1]]);
              const right = p < L - 1 && isGuardian(party[order[p + 1]]);
              if (!left && !right) ok = false;
            }
          }
          if (!ok) continue;
          let nmask = mask;
          for (let p = 0; p < L; p++) {
            nmask |= 1 << order[p];
            used.add(slot.elements[p].designator);
            current.push({ memberId: party[order[p]].id, seat: slot.elements[p].designator, fee: feeOf(slot.elements[p], party[order[p]].passengerId)! });
          }
          dfs(nmask, fee + podFee, blocks + 1, unmet + podUnmet);
          for (let p = 0; p < L; p++) {
            used.delete(slot.elements[p].designator);
            current.pop();
          }
          if (exhausted) return;
        }
      }
    }
  }

  dfs(0, 0, 0, 0);

  if (!bestKey) {
    const why = exhausted
      ? "Search budget exhausted before a seating was found."
      : "No arrangement puts every child beside an adult on the seats still open.";
    const stuck = party.filter(needsGuardian);
    return { status: "NOT_TOGETHER", reasons: (stuck.length ? stuck : party).map((m) => ({ memberId: m.id, reason: why })) };
  }
  const [fee, blocks, unmetPreferences] = bestKey as Key;
  const order = new Map(party.map((m, i) => [m.id, i]));
  return {
    status: "TOGETHER",
    assignments: [...best].sort((a, b) => order.get(a.memberId)! - order.get(b.memberId)!),
    fee,
    blocks,
    unmetPreferences,
    exact: !exhausted,
  };
}

export interface Evaluation {
  together: boolean;
  fee: number;
  violations: Array<{ memberId: string; reason: string }>;
}

/** Checks any (possibly user-edited) seat assignment against availability, exit-row and child-beside-adult rules. */
export function evaluateAssignment(
  grid: Grid,
  party: PartyMember[],
  assignments: Array<{ memberId: string; seat: string }>,
  opts: { adjacencyOnly?: boolean } = {},
): Evaluation {
  const violations: Evaluation["violations"] = [];
  const bySeat = new Map<string, string>();
  const byMember = new Map<string, GridSeat>();
  let fee = 0;
  const memberOf = new Map(party.map((m) => [m.id, m]));

  for (const a of assignments) {
    const m = memberOf.get(a.memberId);
    const seat = grid.seats.get(a.seat);
    if (!m) continue;
    if (!seat) {
      violations.push({ memberId: m.id, reason: `Seat ${a.seat} is not on this plane.` });
      continue;
    }
    if (bySeat.has(seat.designator)) {
      violations.push({ memberId: m.id, reason: `Seat ${seat.designator} is already given to someone else in the party.` });
      continue;
    }
    const f = opts.adjacencyOnly ? 0 : feeOf(seat, m.passengerId);
    if (f === null) {
      violations.push({ memberId: m.id, reason: `Seat ${seat.designator} is taken.` });
      continue;
    }
    if (!opts.adjacencyOnly && barredFromExit(m) && seat.exitRow) {
      violations.push({ memberId: m.id, reason: `Seat ${seat.designator} is an exit row seat; travelers under 15 cannot sit there.` });
      continue;
    }
    bySeat.set(seat.designator, m.id);
    byMember.set(m.id, seat);
    fee += f;
  }
  for (const m of party) {
    if (!byMember.has(m.id) && !violations.some((v) => v.memberId === m.id)) violations.push({ memberId: m.id, reason: "No seat chosen yet." });
  }
  for (const m of party.filter(needsGuardian)) {
    const seat = byMember.get(m.id);
    if (!seat) continue;
    const hasAdult = neighbours(grid, seat).some((nb) => {
      const occ = bySeat.get(nb.designator);
      const o = occ ? memberOf.get(occ) : undefined;
      return !!o && isGuardian(o);
    });
    if (!hasAdult) violations.push({ memberId: m.id, reason: `Seat ${seat.designator} has no adult beside it.` });
  }
  return { together: violations.length === 0, fee, violations };
}
