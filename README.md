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

**Goal:** fill the reservoir to 100%, as fast as you can. **The clock is the
score** — each level has a target time from the solver, and beating it earns a
medal. The switch count is shown too, but it's a bonus stat, not the goal.

**You lose if:**

- any vat overflows, or
- a pump runs dry — it is on and its source cannot supply the rate it is asking
  for, for more than 2 seconds. A starving pump pulses amber first.

The puzzle is *which* pumps, *in what order*, and *when to shut them off again*.
Every vat starts empty, so a pump switched on too early has nothing to draw; and
a vat taking in more than it sends out will eventually overflow.

**Past the three tutorial levels, no level has a steady state.** Every pipe draws
faster than whatever feeds it, so there is no set of switches you can flip on and
walk away from — a pump left running will empty its vat and trip. Winning means
running each pump, resting it while its vat refills, and running it again, while
nothing upstream backs up and overflows. `tests/levels.test.js` enforces this: a
level that can be won by a fixed set of switches fails the build.

You can pause at any time and keep flipping switches. It's a thinking problem,
not a reflex test.

**Contents:** a ten-level campaign, a daily puzzle that is the same for
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
| `tests/solver.test.js` | That solutions are sound, that the reported time is the quickest found, and that unsolvable levels are correctly reported as such |
| `tests/levels.test.js` | Solves every shipped level from scratch, replays it through the engine, checks the declared target time, enforces that no level past the tutorial has a static answer, and that every switch stays tappable on a phone |
| `tests/browser.test.mjs` | Renders, plays a level to a win through the DOM, checks the failure paths, and asserts no script errors |

### Why the solver exists

`games/water-works/solver.js` is the reason a broken level can't ship. It finds
a winning sequence of toggles for any fixed-rate level, and `levels.test.js`
runs it against every level in the game — so an unwinnable level, or one whose
declared target time is wrong, fails the build. The daily generator calls the same
solver before handing a puzzle to a player, so an unsolvable daily is
impossible by construction.

It looks for three kinds of solution and reports the quickest, which is where a
level's target time comes from:

- a **balanced set** of pumps where no vat is asked for more than it receives —
  found by enumerating sets directly, walking vats in topological order;
- a **burst** — filling a vat, then draining it faster than it refills — found
  by an event-driven A* over the moments when something actually changes;
- a **cycle** — the same thing repeated, found by running every pump under
  two-sided bang-bang control (water behind it, room in front of it) and then
  greedily dropping the pumps that turn out not to be needed.

The campaign levels need the third. The first two still matter for validation:
if either of them solves a level, that level has a static answer and is rejected
as too easy.

All three work in exact arithmetic while the game runs at 60Hz, so every
candidate schedule is replayed through the real engine before being accepted.
That makes the solver *sound but not complete*: it never claims a level is
winnable when it isn't, and a level it can't crack simply never ships.

## Putting it online

The whole site is 10 static files with no build step, so any static host works.

**GitHub Pages** is wired up already: [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml)
publishes `index.html` and `games/` on every push to `main`, but only after the
simulation, solver and level suites pass — so a level that can't be won never
reaches a player. The site lands at `https://<user>.github.io/web-games/`.

It needs one manual step, once: set **Settings → Pages → Source** to
**GitHub Actions**. The workflow cannot do this for you — `pages: write` lets it
deploy to a Pages site but not create one, which needs repo-admin rights the
default `GITHUB_TOKEN` doesn't carry.

Pages needs the repository to be public, or a paid GitHub plan. To host a
private repo for free, use Cloudflare Pages or Netlify instead. Point either at
the repo with:

| Setting | Value |
|---|---|
| Build command | *(leave empty)* |
| Output directory | `.` |

Nothing is served from a fixed path, so the game works from a domain root, a
subdirectory, or straight off the filesystem.

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
hard-codes a coordinate. Add a spec, run `node tests/levels.test.js`, and it will
tell you the `targetTime` to declare — or that the level can't be won, or that it
has a steady state and needs its pipe rates raised until it doesn't.
