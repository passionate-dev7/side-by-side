# Side by Side

An Alexa+ add-on for families flying together. A parent says "find us flights to Orlando for Thanksgiving, kids next to us." Side by Side reads the seat map of each of the cheapest direct fares, ranks them by the total price of seating each child beside a parent, says how many it evaluated, shows the cabin on the Echo Show with the family's names on the seats, books the order with seats in one reservation, and answers "are we still sitting together?" in a later session, naming any child the airline moved away from an adult.

## What is in the repo

| Path | What it is |
|---|---|
| `server/` | MCP server, Streamable HTTP at `/mcp`, protocol 2025-11-25 and 2025-03-26, built on `@modelcontextprotocol/sdk` and `@modelcontextprotocol/ext-apps` |
| `server/src/solver.ts` | Deterministic seating solver. Plain code, no model. Children 13 and under sit beside an adult, nobody under 15 in an exit row |
| `server/policy/dot-family-seating.json` | U.S. DOT Airline Family Seating Dashboard table with its source URL, read date and the dashboard's own update date. `server/src/dot.ts` validates it at startup and refuses a file that lacks any of them; a carrier not in it never counts as fee-free |
| `server/src/tools/` | Six tools: `save_family`, `find_family_flights`, `show_seats`, `move_traveler`, `book_together`, `still_together` |
| `server/src/ui/side-by-side/` | The MCP Apps view (`ui://side-by-side/seats.html`), 768x480 |
| `server/src/lint/` | Tool description lint for poisoned-description patterns |
| `sim/` | Alexa+ simulator (it plays the Alexa+ host, it is not Alexa+): a real MCP client with the MCP Apps host bridge, Web Speech voice, an LLM tool-choosing loop, and a wire panel showing the MCP handshake (protocol version, tools/list) and every tools/call with its latency in ms |
| `skills/side-by-side/SKILL.md` | Agent Skill: voice rules, tool routing, seating policy |
| `spikes/seats/` | Measurement script for the together-price and latency numbers |

## Run it

Requires Node 24 or newer.

```bash
npm install

# 1. The MCP server. Put a Duffel test token (duffel_test_...) in DUFFEL_ACCESS_TOKEN first.
npm run start -w server        # http://127.0.0.1:8790/mcp, health at /health

# 2. The Alexa+ simulator (needs one LLM credential in the environment, see below)
npm run dev -w sim             # http://127.0.0.1:5173
```

`npm run fixture -w server` serves the same tools over the same transport on the same port, backed by an in-memory Duffel emulator that enforces Duffel's order rules (payment equals fare plus seat services, services exist and are unused, expired offers are refused). Every card it produces is labeled `TEST` and `fixture`. The simulator shows an emulator control next to the device when it is connected to it, so the emulated airline can move a child's seat after booking.

## A short scripted flow

A short flow against the fixture server, by voice or typing in the simulator:

1. `save_family`: Dad 40, Mum 38, Mia 6, Leo 9.
2. `find_family_flights` JFK to MCO: the list says how many fares had their seat maps read, and every card carries Offer, Seats, Rule and Booking labels (`LIVE` or `TEST`).
3. `show_seats` on JetBlue: Delta has the lowest fare ($760) and costs $850 for the family to sit together; JetBlue is $812 fare and $0 in seat fees under the DOT commitment, $812 for the family. The seat map shows both side by side.
4. `show_seats` on United: no two open seats are side by side, so the screen says so and offers the flights that work.
5. `book_together`, then the emulator control moves Mia to 30F, then `still_together`: the view names Mia, her old and new seat, and proposes seats that put her beside an adult again.

The wire panel lists `initialize` with the negotiated protocol version, `tools/list`, and each `tools/call` with its latency in ms.

The simulator's tool-choosing model is configured by environment variable names only: `ANTHROPIC_API_KEY`, or `OPENAI_API_KEY` / `OPENROUTER_API_KEY` (optionally `OPENAI_BASE_URL`), or `AWS_BEARER_TOKEN_BEDROCK` for Amazon Bedrock through its OpenAI-compatible endpoint (`openai.gpt-oss-120b` with tool calling, the default whenever that variable is set; `npx tsx sim/scripts/mantle-turn.ts` runs a full save_family then find_family_flights turn against the fixture server), or `AWS_PROFILE` with `AWS_REGION` for Bedrock Converse. `LLM_PROVIDER` and `LLM_MODEL` pick one explicitly. Keys stay in the Vite server process.

## Checks

```bash
npm test                          # server integration, solver, service, DOT table and lint tests, plus the simulator's wire and spoken-text tests
npm run lint:tools -w server      # exits 1 on a poisoned tool description
npm run lint:tools -w server -- --plant   # plants one, exits 1
npx tsx spikes/seats/spike.ts     # prints the together-price table and latency against Alexa's 500 ms budget
```

## How the numbers are made

- Together-price: fare plus the cheapest seat fees that put every child beside an adult on the flight's live seat map, or no seat fees where the carrier is on the DOT fee-free list and adjacent seats exist. A carrier that is not on the DOT list pays every seat fee.
- Evaluated: the search reads the seat map of up to the 10 cheapest direct fares. The list states how many were evaluated and whether more exist.
- The seating answer is computed by `solver.ts` from the Duffel seat map. The model only chooses which tool to call.
- Every card labels its offer, seat map, DOT rule and booking `LIVE` or `TEST` from the Duffel mode of the data (a `duffel_test_` token gives `TEST`), and names the source: Duffel, or the fixture emulator.
- A child is never booked without an adult beside them. When the open seats cannot do that, the answer is "no adjacent seats on this flight" with the flights of the same search that can.
- Spoken replies are stripped of markdown in code before they are captioned or spoken.
