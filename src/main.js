import {
  TEAMS, OWNER_NAMES, OWNER_COLORS, COLOR_PRESETS,
  CITY_NAMES, PORT_NAMES, FORT_NAMES, OIL_NAMES, BARRACK_NAMES,
  VIEW_MAX_W, VIEW_MAX_H, CAMP_DURATION, CAMP_COST, CITY_INCOME_BY_TIER, UNIT_RANK_THRESHOLDS,
  TYPES, SITE_META, TERRAIN, MAPS, MODES, SIZES, ASPECTS, COMPLEX, DIFF, AGG,
  MAX_TURNS, MAX_CAMPS_PER_SIDE, MAX_STACK, FERRY_THROUGHPUT, BRIDGEHEAD_DEFEND_FRACTION
} from './core/constants.js';
import {
  cellKey, rnd, clamp, dist, shuffle,
  diagonalDist, inUnitRange, siteMeta, siteStars, typeMeta, colorOptions
} from './core/utils.js';
import { inBounds as gridInBounds, adjacent4 as gridAdjacent4, adjacent8 as gridAdjacent8 } from './core/grid.js';
import { terrainFor } from './world/mapgen.js';
import { createMovement } from './game/movement.js';
import { createCombat } from './game/combat.js';
import { createSaves, downloadSaveFile } from './io/saves.js';
import {
  randomId, unit, createCargoPayload, createLoadedTransport, site, createCamp,
  cargoOptionTypes, normalizeCargoTypes, transportCost, cargoLabel, describeCargo,
  rankFromKills, effectiveMove, healMultiplier
} from './game/entities.js';
import { createBuild } from './game/build.js';
import { createTurn } from './game/turn.js';
import { createNewGame } from './game/newgame.js';
import { createWorldgen, pickSpacedCells, farthestPointSample, distributeCells } from './world/worldgen.js';
import { createTransport } from './game/transport.js';
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
import { createLobby } from './ui/lobby.js';
import { createScreens } from './ui/screens.js';
import { createBindings } from './ui/bindings.js';
import { createDebugHooks } from './debug/hooks.js';
import { createFastSim } from './debug/fastsim.js';

(() => {
  'use strict';

  const canvas = document.getElementById('board');
  const ctx = canvas.getContext('2d');
  const $ = id => document.getElementById(id);

  let W = 28;
  let H = 16;
  let S = 40;
  let cam = { x: 0, y: 0 };
  let zoom = 1;
  let selectedSaveKey = null;
  let currentSaveKey = null;
  let toastTimer = null;
  let game = null;
  let fastSim = false;

  // 以下三个是 core/grid.js 的薄封装，替调用方补上当前地图尺寸 W、H。
  // 原来的 grid() 只被地形生成使用，已随 terrainFor 一起移入 world/mapgen.js。
  function inBounds(x, y) {
    return gridInBounds(W, H, x, y);
  }

  function adjacent4(x, y) {
    return gridAdjacent4(W, H, x, y);
  }

  function adjacent8(x, y) {
    return gridAdjacent8(W, H, x, y);
  }

  function ownerColor(owner) {
    if (game?.ownerColors?.[owner]) {
      return game.ownerColors[owner];
    }
    if (owner === 'player') {
      return '#55a3ff';
    }
    if (owner === 'neutral') {
      return '#d4b15a';
    }
    return OWNER_COLORS[Number(owner.slice(2))] || OWNER_COLORS[0];
  }

  function selectedSite() {
    return game?.selected?.kind === 'site' ? game.selected.ref : game?.selected?.site || null;
  }

  function selectedUnit() {
    if (!game?.selected) {
      return null;
    }
    return game.selected.kind === 'unit' ? game.selected.ref : game.selected.unit || null;
  }

  function ensureStatsStarted() {
    if (game && !game.stats.startTime) {
      game.stats.startTime = Date.now();
      recordStatSnapshot('start');
    }
  }

  function emptyOwnerMap(seed = 0) {
    return Object.fromEntries(game.ownerOrder.map(owner => [owner, seed]));
  }

  function statTimeSeconds() {
    if (!game?.stats?.startTime) {
      return 0;
    }
    const end = game.stats.endTime || Date.now();
    return Math.max(0, Math.round((end - game.stats.startTime) / 1000));
  }

  function recordStatSnapshot(label = '') {
    if (!game?.stats) {
      return;
    }
    game.stats.history.push({
      label,
      time: statTimeSeconds(),
      produced: { ...game.stats.produced },
      kills: { ...game.stats.kills },
      losses: { ...game.stats.losses },
      captures: { ...game.stats.captures },
      lostSites: { ...game.stats.lostSites }
    });
  }

  function incrementStat(bucket, owner, value = 1) {
    if (!game?.stats?.[bucket]?.[owner] && game?.stats?.[bucket]?.[owner] !== 0) {
      return;
    }
    game.stats[bucket][owner] += value;
  }

  function incrementStrat(owner, key, value = 1) {
    const bucket = game?.stats?.strat?.[owner];
    if (!bucket || typeof bucket[key] !== 'number') {
      return;
    }
    bucket[key] += value;
  }

  function showStatsPanel() {
    if (!game?.stats) {
      return;
    }
    game.stats.endTime = Date.now();
    recordStatSnapshot('finish');
    $('statsPanel').classList.remove('hidden');
    renderStatsSummary(true);
    drawStatsChart();
  }

  function pause(ms) {
    if (fastSim) {
      return Promise.resolve();
    }
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function macroYield() {
    if (typeof setImmediate === 'function') {
      return new Promise(resolve => setImmediate(resolve));
    }
    return new Promise(resolve => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => resolve();
      channel.port2.postMessage(0);
    });
  }

  function aiStepDelay() {
    if (game?.settings?.spectator) {
      return 0;
    }
    return Math.max(120, Math.round((game?.settings?.aiSpeed || 3) * 1000 / 10));
  }

  function teamOf(owner) {
    return game?.teams?.[owner] || 'A';
  }

  function areAllies(a, b) {
    if (!a || !b) {
      return false;
    }
    if (a === b) {
      return true;
    }
    if (a === 'neutral' || b === 'neutral') {
      return false;
    }
    return teamOf(a) === teamOf(b);
  }

  function areEnemies(a, b) {
    return !!a && !!b && a !== 'neutral' && b !== 'neutral' && !areAllies(a, b);
  }

  function ownerName(owner) {
    if (owner === 'player') {
      return `蓝方·${teamOf(owner)}组`;
    }
    if (owner === 'neutral') {
      return '中立势力';
    }
    return `${OWNER_NAMES[Number(owner.slice(2))] || '敌军'}·${teamOf(owner)}组`;
  }

  function ownerShort(owner) {
    if (owner === 'player') {
      return '你方';
    }
    if (owner === 'neutral') {
      return '中立';
    }
    return `AI ${Number(owner.slice(2)) + 1}`;
  }

  function tierName(tier) {
    return ['', '初级', '中级', '高级'][tier] || '特殊';
  }

  function domainName(domain) {
    return domain === 'sea' ? '海军' : '陆军';
  }

  function computeDimensions(sizeKey, aspectKey) {
    const base = SIZES[sizeKey];
    const ratio = ASPECTS[aspectKey].ratio;
    const area = base.cells;
    let width = Math.max(16, Math.round(Math.sqrt(area * ratio)));
    let height = Math.max(12, Math.round(area / width));
    if (aspectKey === 'tall' && height < width) {
      [width, height] = [height, width];
    }
    if (aspectKey === 'wide' && width < height) {
      [width, height] = [height, width];
    }
    return { w: width, h: height };
  }

  function getUnit(x, y) {
    return game.units.find(entry => entry.x === x && entry.y === y);
  }

  function unitsAt(x, y) {
    return game.units.filter(entry => entry.x === x && entry.y === y);
  }

  function getSite(x, y) {
    return game.sites.find(entry => entry.x === x && entry.y === y);
  }

  function isLandTile(x, y) {
    return inBounds(x, y) && game.terrain[y][x] !== 'water' && game.terrain[y][x] !== 'mountain';
  }

  function isWaterTile(x, y) {
    return inBounds(x, y) && game.terrain[y][x] === 'water';
  }

  function isCoastalWater(x, y) {
    return isWaterTile(x, y) && adjacent8(x, y).some(cell => isLandTile(cell.x, cell.y));
  }

  function isDeepWater(x, y) {
    if (!isWaterTile(x, y)) {
      return false;
    }
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        if (isLandTile(x + dx, y + dy)) {
          return false;
        }
      }
    }
    return true;
  }

  function ownerOrder() {
    return game ? game.ownerOrder : [];
  }

  function sameCell(a, b) {
    return !!a && !!b && a.x === b.x && a.y === b.y;
  }

  function grantKills(unitEntry, kills) {
    if (!unitEntry) {
      return;
    }
    unitEntry.kills += kills;
    const nextRank = rankFromKills(unitEntry.kills);
    if (nextRank !== unitEntry.rank) {
      unitEntry.rank = nextRank;
      unitEntry.maxMove = effectiveMove(unitEntry);
      unitEntry.move = Math.max(unitEntry.move, Math.min(unitEntry.maxMove, unitEntry.move + 1));
      log(`${ownerName(unitEntry.owner)}的${typeMeta(unitEntry.type).name}晋升为 ${nextRank} 级老兵。`, 'system');
    }
  }

  function clearPendingOrder() {
    if (game) {
      game.pendingOrder = null;
    }
  }

  function ownerExists(owner) {
    return game.units.some(entry => entry.owner === owner) || game.sites.some(entry => entry.owner === owner);
  }

  // 运行时门面：把 main.js 闭包里的可变状态和服务函数，以访问器的形式交给已拆出的模块。
  //
  // game / W / H 用 getter 而不是直接取值 —— 开新局时 game 会被整体替换，getter
  // 保证模块永远读到最新的那个，不会攥着旧引用。这是这套写法相对「全局状态单例」
  // 的关键好处：状态只有一处真相（main.js 的闭包变量），没有需要手动同步的副本。
  //
  // 随着后续模块继续拆出，这个门面会不断变长；等 main.js 里只剩装配代码时，它
  // 自然就成了 core/state.js。现在还不值得单独建文件，因为它的每一项都直接指向
  // main.js 的闭包。
  //
  // currentSaveKey 带 setter：io/saves.js 存档/读档成功后要回写它。写路径同样只有
  // 一处真相 —— setter 改的就是下面那个 let，不存在模块自己留一份的问题。
  //
  // checkEnd 必须写成惰性转发而不是简写属性：它现在住在 game/turn.js 里，是下面
  // 才创建的 turnApi 的一个方法。写成 `checkEnd,` 会在这一行就去读还没初始化的
  // const，直接 TDZ 报错。combat.js 靠 rt.checkEnd 结束对局，这条链断了的表现是
  // 「战斗能打但对局永远不结束」。
  //
  // 下面所有 xxxApi 变量都是同一个道理：模块之间互相要用对方的函数，而对象字面量
  // 在任何 createXxx(rt) 之前就求值完了。凡是指向「已拆出模块」的项，一律写成
  // 箭头函数转发。规则很简单：指向 main.js 自己的函数用简写，指向模块的用箭头。
  //
  // ⚠️ 装配顺序不能乱：rt → movement → build → turn → transport → worldgen →
  // scoring → pathing。转发本身是惰性的，但解构出来的 const 不是 —— 谁先谁后
  // 决定了哪些名字在哪一行可用。
  let turnApi;
  let transportApi;
  let scoringApi;
  let combatApi;
  let buildApi;
  let pathingApi;
  let intentApi;
  let boardApi;
  let savesApi;
  const rt = {
    get game() { return game; },
    get W() { return W; },
    get H() { return H; },
    get S() { return S; },
    get fastSim() { return fastSim; },
    // 只有 debug/fastsim.js 会写它 —— 见那个文件对 fastSim 开关的说明。
    setFastSim: value => { fastSim = value; },
    get canvas() { return canvas; },
    get ctx() { return ctx; },
    get cam() { return cam; },
    get zoom() { return zoom; },
    // zoom 带 setter：ui/input.js 的滚轮缩放要写它。cam 是对象，改字段即可，
    // 不需要 setter。
    set zoom(value) { zoom = value; },
    ownerColor, selectedUnit, selectedSite,
    statTimeSeconds, domainName, toast, ensureStatsStarted,
    computeDimensions,
    // 大厅预览按当前选的尺寸/纵横比重算 W、H，见 ui/lobby.js 文件头。
    // 用一个函数而不是两个 setter：W 和 H 永远一起改，分开写迟早会漏一个。
    setDimensions: (w, h) => { W = w; H = h; },
    setCellSize: value => { S = value; },
    setGame: value => { game = value; },
    resizeCanvas: (w, h) => { canvas.width = w; canvas.height = h; },
    // 换局/读档时把视角复位。cam 是对象所以能直接改字段，zoom 得赋值。
    resetCamera: () => { cam.x = 0; cam.y = 0; zoom = 1; },
    listSaves: () => savesApi.listSaves(),
    sideLabel: () => turnApi.sideLabel(),
    siteBonus: (siteEntry, unitEntry, key) => combatApi.siteBonus(siteEntry, unitEntry, key),
    sellRefund: unitEntry => buildApi.sellRefund(unitEntry),
    get currentSaveKey() { return currentSaveKey; },
    set currentSaveKey(value) { currentSaveKey = value; },
    inBounds, adjacent4, adjacent8,
    unitsAt, captureSite,
    getUnit, getSite, isLandTile, isWaterTile, isCoastalWater, isDeepWater,
    areAllies, areEnemies, ownerName, ownerShort, teamOf, tierName, ownerOrder,
    supportSites: unitEntry => transportApi.supportSites(unitEntry),
    moveUnit: (unitEntry, x, y) => transportApi.moveUnit(unitEntry, x, y),
    reachable: unitEntry => reachable(unitEntry),
    enemyThreat: (owner, x, y) => scoringApi.enemyThreat(owner, x, y),
    strategicLandingScore: (owner, cell) => scoringApi.strategicLandingScore(owner, cell),
    log, incrementStat, incrementStrat, recordStatSnapshot, grantKills,
    logAiDecision: (owner, text) => intentApi.logAiDecision(owner, text),
    refresh, pause, aiStepDelay, advanceTurn,
    strategicSiteValue: (siteEntry, owner, unitEntry) => scoringApi.strategicSiteValue(siteEntry, owner, unitEntry),
    siteProjectionValue: (owner, siteEntry, lookahead) => scoringApi.siteProjectionValue(owner, siteEntry, lookahead),
    cityEconomyValue: (siteEntry, owner) => scoringApi.cityEconomyValue(siteEntry, owner),
    isBridgeheadSite: siteEntry => scoringApi.isBridgeheadSite(siteEntry),
    friendSupport: (owner, x, y) => scoringApi.friendSupport(owner, x, y),
    targetValue: unitEntry => scoringApi.targetValue(unitEntry),
    futureReach: (unitEntry, lookahead) => pathingApi.futureReach(unitEntry, lookahead),
    buildDistanceField: (unitEntry, target) => pathingApi.buildDistanceField(unitEntry, target),
    hasLandReachToEnemyCity: owner => pathingApi.hasLandReachToEnemyCity(owner),
    landUnitCanReachForeignCity: unitEntry => pathingApi.landUnitCanReachForeignCity(unitEntry),
    allyCongestion: (owner, cell, excludeId) => scoringApi.allyCongestion(owner, cell, excludeId),
    frontlineCount: (owner, target, radius) => scoringApi.frontlineCount(owner, target, radius),
    nearbyEnemies: (cell, owner, radius) => scoringApi.nearbyEnemies(cell, owner, radius),
    unitRoleCellBonus: (owner, unitEntry, cell, intent) => scoringApi.unitRoleCellBonus(owner, unitEntry, cell, intent),
    unitRoleTargetBonus: (unitEntry, enemy, intent) => scoringApi.unitRoleTargetBonus(unitEntry, enemy, intent),
    bestObjective: (owner, unitEntry, intent) => intentApi.bestObjective(owner, unitEntry, intent),
    projectedPressure: (owner, target, lookahead, excludeId) => intentApi.projectedPressure(owner, target, lookahead, excludeId),
    previewCombat: (attacker, defender, fromCell, deterministic) => combatApi.previewCombat(attacker, defender, fromCell, deterministic),
    loadTransport: (transport, passenger) => transportApi.loadTransport(transport, passenger),
    canLoadTransport: (transport, passenger) => transportApi.canLoadTransport(transport, passenger),
    canUnloadTransport: (transport, x, y) => transportApi.canUnloadTransport(transport, x, y),
    unloadTransport: (transport, x, y) => transportApi.unloadTransport(transport, x, y),
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
    canAttack: (attacker, defender, fromCell) => combatApi.canAttack(attacker, defender, fromCell),
    attack: (attacker, defender) => combatApi.attack(attacker, defender),
    buildableTypes: siteEntry => buildApi.buildableTypes(siteEntry),
    buildAtSite: (owner, siteEntry, type, options) => buildApi.buildAtSite(owner, siteEntry, type, options),
    clearPendingOrder,
    checkEnd: () => turnApi.checkEnd(),
    minZoom: () => boardApi.minZoom(),
    clampCam: () => boardApi.clampCam(),
    mapIsPanned: () => boardApi.mapIsPanned(),
    loadPayload: payload => loadPayload(payload),
    hidePauseModal: () => $('pauseModal')?.classList.add('hidden'),
    onGameOver: (win, text) => {
      $('modalTitle').textContent = win === null ? '对局结束' : win ? '胜利！' : '战败';
      $('modalText').textContent = text;
      $('statsPanel').classList.remove('hidden');
      renderStatsSummary(true);
      drawStatsChart();
      $('overlay').classList.remove('hidden');
      refresh();
    }
  };

  const { movementCost, passable, movementNeighbors, reachable } = createMovement(rt);
  buildApi = createBuild(rt);
  const {
    terrainCellCounts, unitCapFor, ownedUnitCount, atUnitCap, campCount,
    unitBuildCost, sellRefund, sellUnit,
    buildableTypes, siteUpgradeCost, buildBudgetLeft, recordBuild, buildAtSite,
    upgradeSite, fullHealSite, aiRepair, consumeAction, engineerBuildCells,
    canBuildCamp, canEngineerLaunch, buildCamp, engineerLaunch
  } = buildApi;
  turnApi = createTurn(rt);
  const {
    healOwner, grantIncome, decayTemporarySites, teamStandings, resolveStalemate,
    checkEnd, finish, endGameNeutral, sideLabel
  } = turnApi;
  transportApi = createTransport(rt);
  const {
    moveUnit, canLoadTransport, loadTransport,
    canUnloadTransport, unloadTransport, supportSites
  } = transportApi;
  const {
    collectLandCells, makeCities, makeSpecialSites,
    nearestCoastalWater, makeNavalSites, spawnLand, spawnSea
  } = createWorldgen(rt);
  scoringApi = createScoring(rt);
  const {
    strategicSiteValue, isBridgeheadSite, frontlineCount, siteProjectionValue,
    enemyThreat, friendSupport, allyCongestion, cityEconomyValue,
    targetValue, nearbyEnemies, unitRoleCellBonus, unitRoleTargetBonus,
    strategicLandingScore
  } = scoringApi;
  pathingApi = createPathing(rt);
  const {
    strategicPassable, buildDistanceField, futureReach,
    moveToward, moveTransportToward, bestLanding,
    landUnitCanReachForeignCity, hasLandReachToEnemyCity,
    clearDistFieldCache, clearLandReachCache
  } = pathingApi;
  intentApi = createIntent(rt);
  const {
    frontMemory, decayFrontMemory, rememberFrontOutcome, logAiDecision,
    bestSupport, bestRetreatCell, projectedPressure,
    buildStrategicIntent, summarizeIntent, unitPriority, bestObjective,
    computeUnitState, finalizeUnitState
  } = intentApi;
  const {
    forceCrowding, capacityPressure, autoLoadAdjacent, autoUnloadAdjacent,
    chooseAction, buildScore, aiSpendGold, aiManageForces,
    teamNeedsEngineer, chooseTransportCargo, engineerBuildChoice
  } = createDecide(rt);
  boardApi = createBoardRenderer(rt);
  const {
    draw, drawSelection, drawMinimap, clampCam, centerCamOn, minZoom, mapIsPanned
  } = boardApi;
  const { chartMetrics, statLabel, renderStatsSummary, drawStatsChart } = createStatsRenderer(rt);
  // panels 放在最后：它是依赖最多的一层（要用到 build / turn / combat 三边的结果），
  // 而它自己不被任何模块依赖 —— 只有 refresh() 调它。
  const {
    uiState, updatePanels, transportConfigMarkup, setCargoPreset, engineerSelected
  } = createPanels(rt);
  // input 依赖 panels 之外的几乎所有东西（它是"点一下会发生什么"的派发中心），
  // 所以放在装配链末尾。
  const {
    tileFromEvent, selectRef, onBoard, endTurn,
    zoomAt, beginPan, panBy, endPan, consumeContextSuppression
  } = createInput(rt);

  function log(text, kind = '') {
    game.logs.push({ text, kind });
    if (game.logs.length > 80) {
      game.logs.shift();
    }
  }

  function toast(text) {
    $('toast').textContent = text;
    $('toast').classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => $('toast').classList.add('hidden'), 1800);
  }

  combatApi = createCombat(rt);
  const { siteBonus, matchupBonus, computeDamage, previewCombat, canAttack, removeUnit, attack } = combatApi;
  const {
    bridgeheadTryAttack, bridgeheadDefendCell, bridgeheadProduce, bridgeheadTurn,
    navalTryAttack, navalPatrolCell, navalLandHoldCell, navalProduce, navalTurn
  } = createScripted(rt);

  function captureSite(unitEntry) {
    const siteEntry = getSite(unitEntry.x, unitEntry.y);
    if (!siteEntry || siteEntry.owner === unitEntry.owner || areAllies(siteEntry.owner, unitEntry.owner)) {
      return;
    }
    if (siteEntry.kind === 'camp') {
      game.sites = game.sites.filter(entry => entry !== siteEntry);
      if (game.selected?.ref === siteEntry) {
        game.selected = null;
      }
      incrementStat('lostSites', siteEntry.owner, 1);
      incrementStat('captures', unitEntry.owner, 1);
      recordStatSnapshot('camp-destroyed');
      log(`${ownerName(unitEntry.owner)}摧毁了${siteEntry.owner === 'player' ? '你的' : ownerName(siteEntry.owner)}临时营地。`, 'system');
      return;
    }
    const domain = typeMeta(unitEntry.type).domain;
    if (siteEntry.kind === 'city' && domain !== 'land') {
      return;
    }
    if ((siteEntry.kind === 'shipyard' || siteEntry.kind === 'fortress') && domain !== 'sea') {
      return;
    }
    const oldTier = siteEntry.tier;
    const oldOwner = siteEntry.owner;
    siteEntry.owner = unitEntry.owner;
    if (siteEntry.kind !== 'fortress' && Math.random() < 0.12) {
      siteEntry.tier = Math.max(1, siteEntry.tier - 1);
      siteEntry.income = Math.max(4, siteMeta(siteEntry.kind).income + (siteEntry.tier - 1) * (siteEntry.kind === 'city' ? 3 : 2));
    }
    if (oldOwner !== 'neutral') {
      incrementStat('lostSites', oldOwner, 1);
    }
    incrementStat('captures', unitEntry.owner, 1);
    if (siteEntry.kind === 'city') {
      incrementStrat(unitEntry.owner, 'cityCaptures');
    } else if (siteEntry.kind.startsWith('oil')) {
      incrementStrat(unitEntry.owner, 'oilCaptures');
    } else if (siteEntry.kind === 'shipyard' || siteEntry.kind === 'fortress') {
      incrementStrat(unitEntry.owner, 'shipyardCaptures');
    }
    recordStatSnapshot('capture');
    log(`${ownerName(unitEntry.owner)}夺取了${siteEntry.name}${siteEntry.tier < oldTier ? '，设施战损降级。' : '。'}`, 'system');
    checkEnd();
  }

  function beginTurn(owner, initial) {
    if (game.over) {
      return;
    }
    if (!ownerExists(owner)) {
      advanceTurn();
      return;
    }
    game.side = owner;
    game.buildsThisTurn = game.buildsThisTurn || {};
    game.buildsThisTurn[owner] = 0;
    if (!initial) {
      decayFrontMemory(owner);
      decayTemporarySites(owner);
      healOwner(owner);
      grantIncome(owner);
      aiRepair(owner);
    }
    for (const unitEntry of game.units.filter(entry => entry.owner === owner)) {
      unitEntry.maxMove = effectiveMove(unitEntry);
      unitEntry.move = unitEntry.maxMove;
      unitEntry.acted = false;
      unitEntry.hasAttacked = false;
    }
    if (owner !== 'player') {
      game.selected = null;
    }
    refresh();
    if (!initial) {
      checkEnd();
    }
    if (owner !== 'player' && !fastSim) {
      setTimeout(() => {
        if (!game.over && game.side === owner) {
          void aiTurn(owner);
        }
      }, 260);
    }
  }

  function advanceTurn() {
    if (game.over) {
      return;
    }
    game.currentIndex = (game.currentIndex + 1) % game.ownerOrder.length;
    if (game.currentIndex === 0) {
      game.turn += 1;
      if (game.turn > MAX_TURNS && !game.freeplay && !game.over) {
        resolveStalemate();
        if (game.over) {
          return;
        }
      }
    }
    beginTurn(game.ownerOrder[game.currentIndex], false);
  }

  function teamCanContestLand(team) {
    if (game.sites.some(siteEntry => siteEntry.kind === 'city' && siteEntry.owner !== 'neutral' && teamOf(siteEntry.owner) === team)) {
      return true;
    }
    if (game.units.some(unitEntry => teamOf(unitEntry.owner) === team && unitEntry.type === 'transport' && unitEntry.cargo?.length)) {
      return true;
    }
    const landUnits = game.units.filter(unitEntry => teamOf(unitEntry.owner) === team && typeMeta(unitEntry.type).domain === 'land');
    if (landUnits.some(landUnitCanReachForeignCity)) {
      return true;
    }
    const hasTransport = game.units.some(unitEntry => teamOf(unitEntry.owner) === team && unitEntry.type === 'transport');
    const hasShipyard = game.sites.some(siteEntry => siteEntry.kind === 'shipyard' && teamOf(siteEntry.owner) === team);
    return !!landUnits.length && (hasTransport || hasShipyard);
  }

  function dominantCityTeam() {
    const cityTeams = [...new Set(game.sites.filter(siteEntry => siteEntry.kind === 'city' && siteEntry.owner !== 'neutral').map(siteEntry => teamOf(siteEntry.owner)))];
    return cityTeams.length === 1 ? cityTeams[0] : null;
  }

  function refresh() {
    if (fastSim) {
      return;
    }
    draw();
    updatePanels();
  }

  savesApi = createSaves(rt);
  const { aiTurn } = createTurnLoop(rt, {
    navalTurn, bridgeheadTurn,
    buildStrategicIntent, summarizeIntent, frontMemory, unitPriority,
    computeUnitState, finalizeUnitState, bestRetreatCell, bestObjective,
    chooseAction, aiManageForces, aiSpendGold,
    autoLoadAdjacent, autoUnloadAdjacent, engineerBuildChoice,
    isBridgeheadSite, frontlineCount, nearbyEnemies,
    bestLanding, moveTransportToward, clearLandReachCache,
    buildCamp, engineerLaunch, sameCell
  });
  const {
    SAVE_PREFIX, listSaves, buildSavePayload, saveAsNewSave, overwriteCurrentSave,
    importSaveToList, currentSaveName, loadSave, deleteSave, readSave
  } = savesApi;
  const {
    fillSelectOptions, syncSliderLabels, renderAISettings, renderLobbyPreview,
    drawPreview, renderCodex, renderSaveList, renderRules
  } = createLobby(rt);
  // 开新局与屏幕切换互相要用对方：newGame 要 runLoadingScreen，
  // startGameFlow 要 newGame。用一个前置声明打破这个环 —— 两边都只在
  // 运行时调用，装配期不会碰。
  let screensApi;
  const { newGame } = createNewGame(rt, {
    makeCities, makeNavalSites, makeSpecialSites, spawnLand, spawnSea,
    centerCamOn, clearDistFieldCache, beginTurn,
    runLoadingScreen: (owners, done) => screensApi.runLoadingScreen(owners, done)
  });
  screensApi = createScreens(rt, {
    newGame, drawPreview, renderLobbyPreview, renderSaveList,
    centerCamOn, clearDistFieldCache, clearLandReachCache, aiTurn
  });
  const { runLoadingScreen, showScreen, startGameFlow, loadPayload } = screensApi;
  // 事件绑定层。它要用到几乎每个模块的成品函数，所以放在装配链最末尾；
  // deps 里全是函数引用，createBindings 只是把它们存进闭包，真正调用要等
  // setup() 里的 bindAll() —— 所以这里引用 showScreen / startGameFlow /
  // loadPayload 这些还没定义的函数声明是安全的（函数声明会提升）。
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
  // 快速模拟。放在这里是因为它要 aiTurn / newGame，而那两个是函数声明（会提升）。
  const { debugSummary, debugRunResult, fastRun, fastBatch } = createFastSim(rt, {
    advanceTurn, aiTurn, newGame, ownerExists, macroYield
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
      draw, refresh, renderStatsSummary, drawStatsChart,
      drawPreview, renderSaveList, renderLobbyPreview, onBoard
    });
    showScreen('setup');
  }

  document.addEventListener('DOMContentLoaded', setup);
})();