'use strict';
// 重构安全网 · 场景矩阵与执行器。
// snapshot.js（存基线）和 verify.js（验基线）共用这里的定义，保证两边跑的
// 是完全相同的东西。
//
// 核心前提：game.js 的 fastBatch() 会把 Math.random 换成种子化 LCG，跑完再还原
// （见 src/main.js 的 makeRng）。所以同一组 (config, seed, rounds, cap) 必然
// 产出逐字节相同的结果。任何差异都意味着游戏逻辑真的变了 —— 这正是"纯结构
// 重构"所需要的行为等价性证明。
//
// 与 suite.js 的分工：
//   suite.js  —— 防「平衡漂移」，断言是宽区间（胜率 25%~75%），允许合理波动。
//   verify.js —— 防「重构搬错」，断言是逐字段全等，不允许任何波动。
const { createHarness, baseConfig } = require('./harness');

// 场景矩阵：覆盖海战 / 陆战 / 多方混战 / 难度分支四类局面，尽量让每条主要
// 代码路径都被踩到。每个场景跑多个 seed，降低"某个 seed 恰好绕开了改动"的
// 漏网概率。
const SCENARIOS = [
  {
    id: 'strait-2ai',
    desc: '裂海海峡 · 2AI 冷酷/均衡 —— 覆盖海战、运输、登陆、桥头堡',
    config: { mapSelect: 'strait', aiSelect: '2', diff: 'brutal', agg: 'balanced' },
    seeds: [777, 20260804],
    rounds: 5,
    cap: 120
  },
  {
    id: 'heartland-2ai',
    desc: '中心平原 · 2AI 冷酷/均衡 —— 覆盖纯陆战、距离场寻路、据点争夺',
    config: { mapSelect: 'heartland', aiSelect: '2', diff: 'brutal', agg: 'balanced' },
    seeds: [777, 20260804],
    rounds: 5,
    cap: 120
  },
  {
    id: 'coast-3ai',
    desc: '海岸丘陵 · 3AI 混战 —— 覆盖多阵营交互、盟友判定、拥挤度',
    config: { mapSelect: 'coast', aiSelect: '3', diff: 'brutal', agg: 'balanced' },
    seeds: [4242],
    rounds: 4,
    cap: 120
  },
  {
    id: 'diff-gap',
    desc: '裂海海峡 · 冷酷冲动 vs 简单谨慎 —— 覆盖难度分支与经济/建造决策差异',
    config: { mapSelect: 'strait', aiSelect: '2', diff: ['brutal', 'easy'], agg: ['reckless', 'cautious'] },
    seeds: [4242],
    rounds: 4,
    cap: 120
  },
  {
    id: 'scripted-bridgehead',
    desc: '裂海海峡 · 冷酷 vs 桥头脚本对手 —— 定向覆盖 bridgehead* 系列登陆逻辑',
    config: { mapSelect: 'strait', aiSelect: '2', diff: ['brutal', 'bridgehead'], agg: 'balanced' },
    seeds: [4242],
    rounds: 4,
    cap: 120
  },
  {
    id: 'scripted-naval',
    desc: '海湾登陆 · 冷酷 vs 海防脚本对手 —— 定向覆盖 naval* 系列制海与巡逻逻辑',
    config: { mapSelect: 'grandbay', aiSelect: '2', diff: ['brutal', 'naval'], agg: 'balanced' },
    seeds: [4242],
    rounds: 4,
    cap: 120
  }
];

// 递归按 key 排序，保证序列化稳定 —— 比对时不会因对象 key 的插入顺序变化误报。
function sortKeys(value) {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortKeys(value[key])]));
  }
  return value;
}

// 把单局结果压成稳定指纹。保留终局态 + 全部 byOwner 战略计数：AI 行为一旦
// 改变，几乎必然在 stalls / reroutes / captures 这些计数上留下痕迹，所以这
// 是灵敏度最高、体积又可控的选择。
function fingerprintRun(run) {
  if (!run) {
    return null;
  }
  return {
    turn: run.turn,
    over: run.over,
    win: run.result ? run.result.win : null,
    resultText: run.result ? run.result.text : null,
    unitsAlive: run.unitsAlive,
    cityOwners: sortKeys(run.cityOwners || {}),
    byOwner: sortKeys(run.byOwner || {})
  };
}

// 跑完整场景矩阵，返回可直接序列化比对的结果树。
// onProgress(scenario, seed, index, total) 用于打印进度，纯展示、不进指纹。
async function runScenarios({ only = null, onProgress = null } = {}) {
  const list = SCENARIOS.filter(scn => !only || only.has(scn.id));
  if (!list.length) {
    throw new Error(`没有匹配的场景（可用：${SCENARIOS.map(s => s.id).join(', ')}）`);
  }

  // harness 会 eval 一次 bundle 并占用全局 DOM 打桩，整个进程只能建一次；
  // 后续场景靠 setConfig 换大厅配置。
  const harness = createHarness(baseConfig(list[0].config));
  const total = list.reduce((sum, scn) => sum + scn.seeds.length, 0);
  const out = {};
  let done = 0;

  for (const scn of list) {
    harness.setConfig(baseConfig(scn.config));
    const bySeed = {};
    for (const seed of scn.seeds) {
      const { agg, runs } = await harness.debug.batch(scn.cap, scn.rounds, seed);
      bySeed[`seed${seed}`] = {
        wins: sortKeys(agg.wins),
        avgTurns: agg.avgTurns,
        totals: sortKeys(agg.totals),
        runs: runs.map(fingerprintRun)
      };
      done += 1;
      if (onProgress) {
        onProgress(scn, seed, done, total);
      }
    }
    out[scn.id] = { desc: scn.desc, cap: scn.cap, rounds: scn.rounds, bySeed };
  }
  return out;
}

// 深度比对，产出 [{ path, expected, actual }]。path 用 / 连接，可直接定位到
// 「哪个场景 / 哪个 seed / 第几局 / 哪个指标」。
function deepDiff(expected, actual, path = '', out = [], limit = 200) {
  if (out.length >= limit) {
    return out;
  }
  const bothObjects = expected && actual
    && typeof expected === 'object' && typeof actual === 'object'
    && Array.isArray(expected) === Array.isArray(actual);

  if (!bothObjects) {
    if (JSON.stringify(expected) !== JSON.stringify(actual)) {
      out.push({ path: path || '(根)', expected, actual });
    }
    return out;
  }

  if (Array.isArray(expected)) {
    if (expected.length !== actual.length) {
      out.push({ path: `${path}.length`, expected: expected.length, actual: actual.length });
    }
    const len = Math.min(expected.length, actual.length);
    for (let i = 0; i < len; i++) {
      deepDiff(expected[i], actual[i], `${path}[${i}]`, out, limit);
    }
    return out;
  }

  for (const key of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
    const nextPath = path ? `${path}/${key}` : key;
    if (!(key in expected)) {
      out.push({ path: nextPath, expected: '(缺失)', actual: actual[key] });
    } else if (!(key in actual)) {
      out.push({ path: nextPath, expected: expected[key], actual: '(缺失)' });
    } else {
      deepDiff(expected[key], actual[key], nextPath, out, limit);
    }
  }
  return out;
}

// 解析 `key=value` 形式的命令行参数，与 run.js / suite.js 保持一致。
function parseArgs(argv = process.argv.slice(2)) {
  const args = {};
  for (const raw of argv) {
    const idx = raw.indexOf('=');
    if (idx > 0) {
      args[raw.slice(0, idx)] = raw.slice(idx + 1);
    }
  }
  return args;
}

function parseOnly(args) {
  return args.only ? new Set(String(args.only).split(',').map(s => s.trim()).filter(Boolean)) : null;
}

module.exports = { SCENARIOS, runScenarios, deepDiff, sortKeys, fingerprintRun, parseArgs, parseOnly };
