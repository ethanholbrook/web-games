/*
 * Water Works - simulation engine.
 *
 * Pure logic, no DOM. Loaded as a classic script in the browser and required
 * directly by tests/engine.test.js under Node.
 *
 * Two rules make the fixed-timestep update well behaved:
 *
 *   1. A pump can only move water the source vat held at the START of the tick.
 *      Water arriving this tick is not available for pass-through, so a vat run
 *      at zero buffer settles one tick's worth above empty instead of
 *      oscillating. When several pumps share a source and together demand more
 *      than it holds, every one of them is scaled by the same factor - no pump
 *      gets priority over its siblings.
 *
 *   2. Overflow is judged on the NETTED level (in minus out), not on inflow
 *      alone. A vat at 99% passing water straight through is not overflowing.
 */
(function (root) {
  'use strict';

  var EPS = 1e-9;
  var OVERFLOW_EPS = 1e-7;

  function snapRate(value, step, max) {
    if (!isFinite(value)) return 0;
    var v = Math.round(value / step) * step;
    if (v < 0) v = 0;
    if (v > max) v = max;
    return Math.round(v * 1e6) / 1e6;
  }

  function Game(level) {
    this.level = level;
    this.cfg = level.config;
    this.fixedRates = level.mode === 'puzzle';
    this.reset();
  }

  /** Full reset: levels, timers, pump states and every configured rate. */
  Game.prototype.reset = function () {
    var self = this;

    this.status = 'IDLE';
    this.elapsed = 0;
    this.failure = null;
    this.moves = 0;

    this.vats = {};
    this.vatOrder = [];
    this.reservoirId = null;
    this.level.vats.forEach(function (v) {
      if (v.reservoir) self.reservoirId = v.id;
      self.vats[v.id] = {
        id: v.id,
        label: v.label,
        level: v.start || 0,
        capacity: v.capacity,
        reservoir: !!v.reservoir,
        netFlow: 0
      };
      self.vatOrder.push(v.id);
    });

    // In puzzle mode every rate comes from the level and never changes; in
    // sandbox mode pumps start at a default the player is free to retune.
    this.pumps = {};
    this.pumpOrder = [];
    this.level.pumps.forEach(function (p) {
      self.pumps[p.id] = {
        id: p.id,
        src: p.src,
        dst: p.dst,
        description: p.description,
        on: false,
        rate: p.rate === undefined ? self.cfg.defaultPumpRate : p.rate,
        flow: 0,
        starving: false,
        starveTimer: 0
      };
      self.pumpOrder.push(p.id);
    });

    this.inlets = this.level.inlets.map(function (i) {
      return {
        id: i.id,
        name: i.name,
        target: i.target,
        description: i.description,
        rate: i.rate === undefined ? 0 : i.rate,
        flow: 0
      };
    });
  };

  Game.prototype.start = function () {
    if (this.status === 'IDLE' || this.status === 'PAUSED') this.status = 'RUNNING';
  };

  Game.prototype.pause = function () {
    if (this.status === 'RUNNING') this.status = 'PAUSED';
  };

  Game.prototype.isOver = function () {
    return this.status === 'WON' || this.status === 'LOST';
  };

  Game.prototype.togglePump = function (id) {
    var p = this.pumps[id];
    if (!p || this.isOver()) return false;
    p.on = !p.on;
    this.moves++;
    if (!p.on) {
      p.flow = 0;
      p.starving = false;
      p.starveTimer = 0;
    }
    return p.on;
  };

  Game.prototype.setPumpRate = function (id, gps) {
    var p = this.pumps[id];
    if (!p || this.isOver() || this.fixedRates) return;
    p.rate = snapRate(gps, this.cfg.rateStep, this.cfg.maxPumpRate);
  };

  Game.prototype.setInletRate = function (index, gps) {
    var inlet = this.inlets[index];
    if (!inlet || this.isOver() || this.fixedRates) return;
    inlet.rate = snapRate(gps, this.cfg.rateStep, this.cfg.maxInletRate);
  };

  Game.prototype.totalInflow = function () {
    var sum = 0;
    for (var i = 0; i < this.inlets.length; i++) sum += this.inlets[i].rate;
    return sum;
  };

  /** Flow actually reaching vat 10 right now, gal/s. */
  Game.prototype.reservoirInflow = function () {
    var sum = 0;
    for (var i = 0; i < this.pumpOrder.length; i++) {
      var p = this.pumps[this.pumpOrder[i]];
      if (p.dst === this.reservoirId) sum += p.flow;
    }
    return sum;
  };

  /**
   * Advance the simulation by one fixed tick. Does nothing unless RUNNING, so
   * callers can drive this from an accumulator without checking state first.
   */
  Game.prototype.step = function (dt) {
    if (this.status !== 'RUNNING') return this.status;

    var cfg = this.cfg;
    var i, id, p, v;

    // 1. What each source vat is being asked for this tick.
    var demand = {};
    for (i = 0; i < this.pumpOrder.length; i++) {
      p = this.pumps[this.pumpOrder[i]];
      p.flow = 0;
      if (p.on && p.rate > 0) demand[p.src] = (demand[p.src] || 0) + p.rate;
    }

    // 2. Scale each vat's outgoing pumps together when it cannot meet demand.
    var scale = {};
    for (id in demand) {
      if (!Object.prototype.hasOwnProperty.call(demand, id)) continue;
      var need = demand[id] * dt;
      var have = this.vats[id].level;
      scale[id] = need <= have + EPS ? 1 : have / need;
    }

    // 3. Resolve per-pump flow and starvation.
    var inflow = {};
    var starvedPump = null;
    for (i = 0; i < this.pumpOrder.length; i++) {
      p = this.pumps[this.pumpOrder[i]];
      if (!p.on || p.rate <= 0) {
        p.starving = false;
        p.starveTimer = 0;
        continue;
      }
      var s = scale[p.src];
      p.flow = p.rate * s;
      if (s < 1 - EPS) {
        p.starving = true;
        p.starveTimer += dt;
        if (p.starveTimer > cfg.dryGrace && !starvedPump) starvedPump = p;
      } else {
        p.starving = false;
        p.starveTimer = 0;
      }
      inflow[p.dst] = (inflow[p.dst] || 0) + p.flow;
    }

    for (i = 0; i < this.inlets.length; i++) {
      var inlet = this.inlets[i];
      inlet.flow = inlet.rate;
      if (inlet.rate > 0) inflow[inlet.target] = (inflow[inlet.target] || 0) + inlet.rate;
    }

    // 4. Net every working vat, then judge overflow on the result.
    var overflowedVat = null;
    for (i = 0; i < this.vatOrder.length; i++) {
      id = this.vatOrder[i];
      v = this.vats[id];
      if (v.reservoir) continue;
      var outRate = (demand[id] || 0) * (scale[id] === undefined ? 1 : scale[id]);
      v.netFlow = (inflow[id] || 0) - outRate;
      v.level += v.netFlow * dt;
      if (v.level > v.capacity + OVERFLOW_EPS && !overflowedVat) overflowedVat = v;
      if (v.level < 0) v.level = 0;
      if (v.level > v.capacity) v.level = v.capacity;
    }

    // 5. The reservoir only ever receives.
    var res = this.vats[this.reservoirId];
    res.netFlow = inflow[this.reservoirId] || 0;
    res.level = Math.min(res.capacity, res.level + res.netFlow * dt);

    this.elapsed += dt;

    if (overflowedVat) {
      this.status = 'LOST';
      this.failure = { kind: 'OVERFLOW', targetId: overflowedVat.id, label: overflowedVat.label };
    } else if (starvedPump) {
      this.status = 'LOST';
      this.failure = { kind: 'DRY_RUN', targetId: starvedPump.id, label: starvedPump.id };
    } else if (res.level >= res.capacity - EPS) {
      this.status = 'WON';
    } else if (this.level.timeLimit && this.elapsed >= this.level.timeLimit) {
      this.status = 'LOST';
      this.failure = { kind: 'TIMEOUT', targetId: res.id, label: res.label };
    }

    return this.status;
  };

  Game.prototype.progress = function () {
    var res = this.vats[this.reservoirId];
    return res.level / res.capacity;
  };

  /** Live snapshot. Intentionally shallow - the renderer reads, never writes. */
  Game.prototype.getState = function () {
    return {
      status: this.status,
      elapsed: this.elapsed,
      failure: this.failure,
      vats: this.vats,
      pumps: this.pumps,
      inlets: this.inlets,
      progress: this.progress()
    };
  };

  root.WaterWorks = root.WaterWorks || {};
  root.WaterWorks.Game = Game;
  root.WaterWorks.snapRate = snapRate;
  root.WaterWorks.createGame = function (level) { return new Game(level); };
})(typeof window !== 'undefined' ? window : globalThis);
