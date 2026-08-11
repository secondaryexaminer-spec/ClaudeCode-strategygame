'use strict';
// 界面路径烟雾测试：渲染层（render/board.js、render/stats.js）+ 面板层（ui/panels.js）。
//
// 为什么需要它：npm run verify 跑的是 fastBatch，而 refresh() 开头有
// `if (fastSim) return;`，所以 draw() / drawMinimap() / updatePanels() 一行都不会
// 执行 —— 整个界面层删掉，行为基线照样全绿。
//
// 这里直接调 debug.newGame()（fastSim 为 false），再用三个 __frontierDebug 入口
// 强制同步跑一遍，并把 harness 的打桩切到严格模式。
//
// 【两种严格模式堵的是两类不同的错】
//   strictCanvas —— 渲染层画图。默认的 ctx 打桩是个 Proxy，吞掉一切调用，把 rt.S
//     写成 rt.SS 会让所有坐标变成 NaN 而测试照样全绿（这是实测出来的，不是假设：
//     第一版烟雾测试就没抓住这个错）。严格模式下 NaN / undefined 参数当场抛错。
//   strictDom —— 面板层拼字符串。写错属性名不抛异常，只是页面上多出一串
//     "undefined"。严格模式下任何写进 innerHTML / textContent 的 "undefined" /
//     "NaN" 当场抛错。
//
// 【调用次数断言是必需的，不是锦上添花】
// 「没抛异常」和「压根没跑」看起来一模一样。所以除了严格打桩，还要断言调用量。
// 而且必须**分层分别断言**：三层加起来一个总数是不够的 —— 面板层正常时写 84 次
// DOM、统计面板写 8 次，如果只断言总数下限 30，统计面板整个不跑也照样过关。
// 每层单独量一次，才能让任意一层熄火都被抓住。
//
// 【已知的覆盖边界，别把它当成全面的 UI 测试】
// 它只验证「跑得通、不产生 undefined/NaN」，不验证布局、样式、事件绑定，也不验证
// 文案内容对不对。setup() 里的事件绑定完全没有覆盖。
//
// 用法：node sim/smoke-render.js
const { createHarness, baseConfig } = require('./harness');

const CASES = [
  { id: '海峡·2AI', config: { mapSelect: 'strait', aiSelect: '2', diff: 'brutal', agg: 'balanced' } },
  { id: '群岛·3AI', config: { mapSelect: 'archipelago', aiSelect: '3', diff: 'medium', agg: 'reckless' } },
  { id: '平原·1AI', config: { mapSelect: 'plains', aiSelect: '1', diff: 'easy', agg: 'cautious' } }
];

// 下限取实测值的三分之一左右，留出地图大小和兵力差异的余量，
// 但离「提前 return」的个位数足够远。
//
// 统计面板量的是 ctx 而不是 dom：它主体是一张折线图，DOM 那边只写一个标题和一段
// summary.innerHTML —— 而汇总卡的数字是靠 querySelectorAll('[data-final]') 再逐个
// 写 textContent 填进去的，打桩的 querySelectorAll 恒返回空数组，那段循环在无头
// 环境里根本进不去。**这是打桩的天花板，不是代码的问题**：汇总卡的数字填充逻辑
// 这里测不到，别为了让数字好看去调下限假装覆盖了。
const LIMITS = {
  board: { metric: 'ctx', min: 200, label: '棋盘绘制' },
  panels: { metric: 'dom', min: 30, label: '面板刷新' },
  stats: { metric: 'ctx', min: 20, label: '统计图表' }
};

function requireEntry(debug, name) {
  if (typeof debug[name] !== 'function') {
    throw new Error(`__frontierDebug.${name} 不存在（bundle 是旧的？先跑 node build.js）`);
  }
}

function main() {
  const harness = createHarness(baseConfig(CASES[0].config), { strictCanvas: true, strictDom: true });
  let failed = 0;
  for (const item of CASES) {
    harness.setConfig(baseConfig(item.config));
    try {
      harness.debug.newGame();
      // newGame 在非 fastSim 下把首回合交给 runLoadingScreen 的 setInterval，
      // 绘制不会同步发生 —— 必须显式调这几个入口才能真正命中界面层。
      requireEntry(harness.debug, 'redraw');
      requireEntry(harness.debug, 'repaintUi');
      requireEntry(harness.debug, 'repaintStats');

      // 分层测量：每层前面把两个计数器都清零，跑完立刻读数。
      const counts = {};
      const measure = layer => {
        harness.resetCtxCalls();
        harness.resetDomWrites();
        layer();
        return { ctx: harness.ctxCalls(), dom: harness.domWrites() };
      };
      counts.board = measure(() => harness.debug.redraw());
      counts.panels = measure(() => harness.debug.repaintUi());
      counts.stats = measure(() => harness.debug.repaintStats());

      const parts = [];
      for (const [layer, limit] of Object.entries(LIMITS)) {
        const actual = counts[layer][limit.metric];
        if (actual < limit.min) {
          throw new Error(`${limit.label}只产生了 ${actual} 次 ${limit.metric} 调用（下限 ${limit.min}），这一层多半没真正执行`);
        }
        parts.push(`${limit.label} ${String(actual).padStart(5)}`);
      }
      const summary = harness.debug.summary();
      console.log(`  OK   ${item.id.padEnd(12)} 单位 ${String(summary.units.length).padStart(3)} · 据点 ${String(summary.sites.length).padStart(3)} · ${parts.join(' · ')}`);
    } catch (err) {
      failed += 1;
      console.log(`  FAIL ${item.id}`);
      console.log(`       ${(err && err.message) || err}`);
    }
  }
  if (failed) {
    console.log(`\n== ❌ ${failed}/${CASES.length} 个用例的界面路径有问题 ==`);
    process.exit(1);
  }
  console.log(`\n== ✅ 界面路径正常（${CASES.length} 个用例）==`);
  process.exit(0);
}

main();
