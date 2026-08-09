'use strict';
// Reusable headless harness. Builds the DOM/canvas shims, loads the SAME
// js/game.js bundle (no AI fork), and returns the game's __frontierDebug plus a
// setConfig() to swap lobby settings between scenarios in a single process.
const fs = require('fs');
const path = require('path');

// Expand a compact matchup into the per-AI lobby keys the game's setup() reads.
function expandAiConfig(aiCount, diff, agg) {
  const teams = ['B', 'C', 'A', 'D', 'E'];
  const colors = ['crimson', 'violet', 'amber', 'jade', 'steel', 'sand', 'teal'];
  const out = {};
  for (let i = 0; i < aiCount; i++) {
    out[`ai${i}Diff`] = Array.isArray(diff) ? (diff[i] || diff[diff.length - 1]) : diff;
    out[`ai${i}Agg`] = Array.isArray(agg) ? (agg[i] || agg[agg.length - 1]) : agg;
    out[`ai${i}Team`] = teams[i % teams.length];
    out[`ai${i}Color`] = colors[i % colors.length];
  }
  return out;
}

// A full lobby config with sane defaults; scenario overrides merge on top.
function baseConfig(overrides = {}) {
  const aiCount = Number(overrides.aiSelect || 2);
  const diff = overrides.diff || 'brutal';
  const agg = overrides.agg || 'balanced';
  const cfg = {
    mapSelect: 'strait',
    modeSelect: 'conquest',
    aiSelect: String(aiCount),
    spectatorSelect: 'on',
    startUnitsSelect: '6',
    deploymentSelect: 'tight',
    sizeSelect: 'medium',
    aspectSelect: 'standard',
    complexitySelect: 'medium',
    citySpread: '3',
    aiSpeed: '3',
    buildCap: '100',
    incomeMult: '1',
    siteDensity: '1',
    playerTeamSelect: 'A',
    playerColorSelect: 'azure',
    ...expandAiConfig(aiCount, diff, agg),
    ...overrides
  };
  delete cfg.diff;
  delete cfg.agg;
  return cfg;
}

function createHarness(initialConfig = {}, { nocache = false } = {}) {
  const config = {};
  Object.assign(config, initialConfig);

  const ctxStub = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'measureText') return () => ({ width: 0 });
      return () => {};
    },
    set() { return true; }
  });

  const elCache = new Map();
  function elFor(id) {
    if (elCache.has(id)) return elCache.get(id);
    const el = {
      id,
      _value: undefined,
      get value() { return this._value !== undefined ? this._value : (config[id] !== undefined ? config[id] : ''); },
      set value(v) { this._value = v; },
      textContent: '', innerHTML: '', width: 0, height: 0, disabled: false,
      classList: { add() {}, remove() {}, toggle() { return false; }, contains() { return false; } },
      style: {}, dataset: {},
      getContext: () => ctxStub,
      addEventListener() {}, removeEventListener() {},
      appendChild() {}, removeChild() {}, insertAdjacentHTML() {},
      setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
      closest() { return null; }, querySelector() { return null; }, querySelectorAll() { return []; },
      getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0 }; },
      focus() {}, click() {}, remove() {},
      onclick: null, onchange: null, oninput: null
    };
    elCache.set(id, el);
    return el;
  }

  let domReady = null;
  global.document = {
    getElementById: id => elFor(id),
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => elFor('__el_' + Math.random()),
    addEventListener: (evt, fn) => { if (evt === 'DOMContentLoaded') domReady = fn; },
    removeEventListener() {}
  };
  global.window = global;
  global.addEventListener = () => {};
  global.removeEventListener = () => {};
  global.requestAnimationFrame = () => 0;
  global.cancelAnimationFrame = () => {};
  global.MessageChannel = class {
    constructor() {
      const port1 = { onmessage: null };
      this.port1 = port1;
      this.port2 = { postMessage() { setImmediate(() => { if (port1.onmessage) port1.onmessage({ data: 0 }); }); } };
    }
  };

  global.__NO_DIST_CACHE = !!nocache;
  const gamePath = path.join(__dirname, '..', 'js', 'game.js');
  const gameSrc = fs.readFileSync(gamePath, 'utf8');
  (0, eval)(gameSrc);
  if (typeof domReady === 'function') domReady();

  const debug = global.window.__frontierDebug;
  if (!debug || typeof debug.batch !== 'function') {
    throw new Error('Headless harness failed: __frontierDebug.batch missing.');
  }

  return {
    debug,
    gamePath,
    // Apply a full config for the next scenario (values persist via elFor cache).
    setConfig(next) {
      for (const [id, val] of Object.entries(next)) {
        config[id] = val;
        elFor(id).value = val;
      }
    }
  };
}

module.exports = { createHarness, baseConfig, expandAiConfig };
