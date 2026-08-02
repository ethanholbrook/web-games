/*
 * Water Works - screens, rendering and input.
 *
 * Two modes share one renderer. PUZZLE levels have fixed rates printed on the
 * pipes and are played entirely with the pump switches; SANDBOX exposes every
 * rate as a slider. The scene is rebuilt only when the level changes - each
 * frame just mutates attributes on cached nodes.
 *
 * Simulation runs on a fixed-timestep accumulator, so play is identical at
 * 30fps and 144fps, and toggling is allowed while paused: the puzzle is meant
 * to be a thinking problem, not a reflex test.
 */
(function () {
  'use strict';

  var W = window.WaterWorks;
  var SVG_NS = 'http://www.w3.org/2000/svg';
  var MAX_STEPS_PER_FRAME = 15;
  var DASH_UNITS_PER_GALLON = 3.2;
  var PROGRESS_KEY = 'waterworks.progress.v1';

  var GLYPH = { on: '▶', off: '■', starving: '!' };

  // The clock is the score. Targets come from the solver, so gold means matching
  // roughly the best line anyone has found for the level.
  var MEDALS = [
    { id: 'gold', label: 'Gold', mark: '●', factor: 1.15 },
    { id: 'silver', label: 'Silver', mark: '●', factor: 1.45 },
    { id: 'bronze', label: 'Bronze', mark: '●', factor: Infinity }
  ];

  function medalFor(seconds, target) {
    if (!target) return null;
    for (var i = 0; i < MEDALS.length; i++) {
      if (seconds <= target * MEDALS[i].factor) return MEDALS[i];
    }
    return MEDALS[MEDALS.length - 1];
  }

  var level = null;
  var game = null;
  var spec = null;
  var nodes = { vats: {}, pumps: {}, inlets: [] };
  var inspector = { pumpId: null, refs: null };
  var selectedId = null;
  var acc = 0;
  var lastTs = 0;
  var running = false;

  var reducedMotion = window.matchMedia
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false;

  // ------------------------------------------------------------ utilities

  function $(id) { return document.getElementById(id); }

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

  function setAttr(node, name, value) {
    var key = '__a_' + name;
    if (node[key] !== value) { node[key] = value; node.setAttribute(name, value); }
  }

  function setClass(node, value) {
    if (node.__cls !== value) { node.__cls = value; node.setAttribute('class', value); }
  }

  function setText(node, value) {
    if (node.__txt !== value) { node.__txt = value; node.textContent = value; }
  }

  function fmtTime(seconds) {
    var mins = Math.floor(seconds / 60);
    var rest = seconds - mins * 60;
    return mins + ':' + (rest < 10 ? '0' : '') + rest.toFixed(1);
  }

  function fmtRate(gps) { return gps.toFixed(1) + ' gal/s'; }

  /* A pipe is drawn as a casing with water inside it, so the moving stroke is
     always narrower than the pipe carrying it, and its dashes scale with the
     bore - a fat pipe gets chunky dashes rather than the same fine ones. */
  function applyPipeWidth(node, base, flow) {
    var inner = Math.max(4, base - 5);
    setAttr(node.base, 'stroke-width', base);
    setAttr(flow, 'stroke-width', inner);
    setAttr(flow, 'stroke-dasharray', (inner * 1.5).toFixed(1) + ' ' + (inner * 1.1).toFixed(1));
  }

  // --------------------------------------------------------------- storage

  function loadProgress() {
    try { return JSON.parse(window.localStorage.getItem(PROGRESS_KEY)) || {}; }
    catch (err) { return {}; }
  }

  function saveProgress(progress) {
    try { window.localStorage.setItem(PROGRESS_KEY, JSON.stringify(progress)); }
    catch (err) { /* private mode - progress just won't persist */ }
  }

  function recordWin(levelId, moves, seconds, target) {
    var progress = loadProgress();
    var previous = progress[levelId];
    var medal = medalFor(seconds, target);

    if (!previous || seconds < previous.time) {
      progress[levelId] = {
        time: seconds,
        moves: moves,
        medal: medal ? medal.id : null,
        fewestMoves: previous ? Math.min(previous.fewestMoves || previous.moves, moves) : moves
      };
      saveProgress(progress);
      return true;
    }

    // Not a faster run, but it may still be a tidier one.
    if (moves < (previous.fewestMoves || previous.moves)) {
      previous.fewestMoves = moves;
      saveProgress(progress);
    }
    return false;
  }

  // ---------------------------------------------------------- level select

  var dailyCache = null;

  function getDaily() {
    if (dailyCache === undefined || dailyCache === null) {
      dailyCache = W.dailyFor ? W.dailyFor(new Date()) : null;
    }
    return dailyCache;
  }

  function levelCard(spec, meta) {
    var card = el('button', 'card');
    card.type = 'button';

    var head = el('div', 'card-head');
    head.appendChild(el('h3', null, spec.name));
    if (meta.best) {
      head.appendChild(el('span', 'card-best medal-' + (meta.best.medal || 'bronze'),
        '● ' + fmtTime(meta.best.time)));
    }
    card.appendChild(head);

    card.appendChild(el('p', null, spec.blurb || ''));

    var tags = el('div', 'tags');
    if (spec.mode === 'sandbox') {
      tags.appendChild(el('span', 'tag', 'Free play'));
    } else {
      tags.appendChild(el('span', 'tag', 'Target ' + fmtTime(spec.targetTime)));
      tags.appendChild(el('span', 'tag',
        spec.pumps.length + (spec.pumps.length === 1 ? ' pump' : ' pumps')));
      if (spec.timeLimit) tags.appendChild(el('span', 'tag tag-warn', spec.timeLimit + 's limit'));
    }
    if (meta.best) tags.appendChild(el('span', 'tag tag-done', meta.best.moves + ' switches'));
    card.appendChild(tags);

    card.addEventListener('click', function () { startLevel(spec); });
    return card;
  }

  function buildSelect() {
    var progress = loadProgress();

    var campaign = $('campaign-grid');
    campaign.textContent = '';
    W.CAMPAIGN_SPECS.forEach(function (spec) {
      campaign.appendChild(levelCard(spec, { best: progress[spec.id] }));
    });

    var sandbox = $('sandbox-grid');
    sandbox.textContent = '';
    sandbox.appendChild(levelCard(W.SANDBOX_SPEC, { best: null }));

    var dailyHost = $('daily-grid');
    dailyHost.textContent = '';
    var daily = getDaily();
    if (daily) {
      var key = 'daily-' + daily.dayNumber;
      dailyHost.appendChild(levelCard(daily.spec, { best: progress[key] }));
    } else {
      dailyHost.appendChild(el('p', 'panel-hint', 'Today’s puzzle could not be generated.'));
    }
  }

  function showSelect() {
    running = false;
    $('screen-play').hidden = true;
    $('screen-select').hidden = false;
    buildSelect();
    if (window.history.replaceState) window.history.replaceState(null, '', location.pathname);
  }

  // ---------------------------------------------------------- scene build

  function progressKeyFor(spec) {
    return spec.daily ? 'daily-' + spec.dayNumber : spec.id;
  }

  function buildScene() {
    var scene = $('scene');
    scene.textContent = '';
    scene.setAttribute('viewBox', '0 0 ' + level.view.width + ' ' + level.view.height);
    $('stage-inner').style.aspectRatio = level.view.width + ' / ' + level.view.height;
    // Small levels would otherwise be blown up until the switches dwarf the
    // plant, so cap how far past 1:1 the diagram may scale.
    $('stage-inner').style.maxWidth = Math.round(level.view.width * 1.35) + 'px';

    nodes = { vats: {}, pumps: {}, inlets: [] };

    var layerPipes = svg('g', {});
    var layerVats = svg('g', {});
    var layerLabels = svg('g', {});
    var layerPumps = svg('g', {});
    var puzzle = level.mode === 'puzzle';

    level.inlets.forEach(function (inlet) {
      var base = svg('path', { d: inlet.path, class: 'pipe-base' });
      layerPipes.appendChild(base);
      var flow = svg('path', { d: inlet.path, class: 'pipe-flow inlet-flow' });
      layerPipes.appendChild(flow);
      nodes.inlets.push({ def: inlet, base: base, flow: flow, dash: 0 });

      if (puzzle) {
        var vat = level.vatById[inlet.target];
        var badge = svg('text', { class: 'rate-badge', x: vat.cx + 34, y: 34 });
        badge.textContent = inlet.rate;
        layerLabels.appendChild(badge);
      }
    });

    level.pumps.forEach(function (pump) {
      var base = svg('path', { d: pump.path, class: 'pipe-base' });
      layerPipes.appendChild(base);
      var flow = svg('path', { d: pump.path, class: 'pipe-flow' });
      layerPipes.appendChild(flow);
      nodes.pumps[pump.id] = { def: pump, base: base, flow: flow, dash: 0 };

      // In puzzle mode the rate belongs to the pipe, not the switch - it never
      // changes, so it reads as a property of the plant.
      if (puzzle) {
        var badge = svg('text', { class: 'rate-badge', x: pump.labelX, y: pump.labelY });
        badge.textContent = pump.rate;
        layerLabels.appendChild(badge);
      }
    });

    level.vats.forEach(function (vat) {
      var group = svg('g', {});
      var isRes = !!vat.reservoir;

      group.appendChild(svg('rect', { class: 'vat-back', x: vat.x, y: vat.y, width: vat.w, height: vat.h }));

      var fill = svg('rect', { class: 'vat-fill', x: vat.x + 2, y: vat.y + vat.h, width: vat.w - 4, height: 0 });
      group.appendChild(fill);

      if (!isRes) {
        var warnY = vat.y + vat.h * (1 - level.config.warnFraction);
        [[vat.x, vat.x + 30], [vat.x + vat.w - 30, vat.x + vat.w]].forEach(function (span) {
          group.appendChild(svg('line', {
            class: 'vat-warnline', x1: span[0], y1: warnY, x2: span[1], y2: warnY
          }));
        });
      }

      var body = svg('rect', { class: 'vat-body', x: vat.x, y: vat.y, width: vat.w, height: vat.h });
      group.appendChild(body);

      // Placed as fractions of the vat's height rather than fixed offsets, so
      // the name and the reading stay clear of each other whatever size the
      // vat is - the reservoir is much shorter than a working vat.
      var label = svg('text', {
        class: 'vat-label' + (isRes ? ' reservoir-label' : ''),
        x: vat.cx, y: vat.y + vat.h * (isRes ? 0.34 : 0.27)
      });
      label.textContent = isRes ? vat.label : vat.id;
      group.appendChild(label);

      var reading = svg('text', {
        class: 'vat-reading' + (isRes ? ' reservoir-reading' : ''),
        x: vat.cx, y: vat.y + vat.h * (isRes ? 0.74 : 0.78)
      });
      group.appendChild(reading);

      layerVats.appendChild(group);
      nodes.vats[vat.id] = { def: vat, fill: fill, body: body, reading: reading };
    });

    level.pumps.forEach(function (pump) {
      var bw = level.button.w;
      var bh = level.button.h;
      var group = svg('g', { class: 'pump', tabindex: '0', role: 'button' });

      group.appendChild(svg('rect', {
        class: 'pump-box', x: pump.buttonX - bw / 2, y: pump.buttonY - bh / 2,
        width: bw, height: bh, rx: 6
      }));

      // The glyph carries the same information as the colour, so on/off/
      // starving stay distinguishable without relying on hue.
      var glyph = svg('text', { class: 'pump-glyph', x: pump.buttonX, y: pump.buttonY - 9 });
      group.appendChild(glyph);

      var label = svg('text', { class: 'pump-label', x: pump.buttonX, y: pump.buttonY + 9 });
      label.textContent = pump.id;
      group.appendChild(label);

      var rate = puzzle ? null : svg('text', { class: 'pump-rate', x: pump.buttonX, y: pump.buttonY + 15 });
      if (rate) {
        setAttr(label, 'y', pump.buttonY + 1);
        setAttr(glyph, 'y', pump.buttonY - 13);
        group.appendChild(rate);
      }

      wirePump(group, pump.id);
      layerPumps.appendChild(group);
      nodes.pumps[pump.id].group = group;
      nodes.pumps[pump.id].glyph = glyph;
      nodes.pumps[pump.id].rateText = rate;
    });

    scene.appendChild(layerPipes);
    scene.appendChild(layerVats);
    scene.appendChild(layerLabels);
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
      } else if (level.mode === 'sandbox' && (event.key === 'ArrowUp' || event.key === 'ArrowRight')) {
        event.preventDefault();
        nudgeRate(id, 1);
      } else if (level.mode === 'sandbox' && (event.key === 'ArrowDown' || event.key === 'ArrowLeft')) {
        event.preventDefault();
        nudgeRate(id, -1);
      }
    });

    group.addEventListener('wheel', function (event) {
      if (level.mode !== 'sandbox') return;
      event.preventDefault();
      nudgeRate(id, event.deltaY < 0 ? 1 : -1);
      select(id);
    }, { passive: false });

    group.addEventListener('focus', function () { select(id); });
  }

  function nudgeRate(id, direction) {
    game.setPumpRate(id, game.pumps[id].rate + direction * level.config.rateStep);
    select(id);
  }

  // --------------------------------------------------------- sandbox panels

  function buildInletControls() {
    var host = $('inlet-list');
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
      slider.max = String(level.config.maxInletRate);
      slider.step = String(level.config.rateStep);
      slider.value = String(inlet.rate);
      slider.setAttribute('aria-label', inlet.description + ' rate, gallons per second');
      slider.addEventListener('input', function () {
        game.setInletRate(index, parseFloat(slider.value));
        value.textContent = fmtRate(game.inlets[index].rate);
      });

      wrap.appendChild(slider);
      host.appendChild(wrap);
      nodes.inlets[index].valueText = value;
    });
  }

  function select(id) {
    if (selectedId === id) return;
    selectedId = id;
    if (level.mode === 'sandbox') buildInspector();
  }

  function buildInspector() {
    var host = $('inspector');
    host.textContent = '';
    inspector.pumpId = selectedId;
    inspector.refs = null;

    if (!selectedId) {
      host.appendChild(el('p', 'inspector-empty',
        'Click a pump to switch it on and tune its rate. Shift-click selects without '
        + 'toggling; the scroll wheel adjusts a rate in place.'));
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
    slider.max = String(level.config.maxPumpRate);
    slider.step = String(level.config.rateStep);
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
    var showStarving = pump.starving && pump.starveTimer > level.config.starveVisualDelay;

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
    var puzzle = level.mode === 'puzzle';

    level.vats.forEach(function (def) {
      var node = nodes.vats[def.id];
      var vat = game.vats[def.id];
      var frac = Math.max(0, Math.min(1, vat.level / vat.capacity));
      var height = (def.h - 4) * frac;

      setAttr(node.fill, 'y', (def.y + def.h - 2 - height).toFixed(2));
      setAttr(node.fill, 'height', height.toFixed(2));
      setClass(node.fill, 'vat-fill'
        + (!vat.reservoir && frac >= level.config.warnFraction ? ' is-warn' : ''));

      var failedHere = failure && failure.targetId === def.id;
      setClass(node.body, 'vat-body' + (failedHere ? ' is-failed' : ''));

      setText(node.reading, vat.reservoir
        ? Math.floor(frac * 100) + '%  ·  ' + Math.round(vat.level) + ' / ' + vat.capacity + ' gal'
        : vat.level.toFixed(1) + ' / ' + vat.capacity);
    });

    level.pumps.forEach(function (def) {
      var node = nodes.pumps[def.id];
      var pump = game.pumps[def.id];
      var showStarving = pump.starving && pump.starveTimer > level.config.starveVisualDelay;
      var failedHere = failure && failure.targetId === def.id;
      var flowing = pump.on && pump.flow > 1e-6;

      setClass(node.group, 'pump'
        + (pump.on ? ' is-on' : '')
        + (showStarving ? ' is-starving' : '')
        + (failedHere ? ' is-failed' : '')
        + (!puzzle && selectedId === def.id ? ' is-selected' : ''));

      setText(node.glyph, showStarving ? GLYPH.starving : pump.on ? GLYPH.on : GLYPH.off);
      if (node.rateText) setText(node.rateText, pump.rate.toFixed(1));

      applyPipeWidth(node, W.pipeWidth(pump.rate, level.config.maxPumpRate), node.flow);

      setClass(node.flow, 'pipe-flow'
        + (flowing ? ' is-flowing' : '')
        + (showStarving ? ' is-starving' : ''));

      if (flowing && !reducedMotion) {
        node.dash = (node.dash - pump.flow * DASH_UNITS_PER_GALLON * realDt) % 1000;
        setAttr(node.flow, 'stroke-dashoffset', node.dash.toFixed(1));
      }

      var aria = def.id + ', ' + def.description + ', ' + def.rate + ' gallons per second, '
        + (showStarving ? 'starving' : pump.on ? 'on' : 'off');
      if (node.group.__aria !== aria) {
        node.group.__aria = aria;
        node.group.setAttribute('aria-label', aria);
      }
    });

    nodes.inlets.forEach(function (node, index) {
      var inlet = game.inlets[index];
      var flowing = inlet.rate > 0 && game.status === 'RUNNING';
      applyPipeWidth(node, W.pipeWidth(inlet.rate, level.config.maxInletRate), node.flow);
      setClass(node.flow, 'pipe-flow inlet-flow' + (flowing ? ' is-flowing' : ''));
      if (flowing && !reducedMotion) {
        node.dash = (node.dash - inlet.rate * DASH_UNITS_PER_GALLON * realDt) % 1000;
        setAttr(node.flow, 'stroke-dashoffset', node.dash.toFixed(1));
      }
    });

    var progress = game.progress();
    var pct = Math.floor(progress * 100);
    $('hud-progress-fill').style.width = (progress * 100).toFixed(2) + '%';
    setText($('hud-progress-label'), pct + '%');
    $('hud-progress').setAttribute('aria-valuenow', String(pct));
    setText($('hud-time'), fmtTime(game.elapsed)
      + (level.timeLimit ? ' / ' + fmtTime(level.timeLimit) : ''));

    if (puzzle) {
      setText($('hud-moves'), String(game.moves));
      setText($('hud-target'), spec.targetTime ? fmtTime(spec.targetTime) : '—');
    } else {
      setText($('hud-outflow'), fmtRate(game.reservoirInflow()));
      setText($('hud-inflow'), fmtRate(game.totalInflow()));
    }

    var statusNode = $('hud-status');
    var statusText = { IDLE: 'Ready', RUNNING: 'Running', PAUSED: 'Paused', WON: 'Solved', LOST: 'Failed' };
    setText(statusNode, statusText[game.status]);
    statusNode.className = 'hud-value'
      + (game.status === 'WON' ? ' is-won' : game.status === 'LOST' ? ' is-lost'
        : game.status === 'RUNNING' ? ' is-running' : '');

    var startBtn = $('btn-start');
    setText(startBtn, game.status === 'RUNNING' ? 'Pause' : game.status === 'PAUSED' ? 'Resume' : 'Start');
    startBtn.disabled = game.isOver();

    if (!puzzle) renderInspector();
  }

  // ------------------------------------------------------------ frame loop

  function frame(ts) {
    window.requestAnimationFrame(frame);
    if (!running || !game) { lastTs = ts; return; }

    if (lastTs === 0) lastTs = ts;
    var realDt = (ts - lastTs) / 1000;
    lastTs = ts;
    if (realDt > 0.25) realDt = 0.25;
    if (realDt < 0) realDt = 0;

    if (game.status === 'RUNNING') {
      acc += realDt;
      var steps = 0;
      var simDt = 1 / level.config.simHz;
      while (acc >= simDt && steps < MAX_STEPS_PER_FRAME && game.status === 'RUNNING') {
        game.step(simDt);
        acc -= simDt;
        steps++;
      }
      if (acc > simDt * MAX_STEPS_PER_FRAME) acc = 0;
      if (game.isOver()) showResult();
    }

    render(realDt);
  }

  // ----------------------------------------------------------------- modal

  function openModal(title, buildBody, actions) {
    $('modal-title').textContent = title;
    var body = $('modal-body');
    body.textContent = '';
    buildBody(body);

    var host = $('modal-actions');
    host.textContent = '';
    actions.forEach(function (action) {
      var button = el('button', 'btn' + (action.primary ? ' btn-primary' : ''), action.label);
      button.type = 'button';
      button.addEventListener('click', action.onClick);
      host.appendChild(button);
    });

    $('modal').hidden = false;
    var first = host.querySelector('button');
    if (first) first.focus();
  }

  function closeModal() { $('modal').hidden = true; }

  function showHelp() {
    var wasRunning = game && game.status === 'RUNNING';
    if (wasRunning) game.pause();
    var puzzle = level.mode === 'puzzle';

    openModal('How to Play', function (body) {
      body.appendChild(el('p', null, puzzle
        ? 'Every pipe moves a fixed number of gallons per second, printed beside it. '
          + 'Your only control is which pumps are running.'
        : 'Set the inlet and pump rates however you like, then keep the plant balanced.'));

      var rules = el('ul');
      [
        'Fill the reservoir at the bottom to 100%. The clock is your score — '
          + 'beat the target time for a medal.',
        'A vat that reaches its capacity overflows and the run ends.',
        'A pump that cannot draw its full rate pulses amber. Feed it or switch it off '
          + 'within ' + level.config.dryGrace.toFixed(0) + ' seconds or it runs dry.',
        'Most levels have no setting you can walk away from: every pipe draws '
          + 'faster than its supply, so pumps have to be run, rested and run again.',
        puzzle
          ? 'You can pause at any time and keep flipping switches — this is a puzzle, not a reflex test.'
          : 'Click a pump to toggle it; shift-click selects without toggling.'
      ].forEach(function (text) { rules.appendChild(el('li', null, text)); });
      body.appendChild(rules);

      var kbd = el('p');
      kbd.appendChild(document.createTextNode('Keyboard: '));
      kbd.appendChild(el('kbd', null, 'Tab'));
      kbd.appendChild(document.createTextNode(' to a pump, '));
      kbd.appendChild(el('kbd', null, 'Space'));
      kbd.appendChild(document.createTextNode(' to toggle.'));
      body.appendChild(kbd);
    }, [
      { label: wasRunning ? 'Resume' : 'Close', primary: true, onClick: function () {
        closeModal();
        if (wasRunning) game.start();
      } }
    ]);
  }

  function failureText(failure) {
    if (!failure) return '';
    if (failure.kind === 'OVERFLOW') {
      return failure.label + ' overflowed — it reached capacity while still taking on '
        + 'more water than it was sending out.';
    }
    if (failure.kind === 'TIMEOUT') {
      return 'Time ran out. The reservoir needed to be full within '
        + level.timeLimit + ' seconds.';
    }
    var pump = game.pumps[failure.targetId];
    return pump.id + ' ran dry — its source could not supply the ' + fmtRate(pump.rate)
      + ' it was asking for (' + pump.description + ').';
  }

  function shareText() {
    var medal = medalFor(game.elapsed, spec.targetTime);
    return 'Water Works Daily #' + spec.dayNumber + '\n'
      + fmtTime(game.elapsed) + (medal ? '  ' + medal.mark + ' ' + medal.label : '')
      + '  (target ' + fmtTime(spec.targetTime) + ')\n'
      + game.moves + ' switches';
  }

  function showResult() {
    running = false;
    var won = game.status === 'WON';
    var puzzle = level.mode === 'puzzle';
    var improved = won
      ? recordWin(progressKeyFor(spec), game.moves, game.elapsed, spec.targetTime)
      : false;
    var medal = won && puzzle ? medalFor(game.elapsed, spec.targetTime) : null;

    var actions = [{ label: 'Levels', onClick: function () { closeModal(); showSelect(); } }];
    if (won && puzzle && spec.daily && navigator.clipboard) {
      actions.push({ label: 'Copy result', onClick: function (event) {
        navigator.clipboard.writeText(shareText());
        event.target.textContent = 'Copied';
      } });
    }
    actions.push({ label: won ? 'Play again' : 'Retry', primary: true, onClick: function () {
      closeModal();
      restart();
    } });

    openModal(won ? 'Reservoir Full' : 'Run Failed', function (body) {
      body.appendChild(el('p', 'result-headline ' + (won ? 'is-won' : 'is-lost'),
        won ? 'Filled in ' + fmtTime(game.elapsed) : failureText(game.failure)));

      if (medal) {
        var banner = el('p', 'medal-banner medal-' + medal.id);
        banner.appendChild(el('span', 'medal-mark', medal.mark));
        banner.appendChild(document.createTextNode(' ' + medal.label
          + ' — target is ' + fmtTime(spec.targetTime)));
        body.appendChild(banner);

        var next = MEDALS[MEDALS.indexOf(medal) - 1];
        if (next) {
          body.appendChild(el('p', null, 'Finish in '
            + fmtTime(spec.targetTime * next.factor) + ' for ' + next.label + '.'));
        }
      }

      if (won && puzzle) {
        body.appendChild(el('p', null, 'Took ' + game.moves + ' switches.'));
        if (improved) body.appendChild(el('p', null, 'That’s your best time on this level.'));
      }

      if (!won) {
        body.appendChild(el('p', null, 'The reservoir reached '
          + Math.floor(game.progress() * 100) + '% after ' + fmtTime(game.elapsed) + '.'));
      }
    }, actions);
  }

  // --------------------------------------------------------------- actions

  function restart() {
    game.reset();
    acc = 0;
    lastTs = 0;
    // showResult() parks the frame loop when a run ends; without this the
    // restarted level sits at Ready and Start appears to do nothing.
    running = true;
    selectedId = null;
    if (level.mode === 'sandbox') {
      buildInletControls();
      buildInspector();
    }
    closeModal();
    render(0);
  }

  function startLevel(chosenSpec) {
    spec = chosenSpec;
    level = W.buildLevel(spec);
    game = W.createGame(level);

    var puzzle = level.mode === 'puzzle';
    $('screen-select').hidden = true;
    $('screen-play').hidden = false;
    $('level-name').textContent = level.name;
    $('level-blurb').textContent = level.blurb || '';
    $('panel-inlets').hidden = puzzle;
    $('panel-inspector').hidden = puzzle;
    $('layout').classList.toggle('is-solo', puzzle);
    $('hud-moves-item').hidden = !puzzle;
    $('hud-target-item').hidden = !puzzle;
    $('hud-outflow-item').hidden = puzzle;
    $('stage-hint').textContent = puzzle
      ? 'Numbers beside each pipe are gallons per second. Pause any time — switches still work.'
      : '';

    buildScene();
    if (!puzzle) {
      buildInletControls();
      buildInspector();
    }

    acc = 0;
    lastTs = 0;
    running = true;
    closeModal();
    render(0);

    if (window.history.replaceState && !spec.daily) {
      window.history.replaceState(null, '', '?level=' + spec.id);
    }
  }

  function toggleRun() {
    if (game.status === 'RUNNING') game.pause(); else game.start();
  }

  // ------------------------------------------------------------------ boot

  $('btn-back').addEventListener('click', showSelect);
  $('btn-start').addEventListener('click', toggleRun);
  $('btn-restart').addEventListener('click', restart);
  $('btn-help').addEventListener('click', showHelp);

  $('modal').addEventListener('click', function (event) {
    if (event.target === $('modal')) closeModal();
  });

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && !$('modal').hidden) closeModal();
  });

  // Losing a run because the tab went to the background would not be fair.
  document.addEventListener('visibilitychange', function () {
    if (document.hidden && game && game.status === 'RUNNING') game.pause();
  });

  buildSelect();

  var requested = /[?&]level=([\w-]+)/.exec(location.search);
  if (requested) {
    var found = W.specById(requested[1]);
    if (found) startLevel(found);
  }

  window.requestAnimationFrame(frame);
})();
