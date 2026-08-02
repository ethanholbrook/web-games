/*
 * Water Works - level builder.
 *
 * Turns a logical level spec into a drawable level. Authors describe a plant in
 * terms of grid positions and flow rates; everything visual - pipe paths, port
 * positions, button placement, the SVG viewBox - is derived here, so no level
 * ever hard-codes a coordinate.
 *
 * A spec looks like:
 *
 *   {
 *     id: 'c3', name: 'Crossfeed', mode: 'puzzle',
 *     cols: 3, rows: 3,
 *     vats:      [ { id: 'V1', col: 0, row: 0, capacity: 40 }, ... ],
 *     reservoir: { capacity: 240 },
 *     inlets:    [ { target: 'V1', rate: 6 } ],
 *     pumps:     [ { id: 'P1', src: 'V1', dst: 'V4', rate: 5 } ],
 *     timeLimit: 90            // optional
 *   }
 *
 * Grids may be sparse - a vat only exists where the spec puts one.
 */
(function (root) {
  'use strict';

  var DEFAULT_CONFIG = {
    maxInletRate: 12,
    maxPumpRate: 12,
    rateStep: 0.5,
    defaultPumpRate: 5,
    dryGrace: 2.0,
    starveVisualDelay: 0.15,
    warnFraction: 0.85,
    simHz: 60
  };

  // Layout constants.
  //
  // Everything is proportional to COL_PITCH, so the plant reads the same at any
  // grid size. The ratios that matter:
  //
  //   vat width      0.43 x pitch   leaves 0.57 between columns
  //   switch width   0.31 x pitch   sits inside that gap with room either side
  //   pipe (widest)  0.11 x pitch   thick enough to read, thin enough to pass
  //                                 under a switch
  //
  // The diagram is scaled to fit the stage, so a switch's size in pixels comes
  // from its share of the viewBox rather than its raw number. Keeping the world
  // compact is what makes it tappable on a phone: at three columns the viewBox
  // is 648 wide, so a 66-unit switch lands at ~38px.
  var COL_PITCH = 212;
  var ROW_PITCH = 265;
  var VAT_W = 92;
  var VAT_H = 100;
  var FIRST_COL_X = 112;      // centre of column 0
  var FIRST_ROW_Y = 60;       // top of row 0
  var INLET_TOP = 6;
  var OUTLET_BAND = 80;       // gap between the last row and the reservoir
  var RESERVOIR_H = 95;
  var RESERVOIR_PAD = 16;     // how far the reservoir overhangs the outer vats
  var BOTTOM_PAD = 10;

  var PORT_DX = 32;           // diagonals leave this far off centre
  var LATERAL_INSET = 32;     // laterals run this far above the vat floor
  var BUTTON_W = 66;
  var BUTTON_H = 44;
  // Crossing diagonals separate by span*|1 - 2t|, so a smaller t pushes the pair
  // apart AND lifts them clear of the vertical switch sitting mid-band between
  // the same two rows. 0.16 clears both while keeping each below its source vat.
  var DIAGONAL_T = 0.16;
  var PARALLEL_GAP = 100;     // spacing between pipes joining the same two vats
  var LABEL_OFFSET = 50;      // how far a rate badge sits off its pipe

  // Pipe thickness carries the flow rate, so the plant can be read at a glance
  // before any of the numbers are. Measured against the same reference rate on
  // every level, so a 10 gal/s pipe looks identical wherever it appears.
  var PIPE_MIN_W = 8;
  var PIPE_MAX_W = 24;

  function pipeWidth(rate, maxRate) {
    var t = Math.max(0, Math.min(1, (rate || 0) / (maxRate || 12)));
    return Math.round((PIPE_MIN_W + (PIPE_MAX_W - PIPE_MIN_W) * t) * 10) / 10;
  }

  var INLET_NAMES = ['A', 'B', 'C', 'D', 'E', 'F'];

  function lerp(a, b, t) { return a + (b - a) * t; }

  function classify(src, dst, reservoirId) {
    if (dst.id === reservoirId) return 'outlet';
    if (dst.row === src.row) return 'lateral';
    return dst.col === src.col ? 'vertical' : 'diagonal';
  }

  /**
   * `slot` and `slots` spread pumps that share the same pair of vats sideways,
   * so two parallel pipes are drawn as two pipes rather than one on top of
   * another. A single pump is always centred.
   */
  function geometryFor(kind, src, dst, slot, slots) {
    var a, b, dir;

    if (kind === 'vertical') {
      a = { x: src.cx, y: src.bottom };
      b = { x: dst.cx, y: dst.top };
    } else if (kind === 'outlet') {
      a = { x: src.cx, y: src.bottom };
      b = { x: src.cx, y: dst.top };
    } else if (kind === 'lateral') {
      var y = src.bottom - LATERAL_INSET;
      var leftToRight = dst.col > src.col;
      a = { x: leftToRight ? src.x + src.w : src.x, y: y };
      b = { x: leftToRight ? dst.x : dst.x + dst.w, y: y };
    } else {
      dir = dst.col > src.col ? 1 : -1;
      a = { x: src.cx + dir * PORT_DX, y: src.bottom };
      b = { x: dst.cx - dir * PORT_DX, y: dst.top };
    }

    // Where the rate badge sits relative to its switch. Pushing every badge
    // straight out to the right works for a vertical run, but on a diagonal it
    // lands on whatever pipe the next column has there - so a diagonal's badge
    // follows its own direction of travel and lifts, into the open band beside
    // the vat it came from.
    var labelDX, labelDY;
    if (kind === 'lateral') {
      labelDX = 0;
      labelDY = -LABEL_OFFSET * 0.5;
    } else if (kind === 'diagonal') {
      labelDX = (b.x >= a.x ? 1 : -1) * LABEL_OFFSET * 0.72;
      labelDY = -LABEL_OFFSET * 0.72;
    } else {
      labelDX = LABEL_OFFSET;
      labelDY = 0;
    }

    if (slots > 1) {
      var dx = b.x - a.x;
      var dy = b.y - a.y;
      var len = Math.sqrt(dx * dx + dy * dy) || 1;
      var shift = (slot - (slots - 1) / 2) * PARALLEL_GAP;
      var nx = -dy / len * shift;
      var ny = dx / len * shift;
      a = { x: a.x + nx, y: a.y + ny };
      b = { x: b.x + nx, y: b.y + ny };
      // Labels go outwards from the bundle, or they land on the next pipe over.
      var away = Math.sqrt(nx * nx + ny * ny) || 1;
      labelDX = nx / away * LABEL_OFFSET;
      labelDY = ny / away * LABEL_OFFSET;
    }

    var t = kind === 'diagonal' ? DIAGONAL_T : 0.5;
    return {
      path: 'M ' + a.x + ' ' + a.y + ' L ' + b.x + ' ' + b.y,
      length: Math.sqrt((b.x - a.x) * (b.x - a.x) + (b.y - a.y) * (b.y - a.y)),
      buttonX: lerp(a.x, b.x, t),
      buttonY: lerp(a.y, b.y, t),
      // Perpendicular offset for the rate label so it never sits on the pipe.
      labelX: lerp(a.x, b.x, t) + labelDX,
      labelY: lerp(a.y, b.y, t) + labelDY
    };
  }

  function buildLevel(spec) {
    var config = {};
    var k;
    for (k in DEFAULT_CONFIG) config[k] = DEFAULT_CONFIG[k];
    for (k in (spec.config || {})) config[k] = spec.config[k];

    var cols = spec.cols;
    var rows = spec.rows;
    var width = FIRST_COL_X * 2 + (cols - 1) * COL_PITCH;
    var lastRowBottom = FIRST_ROW_Y + (rows - 1) * ROW_PITCH + VAT_H;
    var reservoirTop = lastRowBottom + OUTLET_BAND;
    var height = reservoirTop + RESERVOIR_H + BOTTOM_PAD;

    var vats = spec.vats.map(function (v) {
      var cx = FIRST_COL_X + v.col * COL_PITCH;
      var top = FIRST_ROW_Y + v.row * ROW_PITCH;
      return {
        id: v.id,
        label: v.label || v.id,
        col: v.col,
        row: v.row,
        capacity: v.capacity,
        start: v.start || 0,
        x: cx - VAT_W / 2,
        y: top,
        w: VAT_W,
        h: VAT_H,
        cx: cx,
        top: top,
        bottom: top + VAT_H
      };
    });

    var reservoirSpec = spec.reservoir;
    var reservoirId = reservoirSpec.id || 'R';
    var reservoirX = FIRST_COL_X - VAT_W / 2 - RESERVOIR_PAD;
    var reservoirW = width - 2 * reservoirX;

    var reservoir = {
      id: reservoirId,
      label: reservoirSpec.label || 'Reservoir',
      capacity: reservoirSpec.capacity,
      start: reservoirSpec.start || 0,
      reservoir: true,
      col: (cols - 1) / 2,
      row: rows,
      x: reservoirX,
      y: reservoirTop,
      w: reservoirW,
      h: RESERVOIR_H,
      cx: width / 2,
      top: reservoirTop,
      bottom: reservoirTop + RESERVOIR_H
    };

    vats.push(reservoir);

    var vatById = {};
    vats.forEach(function (v) { vatById[v.id] = v; });

    // Count pipes per vat pair up front so parallel runs can be fanned out.
    var pairCount = {};
    var pairSeen = {};
    spec.pumps.forEach(function (p) {
      var key = p.src + '>' + p.dst;
      pairCount[key] = (pairCount[key] || 0) + 1;
    });

    var pumps = spec.pumps.map(function (p) {
      var src = vatById[p.src];
      var dst = vatById[p.dst];
      if (!src) throw new Error(p.id + ' draws from unknown vat ' + p.src);
      if (!dst) throw new Error(p.id + ' feeds unknown vat ' + p.dst);

      var key = p.src + '>' + p.dst;
      var slot = pairSeen[key] = (pairSeen[key] === undefined ? 0 : pairSeen[key] + 1);

      var kind = classify(src, dst, reservoirId);
      var geom = geometryFor(kind, src, dst, slot, pairCount[key]);

      return {
        id: p.id,
        src: p.src,
        dst: p.dst,
        rate: p.rate,
        width: pipeWidth(p.rate, config.maxPumpRate),
        kind: kind,
        path: geom.path,
        length: geom.length,
        buttonX: geom.buttonX,
        buttonY: geom.buttonY,
        labelX: geom.labelX,
        labelY: geom.labelY,
        description: src.label + ' → ' + dst.label
      };
    });

    var inlets = spec.inlets.map(function (inlet, i) {
      var vat = vatById[inlet.target];
      if (!vat) throw new Error('inlet feeds unknown vat ' + inlet.target);
      return {
        id: inlet.id || 'IN' + (i + 1),
        name: 'Inlet ' + (INLET_NAMES[i] || i + 1),
        target: inlet.target,
        rate: inlet.rate,
        width: pipeWidth(inlet.rate, config.maxInletRate),
        path: 'M ' + vat.cx + ' ' + INLET_TOP + ' L ' + vat.cx + ' ' + vat.top,
        length: vat.top - INLET_TOP,
        description: 'Inlet ' + (INLET_NAMES[i] || i + 1) + ' → ' + vat.label
      };
    });

    return {
      id: spec.id,
      name: spec.name,
      blurb: spec.blurb,
      mode: spec.mode || 'puzzle',
      config: config,
      timeLimit: spec.timeLimit,
      par: spec.par,
      view: { width: width, height: height },
      button: { w: BUTTON_W, h: BUTTON_H },
      pipe: { min: PIPE_MIN_W, max: PIPE_MAX_W },
      vats: vats,
      vatById: vatById,
      reservoirId: reservoirId,
      pumps: pumps,
      inlets: inlets
    };
  }

  root.WaterWorks = root.WaterWorks || {};
  root.WaterWorks.buildLevel = buildLevel;
  root.WaterWorks.pipeWidth = pipeWidth;
  root.WaterWorks.defaultConfig = DEFAULT_CONFIG;
})(typeof window !== 'undefined' ? window : globalThis);
