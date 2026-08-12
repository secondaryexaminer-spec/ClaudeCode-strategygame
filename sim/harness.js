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

  // 属性名从 HTML 的 `data-unit-action` 转成 dataset 的 `unitAction`。
  const camel = name => name.replace(/-([a-z])/g, (_m, ch) => ch.toUpperCase());

  // 极简选择器匹配：只认 `[attr]` 和 `.class` 两种，别的一律不匹配。
  // 够用的原因是 src/ 里出现的选择器就这两类（`[data-final]`、`[data-type]`、
  // `.save-row`、`.lblock`……）。写成完整的 CSS 解析器是过度投入，但**返回什么
  // 都不匹配也不行** —— 那就是原来的 `querySelectorAll: () => []`，会让依赖它的
  // 整段代码变成永远跑不到的死代码而毫无征兆。
  function selectorMatches(selector, attrs) {
    const attrHit = /^\[([\w-]+)\]$/.exec(selector);
    if (attrHit) {
      return attrs[attrHit[1]] !== undefined;
    }
    const classHit = /^\.([\w-]+)$/.exec(selector);
    if (classHit) {
      return String(attrs.class || '').split(/\s+/).includes(classHit[1]);
    }
    return false;
  }

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

  // 从一段 innerHTML 里扫出匹配选择器的标签，为每个造一个轻量节点。
  //
  // 这不是 HTML 解析器，只够支撑「先写 innerHTML，再 querySelectorAll 回来逐个
  // 填 textContent」这个模式 —— src/render/stats.js 的汇总卡和
  // src/ui/bindings.js 的存档行选中都是这么写的。原来 querySelectorAll 恒返回
  // 空数组，那两段循环一次都进不去。
  //
  // 造出来的节点带 dataset 和 textContent，写 textContent 同样走 checkDomWrite，
  // 所以 strictDom 能抓到往里面填的 undefined / NaN（汇总卡的数字就靠这个）。
  //
  // 每次调用都造一批新节点，写进去的值不会留到下次查询 —— 和真实 DOM 不同。
  // 这不影响覆盖：有价值的是**写入动作经过了 checkDomWrite**，不是值能读回来。
  function parseNodes(html, selector) {
    if (!html || typeof html !== 'string') {
      return [];
    }
    const out = [];
    const tagPattern = /<([a-zA-Z][\w-]*)((?:\s+[\w-]+="[^"]*")*)\s*\/?>/g;
    let tag;
    while ((tag = tagPattern.exec(html))) {
      const attrs = {};
      const attrPattern = /([\w-]+)="([^"]*)"/g;
      let attr;
      while ((attr = attrPattern.exec(tag[2] || ''))) {
        attrs[attr[1]] = attr[2];
      }
      if (!selectorMatches(selector, attrs)) {
        continue;
      }
      const dataset = {};
      for (const [key, value] of Object.entries(attrs)) {
        if (key.startsWith('data-')) {
          dataset[camel(key.slice(5))] = value;
        }
      }
      out.push(makeNode({ dataset, className: attrs.class || '', id: attrs.id || '' }));
    }
    return out;
  }

  // 一个不进 elCache 的轻量节点：解析 innerHTML 得到的子元素，以及合成事件时
  // 用的 event.target 都是它。
  //
  // closest() 是关键：src/ui/bindings.js 的面板按钮**全部走事件委托**，回调第一
  // 句就是 `event.target.closest('[data-type]')`。原来的打桩恒返回 null，于是每个
  // 委托回调都在第一个 if 里 return 掉 —— 生产、变卖、升级、工程师建造这些按钮
  // 的处理逻辑一行都执行不到，而测试里看不出任何异常。
  function makeNode({ dataset = {}, className = '', id = '', value = '' } = {}) {
    const node = {
      id, dataset, className, value,
      _text: '', _html: '',
      get textContent() { return this._text; },
      set textContent(v) { checkDomWrite(this, 'textContent', v); this._text = v; },
      get innerHTML() { return this._html; },
      set innerHTML(v) { checkDomWrite(this, 'innerHTML', v); this._html = v; },
      classList: {
        add() {}, remove() {},
        toggle() { return false; },
        contains(name) { return className.split(/\s+/).includes(name); }
      },
      style: {},
      // 自己匹配就返回自己。真实 DOM 会继续往父节点找，这里没有父子关系 ——
      // 够用是因为委托回调找的都是被点的那个按钮本身。
      closest(selector) { return selectorMatches(selector, { ...toAttrs(dataset), class: className, id }) ? node : null; },
      querySelector() { return null; },
      querySelectorAll(selector) { return parseNodes(this._html, selector); },
      appendChild() {}, removeChild() {}, setAttribute() {}, getAttribute() { return null; },
      addEventListener() {}, removeEventListener() {}, focus() {}, click() {}, remove() {}
    };
    return node;
  }

  // dataset 反查回 HTML 属性名，给 closest 判 `[data-unit-action]` 用。
  function toAttrs(dataset) {
    const out = {};
    for (const [key, value] of Object.entries(dataset || {})) {
      out['data-' + key.replace(/[A-Z]/g, ch => '-' + ch.toLowerCase())] = value;
    }
    return out;
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
      // 记下这个元素被挂了哪些事件，供 handlersFor() 检查绑定层有没有漏，
      // 同时**把回调本身存下来** —— dispatchOn() 要靠它合成点击。只记次数不存
      // 回调的话，"绑上了"能验，"绑对了"还是验不了。
      _handlers: {},
      _listeners: {},
      addEventListener(type, fn) {
        this._handlers[type] = (this._handlers[type] || 0) + 1;
        (this._listeners[type] = this._listeners[type] || []).push(fn);
      },
      removeEventListener() {},
      _onclick: null,
      get onclick() { return this._onclick; },
      set onclick(fn) { this._onclick = fn; if (fn) { this._handlers.onclick = 1; } },
      appendChild() {}, removeChild() {}, insertAdjacentHTML() {},
      setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
      closest() { return null; },
      querySelector() { return null; },
      // 从自己刚写进去的 innerHTML 里解析，见 parseNodes 的注释。
      querySelectorAll(selector) { return parseNodes(this._html, selector); },
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
  // document / window 上的处理器不走 elFor 打桩，得单独记 —— 键盘和拖拽就绑在
  // 这两个上面。记下来之后既能断言"绑上了"，也能用 dispatch* 合成事件。
  const globalHandlers = { document: {}, window: {} };
  function collect(bucket, evt, fn) {
    bucket[evt] = bucket[evt] || [];
    bucket[evt].push(fn);
  }
  global.document = {
    getElementById: id => elFor(id),
    // saves.js 的 downloadSaveFile 会往 body 上挂一个临时 <a> 再点掉它。
    // 少了这个属性，导出存档会在 appendChild 上炸掉。
    body: { appendChild() {}, removeChild() {} },
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => elFor('__el_' + Math.random()),
    addEventListener: (evt, fn) => {
      if (evt === 'DOMContentLoaded') {
        domReady = fn;
        return;
      }
      collect(globalHandlers.document, evt, fn);
    },
    removeEventListener() {}
  };
  global.window = global;
  global.addEventListener = (evt, fn) => collect(globalHandlers.window, evt, fn);
  global.removeEventListener = () => {};
  global.requestAnimationFrame = () => 0;
  global.cancelAnimationFrame = () => {};

  // 内存版 localStorage。
  //
  // ⚠️ 必须在 eval(gameSrc) **之前**装好：src/io/storage.js 在模块求值的那一刻就
  // 执行 `typeof localStorage !== 'undefined'` 并把结果冻进 `saveStore.available`。
  // 晚一步装，整个存档链路会**静默**变成空操作 —— setItem 什么都不做、listSaves
  // 恒返回空数组，而且不抛任何错。存档测不到过去被记成"打桩的天花板"，其实只是
  // 这里没接上。（这个因果做过对照实测，把这段挪到 eval 之后，存档往返链会红。）
  //
  // 只实现 saves.js 真正用到的那几个方法（含 length / key(i)，listSaves 靠它们
  // 遍历）。用 Map 而不是普通对象：键名由存档名拼出来，普通对象会和 __proto__
  // 这类键冲突。
  const storageData = new Map();
  global.localStorage = {
    get length() { return storageData.size; },
    key(index) { return [...storageData.keys()][index] ?? null; },
    getItem(key) { return storageData.has(String(key)) ? storageData.get(String(key)) : null; },
    setItem(key, value) { storageData.set(String(key), String(value)); },
    removeItem(key) { storageData.delete(String(key)); },
    clear() { storageData.clear(); }
  };
  // 导出存档要用（saves.js 的 downloadSaveFile）。无头环境里不真的下载，
  // 只要不抛错、并且让测试能确认"确实走到了导出"。
  const downloads = [];
  global.Blob = class {
    constructor(parts) { this.parts = parts; this._text = parts.join(''); }
  };
  global.URL = {
    createObjectURL(blob) { downloads.push(blob?._text ?? ''); return `blob:stub/${downloads.length}`; },
    revokeObjectURL() {}
  };
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
    // document / window 上绑了哪些事件类型。键盘和拖拽在这里，不在元素打桩里。
    globalHandlerTypes: target => Object.keys(globalHandlers[target] || {}),
    // 合成一次事件喂给 document / window 上注册的处理器。走的是绑定层真正注册的
    // 那个回调，所以键盘快捷键改坏了会被抓住。
    dispatchGlobal(target, evt, payload = {}) {
      const list = globalHandlers[target]?.[evt] || [];
      const event = { preventDefault() {}, stopPropagation() {}, ...payload };
      list.forEach(fn => fn(event));
      return list.length;
    },
    // 合成一次事件喂给某个元素上注册的处理器（含 onclick 赋值）。
    //
    // 这是"绑上了"到"绑对了"之间那一步。src/ui/bindings.js 里的面板按钮全部走
    // 事件委托，回调第一句是 `event.target.closest('[data-xxx]')` —— 所以调用方
    // 传 `dataset` 而不是元素 id，harness 据此造一个能被 closest 认出来的 target。
    //
    // 例：模拟点击生产栏里的"造民兵"按钮
    //   dispatchOn('buildGrid', 'click', { dataset: { type: 'militia' } })
    //
    // 返回真正被调用的处理器个数。0 表示这个元素上根本没挂这个事件 —— 调用方
    // 应当把它当成失败，而不是"点了没反应"。
    dispatchOn(id, evt, payload = {}) {
      const el = elCache.get(id);
      if (!el) {
        return 0;
      }
      const { dataset, className, value, ...rest } = payload;
      const target = makeNode({ dataset: dataset || {}, className: className || '', id, value });
      const event = {
        target,
        currentTarget: el,
        preventDefault() {}, stopPropagation() {},
        ...rest
      };
      let fired = 0;
      if (evt === 'click' && typeof el._onclick === 'function') {
        el._onclick(event);
        fired += 1;
      }
      for (const fn of el._listeners?.[evt] || []) {
        fn(event);
        fired += 1;
      }
      return fired;
    },
    // 存档后端的直接视图。用来断言"保存真的写进去了"而不只是"没抛错"。
    storageKeys: () => [...storageData.keys()],
    storageGet: key => (storageData.has(key) ? storageData.get(key) : null),
    storageClear: () => storageData.clear(),
    // downloadSaveFile 导出过的文件内容（JSON 字符串）。无头环境里不真的下载。
    downloads: () => downloads.slice(),
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
