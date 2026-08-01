# Web Games

Small browser games with no build step and no dependencies. Every game is plain
HTML, CSS and classic JavaScript — open a page in a browser and it runs, whether
served over HTTP or opened straight from disk.

Open [`index.html`](index.html) for the catalog, or serve the folder:

```sh
python3 -m http.server 8000
# then visit http://localhost:8000
```

## Games

### Water Works — [`games/water-works/`](games/water-works/)

A process-control puzzle. Three inlets feed a 3×3 grid of vats, and 23 pumps
move water down and across the grid into Vat 10 at the bottom.

**Goal:** fill Vat 10 to 100%.

**You lose if:**

- any of Vats 1–9 overflows (reaches its 100-gallon capacity), or
- a pump runs dry — it is switched on and its source cannot supply the rate it
  is asking for, for more than 2 seconds. A starving pump pulses amber first, so
  there is time to react.

**Controls:** click a pump button to switch it on or off. Shift-click selects it
without toggling. Tune the selected pump with the inspector slider, the scroll
wheel over its button, or the arrow keys. Tab reaches every pump; Space toggles.

**Layout.** Vats 1–3 sit under the inlets, 4–6 in the middle, 7–9 on the bottom
row, and Vat 10 spans the base. Pumps P1–P9 run straight down each column,
P10/P13/P16/P17/P22/P23 run left-to-right within a row, and the rest cross
diagonally between rows. Every pump flows down or right, so the plumbing is a
DAG — there are no loops to stabilise.

**Reference solution** (if you want to see it finish): set all three inlets to
10 gal/s, then bring on P1–P3, P4–P6 and P7–P9 at 10 gal/s each, roughly five
seconds apart. Vats 1–9 hold steady near 50 gallons and Vat 10 fills in about
48 seconds.

## Tests

The simulation is pure and has no DOM dependencies, so it runs directly under
Node with nothing installed:

```sh
node tests/engine.test.js
```

This covers conservation of mass, overflow and dry-run detection, the grace
timer, proportional scaling when several pumps share a starved source, topology
integrity, and that the reference solution above actually wins.

## Adding a game

1. Create `games/<name>/` with its own `index.html`, `style.css` and scripts.
2. Keep it dependency-free and use classic `<script>` tags — ES modules break
   when a page is opened over `file://`.
3. Add a card for it to the root `index.html`.
4. If it has simulation logic worth testing, keep that logic DOM-free and wrap
   it as `(function (root) { ... })(typeof window !== 'undefined' ? window : globalThis)`
   so a Node test can `require()` it. See `games/water-works/engine.js`.
