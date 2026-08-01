/*
 * Water Works - level definitions.
 *
 * Pure data. Geometry is derived by geometry.js, and every level's targetTime
 * is checked against the solver by tests/levels.test.js, so a level that is not
 * winnable - or whose target is not achievable - cannot ship.
 *
 * Puzzle levels have fixed rates on every pipe and are played entirely with the
 * pump switches; the score is the clock. From l4 onwards none of them has a
 * steady state: every route to the reservoir outruns its own supply, so pumps
 * have to be cycled rather than set once and left. tests/levels.test.js enforces
 * that. Sandbox is the original free-play plant, where the rates are yours.
 */
(function (root) {
  'use strict';

  /** "V1 0,0 40" -> a vat at column 0, row 0 holding 40 gallons. */
  function vat(id, col, row, capacity, start) {
    return { id: id, col: col, row: row, capacity: capacity, start: start || 0 };
  }

  /** "P1 V1>V4 @5" -> a pump moving 5 gal/s from V1 to V4. */
  function pump(id, src, dst, rate) {
    return { id: id, src: src, dst: dst, rate: rate };
  }

  function inlet(target, rate) {
    return { target: target, rate: rate };
  }

  // ------------------------------------------------------------- campaign

  var CAMPAIGN = [
    {
      id: 'l1',
      targetTime: 10.5,
      name: 'First Draw',
      blurb: 'Water is already arriving. Send it on.',
      cols: 1, rows: 1,
      vats: [vat('V1', 0, 0, 40)],
      reservoir: { capacity: 60 },
      inlets: [inlet('V1', 6)],
      pumps: [pump('P1', 'V1', 'R', 6)]
    },

    {
      id: 'l2',
      targetTime: 15.5,
      name: 'Downstream',
      blurb: 'A pump with nothing to draw from runs dry. Mind the order.',
      cols: 1, rows: 2,
      vats: [vat('V1', 0, 0, 40), vat('V2', 0, 1, 40)],
      reservoir: { capacity: 90 },
      inlets: [inlet('V1', 6)],
      pumps: [pump('P1', 'V1', 'V2', 6), pump('P2', 'V2', 'R', 6)]
    },

    {
      id: 'l3',
      targetTime: 17,
      name: 'Overdraw',
      blurb: 'This pump wants three times what the inlet delivers. Let the vat fill first.',
      cols: 1, rows: 1,
      vats: [vat('V1', 0, 0, 40)],
      reservoir: { capacity: 50 },
      inlets: [inlet('V1', 3)],
      pumps: [pump('P1', 'V1', 'R', 9)]
    },

    {
      id: 'l4',
      targetTime: 51,
      name: 'Duty Cycle',
      blurb: 'One tankful is not enough. Run it, refill it, run it again.',
      cols: 1, rows: 1,
      vats: [vat('V1', 0, 0, 40)],
      reservoir: { capacity: 150 },
      inlets: [inlet('V1', 3)],
      pumps: [pump('P1', 'V1', 'R', 9)]
    },

    {
      id: 'l5',
      targetTime: 34,
      name: 'Trickle and Surge',
      blurb: 'The steady pump alone will overfill the vat. Dump the surplus.',
      cols: 1, rows: 1,
      vats: [vat('V1', 0, 0, 50)],
      reservoir: { capacity: 200 },
      inlets: [inlet('V1', 6)],
      pumps: [pump('P1', 'V1', 'R', 4), pump('P2', 'V1', 'R', 10)]
    },

    {
      id: 'l6',
      targetTime: 34.5,
      name: 'Two Stages',
      blurb: 'Both pumps outrun their supply. Now they have to take turns.',
      cols: 1, rows: 2,
      vats: [vat('V1', 0, 0, 40), vat('V2', 0, 1, 30)],
      reservoir: { capacity: 150 },
      inlets: [inlet('V1', 5)],
      pumps: [pump('P1', 'V1', 'V2', 12), pump('P2', 'V2', 'R', 12)]
    },

    {
      id: 'l7',
      targetTime: 41.5,
      name: 'Split Cycle',
      blurb: 'One branch you can leave running. The other you cannot.',
      cols: 2, rows: 2,
      vats: [vat('V1', 0, 0, 50), vat('V2', 1, 0, 40), vat('V3', 0, 1, 40), vat('V4', 1, 1, 40)],
      reservoir: { capacity: 280 },
      inlets: [inlet('V1', 8)],
      pumps: [
        pump('P1', 'V1', 'V3', 12), pump('P2', 'V1', 'V2', 5),
        pump('P3', 'V3', 'R', 12), pump('P4', 'V2', 'V4', 5), pump('P5', 'V4', 'R', 5)
      ]
    },

    {
      id: 'l8',
      targetTime: 36.5,
      name: 'Crossfeed',
      blurb: 'The middle column has no inlet of its own. Feed it sideways, and keep it moving.',
      cols: 3, rows: 2,
      vats: [
        vat('V1', 0, 0, 45), vat('V2', 1, 0, 45), vat('V3', 2, 0, 45),
        vat('V4', 0, 1, 45), vat('V5', 1, 1, 45), vat('V6', 2, 1, 45)
      ],
      reservoir: { capacity: 360 },
      inlets: [inlet('V1', 7), inlet('V3', 5)],
      pumps: [
        pump('P1', 'V1', 'V4', 10), pump('P2', 'V1', 'V2', 4),
        pump('P3', 'V2', 'V5', 9), pump('P4', 'V3', 'V6', 10),
        pump('P5', 'V3', 'V2', 3),
        pump('P6', 'V4', 'R', 10), pump('P7', 'V5', 'R', 9), pump('P8', 'V6', 'R', 10)
      ]
    },

    {
      id: 'l9',
      targetTime: 47,
      name: 'Full Plant',
      blurb: 'Three rows, nothing you can leave alone. Keep every stage turning over.',
      cols: 3, rows: 3,
      vats: [
        vat('V1', 0, 0, 45), vat('V2', 1, 0, 45), vat('V3', 2, 0, 45),
        vat('V4', 0, 1, 45), vat('V5', 1, 1, 45), vat('V6', 2, 1, 45),
        vat('V7', 0, 2, 45), vat('V8', 1, 2, 45), vat('V9', 2, 2, 45)
      ],
      reservoir: { capacity: 420 },
      inlets: [inlet('V1', 6), inlet('V3', 6)],
      pumps: [
        pump('P1', 'V1', 'V4', 10), pump('P2', 'V1', 'V2', 4),
        pump('P3', 'V2', 'V5', 9), pump('P4', 'V3', 'V6', 10),
        pump('P5', 'V3', 'V2', 4),
        pump('P6', 'V4', 'V7', 10), pump('P7', 'V5', 'V8', 9), pump('P8', 'V6', 'V9', 10),
        pump('P9', 'V7', 'R', 10), pump('P10', 'V8', 'R', 9), pump('P11', 'V9', 'R', 10)
      ]
    },

    {
      id: 'l10',
      targetTime: 43,
      name: 'Against the Clock',
      blurb: 'Every drop counts. Waste an inlet and you will not make the deadline.',
      cols: 3, rows: 2,
      timeLimit: 75,
      vats: [
        vat('V1', 0, 0, 50), vat('V2', 1, 0, 50), vat('V3', 2, 0, 50),
        vat('V4', 0, 1, 50), vat('V5', 1, 1, 50), vat('V6', 2, 1, 50)
      ],
      reservoir: { capacity: 480 },
      inlets: [inlet('V1', 5), inlet('V2', 6), inlet('V3', 5)],
      pumps: [
        pump('P1', 'V1', 'V4', 11), pump('P2', 'V2', 'V5', 12), pump('P3', 'V3', 'V6', 11),
        pump('P4', 'V1', 'V5', 4), pump('P5', 'V3', 'V5', 4),
        pump('P6', 'V4', 'R', 11), pump('P7', 'V5', 'R', 12), pump('P8', 'V6', 'R', 11)
      ]
    }
  ];

  // -------------------------------------------------------------- sandbox

  var SANDBOX_PUMPS = [
    ['P1', 'V1', 'V4'], ['P2', 'V2', 'V5'], ['P3', 'V3', 'V6'],
    ['P4', 'V4', 'V7'], ['P5', 'V5', 'V8'], ['P6', 'V6', 'V9'],
    ['P7', 'V7', 'R'], ['P8', 'V8', 'R'], ['P9', 'V9', 'R'],
    ['P10', 'V1', 'V2'], ['P11', 'V1', 'V5'], ['P12', 'V2', 'V4'],
    ['P13', 'V2', 'V3'], ['P14', 'V2', 'V6'], ['P15', 'V3', 'V5'],
    ['P16', 'V4', 'V5'], ['P17', 'V5', 'V6'],
    ['P18', 'V4', 'V8'], ['P19', 'V5', 'V7'], ['P20', 'V5', 'V9'], ['P21', 'V6', 'V8'],
    ['P22', 'V7', 'V8'], ['P23', 'V8', 'V9']
  ];

  var SANDBOX = {
    id: 'sandbox',
    name: 'Sandbox',
    blurb: 'The original plant, with every rate under your control. Nothing to solve — just run it.',
    mode: 'sandbox',
    cols: 3, rows: 3,
    vats: [
      vat('V1', 0, 0, 100), vat('V2', 1, 0, 100), vat('V3', 2, 0, 100),
      vat('V4', 0, 1, 100), vat('V5', 1, 1, 100), vat('V6', 2, 1, 100),
      vat('V7', 0, 2, 100), vat('V8', 1, 2, 100), vat('V9', 2, 2, 100)
    ],
    reservoir: { capacity: 1000, label: 'Vat 10' },
    inlets: [inlet('V1', 0), inlet('V2', 0), inlet('V3', 0)],
    pumps: SANDBOX_PUMPS.map(function (p) { return pump(p[0], p[1], p[2], 5); })
  };

  root.WaterWorks = root.WaterWorks || {};
  root.WaterWorks.CAMPAIGN_SPECS = CAMPAIGN;
  root.WaterWorks.SANDBOX_SPEC = SANDBOX;
  root.WaterWorks.ALL_SPECS = [SANDBOX].concat(CAMPAIGN);

  root.WaterWorks.specById = function (id) {
    var all = root.WaterWorks.ALL_SPECS;
    for (var i = 0; i < all.length; i++) if (all[i].id === id) return all[i];
    return null;
  };
})(typeof window !== 'undefined' ? window : globalThis);
