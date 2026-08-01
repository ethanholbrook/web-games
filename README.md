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

A plumbing puzzle. Inlets feed a grid of vats, pumps move water down and across
into a reservoir at the bottom, and **every pipe moves a fixed number of gallons
per second, printed beside it**. Your only control is which pumps are running.

**Goal:** fill the reservoir to 100%.

**You lose if:**

- any vat overflows, or
- a pump runs dry — it is on and its source cannot supply the rate it is asking
  for, for more than 2 seconds. A starving pump pulses amber first.

The puzzle is *which* pumps and *in what order*. Every vat starts empty, so a
pump switched on too early has nothing to draw; and a vat taking in more than it
sends out will eventually overflow. A plant is stable when every vat's inflow
matches its outflow — but some levels have no stable answer at all and can only
be won by letting a vat fill and then draining it faster than it refills.

You can pause at any time and keep flipping switches. It's a thinking problem,
not a reflex test.

**Contents:** a nine-level campaign, a daily puzzle that is the same for
everyone and regenerates each day, and the original Sandbox plant where every
rate is a slider.

**Controls:** click a pump to switch it. Tab reaches every pump and Space
toggles. In Sandbox, shift-click selects without toggling and the scroll wheel
adjusts a rate in place.

## Tests

```sh
npm test              # simulation, solver, and every shipped level
npm run test:browser  # end-to-end in Chromium (needs: npm install --no-save playwright)
```

The first three suites have **no dependencies** — they run under plain `node`
against the same files the browser loads.

| Suite | Covers |
|---|---|
| `tests/engine.test.js` | Conservation of mass, overflow and dry-run detection, the starvation grace timer, proportional sharing when several pumps drain one vat, determinism |
| `tests/solver.test.js` | That solutions are sound, that par is tight, and that unsolvable levels are correctly reported as such |
| `tests/levels.test.js` | Solves every shipped level from scratch and replays it through the engine |
| `tests/browser.test.mjs` | Renders, plays a level to a win through the DOM, checks the failure paths, and asserts no script errors |

### Why the solver exists

`games/water-works/solver.js` is the reason a broken level can't ship. It finds
a winning sequence of toggles for any fixed-rate level, and `levels.test.js`
runs it against every level in the game — so an unwinnable level, or one whose
declared par is wrong, fails the build. The daily generator calls the same
solver before handing a puzzle to a player, so an unsolvable daily is
impossible by construction.

It looks for two kinds of solution. Most levels are won by a **balanced set** of
pumps where no vat is asked for more than it receives; that search enumerates
sets directly, walking vats in topological order. The rest are won by a
**burst** — filling a vat then draining it faster than it refills — which an
event-driven A* search covers.

Both searches work in exact arithmetic while the game runs at 60Hz, so every
candidate schedule is replayed through the real engine before being accepted.
That makes the solver *sound but not complete*: it never claims a level is
winnable when it isn't, and a level it can't crack simply never ships.

## Adding a game

1. Create `games/<name>/` with its own `index.html`, `style.css` and scripts.
2. Keep it dependency-free and use classic `<script>` tags — ES modules break
   when a page is opened over `file://`.
3. Add a card for it to the root `index.html`.
4. If it has simulation logic worth testing, keep that logic DOM-free and wrap
   it as `(function (root) { ... })(typeof window !== 'undefined' ? window : globalThis)`
   so a Node test can `require()` it. See `games/water-works/engine.js`.

### Adding a Water Works level

Levels are pure data in [`games/water-works/levels.js`](games/water-works/levels.js) —
grid positions, capacities and flow rates. Geometry is derived, so nothing
hard-codes a coordinate. Add a spec, run `node tests/levels.test.js`, and it
will tell you the par to declare (or that the level can't be won).
