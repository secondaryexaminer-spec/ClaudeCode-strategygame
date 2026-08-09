'use strict';
// Headless Node harness: runs the SAME strategy-game/js/game.js without a browser.
// Reuses window.__frontierDebug.batch via a minimal DOM shim, so AI logic never forks.
// Usage examples:
//   node strategy-game/sim/run.js
//   node strategy-game/sim/run.js map=strait diff=brutal agg=balanced rounds=20 seeds=777,101,555
//   node strategy-game/sim/run.js ai=3 start=6 deploy=tight cap=140

const fs = require('fs');
const path = require('path');

const args = {};
for (const raw of process.argv.slice(2)) {
  const idx = raw.indexOf('=');
  if (idx > 0) {
    args[raw.slice(0, idx)] = raw.slice(idx + 1);
  }
}

const aiCount = Number(args.ai || 2);
const diff = args.diff || 'brutal';
const agg = args.agg || 'balanced';
const teams = ['B', 'C', 'A'];
const colors = ['crimson', 'violet', 'amber'];

// Config consumed by newGame() via $(id).value. Injected AFTER setup() so it wins over setup defaults.
const config = {
  mapSelect: args.map || 'strait',
  modeSelect: args.mode || 'conquest',
  aiSelect: String(aiCount),
  spectatorSelect: 'on',
  startUnitsSelect: String(args.start || 6),
  deploymentSelect: args.deploy || 'tight',
  sizeSelect: args.size || 'medium',
  aspectSelect: args.aspect || 'standard',
  complexitySelect: args.complexity || 'medium',
  citySpread: String(args.spread || 3),
  aiSpeed: '3',
  buildCap: String(args.buildCap || 100),
  incomeMult: String(args.incomeMult || 1),
  siteDensity: String(args.siteDensity || 1),
  playerTeamSelect: 'A',
  playerColorSelect: 'azure'
};
for (let i = 0; i < aiCount; i++) {
  config[`ai${i}Diff`] = args[`ai${i}Diff`] || diff;
  config[`ai${i}Agg`] = args[`ai${i}Agg`] || agg;
  config[`ai${i}Team`] = args[`ai${i}Team`] || teams[i % teams.length];
  config[`ai${i}Color`] = args[`ai${i}Color`] || colors[i % colors.length];
}

// --- Minimal DOM / canvas shim -------------------------------------------------
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
// Guarantee a non-throttled macrotask yield regardless of Node version quirks.
global.MessageChannel = class {
  constructor() {
    const port1 = { onmessage: null };
    this.port1 = port1;
    this.port2 = { postMessage() { setImmediate(() => { if (port1.onmessage) port1.onmessage({ data: 0 }); }); } };
  }
};

// --- Load game.js (executes IIFE, registers DOMContentLoaded -> setup) ----------
global.__NO_DIST_CACHE = !!args.nocache;
const gamePath = path.join(__dirname, '..', 'js', 'game.js');
const gameSrc = fs.readFileSync(gamePath, 'utf8');
const diagFile = path.join(__dirname, 'last-diag.json');
const diag = { ts: new Date().toISOString(), gamePath, bytes: gameSrc.length };
fs.writeFileSync(diagFile, JSON.stringify(diag, null, 2));
try {
  (0, eval)(gameSrc);
  diag.evalDone = true;
  diag.domReady = typeof domReady;
  if (typeof domReady === 'function') {
    domReady();
  }
  diag.setupDone = true;
  diag.debugType = typeof (global.window && global.window.__frontierDebug);
  fs.writeFileSync(diagFile, JSON.stringify(diag, null, 2));
} catch (e) {
  diag.error = String(e && e.stack || e);
  fs.writeFileSync(diagFile, JSON.stringify(diag, null, 2));
  process.exit(1);
}
const debug = global.window.__frontierDebug;
if (!debug || typeof debug.batch !== 'function') {
  console.error('Failed to initialise headless harness: __frontierDebug.batch missing.');
  process.exit(1);
}

// Inject config now so it overrides setup() defaults before any batch run.
for (const [id, val] of Object.entries(config)) {
  elFor(id).value = val;
}

const cap = Number(args.cap || 140);
const rounds = Number(args.rounds || 20);
const seeds = String(args.seeds || args.seed || '777').split(',').map(s => Number(s.trim())).filter(n => !Number.isNaN(n));

const outFile = args.out ? path.resolve(args.out) : path.join(__dirname, 'last-result.json');

(async () => {
  const started = Date.now();
  const out = {};
  for (const seed of seeds) {
    const result = await debug.batch(cap, rounds, seed);
    const byOwner = {};
    for (const run of result.runs) {
      for (const [owner, strat] of Object.entries(run.byOwner || {})) {
        byOwner[owner] = byOwner[owner] || {};
        for (const [key, val] of Object.entries(strat)) {
          byOwner[owner][key] = (byOwner[owner][key] || 0) + val;
        }
      }
    }
    const n = Math.max(1, result.runs.length);
    for (const owner of Object.keys(byOwner)) {
      for (const key of Object.keys(byOwner[owner])) {
        byOwner[owner][key] = Math.round((byOwner[owner][key] / n) * 10) / 10;
      }
    }
    out[`seed${seed}`] = { ...result.agg, byOwner, owners: result.runs[0]?.byOwner ? Object.keys(result.runs[0].byOwner) : [] };
  }
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  const payload = {
    config: { map: config.mapSelect, mode: config.modeSelect, ai: aiCount, diff, agg, start: config.startUnitsSelect, deploy: config.deploymentSelect, cap, rounds },
    elapsedSec: Number(elapsed),
    results: out
  };
  fs.writeFileSync(outFile, JSON.stringify(payload, null, 2));
  console.log(JSON.stringify(payload, null, 2));
  process.exit(0);
})().catch(err => {
  fs.writeFileSync(outFile, JSON.stringify({ error: String(err && err.stack || err) }, null, 2));
  console.error('SIM_ERROR', err && err.stack || err);
  process.exit(1);
});
