import { describe, expect, it } from "vitest";
import { buildGrid, neighbours, type Grid } from "../src/seatmap.js";
import { evaluateAssignment, solveSeating, type PartyMember } from "../src/solver.js";
import { dotFeeFreeAdjacent, DOT_SOURCE } from "../src/dot.js";
import { makeSeatMap } from "./fixtures/seatmap.js";

const P = (id: string, age: number, seatPreference?: "aisle" | "window"): PartyMember => ({ id, passengerId: `pas_${id}`, age, seatPreference });
const family = [P("dad", 40), P("mum", 38), P("mia", 6), P("leo", 9)];
const pids = family.map((m) => m.passengerId);

function grid(spec: Partial<Parameters<typeof makeSeatMap>[0]> = {}): Grid {
  return buildGrid(makeSeatMap({ rows: 30, layout: [3, 3], passengerIds: pids, ...spec }));
}

describe("seat map model", () => {
  it("treats a seat with no available services as taken and an aisle as a break in adjacency", () => {
    const g = grid({ taken: ["1B"] });
    expect(g.seats.get("1B")!.fees.size).toBe(0);
    expect(neighbours(g, g.seats.get("1C")!).map((s) => s.designator)).toEqual(["1B"]);
    expect(neighbours(g, g.seats.get("1D")!).map((s) => s.designator)).toEqual(["1E"]);
    expect(g.seats.get("1C")!.aisle && g.seats.get("1D")!.aisle).toBe(true);
    expect(g.seats.get("1A")!.window && g.seats.get("1F")!.window).toBe(true);
  });
});

describe("solver", () => {
  it("seats a family of four in one block of four on a 2-4-2 widebody, and in two blocks of two on a 3-3 narrowbody", () => {
    const wide = solveSeating(grid({ layout: [2, 4, 2] }), family);
    expect(wide.status === "TOGETHER" && wide.blocks).toBe(1);
    const narrow = solveSeating(grid(), family);
    expect(narrow.status === "TOGETHER" && narrow.blocks).toBe(2);
  });

  it("seats the whole family at $0 on an open cabin, children beside adults", () => {
    const s = solveSeating(grid(), family);
    expect(s.status).toBe("TOGETHER");
    if (s.status !== "TOGETHER") return;
    expect(s.fee).toBe(0);
    expect(s.exact).toBe(true);
    const ev = evaluateAssignment(grid(), family, s.assignments);
    expect(ev.together).toBe(true);
  });

  it("is deterministic: the same input gives byte-identical seats", () => {
    const a = JSON.stringify(solveSeating(grid({ taken: ["1A", "2C", "3D"] }), family));
    const b = JSON.stringify(solveSeating(grid({ taken: ["1A", "2C", "3D"] }), family));
    expect(a).toBe(b);
  });

  it("pays for the cheapest adjacent block when every free seat next to another has a fee", () => {
    const fee = (d: string) => (parseInt(d, 10) <= 2 ? 0 : 12);
    // rows 1 and 2 keep only isolated single seats free (no two neighbours), the rest cost 12 each
    const taken = ["1B", "1C", "1E", "1F", "2A", "2C", "2D", "2F"];
    const g = grid({ fee, taken });
    const s = solveSeating(g, [P("dad", 40), P("mia", 6)]);
    expect(s.status).toBe("TOGETHER");
    if (s.status !== "TOGETHER") return;
    // dad and mia must pair on a priced pair of seats: 2 x 12 = 24 dollars, 2400 minor units
    expect(s.fee).toBe(2400);
  });

  it("returns NOT_TOGETHER when every adjacent pair is taken", () => {
    // only the aisle-separated seats 'A' and 'D'... leave one free seat per section: nobody has a neighbour
    const taken: string[] = [];
    for (let r = 1; r <= 30; r++) for (const c of ["B", "C", "E", "F"]) taken.push(`${r}${c}`);
    const s = solveSeating(grid({ taken }), family);
    expect(s.status).toBe("NOT_TOGETHER");
    if (s.status !== "NOT_TOGETHER") return;
    expect(s.reasons.length).toBeGreaterThan(0);
  });

  it("returns NOT_TOGETHER for a child on a booking with no adult", () => {
    const s = solveSeating(grid(), [P("mia", 6), P("leo", 9)]);
    expect(s.status).toBe("NOT_TOGETHER");
  });

  it("never puts a child in an exit row, even when that is the only block", () => {
    const taken: string[] = [];
    for (let r = 1; r <= 30; r++) if (r !== 12) for (const c of ["A", "B", "C", "D", "E", "F"]) taken.push(`${r}${c}`);
    const s = solveSeating(grid({ taken, exitRows: [12] }), [P("dad", 40), P("mia", 6)]);
    expect(s.status).toBe("NOT_TOGETHER");
    // control: the same cabin without the exit designation is solvable, so the exit rule is what changed the answer
    const control = solveSeating(grid({ taken }), [P("dad", 40), P("mia", 6)]);
    expect(control.status).toBe("TOGETHER");
  });

  it("an adult cannot be a guardian for more children than they have neighbours", () => {
    const s = solveSeating(grid(), [P("dad", 40), P("a", 5), P("b", 7), P("c", 9)]);
    expect(s.status).toBe("NOT_TOGETHER");
  });

  it("a 15 year old does not count as a guardian", () => {
    const s = solveSeating(grid(), [P("teen", 15), P("mia", 6)]);
    expect(s.status).toBe("NOT_TOGETHER");
  });

  it("honours an aisle preference when it costs nothing", () => {
    const s = solveSeating(grid(), [P("dad", 40, "aisle"), P("mia", 6)]);
    expect(s.status).toBe("TOGETHER");
    if (s.status !== "TOGETHER") return;
    expect(s.unmetPreferences).toBe(0);
    const dadSeat = s.assignments.find((a) => a.memberId === "dad")!.seat;
    expect(grid().seats.get(dadSeat)!.aisle).toBe(true);
  });

  it("matches an exhaustive search on 300 random small cabins (fee optimum and feasibility)", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
    const parties: PartyMember[][] = [
      [P("a1", 40), P("c1", 6)],
      [P("a1", 40), P("a2", 38), P("c1", 6)],
      [P("a1", 40), P("c1", 6), P("c2", 9)],
      [P("a1", 40), P("a2", 38), P("c1", 6), P("c2", 9)],
    ];
    let together = 0;
    let notTogether = 0;
    for (let i = 0; i < 300; i++) {
      const party = parties[i % parties.length];
      const ids = party.map((m) => m.passengerId);
      const layout = i % 2 ? [2, 2] : [3, 3];
      const rows = party.length === 4 ? 2 : 3;
      const spec = makeSeatMap({
        rows,
        layout,
        passengerIds: ids,
        taken: Array.from({ length: rows * layout.reduce((a, b) => a + b, 0) }, (_, k) => k)
          .filter(() => rnd() < 0.35)
          .map((k) => {
            const per = layout.reduce((a, b) => a + b, 0);
            return `${Math.floor(k / per) + 1}${"ABCDEF"[k % per]}`;
          }),
        fee: (d) => ((d.charCodeAt(0) * 7 + d.charCodeAt(1) * 3) % 5) * 5,
      });
      const g = buildGrid(spec);
      const seats = [...g.seats.values()].filter((s) => s.fees.size > 0);

      // exhaustive: every injective assignment of members to free seats
      let bestFee = Infinity;
      const chosen: Array<{ memberId: string; seat: string }> = [];
      const used = new Set<string>();
      const rec = (k: number) => {
        if (k === party.length) {
          const ev = evaluateAssignment(g, party, chosen);
          if (ev.together && ev.fee < bestFee) bestFee = ev.fee;
          return;
        }
        for (const s of seats) {
          if (used.has(s.designator)) continue;
          used.add(s.designator);
          chosen.push({ memberId: party[k].id, seat: s.designator });
          rec(k + 1);
          chosen.pop();
          used.delete(s.designator);
        }
      };
      rec(0);

      const sol = solveSeating(g, party);
      if (bestFee === Infinity) {
        expect(sol.status, `case ${i} should be infeasible`).toBe("NOT_TOGETHER");
        notTogether++;
      } else {
        expect(sol.status, `case ${i} should be feasible`).toBe("TOGETHER");
        if (sol.status === "TOGETHER") {
          expect(sol.fee, `case ${i} fee`).toBe(bestFee);
          expect(evaluateAssignment(g, party, sol.assignments).together).toBe(true);
        }
        together++;
      }
    }
    // the comparison only means something if both outcomes actually occurred
    expect(together).toBeGreaterThan(30);
    expect(notTogether).toBeGreaterThan(30);
  });
});

describe("evaluateAssignment", () => {
  it("flags a child seated across the aisle from the only adult", () => {
    const g = grid();
    const ev = evaluateAssignment(g, [P("dad", 40), P("mia", 6)], [
      { memberId: "dad", seat: "10C" },
      { memberId: "mia", seat: "10D" },
    ]);
    expect(ev.together).toBe(false);
    expect(ev.violations[0].memberId).toBe("mia");
  });

  it("flags a taken seat and a double booking", () => {
    const g = grid({ taken: ["5A"] });
    const ev = evaluateAssignment(g, [P("dad", 40), P("mia", 6)], [
      { memberId: "dad", seat: "5A" },
      { memberId: "mia", seat: "5A" },
    ]);
    expect(ev.together).toBe(false);
    expect(ev.violations.map((v) => v.reason).join(" ")).toMatch(/taken/);
  });

  it("accepts a child between two adults", () => {
    const ev = evaluateAssignment(grid(), [P("dad", 40), P("mum", 38), P("mia", 6)], [
      { memberId: "dad", seat: "7A" },
      { memberId: "mia", seat: "7B" },
      { memberId: "mum", seat: "7C" },
    ]);
    expect(ev.together).toBe(true);
  });
});

describe("DOT family seating table", () => {
  it("lists the five fee-free carriers and four non-guaranteeing carriers from the dashboard", () => {
    expect(["AS", "AA", "F9", "HA", "B6"].map(dotFeeFreeAdjacent)).toEqual([true, true, true, true, true]);
    expect(["G4", "DL", "WN", "UA"].map(dotFeeFreeAdjacent)).toEqual([false, false, false, false]);
    expect(dotFeeFreeAdjacent("ZZ")).toBeNull();
    expect(DOT_SOURCE.readOn).toBe("2026-10-21");
  });
});
