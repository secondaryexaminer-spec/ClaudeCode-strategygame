'use strict';
// 校验当前代码的行为是否与 sim/baseline.json 完全一致。
// 纯结构重构（拆模块、搬函数、改导入）之后应当全绿；一旦变红，说明这次改动
// 真的动了游戏逻辑 —— 要么是搬错了，要么是无意中改了行为。
//
// 用法：
//   npm run verify                       全部场景（多进程并行）
//   npm run verify:fast                  只跑最快的一个场景，改一刀验一次用
//   node sim/verify.js only=strait-2ai   只验某几个场景（定位问题时用，快很多）
//   node sim/verify.js jobs=1            退回单进程串行（怀疑并行本身有问题时用）
//   node sim/verify.js max=50            最多打印多少条差异（默认 25）
//
// 退出码：0 = 行为一致；1 = 有差异 / 基线缺失 / 运行出错。
const fs = require('fs');
const path = require('path');
const { runScenarios, deepDiff, parseArgs, parseOnly } = require('./scenarios');
const { runScenariosParallel, defaultJobs } = require('./pool');

const args = parseArgs();
const only = parseOnly(args);
const maxPrint = Number(args.max || 25);
const jobs = args.jobs === undefined ? defaultJobs() : Math.max(1, Number(args.jobs) || 1);
const baseFile = args.baseline ? path.resolve(args.baseline) : path.join(__dirname, 'baseline.json');

function shortValue(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text !== undefined && text.length > 70 ? `${text.slice(0, 67)}...` : String(text);
}

async function main() {
  if (!fs.existsSync(baseFile)) {
    console.error(`找不到基线文件 ${path.relative(process.cwd(), baseFile)}，请先运行 npm run snap`);
    process.exit(1);
  }
  const baseline = JSON.parse(fs.readFileSync(baseFile, 'utf8'));
  const expected = baseline.scenarios || {};

  const started = Date.now();
  console.log(`基线：${baseline.meta?.ts || '未知时间'}（Node ${baseline.meta?.node || '未知'}）`);
  if (baseline.meta?.node && baseline.meta.node !== process.version) {
    // shuffle() 依赖 Array.prototype.sort 的实现，跨大版本可能产生不同顺序，
    // 差异未必是你的代码造成的 —— 先提示，避免误判。
    console.log(`⚠️  当前 Node ${process.version} 与生成基线时不同，若出现差异请先在相同版本下复核。`);
  }
  console.log(`开始校验（${jobs > 1 ? `${jobs} 进程并行` : '单进程串行'}），各场景进度：`);

  const onProgress = (scn, seed, done, total) => {
    console.log(`  [${done}/${total}] ${scn.id.padEnd(15)} seed=${seed}`);
  };
  const actual = jobs > 1
    ? await runScenariosParallel({ only, jobs, onProgress })
    : await runScenarios({ only, onProgress });

  const rows = [];
  let totalDiffs = 0;
  for (const id of Object.keys(actual)) {
    if (!(id in expected)) {
      console.log(`\n➕ 场景 ${id} 不在基线里（新增场景？跑一次 npm run snap 收进基线）`);
      continue;
    }
    const diffs = deepDiff(expected[id], actual[id], id);
    totalDiffs += diffs.length;
    rows.push({ id, diffs });
  }

  // 基线里有、这次没跑到的场景：只在全量校验时才算问题。
  const missing = Object.keys(expected).filter(id => !(id in actual));
  if (missing.length && !only) {
    console.log(`\n⚠️  基线中的场景未被执行：${missing.join(', ')}`);
  }

  console.log('');
  for (const row of rows) {
    console.log(`${row.diffs.length ? 'DIFF' : 'SAME'}  ${row.id.padEnd(15)} ${row.diffs.length ? `${row.diffs.length} 处差异` : '行为一致'}`);
  }

  const elapsedSec = ((Date.now() - started) / 1000).toFixed(1);
  if (!totalDiffs) {
    console.log(`\n== ✅ 行为与基线完全一致（${rows.length} 个场景，用时 ${elapsedSec}s）==`);
    process.exit(0);
  }

  console.log(`\n== ❌ 发现 ${totalDiffs} 处行为差异（用时 ${elapsedSec}s）==\n`);
  let printed = 0;
  for (const row of rows) {
    for (const diff of row.diffs) {
      if (printed >= maxPrint) {
        break;
      }
      console.log(`  ${diff.path}`);
      console.log(`      基线 ${shortValue(diff.expected)}`);
      console.log(`      现在 ${shortValue(diff.actual)}`);
      printed += 1;
    }
    if (printed >= maxPrint) {
      break;
    }
  }
  if (totalDiffs > printed) {
    console.log(`  …… 还有 ${totalDiffs - printed} 处未显示（加 max=100 查看更多）`);
  }
  console.log('\n如果这次改动【本就打算】改变游戏行为，确认差异合理后运行 npm run snap 更新基线；');
  console.log('如果这次改动【应该是】纯结构重构，那就是搬错了，请按上面的路径回查。');
  process.exit(1);
}

main().catch(err => {
  console.error('VERIFY_ERROR', (err && err.stack) || err);
  process.exit(1);
});
