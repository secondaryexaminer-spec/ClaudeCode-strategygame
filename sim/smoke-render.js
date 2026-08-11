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
  { id: '平原·1AI', config: { mapSelect: 'plains', aiSelect: '1', diff: 'easy', agg: 'cautious' } },
  // 上面三个都走 baseConfig 的默认值 spectatorSelect:'on' —— 观战局根本没有玩家
  // 单位，onBoard 一进门就被 `if (game.settings?.spectator)` 拦住只做选中。
  // 也就是说装载 / 攻击 / 移动那几条分支在观战局里一条都跑不到。
  // 这个用例专门关掉观战，把"选中 → 移动"这条最基本的操作链跑通。
  // 用海岸图而不是内陆图：交互链要凑出两对"空海格挨着空陆格"来验装载和工程师
  // 下水，内陆图的海岸线太短，实测只能凑出一对。
  { id: '海岸·可操作', config: { mapSelect: 'coast', aiSelect: '1', spectatorSelect: 'off', diff: 'easy', agg: 'cautious' }, interactive: true }
];

// 下限取实测值的三分之一左右，留出地图大小和兵力差异的余量，
// 但离「提前 return」的个位数足够远。
//
// 统计面板量的是 ctx 而不是 dom：它主体是一张折线图，DOM 那边只写一个标题和一段
// summary.innerHTML —— 而汇总卡的数字是靠 querySelectorAll('[data-final]') 再逐个
// 写 textContent 填进去的，打桩的 querySelectorAll 恒返回空数组，那段循环在无头
// 环境里根本进不去。**这是打桩的天花板，不是代码的问题**：汇总卡的数字填充逻辑
// 这里测不到，别为了让数字好看去调下限假装覆盖了。
// 固定种子，理由见 withSeed。改这个值会换掉四张图的布局，
// 换完请确认四个用例仍然都能跑到该跑的分支（尤其是"内陆·可操作"的移动链）。
const SEED = 20260811;

const LIMITS = {
  board: { metric: 'ctx', min: 200, label: '棋盘绘制' },
  panels: { metric: 'dom', min: 30, label: '面板刷新' },
  stats: { metric: 'ctx', min: 20, label: '统计图表' },
  click: { metric: 'hits', min: 2, label: '棋盘点击' },
  lobby: { metric: 'ctx', min: 100, label: '大厅预览' }
};

// 只在 interactive 用例里跑：构造出特定局面，逐条验证 onBoard 的分支。
// 随机开局不保证出现"运兵船旁边有陆军"这种组合，所以用 placeUnit 直接摆出来。
// 每条返回一句描述，失败就抛。
const INTERACTION_CHECKS = [
  {
    name: '装载',
    run(debug, spot) {
      // 运兵船在海格、陆军在相邻陆格 → 点陆军再点船 = 装载。
      const shipId = debug.placeUnit('transport', 'player', spot.sea.x, spot.sea.y);
      debug.placeUnit('militia', 'player', spot.land.x, spot.land.y);
      debug.clickCell(spot.land.x, spot.land.y);
      debug.clickCell(spot.sea.x, spot.sea.y);
      const ship = debug.inspectCell(spot.sea.x, spot.sea.y);
      if (!ship || ship.id !== shipId || ship.cargo.length !== 1) {
        throw new Error(`点陆军再点运兵船没有装载（船上有 ${ship ? ship.cargo.length : '?'} 个单位）`);
      }
      return `载员 ${ship.cargo.length}`;
    }
  },
  {
    name: '卸载',
    run(debug, spot) {
      // 承接上一条：船上已有一个陆军，点空陆格 = 卸载。
      debug.clickCell(spot.sea.x, spot.sea.y);
      debug.clickCell(spot.land.x, spot.land.y);
      const ship = debug.inspectCell(spot.sea.x, spot.sea.y);
      const landed = debug.inspectCell(spot.land.x, spot.land.y);
      if (!ship || ship.cargo.length !== 0 || !landed) {
        throw new Error(`点空陆格没有卸载（船上还有 ${ship ? ship.cargo.length : '?'} 个，岸上 ${landed ? '有' : '没有'}单位）`);
      }
      return `卸下 ${landed.type}`;
    }
  },
  {
    name: '攻击',
    run(debug, spot) {
      // 相邻两格摆敌我各一，点自己再点敌人 = 攻击。断言目标掉血或阵亡。
      debug.placeUnit('swordsman', 'player', spot.landA.x, spot.landA.y);
      debug.placeUnit('militia', 'ai0', spot.landB.x, spot.landB.y);
      const before = debug.inspectCell(spot.landB.x, spot.landB.y);
      debug.clickCell(spot.landA.x, spot.landA.y);
      debug.clickCell(spot.landB.x, spot.landB.y);
      const after = debug.inspectCell(spot.landB.x, spot.landB.y);
      const killed = !after || after.owner !== 'ai0';
      if (!killed && after.hp >= before.hp) {
        throw new Error(`点敌人没有造成伤害（${before.hp} → ${after.hp}）`);
      }
      return killed ? '目标阵亡' : `${before.hp} → ${after.hp}`;
    }
  },
  {
    name: '工程师下水',
    run(debug, spot) {
      // onBoard 的第 2 条分支：有 pendingOrder 时点海格 = 完成建造。
      // 这条链要两步：先在面板上选好造什么（这里直接写 pendingOrder，
      // 因为面板按钮的点击不在本测试范围内），再点海格下水。
      debug.placeUnit('engineer', 'player', spot.land2.x, spot.land2.y);
      const engineer = debug.inspectCell(spot.land2.x, spot.land2.y);
      debug.clickCell(spot.land2.x, spot.land2.y);
      // 造空载运兵船（42）而不是战船（46）：开局金币是 45，战船差 1 块钱 ——
      // 那会让这条链因为"钱不够"而失败，看起来却像派发链断了。
      const armed = debug.armEngineerLaunch(engineer.id, 'transport', []);
      if (!armed) {
        throw new Error('设置 pendingOrder 失败（工程师没选中？）');
      }
      debug.clickCell(spot.sea2.x, spot.sea2.y);
      const launched = debug.inspectCell(spot.sea2.x, spot.sea2.y);
      if (!launched || launched.type !== 'transport') {
        throw new Error(`点海格没有造出运兵船（那一格现在是 ${launched ? launched.type : '空的'}）`);
      }
      return `造出 ${launched.type}`;
    }
  },
  {
    name: '缩放',
    run(debug) {
      // 滚轮放大再缩小，断言 zoom 真的变了。
      const zoomed = debug.wheelZoom(-100, 50, 50);
      const back = debug.wheelZoom(100, 50, 50);
      if (!zoomed || !back || zoomed.zoom === back.zoom) {
        throw new Error(`滚轮没有改变缩放（${zoomed?.zoom} vs ${back?.zoom}）`);
      }
      return `${back.zoom.toFixed(2)} → ${zoomed.zoom.toFixed(2)}`;
    }
  },
  {
    name: '拖拽',
    run(debug) {
      // 先放大到地图超出视口 —— 否则 mapIsPanned() 为假，beginPan 直接不记录，
      // 拖拽"没反应"是正确行为，断言会假绿通过（第一版就是这样）。
      for (let i = 0; i < 6; i++) {
        debug.wheelZoom(-100, 10, 10);
      }
      // 左键（button 0）不该触发平移，右键（button 2）才该。
      const left = debug.dragPan(40, 40, 0);
      if (left.camMoved) {
        throw new Error('左键拖拽也平移了摄像机（beginPan 应该只认右键）');
      }
      const right = debug.dragPan(40, 40, 2);
      if (!right.camMoved) {
        throw new Error('放大到超出视口后，右键拖拽仍然没有平移摄像机');
      }
      return '右键平移生效，左键不生效';
    }
  },
  {
    name: '键盘',
    run(debug, spot, harness) {
      // Escape 应该清掉选中。走的是 bindings.js 真正注册到 document 上的回调。
      debug.clickCell(spot.landA.x, spot.landA.y);
      const delivered = harness.dispatchGlobal('document', 'keydown', { key: 'Escape', code: 'Escape' });
      if (!delivered) {
        throw new Error('document 上没有 keydown 处理器（键盘绑定丢了）');
      }
      if (debug.selection().kind) {
        throw new Error('按 Escape 之后仍有选中');
      }
      return `${delivered} 个 keydown 处理器`;
    }
  }
];

// setup() 结束后必须挂上事件的元素。src/ui/bindings.js 里漏掉一行
// addEventListener 不会报任何错 —— 那个按钮只是永远点不动，而无头环境里谁也
// 不会去点它。这份清单是绑定层唯一的自动化保护，加新按钮时请一并加进来。
//
// 只检查"有没有挂"，不检查挂的是什么、点了会发生什么 —— 那些还是得开浏览器。
const MUST_BE_BOUND = [
  'board',                                                          // 棋盘点击 / 拖拽 / 缩放
  'aiSelect', 'mapSelect', 'citySpread', 'aiSpeed', 'buildCap',     // 大厅选项
  'btnStartGame', 'btnNewGame', 'btnHelp', 'btnInfoPage',           // 大厅按钮
  'buildGrid', 'buildBody', 'selActions', 'engineerCard',           // 面板事件委托
  'btnUpgrade', 'btnFullHeal', 'btnEndTurn',                        // 据点与回合
  'btnPause', 'btnResume', 'btnEndGame',                            // 暂停菜单
  'btnModalOk', 'btnModalContinue',                                 // 结算弹窗
  'btnChartPrev', 'btnChartNext',                                   // 统计翻页
  'btnSaveGame', 'btnSaveConfirm', 'btnSaveOverwrite', 'btnSaveExport', 'btnSaveCancel',
  'btnLoadPage', 'btnLoadBack', 'btnLoadConfirm', 'btnLoadDelete',
  'saveListBody', 'btnImportSave', 'btnExportSave', 'importFile'
];

function requireEntry(debug, name) {
  if (typeof debug[name] !== 'function') {
    throw new Error(`__frontierDebug.${name} 不存在（bundle 是旧的？先跑 node build.js）`);
  }
}

// 在当前地图上找几对空格子给交互链用：
//   sea + land     —— 相邻的海格与陆格，验装载 / 卸载
//   sea2 + land2   —— 另一对，验工程师下水（第一对上已经站了卸载下来的单位）
//   landA + landB  —— 相邻的两个陆格，验攻击
// 必须都是空的（没单位、没据点），否则摆上去的测试单位会和原有的叠在同一格 ——
// inspectCell 只返回最上面那个，断言就会读到不是自己摆的那个单位。
// （这是实测踩到的：工程师和卸载下来的民兵叠在了一起。）
//
// 找不到就抛，而不是跳过 —— 跳过等于静默减少覆盖，那正是这套测试要避免的事。
// 真遇到某张图凑不出这些格子，该换用例配置，不该让测试悄悄变宽松。
function findInteractionSpots(harness) {
  const board = harness.debug.summary();
  const taken = new Set([
    ...board.units.map(entry => `${entry.x},${entry.y}`),
    ...board.sites.map(entry => `${entry.x},${entry.y}`)
  ]);
  const free = (x, y) => !taken.has(`${x},${y}`);
  requireEntry(harness.debug, 'terrainAt');
  requireEntry(harness.debug, 'dimensions');
  const isSea = (x, y) => harness.debug.terrainAt(x, y) === 'water';
  const isLand = (x, y) => {
    const t = harness.debug.terrainAt(x, y);
    return !!t && t !== 'water' && t !== 'mountain';
  };
  const dims = harness.debug.dimensions();
  const NEIGHBORS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  // 找一对相邻的空格子，第一个满足 firstOk、第二个满足 secondOk。找到就占位。
  const findPair = (firstOk, secondOk) => {
    for (let y = 0; y < dims.h; y++) {
      for (let x = 0; x < dims.w; x++) {
        if (!free(x, y) || !firstOk(x, y)) {
          continue;
        }
        for (const [dx, dy] of NEIGHBORS) {
          if (free(x + dx, y + dy) && secondOk(x + dx, y + dy)) {
            taken.add(`${x},${y}`);
            taken.add(`${x + dx},${y + dy}`);
            return [{ x, y }, { x: x + dx, y: y + dy }];
          }
        }
      }
    }
    return null;
  };
  const pairA = findPair(isSea, isLand);
  const pairB = findPair(isSea, isLand);
  const pairC = findPair(isLand, isLand);
  if (!pairA || !pairB || !pairC) {
    throw new Error(`这张图上凑不出交互链需要的空格子（海陆对 ${[pairA, pairB].filter(Boolean).length}/2、陆陆对 ${pairC ? 1 : 0}/1）`);
  }
  return {
    sea: pairA[0], land: pairA[1],
    sea2: pairB[0], land2: pairB[1],
    landA: pairC[0], landB: pairC[1]
  };
}

// 用固定种子跑，理由和 verify 一样：布点、地形、初始兵力全靠 Math.random，// 不固定的话每次跑的都是不同的局 —— 断言就会时绿时红，而红的原因往往是"这次
// 敌人恰好离得近"而不是代码坏了（这是实际踩到的：点敌人有时触发攻击分支）。
// 和 fastBatch 用的是同一个 LCG，跑完必须还原，否则会污染后续用例。
function withSeed(seed, fn) {
  const orig = Math.random;
  let state = seed >>> 0;
  Math.random = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
  try {
    return fn();
  } finally {
    Math.random = orig;
  }
}

function main() {
  // createHarness 会触发 DOMContentLoaded → setup() → showScreen('setup')
  // → renderLobbyPreview()，所以大厅的大部分渲染在这一行就跑完了，strictDom
  // 也已经生效。**它抛错就说明大厅层有问题**，必须单独兜住 —— 否则异常会在
  // 用例循环之外冒出去，进程直接崩，报错里看不出是哪一层的事。
  let harness;
  try {
    harness = createHarness(baseConfig(CASES[0].config), { strictCanvas: true, strictDom: true });
  } catch (err) {
    console.log('  FAIL 大厅初始化（setup / showScreen / renderLobbyPreview）');
    console.log(`       ${(err && err.message) || err}`);
    console.log('\n== ❌ 界面路径有问题：游戏还没开局就挂了 ==');
    process.exit(1);
  }
  let failed = 0;

  // 绑定检查只做一次：setup() 在 createHarness 里已经跑完，之后不会再绑。
  const unbound = MUST_BE_BOUND.filter(id => !Object.keys(harness.handlersFor(id)).length);
  if (unbound.length) {
    failed += 1;
    console.log(`  FAIL 事件绑定（src/ui/bindings.js）`);
    console.log(`       这 ${unbound.length} 个元素上一个事件都没挂：${unbound.join('、')}`);
  } else {
    console.log(`  OK   事件绑定       ${MUST_BE_BOUND.length} 个元素都挂上了处理器`);
  }
  CASES.forEach((item, index) => {
    harness.setConfig(baseConfig(item.config));
    try {
      // 每个用例一个固定种子（错开，避免几张图长得一样）。
      withSeed(SEED + index * 2654435761, () => harness.debug.newGame());
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

      // 棋盘点击：onBoard 是玩家唯一的操作入口，分支顺序就是规则本身
      // （见 src/ui/input.js 文件头）。这里逐类目标各点一次，验证坐标换算和
      // 派发链路跑得通 —— 顺带把 selectRef → refresh → updatePanels 也带一遍。
      requireEntry(harness.debug, 'clickCell');
      const board = harness.debug.summary();
      let hits = 0;

      // 非观战用例先验一条完整的操作链：选中自己的单位 → 点邻格 → 单位真的动了。
      // 光验"点了会选中"是不够的 —— 那条路径在观战分支就返回了，移动、攻击、
      // 装载那几条 if 一条都没走到。
      //
      // 必须排在下面的选中测试**之前**：那边点据点时如果据点恰好可达，会顺手
      // 把单位移过去并耗掉 move，这边就没得动了。
      //
      // 要遍历**所有**玩家单位，不能只试第一个：开局是紧密部署，靠地图角落的
      // 单位可能 8 个邻格里 5 个越界、剩下 3 个被队友占满，一格都动不了 ——
      // 那是合法局面，不是 bug。（这是实测踩到的：某个种子下第一个单位正好在
      // 右下角。）
      if (item.interactive) {
        const movers = board.units.filter(entry => entry.owner === 'player');
        if (!movers.length) {
          throw new Error('关掉观战后仍然没有玩家单位，用例配置有问题');
        }
        let moved = false;
        for (const mover of movers) {
          // 用 clickCell 的返回值判断，不用 summary —— summary 的 units 不带 id，
          // 同型号有多个时分不清谁动了。
          const picked = harness.debug.clickCell(mover.x, mover.y);
          if (!picked?.id) {
            continue;
          }
          for (let dy = -1; dy <= 1 && !moved; dy++) {
            for (let dx = -1; dx <= 1 && !moved; dx++) {
              if (!dx && !dy) {
                continue;
              }
              const after = harness.debug.clickCell(mover.x + dx, mover.y + dy);
              // 同一个单位 + 坐标变了 = 真的移动了。
              // 点到队友会换 id；点到走不了的格子会原地不动。两种都不算。
              moved = !!after && after.id === picked.id && (after.x !== picked.x || after.y !== picked.y);
            }
          }
          if (moved) {
            break;
          }
        }
        if (!moved) {
          throw new Error(`试遍了 ${movers.length} 个玩家单位的所有邻格，一个都没动起来（移动派发链多半断了）`);
        }
        hits += 1;
      }

      // 非观战局里不点敌人：如果它正好落在射程内，点击会走"攻击"分支，
      // 攻击完重新选中的是攻击方而不是目标格，下面那条断言就会随机地假红
      // （敌人在不在射程内取决于随机布局）。观战局没有这个问题 —— 那边
      // 一进门就被 spectator 拦住，点谁都只是选中。
      //
      // 单位位置可能已被上面的移动测试改掉，所以这里重新取一次 summary。
      const now = harness.debug.summary();
      const targets = [
        now.units.find(entry => entry.owner === 'player'),
        item.interactive ? null : now.units.find(entry => entry.owner !== 'player'),
        now.sites[0]
      ].filter(Boolean);
      if (targets.length < 2) {
        throw new Error(`可点的目标只有 ${targets.length} 个，点击测试无从下手`);
      }
      let selected = 0;
      for (const target of targets) {
        const picked = harness.debug.clickCell(target.x, target.y);
        // 点在有东西的格子上必然会选中点什么；选不中说明坐标换算错了。
        if (picked && picked.x === target.x && picked.y === target.y) {
          selected += 1;
        }
      }
      if (selected < targets.length) {
        throw new Error(`点了 ${targets.length} 个有目标的格子，只有 ${selected} 个真的选中了（多半是屏幕→格子的坐标换算错了）`);
      }
      counts.click = { hits: hits + selected };

      // 交互链：装载 / 卸载 / 攻击 / 缩放 / 拖拽 / 键盘。
      // 只在 interactive 用例里跑，因为观战局的 onBoard 一进门就 return 了。
      // 场景靠 placeUnit 直接摆出来 —— 随机开局不保证出现这些组合。
      if (item.interactive) {
        requireEntry(harness.debug, 'placeUnit');
        requireEntry(harness.debug, 'inspectCell');
        const spot = findInteractionSpots(harness);
        const results = [];
        for (const check of INTERACTION_CHECKS) {
          results.push(`${check.name}(${check.run(harness.debug, spot, harness)})`);
        }
        console.log(`       交互链 ${results.join(' · ')}`);
      }

      // 大厅层放在最后：repaintLobby 里的 renderLobbyPreview 会按下拉框重算 W / H，
      // 之后这局的棋盘尺寸就对不上了。见 __frontierDebug.repaintLobby 的注释。
      requireEntry(harness.debug, 'repaintLobby');
      counts.lobby = measure(() => harness.debug.repaintLobby());

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
  });
  if (failed) {
    console.log(`\n== ❌ ${failed}/${CASES.length + 1} 项界面检查有问题（绑定 1 项 + 用例 ${CASES.length} 项）==`);
    process.exit(1);
  }
  console.log(`\n== ✅ 界面路径正常（绑定 + ${CASES.length} 个用例）==`);
  process.exit(0);
}

main();
