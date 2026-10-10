# Changelog

## 0.3.27

- Desktop: the bright accent is part of the card now: a line down the inside of its left border that curves along the top and bottom borders at its ends. The accent's SVG pieces carry a real `alt` (an SVG with an empty one may not draw).

## 0.3.26

- Desktop: the accent bar lives in a full-width one-cell column, so its curved ends are no longer squeezed by a 2px parent.

## 0.3.25

- Desktop: the accent bar's ends curve toward the card like its rounded corner. The live buffer is grey (chip, bar and, in the terminal, its title).

## 0.3.24

- Desktop: the accent bar has rounded ends (small SVG caps above and below the stretching middle).

## 0.3.23

- Desktop: the accent bar is about 2px (17% of a one-cell column) instead of 8px.

## 0.3.22

- Desktop: each card has a bright bar of its colour beside it (about 1% of the width) and a darker border; a gap now separates the header from the first card. Replaces the overlaid left line, which did not render.

## 0.3.21

- Desktop: the bright left edge is a 3px SVG line clipped to the card's height, replacing the zero-width box that drew a stray outline.

## 0.3.20

- Desktop: the bright left edge is a hairline over the border instead of a solid block, so cards no longer look thicker.

## 0.3.19

- Desktop: card borders are dim, with a bright strip of the panel's colour down the left edge.

## 0.3.18

- Desktop: header card with a logo badge and agents pill, a role line, a pill-style WORKING tag, the gate's recent checks as verdict-coloured cells on its title row, tinted state chips in the fleet, and an inset buffer for the log.

## 0.3.17

- Desktop: each card has a faint tint of its own colour, and the context window and quotas are segmented SVG bars (amber past 80%).

## 0.3.16

- Desktop: each panel's title is an SVG chip (rounded, with a marker, in the panel's colour). Buttons, fleet rows and numbers stay live text.

## 0.3.15

- Terminal panels carry their title on the top border. The gate buttons no longer repeat their hotkey (`f: f:file`), and at narrow widths the gate shows only non-zero tallies.

## 0.3.14

- New look. Desktop: rounded cards, with effort, requests and cost as tiles, a context bar and the quotas under it. Terminal: marked, boxed sections with a context ruler, three stat columns and check pills. Panels are numbered (`01 // AGENT CORE`, `02 // GATEWAY`, `03 // FLEET`, `04 // LIVE BUFFER`).
- Fleet table gains IDLE and STATE columns; the session log is now the live buffer with the turn clock. Still real data only: no latency, network or burn-rate figures.

## 0.3.2

- A background architect's advice is read from its `SubagentHandback` tool call, where the report actually arrives, with the hand-back text as a fallback. Bold markers no longer leak into the advice line.
- README: no longer promises that counters survive every update; a change to the state's shape may reset them once.

## 0.3.1

- The main box shows the model and effort as soon as a request starts, not after the first one finishes.
- Advice from a background architect agent (such as `fable-advisor`) now reaches the architect's `»` line; it arrives as a hand-back message, not as the agent's own answer.
- New README media showing the Flightdeck header; plainer wording about opening on start.
- More gate tests (24 in all).

## 0.3.0

First public release.

- Panels: main vitals (context, compactions, cost, rate limits), architect timeline, permission gate strip with per-family drill-down, agent cards and swimlanes, other loops, turn receipt, session log.
- Layouts: docked one- or two-column, and an 8-row inline summary for the main screen. Cards fall back to swimlanes when they don't fit.
- Theme colours by default, with a `pastel` palette option.
- Animated connectors and live clocks as surface modules, only while work flows.
- Works on the terminal, desktop app, VS Code and mobile surfaces.
- Config for the architect pattern, labels, panels, layout, card limit, motion, moments, palette, opening on start and the status line.
- `/clear` and `/flightdeck reset` start the pane fresh; reads tolerate missing or older fields.
