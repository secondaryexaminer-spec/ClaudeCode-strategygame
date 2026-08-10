'use strict';
// 脚本对手：两套行为固定、不做通用决策的测试 AI。
//
// 依赖注入方式见 game/movement.js 顶部对 rt 门面的说明。
//
// 这两个不是给玩家用的难度档，是【测试装置】—— 对应 DIFF 里 scripted: true 的
// bridgehead / naval 两项。它们的价值在于行为可预测：正规 AI 一改参数，所有
// 场景的结果都会变；而脚本对手永远做同一件事，于是可以拿来定向测试特定机制。
//
// sim/scenarios.js 里的 scripted-bridgehead / scripted-naval 两个回归场景就靠
// 它们覆盖「登陆突破桥头堡」和「制海线争夺」这两条路径。改动这个文件等于改动
// 那两个场景的对照组，基线必红 —— 所以除非确实要改测试装置本身，否则别动。
//
// 两者共同的套路：把地图按 BRIDGEHEAD_DEFEND_FRACTION 横向切开，死守上方、
// 故意给下方留口，逼迫被测方去尝试登陆/突破。
import { BRIDGEHEAD_DEFEND_FRACTION } from '../core/constants.js';
import { dist, typeMeta } from '../core/utils.js';

export function createScripted(rt) {
  // ── 桥头测试 AI：死守上方 3/4 ────────────────────────────────────

  function bridgeheadTryAttack(owner, unitEntry) {
    if (unitEntry.hasAttacked) {
      return false;
    }
    const targets = rt.game.units.filter(entry => rt.canAttack(unitEntry, entry));
    if (!targets.length) {
      return false;
    }
    // 先打残血的，同血量时打高级兵种。
    targets.sort((a, b) => (a.hp - b.hp) || (typeMeta(b.type).level - typeMeta(a.type).level));
    rt.attack(unitEntry, targets[0]);
    return true;
  }

  function bridgeheadDefendCell(owner, unitEntry) {
    const midY = Math.floor(rt.H * BRIDGEHEAD_DEFEND_FRACTION);
    const enemies = rt.game.units.filter(entry => rt.areEnemies(entry.owner, owner));
    const upperEnemies = enemies.filter(entry => entry.y < midY);
    const focus = (upperEnemies.length ? upperEnemies : enemies).sort((a, b) => dist(a, unitEntry) - dist(b, unitEntry))[0];
    const cells = [...rt.reachable(unitEntry).keys()].map(key => {
      const [x, y] = key.split(',').map(Number);
      return { x, y };
    });
    cells.push({ x: unitEntry.x, y: unitEntry.y });
    const zoneCells = cells.filter(cell => cell.y < midY);
    const pool = zoneCells.length ? zoneCells : cells;
    if (!focus) {
      const anchorX = Math.floor(rt.W / 2);
      pool.sort((a, b) => Math.abs(a.x - anchorX) - Math.abs(b.x - anchorX) || a.y - b.y);
      return pool[0];
    }
    pool.sort((a, b) => dist(a, focus) - dist(b, focus) || a.y - b.y);
    return pool[0];
  }

  function bridgeheadProduce(owner) {
    const prefer = ['guard', 'spearman', 'crossbow', 'archer', 'swordsman', 'militia'];
    let built = 0;
    for (const siteEntry of rt.game.sites.filter(entry => entry.owner === owner && !rt.getUnit(entry.x, entry.y))) {
      if (built >= 2) {
        break;
      }
      const types = rt.buildableTypes(siteEntry);
      const landChoice = prefer.find(type => types.includes(type) && rt.game.goldByOwner[owner] >= typeMeta(type).cost);
      const choice = landChoice || (types.includes('warship') && rt.game.goldByOwner[owner] >= typeMeta('warship').cost ? 'warship' : null);
      if (choice && rt.buildAtSite(owner, siteEntry, choice)) {
        built += 1;
      }
    }
  }

  async function bridgeheadTurn(owner) {
    rt.logAiDecision(owner, '桥头测试AI：死守上方 3/4，仅留最下 1/4 不设防。');
    bridgeheadProduce(owner);
    rt.refresh();
    await rt.pause(rt.aiStepDelay());
    const units = rt.game.units.filter(entry => entry.owner === owner);
    // 遍历副本，并在每步检查单位是否还活着 —— 反击可能在循环中途干掉它。
    for (const unitEntry of [...units]) {
      if (!rt.game.units.includes(unitEntry)) {
        continue;
      }
      if (!bridgeheadTryAttack(owner, unitEntry)) {
        const dest = bridgeheadDefendCell(owner, unitEntry);
        if (dest && (dest.x !== unitEntry.x || dest.y !== unitEntry.y)) {
          rt.moveUnit(unitEntry, dest.x, dest.y);
        }
        bridgeheadTryAttack(owner, unitEntry);
      }
      rt.refresh();
      await rt.pause(rt.aiStepDelay());
    }
    if (!rt.game.over) {
      rt.advanceTurn();
    }
  }

  // ── 海防测试 AI：制海守上方水道、专打运兵船，下方海道留口 ──────────

  function navalTryAttack(owner, unitEntry) {
    if (unitEntry.hasAttacked) {
      return false;
    }
    const targets = rt.game.units.filter(entry => rt.canAttack(unitEntry, entry));
    if (!targets.length) {
      return false;
    }
    // 与桥头 AI 的区别就在这个优先级：运兵船 > 战舰 > 其他。
    const priority = entry => (entry.type === 'transport' ? 2 : entry.type === 'warship' ? 1 : 0);
    targets.sort((a, b) => priority(b) - priority(a) || (a.hp - b.hp));
    rt.attack(unitEntry, targets[0]);
    return true;
  }

  function navalPatrolCell(owner, warship) {
    const line = Math.floor(rt.H * BRIDGEHEAD_DEFEND_FRACTION);
    const enemies = rt.game.units.filter(entry => rt.areEnemies(entry.owner, owner));
    const seaFocus = enemies.filter(entry => (typeMeta(entry.type).domain === 'sea' || entry.type === 'transport') && entry.y < line);
    const focus = (seaFocus.length ? seaFocus : enemies).sort((a, b) => dist(a, warship) - dist(b, warship))[0];
    const cells = [...rt.reachable(warship).keys()].map(key => {
      const [x, y] = key.split(',').map(Number);
      return { x, y };
    });
    cells.push({ x: warship.x, y: warship.y });
    const zone = cells.filter(cell => cell.y < line);
    const pool = zone.length ? zone : cells;
    if (!focus) {
      const anchorX = Math.floor(rt.W / 2);
      pool.sort((a, b) => Math.abs(a.x - anchorX) - Math.abs(b.x - anchorX) || a.y - b.y);
      return pool[0];
    }
    pool.sort((a, b) => dist(a, focus) - dist(b, focus) || a.y - b.y);
    return pool[0];
  }

  function navalLandHoldCell(owner, unitEntry) {
    const homes = rt.game.sites.filter(entry => entry.owner === owner && (entry.kind === 'city' || entry.kind.startsWith('barracks')));
    const cells = [...rt.reachable(unitEntry).keys()].map(key => {
      const [x, y] = key.split(',').map(Number);
      return { x, y };
    });
    cells.push({ x: unitEntry.x, y: unitEntry.y });
    const nearEnemy = rt.game.units.filter(entry => rt.areEnemies(entry.owner, owner) && typeMeta(entry.type).domain === 'land').sort((a, b) => dist(a, unitEntry) - dist(b, unitEntry))[0];
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
    for (const siteEntry of rt.game.sites.filter(entry => entry.owner === owner && entry.kind === 'shipyard' && !rt.getUnit(entry.x, entry.y))) {
      if (built >= 2) {
        break;
      }
      if (rt.buildableTypes(siteEntry).includes('warship') && rt.game.goldByOwner[owner] >= typeMeta('warship').cost && rt.buildAtSite(owner, siteEntry, 'warship')) {
        built += 1;
      }
    }
    const prefer = ['guard', 'spearman', 'crossbow', 'archer'];
    for (const siteEntry of rt.game.sites.filter(entry => entry.owner === owner && entry.kind === 'city' && !rt.getUnit(entry.x, entry.y))) {
      if (built >= 3) {
        break;
      }
      const type = prefer.find(entry => rt.buildableTypes(siteEntry).includes(entry) && rt.game.goldByOwner[owner] >= typeMeta(entry).cost);
      if (type && rt.buildAtSite(owner, siteEntry, type)) {
        built += 1;
      }
    }
  }

  async function navalTurn(owner) {
    rt.logAiDecision(owner, '海防测试AI：制海守上方水道、专打运兵船，下方海道留口。');
    navalProduce(owner);
    rt.refresh();
    await rt.pause(rt.aiStepDelay());
    const units = rt.game.units.filter(entry => entry.owner === owner);
    for (const unitEntry of [...units]) {
      if (!rt.game.units.includes(unitEntry)) {
        continue;
      }
      // 注意 dest 在攻击【之前】就算好了 —— 攻击可能改变战场，但这里刻意用旧信息。
      const dest = typeMeta(unitEntry.type).domain === 'sea' ? navalPatrolCell(owner, unitEntry) : navalLandHoldCell(owner, unitEntry);
      if (!navalTryAttack(owner, unitEntry)) {
        if (dest && (dest.x !== unitEntry.x || dest.y !== unitEntry.y)) {
          rt.moveUnit(unitEntry, dest.x, dest.y);
        }
        navalTryAttack(owner, unitEntry);
      }
      rt.refresh();
      await rt.pause(rt.aiStepDelay());
    }
    if (!rt.game.over) {
      rt.advanceTurn();
    }
  }

  return {
    bridgeheadTryAttack, bridgeheadDefendCell, bridgeheadProduce, bridgeheadTurn,
    navalTryAttack, navalPatrolCell, navalLandHoldCell, navalProduce, navalTurn
  };
}
