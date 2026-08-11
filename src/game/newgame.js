'use strict';
// 开新局：读大厅配置 → 定尺寸 → 生成地形 → 布点 → 出兵 → 交给首回合。
//
// 依赖注入方式见 game/movement.js 顶部对 rt 门面的说明；额外的 deps 见
// debug/hooks.js 的说明。
//
// 【顺序是硬约束，不是风格】
// 从上到下每一步都依赖前一步的结果：
//   1. 读配置    —— 阵营名单要先定，后面所有 Object.fromEntries(owners...) 都靠它
//   2. 定 W/H/S  —— 地形生成、画布尺寸、摄像机都要用
//   3. 建 game   —— 这一步之后 rt.game 才是新的那局
//   4. 布据点    —— makeCities 必须最先，makeNavalSites / makeSpecialSites 要
//                   避开已有据点
//   5. 出兵      —— spawnLand 需要 used 集合（城市占掉的格子）
//   6. 首回合    —— beginTurn 重置移动力、结算收入
// 打乱任意两步都会静默产生一局"能玩但不对"的游戏。
//
// 【随机数消耗量是基线的一部分】
// 地形生成、城市布点、特殊据点、出兵位置全部走 Math.random()。**改变这里任何一处
// 的随机数调用次数或顺序，都会让 sim/baseline.json 整体失效** —— 哪怕逻辑等价。
// 比如把 `spawnSea(...)` 挪到 `spawnLand(...)` 后面，两者消耗的随机数序列就换了位置。
// 真要改，先想清楚是不是打算更新基线。
//
// 【为什么开局金币是硬编码的 45】
// 它不在设置里，因为收入倍率（incomeMult）已经提供了调节经济节奏的手段，再多一个
// 起始金币会让平衡矩阵多一个维度。改它等于改所有基线。
//
// 【newGame 返回时游戏还没开始】
// 非 fastSim 下首回合交给 runLoadingScreen 的 setInterval，newGame 返回时
// beginTurn 还没跑。测试里要同步拿到开局状态，得用 fastSim 或
// __frontierDebug 的 repaint* 入口。
import {
  TEAMS, OWNER_COLORS, COLOR_PRESETS, VIEW_MAX_W, VIEW_MAX_H,
  MAPS, SIZES, ASPECTS
} from '../core/constants.js';
import { cellKey } from '../core/utils.js';
import { terrainFor } from '../world/mapgen.js';

// 每个阵营的起始金币。见文件头：改它等于改所有基线。
const START_GOLD = 45;
// 策略统计的空模板。字段名同时是 sim/scenarios.js 指纹的一部分。
const EMPTY_STRAT = {
  stalls: 0, reserves: 0, reroutes: 0, retreats: 0,
  cityCaptures: 0, oilCaptures: 0, shipyardCaptures: 0,
  engineerLandings: 0, transportLaunches: 0, campsBuilt: 0, sells: 0
};

export function createNewGame(rt, deps) {
  const $ = id => document.getElementById(id);
  const {
    makeCities, makeNavalSites, makeSpecialSites, spawnLand, spawnSea,
    centerCamOn, clearDistFieldCache, beginTurn, runLoadingScreen
  } = deps;

  // 从大厅的下拉框读出这一局的全部配置。
  // 每个 $(...) 都带兜底：sim/harness.js 的 DOM 打桩不保证每个 id 都有值。
  function readLobbyConfig() {
    const aiCount = Number($('aiSelect').value);
    const spectator = $('spectatorSelect')?.value === 'on';
    // 观战模式下玩家不参战，名单里就没有 'player'。
    const owners = spectator
      ? Array.from({ length: aiCount }, (_, index) => `ai${index}`)
      : ['player', ...Array.from({ length: aiCount }, (_, index) => `ai${index}`)];
    const teams = { player: $('playerTeamSelect').value };
    const aiProfiles = {};
    const ownerColors = { player: COLOR_PRESETS[$('playerColorSelect').value || 'azure']?.value || '#55a3ff' };
    for (let i = 0; i < aiCount; i++) {
      teams[`ai${i}`] = $(`ai${i}Team`)?.value || TEAMS[(i + 1) % TEAMS.length];
      aiProfiles[`ai${i}`] = { diff: $(`ai${i}Diff`)?.value || 'medium', agg: $(`ai${i}Agg`)?.value || 'balanced' };
      ownerColors[`ai${i}`] = COLOR_PRESETS[$(`ai${i}Color`)?.value || 'crimson']?.value || OWNER_COLORS[i % OWNER_COLORS.length];
    }
    return { aiCount, spectator, owners, teams, aiProfiles, ownerColors };
  }

  function readSettings(config) {
    return {
      map: $('mapSelect').value,
      mode: $('modeSelect').value,
      spectator: config.spectator,
      ai: config.aiCount,
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
    };
  }

  function emptyStats(owners) {
    return {
      startTime: null,
      endTime: null,
      chartIndex: 0,
      produced: Object.fromEntries(owners.map(owner => [owner, 0])),
      kills: Object.fromEntries(owners.map(owner => [owner, 0])),
      losses: Object.fromEntries(owners.map(owner => [owner, 0])),
      captures: Object.fromEntries(owners.map(owner => [owner, 0])),
      lostSites: Object.fromEntries(owners.map(owner => [owner, 0])),
      strat: Object.fromEntries(owners.map(owner => [owner, { ...EMPTY_STRAT }])),
      history: []
    };
  }

  function newGame() {
    const config = readLobbyConfig();
    const { owners, spectator } = config;
    const dimensions = rt.computeDimensions($('sizeSelect').value, $('aspectSelect').value);
    rt.setDimensions(dimensions.w, dimensions.h);
    // 小图用大格子看得清，大图用小格子换视野 —— 超出视口的部分靠平移。
    rt.setCellSize(dimensions.w <= 22 ? 52 : 44);
    const W = rt.W;
    const H = rt.H;
    const S = rt.S;
    rt.resizeCanvas(Math.min(W * S, VIEW_MAX_W), Math.min(H * S, VIEW_MAX_H));
    rt.resetCamera();
    // 新局和任何存档都无关，清掉"当前存档"标记，下次保存会走"另存为"。
    rt.currentSaveKey = null;
    // 距离场缓存只依赖地形，换地图必须清。
    // （落地可达缓存依赖单位位置，每回合开头会清，这里不用管。）
    clearDistFieldCache();

    rt.setGame({
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
      teams: config.teams,
      ownerColors: config.ownerColors,
      aiProfiles: config.aiProfiles,
      aiFrontMemory: {},
      freeplay: false,
      pendingOrder: null,
      goldByOwner: Object.fromEntries(owners.map(owner => [owner, START_GOLD])),
      stats: emptyStats(owners),
      settings: readSettings(config)
    });
    const game = rt.game;

    // 布点顺序不能换：城市先占位，后两者要避开已有据点。
    game.sites = makeCities(config.aiCount, game.settings.size, game.settings.spread);
    game.sites.push(...makeNavalSites());
    game.sites.push(...makeSpecialSites());

    // 城市占掉的格子，出兵时要避开（不能把单位生在城里）。
    const used = new Set(game.sites.filter(entry => entry.kind === 'city').map(entry => cellKey(entry.x, entry.y)));
    for (const owner of owners) {
      const homes = game.sites.filter(entry => entry.owner === owner && entry.kind === 'city');
      if (!homes.length) {
        continue;
      }
      // 起始兵力 ≥4 才给海军，≥6 给两艘 —— 兵少的时候海军会挤占陆军编制。
      const seaSpawn = game.settings.start >= 4 ? spawnSea(owner, game.settings.start >= 6 ? 2 : 1) : 0;
      spawnLand(owner, homes, Math.max(0, game.settings.start - seaSpawn), used, game.settings.deploy);
    }

    $('statsPanel').classList.add('hidden');
    $('statsSummary').innerHTML = '';
    rt.recordStatSnapshot('deploy');
    rt.log(`版本 0.1.2 战局开始：${MAPS[game.settings.map].name} · ${SIZES[game.settings.size].name} · ${ASPECTS[game.settings.aspect].name} ${W}×${H} · ${game.sites.filter(entry => entry.kind === 'city').length} 座城市 · ${game.sites.filter(entry => entry.kind === 'shipyard').length} 座船坞。`, 'system');

    const focusCity = game.sites.find(entry => entry.kind === 'city' && entry.owner === (spectator ? owners[0] : 'player'));
    if (focusCity) {
      centerCamOn(focusCity.x, focusCity.y);
    }
    const startFirstTurn = () => beginTurn(owners[0], true);
    // fastSim 下不能等 setInterval，直接开打。见文件头。
    if (rt.fastSim) {
      startFirstTurn();
    } else {
      runLoadingScreen(owners, startFirstTurn);
    }
  }

  return { newGame, readLobbyConfig, readSettings, emptyStats };
}
