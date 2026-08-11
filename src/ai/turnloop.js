'use strict';
// AI 回合的编排：决定这一方的单位按什么顺序行动、每个单位走哪条决策分支。
//
// 依赖注入方式见 game/movement.js 顶部对 rt 门面的说明；额外的 deps 见
// debug/hooks.js 的说明。
//
// 【它在 AI 三层之上，是第四层】
//   ai/scoring  —— 这个东西值多少分
//   ai/intent   —— 这一方这回合想干什么
//   ai/decide   —— 某个单位具体怎么做
//   ai/turnloop —— 谁先动、走哪条分支、什么时候收手   ← 就是这个文件
// 依赖是单向的：turnloop 调用下面三层，下面三层不知道它的存在。
//
// 【每个单位的分支顺序就是 AI 的行为优先级，不要重排】
//   1. 桥头暂退  —— 目标被判定为"打不动"时先撤，避免在同一处反复送人头
//   2. 桥头预备队 —— 谨慎性格下，前线够密就把后续单位留作预备队
//   3. 运输船    —— 装载 / 卸载 / 驶向登陆点
//   4. 工程师    —— 建营地 / 造舰
//   5. 通用决策  —— chooseAction：移动 + 攻击
// 每条分支都以 `continue` 结尾，先匹配上的赢。把 3 挪到 1 前面，运输船就永远不会
// 参与桥头撤退；把 5 挪上来，前四条就全都失效了。
//
// 【为什么每步之后都 refresh() + pause()】
// 让玩家看得见 AI 在做什么。fastSim 下 refresh() 直接返回、pause() 不等待，
// 所以无头模拟里这两句几乎是零开销 —— 不要为了"优化"把它们移到分支外面，
// 那样正常游戏时 AI 会一瞬间走完所有单位。
//
// 【`[...units]` 这个拷贝是必需的】
// 循环体内会攻击、会让单位阵亡，game.units 会被改。直接迭代原数组会漏掉元素。
// 拷贝之后还要在循环里再判一次 `game.units.includes(unitEntry)` —— 拷贝只保证
// 迭代不乱，不保证单位还活着（它可能在别人的反击里死了）。
import { DIFF } from '../core/constants.js';
import { cellKey, dist, typeMeta } from '../core/utils.js';

export function createTurnLoop(rt, deps) {
  const {
    // 脚本对手
    navalTurn, bridgeheadTurn,
    // 意图层
    buildStrategicIntent, summarizeIntent, frontMemory, unitPriority,
    computeUnitState, finalizeUnitState, bestRetreatCell, bestObjective,
    // 决策层
    chooseAction, aiManageForces, aiSpendGold,
    autoLoadAdjacent, autoUnloadAdjacent, engineerBuildChoice,
    // 评分与寻路
    isBridgeheadSite, frontlineCount, nearbyEnemies,
    bestLanding, moveTransportToward, clearLandReachCache,
    // 动作
    buildCamp, engineerLaunch, sameCell
  } = deps;

  async function aiTurn(owner) {
    const game = rt.game;
    const profile = game.aiProfiles[owner] || { diff: 'medium', agg: 'balanced' };
    // 落地可达缓存依赖单位位置，每个回合开头必须清。
    clearLandReachCache();

    // 脚本对手是给回归测试用的固定行为，不走下面这套通用逻辑。
    if (DIFF[profile.diff]?.scripted) {
      if (DIFF[profile.diff].script === 'naval') {
        await navalTurn(owner);
      } else {
        await bridgeheadTurn(owner);
      }
      return;
    }

    const intent = buildStrategicIntent(owner, profile);
    const memory = frontMemory(owner);
    rt.logAiDecision(owner, summarizeIntent(intent));
    if (intent.cooledTargets?.length) {
      rt.incrementStrat(owner, 'reroutes');
      rt.logAiDecision(owner, `暂时避开受阻方向：${intent.cooledTargets.join('、')}。`);
    }
    // 先修理和生产，再动兵 —— 新造的单位这回合就能参与行动。
    aiManageForces(owner);
    aiSpendGold(owner, profile);
    rt.refresh();
    await rt.pause(rt.aiStepDelay());

    // 按 unitPriority 排序：重要的单位先动，能先占到好位置。
    const units = game.units.filter(entry => entry.owner === owner).sort((a, b) => unitPriority(b, intent) - unitPriority(a, intent));
    for (const unitEntry of [...units]) {
      if (game.over) {
        break;
      }
      // 可能在别人的反击里已经阵亡，见文件头。
      if (!game.units.includes(unitEntry)) {
        continue;
      }
      const state = computeUnitState(unitEntry);
      const startCell = { x: unitEntry.x, y: unitEntry.y };
      const assaultKey = intent.assaultSite ? `site:${cellKey(intent.assaultSite.x, intent.assaultSite.y)}` : null;
      const bridgeheadCooldown = assaultKey ? memory[assaultKey]?.cooldown > 0 : false;
      // 两个判定条件（阵营级冷却 / 这个单位自己的绕路计时）取或：
      // 前者是"整条战线都撞墙了"，后者是"就这个单位一直上不去"。
      const bridgeheadBlocked = intent.assaultSite && isBridgeheadSite(intent.assaultSite) && (bridgeheadCooldown || (state.rerouteTurns > 0 && state.failedObjectiveKey === assaultKey)) && dist(unitEntry, intent.assaultSite) <= 4;

      // 分支 1：桥头暂退。冲动性格不撤。
      if (bridgeheadBlocked && typeMeta(unitEntry.type).domain === 'land' && profile.agg !== 'reckless') {
        const retreatCell = bestRetreatCell(owner, unitEntry, intent.assaultSite);
        if (retreatCell && (retreatCell.x !== unitEntry.x || retreatCell.y !== unitEntry.y)) {
          rt.incrementStrat(owner, 'retreats');
          rt.logAiDecision(owner, `${typeMeta(unitEntry.type).name}从桥头暂退，在 ${intent.assaultSite.name} 方向重整。`);
          rt.moveUnit(unitEntry, retreatCell.x, retreatCell.y);
          finalizeUnitState(unitEntry, state, assaultKey || 'idle', true);
          rt.refresh();
          await rt.pause(rt.aiStepDelay());
          continue;
        }
      }

      // 分支 2：桥头预备队。前线已经够密时，把远处的和远程单位留在后面，
      // 避免全挤在滩头互相挡路。血量太低的不留（它该回去修）。
      if (profile.agg === 'cautious' && intent.assaultSite && isBridgeheadSite(intent.assaultSite)) {
        const currentFrontline = frontlineCount(owner, intent.assaultSite, 3);
        const isReserveCandidate = typeMeta(unitEntry.type).domain === 'land' && unitEntry.type !== 'engineer' && (dist(unitEntry, intent.assaultSite) > 4 || typeMeta(unitEntry.type).range >= 2);
        if (currentFrontline >= 4 && isReserveCandidate && unitEntry.hp > unitEntry.maxHp * 0.65) {
          rt.incrementStrat(owner, 'reserves');
          rt.logAiDecision(owner, `${typeMeta(unitEntry.type).name}作为桥头预备队待机。`);
          finalizeUnitState(unitEntry, state, `reserve:${cellKey(intent.assaultSite.x, intent.assaultSite.y)}`, false);
          rt.refresh();
          await rt.pause(rt.aiStepDelay());
          continue;
        }
      }

      // 分支 3：运输船。空船装人、满船卸人、都不行就驶向登陆点。
      if (unitEntry.type === 'transport') {
        if (!unitEntry.cargo.length && autoLoadAdjacent(unitEntry)) {
          finalizeUnitState(unitEntry, state, 'transport-load', false);
          rt.refresh();
          await rt.pause(rt.aiStepDelay());
          continue;
        }
        if (unitEntry.cargo.length && autoUnloadAdjacent(unitEntry)) {
          finalizeUnitState(unitEntry, state, 'transport-unload', false);
          rt.refresh();
          await rt.pause(rt.aiStepDelay());
          continue;
        }
        const landing = bestLanding(owner, unitEntry);
        if (landing) {
          const moved = moveTransportToward(unitEntry, landing);
          // 移动之后再判一次要不要卸载：可能刚好开到了能登陆的位置。
          // 附近没敌人、或者有战船护航才卸 —— 否则登陆的部队会被当场吃掉。
          const nearThreat = nearbyEnemies({ x: unitEntry.x, y: unitEntry.y }, owner, 2);
          const escortAdjacent = game.units.some(entry => entry.owner === owner && entry.type === 'warship' && dist(entry, unitEntry) <= 2);
          if (unitEntry.cargo.length && (nearThreat === 0 || escortAdjacent)) {
            autoUnloadAdjacent(unitEntry);
          }
          finalizeUnitState(unitEntry, state, `landing:${cellKey(landing.x, landing.y)}`, moved);
          rt.refresh();
          await rt.pause(rt.aiStepDelay());
          continue;
        }
      }

      // 分支 4：工程师。建营地或造舰；两个都做不了就落到通用决策。
      if (unitEntry.type === 'engineer') {
        const engineerChoice = engineerBuildChoice(owner, unitEntry, intent);
        if (engineerChoice?.kind === 'camp' && buildCamp(unitEntry)) {
          finalizeUnitState(unitEntry, state, 'camp', false);
          rt.refresh();
          await rt.pause(rt.aiStepDelay());
          continue;
        }
        if (engineerChoice?.cell && engineerLaunch(unitEntry, engineerChoice.kind, engineerChoice.cell, engineerChoice.cargoTypes || [])) {
          finalizeUnitState(unitEntry, state, `${engineerChoice.kind}:${cellKey(engineerChoice.cell.x, engineerChoice.cell.y)}`, false);
          rt.refresh();
          await rt.pause(rt.aiStepDelay());
          continue;
        }
      }

      // 分支 5：通用决策 —— 移动 + 攻击。
      const choice = chooseAction(owner, unitEntry, profile, intent);
      const objectiveSite = choice.target ? null : bestObjective(owner, unitEntry, intent);
      const objectiveKey = objectiveSite ? `site:${cellKey(objectiveSite.x, objectiveSite.y)}` : choice.target ? `attack:${choice.target.id}` : 'idle';
      if (choice.move && (choice.move.x !== unitEntry.x || choice.move.y !== unitEntry.y)) {
        rt.moveUnit(unitEntry, choice.move.x, choice.move.y);
      }
      // 移动之后目标可能已经不在了（被别的单位打死），双方都要再确认一次。
      if (choice.target && game.units.includes(unitEntry) && game.units.includes(choice.target) && rt.canAttack(unitEntry, choice.target)) {
        rt.attack(unitEntry, choice.target);
      }
      finalizeUnitState(unitEntry, state, objectiveKey, !sameCell(startCell, unitEntry));
      rt.refresh();
      await rt.pause(rt.aiStepDelay());
    }

    // 对局已经结束就别再推进轮次了 —— advanceTurn 会重置移动力、结算收入。
    if (!game.over) {
      rt.advanceTurn();
    }
  }

  return { aiTurn };
}
