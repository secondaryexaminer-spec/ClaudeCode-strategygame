'use strict';
// 生成重构基线：跑完整场景矩阵，把行为指纹写进 sim/baseline.json（该文件需入库）。
//
// 用法：
//   npm run snap                          全部场景
//   node sim/snapshot.js only=strait-2ai  只重算某几个场景（其余保留原值）
//   node sim/snapshot.js out=sim/x.json   写到别处
//
// ⚠️ 什么时候该重新生成基线：
//   ✅ 你「有意」改变了游戏逻辑或平衡（改数值、换算法、修 bug、加兵种/地形）
//   ❌ 纯结构重构（拆模块、搬函数、改导入）之后【不要】重新生成 ——
//      那种情况正确的做法是跑 npm run verify 证明行为没变。
//      verify 红了就去改代码，而不是覆盖基线，否则这张安全网就废了。
const fs = require('fs');
const path = require('path');
const { runScenarios, parseArgs, parseOnly, SCENARIOS } = require('./scenarios');

const args = parseArgs();
const only = parseOnly(args);
const outFile = args.out ? path.resolve(args.out) : path.join(__dirname, 'baseline.json');

async function main() {
  const started = Date.now();
  const bundlePath = path.join(__dirname, '..', 'js', 'game.js');
  const bundleBytes = fs.statSync(bundlePath).size;

  if (only) {
    console.log(`只重算场景：${[...only].join(', ')}（其余场景沿用旧基线）`);
  }
  console.log('开始生成基线，各场景进度：');

  const scenarios = await runScenarios({
    only,
    onProgress: (scn, seed, done, total) => {
      console.log(`  [${done}/${total}] ${scn.id.padEnd(15)} seed=${seed}`);
    }
  });

  // 局部重算时，把新结果合并进旧基线，不丢掉未跑的场景。
  let merged = scenarios;
  if (only && fs.existsSync(outFile)) {
    try {
      const prev = JSON.parse(fs.readFileSync(outFile, 'utf8'));
      merged = { ...(prev.scenarios || {}), ...scenarios };
    } catch (err) {
      console.warn(`旧基线无法解析，将整份覆盖：${err.message}`);
    }
  }

  const elapsedSec = Number(((Date.now() - started) / 1000).toFixed(1));
  const payload = {
    // meta 仅用于诊断，verify 不会拿它做断言（否则每次都会因时间戳而红）。
    meta: {
      ts: new Date().toISOString(),
      node: process.version,
      bundleBytes,
      elapsedSec,
      scenarioIds: Object.keys(merged).sort()
    },
    scenarios: merged
  };
  fs.writeFileSync(outFile, `${JSON.stringify(payload, null, 2)}\n`);

  const runCount = Object.values(merged)
    .reduce((sum, scn) => sum + Object.values(scn.bySeed).reduce((n, s) => n + s.runs.length, 0), 0);
  console.log(`\n== 基线已写入 ${path.relative(process.cwd(), outFile)} ==`);
  console.log(`   场景 ${Object.keys(merged).length}/${SCENARIOS.length}，累计 ${runCount} 局，用时 ${elapsedSec}s`);
  console.log('   请把它一起提交入库，之后用 npm run verify 校验。');
  process.exit(0);
}

main().catch(err => {
  console.error('SNAPSHOT_ERROR', (err && err.stack) || err);
  process.exit(1);
});
