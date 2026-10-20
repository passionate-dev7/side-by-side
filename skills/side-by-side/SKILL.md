---
name: side-by-side
description: Book family flights where every child sits next to a parent. Use when a traveler asks for flights for their family, wants kids seated beside them, asks what it costs to sit together, wants to change who sits where, books the trip, or asks whether the family is still seated together.
---

# Side by Side

Side by Side is an MCP server for Alexa+. It ranks flights by what it costs for the whole family to sit together, shows the seat map with the family's names on the seats, books the order with the seats in one reservation, and checks the seats again in later sessions.

## Rules the tools enforce

- Every child aged 13 or under is seated directly beside an adult (18 or older), same row, no aisle between. This is the condition behind the U.S. DOT Airline Family Seating Dashboard commitments.
- Nobody under 15 is placed in an exit row.
- Seats, prices and the together verdict come from the tools. Read them back as given. Do not estimate a seat, a fee or a fare.
- Carriers that commit to fee-free adjacent seating for a child 13 or under per the DOT dashboard (read 2026-10-21, dashboard updated 2025-09-05): Alaska, American, Frontier, Hawaiian, JetBlue. Carriers that do not: Allegiant, Delta, Southwest, United. Any other carrier is not on the dashboard and carries no guarantee.
- A booking happens only after the traveler agrees to the price. When the server asks to confirm, relay the question and wait.
- Orders made with a Duffel test token are test bookings. Say "test mode" when you read back a booking reference.

## Flow

1. Who is traveling: `save_family` with names and ages. Ask for ages you do not have. Children under 2 are not supported.
2. Where and when: `find_family_flights` with origin, destination and date. It returns direct flights ranked by the together-total (fare plus the cheapest seat fees that put every child beside an adult).
3. The seat map: `show_seats` for the chosen flight. Describe it in one sentence: who sits where and the total.
4. Changes: `move_traveler` with a seat ("14C") or a position ("aisle", "window"). If the result says the family is no longer together, say which child is alone and offer to undo.
5. Booking: `book_together`. The server may ask for missing passenger details and a final yes. It refuses when a child would sit apart from an adult.
6. Later: `still_together` reads the booked seats and any airline changes and says yes or no with the row change.

## Voice

Speak in short plain sentences. Lead with the answer: "JetBlue seats your family together for 812 dollars, 52 more than the cheapest fare." Name the people and the seats. Do not read tables aloud. Every tool returns a spoken line; use it. On screens the tool also draws a 768 by 480 card, so keep speech to the headline.

## Errors

Every tool answers with a code and a spoken line, even on failure. Read the spoken line. Never retry a booking after `order_pending`; ask the traveler to check again with `still_together`.
