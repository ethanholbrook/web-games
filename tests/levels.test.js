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

// The opening levels exist to teach the mechanics, so they are allowed to have
// a static answer. Everything after them must require active switching.
var TUTORIAL_LEVELS = 3;

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

test('switches stay tappable on a phone', function () {
  // The diagram is scaled to fit, so a switch's share of the viewBox is what
  // decides its size in pixels. Measured against a 390px-wide phone, minus the
  // page padding, and the viewport height the stage is allowed to use.
  var STAGE_W = 370;
  var STAGE_H = 654;
  var MIN_W = 40;
  var MIN_H = 28;

  WaterWorks.ALL_SPECS.forEach(function (spec) {
    var level = WaterWorks.buildLevel(spec);
    var scale = Math.min(STAGE_W / level.view.width, STAGE_H / level.view.height);
    var w = level.button.w * scale;
    var h = level.button.h * scale;
    assert(w >= MIN_W && h >= MIN_H, spec.id + ': switches would render '
      + w.toFixed(0) + 'x' + h.toFixed(0) + 'px on a phone, under the '
      + MIN_W + 'x' + MIN_H + ' minimum');
  });
});

test('the diagram fits a phone without sideways scrolling', function () {
  // Anything wider than about 3:2 would be squeezed flat once fitted to a
  // portrait screen, which is what forced horizontal scrolling before.
  WaterWorks.ALL_SPECS.forEach(function (spec) {
    var level = WaterWorks.buildLevel(spec);
    var aspect = level.view.width / level.view.height;
    assert(aspect <= 1.5, spec.id + ' is ' + aspect.toFixed(2)
      + ':1 - too wide to fit a portrait phone');
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

    // The quickest route deliberately runs vats to the brim, so fairness is
    // judged on whether a comfortable way to win exists at all.
    assert(result.safeHeadroom >= MIN_HEADROOM,
      'the roomiest solution leaves only ' + result.safeHeadroom.toFixed(2)
      + ' gal of headroom - too tight to be fair');

    // targetTime is shipped as data so the game never has to run the solver;
    // this is what keeps that number honest.
    assert(Math.abs(spec.targetTime - result.targetTime) <= Math.max(1, result.targetTime * 0.05),
      'declares a target of ' + spec.targetTime + 's but the best the solver can do is '
      + result.targetTime.toFixed(1) + 's');

    if (spec.timeLimit) {
      assert(replay.elapsed < spec.timeLimit,
        'wins at ' + replay.elapsed.toFixed(1) + 's but the limit is ' + spec.timeLimit + 's');
    }

    console.log('       target ' + result.targetTime.toFixed(1) + 's via ' + result.strategy
      + ', ' + result.par + ' switches minimum, headroom ' + result.safeHeadroom.toFixed(1) + ' gal');
  });
});

test('past the tutorial, no level can be won by a static set of pumps', function () {
  // This is the whole point of the design: leaving a set of switches on and
  // walking away must not work. A 'balanced' or 'buffered' solution means some
  // fixed set of pumps runs to the end untouched, which makes the level a
  // one-shot setup rather than something to manage.
  WaterWorks.CAMPAIGN_SPECS.forEach(function (spec, i) {
    if (i < TUTORIAL_LEVELS) return;
    var result = WaterWorks.solve(WaterWorks.buildLevel(spec));
    assert(result.solved, spec.id + ' is not solvable at all');
    var staticWin = result.strategies.filter(function (s) {
      return s.strategy === 'balanced' || s.strategy === 'buffered';
    });
    assert(!staticWin.length, spec.id + ' (' + spec.name + ') can be won by switching '
      + (staticWin.length ? staticWin[0].toggles : '?')
      + ' pumps on and leaving them - it needs no dynamic control');
  });
});

test('the tutorial levels are the gentle ones', function () {
  var specs = WaterWorks.CAMPAIGN_SPECS;
  for (var i = 0; i < TUTORIAL_LEVELS; i++) {
    assert(specs[i].pumps.length <= 3,
      specs[i].id + ' is meant to be a tutorial but has ' + specs[i].pumps.length + ' pumps');
  }
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
