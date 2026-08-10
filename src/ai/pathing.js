'use strict';
// AI 寻路：距离场、接近目标、登陆点选择、陆路可达性。
//
// 依赖注入方式见 game/movement.js 顶部对 rt 门面的说明。
//
// 与 game/movement.js 的分工：movement 算「这一回合能走到哪」（受行动力限制，
// 每次都要重算）；这里算「朝目标的方向」（不受行动力限制，只看地形连通性，
// 因此可以缓存）。
//
// 【两个缓存的生命周期】
// distFieldCache —— 距离场只取决于地形和 domain，一局之内地形不变，所以整局
//   有效。由 newGame / loadPayload 负责清空。
// landReachCache —— 陆路能否够到敌城，取决于单位当前位置，所以只在一个 AI
//   回合内有效。由 aiTurn 在每次开始时清空。
//
// 这两个 Map 建在工厂闭包里而不是模块顶层，是刻意的：createPathing 每次调用
// 得到一套独立的缓存。但请注意它们【不会】随 game 对象被替换而自动失效 ——
// 清空完全靠外部显式调用 clearDistFieldCache / clearLandReachCache。漏掉任何
// 一处清空点，表现是 AI 拿着上一局的地图寻路，而且不报错。
import { cellKey, dist, diagonalDist, typeMeta } from '../core/utils.js';

export function createPathing(rt) {
  const distFieldCache = new Map();
  const landReachCache = new Map();

  // 与 movement.js 的 passable 不同：这里【不看】格子上有没有单位。
  // 距离场要的是「地形上能不能走通」，友军挡路是这一回合的事，不该进缓存。
  function strategicPassable(unitEntry, x, y) {
    if (!rt.inBounds(x, y)) {
      return false;
    }
    const domain = typeMeta(unitEntry.type).domain;
    if (domain === 'sea') {
      return rt.game.terrain[y][x] === 'water';
    }
    return rt.game.terrain[y][x] !== 'water' && rt.game.terrain[y][x] !== 'mountain';
  }

  function buildDistanceField(unitEntry, target) {
    if (!target) {
      return null;
    }
    if (!strategicPassable(unitEntry, target.x, target.y)) {
      return null;
    }
    // 距离场只取决于地形（一局之内固定）+ domain，所以按局缓存。
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
      for (const next of rt.adjacent8(current.x, current.y)) {
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

  // 若干回合后大致能覆盖多远，用于「值不值得现在动身」的判断。
  function futureReach(unitEntry, lookahead) {
    return typeMeta(unitEntry.type).range + unitEntry.move + Math.max(0, lookahead - 1) * Math.max(1, Math.floor(unitEntry.maxMove * 0.85));
  }

  function moveToward(unitEntry, target) {
    const distanceField = buildDistanceField(unitEntry, target);
    const cells = [...rt.reachable(unitEntry).keys()].map(key => {
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
    return rt.moveUnit(unitEntry, cells[0].x, cells[0].y);
  }

  // 运兵船朝登陆点推进，但会重度规避敌方攻击范围 —— 除非旁边有战舰护航。
  function moveTransportToward(transport, target) {
    const owner = transport.owner;
    const distanceField = buildDistanceField(transport, target);
    const current = { x: transport.x, y: transport.y };
    const currentDist = distanceField?.get(cellKey(current.x, current.y)) ?? dist(current, target);
    const cells = [...rt.reachable(transport).keys()].map(key => {
      const [x, y] = key.split(',').map(Number);
      return { x, y };
    });
    cells.push(current);
    let best = current;
    let bestScore = -Infinity;
    for (const cell of cells) {
      const cellDist = distanceField?.get(cellKey(cell.x, cell.y)) ?? dist(cell, target);
      const progress = currentDist - cellDist;
      const threat = rt.enemyThreat(owner, cell.x, cell.y);
      const escorted = rt.game.units.some(entry => entry.owner === owner && entry.type === 'warship' && diagonalDist(entry, cell) <= 1);
      const score = progress * 3 - threat * (escorted ? 0.4 : 2.4);
      if (score > bestScore) {
        bestScore = score;
        best = cell;
      }
    }
    if (best.x !== transport.x || best.y !== transport.y) {
      return rt.moveUnit(transport, best.x, best.y);
    }
    return false;
  }

  // 扫描全图找最佳登陆滩头。同分时靠离运兵船的距离决胜；扫描顺序（y 外 x 内）
  // 也参与决定同分同距时的胜者，是行为的一部分。
  function bestLanding(owner, transport) {
    const cells = [];
    for (let y = 0; y < rt.H; y++) {
      for (let x = 0; x < rt.W; x++) {
        if (rt.isLandTile(x, y) && rt.adjacent8(x, y).some(cell => rt.isWaterTile(cell.x, cell.y))) {
          cells.push({ x, y, score: rt.strategicLandingScore(owner, { x, y }) });
        }
      }
    }
    cells.sort((a, b) => b.score - a.score || dist(transport, a) - dist(transport, b));
    return cells[0] || null;
  }

  // 该单位能否纯靠陆路走到某座敌城（洪水填充，不看行动力）。
  function landUnitCanReachForeignCity(unitEntry) {
    if (typeMeta(unitEntry.type).domain !== 'land') {
      return false;
    }
    const seen = new Set([cellKey(unitEntry.x, unitEntry.y)]);
    const queue = [{ x: unitEntry.x, y: unitEntry.y }];
    while (queue.length) {
      const current = queue.shift();
      const siteEntry = rt.getSite(current.x, current.y);
      if (siteEntry?.kind === 'city' && !rt.areAllies(siteEntry.owner, unitEntry.owner)) {
        return true;
      }
      for (const next of rt.adjacent8(current.x, current.y)) {
        if (!rt.isLandTile(next.x, next.y)) {
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

  // 按 AI 回合记忆化：该方是否有任何陆军能走到敌城（上面那个洪水填充很贵）。
  function hasLandReachToEnemyCity(owner) {
    const cached = landReachCache.get(owner);
    if (cached !== undefined) {
      return cached;
    }
    const result = rt.game.units.some(unitEntry => unitEntry.owner === owner && typeMeta(unitEntry.type).domain === 'land' && landUnitCanReachForeignCity(unitEntry));
    landReachCache.set(owner, result);
    return result;
  }

  function clearDistFieldCache() {
    distFieldCache.clear();
  }

  function clearLandReachCache() {
    landReachCache.clear();
  }

  return {
    strategicPassable, buildDistanceField, futureReach,
    moveToward, moveTransportToward, bestLanding,
    landUnitCanReachForeignCity, hasLandReachToEnemyCity,
    clearDistFieldCache, clearLandReachCache
  };
}
