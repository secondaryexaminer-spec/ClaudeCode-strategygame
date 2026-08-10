'use strict';
// 单任务 worker：被 pool.js fork 出来，只跑一个 (场景, seed) 任务单元，
// 把结果 JSON 从 stdout 的最后一行回传给主进程。
//
// 为什么一个进程只跑一个任务：harness 会 eval 整个 bundle 并占用全局 DOM 打桩，
// 一个进程里只能建一次 harness。与其在进程内换配置连跑，不如一进程一任务 ——
// 顺带获得进程隔离，上一个任务的模块级缓存绝不会污染下一个。
//
// 用法（一般不手动调用，由 pool.js 驱动）：
//   node sim/worker.js scenario=strait-2ai seed=777
const { SCENARIOS, sortKeys, fingerprintRun, parseArgs } = require('./scenarios');
const { createHarness, baseConfig } = require('./harness');

async function main() {
  const args = parseArgs();
  const scn = SCENARIOS.find(item => item.id === args.scenario);
  if (!scn) {
    throw new Error(`未知场景 ${args.scenario}`);
  }
  const seed = Number(args.seed);

  const harness = createHarness(baseConfig(scn.config));
  // 必须显式再 setConfig 一次：createHarness 只是把 config 作为 DOM 打桩的
  // 读取兜底，而串行版 runScenarios() 每个场景都会调 setConfig。少这一步，
  // 两边的结果就对不上（实测如此）—— 详见 pool.js 顶部关于一致性的说明。
  harness.setConfig(baseConfig(scn.config));
  const { agg, runs } = await harness.debug.batch(scn.cap, scn.rounds, seed);

  // 走 JSON 文本而不是 IPC 对象：与 snapshot.js 写文件的序列化路径完全一致，
  // 杜绝结构化克隆在 undefined / NaN 上悄悄改掉值。
  const payload = {
    wins: sortKeys(agg.wins),
    avgTurns: agg.avgTurns,
    totals: sortKeys(agg.totals),
    runs: runs.map(fingerprintRun)
  };
  process.stdout.write(`\n__RESULT__${JSON.stringify(payload)}\n`);
}

main().then(
  () => process.exit(0),
  err => {
    console.error((err && err.stack) || err);
    process.exit(1);
  }
);
