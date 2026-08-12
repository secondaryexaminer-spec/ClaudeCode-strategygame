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

// 每层量什么、下限多少。source 指向 counts 里的哪一次测量 —— 同一次测量可以被
// 量两遍（统计层既量 ctx 也量 dom），因为它们保护的是不同的东西：
// ctx 掉下去说明折线图没画，dom 掉下去说明汇总卡的数字没填。
const LIMITS = {
  board: { source: 'board', metric: 'ctx', min: 200, label: '棋盘绘制' },
  panels: { source: 'panels', metric: 'dom', min: 30, label: '面板刷新' },
  stats: { source: 'stats', metric: 'ctx', min: 20, label: '统计图表' },
  // 汇总卡的六个数字靠 querySelectorAll('[data-final]') 逐个 textContent 填进去。
  // 原来打桩的 querySelectorAll 恒返回空数组，这段循环一次都进不去 —— 我上一轮
  // 把这记成了"打桩的天花板"，其实是打桩自己砌的墙：补上最小的 innerHTML 解析
  // 之后就跑到了，实测稳定 6 次（外加标题和 summary 各一次，共 8）。
  statsCards: { source: 'stats', metric: 'dom', min: 6, label: '汇总卡' },
  click: { source: 'click', metric: 'hits', min: 2, label: '棋盘点击' },
  lobby: { source: 'lobby', metric: 'ctx', min: 100, label: '大厅预览' }
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
  },
  {
    // 以下两条走的是**面板按钮**，不是棋盘点击。
    //
    // 这一层过去完全没有覆盖：MUST_BE_BOUND 只验"挂上了处理器"，点了会发生什么
    // 一概不管。而 bindings.js 里的面板按钮全部走事件委托，回调第一句就是
    // `event.target.closest('[data-xxx]')` —— 换句话说，只要 harness 的 closest
    // 返回 null，每个回调都在第一个 if 里 return，测试还是全绿。
    // 补上最小的 closest 实现之后这一层才真的可测（见 sim/harness.js 的 makeNode）。
    //
    // ⚠️ 变卖必须排在生产**前面**，两条链是串起来的：开局是紧密部署，己方城市上
    // 全站着单位，而 buildAtSite 要求据点那一格是空的。所以先卖掉城里的兵腾出
    // 位置，再在同一座城生产 —— 这也正好是真实的操作序列。
    //
    // 为什么要卖**两个**：开局金币 45，而后面工程师下水那条链要花 42 造运兵船。
    // 卖一个民兵只回收 8（refund = floor(cost/2)），生产再花掉 16，净支出 8，
    // 下水链就会因为差钱而失败 —— 那看起来像派发链断了，其实只是预算被这条链
    // 挤掉了。卖两个至少 +16、生产一个 -16，净支出不为正，两条链互不干扰。
    //
    // 两个卖的目的不同：第一个必须是**城里那个**（腾出据点格），第二个是任意
    // 己方单位（纯粹筹钱）。实测 coast 图上只有一座己方城市站着兵，所以不能
    // 要求"两座有驻军的城"。
    name: '面板变卖',
    run(debug, spot, harness) {
      const before = debug.summary();
      const city = before.sites.find(entry => {
        if (entry.owner !== 'player' || entry.kind !== 'city') {
          return false;
        }
        const occupant = debug.inspectCell(entry.x, entry.y);
        return occupant && occupant.owner === 'player';
      });
      if (!city) {
        throw new Error('找不到"己方城市上站着己方单位"的位置，变卖与生产链都无从下手');
      }
      const spare = before.units.find(entry => entry.owner === 'player' && (entry.x !== city.x || entry.y !== city.y));
      if (!spare) {
        throw new Error('除了城里那个之外没有别的己方单位，凑不出生产链要的预算');
      }
      const sold = [];
      for (const at of [city, spare]) {
        const picked = debug.clickCell(at.x, at.y);
        if (!picked?.id) {
          throw new Error(`点 (${at.x},${at.y}) 的己方单位没有选中，变卖链无从下手`);
        }
        if (!harness.dispatchOn('selActions', 'click', { dataset: { unitAction: 'sell' } })) {
          throw new Error('selActions 上没有 click 处理器（事件委托没绑上）');
        }
        sold.push(at);
      }
      const after = debug.summary();
      if (after.units.length !== before.units.length - 2) {
        throw new Error(`点变卖按钮单位没有消失（${before.units.length} → ${after.units.length}，期望 -2）`);
      }
      // 交给下一条链，见上面的顺序说明。
      spot.emptiedCity = city;
      return `卖掉 ${sold.length} 个（含 ${city.name} 驻军）`;
    }
  },
  {
    name: '面板生产',
    run(debug, spot, harness) {
      const city = spot.emptiedCity;
      if (!city) {
        throw new Error('上一条变卖链没有腾出城市（它应该先跑）');
      }
      if (debug.inspectCell(city.x, city.y)) {
        throw new Error(`${city.name} 那一格还站着单位，buildAtSite 会直接拒绝`);
      }
      const before = debug.summary();
      debug.clickCell(city.x, city.y);
      const fired = harness.dispatchOn('buildGrid', 'click', { dataset: { type: 'militia' } });
      if (!fired) {
        throw new Error('buildGrid 上没有 click 处理器（事件委托没绑上）');
      }
      const after = debug.summary();
      if (after.units.length !== before.units.length + 1) {
        throw new Error(`点生产按钮没造出单位（${before.units.length} → ${after.units.length}，民兵 16 金，开局 45 金）`);
      }
      return `${city.name} 造出 militia`;
    }
  },
  {
    // 存档链路过去一条都没跑过 —— 不是因为难测，是因为 harness 没装 localStorage，
    // 于是 saveStore.available 恒为 false，保存和读档**静默**变成空操作。
    // 装上内存版之后这条链才成立（见 sim/harness.js 里 localStorage 打桩的注释）。
    //
    // 断言的是**往返一致**而不只是"没抛错"：存 → 改局面 → 读回来 → 局面复原。
    // 这样序列化漏字段、loadPayload 没恢复、存档行的 data-key 拼错，都会被抓住。
    name: '存档往返',
    run(debug, spot, harness) {
      harness.storageClear();
      const before = debug.summary();
      harness.dispatchOn('btnSaveGame', 'click');
      if (!harness.dispatchOn('btnSaveConfirm', 'click')) {
        throw new Error('btnSaveConfirm 上没有 click 处理器');
      }
      const keys = harness.storageKeys().filter(key => key.startsWith('frontier_save_'));
      if (keys.length !== 1) {
        throw new Error(`保存后存档条目有 ${keys.length} 份，期望 1 份（localStorage 打桩没接上？）`);
      }
      // 故意把局面改脏：多摆两个单位，读档后必须消失。
      // 少了这一步，"读档没做任何事"和"读档正确恢复"在断言上分不出来。
      debug.placeUnit('militia', 'player', spot.landA.x, spot.landA.y);
      debug.placeUnit('militia', 'player', spot.landB.x, spot.landB.y);
      if (debug.summary().units.length !== before.units.length + 2) {
        throw new Error('placeUnit 没有把局面改脏，往返断言会失去意义');
      }
      // 进读档页会触发 renderSaveList，把存档行写进 saveListBody 的 innerHTML；
      // 点击那一行走的是 `.save-row` 的委托，靠 dataset.key 认出选的是哪一份。
      harness.dispatchOn('btnLoadPage', 'click');
      if (!harness.dispatchOn('saveListBody', 'click', { className: 'save-row', dataset: { key: keys[0] } })) {
        throw new Error('saveListBody 上没有 click 处理器');
      }
      if (!harness.dispatchOn('btnLoadConfirm', 'click')) {
        throw new Error('btnLoadConfirm 上没有 click 处理器');
      }
      const after = debug.summary();
      if (after.units.length !== before.units.length) {
        throw new Error(`读档后单位数没有复原（存档时 ${before.units.length}、改脏后 ${before.units.length + 2}、读回来 ${after.units.length}）`);
      }
      if (after.turn !== before.turn) {
        throw new Error(`读档后回合数不对（${before.turn} → ${after.turn}）`);
      }
      // 导出走的是另一条路（Blob + createObjectURL），顺带验一下别抛错。
      harness.dispatchOn('btnSaveExport', 'click');
      const exported = harness.downloads();
      if (!exported.length || !exported[exported.length - 1].includes('"state"')) {
        throw new Error('导出没有产生带 state 字段的存档文件');
      }
      return `${before.units.length} 单位往返一致 · 导出 ${exported.length} 份`;
    }
  },
  {
    // 存档版本迁移。这两条路径靠正常保存永远走不到 —— 正常保存写出来的都是
    // 当前版本，所以必须手工把存档塞进存储里构造出来。
    //
    // 没有这条链的话，io/savestate.js 的 migrateSaveState 整个是死代码：
    // 迁移写错了不会有任何征兆，直到某天用户拿着老存档打不开。
    name: '存档迁移',
    run(debug, spot, harness) {
      const key = harness.storageKeys().find(entry => entry.startsWith('frontier_save_'));
      if (!key) {
        throw new Error('存储里没有存档，迁移链要接在存档往返链后面');
      }
      const current = JSON.parse(harness.storageGet(key));
      if (!current.version) {
        throw new Error('当前保存的存档没有 version 字段（toSaveState 没写进去？）');
      }
      const saved = current.state.units.length;

      // ⚠️ 每次尝试读档**之前必须把局面改脏**，否则"读了"和"没读"分不出来 ——
      // 这几份测试存档都是当前局面的快照，不改脏的话两种结果的单位数一模一样，
      // 断言就是摆设。这是实测踩到的：第一版写完跑阳性对照，三条 0/3 全部
      // "改坏后依然全绿"。
      const makeDirty = () => {
        debug.placeUnit('militia', 'player', spot.landA.x, spot.landA.y);
        return debug.summary().units.length;
      };
      const tryLoad = storageKey => {
        harness.dispatchOn('btnLoadPage', 'click');
        if (!harness.dispatchOn('saveListBody', 'click', { className: 'save-row', dataset: { key: storageKey } })) {
          throw new Error('saveListBody 上没有 click 处理器');
        }
        if (!harness.dispatchOn('btnLoadConfirm', 'click')) {
          throw new Error('btnLoadConfirm 上没有 click 处理器');
        }
        return debug.summary().units.length;
      };

      // ① 老存档：加版本号之前存下来的档没有 version 字段，应当被当作版本 1
      //    迁移上来，正常读出 —— 也就是说局面要复原。
      const legacy = { ...current };
      delete legacy.version;
      harness.storageSet('frontier_save_legacy', JSON.stringify(legacy));
      const dirtyA = makeDirty();
      const afterLegacy = tryLoad('frontier_save_legacy');
      if (afterLegacy !== saved) {
        throw new Error(`无 version 字段的老存档没能正常读出（存档里 ${saved} 个单位，改脏后 ${dirtyA}，读完 ${afterLegacy}）`);
      }

      // ② 未来存档：版本号比当前支持的还新，必须**拒绝**而不是硬读 ——
      //    硬读的表现是能开局但行为诡异，比直接报错难查得多。
      //    拒绝的表现就是局面保持脏。
      const future = { ...current, version: current.version + 99 };
      harness.storageSet('frontier_save_future', JSON.stringify(future));
      const dirtyB = makeDirty();
      const afterFuture = tryLoad('frontier_save_future');
      if (afterFuture !== dirtyB) {
        throw new Error(`版本号超前的存档被读进来了，应当拒绝（改脏后 ${dirtyB}，读完 ${afterFuture}）`);
      }

      // ③ 残档：state 里缺必需字段。同样必须在入口拦住 —— 少了 goldByOwner
      //    这类字段不会在读档那一刻崩，而是等到某个 AI 要算钱时才炸。
      const broken = { ...current, state: { ...current.state } };
      delete broken.state.goldByOwner;
      harness.storageSet('frontier_save_broken', JSON.stringify(broken));
      const dirtyC = makeDirty();
      const afterBroken = tryLoad('frontier_save_broken');
      if (afterBroken !== dirtyC) {
        throw new Error(`缺少必需字段的残档被读进来了，应当拒绝（改脏后 ${dirtyC}，读完 ${afterBroken}）`);
      }

      // ④ 设置被改坏的存档：能读，但非法的 settings 要被规范化掉。
      //    和上面三条不同 —— 这一条要求**读得进来**，只是把烂值换成默认值。
      //    没有它的话 core/rules.js 的 normalizeRules 就是死代码：写错了不会
      //    有任何征兆，而一个 NaN 会顺着 settings 飘进布点，直到某个坐标算出
      //    NaN 才炸。
      const messy = { ...current, state: { ...current.state, settings: { ...current.state.settings } } };
      messy.state.settings.spread = 'not-a-number';
      messy.state.settings.buildCap = 99999;
      harness.storageSet('frontier_save_messy', JSON.stringify(messy));
      const dirtyD = makeDirty();
      const afterMessy = tryLoad('frontier_save_messy');
      if (afterMessy !== saved) {
        throw new Error(`设置被改坏的存档没能读进来（改脏后 ${dirtyD}，读完 ${afterMessy}，期望 ${saved}）`);
      }
      const fixedSettings = debug.settings();
      if (!Number.isFinite(fixedSettings.spread)) {
        throw new Error(`读档后 settings.spread 仍然不是数字（${fixedSettings.spread}），normalizeRules 没生效`);
      }
      if (fixedSettings.buildCap > 100) {
        throw new Error(`读档后 settings.buildCap 是 ${fixedSettings.buildCap}，超出控件范围 100，没有被钳制`);
      }
      return `v${current.version} · 老档可迁移、超前档与残档被拒、烂设置被修正`;
    }
  }
];

// 大厅的 change 重渲染。
//
// ⚠️ 必须单独放在**所有**用例内容之后跑，不能并进 INTERACTION_CHECKS：
// renderLobbyPreview 会按大厅下拉框重算 W / H，而 counts.lobby 里的 drawPreview
// 读的是当前这局的 game.terrain —— 顺序反了会越界读出 undefined。
// 这和 __frontierDebug.repaintLobby 的注释是同一个坑。
function checkLobbyRerender(harness) {
  harness.resetCtxCalls();
  const mapFired = harness.dispatchOn('mapSelect', 'change');
  if (!mapFired) {
    throw new Error('mapSelect 上没有 change 处理器（换地图不会重画预览）');
  }
  const ctx = harness.ctxCalls();
  if (ctx < LIMITS.lobby.min) {
    throw new Error(`换地图后大厅预览只画了 ${ctx} 次（下限 ${LIMITS.lobby.min}），重渲染多半没跑`);
  }
  harness.resetDomWrites();
  const aiFired = harness.dispatchOn('aiSelect', 'change');
  if (!aiFired) {
    throw new Error('aiSelect 上没有 change 处理器（改 AI 数量不会重建设置面板）');
  }
  const dom = harness.domWrites();
  if (dom < 1) {
    throw new Error('改 AI 数量没有产生任何 DOM 写入（renderAISettings 没跑）');
  }
  return `换地图 ${ctx} 次绘制 · 改 AI 数量 ${dom} 次写入`;
}

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

// 装上种子化随机数，返回还原函数。
//
// 用固定种子跑，理由和 verify 一样：布点、地形、初始兵力、**战斗结果**全靠
// Math.random，不固定的话每次跑的都是不同的局 —— 断言就会时绿时红，而红的原因
// 往往是"这次敌人恰好离得近"而不是代码坏了（实际踩到过两次：点敌人有时触发
// 攻击分支；交互链里同一次攻击跑出过"10→1""10→2""目标阵亡"三种结果）。
// 和 fastBatch 用的是同一个 LCG，跑完必须还原，否则会污染后续用例。
//
// 分成 beginSeed / withSeed 两个形式是为了 diff 干净：用例体有一百多行，
// 包成闭包会让整段缩进全变。长段落用 beginSeed + finally，短调用用 withSeed。
function beginSeed(seed) {
  const orig = Math.random;
  let state = seed >>> 0;
  Math.random = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
  return () => { Math.random = orig; };
}

function withSeed(seed, fn) {
  const restore = beginSeed(seed);
  try {
    return fn();
  } finally {
    restore();
  }
}

// 地图定义自检：12 张图 × 3 复杂度 × 3 尺寸各生成一次地形。
//
// 为什么单独有这一项：verify 的 6 个场景只用到 4 张图，上面 4 个用例再补 2 张
// —— 12 张里有一半从来没有任何测试跑过。地图定义数据化之后（core/mapdefs.js），
// 一张图的 steps 写错只会毁掉那一张图，而那张图可能永远没人跑，也就永远不会红。
//
// 断言三件事，每件都能抓住一类真实的写错：
//   1. 不抛错          —— op 拼错、少字段
//   2. 地形值合法      —— fill 写了个不存在的地形名
//   3. sea 标记要兑现  —— 声明有海的图必须真的生成出水格。这条最要紧：
//      海图没海不会抛错，只会让运输、登陆、船厂那一整套逻辑在那张图上静默失效。
const TERRAIN_VALUES = new Set(['plain', 'forest', 'mountain', 'road', 'water']);
const MAP_PROBE_SIZES = [[28, 16], [40, 22], [20, 12]];
const MAP_PROBE_COMPLEXITIES = ['low', 'medium', 'high'];

function checkAllMaps(harness) {
  requireEntry(harness.debug, 'probeTerrain');
  requireEntry(harness.debug, 'mapCatalog');
  const catalog = harness.debug.mapCatalog();
  if (catalog.length < 2) {
    throw new Error(`地图清单只有 ${catalog.length} 张，mapCatalog 多半没接上`);
  }
  let probes = 0;
  for (const entry of catalog) {
    for (const complexity of MAP_PROBE_COMPLEXITIES) {
      for (const [w, h] of MAP_PROBE_SIZES) {
        // 固定种子：地形生成消耗随机数，不固定的话"这张图有没有水"会时真时假。
        const grid = withSeed(SEED, () => harness.debug.probeTerrain(entry.id, complexity, w, h));
        probes += 1;
        if (!Array.isArray(grid) || grid.length !== h || grid.some(row => row.length !== w)) {
          throw new Error(`${entry.name}(${entry.id}) 在 ${w}x${h} 下没有产出对应尺寸的地形`);
        }
        let water = 0;
        for (const row of grid) {
          for (const cell of row) {
            if (!TERRAIN_VALUES.has(cell)) {
              throw new Error(`${entry.name}(${entry.id}) 生成了非法地形值 "${cell}"`);
            }
            if (cell === 'water') {
              water += 1;
            }
          }
        }
        if (entry.sea && !water) {
          throw new Error(`${entry.name}(${entry.id}) 声明了 sea: true，却在 ${complexity}/${w}x${h} 下一格水都没有`);
        }
      }
    }
  }
  return `${catalog.length} 张图 · ${probes} 次生成`;
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

  // 地图定义自检。和用例无关，跑一次即可。
  try {
    console.log(`  OK   地图定义       ${checkAllMaps(harness)}`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL 地图定义（src/core/mapdefs.js）`);
    console.log(`       ${(err && err.message) || err}`);
  }
  CASES.forEach((item, index) => {
    harness.setConfig(baseConfig(item.config));
    // 整个用例都在固定种子下跑，不只是 newGame —— 交互链里的战斗同样消耗随机数，
    // 只包 newGame 会让同一次攻击在"打残"和"打死"之间摇摆（实测跑出过三种结果）。
    // 当前的断言宽容到不会因此假红，但下一条更严格的断言就会时绿时红。
    const restoreRandom = beginSeed(SEED + index * 2654435761);
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
      for (const [, limit] of Object.entries(LIMITS)) {
        const actual = counts[limit.source][limit.metric];
        if (actual < limit.min) {
          throw new Error(`${limit.label}只产生了 ${actual} 次 ${limit.metric} 调用（下限 ${limit.min}），这一层多半没真正执行`);
        }
        parts.push(`${limit.label} ${String(actual).padStart(5)}`);
      }
      // 大厅的 change 重渲染。放在这里是因为它会按下拉框重算 W / H —— 前面所有
      // 依赖当前局尺寸的测量都必须已经跑完。
      const lobbyRerender = checkLobbyRerender(harness);
      const summary = harness.debug.summary();
      console.log(`  OK   ${item.id.padEnd(12)} 单位 ${String(summary.units.length).padStart(3)} · 据点 ${String(summary.sites.length).padStart(3)} · ${parts.join(' · ')}`);
      console.log(`       大厅重渲染 ${lobbyRerender}`);
    } catch (err) {
      failed += 1;
      console.log(`  FAIL ${item.id}`);
      console.log(`       ${(err && err.message) || err}`);
    } finally {
      // 必须还原，否则后续用例（以及进程里别的东西）会继续跑在这个种子上。
      restoreRandom();
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
