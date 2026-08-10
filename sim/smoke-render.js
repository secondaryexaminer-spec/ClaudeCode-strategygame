'use strict';
// 渲染路径烟雾测试。
//
// 为什么需要它：npm run verify 跑的是 fastBatch，而 refresh() 开头有
// `if (fastSim) return;`，所以整个 draw() / drawMinimap() / 摄像机换算
// 一行都不会执行 —— 渲染层改坏了，行为基线照样全绿。
//
// 这里直接调 debug.newGame()（fastSim 为 false），强制走一遍完整绘制，
// 并且把 harness 的 canvas 打桩切到 strictCanvas 模式 —— 任何 NaN / undefined
// 坐标当场抛错。
//
// 光靠"没抛异常"是不够的：默认的 ctx 打桩是个 Proxy，吞掉一切调用，把 rt.S
// 写成 rt.SS 会让所有坐标变成 NaN 而测试照样全绿（这是实测出来的，不是假设）。
// strictCanvas 就是为了堵这个洞。
//
// 用法：node sim/smoke-render.js
const { createHarness, baseConfig } = require('./harness');

const CASES = [
  { id: '海峡·2AI', config: { mapSelect: 'strait', aiSelect: '2', diff: 'brutal', agg: 'balanced' } },
  { id: '群岛·3AI', config: { mapSelect: 'archipelago', aiSelect: '3', diff: 'medium', agg: 'reckless' } },
  { id: '平原·1AI', config: { mapSelect: 'plains', aiSelect: '1', diff: 'easy', agg: 'cautious' } }
];

function main() {
  const harness = createHarness(baseConfig(CASES[0].config), { strictCanvas: true });
  let failed = 0;
  for (const item of CASES) {
    harness.setConfig(baseConfig(item.config));
    harness.resetCtxCalls();
    try {
      harness.debug.newGame();
      // newGame 在非 fastSim 下把首回合交给 runLoadingScreen 的 setInterval，
      // 绘制不会同步发生 —— 必须显式 redraw 才能真正命中渲染层。
      if (!harness.debug.redraw) {
        throw new Error('__frontierDebug.redraw 不存在（bundle 是旧的？先跑 node build.js）');
      }
      harness.debug.redraw();
      const calls = harness.ctxCalls();
      // 一张最小的图也有几百次 ctx 调用；个位数说明 draw 提前返回了，
      // 那种「没抛异常」是假绿。
      if (calls < 200) {
        throw new Error(`ctx 只被调用了 ${calls} 次，绘制多半没真正执行`);
      }
      const summary = harness.debug.summary();
      console.log(`  OK   ${item.id.padEnd(12)} 单位 ${String(summary.units.length).padStart(3)} · 据点 ${String(summary.sites.length).padStart(3)} · ctx 调用 ${calls}`);
    } catch (err) {
      failed += 1;
      console.log(`  FAIL ${item.id}`);
      console.log(`       ${(err && err.message) || err}`);
    }
  }
  if (failed) {
    console.log(`\n== ❌ ${failed}/${CASES.length} 个用例的渲染路径有问题 ==`);
    process.exit(1);
  }
  console.log(`\n== ✅ 渲染路径正常（${CASES.length} 个用例）==`);
  process.exit(0);
}

main();
