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

function createHarness(initialConfig = {}, { nocache = false, strictCanvas = false, strictDom = false } = {}) {
  const config = {};
  Object.assign(config, initialConfig);

  // 默认的 ctx 打桩吞掉一切调用，让无头模拟不必关心绘制。
  // 但这也意味着渲染层写错了属性名（rt.S 打成 rt.SS）时，坐标全变成 NaN
  // 而没有任何人报警 —— Proxy 照单全收。
  //
  // strictCanvas 打开后，任何传进绘图调用的 NaN / undefined 参数都会立刻抛错。
  // sim/smoke-render.js 用它给渲染层兜底；行为基线（verify）不需要，保持默认的
  // 静默版本，省掉每帧几千次的参数检查。
  const ctxState = { fillStyle: '', strokeStyle: '', lineWidth: 0, font: '', textAlign: '', textBaseline: '' };
  const ctxStats = { calls: 0 };
  const ctxStub = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'measureText') return () => ({ width: 0 });
      if (!strictCanvas) return () => {};
      if (typeof prop !== 'string') return () => {};
      return (...args) => {
        ctxStats.calls += 1;
        args.forEach((arg, index) => {
          if (typeof arg === 'number' && !Number.isFinite(arg)) {
            throw new Error(`ctx.${prop}() 第 ${index + 1} 个参数是 ${arg}（多半是某个尺寸/坐标读到了 undefined）`);
          }
          if (arg === undefined && prop !== 'setTransform') {
            throw new Error(`ctx.${prop}() 第 ${index + 1} 个参数是 undefined`);
          }
        });
      };
    },
    set(_t, prop, value) {
      // fillStyle = undefined 会让整块区域画成黑色，是典型的"不报错但画错"。
      if (strictCanvas && (value === undefined || (typeof value === 'number' && !Number.isFinite(value)))) {
        throw new Error(`ctx.${String(prop)} 被赋值为 ${value}`);
      }
      ctxState[prop] = value;
      return true;
    }
  });

  const elCache = new Map();

  // strictDom：面板层（src/ui/panels.js）的兜底。
  //
  // 它和 strictCanvas 堵的是同一类洞，但手段不同：面板不画图，它拼字符串写进
  // innerHTML / textContent。写错属性名不会抛异常，只会让页面上出现一串
  // "undefined" —— 而 DOM 打桩是个哑对象，照单全收。
  //
  // 所以这里的断言是：任何写进 innerHTML / textContent 的内容都不许包含
  // "undefined" / "NaN" 字面量。游戏里的正常文案全是中文和数字，不会误伤。
  // 如果哪天真有一段合法文案要含这两个词，改断言之前先确认它真的合法。
  const domStats = { writes: 0 };
  function checkDomWrite(el, prop, value) {
    domStats.writes += 1;
    if (!strictDom) {
      return;
    }
    if (value === undefined || value === null) {
      throw new Error(`#${el.id}.${prop} 被赋值为 ${value}`);
    }
    const text = String(value);
    const hit = /undefined|NaN/.exec(text);
    if (hit) {
      const from = Math.max(0, hit.index - 50);
      throw new Error(`#${el.id}.${prop} 里出现了 "${hit[0]}"：…${text.slice(from, hit.index + 50)}…`);
    }
  }

  function elFor(id) {
    if (elCache.has(id)) return elCache.get(id);
    const el = {
      id,
      _value: undefined,
      get value() { return this._value !== undefined ? this._value : (config[id] !== undefined ? config[id] : ''); },
      set value(v) { this._value = v; },
      _text: '', _html: '',
      get textContent() { return this._text; },
      set textContent(v) { checkDomWrite(this, 'textContent', v); this._text = v; },
      get innerHTML() { return this._html; },
      set innerHTML(v) { checkDomWrite(this, 'innerHTML', v); this._html = v; },
      width: 0, height: 0, disabled: false,
      classList: { add() {}, remove() {}, toggle() { return false; }, contains() { return false; } },
      style: {}, dataset: {},
      getContext: () => ctxStub,
      // 记下这个元素被挂了哪些事件，供 boundElements() 检查绑定层有没有漏。
      // 只记类型和次数，不真的存回调 —— 无头环境里没人会触发它们。
      _handlers: {},
      addEventListener(type) { this._handlers[type] = (this._handlers[type] || 0) + 1; },
      removeEventListener() {},
      _onclick: null,
      get onclick() { return this._onclick; },
      set onclick(fn) { this._onclick = fn; if (fn) { this._handlers.onclick = 1; } },
      appendChild() {}, removeChild() {}, insertAdjacentHTML() {},
      setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
      closest() { return null; }, querySelector() { return null; }, querySelectorAll() { return []; },
      // 返回和 canvas 像素尺寸一致的矩形（即 CSS 缩放比为 1:1）。
      // 原来这里恒返回 width: 0，会让 ui/input.js 的 `canvas.width / rect.width`
      // 变成 0/0 = NaN，任何合成点击都落在 NaN 格上 —— 点击路径根本没法测。
      // 只有 input.js 用这个方法，改它不影响其它工具。
      getBoundingClientRect() { return { left: 0, top: 0, width: this.width || 0, height: this.height || 0 }; },
      focus() {}, click() {}, remove() {},
      onchange: null, oninput: null
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
    // strictCanvas 模式下累计的 ctx 调用次数。用来区分「绘制跑了且没问题」和
    // 「绘制压根没跑」—— 后者同样不抛异常，光看有没有报错会误判成通过。
    ctxCalls: () => ctxStats.calls,
    resetCtxCalls: () => { ctxStats.calls = 0; },
    // 同理，用来区分「面板刷了且没问题」和「面板压根没刷」。
    domWrites: () => domStats.writes,
    resetDomWrites: () => { domStats.writes = 0; },
    // 每个元素上挂了哪些事件（含 onclick 赋值）。src/ui/bindings.js 里漏掉一行
    // addEventListener 是不会报错的 —— 只是那个按钮永远点不动，而无头环境里
    // 谁也不会去点它。这个入口让烟雾测试能直接断言"该绑的都绑上了"。
    handlersFor: id => ({ ...(elCache.get(id)?._handlers || {}) }),
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
