# Side by Side

An Alexa+ add-on for families flying together. A parent says "find us flights to Orlando for Thanksgiving, kids next to us." Side by Side ranks every direct flight by the total price of seating each child beside a parent, shows the cabin on the Echo Show with the family's names on the seats, books the order with seats in one reservation, and answers "are we still sitting together?" in a later session.

## What is in the repo

| Path | What it is |
|---|---|
| `server/` | MCP server, Streamable HTTP at `/mcp`, protocol 2025-11-25 and 2025-03-26, built on `@modelcontextprotocol/sdk` and `@modelcontextprotocol/ext-apps` |
| `server/src/solver.ts` | Deterministic seating solver. Plain code, no model. Children 13 and under sit beside an adult, nobody under 15 in an exit row |
| `server/src/dot.ts` | U.S. DOT Airline Family Seating Dashboard table with its source URL and read date |
| `server/src/tools/` | Six tools: `save_family`, `find_family_flights`, `show_seats`, `move_traveler`, `book_together`, `still_together` |
| `server/src/ui/side-by-side/` | The MCP Apps view (`ui://side-by-side/seats.html`), 768x480 |
| `server/src/lint/` | Tool description lint for poisoned-description patterns |
| `sim/` | Echo Show simulator: a real MCP client with the MCP Apps host bridge, Web Speech voice, and an LLM tool-choosing loop |
| `skills/side-by-side/SKILL.md` | Agent Skill: voice rules, tool routing, seating policy |
| `spikes/seats/` | Measurement script for the together-price and latency numbers |

## Run it

Requires Node 24 or newer.

```bash
npm install

# 1. The MCP server. Put a Duffel test token (duffel_test_...) in DUFFEL_ACCESS_TOKEN first.
npm run start -w server        # http://127.0.0.1:8787/mcp, health at /health

# 2. The Echo Show simulator (needs one LLM credential in the environment, see below)
npm run dev -w sim             # http://127.0.0.1:5173
```

`npm run fixture -w server` serves the same tools over the same transport on the same port, backed by an in-memory Duffel emulator that enforces Duffel's order rules (payment equals fare plus seat services, services exist and are unused, expired offers are refused). It is the quickest way to try the Echo Show flow.

The simulator's tool-choosing model is configured by environment variable names only: `ANTHROPIC_API_KEY`, or `OPENAI_API_KEY` / `OPENROUTER_API_KEY` (optionally `OPENAI_BASE_URL`), or `AWS_BEARER_TOKEN_BEDROCK` / `AWS_PROFILE` with `AWS_REGION` for Amazon Bedrock. `LLM_PROVIDER` and `LLM_MODEL` pick one explicitly. Keys stay in the Vite server process.

## Checks

```bash
npm test                          # server integration, solver, service and lint tests
npm run lint:tools -w server      # exits 1 on a poisoned tool description
npm run lint:tools -w server -- --plant   # plants one, exits 1
npx tsx spikes/seats/spike.ts     # prints the together-price table and latency against Alexa's 500 ms budget
```

## How the numbers are made

- Together-price: fare plus the cheapest seat fees that put every child beside an adult on the flight's live seat map, or no seat fees where the carrier is on the DOT fee-free list and adjacent seats exist.
- The seating answer is computed by `solver.ts` from the Duffel seat map. The model only chooses which tool to call.
- Every card is labeled test mode when the order is made with a Duffel test token.
