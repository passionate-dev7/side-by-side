# DESIGN.md: Side by Side

Hallmark catalog theme: **Midnight** (atmospheric cluster: cool dark canvas, hue 250, Geist display and body, hairline structure, fade-only motion). Genre: atmospheric. Component scope: device screens (768x480 MCP Apps view) plus the web simulator that hosts them.

Extended, not invented. The device canvas is fixed by Amazon's published Alexa visual foundations (768x480 base canvas, Echo Show 8/15 root scale 1.667, dark card #14181E, light card #FFFFFF, type tokens 48/40/32/28/24/20/18/16/14/12/10/8 px, spacing 2/6/8/12/16/20/24, radii 4/8/12/16, both themes, legible at 3 ft). Midnight supplies the hue family, the neutral ramp, the accent discipline and the motion language. The two Amazon card surfaces are vendor-fixed and enter the token set unchanged.

## Audience, use case, tone

- Audience: a parent (and a child beside them) at a kitchen Echo Show, three feet from the screen, deciding where four people sit.
- Use case: choose the flight where the children sit next to a parent, move a name onto another seat, book. One action per screen.
- Tone: utilitarian, austere, calm. An instrument panel for a family decision, not a travel brochure.

## Tokens

All colour is referenced by token. No raw hex or oklch in components.

```css
:root, [data-theme="dark"] {
  --card:        #14181E;                    /* Amazon dark card, vendor fixed */
  --surface-2:   oklch(25% 0.014 258);       /* +1 elevation, lighter not shadowed */
  --surface-3:   oklch(31% 0.016 258);       /* +2 elevation */
  --rule:        oklch(36% 0.014 258);
  --ink:         oklch(95% 0.006 250);
  --muted:       oklch(76% 0.012 255);
  --accent:      oklch(80% 0.125 232);       /* signal sky, hue 232, never violet */
  --accent-ink:  oklch(20% 0.03 250);
  --ok:          oklch(80% 0.15 155);
  --warn:        oklch(84% 0.14 82);
  --danger:      oklch(72% 0.17 25);
}
[data-theme="light"] {
  --card:        #FFFFFF;                    /* Amazon light card, vendor fixed */
  --surface-2:   oklch(96% 0.006 250);
  --surface-3:   oklch(92% 0.010 250);
  --rule:        oklch(84% 0.010 252);
  --ink:         oklch(22% 0.020 258);
  --muted:       oklch(44% 0.020 258);
  --accent:      oklch(48% 0.165 245);
  --accent-ink:  oklch(98% 0.004 250);
  --ok:          oklch(44% 0.12 155);
  --warn:        oklch(48% 0.11 70);
  --danger:      oklch(48% 0.18 25);
}
```

Status colour is never the only signal: every green or amber state also carries a word ("Together", "Not together", "$0 seat fee") and, on seats, a different shape (filled, outlined, hatched).

## Type

Geist variable (SIL OFL), embedded in the view as a data URI so the sandboxed iframe needs no network. Fallback stack ends in a neutral sans, never Inter. Tabular figures on every price, time and seat designator. Dark mode body weight 400 maps to variable weight 380.

Device scale (px on the 768x480 canvas): 48 booking reference and hero verdict, 32 screen title and price totals, 28 airline name, 24 body and name chips, 20 secondary labels and seat designators, 18 and below only for map annotations (row numbers, fee on a seat). Minimum for any decision-bearing text is 24.

Simulator chrome (outside the device) uses Geist at 14 to 20 and Geist Mono for protocol text.

## Spacing and radius

Spacing: 2, 6, 8, 12, 16, 20, 24 (Amazon). Screen padding 24. Radii: 4, 8, 12, 16. Seat 12, chip 8, button 12, device bezel 28.

## Components

- Screen: one title, one or two fields, one action. 768x480, `overflow: hidden`.
- Seat (free): `--surface-2` fill, `--rule` border. Seat (taken): hatched `--surface-2`, no pointer. Seat (mine): holds the name chip.
- Name chip: `--accent` fill for adults, `--ok` outline plus a small-size glyph for children, so children read differently without colour alone. Draggable (pointer events), tappable (select, then tap a seat).
- Verdict chip: `--ok` "Together" or `--warn` "Not together", with the violation sentence beside it.
- Flight card: airline and times, then the sum in one line (fare, each seat fee, what the DOT waiver took off), then the waiver verdict with its reason; the family total sits right at 32px and the card's rank under it. Colour goes on the winning card and its waiver word only.
- Primary button: `--accent` fill, 56px tall, 12px radius, one per screen.
- Source line: one muted line at the foot of every screen naming the airline seat maps and the DOT dashboard edition the rule comes from.
- Device frame: restrained bezel around the 768x480 canvas, no fake browser chrome.

## Motion

Fade and 8px rise only, 220ms `--ease-out`. Chip moves are a 120ms transform. `prefers-reduced-motion: reduce` collapses everything to a 150ms opacity change. No bounce, no glow, no looping animation except the one functional waiting indicator, which becomes static under reduced motion.

## Bans in force

Inter, Roboto, Arial or system-ui as display face. Purple or blue-to-pink gradients. Gradient text. Emoji icons. Three equal feature cards. Side-stripe cards. Em dashes. "No data" empty states. Fake browser chrome.
