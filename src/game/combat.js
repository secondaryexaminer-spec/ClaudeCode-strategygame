'use strict';
// 战斗规则：加成计算、伤害公式、攻击结算与单位移除。
//
// 依赖注入方式同 game/movement.js —— 见那里对 runtime 门面 rt 的说明。
//
// 这个模块比 movement 更「脏」：removeUnit 和 attack 会写日志、改统计、触发
// 胜负判定，副作用一路穿到 main.js。这些副作用同样从 rt 上取（rt.log /
// rt.incrementStat / rt.checkEnd ...），所以模块本身仍然可以被单独替换或打桩测试。
//
// 拆分边界的取舍：伤害公式（computeDamage / previewCombat）是纯计算，本可以
// 单独抽成无副作用模块；但它和 attack 共享 siteBonus / matchupBonus，硬拆会让
// 一次战斗结算跨三个文件。战斗是一个完整的规则单元，先整块搬过来。
import { TERRAIN } from '../core/constants.js';
import { rnd, clamp, diagonalDist, inUnitRange, siteMeta, typeMeta } from '../core/utils.js';

export function createCombat(rt) {
  function siteBonus(siteEntry, unitEntry, mode) {
    if (!siteEntry || !rt.areAllies(siteEntry.owner, unitEntry.owner)) {
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
    const attackSite = rt.getSite(fromCell.x, fromCell.y);
    const defenseSite = rt.getSite(toCell.x, toCell.y);
    const terrainDef = TERRAIN[rt.game.terrain[toCell.y][toCell.x]].def;
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
    return !!attacker && !!defender && attacker.owner === rt.game.side && !attacker.hasAttacked && rt.areEnemies(attacker.owner, defender.owner) && inUnitRange(typeMeta(attacker.type).range, fromCell, defender);
  }

  function removeUnit(unitEntry) {
    if (unitEntry.cargo?.length) {
      rt.log(`${typeMeta(unitEntry.type).name}被击沉，船上搭载单位全部损失。`, 'warning');
    }
    rt.incrementStat('losses', unitEntry.owner, 1 + (unitEntry.cargo?.length || 0));
    rt.game.units = rt.game.units.filter(entry => entry !== unitEntry);
    rt.recordStatSnapshot('loss');
    // 最后一个敌方单位阵亡的瞬间就判定歼灭胜利，而不是等到下个回合开始。
    if (!rt.game.over) {
      rt.checkEnd();
    }
  }

  function attack(attacker, defender) {
    const result = previewCombat(attacker, defender, { x: attacker.x, y: attacker.y }, false);
    defender.hp -= result.damage;
    defender.lastAttacked = true;
    attacker.move = 0;
    attacker.hasAttacked = true;
    attacker.acted = true;
    rt.log(`${rt.ownerName(attacker.owner)}的${typeMeta(attacker.type).name}攻击${rt.ownerName(defender.owner)}的${typeMeta(defender.type).name}，造成 ${result.damage} 点伤害。`, 'battle');
    if (defender.hp <= 0) {
      rt.incrementStat('kills', attacker.owner, 1 + (defender.cargo?.length || 0));
      rt.grantKills(attacker, 1 + (defender.cargo?.length || 0));
      removeUnit(defender);
      rt.log(`${typeMeta(defender.type).name}被消灭。`, 'battle');
    } else if (result.counter > 0) {
      attacker.hp -= result.counter;
      rt.log(`${typeMeta(defender.type).name}反击，造成 ${result.counter} 点伤害。`, 'battle');
      if (attacker.hp <= 0) {
        rt.incrementStat('kills', defender.owner, 1 + (attacker.cargo?.length || 0));
        rt.grantKills(defender, 1 + (attacker.cargo?.length || 0));
        removeUnit(attacker);
        rt.log(`${typeMeta(attacker.type).name}在反击中被击毁。`, 'battle');
      }
    }
    rt.checkEnd();
  }

  return { siteBonus, matchupBonus, computeDamage, previewCombat, canAttack, removeUnit, attack };
}
