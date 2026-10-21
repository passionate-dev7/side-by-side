import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/**
 * U.S. DOT Airline Family Seating Dashboard, loaded at startup from policy/dot-family-seating.json.
 * The file carries its source URL, the date it was read and the date the dashboard itself was last updated, and this
 * module refuses to start on a file that lacks any of them. A carrier that is not in the file has no guarantee: lookups
 * return null, never true.
 */

const CONDITION_IDS = ["same_reservation", "adjacent_in_class", "no_downgauge", "seats_untouched", "layout_possible"] as const;
export type DotConditionId = (typeof CONDITION_IDS)[number];

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => !Number.isNaN(Date.parse(s)), "not a calendar date");

const DotFile = z
  .object({
    source: z.object({
      name: z.string().min(1),
      url: z.url().refine((u) => u.startsWith("https://") && new URL(u).hostname.endsWith("transportation.gov"), "must be an https transportation.gov URL"),
      readOn: isoDate,
      dashboardUpdated: isoDate,
      method: z.string().min(1),
    }),
    childMaxAge: z.number().int().min(1).max(17),
    /** "all": the dashboard row says the commitment holds for all fare types and names no exclusion. */
    fareTypes: z.literal("all"),
    fareTypesSource: z.string().min(1),
    conditions: z
      .array(z.object({ id: z.enum(CONDITION_IDS), appliesTo: z.string().min(1), text: z.string().min(1) }).strict())
      .min(CONDITION_IDS.length),
    assignedBy: z.string().min(1),
    carriers: z
      .array(z.object({ iata: z.string().regex(/^[A-Z0-9]{2}$/, "two character IATA code, upper case"), name: z.string().min(1), feeFreeAdjacent: z.boolean() }).strict())
      .min(1),
  })
  .strict()
  .superRefine((f, ctx) => {
    const seen = new Set<string>();
    for (const c of f.carriers) {
      if (seen.has(c.iata)) ctx.addIssue({ code: "custom", message: `carrier ${c.iata} is listed twice` });
      seen.add(c.iata);
    }
    const ids = new Set(f.conditions.map((c) => c.id));
    for (const id of CONDITION_IDS) if (!ids.has(id)) ctx.addIssue({ code: "custom", message: `condition ${id} is missing` });
    if (ids.size !== f.conditions.length) ctx.addIssue({ code: "custom", message: "a condition is listed twice" });
    if (f.source.readOn < f.source.dashboardUpdated) ctx.addIssue({ code: "custom", message: "readOn is earlier than the dashboard's own update date" });
  });

export type DotTable = z.infer<typeof DotFile>;

/** Parses and validates a table file. Throws, naming the first problem, on anything that is not source-backed and dated. */
export function parseDotTable(json: string): DotTable {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    throw new Error(`DOT table is not JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  const r = DotFile.safeParse(raw);
  if (!r.success) throw new Error(`DOT table rejected: ${r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
  return r.data;
}

/** true/false as listed by DOT, null when the carrier is not on the dashboard (no guarantee is assumed). */
export function lookupFeeFree(table: DotTable, iata: string): boolean | null {
  return table.carriers.find((c) => c.iata === iata.toUpperCase())?.feeFreeAdjacent ?? null;
}

export const DOT_FILE = fileURLToPath(new URL("../policy/dot-family-seating.json", import.meta.url));
const table = parseDotTable(readFileSync(DOT_FILE, "utf8"));

export const DOT_SOURCE = { url: table.source.url, readOn: table.source.readOn, dashboardUpdated: table.source.dashboardUpdated } as const;
export const DOT_CHILD_MAX_AGE = table.childMaxAge;
export const DOT_CONDITIONS: ReadonlyArray<{ id: DotConditionId; text: string }> = table.conditions.map(({ id, text }) => ({ id, text }));
export const DOT_FARE_TYPES = table.fareTypes;
export const DOT_ASSIGNED_BY = table.assignedBy;
export const DOT_CARRIERS: ReadonlyArray<{ iata: string; name: string; feeFreeAdjacent: boolean }> = table.carriers;

export const dotFeeFreeAdjacent = (iata: string): boolean | null => lookupFeeFree(table, iata);
/** The dashboard's name for a listed carrier, null when it is not listed. */
export const dotCarrierName = (iata: string): string | null => table.carriers.find((c) => c.iata === iata.toUpperCase())?.name ?? null;
