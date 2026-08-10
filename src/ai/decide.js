'use strict';
// AI 动作决策：这一格值不值得走、该打谁、造什么、卖什么、工程师干什么。
//
// 依赖注入方式见 game/movement.js 顶部对 rt 门面的说明。
//
// 三层里的最后一层：scoring 答「值多少分」，intent 答「这一方想干什么」，
// 这里答「具体怎么做」。
//
// ⚠️ chooseAction 是整个 AI 的心脏，一次调用会把「可达格 × (1 + 敌人数)」种
// 组合全部打分。它【不】执行任何动作，只返回 { score, move, target } —— 执行
// 由 aiTurn 负责。这个分离是有意的：可以在不落子的情况下评估，也让这个函数
// 保持无副作用、可反复调用。
//
// ⚠️ aiSpendGold 里有一处 Math.random()（升级据点的概率判定）。它在升级循环
// 内、按据点顺序消耗，所以升级候选的排序、以及循环有没有提前 return，都会改变
// 后续整条随机数流。sim 的确定性回放依赖这一点，不要重排那个循环。
import { DIFF, AGG, MAPS, FERRY_THROUGHPUT, CAMP_COST, MAX_CAMPS_PER_SIDE } from '../core/constants.js';
import { cellKey, dist, diagonalDist, typeMeta, siteMeta } from '../core/utils.js';
import { normalizeCargoTypes, transportCost } from '../game/entities.js';

export function createDecide(rt) {
  // 本方有多少比例的单位卡住了。高说明战线僵持，该考虑卖兵换钱而不是继续堆。
  function forceCrowding(owner) {
    const units = rt.game.units.filter(entry => entry.owner === owner);
    if (!units.length) {
      return 0;
    }
    const stalled = units.filter(entry => (entry.aiState?.stalledTurns || 0) >= 2).length;
    return stalled / units.length;
  }

  function capacityPressure(owner) {
    const landRatio = rt.ownedUnitCount(owner, 'land') / Math.max(1, rt.unitCapFor('land'));
    const seaRatio = rt.ownedUnitCount(owner, 'sea') / Math.max(1, rt.unitCapFor('sea'));
    return Math.max(landRatio, seaRatio);
  }

  // 装最高级、同级装最健康的。
  function autoLoadAdjacent(transport) {
    const options = rt.game.units.filter(entry => entry.owner === transport.owner && typeMeta(entry.type).domain === 'land' && diagonalDist(entry, transport) === 1);
    options.sort((a, b) => typeMeta(b.type).level - typeMeta(a.type).level || b.hp - a.hp);
    return options.length ? rt.loadTransport(transport, options[0]) : false;
  }

  function autoUnloadAdjacent(transport) {
    const cells = rt.adjacent8(transport.x, transport.y).filter(cell => rt.canUnloadTransport(transport, cell.x, cell.y));
    if (!cells.length) {
      return false;
    }
    cells.sort((a, b) => rt.strategicLandingScore(transport.owner, b) - rt.strategicLandingScore(transport.owner, a));
    return rt.unloadTransport(transport, cells[0].x, cells[0].y);
  }

  // 对每个可达格（含原地）打分，再对每个射程内的敌人叠加一次攻击评估。
  // 返回最优的 { score, move, target }，target 为 null 表示只移动不攻击。
  function chooseAction(owner, unitEntry, profile, intent = null) {
    const diffCfg = DIFF[profile.diff];
    const aggCfg = AGG[profile.agg];
    const state = unitEntry.aiState || { stalledTurns: 0, rerouteTurns: 0 };
    const cells = [...rt.reachable(unitEntry).entries()].map(([key, cost]) => {
      const [x, y] = key.split(',').map(Number);
      return { x, y, cost };
    });
    cells.push({ x: unitEntry.x, y: unitEntry.y, cost: 0 });
    const objective = rt.bestObjective(owner, unitEntry, intent);
    const distanceField = rt.buildDistanceField(unitEntry, objective);
    const enemies = rt.game.units.filter(entry => rt.areEnemies(entry.owner, owner));
    // 主攻点已经挤了 5 个人就调低吸引力、调高扩张权重，避免全军堵在一个隘口。
    const assaultSaturated = intent?.assaultSite && rt.isBridgeheadSite(intent.assaultSite) ? rt.frontlineCount(owner, intent.assaultSite, 2) >= 5 : false;
    const assaultMag = assaultSaturated ? 0.4 : 1;
    const expansionMag = assaultSaturated ? 1.5 : 1;
    let best = { score: -Infinity, move: null, target: null };
    for (const cell of cells) {
      const currentPath = objective && distanceField ? distanceField.get(cellKey(unitEntry.x, unitEntry.y)) ?? dist(unitEntry, objective) : 0;
      const nextPath = objective && distanceField ? distanceField.get(cellKey(cell.x, cell.y)) ?? dist(cell, objective) : 0;
      const moveScore = objective ? (currentPath - nextPath) * 2.9 * diffCfg.lookahead * aggCfg.push : 0;
      const supportScore = rt.friendSupport(owner, cell.x, cell.y);
      const riskPenalty = rt.enemyThreat(owner, cell.x, cell.y) * diffCfg.risk * aggCfg.preserve * 0.9;
      const congestionPenalty = rt.allyCongestion(owner, cell, unitEntry.id) * (1.8 + state.stalledTurns * 0.7);
      const siteEntry = rt.getSite(cell.x, cell.y);
      const captureScore = siteEntry ? rt.strategicSiteValue(siteEntry, owner, unitEntry) + rt.cityEconomyValue(siteEntry, owner) : 0;
      const intentBonus = intent?.assaultSite ? Math.max(0, dist(unitEntry, intent.assaultSite) - dist(cell, intent.assaultSite)) * 1.4 * assaultMag : 0;
      const expansionBonus = intent?.expansionSite ? Math.max(0, dist(unitEntry, intent.expansionSite) - dist(cell, intent.expansionSite)) * 1.9 * aggCfg.expansion * expansionMag : 0;
      const futureCityPressure = objective ? Math.max(0, rt.futureReach(unitEntry, diffCfg.lookahead) - dist(cell, objective)) * 0.35 : 0;
      const rerouteBonus = state.rerouteTurns > 0 && objective ? Math.max(0, dist(unitEntry, objective) - dist(cell, objective)) * 0.4 : 0;
      const terrainBonus = rt.game.terrain[cell.y][cell.x] === 'forest' ? 3 * aggCfg.forestBias : 0;
      const roleBonus = rt.unitRoleCellBonus(owner, unitEntry, cell, intent);
      const base = moveScore + supportScore + captureScore + intentBonus + expansionBonus + futureCityPressure + rerouteBonus + terrainBonus + roleBonus - riskPenalty - congestionPenalty;
      if (base > best.score) {
        best = { score: base, move: cell, target: null };
      }
      for (const enemy of enemies) {
        if (dist(cell, enemy) > typeMeta(unitEntry.type).range) {
          continue;
        }
        // deterministic=true：预演不能消耗随机数，否则评估过程本身会影响后续战斗结果。
        const preview = rt.previewCombat(unitEntry, enemy, cell, true);
        const focusBonus = intent?.focusTarget?.id === enemy.id ? 18 + rt.projectedPressure(owner, enemy, diffCfg.lookahead, unitEntry.id) * 0.22 : 0;
        const followUpBonus = rt.projectedPressure(owner, enemy, diffCfg.lookahead, unitEntry.id) * 0.18;
        const chaseBonus = enemy.hp <= enemy.maxHp * 0.45 ? 8 * aggCfg.chase : 0;
        const roleTargetBonus = rt.unitRoleTargetBonus(unitEntry, enemy, intent);
        const score = base + preview.damage * 3.1 - preview.counter * 2.1 + (preview.kill ? 24 : 0) + rt.targetValue(enemy) + focusBonus + followUpBonus + chaseBonus + roleTargetBonus;
        if (score > best.score) {
          best = { score, move: cell, target: enemy };
        }
      }
    }
    return best;
  }

  function buildScore(owner, siteEntry, type, cargoTypes = []) {
    const meta = typeMeta(type);
    const ownUnits = rt.game.units.filter(entry => entry.owner === owner);
    const enemySea = rt.game.units.filter(entry => rt.areEnemies(entry.owner, owner) && typeMeta(entry.type).domain === 'sea').length;
    const enemyCavalry = rt.game.units.filter(entry => rt.areEnemies(entry.owner, owner) && entry.type === 'cavalry').length;
    const ownSea = ownUnits.filter(entry => typeMeta(entry.type).domain === 'sea').length;
    const ownLand = ownUnits.filter(entry => typeMeta(entry.type).domain === 'land').length;
    const ownWarships = ownUnits.filter(entry => entry.type === 'warship').length;
    const ownTransports = ownUnits.filter(entry => entry.type === 'transport').length;
    const ownEngineers = ownUnits.filter(entry => entry.type === 'engineer').length;
    const loadedTransports = ownUnits.filter(entry => entry.type === 'transport' && entry.cargo?.length).length;
    // 敌人在海对面、陆军又已经超过运力 → 别再堆陆军了，造船把人运过去。
    const enemyHasCities = rt.game.sites.some(entry => entry.kind === 'city' && rt.areEnemies(entry.owner, owner));
    const landStranded = enemyHasCities && !rt.hasLandReachToEnemyCity(owner) && ownLand > ownTransports * FERRY_THROUGHPUT + 6;
    let score = meta.level * 6 + meta.atk + meta.def * 0.5 + meta.move * 0.4;
    if (landStranded && meta.domain === 'land') {
      score -= 60;
    }
    if (siteEntry.kind === 'city') {
      if (type === 'spearman') score += enemyCavalry * 2;
      if (type === 'archer' || type === 'crossbow') score += ownLand > 4 ? 4 : 1;
      if (type === 'cavalry') score += rt.W > 30 ? 5 : 1;
      if (type === 'guard') score += 2;
      if (type === 'crossbow') score += ownLand >= 3 ? 6 : 3;
      if (type === 'archer') score += rt.game.goldByOwner[owner] < 50 ? 5 : 2;
      if (type === 'engineer') score += ownEngineers >= 4 ? -20 : (teamNeedsEngineer(owner) && ownEngineers < 2 ? 26 : 4);
    }
    if (siteEntry.kind === 'shipyard') {
      if (type === 'warship') score += enemySea * 3 + (MAPS[rt.game.settings.map].sea ? 8 : 2) + Math.max(0, loadedTransports - ownWarships) * 4;
      if (type === 'transport') score += (ownLand > ownSea * 2 ? 7 : 2) + (landStranded ? 22 : 0) + normalizeCargoTypes(cargoTypes).reduce((sum, cargoType) => sum + (cargoType === 'engineer' ? 6 : typeMeta(cargoType).level * 2), 0);
    }
    return score;
  }

  function aiSpendGold(owner, profile) {
    const diffCfg = DIFF[profile.diff];
    const aggCfg = AGG[profile.agg];
    const upgrades = rt.game.sites.filter(entry => entry.owner === owner && entry.tier < siteMeta(entry.kind).maxTier).sort((a, b) => rt.strategicSiteValue(b, owner) - rt.strategicSiteValue(a, owner));
    for (const siteEntry of upgrades) {
      if (rt.game.goldByOwner[owner] >= rt.siteUpgradeCost(siteEntry) && Math.random() < diffCfg.economy) {
        rt.upgradeSite(owner, siteEntry);
      }
    }
    if (rt.game.goldByOwner[owner] <= aggCfg.lowGoldReserve && profile.agg === 'cautious') {
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
      for (const siteEntry of rt.game.sites.filter(entry => entry.owner === owner && !rt.getUnit(entry.x, entry.y))) {
        for (const type of rt.buildableTypes(siteEntry)) {
          if (rt.atUnitCap(owner, typeMeta(type).domain)) {
            continue;
          }
          const cargoTypes = type === 'transport' ? chooseTransportCargo(owner, rt.game.goldByOwner[owner], true) : [];
          const totalCost = type === 'transport' ? transportCost(cargoTypes) : typeMeta(type).cost;
          if (rt.game.goldByOwner[owner] >= totalCost) {
            options.push({ siteEntry, type, cargoTypes, score: buildScore(owner, siteEntry, type, cargoTypes) });
          }
        }
      }
      // 稳定排序 + 生成顺序（据点顺序 × buildableTypes 顺序）共同决定同分时选谁。
      options.sort((a, b) => b.score - a.score);
      if (!options.length || !rt.buildAtSite(owner, options[0].siteEntry, options[0].type, { cargoTypes: options[0].cargoTypes })) {
        break;
      }
      produced += 1;
    }
  }

  // 兵力超上限或战线僵住时，卖掉最没用的几个卡住的兵换钱。工程师永不卖。
  function aiManageForces(owner) {
    const landCap = rt.unitCapFor('land');
    const landCount = rt.ownedUnitCount(owner, 'land');
    const crowd = forceCrowding(owner);
    if (landCount <= landCap && crowd < 0.6) {
      return;
    }
    const candidates = rt.game.units.filter(entry => entry.owner === owner && typeMeta(entry.type).domain === 'land' && entry.type !== 'engineer' && (entry.aiState?.stalledTurns || 0) >= 3);
    candidates.sort((a, b) => typeMeta(a.type).level - typeMeta(b.type).level || (b.aiState?.stalledTurns || 0) - (a.aiState?.stalledTurns || 0));
    let quota = Math.max(landCount - landCap, crowd > 0.6 ? 1 : 0);
    quota = Math.min(quota, 3);
    for (const unitEntry of candidates.slice(0, quota)) {
      rt.sellUnit(owner, unitEntry);
    }
  }

  function teamNeedsEngineer(owner) {
    const enemyCities = rt.game.sites.filter(siteEntry => siteEntry.kind === 'city' && rt.areEnemies(siteEntry.owner, owner));
    const ownedEngineers = rt.game.units.filter(unitEntry => unitEntry.owner === owner && unitEntry.type === 'engineer').length;
    return !ownedEngineers || (!!enemyCities.length && !rt.hasLandReachToEnemyCity(owner));
  }

  function chooseTransportCargo(owner, budget, preferEngineer = false) {
    // 已有陆军过剩且被困住 → 造空船去摆渡他们，而不是再造新兵。
    // 只在已经有一支摆渡船队之后才这么做，所以头几艘船仍然带兵投送。
    const idleLand = rt.game.units.filter(entry => entry.owner === owner && typeMeta(entry.type).domain === 'land').length;
    const transportSlots = rt.game.units.filter(entry => entry.owner === owner && entry.type === 'transport').length * FERRY_THROUGHPUT;
    if (transportSlots >= 2 && idleLand > transportSlots + 4) {
      return [];
    }
    const plans = preferEngineer
      ? [['engineer', 'swordsman'], ['engineer', 'crossbow'], ['engineer'], ['swordsman', 'crossbow'], ['swordsman']]
      : [['guard', 'engineer'], ['swordsman', 'crossbow'], ['engineer', 'swordsman'], ['swordsman', 'spearman'], ['engineer'], ['militia']];
    return plans.find(plan => transportCost(plan) <= budget) || [];
  }

  // 工程师这回合干什么：建前进营地、造摆渡船、造战舰，还是什么都不做。
  // 判断顺序本身就是优先级，不要重排。
  function engineerBuildChoice(owner, engineer, intent) {
    const waterCells = rt.engineerBuildCells(engineer);
    const enemyCities = rt.game.sites.filter(siteEntry => siteEntry.kind === 'city' && rt.areEnemies(siteEntry.owner, owner));
    const nearestEnemyCity = enemyCities.length ? enemyCities.sort((a, b) => dist(a, engineer) - dist(b, engineer))[0] : null;
    const hasTransport = rt.game.units.some(unitEntry => unitEntry.owner === owner && unitEntry.type === 'transport');
    const landFrontExists = rt.hasLandReachToEnemyCity(owner);
    const nearFront = (nearestEnemyCity && dist(engineer, nearestEnemyCity) <= 6) || rt.game.units.some(unitEntry => rt.areEnemies(unitEntry.owner, owner) && dist(unitEntry, engineer) <= 5);
    const safeEnough = rt.enemyThreat(owner, engineer.x, engineer.y) < typeMeta('engineer').hp * 0.6;
    const canAffordForwardBase = rt.game.goldByOwner[owner] >= CAMP_COST + typeMeta('swordsman').cost;
    const needsCamp = landFrontExists && !rt.getSite(engineer.x, engineer.y) && rt.campCount(owner) < MAX_CAMPS_PER_SIDE && canAffordForwardBase && nearFront && safeEnough && !rt.atUnitCap(owner, 'land');
    if (needsCamp && rt.canBuildCamp(engineer)) {
      return { kind: 'camp' };
    }
    if (!waterCells.length) {
      return null;
    }
    const ownedTransports = rt.game.units.filter(unitEntry => unitEntry.owner === owner && unitEntry.type === 'transport').length;
    const landWaiting = rt.game.units.some(unitEntry => unitEntry.owner === owner && typeMeta(unitEntry.type).domain === 'land' && unitEntry.type !== 'engineer' && !rt.landUnitCanReachForeignCity(unitEntry));
    const needFerry = !landFrontExists && enemyCities.length > 0 && landWaiting;
    if (needFerry && ownedTransports < 2 && rt.game.goldByOwner[owner] >= transportCost(['engineer']) && !rt.atUnitCap(owner, 'sea')) {
      const cargoTypes = chooseTransportCargo(owner, rt.game.goldByOwner[owner], true);
      // 没有 assaultSite 时这个 comparator 恒返回 0 —— 稳定排序下等于不排，
      // 于是 waterCells 保持 adjacent8 的原始邻居顺序。这是载荷性的。
      const cell = waterCells.sort((a, b) => (intent?.assaultSite ? dist(a, intent.assaultSite) - dist(b, intent.assaultSite) : 0))[0];
      if (cell) {
        return { kind: 'transport', cell, cargoTypes };
      }
    }
    const enemySea = rt.game.units.some(unitEntry => rt.areEnemies(unitEntry.owner, owner) && typeMeta(unitEntry.type).domain === 'sea');
    if (enemySea && rt.game.goldByOwner[owner] >= typeMeta('warship').cost) {
      return { kind: 'warship', cell: waterCells[0], cargoTypes: [] };
    }
    if ((teamNeedsEngineer(owner) || !hasTransport || intent?.assaultSite) && rt.game.goldByOwner[owner] >= transportCost(['engineer'])) {
      const cargoTypes = chooseTransportCargo(owner, rt.game.goldByOwner[owner], true);
      const cell = waterCells.sort((a, b) => (intent?.assaultSite ? dist(a, intent.assaultSite) - dist(b, intent.assaultSite) : 0))[0];
      if (cell) {
        return { kind: 'transport', cell, cargoTypes };
      }
    }
    return null;
  }

  return {
    forceCrowding, capacityPressure, autoLoadAdjacent, autoUnloadAdjacent,
    chooseAction, buildScore, aiSpendGold, aiManageForces,
    teamNeedsEngineer, chooseTransportCargo, engineerBuildChoice
  };
}
