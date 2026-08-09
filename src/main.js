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
import { saveStore } from './io/storage.js';

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
  const distFieldCache = new Map();
  const landReachCache = new Map();
  const uiState = {
    shipyardCargo: ['none', 'none', 'none', 'none', 'none'],
    engineerCargo: ['none', 'none', 'none', 'none', 'none']
  };

  function inBounds(x, y) {
    return x >= 0 && y >= 0 && x < W && y < H;
  }

  function grid(fill) {
    return Array.from({ length: H }, () => Array(W).fill(fill));
  }

  function adjacent4(x, y) {
    return [[1, 0], [-1, 0], [0, 1], [0, -1]]
      .map(([dx, dy]) => ({ x: x + dx, y: y + dy }))
      .filter(cell => inBounds(cell.x, cell.y));
  }

  function adjacent8(x, y) {
    return [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]
      .map(([dx, dy]) => ({ x: x + dx, y: y + dy }))
      .filter(cell => inBounds(cell.x, cell.y));
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

  function frontMemory(owner) {
    if (!game.aiFrontMemory[owner]) {
      game.aiFrontMemory[owner] = {};
    }
    return game.aiFrontMemory[owner];
  }

  function decayFrontMemory(owner) {
    const memory = frontMemory(owner);
    for (const key of Object.keys(memory)) {
      if (memory[key].cooldown > 0) {
        memory[key].cooldown -= 1;
      }
      if (memory[key].cooldown <= 0 && memory[key].stalls <= 0) {
        delete memory[key];
      }
    }
  }

  function rememberFrontOutcome(owner, objectiveKey, movedThisTurn) {
    if (!objectiveKey || !objectiveKey.startsWith('site:')) {
      return;
    }
    const memory = frontMemory(owner);
    const entry = memory[objectiveKey] || { stalls: 0, cooldown: 0 };
    if (movedThisTurn) {
      entry.stalls = Math.max(0, entry.stalls - 1);
    } else {
      entry.stalls += 1;
      if (entry.stalls >= 3) {
        entry.cooldown = Math.max(entry.cooldown, 3);
        entry.stalls = 0;
      }
    }
    memory[objectiveKey] = entry;
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

  function randomId() {
    return Math.random().toString(36).slice(2);
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

  function unit(type, owner, x, y) {
    const meta = typeMeta(type);
    return {
      id: randomId(),
      type,
      owner,
      x,
      y,
      hp: meta.hp,
      maxHp: meta.hp,
      move: meta.move,
      maxMove: meta.move,
      baseMove: meta.move,
      acted: false,
      hasAttacked: false,
      lastAttacked: false,
      kills: 0,
      rank: 0,
      cargo: meta.transport ? [] : null
    };
  }

  function createCargoPayload(owner, type) {
    return {
      type,
      owner,
      hp: typeMeta(type).hp,
      maxHp: typeMeta(type).hp,
      lastAttacked: false
    };
  }

  function createLoadedTransport(owner, x, y, cargoTypes = []) {
    const transport = unit('transport', owner, x, y);
    transport.cargo = normalizeCargoTypes(cargoTypes).map(type => createCargoPayload(owner, type));
    return transport;
  }

  function site(kind, owner, x, y, name, tier = 1, income = null) {
    return {
      id: randomId(),
      kind,
      owner,
      x,
      y,
      name,
      tier,
      income: income == null ? siteMeta(kind).income : income
    };
  }

  function createCamp(owner, x, y) {
    const camp = site('camp', owner, x, y, '临时营地', 2, 0);
    camp.duration = CAMP_DURATION;
    camp.uncapturable = true;
    return camp;
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

  function terrainCellCounts() {
    if (game.__cellCounts) {
      return game.__cellCounts;
    }
    let land = 0;
    let sea = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (game.terrain[y][x] === 'water') {
          sea += 1;
        } else if (game.terrain[y][x] !== 'mountain') {
          land += 1;
        }
      }
    }
    game.__cellCounts = { land, sea };
    return game.__cellCounts;
  }

  function unitCapFor(domain) {
    const counts = terrainCellCounts();
    const participants = Math.max(1, game.ownerOrder.length);
    const cells = domain === 'sea' ? counts.sea : counts.land;
    return Math.max(1, Math.floor(cells / (participants + 1)));
  }

  function ownedUnitCount(owner, domain) {
    return game.units.filter(entry => entry.owner === owner && typeMeta(entry.type).domain === domain).length;
  }

  function atUnitCap(owner, domain) {
    return ownedUnitCount(owner, domain) >= unitCapFor(domain);
  }

  function campCount(owner) {
    return game.sites.filter(entry => entry.kind === 'camp' && entry.owner === owner).length;
  }

  function unitBuildCost(unitEntry) {
    if (unitEntry.type === 'transport') {
      return transportCost((unitEntry.cargo || []).map(payload => payload.type));
    }
    return typeMeta(unitEntry.type).cost;
  }

  function sellRefund(unitEntry) {
    return Math.floor(unitBuildCost(unitEntry) / 2);
  }

  function sellUnit(owner, unitEntry) {
    if (!unitEntry || unitEntry.owner !== owner || game.side !== owner || game.over) {
      return false;
    }
    const refund = sellRefund(unitEntry);
    game.goldByOwner[owner] += refund;
    game.units = game.units.filter(entry => entry !== unitEntry);
    incrementStrat(owner, 'sells');
    if (game.selected?.ref === unitEntry) {
      game.selected = null;
    }
    log(`${ownerName(owner)}变卖了${typeMeta(unitEntry.type).name}，回收 ${refund} 🪙。`, 'gold');
    return true;
  }

  function forceCrowding(owner) {
    const units = game.units.filter(entry => entry.owner === owner);
    if (!units.length) {
      return 0;
    }
    const stalled = units.filter(entry => (entry.aiState?.stalledTurns || 0) >= 2).length;
    return stalled / units.length;
  }

  function capacityPressure(owner) {
    const landRatio = ownedUnitCount(owner, 'land') / Math.max(1, unitCapFor('land'));
    const seaRatio = ownedUnitCount(owner, 'sea') / Math.max(1, unitCapFor('sea'));
    return Math.max(landRatio, seaRatio);
  }

  function cargoOptionTypes() {
    return Object.keys(TYPES).filter(type => typeMeta(type).domain === 'land');
  }

  function normalizeCargoTypes(types) {
    return (types || []).filter(type => type && type !== 'none' && TYPES[type] && typeMeta(type).domain === 'land').slice(0, typeMeta('transport').transport);
  }

  function sameCell(a, b) {
    return !!a && !!b && a.x === b.x && a.y === b.y;
  }

  function rankFromKills(kills) {
    let rank = 0;
    for (let index = 0; index < UNIT_RANK_THRESHOLDS.length; index++) {
      if (kills >= UNIT_RANK_THRESHOLDS[index]) {
        rank = index;
      }
    }
    return rank;
  }

  function effectiveMove(unitEntry) {
    return unitEntry.baseMove + Math.floor(unitEntry.rank / 2);
  }

  function healMultiplier(unitEntry) {
    return 1 + unitEntry.rank * 0.15;
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

  function transportCost(cargoTypes = []) {
    return typeMeta('transport').cost + normalizeCargoTypes(cargoTypes).reduce((sum, type) => sum + typeMeta(type).cost, 0);
  }

  function cargoLabel(type) {
    return type === 'none' ? '空位' : `${typeMeta(type).icon} ${typeMeta(type).name}`;
  }

  function describeCargo(cargoTypes = []) {
    const types = normalizeCargoTypes(cargoTypes);
    return types.length ? types.map(type => typeMeta(type).name).join('、') : '空舱';
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

  function createEllipse(terrain, cx, cy, rx, ry, fillTerrain, chance = 1) {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const nx = (x - cx) / rx;
        const ny = (y - cy) / ry;
        if (nx * nx + ny * ny <= 1 && Math.random() <= chance) {
          terrain[y][x] = fillTerrain;
        }
      }
    }
  }

  function paintRiver(terrain, center, phase = 0) {
    for (let y = 0; y < H; y++) {
      const riverX = Math.round(center + Math.sin(y * 0.65 + phase) * 1.6 + Math.sin(y * 0.19) * 0.8);
      terrain[y][clamp(riverX, 1, W - 2)] = 'water';
      if (y % 5 === 2) {
        terrain[y][clamp(riverX, 1, W - 2)] = 'road';
      }
    }
  }

  function paintRidge(terrain, center) {
    for (let x = 0; x < W; x++) {
      const ridgeY = Math.round(center + Math.sin(x * 0.52) * 1.7 + Math.sin(x * 0.18) * 1.1);
      for (let dy = -1; dy <= 1; dy++) {
        const y = clamp(ridgeY + dy, 1, H - 2);
        terrain[y][x] = 'mountain';
      }
      if (x % 7 === 3) {
        terrain[clamp(ridgeY, 1, H - 2)][x] = 'road';
      }
    }
  }

  function addRoadCross(terrain) {
    const midY = Math.floor(H / 2);
    const midX = Math.floor(W / 2);
    for (let x = 1; x < W - 1; x++) {
      if (terrain[midY][x] !== 'water' && terrain[midY][x] !== 'mountain') {
        terrain[midY][x] = 'road';
      }
    }
    for (let y = 1; y < H - 1; y++) {
      if (terrain[y][midX] !== 'water' && terrain[y][midX] !== 'mountain') {
        terrain[y][midX] = 'road';
      }
    }
  }

  function scatter(terrain, type, count, radius, allowed) {
    for (let i = 0; i < count; i++) {
      const cx = rnd(W);
      const cy = rnd(H);
      const r = 1 + rnd(radius);
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const x = cx + dx;
          const y = cy + dy;
          if (!inBounds(x, y) || !allowed.includes(terrain[y][x])) {
            continue;
          }
          if (Math.hypot(dx, dy) <= r + 0.4 && Math.random() > 0.18) {
            terrain[y][x] = type;
          }
        }
      }
    }
  }

  function terrainFor(mapId, complexityId) {
    const terrain = grid('plain');
    const complexity = COMPLEX[complexityId];
    switch (mapId) {
      case 'frontier':
        paintRiver(terrain, W * 0.48, 0);
        paintRidge(terrain, H * 0.26);
        break;
      case 'twinrivers':
        paintRiver(terrain, W * 0.34, 0.25);
        paintRiver(terrain, W * 0.67, 1.15);
        break;
      case 'highlands':
        paintRidge(terrain, H * 0.38);
        paintRidge(terrain, H * 0.68);
        break;
      case 'plains':
        addRoadCross(terrain);
        break;
      case 'heartland':
        addRoadCross(terrain);
        createEllipse(terrain, W * 0.2, H * 0.25, 4, 2, 'forest', 0.94);
        createEllipse(terrain, W * 0.78, H * 0.72, 4, 3, 'forest', 0.94);
        break;
      case 'coast':
        for (let y = 0; y < H; y++) {
          const shore = Math.floor(W * 0.22 + Math.sin(y * 0.42) * 2);
          for (let x = 0; x <= shore; x++) {
            terrain[y][x] = 'water';
          }
        }
        paintRidge(terrain, H * 0.7);
        break;
      case 'islands':
        for (let y = 0; y < H; y++) {
          for (let x = 0; x < W; x++) {
            terrain[y][x] = 'water';
          }
        }
        createEllipse(terrain, W * 0.22, H * 0.48, 5, 3, 'plain', 0.96);
        createEllipse(terrain, W * 0.5, H * 0.3, 4, 2, 'plain', 0.95);
        createEllipse(terrain, W * 0.72, H * 0.66, 6, 3, 'plain', 0.95);
        createEllipse(terrain, W * 0.45, H * 0.78, 3, 2, 'plain', 0.92);
        break;
      case 'innersea':
        createEllipse(terrain, W * 0.5, H * 0.52, W * 0.22, H * 0.3, 'water', 0.98);
        addRoadCross(terrain);
        break;
      case 'grandbay':
        createEllipse(terrain, W * 0.14, H * 0.78, W * 0.36, H * 0.42, 'water', 0.98);
        createEllipse(terrain, W * 0.42, H * 0.58, 3, 2, 'water', 0.9);
        break;
      case 'strait':
        for (let y = 0; y < H; y++) {
          const seaX = Math.floor(W * 0.5 + Math.sin(y * 0.42) * 1.1);
          for (let dx = -2; dx <= 2; dx++) {
            if (inBounds(seaX + dx, y)) {
              terrain[y][seaX + dx] = 'water';
            }
          }
        }
        createEllipse(terrain, W * 0.48, H * 0.24, 2, 1, 'plain', 1);
        createEllipse(terrain, W * 0.5, H * 0.73, 2, 1, 'plain', 1);
        break;
      case 'archipelago':
        for (let y = 0; y < H; y++) {
          for (let x = 0; x < W; x++) {
            terrain[y][x] = 'water';
          }
        }
        createEllipse(terrain, W * 0.28, H * 0.34, 5, 3, 'plain', 0.96);
        createEllipse(terrain, W * 0.62, H * 0.25, 4, 2, 'plain', 0.94);
        createEllipse(terrain, W * 0.77, H * 0.62, 6, 3, 'plain', 0.95);
        createEllipse(terrain, W * 0.44, H * 0.72, 5, 2, 'plain', 0.93);
        createEllipse(terrain, W * 0.12, H * 0.74, 3, 2, 'plain', 0.92);
        break;
      case 'random':
        for (let y = 0; y < H; y++) {
          for (let x = 0; x < W; x++) {
            const roll = Math.random();
            terrain[y][x] = roll < complexity.water ? 'water' : roll < complexity.water + complexity.mountain ? 'mountain' : roll < complexity.water + complexity.mountain + complexity.forest ? 'forest' : 'plain';
          }
        }
        addRoadCross(terrain);
        break;
      default:
        break;
    }
    if (mapId !== 'random') {
      scatter(terrain, 'forest', Math.max(2, Math.round(W * H * complexity.forest / 24)), 2, ['plain']);
      scatter(terrain, 'mountain', Math.max(1, Math.round(W * H * complexity.mountain / 34)), 1, ['plain']);
      if (!MAPS[mapId].sea) {
        scatter(terrain, 'water', Math.max(0, Math.round(W * H * complexity.water / 70)), 1, ['plain']);
      }
    }
    return terrain;
  }

  function ownerExists(owner) {
    return game.units.some(entry => entry.owner === owner) || game.sites.some(entry => entry.owner === owner);
  }

  function movementCost(unitEntry, x, y) {
    return typeMeta(unitEntry.type).domain === 'sea' ? 1 : TERRAIN[game.terrain[y][x]].cost;
  }

  function passable(unitEntry, x, y) {
    if (!inBounds(x, y) || getUnit(x, y)) {
      return false;
    }
    const domain = typeMeta(unitEntry.type).domain;
    if (domain === 'sea') {
      return game.terrain[y][x] === 'water';
    }
    return game.terrain[y][x] !== 'water' && game.terrain[y][x] !== 'mountain';
  }

  function movementNeighbors(unitEntry, currentCost, x, y) {
    // 8-directional movement, consistent with the diagonal (Chebyshev) adjacency used for attacks and reachability.
    return adjacent8(x, y);
  }

  function reachable(unitEntry) {
    const seen = new Map([[cellKey(unitEntry.x, unitEntry.y), 0]]);
    const queue = [{ x: unitEntry.x, y: unitEntry.y, cost: 0 }];
    while (queue.length) {
      const current = queue.shift();
      for (const next of movementNeighbors(unitEntry, current.cost, current.x, current.y)) {
        if (!passable(unitEntry, next.x, next.y)) {
          continue;
        }
        // Diagonal steps cost ~√2 so the reachable area stays round (octagon) instead of a square.
        const step = movementCost(unitEntry, next.x, next.y);
        const diagonal = next.x !== current.x && next.y !== current.y;
        const cost = current.cost + (diagonal ? step * Math.SQRT2 : step);
        const key = cellKey(next.x, next.y);
        if (cost > unitEntry.move) {
          continue;
        }
        if (!seen.has(key) || cost < seen.get(key)) {
          seen.set(key, cost);
          queue.push({ x: next.x, y: next.y, cost });
        }
      }
    }
    return seen;
  }

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

  function siteBonus(siteEntry, unitEntry, mode) {
    if (!siteEntry || !areAllies(siteEntry.owner, unitEntry.owner)) {
      return 0;
    }
    const domain = typeMeta(unitEntry.type).domain;
    if ((siteEntry.kind === 'city' || siteEntry.kind === 'camp' || siteEntry.kind === 'barracksSmall' || siteEntry.kind === 'barracksLarge') && domain === 'land') {
      const supportTier = siteMeta(siteEntry.kind).supportTier || siteEntry.tier;
      return mode === 'attack' ? supportTier : supportTier * 2;
    }
    if (siteEntry.kind === 'shipyard' && domain === 'sea') {
      return mode === 'attack' ? siteEntry.tier : siteEntry.tier + 1;
    }
    if (siteEntry.kind === 'fortress' && domain === 'sea') {
      return mode === 'attack' ? 1 : 3;
    }
    return 0;
  }

  function matchupBonus(attacker, defender) {
    const bonusVs = typeMeta(attacker.type).bonusVs || {};
    return bonusVs[defender.type] || 0;
  }

  function computeDamage(attacker, defender, fromCell, toCell, isCounter, deterministic) {
    const attackMeta = typeMeta(attacker.type);
    const defenseMeta = typeMeta(defender.type);
    const attackSite = getSite(fromCell.x, fromCell.y);
    const defenseSite = getSite(toCell.x, toCell.y);
    const terrainDef = TERRAIN[game.terrain[toCell.y][toCell.x]].def;
    const attackBuff = siteBonus(attackSite, attacker, 'attack') + matchupBonus(attacker, defender);
    const defenseBuff = siteBonus(defenseSite, defender, 'defense') + terrainDef;
    const attackHpFactor = 0.55 + attacker.hp / attacker.maxHp * 0.65;
    const defendHpFactor = 0.55 + defender.hp / defender.maxHp * 0.55;
    const charge = attackMeta.charge && !isCounter && diagonalDist(fromCell, toCell) === 1 && attacker.move === attacker.maxMove ? attackMeta.charge : 0;
    const base = (attackMeta.atk + attackBuff + attacker.rank) * attackHpFactor + charge;
    const shield = (defenseMeta.def + defenseBuff) * defendHpFactor;
    const variance = deterministic ? 1 : rnd(3);
    return clamp(Math.round(base - shield * 0.58 + 2 + variance), 1, defender.hp);
  }

  function previewCombat(attacker, defender, fromCell, deterministic) {
    const attackFrom = fromCell || { x: attacker.x, y: attacker.y };
    const damage = computeDamage(attacker, defender, attackFrom, { x: defender.x, y: defender.y }, false, deterministic);
    const targetLeft = Math.max(0, defender.hp - damage);
    let counter = 0;
    if (targetLeft > 0 && inUnitRange(typeMeta(defender.type).range, { x: defender.x, y: defender.y }, attackFrom)) {
      counter = clamp(Math.round(computeDamage(defender, attacker, { x: defender.x, y: defender.y }, attackFrom, true, deterministic) * 0.8), 0, attacker.hp);
    }
    return { damage, counter, kill: targetLeft <= 0, targetLeft, selfLeft: Math.max(0, attacker.hp - counter) };
  }

  function canAttack(attacker, defender, fromCell = { x: attacker.x, y: attacker.y }) {
    return !!attacker && !!defender && attacker.owner === game.side && !attacker.hasAttacked && areEnemies(attacker.owner, defender.owner) && inUnitRange(typeMeta(attacker.type).range, fromCell, defender);
  }

  function removeUnit(unitEntry) {
    if (unitEntry.cargo?.length) {
      log(`${typeMeta(unitEntry.type).name}被击沉，船上搭载单位全部损失。`, 'warning');
    }
    incrementStat('losses', unitEntry.owner, 1 + (unitEntry.cargo?.length || 0));
    game.units = game.units.filter(entry => entry !== unitEntry);
    recordStatSnapshot('loss');
    // Detect elimination victories the moment the last enemy unit dies, not only at turn start.
    if (!game.over) {
      checkEnd();
    }
  }

  function attack(attacker, defender) {
    const result = previewCombat(attacker, defender, { x: attacker.x, y: attacker.y }, false);
    defender.hp -= result.damage;
    defender.lastAttacked = true;
    attacker.move = 0;
    attacker.hasAttacked = true;
    attacker.acted = true;
    log(`${ownerName(attacker.owner)}的${typeMeta(attacker.type).name}攻击${ownerName(defender.owner)}的${typeMeta(defender.type).name}，造成 ${result.damage} 点伤害。`, 'battle');
    if (defender.hp <= 0) {
      incrementStat('kills', attacker.owner, 1 + (defender.cargo?.length || 0));
      grantKills(attacker, 1 + (defender.cargo?.length || 0));
      removeUnit(defender);
      log(`${typeMeta(defender.type).name}被消灭。`, 'battle');
    } else if (result.counter > 0) {
      attacker.hp -= result.counter;
      log(`${typeMeta(defender.type).name}反击，造成 ${result.counter} 点伤害。`, 'battle');
      if (attacker.hp <= 0) {
        incrementStat('kills', defender.owner, 1 + (attacker.cargo?.length || 0));
        grantKills(defender, 1 + (attacker.cargo?.length || 0));
        removeUnit(attacker);
        log(`${typeMeta(attacker.type).name}在反击中被击毁。`, 'battle');
      }
    }
    checkEnd();
  }

  function strategicSiteValue(siteEntry, owner, unitEntry) {
    if (siteEntry.owner === owner || areAllies(siteEntry.owner, owner)) {
      return 0;
    }
    let score = siteEntry.kind === 'city' ? 26 : siteEntry.kind === 'shipyard' ? 24 : siteEntry.kind === 'camp' ? 14 : siteEntry.kind.startsWith('oil') ? 24 : siteEntry.kind.startsWith('barracks') ? 20 : 18;
    score += siteEntry.income + siteEntry.tier * 5;
    if (siteEntry.owner === 'neutral') {
      score *= 0.82;
    }
    if (unitEntry) {
      const domain = typeMeta(unitEntry.type).domain;
      if ((siteEntry.kind === 'city' || siteEntry.kind.startsWith('oil') || siteEntry.kind.startsWith('barracks')) && domain === 'sea') {
        score *= 0.3;
      }
      if ((siteEntry.kind === 'shipyard' || siteEntry.kind === 'fortress') && domain === 'land') {
        score *= 0.25;
      }
    }
    return score;
  }

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

  function moveUnit(unitEntry, x, y) {
    const cost = reachable(unitEntry).get(cellKey(x, y));
    if (cost === undefined || unitEntry.hasAttacked) {
      return false;
    }
    unitEntry.x = x;
    unitEntry.y = y;
    unitEntry.move -= cost;
    unitEntry.acted = true;
    captureSite(unitEntry);
    return true;
  }

  function canLoadTransport(transport, passenger) {
    return !!transport && !!passenger && !!typeMeta(transport.type).transport && typeMeta(passenger.type).domain === 'land' && transport.owner === passenger.owner && diagonalDist(transport, passenger) === 1 && transport.cargo.length < typeMeta(transport.type).transport;
  }

  function loadTransport(transport, passenger) {
    if (!canLoadTransport(transport, passenger)) {
      return false;
    }
    transport.cargo.push({ type: passenger.type, owner: passenger.owner, hp: passenger.hp, maxHp: passenger.maxHp, lastAttacked: passenger.lastAttacked });
    game.units = game.units.filter(entry => entry !== passenger);
    transport.acted = true;
    log(`${typeMeta(passenger.type).name}登上了运兵船。`, 'system');
    return true;
  }

  function canUnloadTransport(transport, x, y) {
    if (!transport || !transport.cargo?.length || diagonalDist(transport, { x, y }) !== 1 || !isLandTile(x, y)) {
      return false;
    }
    // Stacking is created only by unloading: target must be empty or already hold <3 friendly land units.
    const occupants = unitsAt(x, y);
    return occupants.length < MAX_STACK && occupants.every(entry => entry.owner === transport.owner && typeMeta(entry.type).domain === 'land');
  }

  function unloadTransport(transport, x, y) {
    if (!canUnloadTransport(transport, x, y)) {
      return false;
    }
    const payload = transport.cargo.shift();
    const unitEntry = unit(payload.type, payload.owner, x, y);
    unitEntry.hp = payload.hp;
    unitEntry.maxHp = payload.maxHp;
    unitEntry.move = 0;
    unitEntry.acted = true;
    unitEntry.hasAttacked = true;
    unitEntry.lastAttacked = payload.lastAttacked;
    game.units.push(unitEntry);
    transport.acted = true;
    if (unitEntry.type === 'engineer') {
      incrementStrat(unitEntry.owner, 'engineerLandings');
    }
    log(`${typeMeta(unitEntry.type).name}完成登陆。`, 'system');
    captureSite(unitEntry);
    return true;
  }

  function autoLoadAdjacent(transport) {
    const options = game.units.filter(entry => entry.owner === transport.owner && typeMeta(entry.type).domain === 'land' && diagonalDist(entry, transport) === 1);
    options.sort((a, b) => typeMeta(b.type).level - typeMeta(a.type).level || b.hp - a.hp);
    return options.length ? loadTransport(transport, options[0]) : false;
  }

  function strategicLandingScore(owner, cell) {
    let score = 0;
    for (const siteEntry of game.sites) {
      if (areEnemies(siteEntry.owner, owner) && (siteEntry.kind === 'city' || siteEntry.kind.startsWith('oil'))) {
        score += 18 / (1 + dist(siteEntry, cell));
      }
    }
    // Prefer undefended beaches: land where the enemy is thin, not into their defensive line.
    score -= nearbyEnemies(cell, owner, 2) * 8;
    score -= nearbyEnemies(cell, owner, 4) * 3;
    return score;
  }

  function autoUnloadAdjacent(transport) {
    const cells = adjacent8(transport.x, transport.y).filter(cell => canUnloadTransport(transport, cell.x, cell.y));
    if (!cells.length) {
      return false;
    }
    cells.sort((a, b) => strategicLandingScore(transport.owner, b) - strategicLandingScore(transport.owner, a));
    return unloadTransport(transport, cells[0].x, cells[0].y);
  }

  function supportSites(unitEntry) {
    return game.sites.filter(siteEntry => areAllies(siteEntry.owner, unitEntry.owner) && ((((siteEntry.kind === 'city' || siteEntry.kind === 'camp' || siteEntry.kind === 'barracksSmall' || siteEntry.kind === 'barracksLarge') && typeMeta(unitEntry.type).domain === 'land')) || ((siteEntry.kind === 'shipyard' || siteEntry.kind === 'fortress') && typeMeta(unitEntry.type).domain === 'sea')));
  }

  function decayTemporarySites(owner) {
    const expired = [];
    for (const siteEntry of game.sites) {
      if (siteEntry.kind !== 'camp' || siteEntry.owner !== owner) {
        continue;
      }
      siteEntry.duration -= 1;
      if (siteEntry.duration <= 0) {
        expired.push(siteEntry);
      }
    }
    if (!expired.length) {
      return;
    }
    game.sites = game.sites.filter(siteEntry => !expired.includes(siteEntry));
    if (expired.includes(game.selected?.ref)) {
      game.selected = null;
    }
    expired.forEach(siteEntry => log(`${siteEntry.name}补给耗尽，已自行拆除。`, 'warning'));
  }

  function healOwner(owner) {
    for (const unitEntry of game.units.filter(entry => entry.owner === owner)) {
      const supports = supportSites(unitEntry);
      if (!supports.length) {
        unitEntry.lastAttacked = false;
        continue;
      }
      const nearest = Math.min(...supports.map(siteEntry => dist(siteEntry, unitEntry)));
      if (!unitEntry.lastAttacked) {
        const ratio = (nearest === 0 ? 0.16 : nearest <= 1 ? 0.1 : nearest >= 14 ? 0.02 : Math.max(0.02, 0.1 - (nearest - 1) * 0.08 / 13)) * healMultiplier(unitEntry);
        unitEntry.hp = Math.min(unitEntry.maxHp, unitEntry.hp + Math.max(1, Math.ceil(unitEntry.maxHp * ratio)));
      }
      unitEntry.lastAttacked = false;
    }
  }

  function grantIncome(owner) {
    const base = game.sites.filter(entry => entry.owner === owner).reduce((sum, entry) => sum + entry.income, 0);
    const gain = Math.round(base * (game.settings?.incomeMult || 1));
    game.goldByOwner[owner] += gain;
    if (gain > 0) {
      log(`${ownerName(owner)}获得 ${gain} 金币收入。`, 'gold');
    }
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

  function teamStandings() {
    const standings = {};
    const ensure = team => (standings[team] = standings[team] || { cities: 0, sites: 0, units: 0 });
    for (const siteEntry of game.sites) {
      if (siteEntry.owner === 'neutral') {
        continue;
      }
      const bucket = ensure(teamOf(siteEntry.owner));
      bucket.sites += 1;
      if (siteEntry.kind === 'city') {
        bucket.cities += 1;
      }
    }
    for (const unitEntry of game.units) {
      ensure(teamOf(unitEntry.owner)).units += 1;
    }
    return standings;
  }

  function resolveStalemate() {
    const standings = teamStandings();
    const ranked = Object.entries(standings).sort((a, b) => b[1].cities - a[1].cities || b[1].sites - a[1].sites || b[1].units - a[1].units);
    if (!ranked.length) {
      finish(false, `战局在第 ${game.turn} 回合陷入僵局，双方均无立足点。`);
      return;
    }
    const [leadTeam, lead] = ranked[0];
    const playerWin = !game.settings?.spectator && teamOf('player') === leadTeam;
    finish(playerWin, `战局在第 ${game.turn} 回合达到回合上限，判定 ${leadTeam} 组以 ${lead.cities} 城 / ${lead.sites} 据点领先胜出。`);
  }

  function landUnitCanReachForeignCity(unitEntry) {
    if (typeMeta(unitEntry.type).domain !== 'land') {
      return false;
    }
    const seen = new Set([cellKey(unitEntry.x, unitEntry.y)]);
    const queue = [{ x: unitEntry.x, y: unitEntry.y }];
    while (queue.length) {
      const current = queue.shift();
      const siteEntry = getSite(current.x, current.y);
      if (siteEntry?.kind === 'city' && !areAllies(siteEntry.owner, unitEntry.owner)) {
        return true;
      }
      for (const next of adjacent8(current.x, current.y)) {
        if (!isLandTile(next.x, next.y)) {
          continue;
        }
        const nextKey = cellKey(next.x, next.y);
        if (seen.has(nextKey)) {
          continue;
        }
        seen.add(nextKey);
        queue.push(next);
      }
    }
    return false;
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

  function checkEnd() {
    if (game.over || game.freeplay) {
      return;
    }
    if (game.settings?.spectator) {
      const activeTeams = new Set();
      for (const unitEntry of game.units) {
        activeTeams.add(teamOf(unitEntry.owner));
      }
      for (const siteEntry of game.sites) {
        if (siteEntry.owner !== 'neutral') {
          activeTeams.add(teamOf(siteEntry.owner));
        }
      }
      if (game.settings.mode === 'skirmish') {
        const combatTeams = new Set(game.units.map(unitEntry => teamOf(unitEntry.owner)));
        if (combatTeams.size === 1 && combatTeams.size > 0) {
          finish(true, `${[...combatTeams][0]} 组赢得了观战遭遇战。`);
        }
        return;
      }
      if (game.settings.mode === 'survival' && game.turn >= 12) {
        const ranked = [...activeTeams].sort((a, b) => game.sites.filter(siteEntry => siteEntry.kind === 'city' && teamOf(siteEntry.owner) === b).length - game.sites.filter(siteEntry => siteEntry.kind === 'city' && teamOf(siteEntry.owner) === a).length);
        if (ranked[0]) {
          finish(true, `${ranked[0]} 组在观战守城模式中存活到第12回合。`);
        }
        return;
      }
      const hostileTeams = new Set(game.sites.filter(siteEntry => (siteEntry.kind === 'city' || siteEntry.kind === 'shipyard' || siteEntry.kind === 'fortress') && siteEntry.owner !== 'neutral').map(siteEntry => teamOf(siteEntry.owner)));
      if (hostileTeams.size === 1) {
        const winnerTeam = [...hostileTeams][0];
        const enemyEngineers = game.units.some(unitEntry => (unitEntry.type === 'engineer' && teamOf(unitEntry.owner) !== winnerTeam) || unitEntry.cargo?.some(payload => payload.type === 'engineer' && teamOf(payload.owner) !== winnerTeam));
        if (!enemyEngineers) {
          finish(true, `${winnerTeam} 组完成了全部敌对城市与海上据点占领，并清除了敌方工程师。`);
          return;
        }
      }
      if (activeTeams.size === 1 && activeTeams.size > 0) {
        finish(true, `${[...activeTeams][0]} 组成为战场最后赢家。`);
      }
      return;
    }
    const playerTeam = teamOf('player');
    const activeTeams = new Set();
    for (const unitEntry of game.units) {
      activeTeams.add(teamOf(unitEntry.owner));
    }
    for (const siteEntry of game.sites) {
      if (siteEntry.owner !== 'neutral') {
        activeTeams.add(teamOf(siteEntry.owner));
      }
    }
    const playerAlive = [...activeTeams].includes(playerTeam);
    if (game.settings.mode === 'survival') {
      const alliedCity = game.sites.some(siteEntry => siteEntry.kind === 'city' && areAllies(siteEntry.owner, 'player'));
      if (!alliedCity && !game.units.some(unitEntry => areAllies(unitEntry.owner, 'player'))) {
        finish(false, '你的组已经失去全部立足点。');
        return;
      }
      if (game.turn >= 12 && alliedCity) {
        finish(true, '你成功守住了关键城市直到第12回合。');
      }
      return;
    }
    if (game.settings.mode === 'skirmish') {
      const combatTeams = new Set(game.units.map(unitEntry => teamOf(unitEntry.owner)));
      if (!combatTeams.has(playerTeam)) {
        finish(false, '你的组全部野战部队已被消灭。');
        return;
      }
      if (combatTeams.size === 1 && combatTeams.has(playerTeam)) {
        finish(true, '敌对组野战部队已全部被消灭。');
      }
      return;
    }
    const enemyControlledCities = game.sites.filter(siteEntry => siteEntry.kind === 'city' && siteEntry.owner !== 'neutral' && teamOf(siteEntry.owner) !== playerTeam);
    const enemyControlledSeaSites = game.sites.filter(siteEntry => (siteEntry.kind === 'shipyard' || siteEntry.kind === 'fortress') && siteEntry.owner !== 'neutral' && teamOf(siteEntry.owner) !== playerTeam);
    if (!enemyControlledCities.length && !enemyControlledSeaSites.length) {
      const enemyEngineers = game.units.some(unitEntry => (unitEntry.type === 'engineer' && teamOf(unitEntry.owner) !== playerTeam) || unitEntry.cargo?.some(payload => payload.type === 'engineer' && teamOf(payload.owner) !== playerTeam));
      if (!enemyEngineers) {
        finish(true, '你已占领全部敌对城市与海上据点，并清除了全部敌方工程师。');
        return;
      }
    }
    const hostileTeams = new Set(game.sites.filter(siteEntry => (siteEntry.kind === 'city' || siteEntry.kind === 'shipyard' || siteEntry.kind === 'fortress') && siteEntry.owner !== 'neutral').map(siteEntry => teamOf(siteEntry.owner)));
    if (hostileTeams.size === 1 && !hostileTeams.has(playerTeam)) {
      const winnerTeam = [...hostileTeams][0];
      const enemyEngineers = game.units.some(unitEntry => (unitEntry.type === 'engineer' && teamOf(unitEntry.owner) !== winnerTeam) || unitEntry.cargo?.some(payload => payload.type === 'engineer' && teamOf(payload.owner) !== winnerTeam));
      if (!enemyEngineers) {
        finish(false, '敌方已占领全部城市与海上据点，并清除了你方全部工程师。');
        return;
      }
    }
    if (!playerAlive) {
      finish(false, '你的组已经失去全部据点与部队。');
      return;
    }
    if (activeTeams.size === 1 && activeTeams.has(playerTeam)) {
      finish(true, '战场上只剩下你的组仍具战争能力。');
    }
  }

  function finish(win, text) {
    game.over = true;
    game.stats.endTime = Date.now();
    game.result = { win, text };
    recordStatSnapshot('finish');
    if (fastSim) {
      return;
    }
    $('modalTitle').textContent = win === null ? '对局结束' : win ? '胜利！' : '战败';
    $('modalText').textContent = text;
    $('statsPanel').classList.remove('hidden');
    renderStatsSummary(true);
    drawStatsChart();
    $('overlay').classList.remove('hidden');
    refresh();
  }

  // Manually end the match with nobody winning; still settles time and shows stats.
  function endGameNeutral() {
    if (!game || game.over) {
      return;
    }
    $('pauseModal')?.classList.add('hidden');
    finish(null, '本局已手动结束，以下为本局统计。');
  }

  function sideLabel() {
    if (game.settings?.spectator) {
      return `观战中 · ${ownerShort(game.side)}行动中 · ${teamOf(game.side)}组`;
    }
    return game.side === 'player' ? `你的回合 · ${teamOf('player')}组` : `${ownerShort(game.side)}行动中 · ${teamOf(game.side)}组`;
  }

  function buildableTypes(siteEntry) {
    const domain = siteMeta(siteEntry.kind).domain;
    if (!domain) {
      return [];
    }
    return Object.keys(TYPES).filter(type => typeMeta(type).domain === domain && typeMeta(type).level <= siteEntry.tier);
  }

  function siteUpgradeCost(siteEntry) {
    return siteMeta(siteEntry.kind).upgradeCosts[siteEntry.tier] || 0;
  }

  function buildBudgetLeft(owner) {
    return (game.settings?.buildCap ?? 100) - (game.buildsThisTurn?.[owner] || 0);
  }

  function recordBuild(owner, count) {
    game.buildsThisTurn = game.buildsThisTurn || {};
    game.buildsThisTurn[owner] = (game.buildsThisTurn[owner] || 0) + count;
  }

  function buildAtSite(owner, siteEntry, type, options = {}) {
    const cargoTypes = type === 'transport' ? normalizeCargoTypes(options.cargoTypes) : [];
    const totalCost = type === 'transport' ? transportCost(cargoTypes) : typeMeta(type).cost;
    const builtUnits = type === 'transport' ? 1 + cargoTypes.length : 1;
    if (!siteEntry || siteEntry.owner !== owner || !buildableTypes(siteEntry).includes(type) || getUnit(siteEntry.x, siteEntry.y) || game.goldByOwner[owner] < totalCost) {
      return false;
    }
    if (atUnitCap(owner, typeMeta(type).domain) || buildBudgetLeft(owner) < builtUnits) {
      return false;
    }
    recordBuild(owner, builtUnits);
    game.goldByOwner[owner] -= totalCost;
    if (type === 'transport') {
      game.units.push(createLoadedTransport(owner, siteEntry.x, siteEntry.y, cargoTypes));
      log(`${ownerName(owner)}在${siteEntry.name}下水了运兵船，预载 ${describeCargo(cargoTypes)}。`, 'system');
      incrementStat('produced', owner, 1 + cargoTypes.length);
    } else {
      game.units.push(unit(type, owner, siteEntry.x, siteEntry.y));
      log(`${ownerName(owner)}在${siteEntry.name}部署了${typeMeta(type).name}。`, 'system');
      incrementStat('produced', owner, 1);
    }
    recordStatSnapshot('build');
    return true;
  }

  function upgradeSite(owner, siteEntry) {
    const cost = siteUpgradeCost(siteEntry);
    if (!siteEntry || siteEntry.owner !== owner || siteEntry.tier >= siteMeta(siteEntry.kind).maxTier || game.goldByOwner[owner] < cost) {
      return false;
    }
    game.goldByOwner[owner] -= cost;
    siteEntry.tier += 1;
    siteEntry.income += siteEntry.kind === 'city' ? 3 : 2;
    log(`${siteEntry.name}升级为${tierName(siteEntry.tier)}${siteMeta(siteEntry.kind).name}。`, 'system');
    return true;
  }

  function fullHealSite(owner, siteEntry) {
    const occupant = getUnit(siteEntry.x, siteEntry.y);
    const cost = siteEntry.kind === 'city' || siteEntry.kind === 'camp' ? 5 : siteEntry.kind === 'shipyard' ? 6 : 7;
    if (!siteEntry || siteEntry.owner !== owner || !occupant || occupant.owner !== owner || game.goldByOwner[owner] < cost) {
      return false;
    }
    game.goldByOwner[owner] -= cost;
    occupant.hp = occupant.maxHp;
    log(`${siteEntry.name}花费${cost}金币完成驻军修整。`, 'gold');
    return true;
  }

  function aiRepair(owner) {
    for (const siteEntry of game.sites.filter(entry => entry.owner === owner)) {
      const occupant = getUnit(siteEntry.x, siteEntry.y);
      if (!occupant || occupant.owner !== owner || occupant.hp >= occupant.maxHp) {
        continue;
      }
      const cost = siteEntry.kind === 'city' || siteEntry.kind === 'camp' ? 5 : siteEntry.kind === 'shipyard' ? 6 : 7;
      if (occupant.hp <= occupant.maxHp * 0.45 && game.goldByOwner[owner] >= cost) {
        game.goldByOwner[owner] -= cost;
        occupant.hp = occupant.maxHp;
        log(`${ownerName(owner)}在${siteEntry.name}完成驻军修整。`, 'system');
      }
    }
  }

  function consumeAction(unitEntry) {
    unitEntry.move = 0;
    unitEntry.acted = true;
    unitEntry.hasAttacked = true;
  }

  function engineerBuildCells(unitEntry) {
    return adjacent8(unitEntry.x, unitEntry.y).filter(cell => isWaterTile(cell.x, cell.y) && !getUnit(cell.x, cell.y));
  }

  function canBuildCamp(unitEntry) {
    return !!unitEntry && unitEntry.type === 'engineer' && unitEntry.owner === game.side && !unitEntry.acted && isLandTile(unitEntry.x, unitEntry.y) && !getSite(unitEntry.x, unitEntry.y) && game.goldByOwner[unitEntry.owner] >= CAMP_COST && campCount(unitEntry.owner) < MAX_CAMPS_PER_SIDE;
  }

  function canEngineerLaunch(unitEntry, type, cell, cargoTypes = []) {
    const totalCost = type === 'transport' ? transportCost(cargoTypes) : typeMeta(type).cost;
    return !!unitEntry && unitEntry.type === 'engineer' && unitEntry.owner === game.side && !unitEntry.acted && !!cell && diagonalDist(unitEntry, cell) === 1 && isWaterTile(cell.x, cell.y) && !getUnit(cell.x, cell.y) && game.goldByOwner[unitEntry.owner] >= totalCost;
  }

  function buildCamp(unitEntry) {
    if (!canBuildCamp(unitEntry) || campCount(unitEntry.owner) >= MAX_CAMPS_PER_SIDE) {
      return false;
    }
    game.goldByOwner[unitEntry.owner] -= CAMP_COST;
    game.sites.push(createCamp(unitEntry.owner, unitEntry.x, unitEntry.y));
    consumeAction(unitEntry);
    clearPendingOrder();
    incrementStat('captures', unitEntry.owner, 1);
    incrementStrat(unitEntry.owner, 'campsBuilt');
    recordStatSnapshot('camp');
    log(`${ownerName(unitEntry.owner)}的工程师建立了临时营地，可维持 ${CAMP_DURATION} 回合。`, 'system');
    return true;
  }

  function engineerLaunch(unitEntry, type, cell, cargoTypes = []) {
    const totalCost = type === 'transport' ? transportCost(cargoTypes) : typeMeta(type).cost;
    const builtUnits = type === 'transport' ? 1 + cargoTypes.length : 1;
    if (!canEngineerLaunch(unitEntry, type, cell, cargoTypes)) {
      return false;
    }
    if (atUnitCap(unitEntry.owner, typeMeta(type).domain) || buildBudgetLeft(unitEntry.owner) < builtUnits) {
      return false;
    }
    recordBuild(unitEntry.owner, builtUnits);
    game.goldByOwner[unitEntry.owner] -= totalCost;
    game.units.push(type === 'transport' ? createLoadedTransport(unitEntry.owner, cell.x, cell.y, cargoTypes) : unit(type, unitEntry.owner, cell.x, cell.y));
    consumeAction(unitEntry);
    clearPendingOrder();
    incrementStat('produced', unitEntry.owner, type === 'transport' ? 1 + cargoTypes.length : 1);
    if (type === 'transport') {
      incrementStrat(unitEntry.owner, 'transportLaunches');
    }
    recordStatSnapshot('engineer-build');
    log(`${ownerName(unitEntry.owner)}的工程师在海边建造了${type === 'transport' ? `运兵船（${describeCargo(cargoTypes)}）` : typeMeta(type).name}。`, 'system');
    return true;
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

  function collectLandCells() {
    const cells = [];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (game.terrain[y][x] !== 'water' && game.terrain[y][x] !== 'mountain') {
          cells.push({ x, y });
        }
      }
    }
    return cells;
  }

  function pickSpacedCells(pool, count, minGap) {
    const picks = [];
    for (const cell of shuffle(pool)) {
      if (picks.length >= count) {
        break;
      }
      if (picks.every(other => dist(cell, other) >= minGap)) {
        picks.push(cell);
      }
    }
    return picks;
  }

  // Even (blue-noise) placement: repeatedly take the cell farthest from all already-chosen cells.
  function farthestPointSample(pool, count, usedKeys) {
    if (count <= 0 || !pool.length) {
      return [];
    }
    const avail = usedKeys ? pool.filter(cell => !usedKeys.has(cellKey(cell.x, cell.y))) : pool.slice();
    if (!avail.length) {
      return [];
    }
    const minD = new Array(avail.length).fill(Infinity);
    const picks = [];
    let idx = Math.floor(Math.random() * avail.length);
    for (let k = 0; k < count && k < avail.length; k++) {
      const chosen = avail[idx];
      picks.push(chosen);
      let farIdx = -1;
      let farDist = -1;
      for (let i = 0; i < avail.length; i++) {
        const d = dist(avail[i], chosen);
        if (d < minD[i]) {
          minD[i] = d;
        }
        if (minD[i] > farDist) {
          farDist = minD[i];
          farIdx = i;
        }
      }
      idx = farIdx;
    }
    return picks;
  }

  // Distribute sites by the 城池分布 slider: 0 = perfectly even, 100 = most points clustered around random centers.
  function distributeCells(pool, count, spread) {
    if (!pool.length || count <= 0) {
      return [];
    }
    count = Math.min(count, pool.length);
    const clusterFactor = clamp((spread ?? 50) / 100, 0, 1);
    const clusterShare = clusterFactor * (0.5 + Math.random() * 0.4);
    const clusterCount = Math.min(count, Math.round(clusterShare * count));
    const uniformCount = count - clusterCount;
    const used = new Set();
    const picks = [];
    for (const cell of farthestPointSample(pool, uniformCount, used)) {
      picks.push(cell);
      used.add(cellKey(cell.x, cell.y));
    }
    if (clusterCount > 0) {
      const centerN = clamp(1 + Math.floor(Math.random() * 4), 1, Math.max(1, Math.ceil(clusterCount / 2)));
      const centers = Array.from({ length: centerN }, () => pool[Math.floor(Math.random() * pool.length)]);
      for (let i = 0; i < clusterCount; i++) {
        const center = centers[i % centers.length];
        let best = null;
        let bestD = Infinity;
        const tries = Math.min(pool.length, 200);
        for (let t = 0; t < tries; t++) {
          const cell = pool[Math.floor(Math.random() * pool.length)];
          if (used.has(cellKey(cell.x, cell.y))) {
            continue;
          }
          const d = dist(cell, center) + Math.random() * 3;
          if (d < bestD) {
            bestD = d;
            best = cell;
          }
        }
        if (best) {
          picks.push(best);
          used.add(cellKey(best.x, best.y));
        }
      }
    }
    return picks;
  }

  function makeCities(aiCount, sizeKey, spread) {
    const cells = collectLandCells();
    const owners = ['player', ...Array.from({ length: aiCount }, (_, index) => `ai${index}`)];
    // Spread owner homes across the whole map (scaled to area & player count) so factions don't cluster in one corner.
    let ownerGap = clamp(Math.round(Math.sqrt(2 * W * H / owners.length) * 0.72), 4, Math.floor((W + H) / 2));
    let ownerCells = pickSpacedCells(cells, owners.length, ownerGap);
    while (ownerCells.length < owners.length && ownerGap > 3) {
      ownerGap = Math.max(3, Math.floor(ownerGap * 0.75));
      ownerCells = pickSpacedCells(cells, owners.length, ownerGap);
    }
    if (ownerCells.length < owners.length) {
      const chosen = new Set(ownerCells.map(cell => cellKey(cell.x, cell.y)));
      for (const cell of shuffle(cells)) {
        if (ownerCells.length >= owners.length) {
          break;
        }
        const key = cellKey(cell.x, cell.y);
        if (!chosen.has(key)) {
          chosen.add(key);
          ownerCells.push(cell);
        }
      }
    }
    // Neutral cities fill out the rest; total scales with map size and the site-density setting.
    const density = game.settings?.siteDensity ?? 1;
    const baseTotal = Math.max(6, aiCount + 4) + ({ small: 1, medium: 4, large: 8, huge: 12, giant: 18, colossal: 26 }[sizeKey] || 0);
    const neutralCount = Math.min(cells.length - owners.length, Math.max(0, Math.round((baseTotal - owners.length) * density)));
    const usedKeys = new Set(ownerCells.map(cell => cellKey(cell.x, cell.y)));
    const neutralPool = cells.filter(cell => !usedKeys.has(cellKey(cell.x, cell.y)));
    const neutralCells = distributeCells(neutralPool, neutralCount, spread);
    const entries = [
      ...ownerCells.map((cell, index) => ({ cell, owner: owners[index] })),
      ...neutralCells.map(cell => ({ cell, owner: 'neutral' }))
    ];
    return entries.map((entry, index) => {
      const tier = Math.random() < 0.62 ? 1 : Math.random() < 0.84 ? 2 : 3;
      return site('city', entry.owner, entry.cell.x, entry.cell.y, CITY_NAMES[index % CITY_NAMES.length], tier, CITY_INCOME_BY_TIER[tier]);
    });
  }

  function makeSpecialSites() {
    const used = new Set(game.sites.map(entry => cellKey(entry.x, entry.y)));
    const land = collectLandCells().filter(cell => !used.has(cellKey(cell.x, cell.y)));
    const density = game.settings?.siteDensity ?? 1;
    const spread = game.settings?.spread ?? 50;
    const oilKinds = ['oilSmall', 'oilMedium', 'oilLarge'];
    const oilCount = clamp(Math.round(land.length / 120 * density), 2, 10);
    const oilCells = distributeCells(land, oilCount, spread);
    const specials = [];
    oilCells.forEach((cell, index) => {
      const kind = oilKinds[index % oilKinds.length];
      used.add(cellKey(cell.x, cell.y));
      specials.push(site(kind, 'neutral', cell.x, cell.y, OIL_NAMES[index % OIL_NAMES.length], 1, siteMeta(kind).income));
    });

    const barracksPool = land.filter(cell => !used.has(cellKey(cell.x, cell.y)));
    const barracksCount = clamp(Math.round(land.length / 150 * density), 2, 8);
    distributeCells(barracksPool, barracksCount, spread).forEach((cell, index) => {
      const kind = index % 2 === 0 ? 'barracksLarge' : 'barracksSmall';
      used.add(cellKey(cell.x, cell.y));
      specials.push(site(kind, 'neutral', cell.x, cell.y, BARRACK_NAMES[index % BARRACK_NAMES.length], 1, 0));
    });
    return specials;
  }

  function nearestCoastalWater(homes, used) {
    const candidates = [];
    for (const home of homes) {
      for (let y = Math.max(0, home.y - 8); y <= Math.min(H - 1, home.y + 8); y++) {
        for (let x = Math.max(0, home.x - 8); x <= Math.min(W - 1, home.x + 8); x++) {
          if (!used.has(cellKey(x, y)) && isCoastalWater(x, y)) {
            candidates.push({ x, y, score: dist(home, { x, y }) });
          }
        }
      }
    }
    candidates.sort((a, b) => a.score - b.score);
    return candidates[0] || null;
  }

  function makeNavalSites() {
    const used = new Set(game.sites.map(entry => cellKey(entry.x, entry.y)));
    const sites = [];
    for (const owner of ownerOrder()) {
      const homes = game.sites.filter(entry => entry.owner === owner && entry.kind === 'city');
      const cell = nearestCoastalWater(homes, used);
      if (!cell) {
        continue;
      }
      used.add(cellKey(cell.x, cell.y));
      sites.push(site('shipyard', owner, cell.x, cell.y, PORT_NAMES[sites.length % PORT_NAMES.length], Math.random() < 0.25 ? 2 : 1, 8 + rnd(3)));
    }
    const coastal = [];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (!used.has(cellKey(x, y)) && isCoastalWater(x, y)) {
          coastal.push({ x, y });
        }
      }
    }
    const spread = game.settings?.spread ?? 50;
    const density = game.settings?.siteDensity ?? 1;
    for (const cell of distributeCells(coastal, clamp(Math.round(coastal.length / 60 * density), 1, 8), spread)) {
      used.add(cellKey(cell.x, cell.y));
      sites.push(site('shipyard', 'neutral', cell.x, cell.y, PORT_NAMES[sites.length % PORT_NAMES.length], 1, 7 + rnd(3)));
    }
    const deep = [];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (!used.has(cellKey(x, y)) && isDeepWater(x, y)) {
          deep.push({ x, y });
        }
      }
    }
    for (const cell of distributeCells(deep, clamp(Math.round(deep.length / 90 * density), 0, 6), spread)) {
      sites.push(site('fortress', 'neutral', cell.x, cell.y, FORT_NAMES[sites.length % FORT_NAMES.length], 1, 5 + rnd(2)));
    }
    return sites;
  }

  function spawnLand(owner, homes, count, used, deploy) {
    const bag = ['militia', 'scout', 'spearman', 'swordsman', 'archer', 'crossbow', 'cavalry', 'guard'];
    const centerX = homes.reduce((sum, entry) => sum + entry.x, 0) / homes.length;
    const centerY = homes.reduce((sum, entry) => sum + entry.y, 0) / homes.length;
    const radius = deploy === 'tight' ? 3 : deploy === 'loose' ? 6 : deploy === 'veryLoose' ? 10 : Math.max(W, H);
    for (let i = 0; i < count; i++) {
      const cells = [];
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          if (isLandTile(x, y) && !used.has(cellKey(x, y)) && Math.hypot(x - centerX, y - centerY) <= radius) {
            cells.push({ x, y });
          }
        }
      }
      if (!cells.length) {
        continue;
      }
      cells.sort((a, b) => Math.hypot(a.x - centerX, a.y - centerY) - Math.hypot(b.x - centerX, b.y - centerY));
      const pick = deploy === 'random' ? cells[rnd(cells.length)] : cells[rnd(Math.max(1, Math.min(cells.length, Math.ceil(cells.length * 0.5))))];
      used.add(cellKey(pick.x, pick.y));
      game.units.push(unit(bag[rnd(bag.length)], owner, pick.x, pick.y));
    }
  }

  function spawnSea(owner, count) {
    const ports = game.sites.filter(entry => entry.owner === owner && entry.kind === 'shipyard');
    let spawned = 0;
    for (const port of ports) {
      if (spawned >= count || getUnit(port.x, port.y)) {
        continue;
      }
      game.units.push(unit(spawned === 0 ? 'warship' : 'transport', owner, port.x, port.y));
      spawned += 1;
    }
    return spawned;
  }

  function bestSupport(owner, unitEntry) {
    const supports = supportSites(unitEntry);
    supports.sort((a, b) => dist(a, unitEntry) - dist(b, unitEntry));
    return supports[0] || null;
  }

  function futureReach(unitEntry, lookahead) {
    return typeMeta(unitEntry.type).range + unitEntry.move + Math.max(0, lookahead - 1) * Math.max(1, Math.floor(unitEntry.maxMove * 0.85));
  }

  function isBridgeheadSite(siteEntry) {
    if (!siteEntry) {
      return false;
    }
    const passableNeighbors = adjacent4(siteEntry.x, siteEntry.y).filter(cell => {
      if (game.terrain[siteEntry.y][siteEntry.x] === 'water') {
        return isWaterTile(cell.x, cell.y);
      }
      return isLandTile(cell.x, cell.y);
    });
    return passableNeighbors.length <= 2;
  }

  function frontlineCount(owner, target, radius = 3) {
    if (!target) {
      return 0;
    }
    return game.units.filter(unitEntry => unitEntry.owner === owner && dist(unitEntry, target) <= radius).length;
  }

  function logAiDecision(owner, text) {
    log(`${ownerName(owner)}部署：${text}`, 'system');
  }

  function bestRetreatCell(owner, unitEntry, blockedSite) {
    const supports = supportSites(unitEntry);
    const home = supports.sort((a, b) => dist(a, unitEntry) - dist(b, unitEntry))[0] || null;
    const cells = [...reachable(unitEntry).keys()].map(key => {
      const [x, y] = key.split(',').map(Number);
      return { x, y };
    });
    if (!cells.length) {
      return null;
    }
    cells.push({ x: unitEntry.x, y: unitEntry.y });
    let best = null;
    let bestScore = -Infinity;
    for (const cell of cells) {
      const threat = enemyThreat(owner, cell.x, cell.y);
      const support = friendSupport(owner, cell.x, cell.y);
      const forest = game.terrain[cell.y][cell.x] === 'forest' ? 8 : 0;
      const pullback = blockedSite ? dist(cell, blockedSite) * 1.6 : 0;
      const homeBias = home ? Math.max(0, 8 - dist(cell, home)) : 0;
      const score = support + forest + pullback + homeBias - threat * 1.2;
      if (score > bestScore) {
        bestScore = score;
        best = cell;
      }
    }
    return best;
  }

  function projectedPressure(owner, target, lookahead, excludeId = null) {
    let total = 0;
    for (const ally of game.units.filter(unitEntry => unitEntry.owner === owner)) {
      if (ally.id === excludeId) {
        continue;
      }
      const reach = futureReach(ally, lookahead);
      const distance = dist(ally, target);
      if (distance > reach + 2) {
        continue;
      }
      total += Math.max(0, (typeMeta(ally.type).atk + typeMeta(ally.type).level * 2 - Math.max(0, distance - reach) * 2) * (ally.hp / ally.maxHp));
    }
    return total;
  }

  function siteProjectionValue(owner, siteEntry, lookahead) {
    const relevantUnits = game.units.filter(unitEntry => unitEntry.owner === owner && (siteEntry.kind === 'city' ? typeMeta(unitEntry.type).domain === 'land' : true));
    const nearest = relevantUnits.length ? Math.min(...relevantUnits.map(unitEntry => dist(unitEntry, siteEntry))) : Math.max(W, H);
    return strategicSiteValue(siteEntry, owner) + Math.max(0, lookahead * 8 - nearest);
  }

  function buildStrategicIntent(owner, profile) {
    const diffCfg = DIFF[profile.diff];
    const memory = frontMemory(owner);
    const enemies = game.units.filter(unitEntry => areEnemies(unitEntry.owner, owner));
    const focusTarget = enemies
      .map(unitEntry => {
        const pressure = projectedPressure(owner, unitEntry, diffCfg.lookahead);
        return {
          unitEntry,
          score: targetValue(unitEntry) + pressure * 1.5 + (pressure >= unitEntry.hp ? 16 : 0) + (unitEntry.type === 'transport' ? 8 : 0)
        };
      })
      .sort((a, b) => b.score - a.score)[0]?.unitEntry || null;
    const assaultRanked = game.sites
      .filter(siteEntry => strategicSiteValue(siteEntry, owner) > 0)
      .sort((a, b) => siteProjectionValue(owner, b, diffCfg.lookahead) - siteProjectionValue(owner, a, diffCfg.lookahead));
    const notCooled = siteEntry => !(memory[`site:${cellKey(siteEntry.x, siteEntry.y)}`]?.cooldown > 0);
    // Skip fronts that have proven blocked (front-memory cooldown) so the army commits to an open approach.
    const assaultSite = assaultRanked.find(notCooled) || assaultRanked[0] || null;
    const expansionRanked = game.sites
      .filter(siteEntry => cityEconomyValue(siteEntry, owner) > 0)
      .sort((a, b) => cityEconomyValue(b, owner) - cityEconomyValue(a, owner));
    const expansionSite = expansionRanked.find(notCooled) || expansionRanked[0] || assaultSite;
    const alternateSites = game.sites
      .filter(siteEntry => strategicSiteValue(siteEntry, owner) > 0)
      .sort((a, b) => siteProjectionValue(owner, b, diffCfg.lookahead) - siteProjectionValue(owner, a, diffCfg.lookahead))
      .slice(0, 4);
    const navalSite = game.sites
      .filter(siteEntry => siteEntry.kind !== 'city' && strategicSiteValue(siteEntry, owner) > 0)
      .sort((a, b) => siteProjectionValue(owner, b, diffCfg.lookahead) - siteProjectionValue(owner, a, diffCfg.lookahead))[0] || assaultSite;
    const cooledTargets = alternateSites.filter(siteEntry => memory[`site:${cellKey(siteEntry.x, siteEntry.y)}`]?.cooldown > 0).map(siteEntry => siteEntry.name);
    return { focusTarget, assaultSite, expansionSite, navalSite, alternateSites, cooledTargets };
  }

  function summarizeIntent(intent) {
    const assault = intent.assaultSite ? intent.assaultSite.name : '无';
    const expansion = intent.expansionSite ? intent.expansionSite.name : '无';
    const focus = intent.focusTarget ? typeMeta(intent.focusTarget.type).name : '无';
    return `主攻 ${assault}；扩张 ${expansion}；重点目标 ${focus}`;
  }

  function unitPriority(unitEntry, intent) {
    let priority = typeMeta(unitEntry.type).level * 5 + (unitEntry.hp / unitEntry.maxHp) * 4;
    if (intent.focusTarget) {
      priority += Math.max(0, 12 - dist(unitEntry, intent.focusTarget));
    }
    if (intent.assaultSite) {
      priority += Math.max(0, 8 - dist(unitEntry, intent.assaultSite));
    }
    if (intent.expansionSite) {
      priority += Math.max(0, 6 - dist(unitEntry, intent.expansionSite));
    }
    if (unitEntry.type === 'transport' && intent.assaultSite?.kind === 'city') {
      priority += 6;
    }
    if (intent.assaultSite && isBridgeheadSite(intent.assaultSite) && dist(unitEntry, intent.assaultSite) <= 3) {
      priority += 2;
    }
    return priority;
  }

  function bestObjective(owner, unitEntry, intent = null) {
    const defaultAgg = AGG[game.aiProfiles?.[owner]?.agg || 'balanced'] || AGG.balanced;
    const state = unitEntry.aiState || { stalledTurns: 0, rerouteTurns: 0, failedObjectiveKey: null };
    const memory = frontMemory(owner);
    const isSea = typeMeta(unitEntry.type).domain === 'sea';
    const pool = isSea
      ? [intent?.navalSite, intent?.assaultSite, intent?.expansionSite, ...(intent?.alternateSites || [])]
      : [intent?.expansionSite, intent?.assaultSite, ...(intent?.alternateSites || [])];
    const seen = new Set();
    const candidates = [];
    const consider = siteEntry => {
      if (!siteEntry) {
        return;
      }
      const key = cellKey(siteEntry.x, siteEntry.y);
      if (seen.has(key)) {
        return;
      }
      if (strategicSiteValue(siteEntry, owner, unitEntry) <= 0) {
        return;
      }
      if (state.rerouteTurns > 0 && state.failedObjectiveKey === `site:${key}`) {
        return;
      }
      if (memory[`site:${key}`]?.cooldown > 0) {
        return;
      }
      seen.add(key);
      candidates.push(siteEntry);
    };
    pool.forEach(consider);
    if (candidates.length < 2) {
      game.sites.forEach(consider);
    }
    if (!candidates.length) {
      return unitEntry.hp <= unitEntry.maxHp * defaultAgg.retreatHp ? bestSupport(owner, unitEntry) : null;
    }
    let best = null;
    let bestScore = -Infinity;
    for (const siteEntry of candidates) {
      const value = strategicSiteValue(siteEntry, owner, unitEntry) + cityEconomyValue(siteEntry, owner);
      const distance = dist(unitEntry, siteEntry);
      const crowd = game.units.filter(entry => entry.owner === owner && entry.id !== unitEntry.id && dist(entry, siteEntry) <= 3).length;
      const score = value / (1 + distance) - crowd * 1.1;
      if (score > bestScore) {
        bestScore = score;
        best = siteEntry;
      }
    }
    if (best && unitEntry.hp <= unitEntry.maxHp * defaultAgg.retreatHp && dist(unitEntry, best) > 2) {
      return bestSupport(owner, unitEntry);
    }
    return best;
  }

  function enemyThreat(owner, x, y) {
    let score = 0;
    for (const enemy of game.units.filter(entry => areEnemies(entry.owner, owner))) {
      const reach = enemy.move + typeMeta(enemy.type).range;
      const d = dist(enemy, { x, y });
      if (d <= reach + 1) {
        score += typeMeta(enemy.type).atk * (enemy.hp / enemy.maxHp) * (d <= typeMeta(enemy.type).range ? 1.2 : 0.55);
      }
    }
    const siteEntry = getSite(x, y);
    if (siteEntry && areAllies(siteEntry.owner, owner)) {
      score *= 0.82;
    }
    return score;
  }

  function friendSupport(owner, x, y) {
    return game.units.filter(entry => areAllies(entry.owner, owner) && dist(entry, { x, y }) <= 3).length * 1.4;
  }

  function allyCongestion(owner, cell, excludeId = null) {
    let total = 0;
    for (const ally of game.units) {
      if (ally.owner !== owner || ally.id === excludeId) {
        continue;
      }
      if (diagonalDist(ally, cell) <= 1) {
        total += diagonalDist(ally, cell) === 0 ? 1.6 : 0.65;
      }
    }
    return total;
  }

  function cityEconomyValue(siteEntry, owner) {
    if (areAllies(siteEntry.owner, owner)) {
      return 0;
    }
    const earlyTurnBonus = Math.max(0, 10 - game.turn) * 1.8;
    const neutralBonus = siteEntry.owner === 'neutral' ? 12 : 8;
    if (siteEntry.kind === 'city') {
      return 18 + siteEntry.income * 2.2 + siteEntry.tier * 4 + earlyTurnBonus + neutralBonus;
    }
    if (siteEntry.kind.startsWith('oil')) {
      return 24 + siteEntry.income * 2.8 + earlyTurnBonus * 0.8 + neutralBonus;
    }
    if (siteEntry.kind === 'shipyard') {
      return 16 + siteEntry.income * 1.8 + earlyTurnBonus * 0.5 + neutralBonus * 0.7;
    }
    return 0;
  }

  function computeUnitState(unitEntry) {
    const previous = unitEntry.aiState || { stalledTurns: 0, rerouteTurns: 0, failedObjectiveKey: null };
    return {
      ...previous,
      lastPosition: previous.lastPosition || { x: unitEntry.x, y: unitEntry.y }
    };
  }

  function strategicPassable(unitEntry, x, y) {
    if (!inBounds(x, y)) {
      return false;
    }
    const domain = typeMeta(unitEntry.type).domain;
    if (domain === 'sea') {
      return game.terrain[y][x] === 'water';
    }
    return game.terrain[y][x] !== 'water' && game.terrain[y][x] !== 'mountain';
  }

  function buildDistanceField(unitEntry, target) {
    if (!target) {
      return null;
    }
    if (!strategicPassable(unitEntry, target.x, target.y)) {
      return null;
    }
    // Field depends only on terrain (fixed per game) + domain, so cache per game.
    const domain = typeMeta(unitEntry.type).domain;
    const cacheKey = `${domain}:${target.x},${target.y}`;
    const useCache = typeof globalThis === 'undefined' || !globalThis.__NO_DIST_CACHE;
    const cached = useCache ? distFieldCache.get(cacheKey) : undefined;
    if (cached) {
      return cached;
    }
    const distances = new Map([[cellKey(target.x, target.y), 0]]);
    const queue = [{ x: target.x, y: target.y, cost: 0 }];
    let head = 0;
    while (head < queue.length) {
      const current = queue[head++];
      const nextCost = current.cost + 1;
      for (const next of adjacent8(current.x, current.y)) {
        if (!strategicPassable(unitEntry, next.x, next.y)) {
          continue;
        }
        const key = cellKey(next.x, next.y);
        if (!distances.has(key)) {
          distances.set(key, nextCost);
          queue.push({ x: next.x, y: next.y, cost: nextCost });
        }
      }
    }
    if (useCache) {
      distFieldCache.set(cacheKey, distances);
    }
    return distances;
  }

  function finalizeUnitState(unitEntry, state, objectiveKey, movedThisTurn) {
    const stalledTurns = movedThisTurn ? 0 : state.stalledTurns + 1;
    const rerouteTurns = movedThisTurn ? Math.max(0, state.rerouteTurns - 1) : stalledTurns >= 2 ? 2 : Math.max(0, state.rerouteTurns - 1);
    rememberFrontOutcome(unitEntry.owner, objectiveKey, movedThisTurn);
    if (!movedThisTurn && stalledTurns >= 2 && objectiveKey.startsWith('site:')) {
      const siteId = objectiveKey.slice(5);
      incrementStrat(unitEntry.owner, 'stalls');
      logAiDecision(unitEntry.owner, `前线在 ${siteId} 方向受阻，准备改道或暂避。`);
    }
    unitEntry.aiState = {
      lastPosition: { x: unitEntry.x, y: unitEntry.y },
      stalledTurns,
      rerouteTurns,
      failedObjectiveKey: stalledTurns >= 2 ? objectiveKey : state.failedObjectiveKey
    };
  }

  function targetValue(unitEntry) {
    return typeMeta(unitEntry.type).level * 8 + unitEntry.hp * 0.4 + (unitEntry.type === 'engineer' ? 14 : 0);
  }

  function nearbyEnemies(cell, owner, radius = 1) {
    return game.units.filter(unitEntry => areEnemies(unitEntry.owner, owner) && dist(unitEntry, cell) <= radius).length;
  }

  function unitRoleCellBonus(owner, unitEntry, cell, intent) {
    const type = unitEntry.type;
    const siteEntry = getSite(cell.x, cell.y);
    const coastal = adjacent8(cell.x, cell.y).some(next => isWaterTile(next.x, next.y));
    let score = 0;
    if (type === 'scout') {
      score += cityEconomyValue(siteEntry || { kind: 'none', owner }, owner) * 0.35;
      score += coastal ? 1 : 0;
    }
    if (type === 'spearman') {
      score += intent?.focusTarget?.type === 'cavalry' ? 6 : 0;
      score += intent?.assaultSite && isBridgeheadSite(intent.assaultSite) && dist(cell, intent.assaultSite) <= 1 ? 5 : 0;
    }
    if (type === 'archer' || type === 'crossbow') {
      score += game.terrain[cell.y][cell.x] === 'forest' ? 6 : 0;
      score -= nearbyEnemies(cell, owner, 1) * 8;
      score += friendSupport(owner, cell.x, cell.y) * 0.3;
    }
    if (type === 'cavalry') {
      score += intent?.focusTarget ? Math.max(0, 5 - diagonalDist(cell, intent.focusTarget)) * 1.2 : 0;
      score -= game.terrain[cell.y][cell.x] === 'forest' ? 3 : 0;
    }
    if (type === 'guard') {
      score += siteEntry && areAllies(siteEntry.owner, owner) && (siteEntry.kind === 'city' || siteEntry.kind.startsWith('barracks')) ? 8 : 0;
    }
    if (type === 'warship') {
      score += siteEntry?.kind === 'shipyard' && !areAllies(siteEntry.owner, owner) ? 10 : 0;
      const escort = game.units.find(entry => entry.owner === owner && entry.type === 'transport' && entry.cargo?.length && dist(entry, cell) <= 3);
      if (escort) {
        score += 4;
        if (diagonalDist(cell, escort) === 1) {
          score -= 3;
        }
      }
      score += nearbyEnemies(cell, owner, 2) * 1.2;
    }
    if (type === 'transport') {
      score -= nearbyEnemies(cell, owner, 2) * 4;
      score += coastal ? 2 : 0;
    }
    if (type === 'engineer') {
      score += coastal ? 5 : 0;
      score -= nearbyEnemies(cell, owner, 1) * 6;
    }
    return score;
  }

  function unitRoleTargetBonus(unitEntry, enemy, intent) {
    let score = 0;
    if (unitEntry.type === 'spearman' && enemy.type === 'cavalry') {
      score += 10;
    }
    if ((unitEntry.type === 'archer' || unitEntry.type === 'crossbow') && enemy.type === 'engineer') {
      score += 8;
    }
    if (unitEntry.type === 'cavalry' && enemy.hp <= enemy.maxHp * 0.5) {
      score += 8;
    }
    if (unitEntry.type === 'warship' && typeMeta(enemy.type).domain === 'sea') {
      score += 7;
    }
    if (unitEntry.type === 'warship') {
      const guardingTransport = game.units.some(entry => entry.owner === unitEntry.owner && entry.type === 'transport' && entry.cargo?.length && dist(entry, enemy) <= 3);
      if (guardingTransport) {
        score += 9;
      }
    }
    if (unitEntry.type === 'guard' && intent?.assaultSite && dist(enemy, intent.assaultSite) <= 2) {
      score += 4;
    }
    return score;
  }

  function chooseAction(owner, unitEntry, profile, intent = null) {
    const diffCfg = DIFF[profile.diff];
    const aggCfg = AGG[profile.agg];
    const state = unitEntry.aiState || { stalledTurns: 0, rerouteTurns: 0 };
    const cells = [...reachable(unitEntry).entries()].map(([key, cost]) => {
      const [x, y] = key.split(',').map(Number);
      return { x, y, cost };
    });
    cells.push({ x: unitEntry.x, y: unitEntry.y, cost: 0 });
    const objective = bestObjective(owner, unitEntry, intent);
    const distanceField = buildDistanceField(unitEntry, objective);
    const enemies = game.units.filter(entry => areEnemies(entry.owner, owner));
    const assaultSaturated = intent?.assaultSite && isBridgeheadSite(intent.assaultSite) ? frontlineCount(owner, intent.assaultSite, 2) >= 5 : false;
    const assaultMag = assaultSaturated ? 0.4 : 1;
    const expansionMag = assaultSaturated ? 1.5 : 1;
    let best = { score: -Infinity, move: null, target: null };
    for (const cell of cells) {
      const currentPath = objective && distanceField ? distanceField.get(cellKey(unitEntry.x, unitEntry.y)) ?? dist(unitEntry, objective) : 0;
      const nextPath = objective && distanceField ? distanceField.get(cellKey(cell.x, cell.y)) ?? dist(cell, objective) : 0;
      const moveScore = objective ? (currentPath - nextPath) * 2.9 * diffCfg.lookahead * aggCfg.push : 0;
      const supportScore = friendSupport(owner, cell.x, cell.y);
      const riskPenalty = enemyThreat(owner, cell.x, cell.y) * diffCfg.risk * aggCfg.preserve * 0.9;
      const congestionPenalty = allyCongestion(owner, cell, unitEntry.id) * (1.8 + state.stalledTurns * 0.7);
      const siteEntry = getSite(cell.x, cell.y);
      const captureScore = siteEntry ? strategicSiteValue(siteEntry, owner, unitEntry) + cityEconomyValue(siteEntry, owner) : 0;
      const intentBonus = intent?.assaultSite ? Math.max(0, dist(unitEntry, intent.assaultSite) - dist(cell, intent.assaultSite)) * 1.4 * assaultMag : 0;
      const expansionBonus = intent?.expansionSite ? Math.max(0, dist(unitEntry, intent.expansionSite) - dist(cell, intent.expansionSite)) * 1.9 * aggCfg.expansion * expansionMag : 0;
      const futureCityPressure = objective ? Math.max(0, futureReach(unitEntry, diffCfg.lookahead) - dist(cell, objective)) * 0.35 : 0;
      const rerouteBonus = state.rerouteTurns > 0 && objective ? Math.max(0, dist(unitEntry, objective) - dist(cell, objective)) * 0.4 : 0;
      const terrainBonus = game.terrain[cell.y][cell.x] === 'forest' ? 3 * aggCfg.forestBias : 0;
      const roleBonus = unitRoleCellBonus(owner, unitEntry, cell, intent);
      const base = moveScore + supportScore + captureScore + intentBonus + expansionBonus + futureCityPressure + rerouteBonus + terrainBonus + roleBonus - riskPenalty - congestionPenalty;
      if (base > best.score) {
        best = { score: base, move: cell, target: null };
      }
      for (const enemy of enemies) {
        if (dist(cell, enemy) > typeMeta(unitEntry.type).range) {
          continue;
        }
        const preview = previewCombat(unitEntry, enemy, cell, true);
        const focusBonus = intent?.focusTarget?.id === enemy.id ? 18 + projectedPressure(owner, enemy, diffCfg.lookahead, unitEntry.id) * 0.22 : 0;
        const followUpBonus = projectedPressure(owner, enemy, diffCfg.lookahead, unitEntry.id) * 0.18;
        const chaseBonus = enemy.hp <= enemy.maxHp * 0.45 ? 8 * aggCfg.chase : 0;
        const roleTargetBonus = unitRoleTargetBonus(unitEntry, enemy, intent);
        const score = base + preview.damage * 3.1 - preview.counter * 2.1 + (preview.kill ? 24 : 0) + targetValue(enemy) + focusBonus + followUpBonus + chaseBonus + roleTargetBonus;
        if (score > best.score) {
          best = { score, move: cell, target: enemy };
        }
      }
    }
    return best;
  }

  function buildScore(owner, siteEntry, type, cargoTypes = []) {
    const meta = typeMeta(type);
    const ownUnits = game.units.filter(entry => entry.owner === owner);
    const enemySea = game.units.filter(entry => areEnemies(entry.owner, owner) && typeMeta(entry.type).domain === 'sea').length;
    const enemyCavalry = game.units.filter(entry => areEnemies(entry.owner, owner) && entry.type === 'cavalry').length;
    const ownSea = ownUnits.filter(entry => typeMeta(entry.type).domain === 'sea').length;
    const ownLand = ownUnits.filter(entry => typeMeta(entry.type).domain === 'land').length;
    const ownWarships = ownUnits.filter(entry => entry.type === 'warship').length;
    const ownTransports = ownUnits.filter(entry => entry.type === 'transport').length;
    const ownEngineers = ownUnits.filter(entry => entry.type === 'engineer').length;
    const loadedTransports = ownUnits.filter(entry => entry.type === 'transport' && entry.cargo?.length).length;
    // Enemy is across water and our land army already exceeds sealift -> stop piling land, build ships to move it.
    const enemyHasCities = game.sites.some(entry => entry.kind === 'city' && areEnemies(entry.owner, owner));
    const landStranded = enemyHasCities && !hasLandReachToEnemyCity(owner) && ownLand > ownTransports * FERRY_THROUGHPUT + 6;
    let score = meta.level * 6 + meta.atk + meta.def * 0.5 + meta.move * 0.4;
    if (landStranded && meta.domain === 'land') {
      score -= 60;
    }
    if (siteEntry.kind === 'city') {
      if (type === 'spearman') score += enemyCavalry * 2;
      if (type === 'archer' || type === 'crossbow') score += ownLand > 4 ? 4 : 1;
      if (type === 'cavalry') score += W > 30 ? 5 : 1;
      if (type === 'guard') score += 2;
      if (type === 'crossbow') score += ownLand >= 3 ? 6 : 3;
      if (type === 'archer') score += game.goldByOwner[owner] < 50 ? 5 : 2;
      if (type === 'engineer') score += ownEngineers >= 4 ? -20 : (teamNeedsEngineer(owner) && ownEngineers < 2 ? 26 : 4);
    }
    if (siteEntry.kind === 'shipyard') {
      if (type === 'warship') score += enemySea * 3 + (MAPS[game.settings.map].sea ? 8 : 2) + Math.max(0, loadedTransports - ownWarships) * 4;
      if (type === 'transport') score += (ownLand > ownSea * 2 ? 7 : 2) + (landStranded ? 22 : 0) + normalizeCargoTypes(cargoTypes).reduce((sum, cargoType) => sum + (cargoType === 'engineer' ? 6 : typeMeta(cargoType).level * 2), 0);
    }
    return score;
  }

  function aiSpendGold(owner, profile) {
    const diffCfg = DIFF[profile.diff];
    const aggCfg = AGG[profile.agg];
    const upgrades = game.sites.filter(entry => entry.owner === owner && entry.tier < siteMeta(entry.kind).maxTier).sort((a, b) => strategicSiteValue(b, owner) - strategicSiteValue(a, owner));
    for (const siteEntry of upgrades) {
      if (game.goldByOwner[owner] >= siteUpgradeCost(siteEntry) && Math.random() < diffCfg.economy) {
        upgradeSite(owner, siteEntry);
      }
    }
    if (game.goldByOwner[owner] <= aggCfg.lowGoldReserve && profile.agg === 'cautious') {
      return;
    }
    const crowd = capacityPressure(owner);
    let productionBudget = diffCfg.production;
    if (crowd >= 0.95) {
      productionBudget = 0;
    } else if (crowd >= 0.75) {
      productionBudget = Math.max(1, productionBudget - 1);
    }
    let produced = 0;
    while (produced < productionBudget) {
      const options = [];
      for (const siteEntry of game.sites.filter(entry => entry.owner === owner && !getUnit(entry.x, entry.y))) {
        for (const type of buildableTypes(siteEntry)) {
          if (atUnitCap(owner, typeMeta(type).domain)) {
            continue;
          }
          const cargoTypes = type === 'transport' ? chooseTransportCargo(owner, game.goldByOwner[owner], true) : [];
          const totalCost = type === 'transport' ? transportCost(cargoTypes) : typeMeta(type).cost;
          if (game.goldByOwner[owner] >= totalCost) {
            options.push({ siteEntry, type, cargoTypes, score: buildScore(owner, siteEntry, type, cargoTypes) });
          }
        }
      }
      options.sort((a, b) => b.score - a.score);
      if (!options.length || !buildAtSite(owner, options[0].siteEntry, options[0].type, { cargoTypes: options[0].cargoTypes })) {
        break;
      }
      produced += 1;
    }
  }

  function aiManageForces(owner) {
    const landCap = unitCapFor('land');
    const landCount = ownedUnitCount(owner, 'land');
    const crowd = forceCrowding(owner);
    if (landCount <= landCap && crowd < 0.6) {
      return;
    }
    const candidates = game.units.filter(entry => entry.owner === owner && typeMeta(entry.type).domain === 'land' && entry.type !== 'engineer' && (entry.aiState?.stalledTurns || 0) >= 3);
    candidates.sort((a, b) => typeMeta(a.type).level - typeMeta(b.type).level || (b.aiState?.stalledTurns || 0) - (a.aiState?.stalledTurns || 0));
    let quota = Math.max(landCount - landCap, crowd > 0.6 ? 1 : 0);
    quota = Math.min(quota, 3);
    for (const unitEntry of candidates.slice(0, quota)) {
      sellUnit(owner, unitEntry);
    }
  }

  function moveToward(unitEntry, target) {
    const distanceField = buildDistanceField(unitEntry, target);
    const cells = [...reachable(unitEntry).keys()].map(key => {
      const [x, y] = key.split(',').map(Number);
      return { x, y };
    }).filter(cell => cell.x !== unitEntry.x || cell.y !== unitEntry.y);
    if (!cells.length) {
      return false;
    }
    cells.sort((a, b) => {
      const da = distanceField?.get(cellKey(a.x, a.y)) ?? dist(a, target);
      const db = distanceField?.get(cellKey(b.x, b.y)) ?? dist(b, target);
      return da - db;
    });
    return moveUnit(unitEntry, cells[0].x, cells[0].y);
  }

  // Transports advance toward the landing but heavily avoid enemy attack range unless a warship escorts.
  function moveTransportToward(transport, target) {
    const owner = transport.owner;
    const distanceField = buildDistanceField(transport, target);
    const current = { x: transport.x, y: transport.y };
    const currentDist = distanceField?.get(cellKey(current.x, current.y)) ?? dist(current, target);
    const cells = [...reachable(transport).keys()].map(key => {
      const [x, y] = key.split(',').map(Number);
      return { x, y };
    });
    cells.push(current);
    let best = current;
    let bestScore = -Infinity;
    for (const cell of cells) {
      const cellDist = distanceField?.get(cellKey(cell.x, cell.y)) ?? dist(cell, target);
      const progress = currentDist - cellDist;
      const threat = enemyThreat(owner, cell.x, cell.y);
      const escorted = game.units.some(entry => entry.owner === owner && entry.type === 'warship' && diagonalDist(entry, cell) <= 1);
      const score = progress * 3 - threat * (escorted ? 0.4 : 2.4);
      if (score > bestScore) {
        bestScore = score;
        best = cell;
      }
    }
    if (best.x !== transport.x || best.y !== transport.y) {
      return moveUnit(transport, best.x, best.y);
    }
    return false;
  }

  function bestLanding(owner, transport) {
    const cells = [];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (isLandTile(x, y) && adjacent8(x, y).some(cell => isWaterTile(cell.x, cell.y))) {
          cells.push({ x, y, score: strategicLandingScore(owner, { x, y }) });
        }
      }
    }
    cells.sort((a, b) => b.score - a.score || dist(transport, a) - dist(transport, b));
    return cells[0] || null;
  }

  function teamNeedsEngineer(owner) {
    const enemyCities = game.sites.filter(siteEntry => siteEntry.kind === 'city' && areEnemies(siteEntry.owner, owner));
    const ownedEngineers = game.units.filter(unitEntry => unitEntry.owner === owner && unitEntry.type === 'engineer').length;
    return !ownedEngineers || (!!enemyCities.length && !hasLandReachToEnemyCity(owner));
  }

  // Memoized per AI turn: whether any of owner's land units can reach an enemy city by land (expensive flood-fill).
  function hasLandReachToEnemyCity(owner) {
    const cached = landReachCache.get(owner);
    if (cached !== undefined) {
      return cached;
    }
    const result = game.units.some(unitEntry => unitEntry.owner === owner && typeMeta(unitEntry.type).domain === 'land' && landUnitCanReachForeignCity(unitEntry));
    landReachCache.set(owner, result);
    return result;
  }

  function chooseTransportCargo(owner, budget, preferEngineer = false) {
    // A surplus of existing land units is stranded -> build an empty transport to ferry them instead of minting new units.
    // Only once a ferry fleet already exists, so the first transports still project force with fresh cargo.
    const idleLand = game.units.filter(entry => entry.owner === owner && typeMeta(entry.type).domain === 'land').length;
    const transportSlots = game.units.filter(entry => entry.owner === owner && entry.type === 'transport').length * FERRY_THROUGHPUT;
    if (transportSlots >= 2 && idleLand > transportSlots + 4) {
      return [];
    }
    const plans = preferEngineer
      ? [['engineer', 'swordsman'], ['engineer', 'crossbow'], ['engineer'], ['swordsman', 'crossbow'], ['swordsman']]
      : [['guard', 'engineer'], ['swordsman', 'crossbow'], ['engineer', 'swordsman'], ['swordsman', 'spearman'], ['engineer'], ['militia']];
    return plans.find(plan => transportCost(plan) <= budget) || [];
  }

  function engineerBuildChoice(owner, engineer, intent) {
    const waterCells = engineerBuildCells(engineer);
    const enemyCities = game.sites.filter(siteEntry => siteEntry.kind === 'city' && areEnemies(siteEntry.owner, owner));
    const nearestEnemyCity = enemyCities.length ? enemyCities.sort((a, b) => dist(a, engineer) - dist(b, engineer))[0] : null;
    const hasTransport = game.units.some(unitEntry => unitEntry.owner === owner && unitEntry.type === 'transport');
    const landFrontExists = hasLandReachToEnemyCity(owner);
    const nearFront = (nearestEnemyCity && dist(engineer, nearestEnemyCity) <= 6) || game.units.some(unitEntry => areEnemies(unitEntry.owner, owner) && dist(unitEntry, engineer) <= 5);
    const safeEnough = enemyThreat(owner, engineer.x, engineer.y) < typeMeta('engineer').hp * 0.6;
    const canAffordForwardBase = game.goldByOwner[owner] >= CAMP_COST + typeMeta('swordsman').cost;
    const needsCamp = landFrontExists && !getSite(engineer.x, engineer.y) && campCount(owner) < MAX_CAMPS_PER_SIDE && canAffordForwardBase && nearFront && safeEnough && !atUnitCap(owner, 'land');
    if (needsCamp && canBuildCamp(engineer)) {
      return { kind: 'camp' };
    }
    if (!waterCells.length) {
      return null;
    }
    const ownedTransports = game.units.filter(unitEntry => unitEntry.owner === owner && unitEntry.type === 'transport').length;
    const landWaiting = game.units.some(unitEntry => unitEntry.owner === owner && typeMeta(unitEntry.type).domain === 'land' && unitEntry.type !== 'engineer' && !landUnitCanReachForeignCity(unitEntry));
    const needFerry = !landFrontExists && enemyCities.length > 0 && landWaiting;
    if (needFerry && ownedTransports < 2 && game.goldByOwner[owner] >= transportCost(['engineer']) && !atUnitCap(owner, 'sea')) {
      const cargoTypes = chooseTransportCargo(owner, game.goldByOwner[owner], true);
      const cell = waterCells.sort((a, b) => (intent?.assaultSite ? dist(a, intent.assaultSite) - dist(b, intent.assaultSite) : 0))[0];
      if (cell) {
        return { kind: 'transport', cell, cargoTypes };
      }
    }
    const enemySea = game.units.some(unitEntry => areEnemies(unitEntry.owner, owner) && typeMeta(unitEntry.type).domain === 'sea');
    if (enemySea && game.goldByOwner[owner] >= typeMeta('warship').cost) {
      return { kind: 'warship', cell: waterCells[0], cargoTypes: [] };
    }
    if ((teamNeedsEngineer(owner) || !hasTransport || intent?.assaultSite) && game.goldByOwner[owner] >= transportCost(['engineer'])) {
      const cargoTypes = chooseTransportCargo(owner, game.goldByOwner[owner], true);
      const cell = waterCells.sort((a, b) => (intent?.assaultSite ? dist(a, intent.assaultSite) - dist(b, intent.assaultSite) : 0))[0];
      if (cell) {
        return { kind: 'transport', cell, cargoTypes };
      }
    }
    return null;
  }

  // Scripted test opponent: defends the upper half of the strait and deliberately leaves the lower half open.
  function bridgeheadTryAttack(owner, unitEntry) {
    if (unitEntry.hasAttacked) {
      return false;
    }
    const targets = game.units.filter(entry => canAttack(unitEntry, entry));
    if (!targets.length) {
      return false;
    }
    targets.sort((a, b) => (a.hp - b.hp) || (typeMeta(b.type).level - typeMeta(a.type).level));
    attack(unitEntry, targets[0]);
    return true;
  }

  function bridgeheadDefendCell(owner, unitEntry) {
    const midY = Math.floor(H * BRIDGEHEAD_DEFEND_FRACTION);
    const enemies = game.units.filter(entry => areEnemies(entry.owner, owner));
    const upperEnemies = enemies.filter(entry => entry.y < midY);
    const focus = (upperEnemies.length ? upperEnemies : enemies).sort((a, b) => dist(a, unitEntry) - dist(b, unitEntry))[0];
    const cells = [...reachable(unitEntry).keys()].map(key => {
      const [x, y] = key.split(',').map(Number);
      return { x, y };
    });
    cells.push({ x: unitEntry.x, y: unitEntry.y });
    const zoneCells = cells.filter(cell => cell.y < midY);
    const pool = zoneCells.length ? zoneCells : cells;
    if (!focus) {
      const anchorX = Math.floor(W / 2);
      pool.sort((a, b) => Math.abs(a.x - anchorX) - Math.abs(b.x - anchorX) || a.y - b.y);
      return pool[0];
    }
    pool.sort((a, b) => dist(a, focus) - dist(b, focus) || a.y - b.y);
    return pool[0];
  }

  function bridgeheadProduce(owner) {
    const prefer = ['guard', 'spearman', 'crossbow', 'archer', 'swordsman', 'militia'];
    let built = 0;
    for (const siteEntry of game.sites.filter(entry => entry.owner === owner && !getUnit(entry.x, entry.y))) {
      if (built >= 2) {
        break;
      }
      const types = buildableTypes(siteEntry);
      const landChoice = prefer.find(type => types.includes(type) && game.goldByOwner[owner] >= typeMeta(type).cost);
      const choice = landChoice || (types.includes('warship') && game.goldByOwner[owner] >= typeMeta('warship').cost ? 'warship' : null);
      if (choice && buildAtSite(owner, siteEntry, choice)) {
        built += 1;
      }
    }
  }

  async function bridgeheadTurn(owner) {
    logAiDecision(owner, '桥头测试AI：死守上方 3/4，仅留最下 1/4 不设防。');
    bridgeheadProduce(owner);
    refresh();
    await pause(aiStepDelay());
    const units = game.units.filter(entry => entry.owner === owner);
    for (const unitEntry of [...units]) {
      if (!game.units.includes(unitEntry)) {
        continue;
      }
      if (!bridgeheadTryAttack(owner, unitEntry)) {
        const dest = bridgeheadDefendCell(owner, unitEntry);
        if (dest && (dest.x !== unitEntry.x || dest.y !== unitEntry.y)) {
          moveUnit(unitEntry, dest.x, dest.y);
        }
        bridgeheadTryAttack(owner, unitEntry);
      }
      refresh();
      await pause(aiStepDelay());
    }
    if (!game.over) {
      advanceTurn();
    }
  }

  // Scripted naval test opponent: contests the upper sea lane, hunts transports, holds cities, leaves the lower sea open.
  function navalTryAttack(owner, unitEntry) {
    if (unitEntry.hasAttacked) {
      return false;
    }
    const targets = game.units.filter(entry => canAttack(unitEntry, entry));
    if (!targets.length) {
      return false;
    }
    const priority = entry => (entry.type === 'transport' ? 2 : entry.type === 'warship' ? 1 : 0);
    targets.sort((a, b) => priority(b) - priority(a) || (a.hp - b.hp));
    attack(unitEntry, targets[0]);
    return true;
  }

  function navalPatrolCell(owner, warship) {
    const line = Math.floor(H * BRIDGEHEAD_DEFEND_FRACTION);
    const enemies = game.units.filter(entry => areEnemies(entry.owner, owner));
    const seaFocus = enemies.filter(entry => (typeMeta(entry.type).domain === 'sea' || entry.type === 'transport') && entry.y < line);
    const focus = (seaFocus.length ? seaFocus : enemies).sort((a, b) => dist(a, warship) - dist(b, warship))[0];
    const cells = [...reachable(warship).keys()].map(key => {
      const [x, y] = key.split(',').map(Number);
      return { x, y };
    });
    cells.push({ x: warship.x, y: warship.y });
    const zone = cells.filter(cell => cell.y < line);
    const pool = zone.length ? zone : cells;
    if (!focus) {
      const anchorX = Math.floor(W / 2);
      pool.sort((a, b) => Math.abs(a.x - anchorX) - Math.abs(b.x - anchorX) || a.y - b.y);
      return pool[0];
    }
    pool.sort((a, b) => dist(a, focus) - dist(b, focus) || a.y - b.y);
    return pool[0];
  }

  function navalLandHoldCell(owner, unitEntry) {
    const homes = game.sites.filter(entry => entry.owner === owner && (entry.kind === 'city' || entry.kind.startsWith('barracks')));
    const cells = [...reachable(unitEntry).keys()].map(key => {
      const [x, y] = key.split(',').map(Number);
      return { x, y };
    });
    cells.push({ x: unitEntry.x, y: unitEntry.y });
    const nearEnemy = game.units.filter(entry => areEnemies(entry.owner, owner) && typeMeta(entry.type).domain === 'land').sort((a, b) => dist(a, unitEntry) - dist(b, unitEntry))[0];
    if (nearEnemy && dist(nearEnemy, unitEntry) <= 6) {
      cells.sort((a, b) => dist(a, nearEnemy) - dist(b, nearEnemy));
      return cells[0];
    }
    const home = homes.sort((a, b) => dist(a, unitEntry) - dist(b, unitEntry))[0];
    if (home) {
      cells.sort((a, b) => dist(a, home) - dist(b, home));
      return cells[0];
    }
    return { x: unitEntry.x, y: unitEntry.y };
  }

  function navalProduce(owner) {
    let built = 0;
    for (const siteEntry of game.sites.filter(entry => entry.owner === owner && entry.kind === 'shipyard' && !getUnit(entry.x, entry.y))) {
      if (built >= 2) {
        break;
      }
      if (buildableTypes(siteEntry).includes('warship') && game.goldByOwner[owner] >= typeMeta('warship').cost && buildAtSite(owner, siteEntry, 'warship')) {
        built += 1;
      }
    }
    const prefer = ['guard', 'spearman', 'crossbow', 'archer'];
    for (const siteEntry of game.sites.filter(entry => entry.owner === owner && entry.kind === 'city' && !getUnit(entry.x, entry.y))) {
      if (built >= 3) {
        break;
      }
      const type = prefer.find(entry => buildableTypes(siteEntry).includes(entry) && game.goldByOwner[owner] >= typeMeta(entry).cost);
      if (type && buildAtSite(owner, siteEntry, type)) {
        built += 1;
      }
    }
  }

  async function navalTurn(owner) {
    logAiDecision(owner, '海防测试AI：制海守上方水道、专打运兵船，下方海道留口。');
    navalProduce(owner);
    refresh();
    await pause(aiStepDelay());
    const units = game.units.filter(entry => entry.owner === owner);
    for (const unitEntry of [...units]) {
      if (!game.units.includes(unitEntry)) {
        continue;
      }
      const dest = typeMeta(unitEntry.type).domain === 'sea' ? navalPatrolCell(owner, unitEntry) : navalLandHoldCell(owner, unitEntry);
      if (!navalTryAttack(owner, unitEntry)) {
        if (dest && (dest.x !== unitEntry.x || dest.y !== unitEntry.y)) {
          moveUnit(unitEntry, dest.x, dest.y);
        }
        navalTryAttack(owner, unitEntry);
      }
      refresh();
      await pause(aiStepDelay());
    }
    if (!game.over) {
      advanceTurn();
    }
  }

  async function aiTurn(owner) {
    const profile = game.aiProfiles[owner] || { diff: 'medium', agg: 'balanced' };
    landReachCache.clear();
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
    distFieldCache.clear();
    game = {
      terrain: terrainFor($('mapSelect').value, $('complexitySelect').value),
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

  const SAVE_PREFIX = 'frontier_save_';

  function listSaves() {
    const saves = [];
    for (const key of saveStore.keys()) {
      if (!key || !key.startsWith(SAVE_PREFIX)) {
        continue;
      }
      try {
        const data = JSON.parse(saveStore.getItem(key));
        saves.push({ key, name: data.name || '未命名', savedAt: data.savedAt || 0, map: data.map || '', turn: data.turn || 1 });
      } catch (err) {
        // Skip corrupted save entries.
      }
    }
    return saves.sort((a, b) => b.savedAt - a.savedAt);
  }

  function buildSavePayload(name) {
    const { selected, pendingOrder, ...rest } = game;
    return {
      name: name || `存档 ${new Date().toLocaleString('zh-CN')}`,
      savedAt: Date.now(),
      map: MAPS[game.settings.map]?.name || game.settings.map,
      turn: game.turn,
      W, H, S,
      state: rest
    };
  }

  function saveAsNewSave(name) {
    if (!game) {
      return false;
    }
    const key = SAVE_PREFIX + Date.now();
    try {
      saveStore.setItem(key, JSON.stringify(buildSavePayload(name)));
      currentSaveKey = key;
      return true;
    } catch (err) {
      return false;
    }
  }

  function overwriteCurrentSave(name) {
    if (!game || !currentSaveKey) {
      return false;
    }
    try {
      saveStore.setItem(currentSaveKey, JSON.stringify(buildSavePayload(name)));
      return true;
    } catch (err) {
      return false;
    }
  }

  function importSaveToList(payload) {
    if (!payload?.state) {
      return false;
    }
    try {
      saveStore.setItem(SAVE_PREFIX + Date.now(), JSON.stringify({
        name: payload.name || '导入的存档',
        savedAt: payload.savedAt || Date.now(),
        map: payload.map || '',
        turn: payload.turn || 1,
        W: payload.W,
        H: payload.H,
        S: payload.S,
        state: payload.state
      }));
      return true;
    } catch (err) {
      return false;
    }
  }

  function currentSaveName() {
    if (!currentSaveKey) {
      return '';
    }
    try {
      return JSON.parse(saveStore.getItem(currentSaveKey))?.name || '';
    } catch (err) {
      return '';
    }
  }

  // Browsers can't write to the game folder directly, so export downloads a .json the user can keep in /saves.
  function downloadSaveFile(payload) {
    if (!payload) {
      return;
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const safeName = String(payload.name || 'save').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60);
    link.href = url;
    link.download = `${safeName}.frontiersave.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

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
    distFieldCache.clear();
    landReachCache.clear();
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

  function loadSave(key) {
    let payload;
    try {
      payload = JSON.parse(saveStore.getItem(key));
    } catch (err) {
      return false;
    }
    if (loadPayload(payload)) {
      currentSaveKey = key;
      return true;
    }
    return false;
  }

  function deleteSave(key) {
    saveStore.removeItem(key);
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
    const terrain = terrainFor($('mapSelect').value, $('complexitySelect').value);
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
        downloadSaveFile(JSON.parse(saveStore.getItem(selectedSaveKey)));
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