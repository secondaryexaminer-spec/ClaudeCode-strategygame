'use strict';
// 移动规则：地形代价、可通行判定、可达范围。
//
// 与 core/grid.js、world/mapgen.js 不同，这批函数必须读运行时状态（当前地形、
// 场上单位），没法做成纯函数。这里用依赖注入解决：main.js 传进来一个 runtime
// 门面 rt，模块只从 rt 上读，自己一个字节的状态都不存。
//
// 关键点：rt.game 是 getter，不是快照。每次访问都会读到 main.js 里最新的 game
// 引用，所以「开新局把 game 整个换掉」这件事不需要重新 wiring，也不会出现
// 模块拿着旧 game 的悬空引用 —— 这是这套方案相对「全局状态单例」的核心优势：
// 只有一处真相，不存在需要手动同步的第二份状态。
import { TERRAIN } from '../core/constants.js';
import { cellKey, typeMeta } from '../core/utils.js';

export function createMovement(rt) {
  function movementCost(unitEntry, x, y) {
    return typeMeta(unitEntry.type).domain === 'sea' ? 1 : TERRAIN[rt.game.terrain[y][x]].cost;
  }

  function passable(unitEntry, x, y) {
    if (!rt.inBounds(x, y) || rt.getUnit(x, y)) {
      return false;
    }
    const domain = typeMeta(unitEntry.type).domain;
    if (domain === 'sea') {
      return rt.game.terrain[y][x] === 'water';
    }
    return rt.game.terrain[y][x] !== 'water' && rt.game.terrain[y][x] !== 'mountain';
  }

  function movementNeighbors(unitEntry, currentCost, x, y) {
    // 8 向移动，与攻击判定、可达范围所用的对角（切比雪夫）邻接保持一致。
    return rt.adjacent8(x, y);
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
        // 对角一步代价约 √2，这样可达范围是圆的（八边形）而不是方的。
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

  return { movementCost, passable, movementNeighbors, reachable };
}
