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
  let panState = null;
  let panSuppressContext = false;
  let selectedSaveKey = null;
  let currentSaveKey = null;
  let toastTimer = null;
  let game = null;
  let fastSim = false;
  const uiState = {
    shipyardCargo: ['none', 'none', 'none', 'none', 'none'],
    engineerCargo: ['none', 'none', 'none', 'none', 'none']
  };

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

  function chartMetrics() {
    return [
      { key: 'produced', title: '生产单位数对比' },
      { key: 'kills', title: '击杀数对比' },
      { key: 'losses', title: '伤亡数对比' },
      { key: 'captures', title: '占领据点数对比' },
      { key: 'lostSites', title: '丢失据点数对比' }
    ];
  }

  function statLabel(owner) {
    return owner === 'player' ? '玩家' : `AI ${Number(owner.slice(2)) + 1}`;
  }

  function renderStatsSummary(animate = true) {
    if (!game?.stats) {
      return;
    }
    const summary = document.getElementById('statsSummary');
    if (!summary) {
      return;
    }
    const totalProduced = Object.values(game.stats.produced).reduce((sum, value) => sum + value, 0);
    const totalKills = Object.values(game.stats.kills).reduce((sum, value) => sum + value, 0);
    const totalLosses = Object.values(game.stats.losses).reduce((sum, value) => sum + value, 0);
    const totalCaptures = Object.values(game.stats.captures).reduce((sum, value) => sum + value, 0);
    const totalLost = Object.values(game.stats.lostSites).reduce((sum, value) => sum + value, 0);
    const items = [
      { label: '本局时长', value: statTimeSeconds(), suffix: 's' },
      { label: '总生产数', value: totalProduced, suffix: '' },
      { label: '总击杀数', value: totalKills, suffix: '' },
      { label: '总伤亡数', value: totalLosses, suffix: '' },
      { label: '总占领数', value: totalCaptures, suffix: '' },
      { label: '总丢失数', value: totalLost, suffix: '' }
    ];
    summary.innerHTML = items.map((item, index) => `<div class="summary-card"><span class="label">${item.label}</span><span class="value" data-stat-index="${index}" data-final="${item.value}" data-suffix="${item.suffix}">0${item.suffix}</span></div>`).join('');
    if (!animate) {
      summary.querySelectorAll('[data-final]').forEach(node => {
        node.textContent = `${node.dataset.final}${node.dataset.suffix || ''}`;
      });
      return;
    }
    const start = performance.now();
    const duration = 600;
    const values = [...summary.querySelectorAll('[data-final]')];
    function tick(now) {
      const progress = Math.min(1, (now - start) / duration);
      values.forEach(node => {
        const target = Number(node.dataset.final || 0);
        node.textContent = `${Math.round(target * progress)}${node.dataset.suffix || ''}`;
      });
      if (progress < 1) {
        requestAnimationFrame(tick);
      }
    }
    requestAnimationFrame(tick);
  }

  function drawStatsChart() {
    if (!game?.stats) {
      return;
    }
    const canvasEl = document.getElementById('statsChart');
    const titleEl = document.getElementById('chartTitle');
    if (!canvasEl || !titleEl) {
      return;
    }
    const metric = chartMetrics()[game.stats.chartIndex % chartMetrics().length];
    titleEl.textContent = metric.title;
    const chartCtx = canvasEl.getContext('2d');
    const width = canvasEl.width;
    const height = canvasEl.height;
    chartCtx.clearRect(0, 0, width, height);
    chartCtx.fillStyle = '#101820';
    chartCtx.fillRect(0, 0, width, height);
    chartCtx.strokeStyle = 'rgba(255,255,255,0.08)';
    chartCtx.lineWidth = 1;
    for (let i = 0; i < 5; i++) {
      const y = 20 + i * (height - 40) / 4;
      chartCtx.beginPath();
      chartCtx.moveTo(40, y);
      chartCtx.lineTo(width - 10, y);
      chartCtx.stroke();
    }
    const history = game.stats.history.length ? game.stats.history : [{ time: 0, [metric.key]: { ...game.stats[metric.key] } }];
    const maxTime = Math.max(1, ...history.map(point => point.time));
    const maxValue = Math.max(1, ...history.flatMap(point => Object.values(point[metric.key] || {})));
    ownerOrder().forEach(owner => {
      chartCtx.strokeStyle = ownerColor(owner);
      chartCtx.lineWidth = 2;
      chartCtx.beginPath();
      history.forEach((point, index) => {
        const x = 40 + (point.time / maxTime) * (width - 60);
        const y = height - 20 - ((point[metric.key]?.[owner] || 0) / maxValue) * (height - 40);
        if (index === 0) {
          chartCtx.moveTo(x, y);
        } else {
          chartCtx.lineTo(x, y);
        }
      });
      chartCtx.stroke();
      chartCtx.fillStyle = ownerColor(owner);
      chartCtx.fillRect(width - 130, 16 + ownerOrder().indexOf(owner) * 16, 10, 10);
      chartCtx.fillStyle = '#d8e6f7';
      chartCtx.font = '11px sans-serif';
      chartCtx.fillText(statLabel(owner), width - 115, 25 + ownerOrder().indexOf(owner) * 16);
    });
    chartCtx.fillStyle = '#8b9bb0';
    chartCtx.font = '11px sans-serif';
    chartCtx.fillText('时间', width / 2 - 10, height - 6);
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

  function transportConfigMarkup(presetKey, title) {
    const capacity = typeMeta('transport').transport;
    const rows = [];
    for (let slot = 0; slot < capacity; slot++) {
      const options = ['none', ...cargoOptionTypes()].map(type => `<option value="${type}" ${uiState[presetKey][slot] === type ? 'selected' : ''}>${cargoLabel(type)}</option>`).join('');
      rows.push(`<label class="cargo-row"><span>槽位${slot + 1}</span><select data-cargo-preset="${presetKey}" data-cargo-slot="${slot}">${options}</select></label>`);
    }
    return [
      '<div class="build-config">',
      `<h3>${title}</h3>`,
      '<div class="cargo-grid">',
      rows.join(''),
      '</div>',
      `<div class="config-note">当前配置：${describeCargo(uiState[presetKey])} · 总价 ${transportCost(uiState[presetKey])} 🪙</div>`,
      '</div>'
    ].join('');
  }

  function setCargoPreset(presetKey, slot, value) {
    if (!uiState[presetKey]) {
      return;
    }
    uiState[presetKey][slot] = value;
  }

  function engineerSelected() {
    return game?.selected?.kind === 'unit' && game.selected.ref.type === 'engineer' ? game.selected.ref : null;
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
  const rt = {
    get game() { return game; },
    get W() { return W; },
    get H() { return H; },
    get S() { return S; },
    get fastSim() { return fastSim; },
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
    canAttack: (attacker, defender, fromCell) => combatApi.canAttack(attacker, defender, fromCell),
    attack: (attacker, defender) => combatApi.attack(attacker, defender),
    buildableTypes: siteEntry => buildApi.buildableTypes(siteEntry),
    buildAtSite: (owner, siteEntry, type, options) => buildApi.buildAtSite(owner, siteEntry, type, options),
    clearPendingOrder,
    checkEnd: () => turnApi.checkEnd(),
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

  function drawSelection(x, y, color) {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.strokeRect(x * S + 3, y * S + 3, S - 6, S - 6);
    ctx.restore();
  }

  function draw() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.setTransform(zoom, 0, 0, zoom, -cam.x * zoom, -cam.y * zoom);
    const activeUnit = selectedUnit();
    const activeSite = selectedSite();
    const canMoveNow = activeUnit && !activeUnit.hasAttacked && activeUnit.move > 0;
    const moves = canMoveNow && game.side === 'player' ? reachable(activeUnit) : new Map();
    const unloadHints = activeUnit && typeMeta(activeUnit.type).transport && activeUnit.cargo.length ? adjacent8(activeUnit.x, activeUnit.y).filter(cell => canUnloadTransport(activeUnit, cell.x, cell.y)) : [];
    const engineerHints = game.pendingOrder?.kind === 'engineer-launch' && activeUnit?.id === game.pendingOrder.builderId ? engineerBuildCells(activeUnit) : [];

    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const tile = TERRAIN[game.terrain[y][x]];
        const px = x * S;
        const py = y * S;
        ctx.fillStyle = tile.color;
        ctx.fillRect(px, py, S, S);
        ctx.strokeStyle = 'rgba(5,15,22,.3)';
        ctx.lineWidth = 1;
        ctx.strokeRect(px, py, S, S);
        if (tile.mark) {
          ctx.fillStyle = 'rgba(255,255,255,.26)';
          ctx.font = `${Math.floor(S * 0.35)}px serif`;
          ctx.textAlign = 'center';
          ctx.fillText(tile.mark, px + S / 2, py + S * 0.64);
        }
        if (moves.has(cellKey(x, y)) && (!activeUnit || x !== activeUnit.x || y !== activeUnit.y)) {
          ctx.fillStyle = 'rgba(77,164,255,.24)';
          ctx.fillRect(px + 2, py + 2, S - 4, S - 4);
        }
        if (unloadHints.some(cell => cell.x === x && cell.y === y)) {
          ctx.fillStyle = 'rgba(86,211,100,.22)';
          ctx.fillRect(px + 4, py + 4, S - 8, S - 8);
        }
        if (engineerHints.some(cell => cell.x === x && cell.y === y)) {
          ctx.fillStyle = 'rgba(242,166,90,.22)';
          ctx.fillRect(px + 6, py + 6, S - 12, S - 12);
        }
      }
    }

    for (const siteEntry of game.sites) {
      const px = siteEntry.x * S;
      const py = siteEntry.y * S;
      const pad = S * 0.14;
      // Owner-colored plate fills most of the cell so the faction color is clearly readable.
      ctx.fillStyle = ownerColor(siteEntry.owner);
      ctx.fillRect(px + pad, py + pad, S - pad * 2, S - pad * 2);
      ctx.strokeStyle = 'rgba(6,12,18,.6)';
      ctx.lineWidth = 2;
      ctx.strokeRect(px + pad, py + pad, S - pad * 2, S - pad * 2);
      ctx.fillStyle = '#fff';
      ctx.font = `${Math.floor(S * 0.42)}px serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(siteMeta(siteEntry.kind).icon, px + S / 2, py + S * 0.56);
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = '#ffe08a';
      ctx.font = `${Math.max(8, Math.floor(S * 0.2))}px sans-serif`;
      ctx.fillText('★'.repeat(siteStars(siteEntry)), px + S / 2, py + pad + S * 0.17);
    }

    const cellStacks = new Map();
    for (const unitEntry of game.units) {
      const key = cellKey(unitEntry.x, unitEntry.y);
      if (!cellStacks.has(key)) {
        cellStacks.set(key, []);
      }
      cellStacks.get(key).push(unitEntry);
    }
    for (const unitEntry of game.units) {
      const stack = cellStacks.get(cellKey(unitEntry.x, unitEntry.y));
      const stackIndex = stack.indexOf(unitEntry);
      const spread = stack.length > 1 ? (stackIndex - (stack.length - 1) / 2) * S * 0.16 : 0;
      const px = unitEntry.x * S + S / 2 + spread;
      const py = unitEntry.y * S + S / 2 - spread;
      ctx.fillStyle = 'rgba(6,13,20,.72)';
      if (typeMeta(unitEntry.type).domain === 'sea') {
        ctx.fillRect(px - S * 0.28, py - S * 0.22, S * 0.56, S * 0.44);
        ctx.strokeStyle = ownerColor(unitEntry.owner);
        ctx.lineWidth = 3;
        ctx.strokeRect(px - S * 0.28, py - S * 0.22, S * 0.56, S * 0.44);
      } else {
        ctx.beginPath();
        ctx.arc(px, py, S * 0.32, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = ownerColor(unitEntry.owner);
        ctx.lineWidth = 3;
        ctx.stroke();
      }
      ctx.fillStyle = '#fff';
      ctx.font = `${Math.floor(S * 0.44)}px serif`;
      ctx.textAlign = 'center';
      ctx.fillText(typeMeta(unitEntry.type).icon, px, py + S * 0.12);
      ctx.fillStyle = unitEntry.owner === 'player' ? '#55d77a' : '#ff6c66';
      ctx.fillRect(px - S * 0.3, py + S * 0.34, S * 0.6 * unitEntry.hp / unitEntry.maxHp, 4);
      if (unitEntry.cargo?.length) {
        ctx.fillStyle = '#e3b341';
        ctx.font = `${Math.max(9, Math.floor(S * 0.22))}px sans-serif`;
        ctx.fillText(`${unitEntry.cargo.length}`, px + S * 0.22, py - S * 0.18);
      }
      if (stack.length > 1 && stackIndex === 0) {
        ctx.fillStyle = '#7fd0ff';
        ctx.font = `${Math.max(9, Math.floor(S * 0.24))}px sans-serif`;
        ctx.textAlign = 'left';
        ctx.fillText(`≡${stack.length}`, unitEntry.x * S + 3, unitEntry.y * S + S - 4);
        ctx.textAlign = 'center';
      }
    }

    if (activeUnit) {
      drawSelection(activeUnit.x, activeUnit.y, '#9ecbff');
    }
    if (activeSite) {
      drawSelection(activeSite.x, activeSite.y, '#ffd36c');
    }
    ctx.restore();
    drawMinimap();
  }

  function clampCam() {
    // Center the map when it's smaller than the visible area (e.g. zoomed all the way out); otherwise clamp to edges.
    const viewW = canvas.width / zoom;
    const viewH = canvas.height / zoom;
    cam.x = W * S <= viewW ? (W * S - viewW) / 2 : clamp(cam.x, 0, W * S - viewW);
    cam.y = H * S <= viewH ? (H * S - viewH) / 2 : clamp(cam.y, 0, H * S - viewH);
  }

  function centerCamOn(x, y) {
    cam.x = x * S + S / 2 - canvas.width / zoom / 2;
    cam.y = y * S + S / 2 - canvas.height / zoom / 2;
    clampCam();
  }

  function minZoom() {
    return clamp(Math.min(canvas.width / (W * S), canvas.height / (H * S)), 0.2, 1);
  }

  function mapIsPanned() {
    return W * S * zoom > canvas.width + 0.5 || H * S * zoom > canvas.height + 0.5;
  }

  function drawMinimap() {
    if (!mapIsPanned()) {
      return;
    }
    const mmW = 132;
    const mmH = Math.round(mmW * H / W);
    const ox = canvas.width - mmW - 10;
    const oy = canvas.height - mmH - 10;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = 'rgba(6,12,18,.8)';
    ctx.fillRect(ox - 2, oy - 2, mmW + 4, mmH + 4);
    const sx = mmW / W;
    const sy = mmH / H;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        ctx.fillStyle = TERRAIN[game.terrain[y][x]].color || '#26333f';
        ctx.fillRect(ox + x * sx, oy + y * sy, Math.ceil(sx), Math.ceil(sy));
      }
    }
    for (const siteEntry of game.sites) {
      ctx.fillStyle = ownerColor(siteEntry.owner);
      ctx.fillRect(ox + siteEntry.x * sx, oy + siteEntry.y * sy, Math.max(2, sx), Math.max(2, sy));
    }
    for (const unitEntry of game.units) {
      ctx.fillStyle = ownerColor(unitEntry.owner);
      ctx.fillRect(ox + unitEntry.x * sx, oy + unitEntry.y * sy, Math.max(1, sx * 0.7), Math.max(1, sy * 0.7));
    }
    ctx.strokeStyle = '#ffe08a';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(ox + cam.x / S * sx, oy + cam.y / S * sy, canvas.width / zoom / S * sx, canvas.height / zoom / S * sy);
  }

  function updatePanels() {
    $('gold').textContent = game.settings?.spectator ? (game.goldByOwner[game.side] ?? 0) : game.goldByOwner.player;
    $('turn').textContent = game.turn;
    $('sideLabel').textContent = sideLabel();
    $('sideLabel').classList.toggle('enemy', game.side !== 'player');
    $('btnEndTurn').disabled = game.settings?.spectator || game.side !== 'player' || game.over;

    const selected = game.selected;
    const activeUnit = selectedUnit();
    const activeSite = selectedSite();
    $('selectionEmpty').classList.toggle('hidden', !!activeUnit || !!activeSite);
    $('selectionBody').classList.toggle('hidden', !activeUnit);

    if (activeUnit) {
      const unitEntry = activeUnit;
      const meta = typeMeta(unitEntry.type);
      const siteEntry = getSite(unitEntry.x, unitEntry.y);
      const attackBuff = siteBonus(siteEntry, unitEntry, 'attack');
      const defenseBuff = siteBonus(siteEntry, unitEntry, 'defense');
      $('selIcon').textContent = meta.icon;
      $('selName').textContent = meta.name;
      $('selOwner').textContent = ownerName(unitEntry.owner);
      $('selHp').textContent = `${unitEntry.hp}/${unitEntry.maxHp}`;
      $('selMove').textContent = `${Math.floor(unitEntry.move)}/${unitEntry.maxMove}`;
      $('selHpBar').style.width = `${unitEntry.hp / unitEntry.maxHp * 100}%`;
      $('selMoveBar').style.width = `${unitEntry.move / unitEntry.maxMove * 100}%`;
      $('selAttrs').innerHTML = [
        `<div><span>军种：</span>${domainName(meta.domain)}</div>`,
        `<div><span>射程：</span>${meta.range}</div>`,
        `<div><span>等级：</span>${unitEntry.rank}</div>`,
        `<div><span>击杀：</span>${unitEntry.kills}</div>`,
        `<div><span>攻击：</span>${meta.atk + attackBuff}</div>`,
        `<div><span>防御：</span>${meta.def + defenseBuff}</div>`,
        `<div><span>状态：</span>${unitEntry.hasAttacked ? '已攻击' : unitEntry.move < unitEntry.maxMove ? '已机动' : '待命'}</div>`,
        `<div><span>特性：</span>${meta.transport ? `载员 ${unitEntry.cargo.length}/${meta.transport}` : meta.text}</div>`
      ].join('');
      const actions = [];
      if (meta.transport) {
        actions.push(`<button class="btn" data-unit-action="load" ${unitEntry.cargo.length >= meta.transport ? 'disabled' : ''}>装载邻近陆军</button>`);
        actions.push(`<button class="btn" data-unit-action="unload" ${unitEntry.cargo.length ? '' : 'disabled'}>自动卸载到临近空地</button>`);
      }
      if (unitEntry.owner === 'player' && game.side === 'player') {
        actions.push(`<button class="btn" data-unit-action="sell">变卖回收 ${sellRefund(unitEntry)} 🪙</button>`);
      }
      const cellStack = unitsAt(unitEntry.x, unitEntry.y);
      if (cellStack.length > 1) {
        actions.push(`<div class="config-note">同格单位（${cellStack.length}）：</div>`);
        cellStack.forEach(entry => {
          actions.push(`<button class="btn" data-select-unit="${entry.id}" ${entry === unitEntry ? 'disabled' : ''}>${typeMeta(entry.type).icon} ${typeMeta(entry.type).name}</button>`);
        });
      }
      $('selActions').innerHTML = actions.join('');
      let selectionHint = meta.text;
      if (game.pendingOrder?.kind === 'engineer-launch' && unitEntry.id === game.pendingOrder.builderId) {
        const productText = game.pendingOrder.product === 'transport'
          ? `运兵船（${describeCargo(game.pendingOrder.cargoTypes)}）`
          : typeMeta(game.pendingOrder.product).name;
        selectionHint = `已选择建造${productText}，请点击相邻海格下水。`;
      } else if (siteEntry) {
        const attackText = attackBuff ? `攻击 +${attackBuff}` : '';
        const defenseText = defenseBuff ? `防御 +${defenseBuff}` : '';
        const joinText = attackText && defenseText ? '，' : '';
        selectionHint = `${siteEntry.name}提供${attackText}${joinText}${defenseText}。`;
      }
      $('selHint').textContent = selectionHint;
    } else {
      $('selActions').innerHTML = '';
    }

    const engineer = engineerSelected();
    $('engineerCard').classList.toggle('hidden', !engineer || game.side !== 'player');
    if (engineer && game.side === 'player') {
      const coastCells = engineerBuildCells(engineer);
      const warshipDisabled = coastCells.length && game.goldByOwner.player >= typeMeta('warship').cost && !engineer.acted ? '' : 'disabled';
      const transportDisabled = coastCells.length && game.goldByOwner.player >= transportCost(uiState.engineerCargo) && !engineer.acted ? '' : 'disabled';
      const campDisabled = canBuildCamp(engineer) ? '' : 'disabled';
      const engineerPendingText = game.pendingOrder?.kind === 'engineer-launch' && game.pendingOrder.builderId === engineer.id
        ? '待下水：点击高亮海格完成建造。'
        : coastCells.length
          ? '海边施工可用。'
          : '先移动到靠海陆格，才能下水建造舰船。';
      $('engineerBody').innerHTML = [
        '<div class="engineer-panel">',
        `<h3>${typeMeta(engineer.type).icon} ${typeMeta(engineer.type).name}</h3>`,
        `<div class="config-note">工程师可在相邻海格建造舰船，也可在当前位置建立可维持 ${CAMP_DURATION} 回合的临时营地。</div>`,
        transportConfigMarkup('engineerCargo', '工程师运兵船预载'),
        '<div class="engineer-actions">',
        `<button class="btn" data-engineer-build="warship" ${warshipDisabled}>在相邻海格建造战船（${typeMeta('warship').cost} 🪙）</button>`,
        `<button class="btn" data-engineer-build="transport" ${transportDisabled}>在相邻海格建造运兵船（${transportCost(uiState.engineerCargo)} 🪙）</button>`,
        `<button class="btn" data-engineer-build="camp" ${campDisabled}>建立临时营地（${CAMP_COST} 🪙）</button>`,
        '</div>',
        `<div class="engineer-pending">${engineerPendingText}</div>`,
        '</div>'
      ].join('');
    } else {
      $('engineerBody').innerHTML = '';
    }

    const showSite = !!activeSite;
    const manageable = !!activeSite && activeSite.owner === 'player' && game.side === 'player';
    $('buildEmpty').classList.toggle('hidden', showSite);
    $('buildBody').classList.toggle('hidden', !showSite);
    if (showSite) {
      const siteEntry = activeSite;
      const occupant = getUnit(siteEntry.x, siteEntry.y);
      const cost = siteEntry.kind === 'city' || siteEntry.kind === 'camp' ? 5 : siteEntry.kind === 'shipyard' ? 6 : 7;
      $('cityName').textContent = siteEntry.name;
      $('cityTier').textContent = `${tierName(siteEntry.tier)}${siteMeta(siteEntry.kind).name}`;
      $('cityIncome').textContent = `+${siteEntry.income}`;
      $('cityBonus').textContent = siteEntry.kind === 'city' ? `生产陆军，驻军攻击 +${siteEntry.tier}，防御 +${siteEntry.tier * 2}。` : siteEntry.kind === 'shipyard' ? `生产海军；运兵船可直接预载 0~5 个陆军单位下水。` : siteEntry.kind === 'camp' ? `视为中级城市，不产金币，可存在 ${siteEntry.duration ?? CAMP_DURATION} 回合。` : siteEntry.kind.startsWith('oil') ? `不可升级、不可造兵；每回合收益 ${siteEntry.income} 🪙。` : siteEntry.kind.startsWith('barracks') ? `不可升级、不可产金币；驻军加成等同 ${siteMeta(siteEntry.kind).supportTier} 级普通据点。` : '海上堡垒不可生产单位，但提供海上防御。';
      $('btnUpgrade').textContent = siteEntry.tier < siteMeta(siteEntry.kind).maxTier ? `升级至${tierName(siteEntry.tier + 1)}（${siteUpgradeCost(siteEntry)} 🪙）` : '已达最高等级';
      $('btnUpgrade').disabled = !manageable || siteEntry.tier >= siteMeta(siteEntry.kind).maxTier || game.goldByOwner.player < siteUpgradeCost(siteEntry);
      $('btnFullHeal').textContent = occupant ? `花费${cost}金币：驻军修整` : '当前据点无驻军';
      $('btnFullHeal').disabled = !manageable || !occupant || game.goldByOwner.player < cost;
      $('shipyardConfig').classList.toggle('hidden', siteEntry.kind !== 'shipyard');
      $('shipyardConfig').innerHTML = siteEntry.kind === 'shipyard' ? transportConfigMarkup('shipyardCargo', '运兵船预载') : '';
      const types = buildableTypes(siteEntry);
      $('buildGrid').innerHTML = types.length ? types.map(type => {
        const costText = type === 'transport' ? transportCost(uiState.shipyardCargo) : typeMeta(type).cost;
        const disabled = !manageable || game.goldByOwner.player < costText || getUnit(siteEntry.x, siteEntry.y);
        const suffix = type === 'transport' ? `<small> 预载：${describeCargo(uiState.shipyardCargo)}</small>` : `<small> ${domainName(typeMeta(type).domain)} ${tierName(typeMeta(type).level)}</small>`;
        return `<button class="btn build" data-type="${type}" ${disabled ? 'disabled' : ''}><span>${typeMeta(type).icon} ${typeMeta(type).name}${suffix}</span><span class="cost">${costText} 🪙</span></button>`;
      }).join('') : '<div class="muted">该据点不能生产单位。</div>';
    } else {
      $('shipyardConfig').classList.add('hidden');
      $('shipyardConfig').innerHTML = '';
    }

    $('log').innerHTML = game.logs.map(entry => `<div class="entry ${entry.kind}">${entry.text}</div>`).join('');
  }

  function refresh() {
    if (fastSim) {
      return;
    }
    draw();
    updatePanels();
  }

  function selectRef(kind, ref) {
    if (!ref || game.selected?.ref?.id !== ref.id) {
      clearPendingOrder();
    }
    if (!ref) {
      game.selected = null;
      refresh();
      return;
    }
    game.selected = {
      kind,
      ref,
      unit: kind === 'unit' ? ref : getUnit(ref.x, ref.y),
      site: kind === 'site' ? ref : getSite(ref.x, ref.y)
    };
    refresh();
  }

  function tileFromEvent(event) {
    const rect = canvas.getBoundingClientRect();
    const sx = (event.clientX - rect.left) * canvas.width / rect.width;
    const sy = (event.clientY - rect.top) * canvas.height / rect.height;
    return {
      x: Math.floor((cam.x + sx / zoom) / S),
      y: Math.floor((cam.y + sy / zoom) / S)
    };
  }

  function onBoard(event) {
    if (!game || game.over) {
      return;
    }
    const cell = tileFromEvent(event);
    if (!inBounds(cell.x, cell.y)) {
      return;
    }
    const targetUnit = getUnit(cell.x, cell.y);
    const targetSite = getSite(cell.x, cell.y);
    const selectedUnit = game.selected?.kind === 'unit' ? game.selected.ref : null;
    // Only the player's own units can be commanded; foreign units may be selected for info only.
    const ownUnit = selectedUnit && selectedUnit.owner === 'player' ? selectedUnit : null;

    if (game.settings?.spectator) {
      if (targetUnit) {
        selectRef('unit', targetUnit);
        return;
      }
      if (targetSite) {
        selectRef('site', targetSite);
      }
      return;
    }

    if (game.pendingOrder?.kind === 'engineer-launch' && ownUnit && ownUnit.id === game.pendingOrder.builderId && canEngineerLaunch(ownUnit, game.pendingOrder.product, cell, game.pendingOrder.cargoTypes)) {
      engineerLaunch(ownUnit, game.pendingOrder.product, cell, game.pendingOrder.cargoTypes);
      selectRef('unit', ownUnit);
      return;
    }

    if (ownUnit && targetUnit && ownUnit.type === 'transport' && canLoadTransport(ownUnit, targetUnit)) {
      loadTransport(ownUnit, targetUnit);
      selectRef('unit', ownUnit);
      return;
    }
    if (ownUnit && targetUnit && targetUnit.type === 'transport' && canLoadTransport(targetUnit, ownUnit)) {
      loadTransport(targetUnit, ownUnit);
      selectRef('unit', targetUnit);
      return;
    }
    if (ownUnit && !targetUnit && ownUnit.type === 'transport' && canUnloadTransport(ownUnit, cell.x, cell.y)) {
      unloadTransport(ownUnit, cell.x, cell.y);
      selectRef('unit', ownUnit);
      return;
    }
    if (targetUnit?.owner === 'player') {
      ensureStatsStarted();
      const ownStack = unitsAt(cell.x, cell.y).filter(entry => entry.owner === 'player');
      if (ownStack.length > 1 && ownUnit && ownStack.includes(ownUnit)) {
        selectRef('unit', ownStack[(ownStack.indexOf(ownUnit) + 1) % ownStack.length]);
      } else {
        selectRef('unit', targetUnit);
      }
      return;
    }
    if (ownUnit && targetUnit && canAttack(ownUnit, targetUnit)) {
      attack(ownUnit, targetUnit);
      selectRef(game.units.includes(ownUnit) ? 'unit' : null, game.units.includes(ownUnit) ? ownUnit : null);
      return;
    }
    if (targetUnit) {
      selectRef('unit', targetUnit);
      return;
    }
    if (ownUnit && !targetUnit && moveUnit(ownUnit, cell.x, cell.y)) {
      selectRef('unit', ownUnit);
      return;
    }
    if (targetSite) {
      if (targetSite.owner === 'player') {
        ensureStatsStarted();
      }
      selectRef('site', targetSite);
      return;
    }
    toast('请选择己方单位，或点击有效的移动、攻击、装载、卸载目标。');
  }

  function endTurn() {
    if (!game || game.settings?.spectator || game.side !== 'player' || game.over) {
      return;
    }
    clearPendingOrder();
    game.selected = null;
    advanceTurn();
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

  function drawPreview() {
    const pv = $('previewCanvas');
    if (!pv) {
      return;
    }
    const pctx = pv.getContext('2d');
    pctx.clearRect(0, 0, pv.width, pv.height);
    const sx = pv.width / W;
    const sy = pv.height / H;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        pctx.fillStyle = TERRAIN[game.terrain[y][x]].color || '#26333f';
        pctx.fillRect(x * sx, y * sy, Math.ceil(sx), Math.ceil(sy));
      }
    }
    for (const siteEntry of game.sites) {
      pctx.fillStyle = siteEntry.owner === 'neutral' ? '#9fb0bd' : ownerColor(siteEntry.owner);
      const size = siteEntry.kind === 'city' ? Math.max(3, sx) : Math.max(2, sx * 0.7);
      pctx.fillRect(siteEntry.x * sx - size / 2 + sx / 2, siteEntry.y * sy - size / 2 + sy / 2, size, size);
    }
  }

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

  function renderCodex() {
    $('codex').innerHTML = Object.values(TYPES).map(meta => `<div class="codex-item"><div class="icon">${meta.icon}</div><div><div class="title">${meta.name} · ${meta.cost}🪙 · ${domainName(meta.domain)} ${tierName(meta.level)}</div><div class="desc">攻${meta.atk} 防${meta.def} 移${meta.move} 射${meta.range} · ${meta.text}</div></div></div>`).join('');
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

  const {
    SAVE_PREFIX, listSaves, buildSavePayload, saveAsNewSave, overwriteCurrentSave,
    importSaveToList, currentSaveName, loadSave, deleteSave, readSave
  } = createSaves(rt);

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

  function renderSaveList() {
    const saves = listSaves();
    const body = $('saveListBody');
    if (!saves.length) {
      body.innerHTML = '<div class="save-empty">暂无存档。在游戏中点击「暂停 → 存储游戏」即可保存。</div>';
      return;
    }
    body.innerHTML = saves.map(save => `<button class="save-row" data-key="${save.key}"><span class="save-name">${save.name}</span><span class="save-meta">${save.map} · 第 ${save.turn} 回合</span><span class="save-date">${new Date(save.savedAt).toLocaleString('zh-CN')}</span></button>`).join('');
  }

  function renderLobbyPreview() {
    const pv = $('lobbyPreview');
    if (!pv || !pv.getContext) {
      return;
    }
    const dims = computeDimensions($('sizeSelect').value, $('aspectSelect').value);
    W = dims.w;
    H = dims.h;
    const terrain = terrainFor($('mapSelect').value, $('complexitySelect').value, W, H);
    const pctx = pv.getContext('2d');
    pctx.clearRect(0, 0, pv.width, pv.height);
    const sx = pv.width / W;
    const sy = pv.height / H;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        pctx.fillStyle = TERRAIN[terrain[y][x]].color || '#26333f';
        pctx.fillRect(x * sx, y * sy, Math.ceil(sx), Math.ceil(sy));
      }
    }
    const aiCount = Number($('aiSelect').value);
    $('lobbyPreviewMeta').textContent = `${MAPS[$('mapSelect').value].name} · ${SIZES[$('sizeSelect').value].name} · ${ASPECTS[$('aspectSelect').value].name} ${W}×${H} · ${aiCount} 名 AI`;
  }

  function renderAISettings() {
    const count = Number($('aiSelect').value);
    const defaults = ['crimson', 'violet', 'amber', 'jade', 'steel', 'sand', 'teal'];
    $('aiRows').innerHTML = Array.from({ length: count }, (_, i) => {
      const colorOptionsMarkup = colorOptions().map(([key, meta]) => `<option value="${key}" ${key === defaults[i % defaults.length] ? 'selected' : ''}>${meta.name}</option>`).join('');
      const defaultTeam = TEAMS[(i + 1) % TEAMS.length];
      const teamOptionsMarkup = TEAMS.map(team => `<option value="${team}" ${team === defaultTeam ? 'selected' : ''}>${team}组</option>`).join('');
      return `<tr>
        <td class="pt-name">🤖 AI ${i + 1}</td>
        <td><select id="ai${i}Diff" title="AI 难度"><option value="easy">简单</option><option value="medium" selected>中等</option><option value="brutal">冷酷</option><option value="bridgehead">桥头(测试)</option><option value="naval">海防(测试)</option></select></td>
        <td><select id="ai${i}Color" title="AI 颜色">${colorOptionsMarkup}</select></td>
        <td><select id="ai${i}Team" title="AI 组别">${teamOptionsMarkup}</select></td>
        <td><select id="ai${i}Agg" title="AI 进攻欲"><option value="cautious">谨慎</option><option value="balanced" selected>均衡</option><option value="reckless">冲动</option></select></td>
      </tr>`;
    }).join('');
  }

  function renderRules() {
    $('rulesContent').innerHTML = `
      <div class="rule-version">
        <h3 class="info-section-title">基础玩法</h3>
        <div class="rule-grid">
          <section class="rule-block"><h3>回合流程</h3><ul><li>每个阵营依次行动；回合开始时统一重置移动、结算收入、回血与维修。</li><li>单位可先机动再攻击，但每回合只能攻击一次；攻击后本回合不能再机动。</li><li>玩家和 AI 完全共用同一套伤害、生产、升级、维修和运输规则。</li></ul></section>
          <section class="rule-block"><h3>三种模式</h3><ul><li>征服：占领全部城市，并消灭全部敌对工程师后获胜。</li><li>遭遇战：敌对组全部野战部队被消灭时获胜。</li><li>守城：坚持到第12回合且仍保有己方关键城市时获胜。</li></ul></section>
          <section class="rule-block"><h3>移动与地形</h3><ul><li>陆军只能在陆地移动，不能进入海域与山脉。</li><li>海军只能在海域行动，船坞与海上堡垒也属于海上据点。</li><li>森林提供额外防御但增加移动消耗，道路降低机动成本。</li></ul></section>
          <section class="rule-block"><h3>战斗与反击</h3><ul><li>伤害由兵种攻防、当前生命、地形、驻防和克制共同决定。</li><li>只要射程覆盖，防守方就能反击；先手不再拥有单方面碾压优势。</li><li>长枪兵克制骑兵，战船克制运兵船，骑兵满机动接战时获得冲锋加成。</li></ul></section>
          <section class="rule-block"><h3>据点与经济</h3><ul><li>城市生产陆军，港口/造船厂生产海军与预载运兵船，海上堡垒不能生产但可提供海上防御。</li><li>临时营地视为中级城市，不产金币，只能维持 3 回合，且不能被占领。</li><li>驻军可花费金币修整，AI 也会按局势使用同一功能。</li></ul></section>
          <section class="rule-block"><h3>海军与运输</h3><ul><li>战船负责制海、拦截和海上火力压制。</li><li>运兵船可直接预载 0 到 5 个陆军单位下水，登陆后立即释放兵力。</li><li>港口/造船厂位于水中且紧贴陆地；海上堡垒位于深海，不与陆地相邻。</li></ul></section>
          <section class="rule-block"><h3>工程师与胜利</h3><ul><li>工程师可在靠海陆格的相邻海格造出战船或运兵船，也可原地建立临时营地。</li><li>征服模式中，占领全部城市后还必须清除敌对组全部工程师，才能真正锁定胜利。</li><li>敌方单位进入临时营地所在格时，可将其直接摧毁。</li></ul></section>
          <section class="rule-block"><h3>AI 规则</h3><ul><li>AI 会升级据点、花钱造兵、集火残血、评估反击风险并争夺高价值目标。</li><li>冷酷 AI 额外进行团队级目标规划，优先组织围攻、连续压制、载员登陆和工程师扩张。</li><li>进攻欲改变前压程度与冒险意愿，不会修改基础战斗数值。</li></ul></section>
        </div>
        <h3 class="info-section-title">单位图鉴</h3>
        <div class="codex" id="codex"></div>
        <h3 class="info-section-title">新增海图</h3>
        <ul><li>海岸丘陵：长海岸线，重视沿海登陆与抢港口。</li><li>群岛与海峡：多岛链和狭航道，适合争夺制海权。</li><li>内海争夺：中央内海切割大陆，船坞控制非常关键。</li><li>海湾登陆：大型海湾切入内陆，利于多方向两栖包抄。</li><li>裂海海峡：大陆被宽海峡分割，海军和运兵船决定节奏。</li><li>断链群岛：岛屿极多，海上堡垒和前沿船坞价值极高。</li></ul>
        <h3 class="info-section-title">版本 0.1.2 变更</h3>
        <ul><li>港口/造船厂现在可以直接生产预载 0 到 5 个陆军单位的运兵船。</li><li>新增工程师兵种，可在海边造舰，或建立持续 3 回合的临时营地。</li><li>征服模式改为“占领全部城市并清除全部敌方工程师”才算获胜。</li><li>冷酷 AI 新增工程师扩张、载员登陆和反登陆应对逻辑。</li><li>新增战场纵横比设置，可选宽幅、标准、方阵、纵深。</li><li>预增加：地势高低区分、更多海军、更多海上建筑、更有策略的 AI、更大地图、更多 AI 玩家数、更多组别、战役关卡。</li></ul>
      </div>`;
  }

  function setup() {
    for (const [id, meta] of Object.entries(MAPS)) {
      $('mapSelect').insertAdjacentHTML('beforeend', `<option value="${id}">${meta.name}</option>`);
    }
    for (const [id, name] of Object.entries(MODES)) {
      $('modeSelect').insertAdjacentHTML('beforeend', `<option value="${id}">${name}</option>`);
    }
    for (let count = 1; count <= 7; count++) {
      $('aiSelect').insertAdjacentHTML('beforeend', `<option value="${count}">${count} 名</option>`);
    }
    $('spectatorSelect').insertAdjacentHTML('beforeend', `<option value="off" selected>关闭</option><option value="on">开启</option>`);
    for (const team of TEAMS) {
      $('playerTeamSelect').insertAdjacentHTML('beforeend', `<option value="${team}" ${team === 'A' ? 'selected' : ''}>${team}组</option>`);
    }
    for (const [id, meta] of colorOptions()) {
      $('playerColorSelect').insertAdjacentHTML('beforeend', `<option value="${id}" ${id === 'azure' ? 'selected' : ''}>${meta.name}</option>`);
    }
    for (let count = 0; count <= 6; count++) {
      $('startUnitsSelect').insertAdjacentHTML('beforeend', `<option value="${count}" ${count === 4 ? 'selected' : ''}>${count} 个 / 阵营</option>`);
    }
    for (const [id, meta] of Object.entries(SIZES)) {
      $('sizeSelect').insertAdjacentHTML('beforeend', `<option value="${id}" ${id === 'medium' ? 'selected' : ''}>${meta.name}</option>`);
    }
    for (const [id, meta] of Object.entries(ASPECTS)) {
      $('aspectSelect').insertAdjacentHTML('beforeend', `<option value="${id}" ${id === 'standard' ? 'selected' : ''}>${meta.name}</option>`);
    }
    for (const [id, meta] of Object.entries(COMPLEX)) {
      $('complexitySelect').insertAdjacentHTML('beforeend', `<option value="${id}" ${id === 'medium' ? 'selected' : ''}>${meta.name}</option>`);
    }
    $('mapSelect').value = 'coast';
    $('spreadValue').textContent = `${$('citySpread').value}%`;
    $('aiSpeedValue').textContent = `${$('aiSpeed').value}s`;
    $('buildCapValue').textContent = `${$('buildCap').value}`;
    renderAISettings();
    renderRules();
    renderCodex();

    $('aiSelect').addEventListener('change', renderAISettings);
    $('citySpread').addEventListener('input', () => {
      $('spreadValue').textContent = `${$('citySpread').value}%`;
    });
    $('aiSpeed').addEventListener('input', () => {
      $('aiSpeedValue').textContent = `${$('aiSpeed').value}s`;
    });
    $('buildCap').addEventListener('input', () => {
      $('buildCapValue').textContent = `${$('buildCap').value}`;
    });
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
    canvas.addEventListener('mousedown', event => {
      if (event.button === 2 && mapIsPanned()) {
        panState = { x: event.clientX, y: event.clientY, moved: false };
      }
    });
    canvas.addEventListener('wheel', event => {
      if (!game || game.over) {
        return;
      }
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const sx = (event.clientX - rect.left) * canvas.width / rect.width;
      const sy = (event.clientY - rect.top) * canvas.height / rect.height;
      const worldX = cam.x + sx / zoom;
      const worldY = cam.y + sy / zoom;
      zoom = clamp(zoom * (event.deltaY < 0 ? 1.15 : 1 / 1.15), minZoom(), 3);
      // Keep the map point under the cursor fixed while zooming.
      cam.x = worldX - sx / zoom;
      cam.y = worldY - sy / zoom;
      clampCam();
      draw();
    }, { passive: false });
    window.addEventListener('mousemove', event => {
      if (!panState) {
        return;
      }
      const rect = canvas.getBoundingClientRect();
      const scale = canvas.width / rect.width;
      const dx = event.clientX - panState.x;
      const dy = event.clientY - panState.y;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
        panState.moved = true;
      }
      cam.x -= dx * scale / zoom;
      cam.y -= dy * scale / zoom;
      panState.x = event.clientX;
      panState.y = event.clientY;
      clampCam();
      draw();
    });
    window.addEventListener('mouseup', event => {
      if (event.button === 2 && panState) {
        panSuppressContext = panState.moved;
        panState = null;
      }
    });
    canvas.addEventListener('contextmenu', event => {
      event.preventDefault();
      if (panSuppressContext) {
        panSuppressContext = false;
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
      newGame: () => newGame()
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