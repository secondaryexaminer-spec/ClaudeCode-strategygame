'use strict';
// 世界布点：城市、油田、兵营、船坞、要塞的位置分配，以及开局部队部署。
//
// 与 world/mapgen.js 的分工：mapgen 决定「地形长什么样」（哪里是山、水、林），
// 这里决定「在这张地形上把东西放到哪」。前者是纯函数、显式传 W/H；后者要读
// game.sites / game.settings 和地形谓词，所以走 rt 门面（见 game/movement.js
// 顶部说明）。三个纯采样函数不需要 rt，直接顶层导出。
//
// ⚠️ 这一组是整局中最早、最密集的随机数消耗方，任何抽签次数的偏移都会污染
// 之后所有回合。以下几处「看起来能整理」的地方一个都不能动：
//
// 1. makeCities 里的 `Math.random() < 0.62 ? 1 : Math.random() < 0.84 ? 2 : 3`
//    —— 第一次掷点小于 0.62 时第二次根本不执行。改写成先算两个随机数再判断，
//    整条流立刻错位。
// 2. distributeCells 里 `clusterFactor * (0.5 + Math.random() * 0.4)` 这次抽签
//    照样发生，哪怕 clusterFactor 是 0（spread=0）。不能加提前 return。
// 3. distributeCells 内层循环里 `used.has(...) → continue` 位于抖动抽签之前，
//    所以已占用格会跳过一次抽样 —— 抽样次数依赖数据，不能预先展开。
// 4. shuffle 是 `[...items].sort(() => Math.random() - 0.5)`，比较器被调用多少次
//    由 V8 的排序实现决定。绝不能顺手换成 Fisher–Yates，也不能改变它的调用次数
//    或入参长度。（这个实现本身分布不均，是已知技术债，要换得单独一个提交并
//    重新生成基线。）
// 5. site() / unit() 各消耗一次随机数（内部的 randomId）。每多创建或少创建一个，
//    整体错位一次。
//
// 还有两处顺序耦合，同样是行为的一部分：
// - nearestCoastalWater 的 candidates 用曼哈顿距离排序，大量同分。V8 排序稳定，
//   胜者由插入顺序决定，而插入顺序 = homes 数组顺序 × y 外层 / x 内层扫描顺序。
//   调换 x/y 循环或改 ±8 的裁剪范围，选中的港口格就变了。
// - makeNavalSites 里 PORT_NAMES 和 FORT_NAMES 共用同一个递增的 sites.length，
//   所以要塞取名的下标是接着船坞往后数的（会跳号）。这是现有行为，不是 bug。
import { CITY_NAMES, CITY_INCOME_BY_TIER, OIL_NAMES, BARRACK_NAMES, PORT_NAMES, FORT_NAMES } from '../core/constants.js';
import { cellKey, rnd, clamp, dist, shuffle, siteMeta } from '../core/utils.js';
import { site, unit } from '../game/entities.js';

export function pickSpacedCells(pool, count, minGap) {
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

// 蓝噪声式均匀撒点：反复取「离所有已选点最远」的那一格。
export function farthestPointSample(pool, count, usedKeys) {
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

// 按「城池分布」滑杆撒点：0 = 完全均匀，100 = 尽量聚集在若干随机中心周围。
export function distributeCells(pool, count, spread) {
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

export function createWorldgen(rt) {
  // 直接比较字符串字面量、不走 isLandTile：双层循环本身已保证在界内，
  // 少一层 inBounds 调用（W×H 次）。两者结果等价。
  function collectLandCells() {
    const cells = [];
    for (let y = 0; y < rt.H; y++) {
      for (let x = 0; x < rt.W; x++) {
        if (rt.game.terrain[y][x] !== 'water' && rt.game.terrain[y][x] !== 'mountain') {
          cells.push({ x, y });
        }
      }
    }
    return cells;
  }

  function makeCities(aiCount, sizeKey, spread) {
    const cells = collectLandCells();
    const owners = ['player', ...Array.from({ length: aiCount }, (_, index) => `ai${index}`)];
    // 把各方老家撒开（按面积和参战方数量缩放），避免所有势力挤在同一个角落。
    let ownerGap = clamp(Math.round(Math.sqrt(2 * rt.W * rt.H / owners.length) * 0.72), 4, Math.floor((rt.W + rt.H) / 2));
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
    // 中立城市填满剩余名额；总数随地图尺寸和「据点密度」设置一起缩放。
    const density = rt.game.settings?.siteDensity ?? 1;
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

  // 注意：入口处从 game.sites 快照 used。因为 newGame 是「先城市 → 再海军 →
  // 再特殊」的顺序，所以这里能看到城市和船坞，而 makeNavalSites 只能看到城市。
  // 改成「一次性组装再赋值」会抹掉这个可见性差异。
  function makeSpecialSites() {
    const used = new Set(rt.game.sites.map(entry => cellKey(entry.x, entry.y)));
    const land = collectLandCells().filter(cell => !used.has(cellKey(cell.x, cell.y)));
    const density = rt.game.settings?.siteDensity ?? 1;
    const spread = rt.game.settings?.spread ?? 50;
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
      for (let y = Math.max(0, home.y - 8); y <= Math.min(rt.H - 1, home.y + 8); y++) {
        for (let x = Math.max(0, home.x - 8); x <= Math.min(rt.W - 1, home.x + 8); x++) {
          if (!used.has(cellKey(x, y)) && rt.isCoastalWater(x, y)) {
            candidates.push({ x, y, score: dist(home, { x, y }) });
          }
        }
      }
    }
    candidates.sort((a, b) => a.score - b.score);
    return candidates[0] || null;
  }

  function makeNavalSites() {
    const used = new Set(rt.game.sites.map(entry => cellKey(entry.x, entry.y)));
    const sites = [];
    for (const owner of rt.ownerOrder()) {
      const homes = rt.game.sites.filter(entry => entry.owner === owner && entry.kind === 'city');
      const cell = nearestCoastalWater(homes, used);
      if (!cell) {
        continue;
      }
      used.add(cellKey(cell.x, cell.y));
      sites.push(site('shipyard', owner, cell.x, cell.y, PORT_NAMES[sites.length % PORT_NAMES.length], Math.random() < 0.25 ? 2 : 1, 8 + rnd(3)));
    }
    const coastal = [];
    for (let y = 0; y < rt.H; y++) {
      for (let x = 0; x < rt.W; x++) {
        if (!used.has(cellKey(x, y)) && rt.isCoastalWater(x, y)) {
          coastal.push({ x, y });
        }
      }
    }
    const spread = rt.game.settings?.spread ?? 50;
    const density = rt.game.settings?.siteDensity ?? 1;
    for (const cell of distributeCells(coastal, clamp(Math.round(coastal.length / 60 * density), 1, 8), spread)) {
      used.add(cellKey(cell.x, cell.y));
      sites.push(site('shipyard', 'neutral', cell.x, cell.y, PORT_NAMES[sites.length % PORT_NAMES.length], 1, 7 + rnd(3)));
    }
    const deep = [];
    for (let y = 0; y < rt.H; y++) {
      for (let x = 0; x < rt.W; x++) {
        if (!used.has(cellKey(x, y)) && rt.isDeepWater(x, y)) {
          deep.push({ x, y });
        }
      }
    }
    for (const cell of distributeCells(deep, clamp(Math.round(deep.length / 90 * density), 0, 6), spread)) {
      sites.push(site('fortress', 'neutral', cell.x, cell.y, FORT_NAMES[sites.length % FORT_NAMES.length], 1, 5 + rnd(2)));
    }
    return sites;
  }

  // used 是调用方传进来的 Set，这里【原地修改】它 —— newGame 让各 owner 共享
  // 同一个 Set 来实现互相避让。改成「返回新 Set」会让各方开局叠在一起。
  function spawnLand(owner, homes, count, used, deploy) {
    const bag = ['militia', 'scout', 'spearman', 'swordsman', 'archer', 'crossbow', 'cavalry', 'guard'];
    const centerX = homes.reduce((sum, entry) => sum + entry.x, 0) / homes.length;
    const centerY = homes.reduce((sum, entry) => sum + entry.y, 0) / homes.length;
    const radius = deploy === 'tight' ? 3 : deploy === 'loose' ? 6 : deploy === 'veryLoose' ? 10 : Math.max(rt.W, rt.H);
    for (let i = 0; i < count; i++) {
      const cells = [];
      for (let y = 0; y < rt.H; y++) {
        for (let x = 0; x < rt.W; x++) {
          if (rt.isLandTile(x, y) && !used.has(cellKey(x, y)) && Math.hypot(x - centerX, y - centerY) <= radius) {
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
      rt.game.units.push(unit(bag[rnd(bag.length)], owner, pick.x, pick.y));
    }
  }

  // 刻意不把港口格加进 used：spawnLand 只挑陆地格，而港口在水上，今天不冲突。
  // 「顺手补上」会改变 spawnLand 的候选池与排序结果。
  function spawnSea(owner, count) {
    const ports = rt.game.sites.filter(entry => entry.owner === owner && entry.kind === 'shipyard');
    let spawned = 0;
    for (const port of ports) {
      if (spawned >= count || rt.getUnit(port.x, port.y)) {
        continue;
      }
      rt.game.units.push(unit(spawned === 0 ? 'warship' : 'transport', owner, port.x, port.y));
      spawned += 1;
    }
    return spawned;
  }

  return { collectLandCells, makeCities, makeSpecialSites, nearestCoastalWater, makeNavalSites, spawnLand, spawnSea };
}
