/*
 * Water Works - level definitions.
 *
 * Pure data. Geometry is derived by geometry.js, and every puzzle level's `par`
 * is checked against the solver by tests/levels.test.js, so a level that is not
 * actually winnable cannot ship.
 *
 * Puzzle levels have fixed rates on every pipe and are played entirely with the
 * pump switches. Sandbox is the original free-play plant, where the rates are
 * yours to set.
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
      par: 1,
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
      par: 2,
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
      par: 5,
      name: 'Even Split',
      blurb: 'Six in means six out. Anything less and the vat fills up.',
      cols: 2, rows: 2,
      vats: [vat('V1', 0, 0, 40), vat('V2', 1, 0, 40), vat('V3', 0, 1, 40), vat('V4', 1, 1, 40)],
      reservoir: { capacity: 300 },
      inlets: [inlet('V1', 6)],
      pumps: [
        pump('P1', 'V1', 'V3', 4), pump('P2', 'V1', 'V2', 2),
        pump('P3', 'V3', 'R', 4), pump('P4', 'V2', 'V4', 2), pump('P5', 'V4', 'R', 2)
      ]
    },

    {
      id: 'l4',
      par: 2,
      name: 'The Decoy',
      blurb: 'Not every pump belongs on. One route here is a trap.',
      cols: 2, rows: 2,
      vats: [vat('V1', 0, 0, 40), vat('V2', 1, 0, 40), vat('V3', 0, 1, 40), vat('V4', 1, 1, 40)],
      reservoir: { capacity: 300 },
      inlets: [inlet('V1', 6)],
      pumps: [
        pump('P1', 'V1', 'V3', 6), pump('P2', 'V1', 'V2', 3),
        pump('P3', 'V3', 'R', 6), pump('P4', 'V2', 'V4', 3), pump('P5', 'V4', 'R', 3)
      ]
    },

    {
      id: 'l5',
      par: 1,
      name: 'Reserve',
      blurb: 'This pump wants more than the inlet delivers. Let the vat fill first.',
      cols: 1, rows: 1,
      vats: [vat('V1', 0, 0, 60)],
      reservoir: { capacity: 40 },
      inlets: [inlet('V1', 2)],
      pumps: [pump('P1', 'V1', 'R', 8)]
    },

    {
      id: 'l6',
      par: 7,
      name: 'Crossfeed',
      blurb: 'The middle vat has no inlet of its own. Feed it sideways.',
      cols: 3, rows: 2,
      vats: [
        vat('V1', 0, 0, 40), vat('V2', 1, 0, 40), vat('V3', 2, 0, 40),
        vat('V4', 0, 1, 40), vat('V5', 1, 1, 40), vat('V6', 2, 1, 40)
      ],
      reservoir: { capacity: 400 },
      inlets: [inlet('V1', 7), inlet('V3', 5)],
      pumps: [
        pump('P1', 'V1', 'V4', 4), pump('P2', 'V1', 'V2', 3),
        pump('P3', 'V2', 'V5', 3), pump('P4', 'V3', 'V6', 5),
        pump('P5', 'V4', 'R', 4), pump('P6', 'V5', 'R', 3), pump('P7', 'V6', 'R', 5)
      ]
    },

    {
      id: 'l7',
      par: 8,
      name: 'Uneven Supply',
      blurb: 'One column gets far more than it can carry. Share the load.',
      cols: 3, rows: 2,
      vats: [
        vat('V1', 0, 0, 50), vat('V2', 1, 0, 50), vat('V3', 2, 0, 50),
        vat('V4', 0, 1, 50), vat('V5', 1, 1, 50), vat('V6', 2, 1, 50)
      ],
      reservoir: { capacity: 420 },
      inlets: [inlet('V1', 10), inlet('V3', 2)],
      pumps: [
        pump('P1', 'V1', 'V4', 4), pump('P2', 'V1', 'V2', 6),
        pump('P3', 'V2', 'V5', 4), pump('P4', 'V2', 'V3', 2),
        pump('P5', 'V3', 'V6', 4), pump('P6', 'V1', 'V5', 3),
        pump('P7', 'V4', 'R', 4), pump('P8', 'V5', 'R', 4), pump('P9', 'V6', 'R', 4)
      ]
    },

    {
      id: 'l8',
      par: 10,
      name: 'Full Plant',
      blurb: 'Three rows, two feeds, and only one set of switches that balances.',
      cols: 3, rows: 3,
      vats: [
        vat('V1', 0, 0, 40), vat('V2', 1, 0, 40), vat('V3', 2, 0, 40),
        vat('V4', 0, 1, 40), vat('V5', 1, 1, 40), vat('V6', 2, 1, 40),
        vat('V7', 0, 2, 40), vat('V8', 1, 2, 40), vat('V9', 2, 2, 40)
      ],
      reservoir: { capacity: 480 },
      inlets: [inlet('V1', 8), inlet('V3', 4)],
      pumps: [
        pump('P1', 'V1', 'V4', 5), pump('P2', 'V1', 'V2', 3),
        pump('P3', 'V2', 'V5', 3), pump('P4', 'V3', 'V6', 4),
        pump('P5', 'V4', 'V7', 5), pump('P6', 'V5', 'V8', 3), pump('P7', 'V6', 'V9', 4),
        pump('P8', 'V7', 'R', 5), pump('P9', 'V8', 'R', 3), pump('P10', 'V9', 'R', 4)
      ]
    },

    {
      id: 'l9',
      par: 6,
      name: 'Against the Clock',
      blurb: 'The steady route is too slow. Find the one that moves more water.',
      cols: 3, rows: 2,
      timeLimit: 70,
      vats: [
        vat('V1', 0, 0, 60), vat('V2', 1, 0, 60), vat('V3', 2, 0, 60),
        vat('V4', 0, 1, 60), vat('V5', 1, 1, 60), vat('V6', 2, 1, 60)
      ],
      reservoir: { capacity: 480 },
      inlets: [inlet('V1', 6), inlet('V2', 6), inlet('V3', 6)],
      pumps: [
        pump('P1', 'V1', 'V4', 6), pump('P2', 'V2', 'V5', 6), pump('P3', 'V3', 'V6', 6),
        pump('P4', 'V1', 'V5', 3), pump('P5', 'V3', 'V5', 3),
        pump('P6', 'V4', 'R', 6), pump('P7', 'V5', 'R', 8), pump('P8', 'V6', 'R', 6)
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
