/*
 * Zero-dependency tests for the Water Works simulation.
 *
 *   node tests/engine.test.js
 *
 * level1.js and engine.js are classic scripts that attach to `globalThis`
 * under Node, so requiring them for their side effects is all that is needed.
 */
'use strict';

require('../games/water-works/level1.js');
require('../games/water-works/engine.js');

var WaterWorks = globalThis.WaterWorks;
var LEVEL = WaterWorks.LEVEL1;
var DT = 1 / LEVEL.config.simHz;

var passed = 0;
var failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok   ' + name);
  } catch (err) {
    failures.push({ name: name, err: err });
    console.log('  FAIL ' + name + '\n         ' + err.message);
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message || 'assertion failed');
}

function assertClose(actual, expected, tol, message) {
  if (Math.abs(actual - expected) > tol) {
    throw new Error((message || 'value') + ': expected ' + expected + ' +/- ' + tol + ', got ' + actual);
  }
}

function newGame() {
  return WaterWorks.createGame(LEVEL);
}

/** Run for `seconds`, invoking onTick(game) after each step. Stops when over. */
function run(game, seconds, onTick) {
  var steps = Math.round(seconds / DT);
  for (var i = 0; i < steps; i++) {
    game.step(DT);
    if (onTick) onTick(game);
    if (game.isOver()) return;
  }
}

function totalWater(game) {
  var sum = 0;
  for (var i = 0; i < game.vatOrder.length; i++) sum += game.vats[game.vatOrder[i]].level;
  return sum;
}

/** The documented reference solution: stagger three vertical chains at 10 gal/s. */
function playReferenceSolution(game, onTick) {
  var stages = [
    { at: 5, pumps: ['P1', 'P2', 'P3'] },
    { at: 10, pumps: ['P4', 'P5', 'P6'] },
    { at: 15, pumps: ['P7', 'P8', 'P9'] }
  ];
  var next = 0;

  game.setInletRate(0, 10);
  game.setInletRate(1, 10);
  game.setInletRate(2, 10);
  game.start();

  for (var i = 0; i < 200 / DT; i++) {
    while (next < stages.length && game.elapsed >= stages[next].at) {
      stages[next].pumps.forEach(function (id) {
        game.setPumpRate(id, 10);
        game.togglePump(id);
      });
      next++;
    }
    game.step(DT);
    if (onTick) onTick(game);
    if (game.isOver()) return;
  }
}

console.log('\nWater Works engine\n');

// ---------------------------------------------------------------- topology
test('topology: 23 pumps, unique ids, endpoints resolve', function () {
  assert(LEVEL.pumps.length === 23, 'expected 23 pumps, got ' + LEVEL.pumps.length);
  var seen = {};
  LEVEL.pumps.forEach(function (p) {
    assert(!seen[p.id], 'duplicate pump id ' + p.id);
    seen[p.id] = true;
    assert(LEVEL.vatById[p.src], p.id + ' has unknown source ' + p.src);
    assert(LEVEL.vatById[p.dst], p.id + ' has unknown destination ' + p.dst);
    assert(p.src !== p.dst, p.id + ' pumps into itself');
  });
  for (var n = 1; n <= 23; n++) assert(seen['P' + n], 'missing pump P' + n);
  assert(LEVEL.vats.length === 10, 'expected 10 vats');
  assert(LEVEL.inlets.length === 3, 'expected 3 inlets');
});

test('topology: plumbing is acyclic', function () {
  var indegree = {};
  var edges = {};
  LEVEL.vats.forEach(function (v) { indegree[v.id] = 0; edges[v.id] = []; });
  LEVEL.pumps.forEach(function (p) {
    edges[p.src].push(p.dst);
    indegree[p.dst]++;
  });

  var queue = Object.keys(indegree).filter(function (id) { return indegree[id] === 0; });
  var visited = 0;
  while (queue.length) {
    var id = queue.shift();
    visited++;
    edges[id].forEach(function (next) {
      if (--indegree[next] === 0) queue.push(next);
    });
  }
  assert(visited === LEVEL.vats.length, 'cycle detected: only sorted ' + visited + ' of ' + LEVEL.vats.length);
});

test('topology: pump buttons do not overlap', function () {
  var b = LEVEL.button;
  for (var i = 0; i < LEVEL.pumps.length; i++) {
    for (var j = i + 1; j < LEVEL.pumps.length; j++) {
      var a = LEVEL.pumps[i];
      var c = LEVEL.pumps[j];
      var overlaps = Math.abs(a.buttonX - c.buttonX) < b.w && Math.abs(a.buttonY - c.buttonY) < b.h;
      assert(!overlaps, a.id + ' and ' + c.id + ' overlap at ' +
        '(' + a.buttonX + ',' + a.buttonY + ') / (' + c.buttonX + ',' + c.buttonY + ')');
    }
  }
});

// -------------------------------------------------------------- simulation
test('idle games do not advance', function () {
  var game = newGame();
  game.setInletRate(0, 10);
  run(game, 5);
  assert(game.elapsed === 0, 'elapsed advanced while IDLE');
  assert(game.vats.V1.level === 0, 'V1 filled while IDLE');
});

test('conservation of mass across a full run', function () {
  var game = newGame();
  var worst = 0;
  playReferenceSolution(game, function (g) {
    if (g.status !== 'RUNNING') return; // the winning tick clamps vat 10
    var expected = g.totalInflow() * g.elapsed;
    worst = Math.max(worst, Math.abs(totalWater(g) - expected));
  });
  assert(worst < 1e-6, 'water created or destroyed: worst error ' + worst);
});

test('reference solution wins in about 48s', function () {
  var game = newGame();
  playReferenceSolution(game);
  assert(game.status === 'WON', 'expected WON, got ' + game.status +
    (game.failure ? ' (' + game.failure.kind + ' at ' + game.failure.targetId + ')' : ''));
  assertClose(game.elapsed, 48.33, 0.5, 'completion time');
  ['V1', 'V4', 'V7'].forEach(function (id) {
    assertClose(game.vats[id].level, 50, 1, id + ' should hold steady near 50');
  });
});

test('overflow is detected at the arithmetically right moment', function () {
  var game = newGame();
  game.setInletRate(0, 12);
  game.start();
  run(game, 30);
  assert(game.status === 'LOST', 'expected LOST, got ' + game.status);
  assert(game.failure.kind === 'OVERFLOW', 'expected OVERFLOW, got ' + game.failure.kind);
  assert(game.failure.targetId === 'V1', 'expected V1 to overflow, got ' + game.failure.targetId);
  assertClose(game.elapsed, 100 / 12, 0.05, 'overflow time');
});

test('a full vat passing water straight through does not overflow', function () {
  var game = newGame();
  game.vats.V1.level = 99;
  game.setInletRate(0, 10);
  game.setPumpRate('P1', 10);
  game.togglePump('P1');
  game.start();
  run(game, 5);
  assert(game.status === 'RUNNING', 'expected RUNNING, got ' + game.status +
    (game.failure ? ' (' + game.failure.kind + ')' : ''));
  assertClose(game.vats.V1.level, 99, 0.2, 'V1 level');
});

test('starving pump gets the grace period, then fails', function () {
  var game = newGame();
  game.setPumpRate('P1', 10);
  game.togglePump('P1');
  game.start();

  run(game, 1.9);
  assert(game.status === 'RUNNING', 'failed before the grace period elapsed');
  assert(game.pumps.P1.starving === true, 'P1 should be flagged starving');

  run(game, 0.3);
  assert(game.status === 'LOST', 'expected LOST, got ' + game.status);
  assert(game.failure.kind === 'DRY_RUN', 'expected DRY_RUN, got ' + game.failure.kind);
  assert(game.failure.targetId === 'P1', 'expected P1, got ' + game.failure.targetId);
  assertClose(game.elapsed, 2.0, 0.05, 'dry-run time');
});

test('feeding a starving pump in time resets its timer', function () {
  var game = newGame();
  game.setPumpRate('P1', 10);
  game.togglePump('P1');
  game.start();

  run(game, 1.5);
  assert(game.pumps.P1.starveTimer > 1.4, 'timer should have accumulated');

  game.setInletRate(0, 12);
  run(game, 3);
  assert(game.status === 'RUNNING', 'expected RUNNING, got ' + game.status);
  assert(game.pumps.P1.starving === false, 'P1 should have recovered');
  assert(game.pumps.P1.starveTimer === 0, 'starve timer should have reset');
});

test('a vat short of water scales all its pumps equally', function () {
  var game = newGame();
  ['P1', 'P10', 'P11'].forEach(function (id) {
    game.setPumpRate(id, 10);
    game.togglePump(id);
  });
  game.start();
  game.vats.V1.level = (30 * DT) / 2; // exactly half of what the three demand
  game.step(DT);

  ['P1', 'P10', 'P11'].forEach(function (id) {
    assertClose(game.pumps[id].flow, 5, 1e-9, id + ' flow');
    assert(game.pumps[id].starving === true, id + ' should be starving');
  });
  assertClose(game.vats.V1.level, 0, 1e-9, 'V1 should be drained');
});

test('a pump switched on at rate zero never starves', function () {
  var game = newGame();
  game.setPumpRate('P1', 0);
  game.togglePump('P1');
  game.start();
  run(game, 5);
  assert(game.status === 'RUNNING', 'expected RUNNING, got ' + game.status);
  assert(game.pumps.P1.starving === false, 'a pump with no demand cannot starve');
});

test('rates are clamped and snapped to the step', function () {
  var game = newGame();
  game.setPumpRate('P1', 999);
  assert(game.pumps.P1.rate === LEVEL.config.maxPumpRate, 'rate should clamp to max');
  game.setPumpRate('P1', -5);
  assert(game.pumps.P1.rate === 0, 'rate should clamp to zero');
  game.setPumpRate('P1', 3.3);
  assert(game.pumps.P1.rate === 3.5, 'rate should snap to the step, got ' + game.pumps.P1.rate);
  game.setInletRate(0, 99);
  assert(game.inlets[0].rate === LEVEL.config.maxInletRate, 'inlet should clamp to max');
});

test('reset restores a fresh plant', function () {
  var game = newGame();
  game.setInletRate(0, 12);
  game.togglePump('P1');
  game.start();
  run(game, 3);
  game.reset();

  assert(game.status === 'IDLE', 'status should be IDLE');
  assert(game.elapsed === 0, 'elapsed should be zero');
  assert(game.failure === null, 'failure should be cleared');
  assert(game.vats.V1.level === 0, 'V1 should be empty');
  assert(game.pumps.P1.on === false, 'P1 should be off');
  assert(game.pumps.P1.rate === LEVEL.config.defaultPumpRate, 'P1 rate should be the default');
  assert(game.inlets[0].rate === 0, 'inlet should be closed');
});

test('the simulation is deterministic', function () {
  function endState() {
    var game = newGame();
    playReferenceSolution(game);
    return JSON.stringify({ status: game.status, elapsed: game.elapsed, vats: game.vats });
  }
  assert(endState() === endState(), 'identical input produced different end states');
});

// -------------------------------------------------------------------------
console.log('\n' + passed + ' passed, ' + failures.length + ' failed\n');
process.exit(failures.length ? 1 : 0);
