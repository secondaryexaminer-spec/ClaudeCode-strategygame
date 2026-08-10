'use strict';
// 回合流程与胜负判定：回合开始的恢复与收入、僵局裁定、终局判定、结算。
//
// 依赖注入方式见 game/movement.js 顶部对 rt 门面的说明。
//
// 【为什么 beginTurn / advanceTurn 不在这里】
// 那两个是流程编排：切 side、重置行动力、刷新 UI、排 setTimeout 让 AI 接管、
// 双向递归跳过已出局的玩家。它们要碰 refresh / aiTurn / setTimeout / fastSim，
// 是把规则「驱动起来」的胶水，和 io/saves.js 里没搬走的 loadPayload 同一性质。
// 留在 main.js，属于最终会沉淀到装配层的代码。这里只提供它们要调的那些规则。
//
// 【checkEnd 是纯决策 + 单一副作用汇点】
// 整整 100 行里一个字节的状态都没写，所有写入都经由 finish()，共 12 个出口。
// 想进一步纯化的话，可以拆成 evaluateEnd(state) -> {win, text} | null 加三行
// wrapper —— 但那是下一步，这次只做搬移。
//
// ⚠️ 两个不能动的细节：
// 1. 开头的 game.over 守卫是防重入的关键。combat 的一次 attack 结算会调两次
//    checkEnd（removeUnit 里一次、attack 末尾一次），第二次靠这个守卫直接返回。
//    调整守卫顺序会导致 finish 跑两遍、game.result 被覆盖、统计多写一条历史。
// 2. 观战分支里 finish 的 win 恒为 true —— 那不是「玩家赢了」，只是「有结果」。
//    别顺手"修正"成胜者队伍。
import { dist } from '../core/utils.js';
import { healMultiplier } from './entities.js';

export function createTurn(rt) {
  function healOwner(owner) {
    for (const unitEntry of rt.game.units.filter(entry => entry.owner === owner)) {
      const supports = rt.supportSites(unitEntry);
      if (!supports.length) {
        unitEntry.lastAttacked = false;
        continue;
      }
      const nearest = Math.min(...supports.map(siteEntry => dist(siteEntry, unitEntry)));
      if (!unitEntry.lastAttacked) {
        const ratio = (nearest === 0 ? 0.16 : nearest <= 1 ? 0.1 : nearest >= 14 ? 0.02 : Math.max(0.02, 0.1 - (nearest - 1) * 0.08 / 13)) * healMultiplier(unitEntry);
        unitEntry.hp = Math.min(unitEntry.maxHp, unitEntry.hp + Math.max(1, Math.ceil(unitEntry.maxHp * ratio)));
      }
      unitEntry.lastAttacked = false;
    }
  }

  function grantIncome(owner) {
    const base = rt.game.sites.filter(entry => entry.owner === owner).reduce((sum, entry) => sum + entry.income, 0);
    const gain = Math.round(base * (rt.game.settings?.incomeMult || 1));
    rt.game.goldByOwner[owner] += gain;
    if (gain > 0) {
      rt.log(`${rt.ownerName(owner)}获得 ${gain} 金币收入。`, 'gold');
    }
  }

  function teamStandings() {
    const standings = {};
    // 外层括号是语义必需的 —— ensure 要返回那个 bucket，去掉就变成返回 undefined。
    const ensure = team => (standings[team] = standings[team] || { cities: 0, sites: 0, units: 0 });
    for (const siteEntry of rt.game.sites) {
      if (siteEntry.owner === 'neutral') {
        continue;
      }
      const bucket = ensure(rt.teamOf(siteEntry.owner));
      bucket.sites += 1;
      if (siteEntry.kind === 'city') {
        bucket.cities += 1;
      }
    }
    for (const unitEntry of rt.game.units) {
      ensure(rt.teamOf(unitEntry.owner)).units += 1;
    }
    return standings;
  }

  function resolveStalemate() {
    const standings = teamStandings();
    const ranked = Object.entries(standings).sort((a, b) => b[1].cities - a[1].cities || b[1].sites - a[1].sites || b[1].units - a[1].units);
    if (!ranked.length) {
      finish(false, `战局在第 ${rt.game.turn} 回合陷入僵局，双方均无立足点。`);
      return;
    }
    const [leadTeam, lead] = ranked[0];
    const playerWin = !rt.game.settings?.spectator && rt.teamOf('player') === leadTeam;
    finish(playerWin, `战局在第 ${rt.game.turn} 回合达到回合上限，判定 ${leadTeam} 组以 ${lead.cities} 城 / ${lead.sites} 据点领先胜出。`);
  }

  function checkEnd() {
    const game = rt.game;
    if (game.over || game.freeplay) {
      return;
    }
    if (game.settings?.spectator) {
      const activeTeams = new Set();
      for (const unitEntry of game.units) {
        activeTeams.add(rt.teamOf(unitEntry.owner));
      }
      for (const siteEntry of game.sites) {
        if (siteEntry.owner !== 'neutral') {
          activeTeams.add(rt.teamOf(siteEntry.owner));
        }
      }
      if (game.settings.mode === 'skirmish') {
        const combatTeams = new Set(game.units.map(unitEntry => rt.teamOf(unitEntry.owner)));
        if (combatTeams.size === 1 && combatTeams.size > 0) {
          finish(true, `${[...combatTeams][0]} 组赢得了观战遭遇战。`);
        }
        return;
      }
      if (game.settings.mode === 'survival' && game.turn >= 12) {
        const ranked = [...activeTeams].sort((a, b) => game.sites.filter(siteEntry => siteEntry.kind === 'city' && rt.teamOf(siteEntry.owner) === b).length - game.sites.filter(siteEntry => siteEntry.kind === 'city' && rt.teamOf(siteEntry.owner) === a).length);
        if (ranked[0]) {
          finish(true, `${ranked[0]} 组在观战守城模式中存活到第12回合。`);
        }
        return;
      }
      const hostileTeams = new Set(game.sites.filter(siteEntry => (siteEntry.kind === 'city' || siteEntry.kind === 'shipyard' || siteEntry.kind === 'fortress') && siteEntry.owner !== 'neutral').map(siteEntry => rt.teamOf(siteEntry.owner)));
      if (hostileTeams.size === 1) {
        const winnerTeam = [...hostileTeams][0];
        const enemyEngineers = game.units.some(unitEntry => (unitEntry.type === 'engineer' && rt.teamOf(unitEntry.owner) !== winnerTeam) || unitEntry.cargo?.some(payload => payload.type === 'engineer' && rt.teamOf(payload.owner) !== winnerTeam));
        if (!enemyEngineers) {
          finish(true, `${winnerTeam} 组完成了全部敌对城市与海上据点占领，并清除了敌方工程师。`);
          return;
        }
      }
      if (activeTeams.size === 1 && activeTeams.size > 0) {
        finish(true, `${[...activeTeams][0]} 组成为战场最后赢家。`);
      }
      return;
    }
    const playerTeam = rt.teamOf('player');
    const activeTeams = new Set();
    for (const unitEntry of game.units) {
      activeTeams.add(rt.teamOf(unitEntry.owner));
    }
    for (const siteEntry of game.sites) {
      if (siteEntry.owner !== 'neutral') {
        activeTeams.add(rt.teamOf(siteEntry.owner));
      }
    }
    const playerAlive = [...activeTeams].includes(playerTeam);
    if (game.settings.mode === 'survival') {
      const alliedCity = game.sites.some(siteEntry => siteEntry.kind === 'city' && rt.areAllies(siteEntry.owner, 'player'));
      if (!alliedCity && !game.units.some(unitEntry => rt.areAllies(unitEntry.owner, 'player'))) {
        finish(false, '你的组已经失去全部立足点。');
        return;
      }
      if (game.turn >= 12 && alliedCity) {
        finish(true, '你成功守住了关键城市直到第12回合。');
      }
      return;
    }
    if (game.settings.mode === 'skirmish') {
      const combatTeams = new Set(game.units.map(unitEntry => rt.teamOf(unitEntry.owner)));
      if (!combatTeams.has(playerTeam)) {
        finish(false, '你的组全部野战部队已被消灭。');
        return;
      }
      if (combatTeams.size === 1 && combatTeams.has(playerTeam)) {
        finish(true, '敌对组野战部队已全部被消灭。');
      }
      return;
    }
    const enemyControlledCities = game.sites.filter(siteEntry => siteEntry.kind === 'city' && siteEntry.owner !== 'neutral' && rt.teamOf(siteEntry.owner) !== playerTeam);
    const enemyControlledSeaSites = game.sites.filter(siteEntry => (siteEntry.kind === 'shipyard' || siteEntry.kind === 'fortress') && siteEntry.owner !== 'neutral' && rt.teamOf(siteEntry.owner) !== playerTeam);
    if (!enemyControlledCities.length && !enemyControlledSeaSites.length) {
      const enemyEngineers = game.units.some(unitEntry => (unitEntry.type === 'engineer' && rt.teamOf(unitEntry.owner) !== playerTeam) || unitEntry.cargo?.some(payload => payload.type === 'engineer' && rt.teamOf(payload.owner) !== playerTeam));
      if (!enemyEngineers) {
        finish(true, '你已占领全部敌对城市与海上据点，并清除了全部敌方工程师。');
        return;
      }
    }
    const hostileTeams = new Set(game.sites.filter(siteEntry => (siteEntry.kind === 'city' || siteEntry.kind === 'shipyard' || siteEntry.kind === 'fortress') && siteEntry.owner !== 'neutral').map(siteEntry => rt.teamOf(siteEntry.owner)));
    if (hostileTeams.size === 1 && !hostileTeams.has(playerTeam)) {
      const winnerTeam = [...hostileTeams][0];
      const enemyEngineers = game.units.some(unitEntry => (unitEntry.type === 'engineer' && rt.teamOf(unitEntry.owner) !== winnerTeam) || unitEntry.cargo?.some(payload => payload.type === 'engineer' && rt.teamOf(payload.owner) !== winnerTeam));
      if (!enemyEngineers) {
        finish(false, '敌方已占领全部城市与海上据点，并清除了你方全部工程师。');
        return;
      }
    }
    if (!playerAlive) {
      finish(false, '你的组已经失去全部据点与部队。');
      return;
    }
    if (activeTeams.size === 1 && activeTeams.has(playerTeam)) {
      finish(true, '战场上只剩下你的组仍具战争能力。');
    }
  }

  // 原本 finish 在 `if (fastSim) return;` 处天然分成两半：上面是规则与存档语义
  // （无头模拟也要跑），下面全是表现层。搬移时就沿这条线切开，UI 那半交回
  // main.js 的 rt.onGameOver。这样 turn.js 不需要认识 $ 和任何 DOM 元素。
  function finish(win, text) {
    rt.game.over = true;
    rt.game.stats.endTime = Date.now();
    rt.game.result = { win, text };
    rt.recordStatSnapshot('finish');
    if (rt.fastSim) {
      return;
    }
    rt.onGameOver(win, text);
  }

  // 手动结束对局，无人获胜；时间照样结算、统计照样出。
  // 关暂停面板必须在 game.over 守卫之后 —— 对局已经结束时原本就不关它。
  function endGameNeutral() {
    if (!rt.game || rt.game.over) {
      return;
    }
    rt.hidePauseModal();
    finish(null, '本局已手动结束，以下为本局统计。');
  }

  function sideLabel() {
    if (rt.game.settings?.spectator) {
      return `观战中 · ${rt.ownerShort(rt.game.side)}行动中 · ${rt.teamOf(rt.game.side)}组`;
    }
    return rt.game.side === 'player' ? `你的回合 · ${rt.teamOf('player')}组` : `${rt.ownerShort(rt.game.side)}行动中 · ${rt.teamOf(rt.game.side)}组`;
  }

  return { healOwner, grantIncome, teamStandings, resolveStalemate, checkEnd, finish, endGameNeutral, sideLabel };
}
