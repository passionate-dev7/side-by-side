import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { bookTogether, checkTrip, findFamilyFlights, moveTraveler, saveFamily, showSeats } from "../service.js";
import { loadView } from "../ui/load-view.js";
import { elicitorFor, guarded, SEATS_UI_URI, type ToolModule } from "./shared.js";

const ui = { ui: { resourceUri: SEATS_UI_URI } };
const iata = z
  .string()
  .regex(/^[A-Za-z]{3}$/, "three letter airport code")
  .transform((s) => s.toUpperCase());
/** Language models send null for an optional argument they have no value for; read it as absent. */
const opt = <T extends z.ZodType>(t: T) => t.nullish().transform((v) => v ?? undefined);
const offerId = z.string().min(1).max(80).describe("Flight offer id from the ranked list");

export const register: ToolModule = (server, ctx) => {
  registerAppResource(
    server,
    "Side by Side seat map",
    SEATS_UI_URI,
    { description: "768x480 screens for ranked flights, the seat map, the booking and the still-together check", mimeType: RESOURCE_MIME_TYPE },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: RESOURCE_MIME_TYPE, text: loadView("side-by-side"), _meta: { ui: { prefersBorder: false } } }] }),
  );

  registerAppTool(
    server,
    "save_family",
    {
      title: "Save family",
      description: "Save the travelers on a family trip: names, ages and an optional aisle or window preference. Replaces any saved family.",
      inputSchema: {
        travelers: z
          .array(
            z.object({
              name: z.string().min(1).max(40).describe("First name"),
              age: z.number().int().min(2).max(120).describe("Age on the travel date"),
              seat_preference: opt(z.enum(["aisle", "window"])).describe("Preferred seat position"),
              born_on: opt(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).describe("Date of birth, YYYY-MM-DD"),
              gender: opt(z.enum(["m", "f"])).describe("Gender on the passport"),
            }),
          )
          .min(1)
          .max(6)
          .describe("Everyone traveling, 1 to 6 people"),
        family_name: opt(z.string().min(1).max(60)).describe("Surname on the tickets"),
        email: opt(z.string().email()).describe("Contact email"),
        phone_number: opt(z.string().min(6).max(20)).describe("Contact phone with country code"),
      },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
      _meta: ui,
    },
    (a) =>
      guarded(() =>
        saveFamily(ctx, {
          travelers: a.travelers.map((t) => ({ name: t.name, age: t.age, seatPreference: t.seat_preference, bornOn: t.born_on, gender: t.gender })),
          familyName: a.family_name,
          email: a.email,
          phoneNumber: a.phone_number,
        }),
      ),
  );

  registerAppTool(
    server,
    "find_family_flights",
    {
      title: "Find family flights",
      description: "Search direct one-way flights for the family saved on this account, including one saved in an earlier conversation, and rank them by the total cost of seating every child beside an adult, seat fees included. Call it without asking for names or ages again; it says so if no family is saved yet.",
      inputSchema: {
        origin: iata.describe("Departure airport code, for example JFK"),
        destination: iata.describe("Arrival airport code, for example MCO"),
        departure_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Departure date, YYYY-MM-DD"),
        cabin: z.enum(["economy", "premium_economy", "business", "first"]).nullish().transform((v) => v ?? "economy").describe("Cabin class"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
      _meta: ui,
    },
    (a) => guarded(() => findFamilyFlights(ctx, { origin: a.origin, destination: a.destination, departureDate: a.departure_date, cabin: a.cabin })),
  );

  registerAppTool(
    server,
    "show_seats",
    {
      title: "Show seats",
      description: "Show the seat map of one flight with the family's proposed seats and whether every child sits beside an adult.",
      inputSchema: { offer_id: offerId },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
      _meta: ui,
    },
    (a) => guarded(() => showSeats(ctx, a.offer_id)),
  );

  registerAppTool(
    server,
    "move_traveler",
    {
      title: "Move traveler",
      description: "Move one traveler to a named seat, or to an aisle or window seat, and re-check that every child still sits beside an adult.",
      inputSchema: {
        offer_id: offerId,
        traveler: z.string().min(1).max(40).describe("First name of the traveler to move"),
        seat: opt(z.string().regex(/^\d{1,2}[A-Za-z]$/)).describe("Seat designator such as 14C"),
        position: opt(z.enum(["aisle", "window"])).describe("Aisle or window, when no seat is named"),
      },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
      _meta: ui,
    },
    (a) =>
      guarded(() => {
        if (!!a.seat === !!a.position) {
          return { kind: "error" as const, code: "seat_or_position", message: "Give either a seat or an aisle or window position, not both and not neither.", voice: "Tell me a seat number, or say aisle or window." };
        }
        return moveTraveler(ctx, { offerId: a.offer_id, traveler: a.traveler, seat: a.seat, position: a.position });
      }),
  );

  registerAppTool(
    server,
    "book_together",
    {
      title: "Book together",
      description: "Book the flight with the chosen seats in one order, after checking the seats are still open and every child sits beside an adult.",
      inputSchema: {
        offer_id: offerId,
        confirmed: z.boolean().nullish().transform((v) => v ?? false).describe("True once the traveler has agreed to the price"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      _meta: ui,
    },
    (a) => guarded(() => bookTogether(ctx, { offerId: a.offer_id, confirmed: a.confirmed }, elicitorFor(server))),
  );

  registerAppTool(
    server,
    "still_together",
    {
      title: "Still together",
      description: "Check a booked trip: read the current seats and any airline changes, and say whether the family still sits together.",
      inputSchema: { order_id: opt(z.string().min(1).max(80)).describe("Order id or booking reference, defaults to the latest booking") },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      _meta: ui,
    },
    (a) => guarded(() => checkTrip(ctx, a.order_id)),
  );
};
