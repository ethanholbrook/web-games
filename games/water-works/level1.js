/*
 * Water Works - level 1 topology and geometry.
 *
 * Everything the game knows about the plant lives here: vat capacities, pump
 * wiring, tuning constants and the SVG coordinates used to draw it all. The
 * simulation (engine.js) and the renderer (game.js) both read from this, so
 * there is exactly one place to change if the layout ever moves.
 *
 * Coordinate system: a single 1000 x 1080 SVG viewBox. Nothing is hand-placed
 * twice - pipe paths and button positions are derived from the vat grid below.
 */
(function (root) {
  'use strict';

  var CONFIG = {
    vatCapacity: 100,          // gallons, vats 1-9
    reservoirCapacity: 1000,   // gallons, vat 10
    maxInletRate: 12,          // gal/s
    maxPumpRate: 12,           // gal/s
    rateStep: 0.5,             // gal/s
    defaultPumpRate: 5,        // gal/s a pump starts configured at
    dryGrace: 2.0,             // seconds a pump may starve before the run fails
    starveVisualDelay: 0.15,   // seconds before starvation is shown, hides blips
    warnFraction: 0.85,        // vats show a warning band above this
    simHz: 60
  };

  // --- vat grid -----------------------------------------------------------
  var COL_X = [200, 500, 800];      // column centres
  var ROW_Y = [80, 370, 660];       // row tops
  var VAT_W = 160;
  var VAT_H = 170;
  var PORT_DX = 55;                 // diagonal ports sit this far off centre
  var LATERAL_INSET = 22;           // laterals are drawn this far above the floor
  var BUTTON_W = 54;
  var BUTTON_H = 30;
  var DIAGONAL_T = 0.28;            // keeps crossing pairs clear of each other

  var RESERVOIR = { x: 100, y: 930, w: 800, h: 140 };
  var INLET_TOP = 8;

  function makeVat(n) {
    var row = Math.floor((n - 1) / 3);
    var col = (n - 1) % 3;
    var cx = COL_X[col];
    return {
      id: 'V' + n,
      label: 'Vat ' + n,
      row: row,
      col: col,
      x: cx - VAT_W / 2,
      y: ROW_Y[row],
      w: VAT_W,
      h: VAT_H,
      cx: cx,
      top: ROW_Y[row],
      bottom: ROW_Y[row] + VAT_H,
      capacity: CONFIG.vatCapacity
    };
  }

  var vats = [];
  for (var n = 1; n <= 9; n++) vats.push(makeVat(n));

  vats.push({
    id: 'V10',
    label: 'Vat 10',
    row: 3,
    col: 1,
    x: RESERVOIR.x,
    y: RESERVOIR.y,
    w: RESERVOIR.w,
    h: RESERVOIR.h,
    cx: RESERVOIR.x + RESERVOIR.w / 2,
    top: RESERVOIR.y,
    bottom: RESERVOIR.y + RESERVOIR.h,
    capacity: CONFIG.reservoirCapacity,
    reservoir: true
  });

  var vatById = {};
  vats.forEach(function (v) { vatById[v.id] = v; });

  // --- pump wiring --------------------------------------------------------
  // [id, source, destination, kind]. Flow is always downward or left-to-right,
  // which keeps the plumbing a DAG - no loops to stabilise.
  var PUMP_DEFS = [
    ['P1',  'V1', 'V4',  'vertical'],
    ['P2',  'V2', 'V5',  'vertical'],
    ['P3',  'V3', 'V6',  'vertical'],
    ['P4',  'V4', 'V7',  'vertical'],
    ['P5',  'V5', 'V8',  'vertical'],
    ['P6',  'V6', 'V9',  'vertical'],
    ['P7',  'V7', 'V10', 'outlet'],
    ['P8',  'V8', 'V10', 'outlet'],
    ['P9',  'V9', 'V10', 'outlet'],
    ['P10', 'V1', 'V2',  'lateral'],
    ['P11', 'V1', 'V5',  'diagonal'],
    ['P12', 'V2', 'V4',  'diagonal'],
    ['P13', 'V2', 'V3',  'lateral'],
    ['P14', 'V2', 'V6',  'diagonal'],
    ['P15', 'V3', 'V5',  'diagonal'],
    ['P16', 'V4', 'V5',  'lateral'],
    ['P17', 'V5', 'V6',  'lateral'],
    ['P18', 'V4', 'V8',  'diagonal'],
    ['P19', 'V5', 'V7',  'diagonal'],
    ['P20', 'V5', 'V9',  'diagonal'],
    ['P21', 'V6', 'V8',  'diagonal'],
    ['P22', 'V7', 'V8',  'lateral'],
    ['P23', 'V8', 'V9',  'lateral']
  ];

  function lerp(a, b, t) { return a + (b - a) * t; }

  function geometryFor(kind, src, dst) {
    var a, b, dir;

    if (kind === 'vertical') {
      a = { x: src.cx, y: src.bottom };
      b = { x: dst.cx, y: dst.top };
    } else if (kind === 'outlet') {
      a = { x: src.cx, y: src.bottom };
      b = { x: src.cx, y: dst.top };
    } else if (kind === 'lateral') {
      var y = src.bottom - LATERAL_INSET;
      a = { x: src.x + src.w, y: y };
      b = { x: dst.x, y: y };
    } else { // diagonal
      dir = dst.col > src.col ? 1 : -1;
      a = { x: src.cx + dir * PORT_DX, y: src.bottom };
      b = { x: dst.cx - dir * PORT_DX, y: dst.top };
    }

    var t = kind === 'diagonal' ? DIAGONAL_T : 0.5;
    return {
      x1: a.x, y1: a.y, x2: b.x, y2: b.y,
      path: 'M ' + a.x + ' ' + a.y + ' L ' + b.x + ' ' + b.y,
      length: Math.sqrt((b.x - a.x) * (b.x - a.x) + (b.y - a.y) * (b.y - a.y)),
      buttonX: lerp(a.x, b.x, t),
      buttonY: lerp(a.y, b.y, t)
    };
  }

  var pumps = PUMP_DEFS.map(function (def) {
    var src = vatById[def[1]];
    var dst = vatById[def[2]];
    var geom = geometryFor(def[3], src, dst);
    return {
      id: def[0],
      src: def[1],
      dst: def[2],
      kind: def[3],
      path: geom.path,
      length: geom.length,
      buttonX: geom.buttonX,
      buttonY: geom.buttonY,
      description: src.label + ' → ' + dst.label
    };
  });

  // --- inlets -------------------------------------------------------------
  var INLET_NAMES = ['A', 'B', 'C'];
  var inlets = ['V1', 'V2', 'V3'].map(function (target, i) {
    var vat = vatById[target];
    return {
      id: 'IN' + (i + 1),
      name: 'Inlet ' + INLET_NAMES[i],
      target: target,
      path: 'M ' + vat.cx + ' ' + INLET_TOP + ' L ' + vat.cx + ' ' + vat.top,
      length: vat.top - INLET_TOP,
      description: 'Inlet ' + INLET_NAMES[i] + ' → ' + vat.label
    };
  });

  root.WaterWorks = root.WaterWorks || {};
  root.WaterWorks.LEVEL1 = {
    name: 'Level 1 — Three Feeds',
    config: CONFIG,
    view: { width: 1000, height: 1080 },
    button: { w: BUTTON_W, h: BUTTON_H },
    vats: vats,
    vatById: vatById,
    pumps: pumps,
    inlets: inlets
  };
})(typeof window !== 'undefined' ? window : globalThis);
