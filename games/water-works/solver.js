/*
 * Water Works - puzzle solver.
 *
 * Finds a winning sequence of pump toggles for a fixed-rate level. The clock is
 * the score, so it reports the QUICKEST line it can find - that time becomes the
 * level's target - along with the fewest toggles it managed, as a bonus stat.
 *
 * THREE KINDS OF SOLUTION
 *
 * A BALANCED SET is a set of pumps where no vat is asked for more than it
 * receives, switched on once and left alone. That search enumerates sets
 * directly, walking vats in topological order so each vat's inflow is settled
 * before its outgoing pumps are chosen, with iterative deepening on set size.
 *
 * A BURST lets a vat fill, runs a pump faster than its supply for a while, then
 * shuts it off before it empties. An event-driven A* covers those, walking the
 * timeline of moments where something actually changes - a vat fills, a vat runs
 * low, a vat first has enough to feed a pump - because nothing in between is
 * worth acting on. It is capped low, since bursts are only worth hunting for
 * when they are short.
 *
 * A CYCLE is that repeated: run, rest, run again. Every pump is put under
 * two-sided bang-bang control - it needs water behind it AND room in front of it
 * - and pumps that turn out not to be needed are greedily dropped. This is the
 * only thing that solves a level with no steady state, which is what the
 * campaign is built from.
 *
 * The first two double as a difficulty check: if either solves a level, that
 * level can be won by flipping switches once and walking away.
 *
 * SOUND, NOT COMPLETE
 *
 * Both searches work in exact arithmetic; the game runs at 60Hz where a pump
 * can only move what its source held at the start of the tick. To keep the two
 * from disagreeing, drawn-from vats are held above a safety MARGIN rather than
 * allowed to touch zero, and EVERY candidate schedule is REPLAYED THROUGH THE
 * REAL ENGINE before being accepted. The engine is the ground truth, so any
 * schedule this module returns genuinely wins.
 *
 * The converse does not hold - a level none of the three cracks may still be
 * solvable by hand. That is the safe direction to be wrong in: levels the
 * solver rejects simply never ship.
 */
(function (root) {
  'use strict';

  var EPS = 1e-9;

  var DEFAULTS = {
    margin: 1.0,           // gallons a drawn-from vat must keep in reserve
    maxMoves: 16,          // ceiling on toggles for the balanced-set search
    maxBurstMoves: 8,      // ceiling for the event search - bursts must be short
    waitQuantum: 1.0,      // seconds; decision points between hard deadlines
    maxNodes: 120000,      // event-search expansions when it is the only hope
    beatParNodes: 45000,   // cheaper budget when only trying to undercut a par
    exactPar: true,        // false skips the undercut pass entirely (fast path)
    maxSteadyNodes: 400000,
    maxCandidates: 600,    // balanced sets verified per depth
    burstThreshold: 0.85,  // fraction of capacity a burst pump waits for
    offFraction: 0.06,     // fraction of capacity a cycling pump shuts off at
    destHigh: 0.88,        // destination fullness at which a pump backs off
    destLow: 0.70,         // and the level it must drop to before restarting
    maxTime: 180,          // seconds of simulated time
    quantiseLevel: 0.05,
    deadline: undefined,   // absolute Date.now() past which to give up
    marginRetries: [1.0, 2.0, 4.0]
  };

  // ------------------------------------------------------------------ model

  function buildModel(level, opts) {
    var working = [];
    var reservoir = null;

    level.vats.forEach(function (v) {
      if (v.reservoir) reservoir = v; else working.push(v);
    });
    if (!reservoir) throw new Error('level has no reservoir vat');

    var index = {};
    working.forEach(function (v, i) { index[v.id] = i; });

    var n = working.length;
    var model = {
      n: n,
      reservoirId: reservoir.id,
      capacity: new Float64Array(n),
      start: new Float64Array(n),
      inletRate: new Float64Array(n),
      resCapacity: reservoir.capacity,
      resStart: reservoir.start || 0,
      margin: opts.margin,
      maxTime: Math.min(opts.maxTime, level.timeLimit || opts.maxTime)
    };

    working.forEach(function (v, i) {
      model.capacity[i] = v.capacity;
      model.start[i] = v.start || 0;
    });

    level.inlets.forEach(function (inlet) {
      var i = index[inlet.target];
      if (i === undefined) throw new Error('inlet feeds unknown vat ' + inlet.target);
      model.inletRate[i] += inlet.rate || 0;
    });

    model.pumps = level.pumps.map(function (p) {
      if (index[p.src] === undefined) throw new Error(p.id + ' draws from unknown vat ' + p.src);
      if (p.dst !== reservoir.id && index[p.dst] === undefined) {
        throw new Error(p.id + ' feeds unknown vat ' + p.dst);
      }
      return {
        id: p.id,
        rate: p.rate,
        src: index[p.src],
        dst: p.dst === reservoir.id ? -1 : index[p.dst]
      };
    });

    if (model.pumps.length > 30) throw new Error('solver supports at most 30 pumps');

    model.outPumps = [];
    for (var i = 0; i < n; i++) model.outPumps.push([]);
    model.pumps.forEach(function (p, k) { model.outPumps[p.src].push(k); });

    model.topo = topoOrder(model);
    return model;
  }

  /** Vats ordered so every pump points from an earlier vat to a later one. */
  function topoOrder(model) {
    var indegree = new Int32Array(model.n);
    model.pumps.forEach(function (p) { if (p.dst >= 0) indegree[p.dst]++; });

    var queue = [];
    for (var i = 0; i < model.n; i++) if (indegree[i] === 0) queue.push(i);

    var order = [];
    while (queue.length) {
      var v = queue.shift();
      order.push(v);
      model.outPumps[v].forEach(function (k) {
        var dst = model.pumps[k].dst;
        if (dst >= 0 && --indegree[dst] === 0) queue.push(dst);
      });
    }

    if (order.length !== model.n) throw new Error('plumbing contains a cycle');
    return order;
  }

  // ------------------------------------------------------ balanced-set search

  /** Every subset of `pumpIdx` whose combined rate fits inside `budget`. */
  function feasibleSubsets(model, pumpIdx, budget) {
    var out = [];
    var total = 1 << pumpIdx.length;
    for (var bits = 0; bits < total; bits++) {
      var rate = 0;
      var size = 0;
      for (var b = 0; b < pumpIdx.length; b++) {
        if (bits & (1 << b)) { rate += model.pumps[pumpIdx[b]].rate; size++; }
      }
      if (rate <= budget + EPS) out.push({ bits: bits, rate: rate, size: size });
    }
    // Smallest sets first, and among equals the ones that move the most water -
    // both push the search towards short, fast solutions.
    out.sort(function (a, b) { return a.size - b.size || b.rate - a.rate; });
    return out;
  }

  /**
   * How much faster than its supply a vat may be drained and still last the
   * run. A vat holding C gallons losing d gal/s survives C/d seconds, and the
   * run cannot possibly be shorter than filling the reservoir at full tilt, so
   * that shortest possible run gives a safe ceiling on d.
   */
  function deficitAllowance(model) {
    var allowance = new Float64Array(model.n);
    var maxResRate = 0;
    model.pumps.forEach(function (p) { if (p.dst === -1) maxResRate += p.rate; });
    if (maxResRate <= EPS) return allowance;

    var shortestRun = (model.resCapacity - model.resStart) / maxResRate;
    if (shortestRun <= EPS) return allowance;

    for (var i = 0; i < model.n; i++) allowance[i] = model.capacity[i] / shortestRun;
    return allowance;
  }

  /**
   * Collect sets of at most `maxCount` pumps where no vat is asked for more
   * than it receives (plus any deficit `allowance` permits), and some water
   * reaches the reservoir.
   */
  function enumerateBalanced(model, opts, maxCount, allowance) {
    var candidates = [];
    var inflow = new Float64Array(model.n);
    var chosen = [];
    var nodes = 0;
    var stop = false;

    for (var i = 0; i < model.n; i++) inflow[i] = model.inletRate[i];

    function dfs(step, count, resIn) {
      if (stop || ++nodes > opts.maxSteadyNodes) { stop = true; return; }
      if (count > maxCount) return;

      if (step === model.topo.length) {
        if (resIn > EPS) {
          candidates.push({ pumps: chosen.slice(), count: count, resIn: resIn });
          if (candidates.length >= opts.maxCandidates) stop = true;
        }
        return;
      }

      var v = model.topo[step];
      var outs = model.outPumps[v];

      if (!outs.length) { dfs(step + 1, count, resIn); return; }

      var subsets = feasibleSubsets(model, outs, inflow[v] + (allowance ? allowance[v] : 0));
      for (var s = 0; s < subsets.length && !stop; s++) {
        var sub = subsets[s];
        if (count + sub.size > maxCount) continue;

        var added = [];
        var resAdd = 0;
        for (var b = 0; b < outs.length; b++) {
          if (!(sub.bits & (1 << b))) continue;
          var k = outs[b];
          var p = model.pumps[k];
          if (p.dst === -1) resAdd += p.rate; else inflow[p.dst] += p.rate;
          chosen.push(k);
          added.push(k);
        }

        dfs(step + 1, count + sub.size, resIn + resAdd);

        for (var a = added.length - 1; a >= 0; a--) {
          var pk = model.pumps[added[a]];
          if (pk.dst !== -1) inflow[pk.dst] -= pk.rate;
          chosen.pop();
        }
      }
    }

    dfs(0, 0, 0);
    candidates.sort(function (a, b) { return a.count - b.count || b.resIn - a.resIn; });
    return candidates;
  }

  /**
   * Play a chosen set of pumps: switch each on the moment its source clears the
   * safety margin. Runs on the real engine, so the returned schedule is already
   * verified rather than merely planned.
   */
  function playSet(level, pumpIds, opts, cyclic) {
    var game = root.WaterWorks.createGame(level);
    var dt = 1 / level.config.simHz;
    var limit = Math.min(opts.maxTime, level.timeLimit || opts.maxTime);
    var pending = pumpIds.slice();
    var cooling = {};
    var moves = [];
    var minHeadroom = Infinity;
    var minReserve = Infinity;

    // Would switching `pump` on leave its source losing water?
    function wouldStarve(pump) {
      var net = 0;
      game.inlets.forEach(function (inl) { if (inl.target === pump.src) net += inl.rate; });
      game.pumpOrder.forEach(function (id) {
        var other = game.pumps[id];
        if (!other.on) return;
        if (other.dst === pump.src) net += other.rate;
        if (other.src === pump.src) net -= other.rate;
      });
      return net - pump.rate < -EPS;
    }

    /* Bang-bang control for levels with no steady state: run a pump until its
       source is nearly empty, let the vat refill, run it again. Once a pump has
       been shut off for want of water it must wait for a full buffer before
       restarting, which is what stops it chattering at the threshold. */
    function controlCyclic() {
      for (var i = 0; i < pumpIds.length; i++) {
        var pump = game.pumps[pumpIds[i]];
        var source = game.vats[pump.src];
        var dest = game.vats[pump.dst];
        var offLevel = Math.max(opts.margin * 2, source.capacity * opts.offFraction);

        // Two-sided control. A pump needs water behind it AND room in front of
        // it: shutting off only when the source empties will happily overfill
        // whatever is downstream.
        var destFull = !dest.reservoir && dest.level >= dest.capacity * opts.destHigh;
        var destHasRoom = dest.reservoir || dest.level <= dest.capacity * opts.destLow;

        if (pump.on) {
          if (source.level <= offLevel || destFull) {
            game.togglePump(pump.id);
            moves.push({ t: game.elapsed, pumpId: pump.id, on: false });
            cooling[pump.id] = source.level <= offLevel;
          }
        } else {
          var threshold = (cooling[pump.id] || wouldStarve(pump))
            ? source.capacity * opts.burstThreshold
            : opts.margin;
          if (source.level >= threshold && destHasRoom) {
            game.togglePump(pump.id);
            moves.push({ t: game.elapsed, pumpId: pump.id, on: true });
            cooling[pump.id] = false;
          }
        }
      }
    }

    function controlOnce() {
      for (var i = pending.length - 1; i >= 0; i--) {
        var pump = game.pumps[pending[i]];
        var source = game.vats[pump.src];
        // A pump its source can sustain goes on as soon as there is anything to
        // draw. One that outruns its supply has to wait for a full buffer,
        // otherwise it drains the vat and trips immediately.
        var threshold = wouldStarve(pump)
          ? source.capacity * opts.burstThreshold
          : opts.margin;
        if (source.level >= threshold) {
          game.togglePump(pump.id);
          moves.push({ t: game.elapsed, pumpId: pump.id, on: true });
          pending.splice(i, 1);
        }
      }
    }

    game.start();
    while (!game.isOver() && game.elapsed < limit) {
      if (cyclic) controlCyclic(); else controlOnce();

      game.step(dt);

      if (game.status === 'RUNNING') {
        for (var v = 0; v < game.vatOrder.length; v++) {
          var vat = game.vats[game.vatOrder[v]];
          if (!vat.reservoir) minHeadroom = Math.min(minHeadroom, vat.capacity - vat.level);
        }
        for (var k = 0; k < game.pumpOrder.length; k++) {
          var p = game.pumps[game.pumpOrder[k]];
          if (p.on && p.rate > 0) minReserve = Math.min(minReserve, game.vats[p.src].level);
        }
      }
    }

    return {
      won: game.status === 'WON',
      moves: moves,
      elapsed: game.elapsed,
      failure: game.failure,
      unplaced: pending.length,
      minHeadroom: isFinite(minHeadroom) ? minHeadroom : null,
      minReserve: isFinite(minReserve) ? minReserve : null
    };
  }

  function expired(opts) {
    return opts.deadline !== undefined && Date.now() > opts.deadline;
  }

  /** Pumps that lead somewhere useful — feeding a dead end only overflows it. */
  function usefulPumps(model) {
    var reaches = new Uint8Array(model.n);
    var changed = true;
    while (changed) {
      changed = false;
      model.pumps.forEach(function (p) {
        if (reaches[p.src]) return;
        if (p.dst === -1 || reaches[p.dst]) { reaches[p.src] = 1; changed = true; }
      });
    }
    return model.pumps
      .filter(function (p) { return p.dst === -1 || reaches[p.dst]; })
      .map(function (p) { return p.id; });
  }

  /**
   * Levels with no steady state are won by cycling: fill a vat, drain it faster
   * than it refills, shut off, repeat. Run every useful pump under bang-bang
   * control, then greedily drop pumps that turn out not to be needed.
   */
  function cyclicSolve(level, model, opts) {
    var candidates = usefulPumps(model);
    if (!candidates.length) return null;
    if (!playSet(level, candidates, opts, true).won) return null;

    var kept = candidates.slice();
    for (var i = candidates.length - 1; i >= 0 && !expired(opts); i--) {
      if (kept.length <= 1) break;
      var trial = kept.filter(function (id) { return id !== candidates[i]; });
      if (!trial.length) continue;
      if (playSet(level, trial, opts, true).won) kept = trial;
    }

    var final = playSet(level, kept, opts, true);
    return final.won ? final : null;
  }

  function balancedSolve(level, model, opts, allowance) {
    for (var size = 1; size <= Math.min(opts.maxMoves, model.pumps.length); size++) {
      if (expired(opts)) return null;
      var candidates = enumerateBalanced(model, opts, size, allowance);
      for (var c = 0; c < candidates.length; c++) {
        if (candidates[c].count !== size) continue;
        if (expired(opts)) return null;
        var ids = candidates[c].pumps.map(function (k) { return model.pumps[k].id; });
        var played = playSet(level, ids, opts);
        if (played.won) return played;
      }
    }
    return null;
  }

  // --------------------------------------------------------- event search

  function rates(model, mask, net, outflow) {
    var i;
    for (i = 0; i < model.n; i++) {
      net[i] = model.inletRate[i];
      outflow[i] = 0;
    }
    var resNet = 0;
    for (i = 0; i < model.pumps.length; i++) {
      if (!(mask & (1 << i))) continue;
      var p = model.pumps[i];
      net[p.src] -= p.rate;
      outflow[p.src] += p.rate;
      if (p.dst === -1) resNet += p.rate; else net[p.dst] += p.rate;
    }
    return resNet;
  }

  function nextEvent(model, levels, res, net, outflow, resNet, quantum) {
    var dt = quantum;

    for (var i = 0; i < model.n; i++) {
      var lv = levels[i];
      var nr = net[i];

      if (outflow[i] > EPS && lv <= model.margin + EPS) return { ok: false };

      if (nr > EPS) {
        if (lv >= model.capacity[i] - EPS) return { ok: false };
        dt = Math.min(dt, (model.capacity[i] - lv) / nr);
        if (lv < model.margin - EPS) dt = Math.min(dt, (model.margin - lv) / nr);
      } else if (nr < -EPS) {
        dt = Math.min(dt, (lv - model.margin) / (-nr));
      }
    }

    var win = false;
    if (resNet > EPS) {
      var dtWin = (model.resCapacity - res) / resNet;
      if (dtWin <= dt + EPS) { dt = dtWin; win = true; }
    }

    if (!isFinite(dt) || dt <= EPS) return { ok: win, dt: 0, win: win };
    return { ok: true, dt: dt, win: win };
  }

  /**
   * Admissible lower bound on remaining toggles: if nothing is reaching the
   * reservoir, at least enough switches must be flipped to complete some path
   * from a vat that has water to the reservoir. A 0-1 shortest path, where
   * pumps already running are free.
   */
  function heuristic(model, mask, levels, resNet) {
    if (resNet > EPS) return 0;

    var dist = new Int32Array(model.n).fill(0x7fffffff);
    var deque = [];

    for (var i = 0; i < model.n; i++) {
      if (levels[i] > model.margin || model.inletRate[i] > EPS) { dist[i] = 0; deque.push(i); }
    }

    var best = 0x7fffffff;
    while (deque.length) {
      var v = deque.shift();
      for (var k = 0; k < model.outPumps[v].length; k++) {
        var idx = model.outPumps[v][k];
        var p = model.pumps[idx];
        var cost = (mask & (1 << idx)) ? 0 : 1;
        var nd = dist[v] + cost;
        if (p.dst === -1) { if (nd < best) best = nd; continue; }
        if (nd < dist[p.dst]) {
          dist[p.dst] = nd;
          if (cost === 0) deque.unshift(p.dst); else deque.push(p.dst);
        }
      }
    }

    return best === 0x7fffffff ? 0x7fffffff : best;
  }

  function Heap() { this.items = []; }

  Heap.prototype.better = function (a, b) {
    if (a.f !== b.f) return a.f < b.f;
    return a.t < b.t;
  };

  Heap.prototype.push = function (node) {
    var items = this.items;
    items.push(node);
    var i = items.length - 1;
    while (i > 0) {
      var parent = (i - 1) >> 1;
      if (!this.better(items[i], items[parent])) break;
      var tmp = items[i]; items[i] = items[parent]; items[parent] = tmp;
      i = parent;
    }
  };

  Heap.prototype.pop = function () {
    var items = this.items;
    var top = items[0];
    var last = items.pop();
    if (items.length) {
      items[0] = last;
      var i = 0;
      for (;;) {
        var l = 2 * i + 1, r = l + 1, best = i;
        if (l < items.length && this.better(items[l], items[best])) best = l;
        if (r < items.length && this.better(items[r], items[best])) best = r;
        if (best === i) break;
        var tmp = items[i]; items[i] = items[best]; items[best] = tmp;
        i = best;
      }
    }
    return top;
  };

  function eventSearch(model, opts) {
    var n = model.n;
    var net = new Float64Array(n);
    var outflow = new Float64Array(n);
    var quant = opts.quantiseLevel;

    function key(mask, levels, res) {
      var parts = String(mask);
      for (var i = 0; i < n; i++) parts += ',' + Math.round(levels[i] / quant);
      return parts + ',' + Math.round(res / quant);
    }

    var start = {
      mask: 0, levels: Float64Array.from(model.start), res: model.resStart,
      t: 0, moves: 0, f: 0, parent: null, action: null
    };

    var open = new Heap();
    open.push(start);

    var seen = Object.create(null);
    seen[key(0, start.levels, start.res)] = 0;
    var expanded = 0;

    while (open.items.length) {
      if (++expanded > opts.maxNodes) return { solved: false, reason: 'node limit', expanded: expanded };
      if ((expanded & 255) === 0 && expired(opts)) {
        return { solved: false, reason: 'out of time', expanded: expanded };
      }

      var node = open.pop();
      var resNet = rates(model, node.mask, net, outflow);
      var ev = nextEvent(model, node.levels, node.res, net, outflow, resNet, opts.waitQuantum);

      if (ev.ok && ev.win && ev.dt <= EPS) {
        return { solved: true, node: node, expanded: expanded };
      }

      if (ev.ok && ev.dt > EPS) {
        var t2 = node.t + ev.dt;
        if (t2 <= model.maxTime + EPS) {
          var levels2 = new Float64Array(n);
          for (var i = 0; i < n; i++) levels2[i] = node.levels[i] + net[i] * ev.dt;
          var res2 = node.res + resNet * ev.dt;

          if (ev.win) {
            return {
              solved: true,
              node: { mask: node.mask, t: t2, moves: node.moves, parent: node, action: null },
              expanded: expanded
            };
          }

          var k2 = key(node.mask, levels2, res2);
          if (!(k2 in seen) || seen[k2] > node.moves) {
            seen[k2] = node.moves;
            open.push({
              mask: node.mask, levels: levels2, res: res2, t: t2,
              moves: node.moves, f: node.moves + heuristic(model, node.mask, levels2, resNet),
              parent: node, action: null
            });
          }
        }
      }

      if (node.moves >= opts.maxBurstMoves) continue;

      for (var p = 0; p < model.pumps.length; p++) {
        var mask2 = node.mask ^ (1 << p);
        var kf = key(mask2, node.levels, node.res);
        if (kf in seen && seen[kf] <= node.moves + 1) continue;
        seen[kf] = node.moves + 1;
        var h = heuristic(model, mask2, node.levels, rates(model, mask2, net, outflow));
        if (h === 0x7fffffff) continue;
        open.push({
          mask: mask2, levels: node.levels, res: node.res, t: node.t,
          moves: node.moves + 1, f: node.moves + 1 + h, parent: node, action: p
        });
      }
    }

    return { solved: false, reason: 'exhausted', expanded: expanded };
  }

  function reconstruct(model, node) {
    var out = [];
    for (var cur = node; cur && cur.parent; cur = cur.parent) {
      if (cur.action === null) continue;
      var pump = model.pumps[cur.action];
      out.push({ t: cur.t, pumpId: pump.id, on: (cur.mask & (1 << cur.action)) !== 0 });
    }
    out.reverse();
    return out;
  }

  // ------------------------------------------------------------ verification

  /** Replay a schedule through the real 60Hz engine. The final word. */
  function verifySchedule(level, moves, options) {
    var opts = options || {};
    var game = root.WaterWorks.createGame(level);
    var dt = 1 / level.config.simHz;
    var limit = opts.maxTime || level.timeLimit || DEFAULTS.maxTime;
    var i = 0;
    var minHeadroom = Infinity;
    var minReserve = Infinity;

    game.start();
    while (!game.isOver() && game.elapsed < limit) {
      while (i < moves.length && moves[i].t <= game.elapsed + EPS) {
        game.togglePump(moves[i].pumpId);
        i++;
      }
      game.step(dt);

      if (game.status === 'RUNNING') {
        for (var v = 0; v < game.vatOrder.length; v++) {
          var vat = game.vats[game.vatOrder[v]];
          if (!vat.reservoir) minHeadroom = Math.min(minHeadroom, vat.capacity - vat.level);
        }
        for (var k = 0; k < game.pumpOrder.length; k++) {
          var pump = game.pumps[game.pumpOrder[k]];
          if (pump.on && pump.rate > 0) minReserve = Math.min(minReserve, game.vats[pump.src].level);
        }
      }
    }

    return {
      won: game.status === 'WON',
      elapsed: game.elapsed,
      moves: game.moves,
      failure: game.failure,
      applied: i,
      progress: game.progress(),
      minHeadroom: isFinite(minHeadroom) ? minHeadroom : null,
      minReserve: isFinite(minReserve) ? minReserve : null
    };
  }

  // -------------------------------------------------------------------- API

  function solve(level, options) {
    var opts = {};
    var k;
    for (k in DEFAULTS) opts[k] = DEFAULTS[k];
    for (k in (options || {})) opts[k] = options[k];

    var attempts = [];
    var margins = options && options.margin !== undefined ? [options.margin] : opts.marginRetries;

    for (var m = 0; m < margins.length; m++) {
      var attemptOpts = {};
      for (k in opts) attemptOpts[k] = opts[k];
      attemptOpts.margin = margins[m];

      var model = buildModel(level, attemptOpts);
      var found = [];

      function record(strategy, played) {
        if (!played || !played.won) return;
        found.push({
          strategy: strategy,
          moves: played.moves,
          toggles: played.moves.length,
          time: played.elapsed,
          minHeadroom: played.minHeadroom,
          minReserve: played.minReserve
        });
      }

      // Strict balance first - the fast, common case. Failing that, allow vats
      // to run at a deficit their capacity can absorb for the whole run.
      var balanced = balancedSolve(level, model, attemptOpts, null);
      record('balanced', balanced);
      if (!balanced) {
        record('buffered', balancedSolve(level, model, attemptOpts, deficitAllowance(model)));
      }

      // Cycling is often the FASTEST route even when a steady set exists, since
      // it runs pumps at their full rate instead of throttling to what balances.
      // On levels with no steady state it is the only route.
      record('cyclic', cyclicSolve(level, model, attemptOpts));

      // Bursts cost two toggles per pump, so they only matter for the toggle
      // count, and only when they can undercut what is already found.
      var fewestSoFar = found.reduce(function (best, r) {
        return best === null || r.toggles < best ? r.toggles : best;
      }, null);

      attemptOpts.maxBurstMoves = fewestSoFar === null
        ? opts.maxBurstMoves
        : Math.min(opts.maxBurstMoves, fewestSoFar - 1);
      if (fewestSoFar !== null) attemptOpts.maxNodes = opts.beatParNodes;

      if (attemptOpts.maxBurstMoves >= 1 && (!found.length || opts.exactPar)) {
        var burst = eventSearch(model, attemptOpts);
        if (burst.solved) {
          var schedule = reconstruct(model, burst.node);
          var check = verifySchedule(level, schedule, attemptOpts);
          if (check.won) {
            found.push({
              strategy: 'burst', moves: schedule, toggles: schedule.length,
              time: check.elapsed, minHeadroom: check.minHeadroom, minReserve: check.minReserve
            });
          }
        } else if (!found.length) {
          attempts.push({ margin: margins[m], reason: burst.reason, expanded: burst.expanded });
        }
      }

      if (!found.length) continue;

      // Time is the score, so the headline solution is the quickest one; the
      // toggle count is reported separately as a bonus stat.
      var fastest = found.slice().sort(function (a, b) { return a.time - b.time; })[0];
      var fewest = found.slice().sort(function (a, b) {
        return a.toggles - b.toggles || a.time - b.time;
      })[0];
      // The quickest route deliberately runs vats to the brim, so its headroom
      // says nothing about whether the level is fair. What matters is that SOME
      // comfortable way to win exists - that is what level validation gates on.
      var safest = found.slice().sort(function (a, b) {
        return (b.minHeadroom || 0) - (a.minHeadroom || 0);
      })[0];

      return {
        solved: true,
        strategy: fastest.strategy,
        moves: fastest.moves,
        targetTime: fastest.time,
        verifiedTime: fastest.time,
        par: fewest.toggles,
        parStrategy: fewest.strategy,
        minHeadroom: fastest.minHeadroom,
        minReserve: fastest.minReserve,
        safeHeadroom: safest.minHeadroom,
        safeTime: safest.time,
        margin: margins[m],
        strategies: found.map(function (r) {
          return {
            strategy: r.strategy, toggles: r.toggles,
            time: r.time, headroom: r.minHeadroom
          };
        })
      };
    }

    return { solved: false, attempts: attempts };
  }

  function describe(result) {
    if (!result.solved) {
      return 'no solution (' + result.attempts.map(function (a) {
        return 'margin ' + a.margin + ': ' + a.reason;
      }).join('; ') + ')';
    }
    return result.targetTime.toFixed(1) + 's via ' + result.strategy + ', par '
      + result.par + ' toggles, headroom '
      + (result.minHeadroom === null ? 'n/a' : result.minHeadroom.toFixed(1) + ' gal') + '\n  '
      + result.moves.map(function (mv) {
        return mv.t.toFixed(2) + 's ' + mv.pumpId + ' ' + (mv.on ? 'on' : 'off');
      }).join('\n  ');
  }

  root.WaterWorks = root.WaterWorks || {};
  root.WaterWorks.solve = solve;
  root.WaterWorks.verifySchedule = verifySchedule;
  root.WaterWorks.describeSolution = describe;
  root.WaterWorks.solverDefaults = DEFAULTS;
})(typeof window !== 'undefined' ? window : globalThis);
