'use strict';
// 建造与单位经济：造兵、升级据点、修理驻军、工程师作业、变卖单位、兵力上限。
//
// 依赖注入方式见 game/movement.js 顶部对 rt 门面的说明。
//
// 这个模块对 DOM 是干净的 —— 一次都没调过 toast / refresh / $()。所有 UI 反馈
// 都由调用方负责（setup 里的按钮 handler、aiTurn）。搬移时刻意没有把它们收进来：
// 那会让 AI 路径平白多出重绘，也会让无头模拟多走一遍打桩 DOM。
//
// ⚠️ 三条不能"顺手改善"的地方，改了行为基线立刻红：
//
// 1. 先校验、后构造。unit() / createCamp() 各消耗一次随机数，把构造提到校验
//    之前（哪怕只是为了可读性），失败路径就会多消耗一次抽签，整条随机数流错位。
//
// 2. terrainCellCounts 的缓存挂在 game 对象上，不是模块级变量。newGame 换掉
//    game 时缓存自动失效 —— 这正是它要的。改成模块级 Map 的话，fastBatch 连跑
//    10 局时第 2 局起会读到上一局的地图格数，兵力上限全错。
//
// 3. canBuildCamp / canEngineerLaunch 判的是 unitEntry.owner === game.side，
//    而不像 buildAtSite 那样接受显式 owner。签名不一致看着别扭，但 AI 能走通
//    只是因为它只在自己回合行动。统一成显式 owner 会放开一条现在被挡住的路径。
import { TYPES, CAMP_COST, CAMP_DURATION, MAX_CAMPS_PER_SIDE } from '../core/constants.js';
import { diagonalDist, siteMeta, typeMeta } from '../core/utils.js';
import { unit, createLoadedTransport, createCamp, transportCost, normalizeCargoTypes, describeCargo } from './entities.js';

export function createBuild(rt) {
  function terrainCellCounts() {
    if (rt.game.__cellCounts) {
      return rt.game.__cellCounts;
    }
    let land = 0;
    let sea = 0;
    for (let y = 0; y < rt.H; y++) {
      for (let x = 0; x < rt.W; x++) {
        if (rt.game.terrain[y][x] === 'water') {
          sea += 1;
        } else if (rt.game.terrain[y][x] !== 'mountain') {
          land += 1;
        }
      }
    }
    rt.game.__cellCounts = { land, sea };
    return rt.game.__cellCounts;
  }

  function unitCapFor(domain) {
    const counts = terrainCellCounts();
    const participants = Math.max(1, rt.game.ownerOrder.length);
    const cells = domain === 'sea' ? counts.sea : counts.land;
    return Math.max(1, Math.floor(cells / (participants + 1)));
  }

  function ownedUnitCount(owner, domain) {
    return rt.game.units.filter(entry => entry.owner === owner && typeMeta(entry.type).domain === domain).length;
  }

  function atUnitCap(owner, domain) {
    return ownedUnitCount(owner, domain) >= unitCapFor(domain);
  }

  function campCount(owner) {
    return rt.game.sites.filter(entry => entry.kind === 'camp' && entry.owner === owner).length;
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
    if (!unitEntry || unitEntry.owner !== owner || rt.game.side !== owner || rt.game.over) {
      return false;
    }
    const refund = sellRefund(unitEntry);
    rt.game.goldByOwner[owner] += refund;
    rt.game.units = rt.game.units.filter(entry => entry !== unitEntry);
    rt.incrementStrat(owner, 'sells');
    if (rt.game.selected?.ref === unitEntry) {
      rt.game.selected = null;
    }
    rt.log(`${rt.ownerName(owner)}变卖了${typeMeta(unitEntry.type).name}，回收 ${refund} 🪙。`, 'gold');
    return true;
  }

  // 返回顺序 = TYPES 的字面量声明顺序。AI 在 aiSpendGold 里对候选做稳定排序，
  // 同分时靠生成顺序决胜 —— 所以这个顺序是行为的一部分，别换成 Set / entries。
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
    return (rt.game.settings?.buildCap ?? 100) - (rt.game.buildsThisTurn?.[owner] || 0);
  }

  function recordBuild(owner, count) {
    rt.game.buildsThisTurn = rt.game.buildsThisTurn || {};
    rt.game.buildsThisTurn[owner] = (rt.game.buildsThisTurn[owner] || 0) + count;
  }

  function buildAtSite(owner, siteEntry, type, options = {}) {
    const cargoTypes = type === 'transport' ? normalizeCargoTypes(options.cargoTypes) : [];
    const totalCost = type === 'transport' ? transportCost(cargoTypes) : typeMeta(type).cost;
    const builtUnits = type === 'transport' ? 1 + cargoTypes.length : 1;
    if (!siteEntry || siteEntry.owner !== owner || !buildableTypes(siteEntry).includes(type) || rt.getUnit(siteEntry.x, siteEntry.y) || rt.game.goldByOwner[owner] < totalCost) {
      return false;
    }
    if (atUnitCap(owner, typeMeta(type).domain) || buildBudgetLeft(owner) < builtUnits) {
      return false;
    }
    recordBuild(owner, builtUnits);
    rt.game.goldByOwner[owner] -= totalCost;
    if (type === 'transport') {
      rt.game.units.push(createLoadedTransport(owner, siteEntry.x, siteEntry.y, cargoTypes));
      rt.log(`${rt.ownerName(owner)}在${siteEntry.name}下水了运兵船，预载 ${describeCargo(cargoTypes)}。`, 'system');
      rt.incrementStat('produced', owner, 1 + cargoTypes.length);
    } else {
      rt.game.units.push(unit(type, owner, siteEntry.x, siteEntry.y));
      rt.log(`${rt.ownerName(owner)}在${siteEntry.name}部署了${typeMeta(type).name}。`, 'system');
      rt.incrementStat('produced', owner, 1);
    }
    rt.recordStatSnapshot('build');
    return true;
  }

  function upgradeSite(owner, siteEntry) {
    const cost = siteUpgradeCost(siteEntry);
    if (!siteEntry || siteEntry.owner !== owner || siteEntry.tier >= siteMeta(siteEntry.kind).maxTier || rt.game.goldByOwner[owner] < cost) {
      return false;
    }
    rt.game.goldByOwner[owner] -= cost;
    siteEntry.tier += 1;
    siteEntry.income += siteEntry.kind === 'city' ? 3 : 2;
    rt.log(`${siteEntry.name}升级为${rt.tierName(siteEntry.tier)}${siteMeta(siteEntry.kind).name}。`, 'system');
    return true;
  }

  function fullHealSite(owner, siteEntry) {
    const occupant = rt.getUnit(siteEntry.x, siteEntry.y);
    const cost = siteEntry.kind === 'city' || siteEntry.kind === 'camp' ? 5 : siteEntry.kind === 'shipyard' ? 6 : 7;
    if (!siteEntry || siteEntry.owner !== owner || !occupant || occupant.owner !== owner || rt.game.goldByOwner[owner] < cost) {
      return false;
    }
    rt.game.goldByOwner[owner] -= cost;
    occupant.hp = occupant.maxHp;
    rt.log(`${siteEntry.name}花费${cost}金币完成驻军修整。`, 'gold');
    return true;
  }

  // 名字里的 ai 有点误导：这是回合开始时的自动修理，不是 AI 专属决策。
  function aiRepair(owner) {
    for (const siteEntry of rt.game.sites.filter(entry => entry.owner === owner)) {
      const occupant = rt.getUnit(siteEntry.x, siteEntry.y);
      if (!occupant || occupant.owner !== owner || occupant.hp >= occupant.maxHp) {
        continue;
      }
      const cost = siteEntry.kind === 'city' || siteEntry.kind === 'camp' ? 5 : siteEntry.kind === 'shipyard' ? 6 : 7;
      if (occupant.hp <= occupant.maxHp * 0.45 && rt.game.goldByOwner[owner] >= cost) {
        rt.game.goldByOwner[owner] -= cost;
        occupant.hp = occupant.maxHp;
        rt.log(`${rt.ownerName(owner)}在${siteEntry.name}完成驻军修整。`, 'system');
      }
    }
  }

  function consumeAction(unitEntry) {
    unitEntry.move = 0;
    unitEntry.acted = true;
    unitEntry.hasAttacked = true;
  }

  // 返回顺序 = adjacent8 的邻居顺序，调用方（engineerBuildChoice）会直接取
  // 第一个，所以这个顺序也是载荷性的 —— 必须走 rt.adjacent8，别另写一份邻接。
  function engineerBuildCells(unitEntry) {
    return rt.adjacent8(unitEntry.x, unitEntry.y).filter(cell => rt.isWaterTile(cell.x, cell.y) && !rt.getUnit(cell.x, cell.y));
  }

  function canBuildCamp(unitEntry) {
    return !!unitEntry && unitEntry.type === 'engineer' && unitEntry.owner === rt.game.side && !unitEntry.acted && rt.isLandTile(unitEntry.x, unitEntry.y) && !rt.getSite(unitEntry.x, unitEntry.y) && rt.game.goldByOwner[unitEntry.owner] >= CAMP_COST && campCount(unitEntry.owner) < MAX_CAMPS_PER_SIDE;
  }

  function canEngineerLaunch(unitEntry, type, cell, cargoTypes = []) {
    const totalCost = type === 'transport' ? transportCost(cargoTypes) : typeMeta(type).cost;
    return !!unitEntry && unitEntry.type === 'engineer' && unitEntry.owner === rt.game.side && !unitEntry.acted && !!cell && diagonalDist(unitEntry, cell) === 1 && rt.isWaterTile(cell.x, cell.y) && !rt.getUnit(cell.x, cell.y) && rt.game.goldByOwner[unitEntry.owner] >= totalCost;
  }

  function buildCamp(unitEntry) {
    if (!canBuildCamp(unitEntry) || campCount(unitEntry.owner) >= MAX_CAMPS_PER_SIDE) {
      return false;
    }
    rt.game.goldByOwner[unitEntry.owner] -= CAMP_COST;
    rt.game.sites.push(createCamp(unitEntry.owner, unitEntry.x, unitEntry.y));
    consumeAction(unitEntry);
    rt.clearPendingOrder();
    rt.incrementStat('captures', unitEntry.owner, 1);
    rt.incrementStrat(unitEntry.owner, 'campsBuilt');
    rt.recordStatSnapshot('camp');
    rt.log(`${rt.ownerName(unitEntry.owner)}的工程师建立了临时营地，可维持 ${CAMP_DURATION} 回合。`, 'system');
    return true;
  }

  // 注意与 buildAtSite 的不对称：这里的 cargoTypes 没有先归一化就拿来算长度，
  // 而 transportCost 内部会归一化。今天不出问题是因为两个调用方传进来的都已经
  // 干净（UI 已 normalize，AI 走固定 plan）。合并成公共 helper 会静默改掉预算
  // 扣减与统计口径 —— 要动得单独验一遍基线。
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
    rt.game.goldByOwner[unitEntry.owner] -= totalCost;
    rt.game.units.push(type === 'transport' ? createLoadedTransport(unitEntry.owner, cell.x, cell.y, cargoTypes) : unit(type, unitEntry.owner, cell.x, cell.y));
    consumeAction(unitEntry);
    rt.clearPendingOrder();
    rt.incrementStat('produced', unitEntry.owner, type === 'transport' ? 1 + cargoTypes.length : 1);
    if (type === 'transport') {
      rt.incrementStrat(unitEntry.owner, 'transportLaunches');
    }
    rt.recordStatSnapshot('engineer-build');
    rt.log(`${rt.ownerName(unitEntry.owner)}的工程师在海边建造了${type === 'transport' ? `运兵船（${describeCargo(cargoTypes)}）` : typeMeta(type).name}。`, 'system');
    return true;
  }

  return {
    terrainCellCounts, unitCapFor, ownedUnitCount, atUnitCap, campCount,
    unitBuildCost, sellRefund, sellUnit,
    buildableTypes, siteUpgradeCost, buildBudgetLeft, recordBuild, buildAtSite,
    upgradeSite, fullHealSite, aiRepair, consumeAction, engineerBuildCells,
    canBuildCamp, canEngineerLaunch, buildCamp, engineerLaunch
  };
}
