'use strict';
// AI 战略意图：定主攻方向、排单位优先级、选目标、决定撤退，以及前线记忆。
//
// 依赖注入方式见 game/movement.js 顶部对 rt 门面的说明。
//
// 分层位置：scoring 回答「这个格子/目标值多少分」，这里回答「这一方本回合想干
// 什么、每个单位该奔哪去」，decide 回答「具体走哪一格、打谁」。三层之间是单向
// 依赖：intent 用 scoring，decide 用 intent 和 scoring。
//
// 【前线记忆】
// game.aiFrontMemory 按 owner 存 { 'site:x,y': { stalls, cooldown } }。同一个方向
// 连续 3 回合推不动，就给它 3 回合冷却，这段时间内 buildStrategicIntent 和
// bestObjective 都会跳过它，逼迫大军改走别的路。这是 AI 不会在一处死磕的原因。
//
// 记忆存在 game 上（不是模块级），所以随存档一起保存、随 newGame 一起重置 ——
// 这是对的，不要"优化"成模块级 Map。
import { DIFF, AGG } from '../core/constants.js';
import { cellKey, dist, typeMeta } from '../core/utils.js';

export function createIntent(rt) {
  function frontMemory(owner) {
    if (!rt.game.aiFrontMemory[owner]) {
      rt.game.aiFrontMemory[owner] = {};
    }
    return rt.game.aiFrontMemory[owner];
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

  function logAiDecision(owner, text) {
    rt.log(`${rt.ownerName(owner)}部署：${text}`, 'system');
  }

  function bestSupport(owner, unitEntry) {
    const supports = rt.supportSites(unitEntry);
    supports.sort((a, b) => dist(a, unitEntry) - dist(b, unitEntry));
    return supports[0] || null;
  }

  // 残血单位往哪退：友军多、有林地掩护、离补给点近、远离受阻据点、威胁低。
  function bestRetreatCell(owner, unitEntry, blockedSite) {
    const supports = rt.supportSites(unitEntry);
    const home = supports.sort((a, b) => dist(a, unitEntry) - dist(b, unitEntry))[0] || null;
    const cells = [...rt.reachable(unitEntry).keys()].map(key => {
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
      const threat = rt.enemyThreat(owner, cell.x, cell.y);
      const support = rt.friendSupport(owner, cell.x, cell.y);
      const forest = rt.game.terrain[cell.y][cell.x] === 'forest' ? 8 : 0;
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

  // 若干回合内本方能对某个点投送多少火力。用于判断「这个目标围得下来吗」。
  function projectedPressure(owner, target, lookahead, excludeId = null) {
    let total = 0;
    for (const ally of rt.game.units.filter(unitEntry => unitEntry.owner === owner)) {
      if (ally.id === excludeId) {
        continue;
      }
      const reach = rt.futureReach(ally, lookahead);
      const distance = dist(ally, target);
      if (distance > reach + 2) {
        continue;
      }
      total += Math.max(0, (typeMeta(ally.type).atk + typeMeta(ally.type).level * 2 - Math.max(0, distance - reach) * 2) * (ally.hp / ally.maxHp));
    }
    return total;
  }

  // 每个 AI 回合开始时算一次，得出全军共享的战略意图。
  function buildStrategicIntent(owner, profile) {
    const diffCfg = DIFF[profile.diff];
    const memory = frontMemory(owner);
    const enemies = rt.game.units.filter(unitEntry => rt.areEnemies(unitEntry.owner, owner));
    const focusTarget = enemies
      .map(unitEntry => {
        const pressure = projectedPressure(owner, unitEntry, diffCfg.lookahead);
        return {
          unitEntry,
          score: rt.targetValue(unitEntry) + pressure * 1.5 + (pressure >= unitEntry.hp ? 16 : 0) + (unitEntry.type === 'transport' ? 8 : 0)
        };
      })
      .sort((a, b) => b.score - a.score)[0]?.unitEntry || null;
    const assaultRanked = rt.game.sites
      .filter(siteEntry => rt.strategicSiteValue(siteEntry, owner) > 0)
      .sort((a, b) => rt.siteProjectionValue(owner, b, diffCfg.lookahead) - rt.siteProjectionValue(owner, a, diffCfg.lookahead));
    const notCooled = siteEntry => !(memory[`site:${cellKey(siteEntry.x, siteEntry.y)}`]?.cooldown > 0);
    // 跳过已证明推不动的方向（前线记忆冷却），让大军去走还开着的那条路。
    const assaultSite = assaultRanked.find(notCooled) || assaultRanked[0] || null;
    const expansionRanked = rt.game.sites
      .filter(siteEntry => rt.cityEconomyValue(siteEntry, owner) > 0)
      .sort((a, b) => rt.cityEconomyValue(b, owner) - rt.cityEconomyValue(a, owner));
    const expansionSite = expansionRanked.find(notCooled) || expansionRanked[0] || assaultSite;
    const alternateSites = rt.game.sites
      .filter(siteEntry => rt.strategicSiteValue(siteEntry, owner) > 0)
      .sort((a, b) => rt.siteProjectionValue(owner, b, diffCfg.lookahead) - rt.siteProjectionValue(owner, a, diffCfg.lookahead))
      .slice(0, 4);
    const navalSite = rt.game.sites
      .filter(siteEntry => siteEntry.kind !== 'city' && rt.strategicSiteValue(siteEntry, owner) > 0)
      .sort((a, b) => rt.siteProjectionValue(owner, b, diffCfg.lookahead) - rt.siteProjectionValue(owner, a, diffCfg.lookahead))[0] || assaultSite;
    const cooledTargets = alternateSites.filter(siteEntry => memory[`site:${cellKey(siteEntry.x, siteEntry.y)}`]?.cooldown > 0).map(siteEntry => siteEntry.name);
    return { focusTarget, assaultSite, expansionSite, navalSite, alternateSites, cooledTargets };
  }

  function summarizeIntent(intent) {
    const assault = intent.assaultSite ? intent.assaultSite.name : '无';
    const expansion = intent.expansionSite ? intent.expansionSite.name : '无';
    const focus = intent.focusTarget ? typeMeta(intent.focusTarget.type).name : '无';
    return `主攻 ${assault}；扩张 ${expansion}；重点目标 ${focus}`;
  }

  // 决定单位的行动次序。离战略目标近的、级别高的先动 —— 让主力先占好位置，
  // 杂兵再来补空当。改这个函数会改变所有单位的行动顺序，进而改变一切。
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
    if (intent.assaultSite && rt.isBridgeheadSite(intent.assaultSite) && dist(unitEntry, intent.assaultSite) <= 3) {
      priority += 2;
    }
    return priority;
  }

  // 单个单位这回合奔哪个据点去。三重过滤：自己上回合在这撞墙了（rerouteTurns）、
  // 全军记忆里这个方向在冷却、以及价值本来就 ≤0。都没得选时，残血就回补给点。
  function bestObjective(owner, unitEntry, intent = null) {
    const defaultAgg = AGG[rt.game.aiProfiles?.[owner]?.agg || 'balanced'] || AGG.balanced;
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
      if (rt.strategicSiteValue(siteEntry, owner, unitEntry) <= 0) {
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
    // 意图给的几个目标都被过滤掉了，就退回全图扫一遍。
    if (candidates.length < 2) {
      rt.game.sites.forEach(consider);
    }
    if (!candidates.length) {
      return unitEntry.hp <= unitEntry.maxHp * defaultAgg.retreatHp ? bestSupport(owner, unitEntry) : null;
    }
    let best = null;
    let bestScore = -Infinity;
    for (const siteEntry of candidates) {
      const value = rt.strategicSiteValue(siteEntry, owner, unitEntry) + rt.cityEconomyValue(siteEntry, owner);
      const distance = dist(unitEntry, siteEntry);
      const crowd = rt.game.units.filter(entry => entry.owner === owner && entry.id !== unitEntry.id && dist(entry, siteEntry) <= 3).length;
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

  function computeUnitState(unitEntry) {
    const previous = unitEntry.aiState || { stalledTurns: 0, rerouteTurns: 0, failedObjectiveKey: null };
    return {
      ...previous,
      lastPosition: previous.lastPosition || { x: unitEntry.x, y: unitEntry.y }
    };
  }

  // 回合末更新该单位的卡顿记录，并回写前线记忆。
  function finalizeUnitState(unitEntry, state, objectiveKey, movedThisTurn) {
    const stalledTurns = movedThisTurn ? 0 : state.stalledTurns + 1;
    const rerouteTurns = movedThisTurn ? Math.max(0, state.rerouteTurns - 1) : stalledTurns >= 2 ? 2 : Math.max(0, state.rerouteTurns - 1);
    rememberFrontOutcome(unitEntry.owner, objectiveKey, movedThisTurn);
    if (!movedThisTurn && stalledTurns >= 2 && objectiveKey.startsWith('site:')) {
      const siteId = objectiveKey.slice(5);
      rt.incrementStrat(unitEntry.owner, 'stalls');
      logAiDecision(unitEntry.owner, `前线在 ${siteId} 方向受阻，准备改道或暂避。`);
    }
    unitEntry.aiState = {
      lastPosition: { x: unitEntry.x, y: unitEntry.y },
      stalledTurns,
      rerouteTurns,
      failedObjectiveKey: stalledTurns >= 2 ? objectiveKey : state.failedObjectiveKey
    };
  }

  return {
    frontMemory, decayFrontMemory, rememberFrontOutcome, logAiDecision,
    bestSupport, bestRetreatCell, projectedPressure,
    buildStrategicIntent, summarizeIntent, unitPriority, bestObjective,
    computeUnitState, finalizeUnitState
  };
}
