/*
 * Validates every shipped level.
 *
 *   node tests/levels.test.js
 *
 * This is the gate that stops an unwinnable level reaching a player. Each
 * puzzle level is solved from scratch and the solution replayed through the
 * real engine; a level that cannot be won, or that only wins by a hair, fails
 * the build.
 */
'use strict';

require('../games/water-works/geometry.js');
require('../games/water-works/levels.js');
require('../games/water-works/engine.js');
require('../games/water-works/solver.js');

var WaterWorks = globalThis.WaterWorks;

// A solution that squeaks past an overflow by a fraction of a gallon is
// technically valid and miserable to play, so levels have to leave real slack.
var MIN_HEADROOM = 3;

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

console.log('\nWater Works levels\n');

// ------------------------------------------------------------- structural

test('every spec builds without error and has a unique id', function () {
  var seen = {};
  WaterWorks.ALL_SPECS.forEach(function (spec) {
    assert(!seen[spec.id], 'duplicate level id ' + spec.id);
    seen[spec.id] = true;
    var level = WaterWorks.buildLevel(spec);
    assert(level.vats.length === spec.vats.length + 1, spec.id + ' lost a vat in the build');
    assert(level.pumps.length === spec.pumps.length, spec.id + ' lost a pump in the build');
    assert(level.view.width > 0 && level.view.height > 0, spec.id + ' has no viewBox');
  });
});

test('every vat sits inside the viewBox', function () {
  WaterWorks.ALL_SPECS.forEach(function (spec) {
    var level = WaterWorks.buildLevel(spec);
    level.vats.forEach(function (v) {
      assert(v.x >= 0 && v.x + v.w <= level.view.width,
        spec.id + ': ' + v.id + ' overhangs horizontally');
      assert(v.y >= 0 && v.y + v.h <= level.view.height,
        spec.id + ': ' + v.id + ' overhangs vertically');
    });
  });
});

test('pump buttons never overlap', function () {
  WaterWorks.ALL_SPECS.forEach(function (spec) {
    var level = WaterWorks.buildLevel(spec);
    var b = level.button;
    for (var i = 0; i < level.pumps.length; i++) {
      for (var j = i + 1; j < level.pumps.length; j++) {
        var a = level.pumps[i];
        var c = level.pumps[j];
        assert(!(Math.abs(a.buttonX - c.buttonX) < b.w && Math.abs(a.buttonY - c.buttonY) < b.h),
          spec.id + ': ' + a.id + ' and ' + c.id + ' overlap');
      }
    }
  });
});

test('puzzle levels give every pipe an explicit rate', function () {
  WaterWorks.CAMPAIGN_SPECS.forEach(function (spec) {
    spec.pumps.forEach(function (p) {
      assert(typeof p.rate === 'number' && p.rate > 0,
        spec.id + ': ' + p.id + ' has no usable rate');
    });
    spec.inlets.forEach(function (inl, i) {
      assert(typeof inl.rate === 'number' && inl.rate > 0,
        spec.id + ': inlet ' + i + ' has no usable rate');
    });
  });
});

test('every vat can be reached and can reach the reservoir', function () {
  WaterWorks.CAMPAIGN_SPECS.forEach(function (spec) {
    var level = WaterWorks.buildLevel(spec);
    var downstream = {};
    var upstream = {};
    level.pumps.forEach(function (p) {
      (downstream[p.src] = downstream[p.src] || []).push(p.dst);
      (upstream[p.dst] = upstream[p.dst] || []).push(p.src);
    });

    function reaches(from, edges, target) {
      var stack = [from];
      var seen = {};
      while (stack.length) {
        var at = stack.pop();
        if (at === target) return true;
        if (seen[at]) continue;
        seen[at] = true;
        (edges[at] || []).forEach(function (next) { stack.push(next); });
      }
      return false;
    }

    var fed = {};
    level.inlets.forEach(function (inl) { fed[inl.target] = true; });

    level.vats.forEach(function (v) {
      if (v.reservoir) return;
      assert(reaches(v.id, downstream, level.reservoirId),
        spec.id + ': ' + v.id + ' has no route to the reservoir');
      var reachable = fed[v.id] || Object.keys(fed).some(function (f) {
        return reaches(f, downstream, v.id);
      });
      assert(reachable, spec.id + ': ' + v.id + ' can never receive water');
    });
  });
});

// --------------------------------------------------------------- solvable

WaterWorks.CAMPAIGN_SPECS.forEach(function (spec) {
  test('level ' + spec.id + ' (' + spec.name + ') is winnable', function () {
    var level = WaterWorks.buildLevel(spec);
    var result = WaterWorks.solve(level);

    assert(result.solved, 'no solution found: '
      + (result.attempts || []).map(function (a) { return a.reason; }).join('; '));

    var replay = WaterWorks.verifySchedule(level, result.moves);
    assert(replay.won, 'solution did not replay: '
      + (replay.failure ? replay.failure.kind + ' at ' + replay.failure.targetId : 'timeout'));

    assert(result.minHeadroom >= MIN_HEADROOM,
      'only ' + result.minHeadroom.toFixed(2) + ' gal of headroom - too tight to be fair');

    // par is shipped as data so the game never has to run the solver; this is
    // what keeps that number honest.
    assert(spec.par === result.par,
      'declares par ' + spec.par + ' but the solver finds ' + result.par);

    if (spec.timeLimit) {
      assert(replay.elapsed < spec.timeLimit,
        'wins at ' + replay.elapsed.toFixed(1) + 's but the limit is ' + spec.timeLimit + 's');
    }

    console.log('       par ' + result.par + ' (' + result.strategy + '), '
      + result.verifiedTime.toFixed(1) + 's, headroom ' + result.minHeadroom.toFixed(1) + ' gal');
  });
});

test('the campaign gets harder', function () {
  var pars = WaterWorks.CAMPAIGN_SPECS.map(function (spec) {
    return WaterWorks.solve(WaterWorks.buildLevel(spec)).par;
  });
  var first = pars.slice(0, 4);
  assert(first[0] <= first[first.length - 1],
    'the opening levels should not start at their hardest: ' + first.join(','));
  assert(Math.max.apply(null, pars.slice(5)) >= Math.max.apply(null, pars.slice(0, 3)),
    'later levels should demand at least as much as the opening ones');
});

test('every level declares a time limit it can actually meet', function () {
  WaterWorks.CAMPAIGN_SPECS.forEach(function (spec) {
    if (!spec.timeLimit) return;
    var level = WaterWorks.buildLevel(spec);
    var result = WaterWorks.solve(level);
    assert(result.solved && result.verifiedTime < spec.timeLimit * 0.95,
      spec.id + ': the only known solution finishes at ' + result.verifiedTime.toFixed(1)
      + 's against a ' + spec.timeLimit + 's limit - no room for a player to be imperfect');
  });
});

console.log('\n' + passed + ' passed, ' + failures.length + ' failed\n');
process.exit(failures.length ? 1 : 0);
