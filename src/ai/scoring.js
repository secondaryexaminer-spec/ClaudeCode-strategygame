'use strict';
// AI 评分：给格子、目标、据点打分，供决策层排序用。
//
// 依赖注入方式见 game/movement.js 顶部对 rt 门面的说明。
//
// 这一组的共同特征是「读 game + 算分，不改任何东西」。它们是 AI 里最容易验证
// 的部分：同样的局面必然给出同样的分数，没有随机、没有副作用、没有缓存。
// AI 表现不对时，从这里开始查最省力。
//
// ⚠️ 分数的绝对值没有意义，只有相对大小有意义 —— 调用方一律是
// `candidates.sort((a, b) => score(b) - score(a))` 然后取第一个。所以：
// 改动任何一个系数都会改变 AI 行为，哪怕只是把 0.35 写成 0.350000001；
// 而同分时的胜者由数组的原始顺序决定（V8 排序稳定），所以这些函数被调用的
// 顺序、以及候选数组的构造顺序，同样是行为的一部分。
import { dist, diagonalDist, typeMeta } from '../core/utils.js';

export function createScoring(rt) {
  // 据点的战略价值：占下它值多少。已经是自己或盟友的据点一律 0 分。
  function strategicSiteValue(siteEntry, owner, unitEntry) {
    if (siteEntry.owner === owner || rt.areAllies(siteEntry.owner, owner)) {
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

  // 桥头堡地形：通路 ≤2 的据点。这种地方一夫当关，值得专门派兵堵。
  function isBridgeheadSite(siteEntry) {
    if (!siteEntry) {
      return false;
    }
    const passableNeighbors = rt.adjacent4(siteEntry.x, siteEntry.y).filter(cell => {
      if (rt.game.terrain[siteEntry.y][siteEntry.x] === 'water') {
        return rt.isWaterTile(cell.x, cell.y);
      }
      return rt.isLandTile(cell.x, cell.y);
    });
    return passableNeighbors.length <= 2;
  }

  function frontlineCount(owner, target, radius = 3) {
    if (!target) {
      return 0;
    }
    return rt.game.units.filter(unitEntry => unitEntry.owner === owner && dist(unitEntry, target) <= radius).length;
  }

  // 把「据点价值」和「我离它多远」合成一个前瞻分：远的据点即使值钱也先不惦记。
  function siteProjectionValue(owner, siteEntry, lookahead) {
    const relevantUnits = rt.game.units.filter(unitEntry => unitEntry.owner === owner && (siteEntry.kind === 'city' ? typeMeta(unitEntry.type).domain === 'land' : true));
    const nearest = relevantUnits.length ? Math.min(...relevantUnits.map(unitEntry => dist(unitEntry, siteEntry))) : Math.max(rt.W, rt.H);
    return strategicSiteValue(siteEntry, owner) + Math.max(0, lookahead * 8 - nearest);
  }

  // 站在 (x,y) 会挨多少打。射程内的敌人权重更高（1.2 vs 0.55）。
  function enemyThreat(owner, x, y) {
    let score = 0;
    for (const enemy of rt.game.units.filter(entry => rt.areEnemies(entry.owner, owner))) {
      const reach = enemy.move + typeMeta(enemy.type).range;
      const d = dist(enemy, { x, y });
      if (d <= reach + 1) {
        score += typeMeta(enemy.type).atk * (enemy.hp / enemy.maxHp) * (d <= typeMeta(enemy.type).range ? 1.2 : 0.55);
      }
    }
    const siteEntry = rt.getSite(x, y);
    if (siteEntry && rt.areAllies(siteEntry.owner, owner)) {
      score *= 0.82;
    }
    return score;
  }

  function friendSupport(owner, x, y) {
    return rt.game.units.filter(entry => rt.areAllies(entry.owner, owner) && dist(entry, { x, y }) <= 3).length * 1.4;
  }

  // 己方单位挤在一起的惩罚。同格 1.6、相邻 0.65 —— 注意同格是可能的（卸载叠放）。
  function allyCongestion(owner, cell, excludeId = null) {
    let total = 0;
    for (const ally of rt.game.units) {
      if (ally.owner !== owner || ally.id === excludeId) {
        continue;
      }
      if (diagonalDist(ally, cell) <= 1) {
        total += diagonalDist(ally, cell) === 0 ? 1.6 : 0.65;
      }
    }
    return total;
  }

  // 经济价值。earlyTurnBonus 让 AI 前 10 回合优先扩张而不是死磕战线。
  function cityEconomyValue(siteEntry, owner) {
    if (rt.areAllies(siteEntry.owner, owner)) {
      return 0;
    }
    const earlyTurnBonus = Math.max(0, 10 - rt.game.turn) * 1.8;
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

  function targetValue(unitEntry) {
    return typeMeta(unitEntry.type).level * 8 + unitEntry.hp * 0.4 + (unitEntry.type === 'engineer' ? 14 : 0);
  }

  function nearbyEnemies(cell, owner, radius = 1) {
    return rt.game.units.filter(unitEntry => rt.areEnemies(unitEntry.owner, owner) && dist(unitEntry, cell) <= radius).length;
  }

  // 兵种性格：同一个格子对弓箭手和骑兵的价值完全不同。
  // 这是 AI 战术层次感的主要来源，改这里等于改所有兵种的走位偏好。
  function unitRoleCellBonus(owner, unitEntry, cell, intent) {
    const type = unitEntry.type;
    const siteEntry = rt.getSite(cell.x, cell.y);
    const coastal = rt.adjacent8(cell.x, cell.y).some(next => rt.isWaterTile(next.x, next.y));
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
      score += rt.game.terrain[cell.y][cell.x] === 'forest' ? 6 : 0;
      score -= nearbyEnemies(cell, owner, 1) * 8;
      score += friendSupport(owner, cell.x, cell.y) * 0.3;
    }
    if (type === 'cavalry') {
      score += intent?.focusTarget ? Math.max(0, 5 - diagonalDist(cell, intent.focusTarget)) * 1.2 : 0;
      score -= rt.game.terrain[cell.y][cell.x] === 'forest' ? 3 : 0;
    }
    if (type === 'guard') {
      score += siteEntry && rt.areAllies(siteEntry.owner, owner) && (siteEntry.kind === 'city' || siteEntry.kind.startsWith('barracks')) ? 8 : 0;
    }
    if (type === 'warship') {
      score += siteEntry?.kind === 'shipyard' && !rt.areAllies(siteEntry.owner, owner) ? 10 : 0;
      const escort = rt.game.units.find(entry => entry.owner === owner && entry.type === 'transport' && entry.cargo?.length && dist(entry, cell) <= 3);
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

  // 兵种克制：该打谁。与 combat.js 的 matchupBonus 是两回事 —— 那个是实际伤害
  // 加成（规则），这个是 AI 的目标偏好（策略）。两者可以不一致。
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
      const guardingTransport = rt.game.units.some(entry => entry.owner === unitEntry.owner && entry.type === 'transport' && entry.cargo?.length && dist(entry, enemy) <= 3);
      if (guardingTransport) {
        score += 9;
      }
    }
    if (unitEntry.type === 'guard' && intent?.assaultSite && dist(enemy, intent.assaultSite) <= 2) {
      score += 4;
    }
    return score;
  }

  // 往哪片海滩卸载。优先敌人稀薄的地方，别一头撞进防线。
  function strategicLandingScore(owner, cell) {
    let score = 0;
    for (const siteEntry of rt.game.sites) {
      if (rt.areEnemies(siteEntry.owner, owner) && (siteEntry.kind === 'city' || siteEntry.kind.startsWith('oil'))) {
        score += 18 / (1 + dist(siteEntry, cell));
      }
    }
    score -= nearbyEnemies(cell, owner, 2) * 8;
    score -= nearbyEnemies(cell, owner, 4) * 3;
    return score;
  }

  return {
    strategicSiteValue, isBridgeheadSite, frontlineCount, siteProjectionValue,
    enemyThreat, friendSupport, allyCongestion, cityEconomyValue,
    targetValue, nearbyEnemies, unitRoleCellBonus, unitRoleTargetBonus,
    strategicLandingScore
  };
}
