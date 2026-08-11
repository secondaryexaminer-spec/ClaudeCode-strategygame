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
import { createWorldgen, pickSpacedCells, farthestPointSample, distributeCells } from './world/worldgen.js';
import { createTransport } from './game/transport.js';
import { createScoring } from './ai/scoring.js';
import { createPathing } from './ai/pathing.js';
import { createScripted } from './ai/scripted.js';
import { createIntent } from './ai/intent.js';
import { createDecide } from './ai/decide.js';
import { createBoardRenderer } from './render/board.js';
import { createStatsRenderer } from './render/stats.js';
import { createPanels } from './ui/panels.js';
import { createInput } from './ui/input.js';
import { createLobby } from './ui/lobby.js';

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

  function debugSummary() {
    if (!game) {
      return null;
    }
    return {
      turn: game.turn,
      over: game.over,
      side: game.side,
      spectator: game.settings?.spectator,
      result: game.result || null,
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
    const strat = game?.stats?.strat || {};
    for (const owner of Object.keys(strat)) {
      const team = teamOf(owner);
      byTeam[team] = byTeam[team] || {};
      for (const key of Object.keys(strat[owner])) {
        byTeam[team][key] = (byTeam[team][key] || 0) + strat[owner][key];
      }
    }
    return byTeam;
  }

  function debugRunResult() {
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
      cityOwners: game.sites.filter(s => s.kind === 'city').reduce((acc, s) => { const t = s.owner === 'neutral' ? 'neutral' : teamOf(s.owner); acc[t] = (acc[t] || 0) + 1; return acc; }, {}),
      unitsAlive: game.units.length
    };
  }

  async function fastRun(cap = 150) {
    if (!game) {
      return null;
    }
    fastSim = true;
    let guard = 0;
    const guardMax = cap * Math.max(1, game.ownerOrder.length) + 80;
    while (!game.over && game.turn <= cap && guard < guardMax) {
      const owner = game.side;
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
    fastSim = false;
    const result = debugRunResult();
    refresh();
    return result;
  }

  async function fastBatch(cap = 150, rounds = 10, seed = 20260804) {
    const runs = [];
    const origRandom = Math.random;
    const makeRng = value => {
      let state = value >>> 0;
      return () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 4294967296;
      };
    };
    try {
      for (let i = 0; i < rounds; i++) {
        Math.random = makeRng(seed + i * 2654435761);
        fastSim = true;
        newGame();
        const result = await fastRun(cap);
        runs.push(result);
      }
    } finally {
      Math.random = origRandom;
    }
    const agg = { rounds: runs.length, seed, wins: {}, avgTurns: 0, totals: {} };
    for (const run of runs) {
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


  // Scripted test opponent: defends the upper half of the strait and deliberately leaves the lower half open.
  async function aiTurn(owner) {
    const profile = game.aiProfiles[owner] || { diff: 'medium', agg: 'balanced' };
    clearLandReachCache();
    if (DIFF[profile.diff]?.scripted) {
      if (DIFF[profile.diff].script === 'naval') {
        await navalTurn(owner);
      } else {
        await bridgeheadTurn(owner);
      }
      return;
    }
    const intent = buildStrategicIntent(owner, profile);
    const memory = frontMemory(owner);
    logAiDecision(owner, summarizeIntent(intent));
    if (intent.cooledTargets?.length) {
      incrementStrat(owner, 'reroutes');
      logAiDecision(owner, `暂时避开受阻方向：${intent.cooledTargets.join('、')}。`);
    }
    aiManageForces(owner);
    aiSpendGold(owner, profile);
    refresh();
    await pause(aiStepDelay());
    const units = game.units.filter(entry => entry.owner === owner).sort((a, b) => unitPriority(b, intent) - unitPriority(a, intent));
    for (const unitEntry of [...units]) {
      if (game.over) {
        break;
      }
      if (!game.units.includes(unitEntry)) {
        continue;
      }
      const state = computeUnitState(unitEntry);
      const startCell = { x: unitEntry.x, y: unitEntry.y };
      const assaultKey = intent.assaultSite ? `site:${cellKey(intent.assaultSite.x, intent.assaultSite.y)}` : null;
      const bridgeheadCooldown = assaultKey ? memory[assaultKey]?.cooldown > 0 : false;
      const bridgeheadBlocked = intent.assaultSite && isBridgeheadSite(intent.assaultSite) && (bridgeheadCooldown || (state.rerouteTurns > 0 && state.failedObjectiveKey === assaultKey)) && dist(unitEntry, intent.assaultSite) <= 4;
      if (bridgeheadBlocked && typeMeta(unitEntry.type).domain === 'land' && profile.agg !== 'reckless') {
        const retreatCell = bestRetreatCell(owner, unitEntry, intent.assaultSite);
        if (retreatCell && (retreatCell.x !== unitEntry.x || retreatCell.y !== unitEntry.y)) {
          incrementStrat(owner, 'retreats');
          logAiDecision(owner, `${typeMeta(unitEntry.type).name}从桥头暂退，在 ${intent.assaultSite.name} 方向重整。`);
          moveUnit(unitEntry, retreatCell.x, retreatCell.y);
          finalizeUnitState(unitEntry, state, assaultKey || 'idle', true);
          refresh();
          await pause(aiStepDelay());
          continue;
        }
      }
      if (profile.agg === 'cautious' && intent.assaultSite && isBridgeheadSite(intent.assaultSite)) {
        const currentFrontline = frontlineCount(owner, intent.assaultSite, 3);
        const isReserveCandidate = typeMeta(unitEntry.type).domain === 'land' && unitEntry.type !== 'engineer' && (dist(unitEntry, intent.assaultSite) > 4 || typeMeta(unitEntry.type).range >= 2);
        if (currentFrontline >= 4 && isReserveCandidate && unitEntry.hp > unitEntry.maxHp * 0.65) {
          incrementStrat(owner, 'reserves');
          logAiDecision(owner, `${typeMeta(unitEntry.type).name}作为桥头预备队待机。`);
          finalizeUnitState(unitEntry, state, `reserve:${cellKey(intent.assaultSite.x, intent.assaultSite.y)}`, false);
          refresh();
          await pause(aiStepDelay());
          continue;
        }
      }
      if (unitEntry.type === 'transport') {
        if (!unitEntry.cargo.length && autoLoadAdjacent(unitEntry)) {
          finalizeUnitState(unitEntry, state, 'transport-load', false);
          refresh();
          await pause(aiStepDelay());
          continue;
        }
        if (unitEntry.cargo.length && autoUnloadAdjacent(unitEntry)) {
          finalizeUnitState(unitEntry, state, 'transport-unload', false);
          refresh();
          await pause(aiStepDelay());
          continue;
        }
        const landing = bestLanding(owner, unitEntry);
        if (landing) {
          const moved = moveTransportToward(unitEntry, landing);
          const nearThreat = nearbyEnemies({ x: unitEntry.x, y: unitEntry.y }, owner, 2);
          const escortAdjacent = game.units.some(entry => entry.owner === owner && entry.type === 'warship' && dist(entry, unitEntry) <= 2);
          if (unitEntry.cargo.length && (nearThreat === 0 || escortAdjacent)) {
            autoUnloadAdjacent(unitEntry);
          }
          finalizeUnitState(unitEntry, state, `landing:${cellKey(landing.x, landing.y)}`, moved);
          refresh();
          await pause(aiStepDelay());
          continue;
        }
      }
      if (unitEntry.type === 'engineer') {
        const engineerChoice = engineerBuildChoice(owner, unitEntry, intent);
        if (engineerChoice?.kind === 'camp' && buildCamp(unitEntry)) {
          finalizeUnitState(unitEntry, state, 'camp', false);
          refresh();
          await pause(aiStepDelay());
          continue;
        }
        if (engineerChoice?.cell && engineerLaunch(unitEntry, engineerChoice.kind, engineerChoice.cell, engineerChoice.cargoTypes || [])) {
          finalizeUnitState(unitEntry, state, `${engineerChoice.kind}:${cellKey(engineerChoice.cell.x, engineerChoice.cell.y)}`, false);
          refresh();
          await pause(aiStepDelay());
          continue;
        }
      }
      const choice = chooseAction(owner, unitEntry, profile, intent);
      const objectiveSite = choice.target ? null : bestObjective(owner, unitEntry, intent);
      const objectiveKey = objectiveSite ? `site:${cellKey(objectiveSite.x, objectiveSite.y)}` : choice.target ? `attack:${choice.target.id}` : 'idle';
      if (choice.move && (choice.move.x !== unitEntry.x || choice.move.y !== unitEntry.y)) {
        moveUnit(unitEntry, choice.move.x, choice.move.y);
      }
      if (choice.target && game.units.includes(unitEntry) && game.units.includes(choice.target) && canAttack(unitEntry, choice.target)) {
        attack(unitEntry, choice.target);
      }
      finalizeUnitState(unitEntry, state, objectiveKey, !sameCell(startCell, unitEntry));
      refresh();
      await pause(aiStepDelay());
    }
    if (!game.over) {
      advanceTurn();
    }
  }

  function newGame() {
    const aiCount = Number($('aiSelect').value);
    const spectator = $('spectatorSelect')?.value === 'on';
    const owners = spectator ? Array.from({ length: aiCount }, (_, index) => `ai${index}`) : ['player', ...Array.from({ length: aiCount }, (_, index) => `ai${index}`)];
    const teams = { player: $('playerTeamSelect').value };
    const aiProfiles = {};
    const ownerColors = { player: COLOR_PRESETS[$('playerColorSelect').value || 'azure']?.value || '#55a3ff' };
    for (let i = 0; i < aiCount; i++) {
      teams[`ai${i}`] = $(`ai${i}Team`)?.value || TEAMS[(i + 1) % TEAMS.length];
      aiProfiles[`ai${i}`] = { diff: $(`ai${i}Diff`)?.value || 'medium', agg: $(`ai${i}Agg`)?.value || 'balanced' };
      ownerColors[`ai${i}`] = COLOR_PRESETS[$(`ai${i}Color`)?.value || 'crimson']?.value || OWNER_COLORS[i % OWNER_COLORS.length];
    }
    const dimensions = computeDimensions($('sizeSelect').value, $('aspectSelect').value);
    W = dimensions.w;
    H = dimensions.h;
    // Larger tiles for readability; small maps get the biggest cells, big maps pan within the viewport.
    S = W <= 22 ? 52 : 44;
    canvas.width = Math.min(W * S, VIEW_MAX_W);
    canvas.height = Math.min(H * S, VIEW_MAX_H);
    cam.x = 0;
    cam.y = 0;
    zoom = 1;
    currentSaveKey = null;
    clearDistFieldCache();
    game = {
      terrain: terrainFor($('mapSelect').value, $('complexitySelect').value, W, H),
      units: [],
      sites: [],
      ownerOrder: owners,
      currentIndex: 0,
      side: 'player',
      turn: 1,
      selected: null,
      over: false,
      logs: [],
      teams,
      ownerColors,
      aiProfiles,
      aiFrontMemory: {},
      freeplay: false,
      pendingOrder: null,
      goldByOwner: Object.fromEntries(owners.map(owner => [owner, 45])),
      stats: {
        startTime: null,
        endTime: null,
        chartIndex: 0,
        produced: Object.fromEntries(owners.map(owner => [owner, 0])),
        kills: Object.fromEntries(owners.map(owner => [owner, 0])),
        losses: Object.fromEntries(owners.map(owner => [owner, 0])),
        captures: Object.fromEntries(owners.map(owner => [owner, 0])),
        lostSites: Object.fromEntries(owners.map(owner => [owner, 0])),
        strat: Object.fromEntries(owners.map(owner => [owner, { stalls: 0, reserves: 0, reroutes: 0, retreats: 0, cityCaptures: 0, oilCaptures: 0, shipyardCaptures: 0, engineerLandings: 0, transportLaunches: 0, campsBuilt: 0, sells: 0 }])),
        history: []
      },
      settings: {
        map: $('mapSelect').value,
        mode: $('modeSelect').value,
        spectator,
        ai: aiCount,
        start: Number($('startUnitsSelect').value),
        size: $('sizeSelect').value,
        aspect: $('aspectSelect').value,
        aiSpeed: Number($('aiSpeed').value),
        complexity: $('complexitySelect').value,
        spread: Number($('citySpread').value),
        deploy: $('deploymentSelect').value,
        buildCap: Number($('buildCap').value),
        incomeMult: Number($('incomeMult').value),
        siteDensity: Number($('siteDensity').value)
      }
    };
    game.sites = makeCities(aiCount, game.settings.size, game.settings.spread);
    game.sites.push(...makeNavalSites());
    game.sites.push(...makeSpecialSites());
    const used = new Set(game.sites.filter(entry => entry.kind === 'city').map(entry => cellKey(entry.x, entry.y)));
    for (const owner of owners) {
      const homes = game.sites.filter(entry => entry.owner === owner && entry.kind === 'city');
      if (!homes.length) {
        continue;
      }
      const seaSpawn = game.settings.start >= 4 ? spawnSea(owner, game.settings.start >= 6 ? 2 : 1) : 0;
      spawnLand(owner, homes, Math.max(0, game.settings.start - seaSpawn), used, game.settings.deploy);
    }
    $('statsPanel').classList.add('hidden');
    $('statsSummary').innerHTML = '';
    recordStatSnapshot('deploy');
    log(`版本 0.1.2 战局开始：${MAPS[game.settings.map].name} · ${SIZES[game.settings.size].name} · ${ASPECTS[game.settings.aspect].name} ${W}×${H} · ${game.sites.filter(entry => entry.kind === 'city').length} 座城市 · ${game.sites.filter(entry => entry.kind === 'shipyard').length} 座船坞。`, 'system');
    const focusCity = game.sites.find(entry => entry.kind === 'city' && entry.owner === (spectator ? owners[0] : 'player'));
    if (focusCity) {
      centerCamOn(focusCity.x, focusCity.y);
    }
    const startFirstTurn = () => beginTurn(owners[0], true);
    if (fastSim) {
      startFirstTurn();
    } else {
      runLoadingScreen(owners, startFirstTurn);
    }
  }

  const LOADING_TIPS = [
    '战术：长枪兵对骑兵有克制加成，把它们摆在骑兵冲锋的正面。',
    '战术：战船克制运兵船，护航或拦截时优先让战船贴身。',
    '技巧：运兵船现在最多可搭载 5 个陆军单位，登陆后立即释放。',
    '技巧：运兵船卸下的单位可在同一格堆叠（每格最多 3 个），点击堆叠格可循环选择操控。',
    '技巧：大地图下长按右键并拖动鼠标即可平移视野，右下角小地图显示当前视口。',
    '战术：工程师能在海边直接造舰，也能原地建立可维持 3 回合的临时营地。',
    '经济：占领油田和军营能显著增强产能，冷酷 AI 会优先争夺它们。',
    '战术：骑兵满机动接战时获得冲锋加成，保留移动力再发起冲锋。',
    '技巧：驻军可花金币修整，残血精锐撤回城市回血再战更划算。',
    '历史：两栖登陆的关键从来不是抢滩，而是能否持续把后续兵力运上岸。',
    '战术：弩手爆发高但脆弱，用剑士与近卫在前排为其挡刀。',
    '技巧：单位击杀累积可晋升老兵，提升机动与续航，注意保护高阶单位。',
    '提示：设置里可调收入倍率与每回合造兵上限，用来打造快节奏或持久战。',
    '战术：把富余陆军用空运兵船循环转运到敌军薄弱的海岸，是破解岛屿僵局的钥匙。',
    '历史：制海权决定制陆权——失去海上补给线的滩头阵地终将枯萎。'
  ];

  function runLoadingScreen(owners, done) {
    const screen = $('loadingScreen');
    if (!screen) {
      done();
      return;
    }
    drawPreview();
    $('loadingMapName').textContent = `${MAPS[game.settings.map].name} · 部署中`;
    $('loadingMapMeta').textContent = `${SIZES[game.settings.size].name} · ${W}×${H} · ${game.sites.filter(e => e.kind === 'city').length} 城 / ${game.sites.filter(e => e.kind === 'shipyard').length} 船坞`;
    const blockCount = 44;
    $('loadingBlocks').innerHTML = Array.from({ length: blockCount }, () => '<i class="lblock"></i>').join('');
    const blocks = [...$('loadingBlocks').querySelectorAll('.lblock')];
    const sides = owners.map(owner => ({ owner, target: 70 + Math.random() * 30, value: 0 }));
    $('loadingSides').innerHTML = sides.map(side => `<div class="lside"><span class="ldot" style="background:${ownerColor(side.owner)}"></span><span class="lname">${ownerName(side.owner)}</span><span class="lbar"><i data-owner="${side.owner}"></i></span><span class="lpct" data-pct="${side.owner}">0%</span></div>`).join('');
    let tipIndex = Math.floor(Math.random() * LOADING_TIPS.length);
    $('loadingTip').textContent = LOADING_TIPS[tipIndex];
    screen.classList.remove('hidden');
    let progress = 0;
    let tipTick = 0;
    const timer = setInterval(() => {
      progress = Math.min(100, progress + 2 + Math.random() * 4);
      const lit = Math.round(blockCount * progress / 100);
      blocks.forEach((block, index) => block.classList.toggle('on', index < lit));
      $('loadingPercent').textContent = Math.round(progress);
      for (const side of sides) {
        side.value = Math.min(100, side.value + (progress >= side.target ? 6 + Math.random() * 8 : 2 + Math.random() * 5));
        const bar = $('loadingSides').querySelector(`i[data-owner="${side.owner}"]`);
        const pct = $('loadingSides').querySelector(`span[data-pct="${side.owner}"]`);
        if (bar) {
          bar.style.width = `${side.value}%`;
        }
        if (pct) {
          pct.textContent = `${Math.round(side.value)}%`;
        }
      }
      if (++tipTick % 14 === 0) {
        tipIndex = (tipIndex + 1) % LOADING_TIPS.length;
        $('loadingTip').textContent = LOADING_TIPS[tipIndex];
      }
      if (progress >= 100 && sides.every(side => side.value >= 100)) {
        clearInterval(timer);
        setTimeout(() => {
          screen.classList.add('hidden');
          done();
        }, 350);
      }
    }, 90);
  }

  function showScreen(name) {
    const setupEl = $('setupScreen');
    const gameEl = $('gameScreen');
    const infoEl = $('infoScreen');
    if (setupEl) {
      setupEl.classList.toggle('hidden', name !== 'setup');
    }
    if (gameEl) {
      gameEl.classList.toggle('hidden', name !== 'game');
    }
    if (infoEl) {
      infoEl.classList.toggle('hidden', name !== 'info');
    }
    $('loadScreen')?.classList.toggle('hidden', name !== 'load');
    if (name === 'setup') {
      $('overlay')?.classList.add('hidden');
      $('loadingScreen')?.classList.add('hidden');
      renderLobbyPreview();
    }
    if (name === 'load') {
      renderSaveList();
    }
  }

  function startGameFlow() {
    showScreen('game');
    newGame();
  }

  savesApi = createSaves(rt);
  const {
    SAVE_PREFIX, listSaves, buildSavePayload, saveAsNewSave, overwriteCurrentSave,
    importSaveToList, currentSaveName, loadSave, deleteSave, readSave
  } = savesApi;
  const {
    fillSelectOptions, syncSliderLabels, renderAISettings, renderLobbyPreview,
    drawPreview, renderCodex, renderSaveList, renderRules
  } = createLobby(rt);

  function loadPayload(payload) {
    if (!payload?.state) {
      return false;
    }
    W = payload.W;
    H = payload.H;
    S = payload.S;
    canvas.width = Math.min(W * S, VIEW_MAX_W);
    canvas.height = Math.min(H * S, VIEW_MAX_H);
    cam.x = 0;
    cam.y = 0;
    zoom = 1;
    clearDistFieldCache();
    clearLandReachCache();
    game = payload.state;
    game.selected = null;
    game.pendingOrder = null;
    showScreen('game');
    const focusOwner = game.settings?.spectator ? game.ownerOrder[0] : 'player';
    const focusCity = game.sites.find(entry => entry.kind === 'city' && entry.owner === focusOwner);
    if (focusCity) {
      centerCamOn(focusCity.x, focusCity.y);
    }
    const finishLoad = () => {
      refresh();
      if (!game.over && game.side !== 'player' && !fastSim) {
        setTimeout(() => {
          if (!game.over && game.side !== 'player') {
            void aiTurn(game.side);
          }
        }, 300);
      }
    };
    if (fastSim) {
      finishLoad();
    } else {
      runLoadProgress(finishLoad);
    }
    return true;
  }

  // Save-load progress bar: real-ish fill guaranteed to run at least ~1s.
  function runLoadProgress(done) {
    const screen = $('loadingScreen');
    if (!screen) {
      done();
      return;
    }
    drawPreview();
    $('loadingMapName').textContent = `读取存档 · ${MAPS[game.settings.map]?.name || '战局'}`;
    $('loadingMapMeta').textContent = `第 ${game.turn} 回合 · ${SIZES[game.settings.size]?.name || `${W}×${H}`}`;
    $('loadingSides').innerHTML = '';
    $('loadingTip').textContent = LOADING_TIPS[Math.floor(Math.random() * LOADING_TIPS.length)];
    const blockCount = 44;
    $('loadingBlocks').innerHTML = Array.from({ length: blockCount }, () => '<i class="lblock"></i>').join('');
    const blocks = [...$('loadingBlocks').querySelectorAll('.lblock')];
    screen.classList.remove('hidden');
    const started = performance.now();
    const minMs = 1000;
    let progress = 0;
    const timer = setInterval(() => {
      const elapsed = performance.now() - started;
      progress = Math.min(100, Math.max(progress + 3 + Math.random() * 6, elapsed / minMs * 100));
      const lit = Math.round(blockCount * progress / 100);
      blocks.forEach((block, index) => block.classList.toggle('on', index < lit));
      $('loadingPercent').textContent = Math.round(progress);
      if (progress >= 100 && elapsed >= minMs) {
        clearInterval(timer);
        setTimeout(() => {
          screen.classList.add('hidden');
          done();
        }, 200);
      }
    }, 60);
  }

  function setup() {
    fillSelectOptions();
    syncSliderLabels();
    // 顺序不能换：renderRules 生成的 HTML 里才有 #codex 容器，
    // 先渲染图鉴的话它会找不到挂载点、静默变成空的。
    renderRules();
    renderCodex();
    renderAISettings();

    $('aiSelect').addEventListener('change', renderAISettings);
    // 三个滑块共用同一个标签同步函数，格式只写在 ui/lobby.js 一处。
    for (const id of ['citySpread', 'aiSpeed', 'buildCap']) {
      $(id).addEventListener('input', syncSliderLabels);
    }
    $('buildGrid').addEventListener('click', event => {
      const button = event.target.closest('[data-type]');
      const siteEntry = selectedSite();
      if (!button || !siteEntry) {
        return;
      }
      const cargoTypes = button.dataset.type === 'transport' ? normalizeCargoTypes(uiState.shipyardCargo) : [];
      if (!buildAtSite('player', siteEntry, button.dataset.type, { cargoTypes })) {
        toast(buildBudgetLeft('player') <= 0 ? '本回合造兵已达上限。' : '无法在该据点生产该单位。');
      }
      refresh();
    });
    $('buildBody').addEventListener('change', event => {
      const input = event.target.closest('[data-cargo-preset]');
      if (!input) {
        return;
      }
      setCargoPreset(input.dataset.cargoPreset, Number(input.dataset.cargoSlot), input.value);
      refresh();
    });
    $('selActions').addEventListener('click', event => {
      const pick = event.target.closest('[data-select-unit]');
      if (pick) {
        const chosen = game?.units.find(entry => entry.id === pick.dataset.selectUnit);
        if (chosen) {
          selectRef('unit', chosen);
          refresh();
        }
        return;
      }
      const button = event.target.closest('[data-unit-action]');
      if (!button || !game?.selected || game.selected.kind !== 'unit') {
        return;
      }
      const unitEntry = game.selected.ref;
      if (button.dataset.unitAction === 'load' && !autoLoadAdjacent(unitEntry)) {
        toast('附近没有可装载的己方陆军。');
      }
      if (button.dataset.unitAction === 'unload' && !autoUnloadAdjacent(unitEntry)) {
        toast('附近没有可登陆的空地。');
      }
      if (button.dataset.unitAction === 'sell' && !sellUnit('player', unitEntry)) {
        toast('当前无法变卖该单位。');
      }
      refresh();
    });
    $('engineerCard').addEventListener('change', event => {
      const input = event.target.closest('[data-cargo-preset]');
      if (!input) {
        return;
      }
      setCargoPreset(input.dataset.cargoPreset, Number(input.dataset.cargoSlot), input.value);
      refresh();
    });
    $('engineerCard').addEventListener('click', event => {
      const button = event.target.closest('[data-engineer-build]');
      const engineer = engineerSelected();
      if (!button || !engineer || game.side !== 'player') {
        return;
      }
      if (button.dataset.engineerBuild === 'camp') {
        if (!buildCamp(engineer)) {
          toast('当前无法建立临时营地。');
        }
        refresh();
        return;
      }
      game.pendingOrder = {
        kind: 'engineer-launch',
        builderId: engineer.id,
        product: button.dataset.engineerBuild,
        cargoTypes: button.dataset.engineerBuild === 'transport' ? normalizeCargoTypes(uiState.engineerCargo) : []
      };
      refresh();
    });
    canvas.addEventListener('click', onBoard);
    canvas.addEventListener('mousedown', beginPan);
    canvas.addEventListener('wheel', event => {
      if (!game || game.over) {
        return;
      }
      event.preventDefault();
      zoomAt(event);
      draw();
    }, { passive: false });
    window.addEventListener('mousemove', event => {
      if (panBy(event)) {
        draw();
      }
    });
    window.addEventListener('mouseup', endPan);
    canvas.addEventListener('contextmenu', event => {
      event.preventDefault();
      // 刚拖拽完的那一次右键不当成"取消选中"，见 ui/input.js。
      if (consumeContextSuppression()) {
        return;
      }
      clearPendingOrder();
      game.selected = null;
      refresh();
    });
    $('btnEndTurn').onclick = endTurn;
    $('btnNewGame').onclick = () => showScreen('setup');
    $('btnStartGame').onclick = startGameFlow;
    $('btnUpgrade').onclick = () => {
      const siteEntry = selectedSite();
      if (!siteEntry || !upgradeSite('player', siteEntry)) {
        toast('无法升级该据点。');
      }
      refresh();
    };
    $('btnFullHeal').onclick = () => {
      const siteEntry = selectedSite();
      if (!siteEntry || !fullHealSite('player', siteEntry)) {
        toast('当前条件下无法修整驻军。');
      }
      refresh();
    };
    $('btnModalContinue').onclick = () => {
      game.over = false;
      game.freeplay = true;
      game.side = 'player';
      for (const unitEntry of game.units.filter(entry => areAllies(entry.owner, 'player'))) {
        unitEntry.maxMove = effectiveMove(unitEntry);
        unitEntry.move = unitEntry.maxMove;
        unitEntry.acted = false;
        unitEntry.hasAttacked = false;
      }
      $('overlay').classList.add('hidden');
      refresh();
    };
    $('btnModalOk').onclick = () => {
      $('overlay').classList.add('hidden');
      showScreen('setup');
    };
    $('btnHelp').onclick = () => $('helpModal').classList.remove('hidden');
    $('btnHelpLobby').onclick = () => $('helpModal').classList.remove('hidden');
    $('btnHelpClose').onclick = () => $('helpModal').classList.add('hidden');
    $('btnInfoPage').onclick = () => showScreen('info');
    $('btnInfoClose').onclick = () => showScreen('setup');
    $('btnPause').onclick = () => {
      if (game && !game.over) {
        $('pauseModal').classList.remove('hidden');
      }
    };
    $('btnResume').onclick = () => $('pauseModal').classList.add('hidden');
    $('btnEndGame').onclick = () => endGameNeutral();
    $('btnSaveGame').onclick = () => {
      $('pauseModal').classList.add('hidden');
      const hasCurrent = !!currentSaveKey;
      $('btnSaveOverwrite').classList.toggle('hidden', !hasCurrent);
      $('saveNameInput').value = hasCurrent ? currentSaveName() : `${MAPS[game.settings.map]?.name || '战局'} · 第 ${game.turn} 回合`;
      $('saveModal').classList.remove('hidden');
      $('saveNameInput').focus();
    };
    $('btnSaveOverwrite').onclick = () => {
      toast(overwriteCurrentSave($('saveNameInput').value.trim()) ? '已覆盖当前存档。' : '覆盖失败。');
      $('saveModal').classList.add('hidden');
    };
    $('btnSaveConfirm').onclick = () => {
      toast(saveAsNewSave($('saveNameInput').value.trim()) ? '已另存为新存档。' : '保存失败，存储空间可能已满。');
      $('saveModal').classList.add('hidden');
    };
    $('btnSaveExport').onclick = () => {
      downloadSaveFile(buildSavePayload($('saveNameInput').value.trim()));
      $('saveModal').classList.add('hidden');
      toast('已导出存档文件，可放入游戏的 saves 文件夹长期保存。');
    };
    $('btnSaveCancel').onclick = () => $('saveModal').classList.add('hidden');
    $('btnLoadPage').onclick = () => { selectedSaveKey = null; showScreen('load'); };
    $('btnLoadBack').onclick = () => showScreen('setup');
    $('saveListBody').addEventListener('click', event => {
      const row = event.target.closest('.save-row');
      if (!row) {
        return;
      }
      selectedSaveKey = row.dataset.key;
      [...$('saveListBody').querySelectorAll('.save-row')].forEach(el => el.classList.toggle('selected', el === row));
    });
    $('btnLoadConfirm').onclick = () => {
      if (!selectedSaveKey) {
        toast('请先选择一个存档。');
        return;
      }
      if (!loadSave(selectedSaveKey)) {
        toast('该存档已损坏，无法读取。');
      }
    };
    $('btnLoadDelete').onclick = () => {
      if (!selectedSaveKey) {
        toast('请先选择一个存档。');
        return;
      }
      deleteSave(selectedSaveKey);
      selectedSaveKey = null;
      renderSaveList();
      toast('已删除该存档。');
    };
    $('btnExportSave').onclick = () => {
      if (!selectedSaveKey) {
        toast('请先选择一个存档再导出。');
        return;
      }
      try {
        // readSave 把「存档损坏」从抛异常变成了返回 null，这里要显式还原成
        // 失败提示 —— 否则损坏的存档会走到下面那句「已导出」，而实际什么都没下载。
        const payload = readSave(selectedSaveKey);
        if (!payload) {
          throw new Error('存档内容无法解析');
        }
        downloadSaveFile(payload);
        toast('已导出存档文件，可放入游戏的 saves 文件夹长期保存。');
      } catch (err) {
        toast('导出失败：该存档已损坏。');
      }
    };
    $('btnImportSave').onclick = () => $('importFile').click();
    $('importFile').addEventListener('change', event => {
      const file = event.target.files?.[0];
      if (!file) {
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        try {
          if (importSaveToList(JSON.parse(reader.result))) {
            renderSaveList();
            toast('已导入存档并加入列表，点击它即可继续。');
          } else {
            toast('导入失败：文件格式不正确。');
          }
        } catch (err) {
          toast('导入失败：文件无法解析。');
        }
      };
      reader.readAsText(file);
      event.target.value = '';
    });
    $('btnChartPrev').onclick = () => {
      if (!game?.stats) {
        return;
      }
      game.stats.chartIndex = (game.stats.chartIndex + chartMetrics().length - 1) % chartMetrics().length;
      drawStatsChart();
    };
    $('btnChartNext').onclick = () => {
      if (!game?.stats) {
        return;
      }
      game.stats.chartIndex = (game.stats.chartIndex + 1) % chartMetrics().length;
      drawStatsChart();
    };
    window.__frontierDebug = {
      summary: () => debugSummary(),
      run: (cap = 150) => fastRun(cap),
      batch: (cap = 150, rounds = 10, seed = 20260804) => fastBatch(cap, rounds, seed),
      stop: () => {
        if (game && !game.over) {
          resolveStalemate();
        }
        return debugSummary();
      },
      newGame: () => newGame(),
      // 给 sim/smoke-render.js 用：强制同步走一遍完整绘制。
      // 正常流程里 draw() 只由 refresh() 触发，而 refresh() 在 fastSim 下直接
      // 返回、非 fastSim 下又要等 runLoadingScreen 的 setInterval 跑完才轮到 ——
      // 两条路都没法在测试里同步命中渲染层。
      redraw: () => {
        if (!game) {
          return false;
        }
        draw();
        return true;
      },
      // 同上，但覆盖面板层（src/ui/panels.js）。
      //
      // 面板的分支几乎全挂在「当前选中的是什么」上：没选中 / 选中普通单位 /
      // 选中工程师 / 选中运兵船 / 选中据点 / 选中船厂，各走一段不同的代码。
      // 只刷一次默认状态（没选中）等于只覆盖了其中一段，剩下的照样是盲区。
      // 所以这里逐个换选中态各刷一遍，最后清空还原。
      //
      // 直接写 game.selected 而不是走 selectRef()：selectRef 会顺手清掉
      // pendingOrder，属于操作语义；这里只想触发重绘，不想改游戏状态。
      repaintUi: () => {
        if (!game) {
          return false;
        }
        const prevSelected = game.selected;
        const pickUnit = predicate => game.units.find(predicate) || null;
        const refs = [
          { kind: 'unit', ref: pickUnit(entry => entry.owner === 'player') || game.units[0] || null },
          { kind: 'unit', ref: pickUnit(entry => entry.type === 'engineer') },
          { kind: 'unit', ref: pickUnit(entry => typeMeta(entry.type).transport) },
          { kind: 'site', ref: game.sites[0] || null },
          { kind: 'site', ref: game.sites.find(entry => entry.kind === 'shipyard') || null },
          { kind: null, ref: null }
        ];
        for (const item of refs) {
          game.selected = item.ref
            ? {
              kind: item.kind,
              ref: item.ref,
              unit: item.kind === 'unit' ? item.ref : getUnit(item.ref.x, item.ref.y),
              site: item.kind === 'site' ? item.ref : getSite(item.ref.x, item.ref.y)
            }
            : null;
          refresh();
        }
        game.selected = prevSelected;
        refresh();
        return true;
      },
      // 统计面板也在 fastSim 短路之后，同样需要一个同步入口。
      repaintStats: () => {
        if (!game) {
          return false;
        }
        renderStatsSummary(false);
        drawStatsChart();
        return true;
      },
      // 大厅那几个渲染函数里，只有 fillSelectOptions / renderRules / renderCodex /
      // renderAISettings 会在 setup() 里跑到（harness 建立时就触发了）；
      // drawPreview 要等 runLoadingScreen、renderLobbyPreview 要等下拉框 change、
      // renderSaveList 要等进读档页 —— 三个在无头环境里一次都不会执行。
      //
      // ⚠️ 顺序不能换：renderLobbyPreview 会按大厅的下拉框重算 W / H，
      // 而 drawPreview 读的是当前这局的 game.terrain。反过来的话尺寸对不上，
      // 会越界读出 undefined。也因为它改全局尺寸，调用方应该把它放在一个用例的
      // 最后 —— 之后再调 redraw() 画出来的就不是这局的地图了。
      repaintLobby: () => {
        if (!game) {
          return false;
        }
        drawPreview();
        renderSaveList();
        renderLobbyPreview();
        return true;
      },
      // 合成一次棋盘点击。ui/input.js 的 onBoard 是玩家唯一的操作入口，而它在
      // 无头环境里完全没有覆盖 —— fastBatch 不产生鼠标事件，烟雾测试也只走绘制。
      //
      // 这里把格子坐标反算成 clientX/clientY 再喂给 onBoard，走的是和真实点击
      // 一模一样的路径（包括 getBoundingClientRect 的换算），而不是绕过它直接调
      // 内部函数 —— 绕过去就测不到坐标换算写错这类错了。
      //
      // 返回点击后的选中态摘要，方便调用方断言"点了确实有反应"。
      clickCell: (x, y) => {
        if (!game) {
          return null;
        }
        const rect = canvas.getBoundingClientRect();
        const scaleX = rect.width ? canvas.width / rect.width : 1;
        const scaleY = rect.height ? canvas.height / rect.height : 1;
        // tileFromEvent 的逆运算，取格子中心避免落在边界上。
        const px = ((x + 0.5) * S - cam.x) * zoom;
        const py = ((y + 0.5) * S - cam.y) * zoom;
        onBoard({ clientX: rect.left + px / scaleX, clientY: rect.top + py / scaleY });
        return {
          kind: game.selected?.kind || null,
          id: game.selected?.ref?.id || null,
          x: game.selected?.ref?.x ?? null,
          y: game.selected?.ref?.y ?? null
        };
      }
    };
    document.addEventListener('keydown', event => {
      if (event.code === 'Space') {
        event.preventDefault();
        endTurn();
      }
      if (event.key === 'n' || event.key === 'N') {
        showScreen('setup');
      }
      if (event.key === 'Escape' && game) {
        game.selected = null;
        refresh();
      }
    });
    for (const id of ['mapSelect', 'sizeSelect', 'aspectSelect', 'complexitySelect', 'aiSelect']) {
      $(id)?.addEventListener('change', renderLobbyPreview);
    }
    showScreen('setup');
  }

  document.addEventListener('DOMContentLoaded', setup);
})();