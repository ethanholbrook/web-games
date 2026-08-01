/*
 * Water Works - rendering, input and the frame loop.
 *
 * The SVG scene is built once from level1.js and cached by id; every frame only
 * mutates attributes on existing nodes, never creates them. Simulation runs on a
 * fixed-timestep accumulator so play is identical at 30fps and 144fps.
 */
(function () {
  'use strict';

  var W = window.WaterWorks;
  var LEVEL = W.LEVEL1;
  var CFG = LEVEL.config;
  var SVG_NS = 'http://www.w3.org/2000/svg';

  var SIM_DT = 1 / CFG.simHz;
  var MAX_STEPS_PER_FRAME = 15;
  var DASH_UNITS_PER_GALLON = 3.2;
  var BEST_TIME_KEY = 'waterworks.level1.best';

  var game = W.createGame(LEVEL);
  var scene = document.getElementById('scene');
  var nodes = { vats: {}, pumps: {}, inlets: [] };
  var inspector = { pumpId: null, refs: null };
  var selectedId = null;
  var acc = 0;
  var lastTs = 0;
  var reducedMotion = window.matchMedia
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false;

  // ------------------------------------------------------------ utilities

  function svg(tag, attrs) {
    var node = document.createElementNS(SVG_NS, tag);
    for (var key in attrs) {
      if (Object.prototype.hasOwnProperty.call(attrs, key)) node.setAttribute(key, attrs[key]);
    }
    return node;
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /* Cached setters - the frame loop calls these on every node, every frame. */
  function setAttr(node, name, value) {
    var key = '__a_' + name;
    if (node[key] !== value) {
      node[key] = value;
      node.setAttribute(name, value);
    }
  }

  function setClass(node, value) {
    if (node.__cls !== value) {
      node.__cls = value;
      node.setAttribute('class', value);
    }
  }

  function setText(node, value) {
    if (node.__txt !== value) {
      node.__txt = value;
      node.textContent = value;
    }
  }

  function fmtTime(seconds) {
    var mins = Math.floor(seconds / 60);
    var rest = seconds - mins * 60;
    return mins + ':' + (rest < 10 ? '0' : '') + rest.toFixed(1);
  }

  function fmtRate(gps) { return gps.toFixed(1) + ' gal/s'; }

  function readBestTime() {
    try {
      var raw = window.localStorage.getItem(BEST_TIME_KEY);
      return raw === null ? null : parseFloat(raw);
    } catch (err) { return null; }
  }

  function writeBestTime(seconds) {
    try { window.localStorage.setItem(BEST_TIME_KEY, String(seconds)); } catch (err) { /* private mode */ }
  }

  // -------------------------------------------------------------- building

  function buildScene() {
    var layerPipes = svg('g', {});
    var layerVats = svg('g', {});
    var layerPumps = svg('g', {});

    LEVEL.inlets.forEach(function (inlet) {
      layerPipes.appendChild(svg('path', { d: inlet.path, class: 'pipe-base' }));
      var flow = svg('path', { d: inlet.path, class: 'pipe-flow inlet-flow' });
      layerPipes.appendChild(flow);
      nodes.inlets.push({ def: inlet, flow: flow, dash: 0 });
    });

    LEVEL.pumps.forEach(function (pump) {
      layerPipes.appendChild(svg('path', { d: pump.path, class: 'pipe-base' }));
      var flow = svg('path', { d: pump.path, class: 'pipe-flow' });
      layerPipes.appendChild(flow);
      nodes.pumps[pump.id] = { def: pump, flow: flow, dash: 0 };
    });

    LEVEL.vats.forEach(function (vat) {
      var group = svg('g', {});
      var isRes = !!vat.reservoir;

      group.appendChild(svg('rect', { class: 'vat-back', x: vat.x, y: vat.y, width: vat.w, height: vat.h }));

      var fill = svg('rect', {
        class: 'vat-fill', x: vat.x + 2, y: vat.y + vat.h, width: vat.w - 4, height: 0
      });
      group.appendChild(fill);

      // Overflow threshold, drawn as edge ticks so it never crosses the label.
      if (!isRes) {
        var warnY = vat.y + vat.h * (1 - CFG.warnFraction);
        [[vat.x, vat.x + 30], [vat.x + vat.w - 30, vat.x + vat.w]].forEach(function (span) {
          group.appendChild(svg('line', {
            class: 'vat-warnline', x1: span[0], y1: warnY, x2: span[1], y2: warnY
          }));
        });
      }

      var body = svg('rect', { class: 'vat-body', x: vat.x, y: vat.y, width: vat.w, height: vat.h });
      group.appendChild(body);

      var label = svg('text', {
        class: 'vat-label' + (isRes ? ' reservoir-label' : ''),
        x: vat.cx, y: vat.y + (isRes ? 44 : 28)
      });
      label.textContent = isRes ? 'Vat 10' : 'V' + vat.id.slice(1);
      group.appendChild(label);

      var reading = svg('text', {
        class: 'vat-reading' + (isRes ? ' reservoir-reading' : ''),
        x: vat.cx, y: vat.y + vat.h - (isRes ? 44 : 24)
      });
      group.appendChild(reading);

      layerVats.appendChild(group);
      nodes.vats[vat.id] = { def: vat, fill: fill, body: body, reading: reading };
    });

    LEVEL.pumps.forEach(function (pump) {
      var bw = LEVEL.button.w;
      var bh = LEVEL.button.h;
      var group = svg('g', { class: 'pump', tabindex: '0', role: 'button' });

      group.appendChild(svg('rect', {
        class: 'pump-box', x: pump.buttonX - bw / 2, y: pump.buttonY - bh / 2,
        width: bw, height: bh, rx: 6
      }));

      var label = svg('text', { class: 'pump-label', x: pump.buttonX, y: pump.buttonY - 4 });
      label.textContent = pump.id;
      group.appendChild(label);

      var rate = svg('text', { class: 'pump-rate', x: pump.buttonX, y: pump.buttonY + 8 });
      group.appendChild(rate);

      wirePump(group, pump.id);
      layerPumps.appendChild(group);
      nodes.pumps[pump.id].group = group;
      nodes.pumps[pump.id].rateText = rate;
    });

    scene.appendChild(layerPipes);
    scene.appendChild(layerVats);
    scene.appendChild(layerPumps);
  }

  function wirePump(group, id) {
    group.addEventListener('click', function (event) {
      if (event.shiftKey) { select(id); return; }
      game.togglePump(id);
      select(id);
    });

    group.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
        event.preventDefault();
        game.togglePump(id);
        select(id);
      } else if (event.key === 'ArrowUp' || event.key === 'ArrowRight') {
        event.preventDefault();
        nudgeRate(id, 1);
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') {
        event.preventDefault();
        nudgeRate(id, -1);
      }
    });

    group.addEventListener('wheel', function (event) {
      event.preventDefault();
      nudgeRate(id, event.deltaY < 0 ? 1 : -1);
      select(id);
    }, { passive: false });

    group.addEventListener('focus', function () { select(id); });
  }

  function nudgeRate(id, direction) {
    game.setPumpRate(id, game.pumps[id].rate + direction * CFG.rateStep);
    select(id);
  }

  function buildInletControls() {
    var host = document.getElementById('inlet-list');
    host.textContent = '';

    game.inlets.forEach(function (inlet, index) {
      var wrap = el('div', 'control');
      var head = el('div', 'control-head');
      head.appendChild(el('strong', null, inlet.description));
      var value = el('span', 'tabular', fmtRate(inlet.rate));
      head.appendChild(value);
      wrap.appendChild(head);

      var slider = document.createElement('input');
      slider.type = 'range';
      slider.min = '0';
      slider.max = String(CFG.maxInletRate);
      slider.step = String(CFG.rateStep);
      slider.value = String(inlet.rate);
      slider.setAttribute('aria-label', inlet.description + ' rate, gallons per second');
      slider.addEventListener('input', function () {
        game.setInletRate(index, parseFloat(slider.value));
        value.textContent = fmtRate(game.inlets[index].rate);
      });

      wrap.appendChild(slider);
      host.appendChild(wrap);
      nodes.inlets[index].slider = slider;
      nodes.inlets[index].valueText = value;
    });
  }

  // ------------------------------------------------------------- inspector

  function select(id) {
    if (selectedId === id) return;
    selectedId = id;
    buildInspector();
  }

  function buildInspector() {
    var host = document.getElementById('inspector');
    host.textContent = '';
    inspector.pumpId = selectedId;
    inspector.refs = null;

    if (!selectedId) {
      host.appendChild(el('p', 'inspector-empty',
        'Click a pump in the diagram to switch it on and tune its rate. ' +
        'Shift-click selects without toggling; the scroll wheel adjusts a rate in place.'));
      return;
    }

    var pump = game.pumps[selectedId];
    var title = el('div', 'inspector-title');
    title.appendChild(el('b', null, pump.id));
    title.appendChild(el('span', null, pump.description));
    host.appendChild(title);

    var state = el('span', 'inspector-state', 'Off');
    host.appendChild(state);

    var toggle = el('button', 'btn', 'Turn on');
    toggle.type = 'button';
    toggle.addEventListener('click', function () { game.togglePump(selectedId); });
    host.appendChild(toggle);

    var head = el('div', 'control-head');
    head.appendChild(el('strong', null, 'Rate'));
    var rateValue = el('span', 'tabular', fmtRate(pump.rate));
    head.appendChild(rateValue);
    host.appendChild(head);

    var slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = String(CFG.maxPumpRate);
    slider.step = String(CFG.rateStep);
    slider.value = String(pump.rate);
    slider.setAttribute('aria-label', pump.id + ' rate, gallons per second');
    slider.addEventListener('input', function () {
      game.setPumpRate(selectedId, parseFloat(slider.value));
    });
    host.appendChild(slider);

    var stats = el('div', 'inspector-stats');
    var refs = { state: state, toggle: toggle, slider: slider, rateValue: rateValue };
    [['Actual flow', 'flow'], ['Source level', 'srcLevel'], ['Destination level', 'dstLevel']]
      .forEach(function (pair) {
        stats.appendChild(el('span', null, pair[0]));
        refs[pair[1]] = el('b', 'tabular', '—');
        stats.appendChild(refs[pair[1]]);
      });
    host.appendChild(stats);

    inspector.refs = refs;
  }

  function renderInspector() {
    var refs = inspector.refs;
    if (!refs || !inspector.pumpId) return;

    var pump = game.pumps[inspector.pumpId];
    var showStarving = pump.starving && pump.starveTimer > CFG.starveVisualDelay;

    setText(refs.state, showStarving ? 'Starving' : pump.on ? 'Pumping' : 'Off');
    refs.state.className = 'inspector-state' + (showStarving ? ' is-starving' : pump.on ? ' is-on' : '');
    setText(refs.toggle, pump.on ? 'Turn off' : 'Turn on');

    if (parseFloat(refs.slider.value) !== pump.rate) refs.slider.value = String(pump.rate);
    setText(refs.rateValue, fmtRate(pump.rate));

    setText(refs.flow, fmtRate(pump.on ? pump.flow : 0));
    setText(refs.srcLevel, game.vats[pump.src].level.toFixed(1) + ' gal');
    setText(refs.dstLevel, game.vats[pump.dst].level.toFixed(1) + ' gal');
  }

  // ---------------------------------------------------------------- render

  function render(realDt) {
    var failure = game.failure;
    var over = game.isOver();

    LEVEL.vats.forEach(function (def) {
      var node = nodes.vats[def.id];
      var vat = game.vats[def.id];
      var frac = Math.max(0, Math.min(1, vat.level / vat.capacity));
      var height = (def.h - 4) * frac;

      setAttr(node.fill, 'y', (def.y + def.h - 2 - height).toFixed(2));
      setAttr(node.fill, 'height', height.toFixed(2));
      setClass(node.fill, 'vat-fill' + (!vat.reservoir && frac >= CFG.warnFraction ? ' is-warn' : ''));

      var failedHere = failure && failure.targetId === def.id;
      setClass(node.body, 'vat-body' + (failedHere ? ' is-failed' : ''));

      setText(node.reading, vat.reservoir
        ? Math.floor(frac * 100) + '%  ·  ' + Math.round(vat.level) + ' / ' + vat.capacity + ' gal'
        : vat.level.toFixed(1) + ' / ' + vat.capacity);
    });

    LEVEL.pumps.forEach(function (def) {
      var node = nodes.pumps[def.id];
      var pump = game.pumps[def.id];
      var showStarving = pump.starving && pump.starveTimer > CFG.starveVisualDelay;
      var failedHere = failure && failure.targetId === def.id;
      var flowing = pump.on && pump.flow > 1e-6;

      setClass(node.group, 'pump'
        + (pump.on ? ' is-on' : '')
        + (showStarving ? ' is-starving' : '')
        + (failedHere ? ' is-failed' : '')
        + (selectedId === def.id ? ' is-selected' : ''));

      setText(node.rateText, pump.rate.toFixed(1));
      setClass(node.flow, 'pipe-flow'
        + (flowing ? ' is-flowing' : '')
        + (showStarving ? ' is-starving' : ''));

      if (flowing && !reducedMotion) {
        node.dash = (node.dash - pump.flow * DASH_UNITS_PER_GALLON * realDt) % 1000;
        setAttr(node.flow, 'stroke-dashoffset', node.dash.toFixed(1));
      }

      var aria = def.id + ', ' + def.description + ', '
        + (pump.on ? 'on' : 'off') + ', rate ' + pump.rate.toFixed(1) + ' gallons per second';
      if (node.group.__aria !== aria) {
        node.group.__aria = aria;
        node.group.setAttribute('aria-label', aria);
      }
    });

    nodes.inlets.forEach(function (node, index) {
      var inlet = game.inlets[index];
      var flowing = inlet.rate > 0 && game.status === 'RUNNING';
      setClass(node.flow, 'pipe-flow inlet-flow' + (flowing ? ' is-flowing' : ''));
      if (flowing && !reducedMotion) {
        node.dash = (node.dash - inlet.rate * DASH_UNITS_PER_GALLON * realDt) % 1000;
        setAttr(node.flow, 'stroke-dashoffset', node.dash.toFixed(1));
      }
    });

    var progress = game.progress();
    var progressPct = Math.floor(progress * 100);
    document.getElementById('hud-progress-fill').style.width = (progress * 100).toFixed(2) + '%';
    setText(document.getElementById('hud-progress-label'), progressPct + '%');
    document.getElementById('hud-progress').setAttribute('aria-valuenow', String(progressPct));
    setText(document.getElementById('hud-time'), fmtTime(game.elapsed));
    setText(document.getElementById('hud-inflow'), fmtRate(game.totalInflow()));
    setText(document.getElementById('hud-outflow'), fmtRate(game.reservoirInflow()));

    var statusNode = document.getElementById('hud-status');
    var statusText = { IDLE: 'Ready', RUNNING: 'Running', PAUSED: 'Paused', WON: 'Complete', LOST: 'Failed' };
    setText(statusNode, statusText[game.status]);
    statusNode.className = 'hud-value'
      + (game.status === 'WON' ? ' is-won' : game.status === 'LOST' ? ' is-lost'
        : game.status === 'RUNNING' ? ' is-running' : '');

    var startBtn = document.getElementById('btn-start');
    setText(startBtn, game.status === 'RUNNING' ? 'Pause' : game.status === 'PAUSED' ? 'Resume' : 'Start');
    startBtn.disabled = over;

    renderInspector();
  }

  // ------------------------------------------------------------ frame loop

  function frame(ts) {
    window.requestAnimationFrame(frame);

    if (lastTs === 0) lastTs = ts;
    var realDt = (ts - lastTs) / 1000;
    lastTs = ts;
    if (realDt > 0.25) realDt = 0.25;
    if (realDt < 0) realDt = 0;

    if (game.status === 'RUNNING') {
      acc += realDt;
      var steps = 0;
      while (acc >= SIM_DT && steps < MAX_STEPS_PER_FRAME && game.status === 'RUNNING') {
        game.step(SIM_DT);
        acc -= SIM_DT;
        steps++;
      }
      if (acc > SIM_DT * MAX_STEPS_PER_FRAME) acc = 0;
      if (game.isOver()) showResult();
    }

    render(realDt);
  }

  // ----------------------------------------------------------------- modal

  var modal = document.getElementById('modal');

  function openModal(title, buildBody, actions) {
    document.getElementById('modal-title').textContent = title;
    var body = document.getElementById('modal-body');
    body.textContent = '';
    buildBody(body);

    var actionHost = document.getElementById('modal-actions');
    actionHost.textContent = '';
    actions.forEach(function (spec) {
      var button = el('button', 'btn' + (spec.primary ? ' btn-primary' : ''), spec.label);
      button.type = 'button';
      button.addEventListener('click', spec.onClick);
      actionHost.appendChild(button);
    });

    modal.hidden = false;
    var first = actionHost.querySelector('button');
    if (first) first.focus();
  }

  function closeModal() { modal.hidden = true; }

  function showHelp() {
    var wasRunning = game.status === 'RUNNING';
    if (wasRunning) game.pause();

    openModal('How to Play', function (body) {
      body.appendChild(el('p', null,
        'Three inlets feed vats 1, 2 and 3. Twenty-three pumps move water down and across the grid. ' +
        'Fill Vat 10 to 100% to finish the level.'));

      var rules = el('ul');
      [
        'Open the inlet sliders first — a pump with nothing to draw from will fail.',
        'Click a pump button to switch it on or off. Shift-click selects it without toggling.',
        'Tune the selected pump with the inspector slider, the scroll wheel over its button, or the arrow keys.',
        'Vats 1–9 hold 100 gallons. Let one hit 100% and the run ends.',
        'A pump that cannot draw its full rate pulses amber. You have ' + CFG.dryGrace.toFixed(0) +
          ' seconds to feed it before it runs dry and the run ends.',
        'A stable plant is one where every vat’s inflow matches its outflow.'
      ].forEach(function (text) { rules.appendChild(el('li', null, text)); });
      body.appendChild(rules);

      var kbd = el('p');
      kbd.appendChild(document.createTextNode('Keyboard: '));
      kbd.appendChild(el('kbd', null, 'Tab'));
      kbd.appendChild(document.createTextNode(' to a pump, '));
      kbd.appendChild(el('kbd', null, 'Space'));
      kbd.appendChild(document.createTextNode(' to toggle, '));
      kbd.appendChild(el('kbd', null, '↑'));
      kbd.appendChild(document.createTextNode(' / '));
      kbd.appendChild(el('kbd', null, '↓'));
      kbd.appendChild(document.createTextNode(' to change its rate.'));
      body.appendChild(kbd);

      body.appendChild(el('p', null,
        'Stuck? Set all three inlets to 10 gal/s, then bring on P1–P3, P4–P6 and P7–P9 at 10 gal/s each, ' +
        'roughly five seconds apart.'));
    }, [
      { label: wasRunning ? 'Resume' : 'Close', primary: true, onClick: function () {
        closeModal();
        if (wasRunning) game.start();
      } }
    ]);
  }

  function failureExplanation(failure) {
    if (!failure) return '';
    if (failure.kind === 'OVERFLOW') {
      return failure.label + ' overflowed. It reached 100% while still taking on more water than it '
        + 'was sending out.';
    }
    var pump = game.pumps[failure.targetId];
    return pump.id + ' ran dry. Its source could not supply the ' + fmtRate(pump.rate)
      + ' it was asking for (' + pump.description + ') for more than ' + CFG.dryGrace.toFixed(0)
      + ' seconds.';
  }

  function showResult() {
    var won = game.status === 'WON';
    var best = null;

    if (won) {
      var previous = readBestTime();
      if (previous === null || game.elapsed < previous) {
        writeBestTime(game.elapsed);
        best = 'New best time.';
      } else {
        best = 'Best time: ' + fmtTime(previous) + '.';
      }
    }

    openModal(won ? 'Level Complete' : 'Run Failed', function (body) {
      var headline = el('p', 'result-headline ' + (won ? 'is-won' : 'is-lost'),
        won ? 'Vat 10 filled in ' + fmtTime(game.elapsed) : failureExplanation(game.failure));
      body.appendChild(headline);

      if (won && best) body.appendChild(el('p', null, best));
      if (!won) {
        body.appendChild(el('p', null, 'Vat 10 reached ' + Math.floor(game.progress() * 100)
          + '% after ' + fmtTime(game.elapsed) + '.'));
      }
    }, [
      { label: 'Close', onClick: closeModal },
      { label: 'New Game', primary: true, onClick: function () { closeModal(); newGame(); } }
    ]);
  }

  // --------------------------------------------------------------- actions

  function newGame() {
    game.reset();
    acc = 0;
    selectedId = null;
    buildInletControls();
    buildInspector();
    closeModal();
  }

  function toggleRun() {
    if (game.status === 'RUNNING') game.pause();
    else game.start();
  }

  document.getElementById('btn-new').addEventListener('click', newGame);
  document.getElementById('btn-start').addEventListener('click', toggleRun);
  document.getElementById('btn-help').addEventListener('click', showHelp);

  modal.addEventListener('click', function (event) {
    if (event.target === modal) closeModal();
  });

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && !modal.hidden) closeModal();
  });

  // Losing a run because the tab was in the background would not be fair.
  document.addEventListener('visibilitychange', function () {
    if (document.hidden && game.status === 'RUNNING') game.pause();
  });

  document.getElementById('level-name').textContent = LEVEL.name;

  buildScene();
  buildInletControls();
  buildInspector();
  window.requestAnimationFrame(frame);
})();
