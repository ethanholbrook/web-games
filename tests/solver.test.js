/*
 * Tests for the Water Works puzzle solver.
 *
 *   node tests/solver.test.js
 *
 * The property that matters most is SOUNDNESS: any schedule the solver returns
 * must actually win when replayed through the real 60Hz engine. Several tests
 * check that directly rather than trusting the solver's own report.
 */
'use strict';

require('../games/water-works/engine.js');
require('../games/water-works/solver.js');

var WaterWorks = globalThis.WaterWorks;

var CONFIG = {
  rateStep: 0.5, defaultPumpRate: 5, dryGrace: 2.0, starveVisualDelay: 0.15,
  warnFraction: 0.85, simHz: 60, maxPumpRate: 12, maxInletRate: 12
};

var passed = 0;
var failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok   ' + name);
  } catch (err) {
    failures.push(name);
    console.log('  FAIL ' + name + '\n         ' + err.message);
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message || 'assertion failed');
}

/** Compact level builder: vats "V1:40", inlets "V1@6", pumps "P1:V1>V4@5". */
function makeLevel(spec) {
  var vats = spec.vats.map(function (s) {
    var bits = s.split(':');
    return { id: bits[0], label: bits[0], capacity: parseFloat(bits[1]) };
  });
  vats.push({
    id: 'R', label: 'Reservoir', capacity: spec.reservoir, reservoir: true
  });

  var inlets = spec.inlets.map(function (s, i) {
    var bits = s.split('@');
    return { id: 'IN' + (i + 1), name: 'Inlet ' + (i + 1), target: bits[0], rate: parseFloat(bits[1]) };
  });

  var pumps = spec.pumps.map(function (s) {
    var m = /^(\w+):(\w+)>(\w+)@([\d.]+)$/.exec(s);
    if (!m) throw new Error('bad pump spec ' + s);
    return { id: m[1], src: m[2], dst: m[3], rate: parseFloat(m[4]), description: m[2] + ' → ' + m[3] };
  });

  return {
    id: spec.id || 'test', name: spec.name || 'Test', mode: 'puzzle', config: CONFIG,
    vats: vats, inlets: inlets, pumps: pumps, timeLimit: spec.timeLimit
  };
}

console.log('\nWater Works solver\n');

// --------------------------------------------------------------- soundness

test('solves a one-pump level', function () {
  var level = makeLevel({
    vats: ['V1:40'], reservoir: 60, inlets: ['V1@6'], pumps: ['P1:V1>R@6']
  });
  var result = WaterWorks.solve(level);
  assert(result.solved, 'expected a solution');
  assert(result.par === 1, 'expected par 1, got ' + result.par);
});

test('every returned schedule wins when replayed through the engine', function () {
  var levels = [
    makeLevel({ vats: ['V1:40'], reservoir: 60, inlets: ['V1@6'], pumps: ['P1:V1>R@6'] }),
    makeLevel({
      vats: ['V1:40', 'V2:40', 'V3:40'], reservoir: 120, inlets: ['V1@6'],
      pumps: ['P1:V1>V2@4', 'P2:V1>V3@2', 'P3:V2>R@4', 'P4:V3>R@2']
    }),
    makeLevel({
      vats: ['V1:50', 'V2:50', 'V3:50', 'V4:50'], reservoir: 150, inlets: ['V1@8', 'V2@4'],
      pumps: ['P1:V1>V3@5', 'P2:V1>V2@3', 'P3:V2>V4@7', 'P4:V3>R@5', 'P5:V4>R@7']
    })
  ];

  levels.forEach(function (level, i) {
    var result = WaterWorks.solve(level);
    assert(result.solved, 'level ' + i + ' unsolved');
    var replay = WaterWorks.verifySchedule(level, result.moves);
    assert(replay.won, 'level ' + i + ' schedule did not win on replay: '
      + (replay.failure ? replay.failure.kind + ' ' + replay.failure.targetId : 'timeout'));
    assert(replay.moves === result.moves.length, 'level ' + i + ' replay used ' + replay.moves
      + ' toggles but the returned schedule has ' + result.moves.length);
  });
});

test('a schedule with its last toggle removed no longer wins', function () {
  // Guards against the solver padding solutions with toggles that do nothing.
  var level = makeLevel({
    vats: ['V1:40', 'V2:40'], reservoir: 90, inlets: ['V1@6'],
    pumps: ['P1:V1>V2@6', 'P2:V2>R@6']
  });
  var result = WaterWorks.solve(level);
  assert(result.solved, 'expected a solution');
  assert(result.par === 2, 'expected par 2, got ' + result.par);

  var trimmed = result.moves.slice(0, result.moves.length - 1);
  var replay = WaterWorks.verifySchedule(level, trimmed, { maxTime: 60 });
  assert(!replay.won, 'level still won with a toggle removed - par is not tight');
});

// -------------------------------------------------------------- strategies

test('uses a balanced set when one exists', function () {
  // The reservoir is big enough that the run outlasts any unbalanced vat, so
  // leaving a pump off is not an option - every route has to balance.
  var level = makeLevel({
    vats: ['V1:40', 'V2:40', 'V3:40'], reservoir: 600, inlets: ['V1@6'],
    pumps: ['P1:V1>V2@4', 'P2:V1>V3@2', 'P3:V2>R@4', 'P4:V3>R@2']
  });
  var result = WaterWorks.solve(level);
  assert(result.solved, 'expected a solution');
  assert(result.strategy === 'balanced', 'expected balanced, got ' + result.strategy);
  assert(result.par === 4, 'expected par 4, got ' + result.par);
  assert(result.minHeadroom > 5, 'a balanced set should not run vats near overflow, got '
    + result.minHeadroom);
});

test('skips a pump it can win without', function () {
  // Same plumbing, small reservoir: the run ends before the unfed vat fills, so
  // the last pump is never needed. Confirms par is not just "the balanced set".
  var level = makeLevel({
    vats: ['V1:40', 'V2:40', 'V3:40'], reservoir: 120, inlets: ['V1@6'],
    pumps: ['P1:V1>V2@4', 'P2:V1>V3@2', 'P3:V2>R@4', 'P4:V3>R@2']
  });
  var result = WaterWorks.solve(level);
  assert(result.solved, 'expected a solution');
  assert(result.par === 3, 'expected par 3, got ' + result.par);
  var replay = WaterWorks.verifySchedule(level, result.moves);
  assert(replay.won, 'three-toggle schedule did not replay');
});

test('wins by draining a buffer when no balanced set exists', function () {
  // The only pump to the reservoir moves 10 gal/s but the inlet supplies 2, so
  // nothing balances. The win has to come from letting the vat fill first.
  var level = makeLevel({
    vats: ['V1:40'], reservoir: 30, inlets: ['V1@2'], pumps: ['P1:V1>R@10']
  });
  var result = WaterWorks.solve(level);
  assert(result.solved, 'expected a solution');
  assert(result.strategy !== 'balanced',
    'no balanced set exists here, so the strategy should not be balanced');

  var replay = WaterWorks.verifySchedule(level, result.moves);
  assert(replay.won, 'schedule did not replay');
  assert(replay.moves === 1, 'expected a single toggle, got ' + replay.moves);
});

test('the event search can undercut the toggle count', function () {
  // Balanced play needs all four pumps; the run is short enough to win with
  // three, which only the event search finds.
  var level = makeLevel({
    vats: ['V1:40', 'V2:40', 'V3:40'], reservoir: 120, inlets: ['V1@6'],
    pumps: ['P1:V1>V2@4', 'P2:V1>V3@2', 'P3:V2>R@4', 'P4:V3>R@2']
  });
  var result = WaterWorks.solve(level);
  assert(result.solved, 'expected a solution');
  assert(result.par === 3, 'expected 3 toggles at fewest, got ' + result.par);
  assert(result.strategies.some(function (s) {
    return s.strategy === 'burst' && s.toggles === 3;
  }), 'expected the event search to find the three-toggle line');
});

test('the headline solution is the quickest one found', function () {
  // Time is the score, so whichever strategy finishes soonest is the one
  // reported - even when another uses fewer toggles.
  var level = makeLevel({
    vats: ['V1:40', 'V2:40', 'V3:40'], reservoir: 120, inlets: ['V1@6'],
    pumps: ['P1:V1>V2@4', 'P2:V1>V3@2', 'P3:V2>R@4', 'P4:V3>R@2']
  });
  var result = WaterWorks.solve(level);
  assert(result.solved, 'expected a solution');

  var quickest = result.strategies.reduce(function (best, s) {
    return s.time < best.time ? s : best;
  });
  assert(Math.abs(result.targetTime - quickest.time) < 1e-6,
    'targetTime ' + result.targetTime + ' is not the quickest of '
    + JSON.stringify(result.strategies));
  assert(result.par <= quickest.toggles,
    'par should be the fewest toggles across all strategies');
});

test('cycling is found when nothing can be left running', function () {
  // The drain wants three times the inlet and the reservoir needs several
  // tankfuls, so the pump has to be run, rested and run again.
  var level = makeLevel({
    vats: ['V1:40'], reservoir: 150, inlets: ['V1@3'], pumps: ['P1:V1>R@9']
  });
  var result = WaterWorks.solve(level);
  assert(result.solved, 'expected a solution');
  assert(!result.strategies.some(function (s) {
    return s.strategy === 'balanced' || s.strategy === 'buffered';
  }), 'this level should have no static answer');
  assert(result.strategies.some(function (s) { return s.strategy === 'cyclic'; }),
    'expected the cyclic controller to solve it');
  assert(result.par >= 3, 'a repeated cycle needs at least three toggles, got ' + result.par);

  var replay = WaterWorks.verifySchedule(level, result.moves);
  assert(replay.won, 'cycling schedule did not replay');
});

test('par is the smaller of the two strategies', function () {
  // A balanced set exists but wastes toggles; a shorter burst undercuts it.
  var level = makeLevel({
    vats: ['V1:40', 'V2:40'], reservoir: 100, inlets: ['V1@6'],
    pumps: ['P1:V1>V2@4', 'P2:V1>R@4', 'P3:V2>R@4']
  });
  var result = WaterWorks.solve(level);
  assert(result.solved, 'expected a solution');

  // Whatever it picked, nothing smaller may exist that also wins.
  var replay = WaterWorks.verifySchedule(level, result.moves);
  assert(replay.won, 'reported schedule did not replay');
  assert(result.par <= 2, 'expected par of at most 2, got ' + result.par);
});

// ----------------------------------------------------------- unsolvable

test('reports unsolvable when nothing reaches the reservoir', function () {
  var level = makeLevel({
    vats: ['V1:40', 'V2:40'], reservoir: 60, inlets: ['V1@6'], pumps: ['P1:V1>V2@6']
  });
  var result = WaterWorks.solve(level);
  assert(!result.solved, 'expected no solution');
  assert(Array.isArray(result.attempts), 'expected attempt diagnostics');
});

test('reports unsolvable when the time limit cannot be met', function () {
  var level = makeLevel({
    vats: ['V1:40'], reservoir: 300, inlets: ['V1@2'], pumps: ['P1:V1>R@2'], timeLimit: 20
  });
  var result = WaterWorks.solve(level);
  assert(!result.solved, 'expected the time limit to make this unsolvable');
});

test('reports unsolvable when every route overflows first', function () {
  // The inlet outruns the only drain, so V1 always overflows before the
  // reservoir fills.
  var level = makeLevel({
    vats: ['V1:20'], reservoir: 500, inlets: ['V1@12'], pumps: ['P1:V1>R@1']
  });
  var result = WaterWorks.solve(level);
  assert(!result.solved, 'expected no solution');
});

// ------------------------------------------------------------- diagnostics

test('rejects plumbing that contains a cycle', function () {
  var level = makeLevel({
    vats: ['V1:40', 'V2:40'], reservoir: 60, inlets: ['V1@6'],
    pumps: ['P1:V1>V2@4', 'P2:V2>V1@4', 'P3:V2>R@2']
  });
  var threw = false;
  try { WaterWorks.solve(level); } catch (err) {
    threw = /cycle/i.test(err.message);
  }
  assert(threw, 'expected a cycle to be rejected');
});

test('reports slack so knife-edge levels can be filtered out', function () {
  var level = makeLevel({
    vats: ['V1:40', 'V2:40', 'V3:40'], reservoir: 120, inlets: ['V1@6'],
    pumps: ['P1:V1>V2@4', 'P2:V1>V3@2', 'P3:V2>R@4', 'P4:V3>R@2']
  });
  var result = WaterWorks.solve(level);
  assert(result.solved, 'expected a solution');
  assert(typeof result.minHeadroom === 'number', 'minHeadroom should be reported');
  assert(typeof result.minReserve === 'number', 'minReserve should be reported');
  assert(result.minReserve >= 0, 'minReserve should never be negative');
});

test('solving is deterministic', function () {
  var level = makeLevel({
    vats: ['V1:50', 'V2:50', 'V3:50', 'V4:50'], reservoir: 150, inlets: ['V1@8', 'V2@4'],
    pumps: ['P1:V1>V3@5', 'P2:V1>V2@3', 'P3:V2>V4@7', 'P4:V3>R@5', 'P5:V4>R@7']
  });
  var a = JSON.stringify(WaterWorks.solve(level).moves);
  var b = JSON.stringify(WaterWorks.solve(level).moves);
  assert(a === b, 'two solves produced different schedules');
});

test('a full 3x3 grid solves quickly enough to validate at build time', function () {
  var level = makeLevel({
    vats: ['V1:40', 'V2:40', 'V3:40', 'V4:40', 'V5:40', 'V6:40', 'V7:40', 'V8:40', 'V9:40'],
    reservoir: 240, inlets: ['V1@8', 'V3@4'],
    pumps: [
      'P1:V1>V4@5', 'P10:V1>V2@3', 'P2:V2>V5@3', 'P3:V3>V6@4',
      'P4:V4>V7@5', 'P5:V5>V8@3', 'P6:V6>V9@4',
      'P7:V7>R@5', 'P8:V8>R@3', 'P9:V9>R@4'
    ]
  });
  var t0 = Date.now();
  var result = WaterWorks.solve(level);
  var ms = Date.now() - t0;
  assert(result.solved, 'expected a solution');
  assert(result.par === 10, 'expected par 10, got ' + result.par);
  assert(ms < 8000, 'took ' + ms + 'ms, too slow for build-time validation');
});

console.log('\n' + passed + ' passed, ' + failures.length + ' failed\n');
process.exit(failures.length ? 1 : 0);
