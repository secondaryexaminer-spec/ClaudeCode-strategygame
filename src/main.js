// 装配层。这个文件里**没有游戏逻辑** —— 它只做三件事：
//   1. 持有全局可变状态（game、W/H/S、cam/zoom 等 8 个 let）
//   2. 用 rt 门面把这些状态以访问器的形式交给各模块
//   3. 按依赖顺序创建模块，把成品接到一起
//
// 想改游戏行为，去对应的模块文件，不要往这里加函数。
import { createOwners } from './core/owners.js';
import { createQueries } from './core/queries.js';
import { createTiming } from './core/timing.js';
import { createMovement } from './game/movement.js';
import { createCombat } from './game/combat.js';
import { createStats } from './game/stats.js';
import { createBuild } from './game/build.js';
import { createTurn } from './game/turn.js';
import { createTurnFlow } from './game/turnflow.js';
import { createNewGame } from './game/newgame.js';
import { createTransport } from './game/transport.js';
import { createSaves } from './io/saves.js';
import { createWorldgen } from './world/worldgen.js';
import { createScoring } from './ai/scoring.js';
import { createPathing } from './ai/pathing.js';
import { createScripted } from './ai/scripted.js';
import { createIntent } from './ai/intent.js';
import { createDecide } from './ai/decide.js';
import { createTurnLoop } from './ai/turnloop.js';
import { createBoardRenderer } from './render/board.js';
import { createStatsRenderer } from './render/stats.js';
import { createPanels } from './ui/panels.js';
import { createInput } from './ui/input.js';
import { createNotify } from './ui/notify.js';
import { createLobby } from './ui/lobby.js';
import { createScreens } from './ui/screens.js';
import { createBindings } from './ui/bindings.js';
import { createDebugHooks } from './debug/hooks.js';
import { createFastSim } from './debug/fastsim.js';
import { rankFromKills, effectiveMove } from './game/entities.js';
import { typeMeta } from './core/utils.js';

(() => {
  'use strict';

  const canvas = document.getElementById('board');
  const ctx = canvas.getContext('2d');
  const $ = id => document.getElementById(id);

  // ── 全局可变状态。整个项目只有这里持有它们，其余模块一律通过 rt 读写。 ──
  // W/H 是地图格数，S 是每格像素边长。三者由 newGame / loadPayload 设定。
  let W = 28;
  let H = 16;
  let S = 40;
  let cam = { x: 0, y: 0 };
  let zoom = 1;
  let currentSaveKey = null;
  let game = null;
  let fastSim = false;

  // 运行时门面：把上面那些闭包变量和各模块的成品函数，以访问器的形式交给所有模块。
  //
  // 【为什么用 getter 而不是直接传值】
  // 开新局时 game 会被整体替换，getter 保证模块永远读到最新的那个，不会攥着旧引用。
  // 这是这套写法相对「全局状态单例」的关键好处：状态只有一处真相（上面那几个 let），
  // 没有需要手动同步的副本。
  //
  // 【惰性转发的规则，违反了会 TDZ 报错】
  // 这个对象字面量在任何 createXxx(rt) 之前就求值完了。所以：
  //   - 指向下面才创建的模块 → **必须**写成箭头函数转发
  //   - 指向 main.js 自己的东西 → 可以用简写属性
  // 比如 checkEnd 住在 game/turn.js 里，写成 `checkEnd,` 会在这一行就去读还没初始化
  // 的 const，直接 TDZ 报错。这条链断了的表现是「战斗能打但对局永远不结束」。
  //
  // 【写入口都是函数，不是裸 setter】
  // setDimensions / setCellSize / setGame / resetCamera / setFastSim 各自对应一个
  // 明确的场景。用函数而不是 `set W(v)`，是因为这些值几乎从不单独改 —— W 和 H 永远
  // 一起改，cam 和 zoom 复位也永远一起。分开写迟早会漏一个。
  // 例外是 zoom 和 currentSaveKey，它们确实会被单独改（滚轮缩放、存档回写）。
  //
  // ⚠️ 装配顺序不能乱，见下面的创建链。转发本身是惰性的，但解构出来的 const 不是。
  let turnApi;
  let transportApi;
  let scoringApi;
  let combatApi;
  let buildApi;
  let pathingApi;
  let intentApi;
  let boardApi;
  let savesApi;
  let ownersApi;
  let queriesApi;
  let statsApi;
  let notifyApi;
  let timingApi;
  let turnFlowApi;
  let panelsApi;
  let statsRenderApi;
  let screensApi;
  const rt = {
    // ── 状态读取 ──
    get game() { return game; },
    get W() { return W; },
    get H() { return H; },
    get S() { return S; },
    get fastSim() { return fastSim; },
    get canvas() { return canvas; },
    get ctx() { return ctx; },
    get cam() { return cam; },
    get zoom() { return zoom; },
    get currentSaveKey() { return currentSaveKey; },

    // ── 状态写入 ──
    set zoom(value) { zoom = value; },
    set currentSaveKey(value) { currentSaveKey = value; },
    setFastSim: value => { fastSim = value; },
    setDimensions: (w, h) => { W = w; H = h; },
    setCellSize: value => { S = value; },
    setGame: value => { game = value; },
    resizeCanvas: (w, h) => { canvas.width = w; canvas.height = h; },
    resetCamera: () => { cam.x = 0; cam.y = 0; zoom = 1; },

    // ── core/queries.js：棋盘查询 ──
    inBounds: (x, y) => queriesApi.inBounds(x, y),
    adjacent4: (x, y) => queriesApi.adjacent4(x, y),
    adjacent8: (x, y) => queriesApi.adjacent8(x, y),
    getUnit: (x, y) => queriesApi.getUnit(x, y),
    unitsAt: (x, y) => queriesApi.unitsAt(x, y),
    getSite: (x, y) => queriesApi.getSite(x, y),
    isLandTile: (x, y) => queriesApi.isLandTile(x, y),
    isWaterTile: (x, y) => queriesApi.isWaterTile(x, y),
    isCoastalWater: (x, y) => queriesApi.isCoastalWater(x, y),
    isDeepWater: (x, y) => queriesApi.isDeepWater(x, y),

    // ── core/owners.js：阵营 ──
    teamOf: owner => ownersApi.teamOf(owner),
    areAllies: (a, b) => ownersApi.areAllies(a, b),
    areEnemies: (a, b) => ownersApi.areEnemies(a, b),
    ownerColor: owner => ownersApi.ownerColor(owner),
    ownerName: owner => ownersApi.ownerName(owner),
    ownerShort: owner => ownersApi.ownerShort(owner),
    ownerOrder: () => ownersApi.ownerOrder(),
    tierName: tier => ownersApi.tierName(tier),
    domainName: domain => ownersApi.domainName(domain),
    computeDimensions: (sizeKey, aspectKey) => ownersApi.computeDimensions(sizeKey, aspectKey),

    // ── core/timing.js ──
    pause: ms => timingApi.pause(ms),
    aiStepDelay: () => timingApi.aiStepDelay(),

    // ── game/stats.js：统计写入 ──
    ensureStatsStarted: () => statsApi.ensureStatsStarted(),
    statTimeSeconds: () => statsApi.statTimeSeconds(),
    recordStatSnapshot: label => statsApi.recordStatSnapshot(label),
    incrementStat: (bucket, owner, value) => statsApi.incrementStat(bucket, owner, value),
    incrementStrat: (owner, key, value) => statsApi.incrementStrat(owner, key, value),

    // ── ui/notify.js ──
    log: (text, kind) => notifyApi.log(text, kind),
    toast: text => notifyApi.toast(text),

    // ── game/turnflow.js ──
    captureSite: unitEntry => turnFlowApi.captureSite(unitEntry),
    advanceTurn: () => turnFlowApi.advanceTurn(),

    // ── game/turn.js ──
    checkEnd: () => turnApi.checkEnd(),
    sideLabel: () => turnApi.sideLabel(),

    // ── game/combat.js ──
    siteBonus: (siteEntry, unitEntry, key) => combatApi.siteBonus(siteEntry, unitEntry, key),
    previewCombat: (attacker, defender, fromCell, deterministic) => combatApi.previewCombat(attacker, defender, fromCell, deterministic),
    canAttack: (attacker, defender, fromCell) => combatApi.canAttack(attacker, defender, fromCell),
    attack: (attacker, defender) => combatApi.attack(attacker, defender),

    // ── game/build.js ──
    sellRefund: unitEntry => buildApi.sellRefund(unitEntry),
    ownedUnitCount: (owner, domain) => buildApi.ownedUnitCount(owner, domain),
    unitCapFor: domain => buildApi.unitCapFor(domain),
    atUnitCap: (owner, domain) => buildApi.atUnitCap(owner, domain),
    campCount: owner => buildApi.campCount(owner),
    siteUpgradeCost: siteEntry => buildApi.siteUpgradeCost(siteEntry),
    upgradeSite: (owner, siteEntry) => buildApi.upgradeSite(owner, siteEntry),
    sellUnit: (owner, unitEntry) => buildApi.sellUnit(owner, unitEntry),
    engineerBuildCells: unitEntry => buildApi.engineerBuildCells(unitEntry),
    canBuildCamp: unitEntry => buildApi.canBuildCamp(unitEntry),
    canEngineerLaunch: (unitEntry, product, cell, cargoTypes) => buildApi.canEngineerLaunch(unitEntry, product, cell, cargoTypes),
    engineerLaunch: (unitEntry, product, cell, cargoTypes) => buildApi.engineerLaunch(unitEntry, product, cell, cargoTypes),
    buildableTypes: siteEntry => buildApi.buildableTypes(siteEntry),
    buildAtSite: (owner, siteEntry, type, options) => buildApi.buildAtSite(owner, siteEntry, type, options),

    // ── game/transport.js ──
    supportSites: unitEntry => transportApi.supportSites(unitEntry),
    moveUnit: (unitEntry, x, y) => transportApi.moveUnit(unitEntry, x, y),
    loadTransport: (transport, passenger) => transportApi.loadTransport(transport, passenger),
    canLoadTransport: (transport, passenger) => transportApi.canLoadTransport(transport, passenger),
    canUnloadTransport: (transport, x, y) => transportApi.canUnloadTransport(transport, x, y),
    unloadTransport: (transport, x, y) => transportApi.unloadTransport(transport, x, y),

    // ── ai/scoring.js ──
    enemyThreat: (owner, x, y) => scoringApi.enemyThreat(owner, x, y),
    strategicLandingScore: (owner, cell) => scoringApi.strategicLandingScore(owner, cell),
    strategicSiteValue: (siteEntry, owner, unitEntry) => scoringApi.strategicSiteValue(siteEntry, owner, unitEntry),
    siteProjectionValue: (owner, siteEntry, lookahead) => scoringApi.siteProjectionValue(owner, siteEntry, lookahead),
    cityEconomyValue: (siteEntry, owner) => scoringApi.cityEconomyValue(siteEntry, owner),
    isBridgeheadSite: siteEntry => scoringApi.isBridgeheadSite(siteEntry),
    friendSupport: (owner, x, y) => scoringApi.friendSupport(owner, x, y),
    targetValue: unitEntry => scoringApi.targetValue(unitEntry),
    allyCongestion: (owner, cell, excludeId) => scoringApi.allyCongestion(owner, cell, excludeId),
    frontlineCount: (owner, target, radius) => scoringApi.frontlineCount(owner, target, radius),
    nearbyEnemies: (cell, owner, radius) => scoringApi.nearbyEnemies(cell, owner, radius),
    unitRoleCellBonus: (owner, unitEntry, cell, intent) => scoringApi.unitRoleCellBonus(owner, unitEntry, cell, intent),
    unitRoleTargetBonus: (unitEntry, enemy, intent) => scoringApi.unitRoleTargetBonus(unitEntry, enemy, intent),

    // ── ai/pathing.js ──
    futureReach: (unitEntry, lookahead) => pathingApi.futureReach(unitEntry, lookahead),
    buildDistanceField: (unitEntry, target) => pathingApi.buildDistanceField(unitEntry, target),
    hasLandReachToEnemyCity: owner => pathingApi.hasLandReachToEnemyCity(owner),
    landUnitCanReachForeignCity: unitEntry => pathingApi.landUnitCanReachForeignCity(unitEntry),

    // ── ai/intent.js ──
    logAiDecision: (owner, text) => intentApi.logAiDecision(owner, text),
    bestObjective: (owner, unitEntry, intent) => intentApi.bestObjective(owner, unitEntry, intent),
    projectedPressure: (owner, target, lookahead, excludeId) => intentApi.projectedPressure(owner, target, lookahead, excludeId),

    // ── game/movement.js ──
    reachable: unitEntry => movementApi.reachable(unitEntry),

    // ── render/board.js ──
    minZoom: () => boardApi.minZoom(),
    clampCam: () => boardApi.clampCam(),
    mapIsPanned: () => boardApi.mapIsPanned(),

    // ── core/queries.js（接上）──
    selectedUnit: () => queriesApi.selectedUnit(),
    selectedSite: () => queriesApi.selectedSite(),

    // ── io/saves.js ──
    listSaves: () => savesApi.listSaves(),

    // ── ui/screens.js ──
    loadPayload: payload => screensApi.loadPayload(payload),

    // ── 跨层的小动作。都太短，不值得为它们单开模块。 ──
    clearPendingOrder: () => {
      if (game) {
        game.pendingOrder = null;
      }
    },
    ownerExists: owner => ownersApi.ownerExists(owner),
    // 击杀累积到阈值就晋升，顺带补一点当前移动力（否则升级要等下回合才生效）。
    grantKills: (unitEntry, kills) => {
      if (!unitEntry) {
        return;
      }
      unitEntry.kills += kills;
      const nextRank = rankFromKills(unitEntry.kills);
      if (nextRank !== unitEntry.rank) {
        unitEntry.rank = nextRank;
        unitEntry.maxMove = effectiveMove(unitEntry);
        unitEntry.move = Math.max(unitEntry.move, Math.min(unitEntry.maxMove, unitEntry.move + 1));
        rt.log(`${rt.ownerName(unitEntry.owner)}的${typeMeta(unitEntry.type).name}晋升为 ${nextRank} 级老兵。`, 'system');
      }
    },
    // 界面刷新的唯一入口。fastSim 下整个界面层都不执行 —— 这既是无头模拟快的
    // 原因，也是它的盲区所在（补救见 sim/smoke-render.js）。
    refresh: () => {
      if (fastSim) {
        return;
      }
      boardApi.draw();
      panelsApi.updatePanels();
    },
    hidePauseModal: () => $('pauseModal')?.classList.add('hidden'),
    onGameOver: (win, text) => {
      $('modalTitle').textContent = win === null ? '对局结束' : win ? '胜利！' : '战败';
      $('modalText').textContent = text;
      $('statsPanel').classList.remove('hidden');
      statsRenderApi.renderStatsSummary(true);
      statsRenderApi.drawStatsChart();
      $('overlay').classList.remove('hidden');
      rt.refresh();
    }
  };

  // ── 装配链。顺序由依赖决定：被依赖的先创建。 ──
  // 转发是惰性的，但下面解构出来的 const 不是 —— 谁先谁后决定了哪些名字在哪一行可用。
  ownersApi = createOwners(rt);
  queriesApi = createQueries(rt);
  timingApi = createTiming(rt);
  statsApi = createStats(rt);
  notifyApi = createNotify(rt);
  const movementApi = createMovement(rt);
  buildApi = createBuild(rt);
  const {
    buildBudgetLeft, buildAtSite, upgradeSite, fullHealSite, aiRepair,
    sellUnit, buildCamp, engineerLaunch, canBuildCamp
  } = buildApi;
  turnApi = createTurn(rt);
  const {
    healOwner, grantIncome, decayTemporarySites, resolveStalemate,
    endGameNeutral
  } = turnApi;
  transportApi = createTransport(rt);
  combatApi = createCombat(rt);
  savesApi = createSaves(rt);
  const {
    buildSavePayload, saveAsNewSave, overwriteCurrentSave,
    importSaveToList, currentSaveName, loadSave, deleteSave, readSave
  } = savesApi;
  const {
    makeCities, makeSpecialSites, makeNavalSites, spawnLand, spawnSea
  } = createWorldgen(rt);
  scoringApi = createScoring(rt);
  const { isBridgeheadSite, frontlineCount, nearbyEnemies } = scoringApi;
  pathingApi = createPathing(rt);
  const {
    moveTransportToward, bestLanding, clearDistFieldCache, clearLandReachCache
  } = pathingApi;
  intentApi = createIntent(rt);
  const {
    frontMemory, decayFrontMemory, bestRetreatCell,
    buildStrategicIntent, summarizeIntent, unitPriority, bestObjective,
    computeUnitState, finalizeUnitState
  } = intentApi;
  const {
    autoLoadAdjacent, autoUnloadAdjacent, chooseAction,
    aiSpendGold, aiManageForces, engineerBuildChoice
  } = createDecide(rt);
  const { bridgeheadTurn, navalTurn } = createScripted(rt);
  boardApi = createBoardRenderer(rt);
  const { draw, centerCamOn } = boardApi;
  statsRenderApi = createStatsRenderer(rt);
  const { chartMetrics, renderStatsSummary, drawStatsChart } = statsRenderApi;
  panelsApi = createPanels(rt);
  const { uiState, setCargoPreset, engineerSelected } = panelsApi;
  const {
    selectRef, onBoard, endTurn,
    zoomAt, beginPan, panBy, endPan, consumeContextSuppression
  } = createInput(rt);

  // aiTurn 要 turnflow 的 advanceTurn，turnflow 又要 aiTurn 接管 AI 回合 ——
  // 两边都走 rt 或箭头转发，环在运行时才闭合。
  const { aiTurn } = createTurnLoop(rt, {
    navalTurn, bridgeheadTurn,
    buildStrategicIntent, summarizeIntent, frontMemory, unitPriority,
    computeUnitState, finalizeUnitState, bestRetreatCell, bestObjective,
    chooseAction, aiManageForces, aiSpendGold,
    autoLoadAdjacent, autoUnloadAdjacent, engineerBuildChoice,
    isBridgeheadSite, frontlineCount, nearbyEnemies,
    bestLanding, moveTransportToward, clearLandReachCache,
    buildCamp, engineerLaunch, sameCell: queriesApi.sameCell
  });
  turnFlowApi = createTurnFlow(rt, {
    decayFrontMemory, decayTemporarySites, healOwner, grantIncome, aiRepair,
    resolveStalemate, aiTurn
  });
  const { beginTurn } = turnFlowApi;

  const {
    fillSelectOptions, syncSliderLabels, renderAISettings, renderLobbyPreview,
    drawPreview, renderCodex, renderSaveList, renderRules
  } = createLobby(rt);
  // newGame 要 runLoadingScreen，startGameFlow 要 newGame。箭头转发打破这个环。
  const { newGame } = createNewGame(rt, {
    makeCities, makeNavalSites, makeSpecialSites, spawnLand, spawnSea,
    centerCamOn, clearDistFieldCache, beginTurn,
    runLoadingScreen: (owners, done) => screensApi.runLoadingScreen(owners, done)
  });
  screensApi = createScreens(rt, {
    newGame, drawPreview, renderLobbyPreview, renderSaveList,
    centerCamOn, clearDistFieldCache, clearLandReachCache, aiTurn
  });
  const { showScreen, startGameFlow } = screensApi;
  const { bindAll } = createBindings(rt, {
    renderAISettings, syncSliderLabels, renderSaveList, renderLobbyPreview,
    showScreen, startGameFlow,
    uiState, setCargoPreset, engineerSelected,
    onBoard, beginPan, panBy, endPan, zoomAt, consumeContextSuppression,
    endTurn, selectRef, draw,
    chartMetrics, drawStatsChart,
    buildAtSite, buildBudgetLeft, sellUnit, upgradeSite, fullHealSite, buildCamp,
    autoLoadAdjacent, autoUnloadAdjacent, endGameNeutral,
    buildSavePayload, saveAsNewSave, overwriteCurrentSave, importSaveToList,
    currentSaveName, loadSave, deleteSave, readSave
  });
  const { debugSummary, fastRun, fastBatch } = createFastSim(rt, {
    advanceTurn: () => turnFlowApi.advanceTurn(),
    aiTurn, newGame,
    ownerExists: owner => ownersApi.ownerExists(owner),
    macroYield: () => timingApi.macroYield()
  });

  function setup() {
    fillSelectOptions();
    syncSliderLabels();
    // 顺序不能换：renderRules 生成的 HTML 里才有 #codex 容器，
    // 先渲染图鉴的话它会找不到挂载点、静默变成空的。
    renderRules();
    renderCodex();
    renderAISettings();

    bindAll();
    // 无头测试钩子。它是 sim/ 下所有工具进入游戏内部的唯一入口，
    // 见 src/debug/hooks.js 文件头。
    window.__frontierDebug = createDebugHooks(rt, {
      debugSummary, fastRun, fastBatch, newGame, resolveStalemate,
      draw, refresh: () => rt.refresh(), renderStatsSummary, drawStatsChart,
      drawPreview, renderSaveList, renderLobbyPreview, onBoard
    });
    showScreen('setup');
  }

  document.addEventListener('DOMContentLoaded', setup);
})();
