'use strict';
// 无头快速模拟：不渲染、不等动画，尽快把一局（或一批）跑到底，返回可比对的指标。
// sim/ 下所有工具的算力都来自这里。
//
// 依赖注入方式见 game/movement.js 顶部对 rt 门面的说明；额外的 deps 参数见
// debug/hooks.js 的说明 —— 这里用到的几个函数只有快速模拟要用。
//
// 【fastSim 这个开关到底关掉了什么】
// rt.setFastSim(true) 之后：refresh() 直接返回（不画、不刷面板）、pause() 不等待、
// finish() 不弹结算框。也就是说**整个界面层一行都不执行** —— 这正是行为基线
// （npm run verify）跑得快的原因，也正是它的盲区所在（补救见 sim/smoke-render.js）。
//
// 【确定性从哪来：三条缺一不可】
// 1. fastBatch 把 Math.random 换成种子化 LCG，跑完在 finally 里还原。
//    放在 finally 而不是末尾，是因为中途抛异常也必须还原 —— 否则后面所有代码
//    都在用一个被劫持的 Math.random，而且没人知道。
// 2. 游戏代码里必须始终写 `Math.random()`，**绝不能** `const { random } = Math`。
//    解构会在打包时就捕获原生实现，上面的覆写对它无效 —— 而且是静默失效：
//    结果依然是一局合法对局，只是每次都不一样。
// 3. 每局之间的模块级缓存必须清干净。跨局残留会让"连跑第 2 局"和"单跑第 2 局"
//    结果不同，这也是并行和串行对不上时要查的第一个地方。
//
// 【guard 是干什么的】
// while 循环的正常出口是 game.over 或 turn > cap。guard 是第三道保险：如果哪天
// advanceTurn 出了 bug 不推进回合，没有它这里会永远转下去、把整个测试挂死。
// 上限取 `cap × 阵营数 + 80`，比任何正常对局都宽。
//
// 【macroYield 每 40 步一次】
// 纯同步的 while 会把事件循环占满。浏览器里表现为页面卡死，Node 里表现为
// setInterval / setTimeout 全部饿死。每 40 步让一次，代价可以忽略。

export function createFastSim(rt, deps) {
  const { advanceTurn, aiTurn, newGame, ownerExists, macroYield } = deps;

  // 给 sim/scenarios.js 做指纹比对用的快照。字段是**基线的一部分** ——
  // 增删字段会让 sim/baseline.json 整个失效，必须重新 npm run snap。
  function debugSummary() {
    const game = rt.game;
    if (!game) {
      return null;
    }
    return {
      turn: game.turn,
      over: game.over,
      side: game.side,
      spectator: game.settings?.spectator,
      result: game.result || null,
      // 深拷贝：调用方常常在之后继续跑，浅引用会被后续回合改掉。
      strat: game.stats?.strat ? JSON.parse(JSON.stringify(game.stats.strat)) : null,
      teams: { ...game.teams },
      logs: [...game.logs],
      ownerOrder: [...game.ownerOrder],
      sites: game.sites.map(siteEntry => ({ owner: siteEntry.owner, kind: siteEntry.kind, name: siteEntry.name, x: siteEntry.x, y: siteEntry.y })),
      units: game.units.map(unitEntry => ({ owner: unitEntry.owner, type: unitEntry.type, x: unitEntry.x, y: unitEntry.y, hp: unitEntry.hp, rank: unitEntry.rank }))
    };
  }

  function aggregateStratByTeam() {
    const byTeam = {};
    const strat = rt.game?.stats?.strat || {};
    for (const owner of Object.keys(strat)) {
      const team = rt.teamOf(owner);
      byTeam[team] = byTeam[team] || {};
      for (const key of Object.keys(strat[owner])) {
        byTeam[team][key] = (byTeam[team][key] || 0) + strat[owner][key];
      }
    }
    return byTeam;
  }

  // 单局结果。同样是基线的一部分。
  function debugRunResult() {
    const game = rt.game;
    const strat = game?.stats?.strat || {};
    const totals = {};
    for (const owner of Object.keys(strat)) {
      for (const key of Object.keys(strat[owner])) {
        totals[key] = (totals[key] || 0) + strat[owner][key];
      }
    }
    return {
      turn: game.turn,
      over: game.over,
      result: game.result || null,
      totals,
      byOwner: JSON.parse(JSON.stringify(strat)),
      byTeam: aggregateStratByTeam(),
      cityOwners: game.sites.filter(s => s.kind === 'city').reduce((acc, s) => { const t = s.owner === 'neutral' ? 'neutral' : rt.teamOf(s.owner); acc[t] = (acc[t] || 0) + 1; return acc; }, {}),
      unitsAlive: game.units.length
    };
  }

  // 把当前这局跑到底。cap 是回合上限 —— 到点还没分胜负就按当前局面收尾。
  async function fastRun(cap = 150) {
    const game = rt.game;
    if (!game) {
      return null;
    }
    rt.setFastSim(true);
    let guard = 0;
    const guardMax = cap * Math.max(1, game.ownerOrder.length) + 80;
    while (!game.over && game.turn <= cap && guard < guardMax) {
      const owner = game.side;
      // 玩家方在无头模拟里没人操作，直接过；已被消灭的阵营同理。
      if (!ownerExists(owner) || owner === 'player') {
        advanceTurn();
      } else {
        await aiTurn(owner);
      }
      guard += 1;
      if (guard % 40 === 0) {
        await macroYield();
      }
    }
    rt.setFastSim(false);
    const result = debugRunResult();
    rt.refresh();
    return result;
  }

  // 用同一个种子连跑 rounds 局并汇总。种子化的三个前提见文件头。
  async function fastBatch(cap = 150, rounds = 10, seed = 20260804) {
    const runs = [];
    const origRandom = Math.random;
    // 线性同余发生器。参数取自 Numerical Recipes；质量不重要，
    // **可复现**才是唯一要求。换参数会让所有基线失效。
    const makeRng = value => {
      let state = value >>> 0;
      return () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 4294967296;
      };
    };
    try {
      for (let i = 0; i < rounds; i++) {
        // 每局的种子按黄金比例常数错开，避免相邻局的地图长得一样。
        Math.random = makeRng(seed + i * 2654435761);
        rt.setFastSim(true);
        newGame();
        const result = await fastRun(cap);
        runs.push(result);
      }
    } finally {
      // 必须在 finally 里还原，理由见文件头。
      Math.random = origRandom;
    }
    const agg = { rounds: runs.length, seed, wins: {}, avgTurns: 0, totals: {} };
    for (const run of runs) {
      // 优先读结算文案里的组名；打满回合数没有结算时，退回"谁城最多"。
      const winnerTeam = run.result?.text?.match(/^(\S+)\s*组/)?.[1] || (Object.entries(run.cityOwners).filter(([t]) => t !== 'neutral').sort((a, b) => b[1] - a[1])[0]?.[0]) || '未定';
      agg.wins[winnerTeam] = (agg.wins[winnerTeam] || 0) + 1;
      agg.avgTurns += run.turn;
      for (const key of Object.keys(run.totals)) {
        agg.totals[key] = (agg.totals[key] || 0) + run.totals[key];
      }
    }
    agg.avgTurns = Math.round((agg.avgTurns / Math.max(1, runs.length)) * 10) / 10;
    for (const key of Object.keys(agg.totals)) {
      agg.totals[key] = Math.round((agg.totals[key] / Math.max(1, runs.length)) * 10) / 10;
    }
    return { agg, runs };
  }

  return { debugSummary, debugRunResult, aggregateStratByTeam, fastRun, fastBatch };
}
