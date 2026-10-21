import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DOT_CARRIERS, DOT_CHILD_MAX_AGE, DOT_FILE, DOT_SOURCE, dotFeeFreeAdjacent, lookupFeeFree, parseDotTable } from "../src/dot.js";

const onDisk = readFileSync(DOT_FILE, "utf8");
const base = () => JSON.parse(onDisk) as Record<string, any>;
const reject = (mutate: (f: Record<string, any>) => void, message: RegExp) => {
  const f = base();
  mutate(f);
  expect(() => parseDotTable(JSON.stringify(f))).toThrowError(message);
};

describe("DOT family seating table (policy/dot-family-seating.json, loaded at startup)", () => {
  it("carries its source URL, the date it was read and the dashboard's own update date", () => {
    expect(DOT_SOURCE).toEqual({
      url: "https://www.transportation.gov/airconsumer/airline-family-seating-dashboard",
      readOn: "2026-10-21",
      dashboardUpdated: "2025-09-05",
    });
    expect(DOT_CHILD_MAX_AGE).toBe(13);
  });

  it("lists the five fee-free carriers and four non-guaranteeing carriers exactly as the dashboard row reads", () => {
    expect(DOT_CARRIERS).toHaveLength(9);
    expect(["AS", "AA", "F9", "HA", "B6"].map(dotFeeFreeAdjacent)).toEqual([true, true, true, true, true]);
    expect(["G4", "DL", "WN", "UA"].map(dotFeeFreeAdjacent)).toEqual([false, false, false, false]);
    expect(dotFeeFreeAdjacent("b6")).toBe(true);
  });

  it("an unknown carrier is null, never fee-free: not a made-up code, not Spirit (linked on the dashboard but not in its table), not empty", () => {
    for (const code of ["ZZ", "QQ", "NK", "", "B", "B66"]) expect(dotFeeFreeAdjacent(code)).toBeNull();
    // every two letter code that is not in the file: none may come back true
    const listed = new Set(DOT_CARRIERS.map((c) => c.iata));
    const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    let checked = 0;
    for (const a of letters) for (const b of letters) {
      if (listed.has(a + b)) continue;
      checked++;
      expect(dotFeeFreeAdjacent(a + b)).toBeNull();
    }
    expect(checked).toBe(26 * 26 - DOT_CARRIERS.filter((c) => /^[A-Z]{2}$/.test(c.iata)).length);
  });

  it("a table that listed an unknown carrier as fee-free is the only way one could be, and the lookup is driven by the file", () => {
    const t = parseDotTable(onDisk);
    expect(lookupFeeFree(t, "AS")).toBe(true);
    const edited = parseDotTable(JSON.stringify({ ...base(), carriers: [...base().carriers, { iata: "QQ", name: "Nowhere Air", feeFreeAdjacent: true }] }));
    expect(lookupFeeFree(edited, "QQ")).toBe(true);
    expect(lookupFeeFree(t, "QQ")).toBeNull();
  });

  describe("the loader rejects a table that is not dated and source-backed", () => {
    it("accepts the shipped file", () => {
      expect(() => parseDotTable(onDisk)).not.toThrow();
    });
    it("no source", () => reject((f) => delete f.source, /source/));
    it("no read date", () => reject((f) => delete f.source.readOn, /source\.readOn/));
    it("no dashboard update date", () => reject((f) => delete f.source.dashboardUpdated, /source\.dashboardUpdated/));
    it("a read date that is not a date", () => reject((f) => (f.source.readOn = "2026-13-45"), /readOn/));
    it("a read date earlier than the dashboard's own update", () => reject((f) => (f.source.readOn = "2025-01-01"), /earlier than the dashboard/));
    it("a source that is not https", () => reject((f) => (f.source.url = "http://www.transportation.gov/x"), /https transportation\.gov/));
    it("a source on another host", () => reject((f) => (f.source.url = "https://example.com/dot"), /https transportation\.gov/));
    it("a duplicate carrier", () => reject((f) => f.carriers.push({ ...f.carriers[0] }), /AS is listed twice/));
    it("a flag that is not a boolean", () => reject((f) => (f.carriers[0].feeFreeAdjacent = "yes"), /feeFreeAdjacent/));
    it("a flag that is missing, so a carrier cannot default to fee-free", () => reject((f) => delete f.carriers[0].feeFreeAdjacent, /feeFreeAdjacent/));
    it("a lower case code", () => reject((f) => (f.carriers[0].iata = "as"), /IATA/));
    it("an empty carrier list", () => reject((f) => (f.carriers = []), /carriers/));
    it("a field nobody declared", () => reject((f) => (f.defaultFeeFree = true), /defaultFeeFree|Unrecognized/));
    it("something that is not JSON", () => expect(() => parseDotTable("{nope")).toThrowError(/not JSON/));
  });
});
