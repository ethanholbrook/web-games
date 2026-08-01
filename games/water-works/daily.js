/*
 * Water Works - daily puzzle generator.
 *
 * Everyone gets the same plant on the same day, generated on the device from
 * the date alone - no server, no puzzle list to run out.
 *
 * Random plumbing is almost never solvable, so nothing is generated blind.
 * A daily is built BACKWARDS FROM A SOLUTION: each vat is given a throughput,
 * that throughput is split among pipes running down to the next row, and the
 * bottom row drains into the reservoir. By construction the full set of those
 * pipes balances exactly, so a solution is guaranteed before the solver is
 * ever asked. Decoy pipes are then added on top - they can only ever add
 * options, never remove the solution that is already there.
 *
 * The solver still has the last word: it has to find and verify a win, with
 * real headroom and a par in a sensible range, or the seed is discarded and
 * the next one is tried. An unsolvable daily can therefore never ship.
 */
(function (root) {
  'use strict';

  var EPOCH = Date.UTC(2026, 0, 1);  // puzzle #1
  var MS_PER_DAY = 86400000;

  var LIMITS = {
    minPar: 3,
    maxPar: 8,
    minHeadroom: 4,
    minSeconds: 20,
    maxSeconds: 55,
    attempts: 60
  };

  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  function randInt(rng, lo, hi) { return lo + Math.floor(rng() * (hi - lo + 1)); }
  function pick(rng, list) { return list[Math.floor(rng() * list.length)]; }

  /** Split `total` into 1 or 2 positive whole parts. */
  function partition(rng, total, parts) {
    if (parts < 2 || total < 2) return [total];
    var cut = randInt(rng, 1, total - 1);
    return [cut, total - cut];
  }

  function vatId(col, row) { return 'V' + (row + 1) + (col + 1); }

  /**
   * Build one candidate plant. Throughputs are chosen first and the pipes are
   * derived from them, so the resulting set of "spine" pumps balances at every
   * vat by construction.
   */
  function generateSpec(seed, dayNumber) {
    var rng = mulberry32(seed);

    var cols = randInt(rng, 2, 3);
    var rows = randInt(rng, 2, 3);

    // Throughput per grid position, filled top-down.
    var flow = [];
    var r, c;
    for (r = 0; r < rows; r++) {
      flow.push([]);
      for (c = 0; c < cols; c++) flow[r].push(0);
    }

    // Inlets feed the top row.
    var inletCount = randInt(rng, 1, cols);
    var inletCols = [];
    for (c = 0; c < cols; c++) inletCols.push(c);
    for (var i = inletCols.length - 1; i > 0; i--) {
      var j = randInt(rng, 0, i);
      var tmp = inletCols[i]; inletCols[i] = inletCols[j]; inletCols[j] = tmp;
    }
    inletCols = inletCols.slice(0, inletCount);

    var inlets = inletCols.map(function (col) {
      var rate = randInt(rng, 3, 8);
      flow[0][col] += rate;
      return { target: vatId(col, 0), rate: rate };
    });

    // Push each vat's throughput down to the next row, spreading sideways by at
    // most one column so the pipes stay drawable as verticals and diagonals.
    var pumps = [];
    var pumpNo = 1;
    var edgeSeen = {};

    function addPump(srcCol, srcRow, dstCol, dstRow, rate) {
      var src = vatId(srcCol, srcRow);
      var dst = dstRow === rows ? 'R' : vatId(dstCol, dstRow);
      var edge = src + '>' + dst;
      if (edgeSeen[edge]) return false;
      edgeSeen[edge] = true;
      pumps.push({ id: 'P' + pumpNo++, src: src, dst: dst, rate: rate, spine: true });
      return true;
    }

    for (r = 0; r < rows - 1; r++) {
      for (c = 0; c < cols; c++) {
        var total = flow[r][c];
        if (total <= 0) continue;

        var targets = [];
        for (var d = -1; d <= 1; d++) {
          if (c + d >= 0 && c + d < cols) targets.push(c + d);
        }

        var parts = partition(rng, total, total >= 4 && targets.length > 1 ? randInt(rng, 1, 2) : 1);
        var used = {};
        for (var p = 0; p < parts.length; p++) {
          var choices = targets.filter(function (t) { return !used[t]; });
          if (!choices.length) { parts[0] += parts[p]; continue; }
          var target = pick(rng, choices);
          used[target] = true;
          if (addPump(c, r, target, r + 1, parts[p])) flow[r + 1][target] += parts[p];
        }
      }
    }

    // The bottom row drains into the reservoir.
    var totalToReservoir = 0;
    for (c = 0; c < cols; c++) {
      if (flow[rows - 1][c] <= 0) continue;
      addPump(c, rows - 1, c, rows, flow[rows - 1][c]);
      totalToReservoir += flow[rows - 1][c];
    }
    if (totalToReservoir <= 0) return null;

    // Which grid positions actually carry water. Sparse grids are fine.
    var vats = [];
    var live = {};
    var peak = 0;
    for (r = 0; r < rows; r++) {
      for (c = 0; c < cols; c++) {
        if (flow[r][c] <= 0) continue;
        live[vatId(c, r)] = true;
        peak = Math.max(peak, flow[r][c]);
      }
    }

    var capacity = Math.max(36, Math.ceil(peak * 6 / 5) * 5);
    for (r = 0; r < rows; r++) {
      for (c = 0; c < cols; c++) {
        if (flow[r][c] > 0) vats.push({ id: vatId(c, r), col: c, row: r, capacity: capacity });
      }
    }
    if (vats.length < 3) return null;

    // Decoys: extra pipes that exist only to be wrong. They can add options but
    // can never take away the balanced set built above.
    var decoyTarget = randInt(rng, 1, 3);
    for (var attempt = 0; attempt < 24 && decoyTarget > 0; attempt++) {
      var sr = randInt(rng, 0, rows - 1);
      var sc = randInt(rng, 0, cols - 1);
      if (!live[vatId(sc, sr)]) continue;

      var lateral = rng() < 0.35;
      var dr = lateral ? sr : sr + 1;
      var dc = lateral ? sc + 1 : sc + randInt(rng, -1, 1);
      if (dc < 0 || dc >= cols) continue;

      if (dr === rows) {
        if (!addPump(sc, sr, sc, rows, randInt(rng, 2, 8))) continue;
      } else {
        if (!live[vatId(dc, dr)]) continue;
        if (!addPump(sc, sr, dc, dr, randInt(rng, 2, 8))) continue;
      }
      pumps[pumps.length - 1].spine = false;
      decoyTarget--;
    }

    // Squeeze out grid rows and columns that ended up carrying nothing, so a
    // sparse plant is drawn tight instead of with holes in it.
    var colMap = {};
    var rowMap = {};
    var nextCol = 0;
    var nextRow = 0;
    vats.map(function (v) { return v.col; }).sort(function (a, b) { return a - b; })
      .forEach(function (col) { if (!(col in colMap)) colMap[col] = nextCol++; });
    vats.map(function (v) { return v.row; }).sort(function (a, b) { return a - b; })
      .forEach(function (row) { if (!(row in rowMap)) rowMap[row] = nextRow++; });
    vats.forEach(function (v) { v.col = colMap[v.col]; v.row = rowMap[v.row]; });

    var seconds = randInt(rng, LIMITS.minSeconds, LIMITS.maxSeconds);

    return {
      id: 'daily',
      name: 'Daily #' + dayNumber,
      blurb: 'A fresh plant every day. Everyone gets the same one.',
      mode: 'puzzle',
      daily: true,
      dayNumber: dayNumber,
      cols: nextCol,
      rows: nextRow,
      vats: vats,
      reservoir: { capacity: totalToReservoir * seconds },
      inlets: inlets.filter(function (inl) { return live[inl.target]; }),
      pumps: pumps.map(function (p) {
        return { id: p.id, src: p.src, dst: p.dst, rate: p.rate };
      })
    };
  }

  function dayNumberFor(date) {
    var local = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
    return Math.floor((local - EPOCH) / MS_PER_DAY) + 1;
  }

  /**
   * The daily for a given date. Tries seeds derived from the day number until
   * one produces a level the solver can win with a sensible par, so the result
   * is always both deterministic and verified.
   */
  function dailyFor(date, options) {
    var opts = options || {};
    var day = dayNumberFor(date || new Date());
    var W = root.WaterWorks;
    // Generation runs on the player's device, so it is kept on a short leash:
    // a seed that needs a long search is simply skipped for the next one.
    var overallDeadline = Date.now() + (opts.budgetMs || 4000);

    for (var attempt = 0; attempt < LIMITS.attempts; attempt++) {
      if (Date.now() > overallDeadline) break;
      var spec = generateSpec(day * 7919 + attempt * 104729, day);
      if (!spec) continue;

      var level;
      try { level = W.buildLevel(spec); } catch (err) { continue; }

      var result;
      try {
        // Tight budgets: this runs on the player's device, and a daily that
        // needs a long search is a daily better replaced by the next seed.
        result = W.solve(level, {
          exactPar: opts.exactPar === true,
          maxSteadyNodes: 40000,
          maxCandidates: 120,
          maxNodes: 20000,
          deadline: Math.min(overallDeadline, Date.now() + (opts.attemptMs || 250))
        });
      } catch (err) { continue; }

      if (!result.solved) continue;
      if (result.par < LIMITS.minPar || result.par > LIMITS.maxPar) continue;
      if (result.minHeadroom < LIMITS.minHeadroom) continue;

      spec.par = result.par;
      spec.attempt = attempt;
      return { spec: spec, level: W.buildLevel(spec), solution: result, dayNumber: day };
    }

    return null;
  }

  root.WaterWorks = root.WaterWorks || {};
  root.WaterWorks.dailyFor = dailyFor;
  root.WaterWorks.dailyDayNumber = dayNumberFor;
  root.WaterWorks.dailyLimits = LIMITS;
})(typeof window !== 'undefined' ? window : globalThis);
