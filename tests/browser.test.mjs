/*
 * End-to-end browser test.
 *
 *   npm install --no-save playwright
 *   node tests/browser.test.mjs
 *
 * The Node suites cover the simulation and the solver; this covers the parts
 * only a real browser can tell us about — that the scene renders, that the
 * screens wire together, that a level can actually be played to a win through
 * the DOM, and that no script throws along the way.
 *
 * Serves the repo itself on a spare port, so it needs no running server.
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = 8177;

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json'
};

const server = createServer(async (req, res) => {
  try {
    const path = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
    const file = join(ROOT, path.endsWith('/') ? path + 'index.html' : path);
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});

await new Promise((resolve) => server.listen(PORT, resolve));

const BASE = `http://localhost:${PORT}/games/water-works/index.html`;
const problems = [];
let passed = 0;

function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log('  ok   ' + name);
  } else {
    problems.push(name);
    console.log('  FAIL ' + name + (detail ? '\n         ' + detail : ''));
  }
}

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

const scriptErrors = [];
page.on('pageerror', (err) => scriptErrors.push(err.message));
page.on('console', (msg) => { if (msg.type() === 'error') scriptErrors.push(msg.text()); });

const pump = (id) => `#scene g.pump[aria-label^="${id},"]`;

console.log('\nWater Works browser\n');

// ------------------------------------------------------------ level select
await page.goto(BASE, { waitUntil: 'networkidle' });

const cardCount = await page.$$eval('.card', (n) => n.length);
check('level select lists every level', cardCount >= 11, `found ${cardCount} cards`);

const dailyTitle = await page.$eval('#daily-grid .card h3', (n) => n.textContent).catch(() => null);
check("today's daily generates", /^Daily #\d+$/.test(dailyTitle || ''), `got ${dailyTitle}`);

// ------------------------------------------------------------- puzzle mode
await page.click('#campaign-grid .card:nth-child(1)');   // First Draw
await page.waitForTimeout(300);

check('opens the chosen level',
  await page.$eval('#level-name', (n) => n.textContent) === 'First Draw');
check('puzzle mode hides the rate sliders',
  await page.$eval('#panel-inlets', (n) => n.hidden) && await page.$eval('#panel-inspector', (n) => n.hidden));
check('puzzle mode prints rates on the pipes',
  await page.$$eval('.rate-badge', (n) => n.length) === 2);
check('the target time is shown',
  /^0:\d\d\.\d$/.test(await page.$eval('#hud-target', (n) => n.textContent)));

const hudVisible = await page.$eval('#hud-outflow-item',
  (n) => n.getBoundingClientRect().height > 0);
check('sandbox-only readouts stay hidden in puzzle mode', !hudVisible);

// --------------------------------------------------------------- play a run
await page.click('#btn-start');
await page.waitForTimeout(500);
await page.click(pump('P1'));
await page.waitForTimeout(400);

check('switches are counted plainly, not against a par',
  /^\d+$/.test(await page.$eval('#hud-moves', (n) => n.textContent)));
check('running pipes animate',
  await page.$$eval('.pipe-flow.is-flowing', (n) => n.length) > 0);

// Pausing must not lock the switches — this is a puzzle, not a reflex test.
await page.click('#btn-start');
await page.waitForTimeout(150);
const before = await page.$eval('#hud-moves', (n) => n.textContent);
await page.click(pump('P1'));
await page.waitForTimeout(150);
const after = await page.$eval('#hud-moves', (n) => n.textContent);
check('switches still work while paused', before !== after, `${before} -> ${after}`);
await page.click(pump('P1'));
await page.click('#btn-start');

await page.waitForSelector('#modal:not([hidden])', { timeout: 60000 });
check('a correct run wins',
  await page.$eval('#modal-title', (n) => n.textContent) === 'Reservoir Full');
check('a medal is awarded on the clock',
  await page.$$eval('.medal-banner', (n) => n.length) === 1);

await page.click('#modal-actions button:first-child');
await page.waitForTimeout(300);
check('the best time is remembered on the level list',
  /^● 0:\d\d\.\d$/.test(await page.$eval('#campaign-grid .card-best', (n) => n.textContent)));

// ------------------------------------------------------- cycling a pump
// Overdraw has no steady state: the pump wants three times what the inlet
// delivers, so the vat has to fill before it can be run at all.
await page.click('#campaign-grid .card:nth-child(3)');
await page.waitForTimeout(300);
check('opens the cycling level',
  await page.$eval('#level-name', (n) => n.textContent) === 'Overdraw');

await page.click('#btn-start');
await page.click(pump('P1'));                            // far too early
await page.waitForTimeout(900);
check('a pump started on an empty vat shows as starving',
  await page.$$eval('#scene g.pump.is-starving', (n) => n.length) === 1);

await page.click(pump('P1'));                            // back off in time
await page.waitForTimeout(300);
check('backing off in time saves the run',
  await page.$eval('#hud-status', (n) => n.textContent) === 'Running');

// ------------------------------------------------------------ failure paths
await page.click('#btn-back');
await page.waitForTimeout(200);
await page.click('#campaign-grid .card:nth-child(2)');   // Downstream
await page.waitForTimeout(300);
await page.click(pump('P2'));                            // drawing from an empty vat
await page.click('#btn-start');
await page.waitForSelector('#modal:not([hidden])', { timeout: 20000 });
const failBody = await page.$eval('#modal-body', (n) => n.textContent);
check('running a pump dry ends the run', /ran dry/.test(failBody), failBody);

// Regression: the frame loop is parked when a run ends, and restarting has to
// wake it up again or Start silently does nothing until a page reload.
await page.click('#modal-actions button:last-child');        // Retry
await page.waitForTimeout(200);
await page.click('#btn-start');
await page.waitForTimeout(700);
const elapsedAfterRetry = await page.$eval('#hud-time', (n) => n.textContent);
check('the clock runs again after retrying a failed run',
  elapsedAfterRetry !== '0:00.0', `clock stuck at ${elapsedAfterRetry}`);

// ------------------------------------------------------------------ sandbox
await page.click('#modal-actions button:first-child');
await page.waitForTimeout(200);
await page.click('#sandbox-grid .card');
await page.waitForTimeout(300);

check('sandbox keeps its sliders',
  await page.$$eval('#inlet-list input[type=range]', (n) => n.length) === 3);
check('sandbox shows the inspector',
  !(await page.$eval('#panel-inspector', (n) => n.hidden)));

// ----------------------------------------------------------------- layout
await page.setViewportSize({ width: 400, height: 900 });
await page.waitForTimeout(300);
const scrollsSideways = await page.evaluate(
  () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
check('no horizontal scrolling on a narrow screen', !scrollsSideways);

check('no script errors anywhere', scriptErrors.length === 0, scriptErrors.join('\n         '));

await browser.close();
server.close();

console.log('\n' + passed + ' passed, ' + problems.length + ' failed\n');
process.exit(problems.length ? 1 : 0);
