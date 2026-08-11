'use strict';
// 回合流转：谁该行动、行动前重置什么、据点易手时结算什么。
//
// 依赖注入方式见 game/movement.js 顶部对 rt 门面的说明；额外的 deps 见
// debug/hooks.js 的说明。
//
// 【beginTurn 和 advanceTurn 是一对相互递归的函数】
//   advanceTurn → beginTurn（轮到下一家）
//   beginTurn   → advanceTurn（这一家已经被消灭，直接跳过）
// 递归的终止靠 ownerExists：只要还有一方存在就一定会停。全员被消灭的局面不会
// 发生 —— checkEnd 会在最后一方倒下时把 game.over 置真，而两个函数开头都有
// `if (game.over) return`。**动这两个函数时先确认这条链还闭合**，否则表现是
// 开局瞬间栈溢出。
//
// 【为什么首回合不结算收入】
// beginTurn(owner, initial=true) 跳过 decayFrontMemory / decayTemporarySites /
// healOwner / grantIncome / aiRepair。开局金币是 newGame 里发的固定值，
// 首回合再结算一次等于白送一轮收入。
//
// 【AI 接管为什么要延迟 260ms】
// 让玩家看清"轮到谁了"再开始动。fastSim 下整个 setTimeout 分支被跳过 ——
// 无头模拟里由 fastRun 的 while 循环直接驱动 aiTurn。
//
// 【captureSite 里那个 12% 的降级概率是随机数消耗点】
// 每次占领据点都会掷一次（要塞除外）。改判定条件或挪动这行的位置，都会改变
// 后续所有随机数的序列 —— sim/baseline.json 会整体失效。
import { MAX_TURNS } from '../core/constants.js';
import { siteMeta, typeMeta } from '../core/utils.js';
import { effectiveMove } from './entities.js';

// 占领时设施战损降级的概率。要塞不适用（它没有产能可损失）。
const CAPTURE_DOWNGRADE_CHANCE = 0.12;

export function createTurnFlow(rt, deps) {
  const {
    decayFrontMemory, decayTemporarySites, healOwner, grantIncome, aiRepair,
    resolveStalemate, aiTurn
  } = deps;

  // 单位踩进据点格时调用。能不能占由兵种军种决定，不是所有单位都能占所有据点。
  function captureSite(unitEntry) {
    const game = rt.game;
    const siteEntry = rt.getSite(unitEntry.x, unitEntry.y);
    if (!siteEntry || siteEntry.owner === unitEntry.owner || rt.areAllies(siteEntry.owner, unitEntry.owner)) {
      return;
    }
    // 临时营地不易手，直接摧毁 —— 它是"己方专属"的临时设施，抢过来没有意义。
    if (siteEntry.kind === 'camp') {
      game.sites = game.sites.filter(entry => entry !== siteEntry);
      if (game.selected?.ref === siteEntry) {
        game.selected = null;
      }
      rt.incrementStat('lostSites', siteEntry.owner, 1);
      rt.incrementStat('captures', unitEntry.owner, 1);
      rt.recordStatSnapshot('camp-destroyed');
      rt.log(`${rt.ownerName(unitEntry.owner)}摧毁了${siteEntry.owner === 'player' ? '你的' : rt.ownerName(siteEntry.owner)}临时营地。`, 'system');
      return;
    }
    // 军种限制：陆地据点只有陆军能占，海上据点只有海军能占。
    // 油田和军营不在这两条里 —— 它们在陆地上，但任何能站上去的单位都能占。
    const domain = typeMeta(unitEntry.type).domain;
    if (siteEntry.kind === 'city' && domain !== 'land') {
      return;
    }
    if ((siteEntry.kind === 'shipyard' || siteEntry.kind === 'fortress') && domain !== 'sea') {
      return;
    }
    const oldTier = siteEntry.tier;
    const oldOwner = siteEntry.owner;
    siteEntry.owner = unitEntry.owner;
    // 小概率战损降级，见文件头。收入要跟着重算，否则等级降了钱不降。
    if (siteEntry.kind !== 'fortress' && Math.random() < CAPTURE_DOWNGRADE_CHANCE) {
      siteEntry.tier = Math.max(1, siteEntry.tier - 1);
      siteEntry.income = Math.max(4, siteMeta(siteEntry.kind).income + (siteEntry.tier - 1) * (siteEntry.kind === 'city' ? 3 : 2));
    }
    // 中立据点被占不算任何人"丢失"。
    if (oldOwner !== 'neutral') {
      rt.incrementStat('lostSites', oldOwner, 1);
    }
    rt.incrementStat('captures', unitEntry.owner, 1);
    if (siteEntry.kind === 'city') {
      rt.incrementStrat(unitEntry.owner, 'cityCaptures');
    } else if (siteEntry.kind.startsWith('oil')) {
      rt.incrementStrat(unitEntry.owner, 'oilCaptures');
    } else if (siteEntry.kind === 'shipyard' || siteEntry.kind === 'fortress') {
      rt.incrementStrat(unitEntry.owner, 'shipyardCaptures');
    }
    rt.recordStatSnapshot('capture');
    rt.log(`${rt.ownerName(unitEntry.owner)}夺取了${siteEntry.name}${siteEntry.tier < oldTier ? '，设施战损降级。' : '。'}`, 'system');
    // 占城可能直接触发胜利条件。
    rt.checkEnd();
  }

  function beginTurn(owner, initial) {
    const game = rt.game;
    if (game.over) {
      return;
    }
    // 这一方已经被消灭，跳过。递归的另一半，见文件头。
    if (!rt.ownerExists(owner)) {
      rt.advanceTurn();
      return;
    }
    game.side = owner;
    // 每回合的造兵额度独立计算。
    game.buildsThisTurn = game.buildsThisTurn || {};
    game.buildsThisTurn[owner] = 0;
    // 首回合不结算，见文件头。
    if (!initial) {
      decayFrontMemory(owner);
      decayTemporarySites(owner);
      healOwner(owner);
      grantIncome(owner);
      aiRepair(owner);
    }
    for (const unitEntry of game.units.filter(entry => entry.owner === owner)) {
      // maxMove 要重算：军衔提升会改变它。
      unitEntry.maxMove = effectiveMove(unitEntry);
      unitEntry.move = unitEntry.maxMove;
      unitEntry.acted = false;
      unitEntry.hasAttacked = false;
    }
    // 轮到别人时清掉选中，避免玩家看到自己的选中框停在敌方回合。
    if (owner !== 'player') {
      game.selected = null;
    }
    rt.refresh();
    if (!initial) {
      rt.checkEnd();
    }
    // 延迟接管，见文件头。判两次 game.over / game.side 是因为这 260ms 里
    // 玩家可能已经退出对局或读了档。
    if (owner !== 'player' && !rt.fastSim) {
      setTimeout(() => {
        if (!game.over && game.side === owner) {
          void aiTurn(owner);
        }
      }, 260);
    }
  }

  function advanceTurn() {
    const game = rt.game;
    if (game.over) {
      return;
    }
    game.currentIndex = (game.currentIndex + 1) % game.ownerOrder.length;
    // 转回第一家 = 一个完整回合结束。
    if (game.currentIndex === 0) {
      game.turn += 1;
      // 打满上限还没分出胜负，按当前局面判定（主要看谁城多）。
      if (game.turn > MAX_TURNS && !game.freeplay && !game.over) {
        resolveStalemate();
        if (game.over) {
          return;
        }
      }
    }
    beginTurn(game.ownerOrder[game.currentIndex], false);
  }

  return { captureSite, beginTurn, advanceTurn };
}
