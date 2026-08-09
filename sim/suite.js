'use strict';
// Balance regression suite. Runs a fixed battery of matchups through the shared
// headless harness and checks each against expected win-rate / completion bounds.
// Usage:
//   node sim/suite.js                       (all scenarios, default rounds)
//   node sim/suite.js rounds=12 cap=150
//   node sim/suite.js only=mirror-strait,diff-gap
//   node sim/suite.js out=sim/suite-result.json
const fs = require('fs');
const path = require('path');
const { createHarness, baseConfig } = require('./harness');

const args = {};
for (const raw of process.argv.slice(2)) {
  const idx = raw.indexOf('=');
  if (idx > 0) args[raw.slice(0, idx)] = raw.slice(idx + 1);
}
const ROUNDS = Number(args.rounds || 8);
const CAP = Number(args.cap || 150);
const SEED = Number(args.seed || 4242);
const only = args.only ? new Set(String(args.only).split(',').map(s => s.trim())) : null;
const outFile = args.out ? path.resolve(args.out) : path.join(__dirname, 'suite-result.json');

// Win share of a given team among all decided (non-neutral) games.
function teamShare(wins, team) {
  let decided = 0;
  let got = 0;
  for (const [t, n] of Object.entries(wins)) {
    if (t === '未定' || t === 'neutral') continue;
    decided += n;
    if (t === team) got += n;
  }
  return decided ? got / decided : 0;
}
function decidedCount(wins) {
  return Object.entries(wins).reduce((a, [t, n]) => a + (t === '未定' || t === 'neutral' ? 0 : n), 0);
}

// Each scenario: config overrides + an expectation over the aggregated result.
const SCENARIOS = [
  {
    id: 'mirror-strait',
    desc: '裂海海峡 · 双方冷酷/均衡 → 应大致均衡（无地图先手偏置）',
    config: { mapSelect: 'strait', aiSelect: '2', diff: 'brutal', agg: 'balanced' },
    expect: agg => {
      const share = teamShare(agg.wins, 'B');
      return { pass: share >= 0.25 && share <= 0.75, metric: `B胜率 ${(share * 100).toFixed(0)}%`, want: '25%–75%' };
    }
  },
  {
    id: 'mirror-heartland',
    desc: '中心平原(陆战) · 双方冷酷/均衡 → 应大致均衡',
    config: { mapSelect: 'heartland', aiSelect: '2', diff: 'brutal', agg: 'balanced' },
    expect: agg => {
      const share = teamShare(agg.wins, 'B');
      return { pass: share >= 0.25 && share <= 0.75, metric: `B胜率 ${(share * 100).toFixed(0)}%`, want: '25%–75%' };
    }
  },
  {
    id: 'diff-gap',
    desc: '裂海海峡 · ai0冷酷(B) vs ai1简单(C) → 冷酷方应占多数',
    config: { mapSelect: 'strait', aiSelect: '2', diff: ['brutal', 'easy'], agg: 'balanced' },
    expect: agg => {
      const share = teamShare(agg.wins, 'B');
      return { pass: share >= 0.6, metric: `冷酷(B)胜率 ${(share * 100).toFixed(0)}%`, want: '≥60%' };
    }
  },
  {
    id: 'completion',
    desc: '海岸丘陵 · 3AI混战 → 绝大多数对局应在回合上限内分出结果',
    config: { mapSelect: 'coast', aiSelect: '3', diff: 'brutal', agg: 'balanced' },
    expect: agg => {
      const decided = decidedCount(agg.wins);
      const rate = decided / Math.max(1, agg.rounds);
      return { pass: rate >= 0.7, metric: `分出胜负 ${decided}/${agg.rounds}`, want: '≥70%' };
    }
  }
];

async function main() {
  const started = Date.now();
  const harness = createHarness(baseConfig(SCENARIOS[0].config));
  const results = [];
  let failures = 0;

  const list = SCENARIOS.filter(s => !only || only.has(s.id));
  for (const scn of list) {
    harness.setConfig(baseConfig(scn.config));
    const t0 = Date.now();
    const { agg } = await harness.debug.batch(CAP, ROUNDS, SEED);
    const verdict = scn.expect(agg);
    if (!verdict.pass) failures += 1;
    const row = {
      id: scn.id,
      desc: scn.desc,
      pass: verdict.pass,
      metric: verdict.metric,
      want: verdict.want,
      wins: agg.wins,
      avgTurns: agg.avgTurns,
      rounds: agg.rounds,
      elapsedSec: Number(((Date.now() - t0) / 1000).toFixed(1))
    };
    results.push(row);
    console.log(`${verdict.pass ? 'PASS' : 'FAIL'}  ${scn.id.padEnd(18)} ${verdict.metric} (期望 ${verdict.want}) 胜场=${JSON.stringify(agg.wins)} 均回合=${agg.avgTurns}`);
  }

  const payload = {
    ts: new Date().toISOString(),
    rounds: ROUNDS, cap: CAP, seed: SEED,
    elapsedSec: Number(((Date.now() - started) / 1000).toFixed(1)),
    passed: results.length - failures,
    failed: failures,
    results
  };
  fs.writeFileSync(outFile, JSON.stringify(payload, null, 2));
  console.log(`\n== 平衡回归：${payload.passed}/${results.length} 通过，用时 ${payload.elapsedSec}s ==`);
  process.exit(failures ? 1 : 0);
}

main().catch(err => {
  console.error('SUITE_ERROR', err && err.stack || err);
  try { fs.writeFileSync(outFile, JSON.stringify({ error: String(err && err.stack || err) }, null, 2)); } catch (e) {}
  process.exit(1);
});
