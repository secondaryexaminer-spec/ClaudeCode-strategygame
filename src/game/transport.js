'use strict';
// 运输与移动执行：走位、装卸载、补给判定。
//
// 依赖注入方式见 game/movement.js 顶部对 rt 门面的说明。
//
// 与 game/movement.js 的分工：movement 算「能走到哪」（代价、可通行、可达集合），
// 是纯查询；这里是「真的走过去」以及走到之后发生什么（占领据点、上下船）。
//
// 【为什么 autoLoadAdjacent / autoUnloadAdjacent / strategicLandingScore 不在这里】
// 那三个是 AI 的自动决策：挑哪个单位上船、往哪片海滩卸。strategicLandingScore
// 还要调 AI 的 nearbyEnemies，搬过来会让运输规则反向依赖 AI。它们留在 main.js，
// 等拆 ai/ 时一起走。这里只提供它们要调的规则原语。
import { MAX_STACK } from '../core/constants.js';
import { cellKey, diagonalDist, typeMeta } from '../core/utils.js';
import { unit } from './entities.js';

export function createTransport(rt) {
  function moveUnit(unitEntry, x, y) {
    const cost = rt.reachable(unitEntry).get(cellKey(x, y));
    if (cost === undefined || unitEntry.hasAttacked) {
      return false;
    }
    unitEntry.x = x;
    unitEntry.y = y;
    unitEntry.move -= cost;
    unitEntry.acted = true;
    rt.captureSite(unitEntry);
    return true;
  }

  function canLoadTransport(transport, passenger) {
    return !!transport && !!passenger && !!typeMeta(transport.type).transport && typeMeta(passenger.type).domain === 'land' && transport.owner === passenger.owner && diagonalDist(transport, passenger) === 1 && transport.cargo.length < typeMeta(transport.type).transport;
  }

  // 乘客被「折叠」成一条货舱记录后从 game.units 移除 —— 它不再是场上单位，
  // 因此不消耗随机数、也不会被 getUnit 找到。卸载时才重新实例化。
  function loadTransport(transport, passenger) {
    if (!canLoadTransport(transport, passenger)) {
      return false;
    }
    transport.cargo.push({ type: passenger.type, owner: passenger.owner, hp: passenger.hp, maxHp: passenger.maxHp, lastAttacked: passenger.lastAttacked });
    rt.game.units = rt.game.units.filter(entry => entry !== passenger);
    transport.acted = true;
    rt.log(`${typeMeta(passenger.type).name}登上了运兵船。`, 'system');
    return true;
  }

  function canUnloadTransport(transport, x, y) {
    if (!transport || !transport.cargo?.length || diagonalDist(transport, { x, y }) !== 1 || !rt.isLandTile(x, y)) {
      return false;
    }
    // 叠放只可能由卸载产生：目标格要么是空的，要么已有不到 3 个己方陆军。
    const occupants = rt.unitsAt(x, y);
    return occupants.length < MAX_STACK && occupants.every(entry => entry.owner === transport.owner && typeMeta(entry.type).domain === 'land');
  }

  function unloadTransport(transport, x, y) {
    if (!canUnloadTransport(transport, x, y)) {
      return false;
    }
    const payload = transport.cargo.shift();
    const unitEntry = unit(payload.type, payload.owner, x, y);
    unitEntry.hp = payload.hp;
    unitEntry.maxHp = payload.maxHp;
    unitEntry.move = 0;
    unitEntry.acted = true;
    unitEntry.hasAttacked = true;
    unitEntry.lastAttacked = payload.lastAttacked;
    rt.game.units.push(unitEntry);
    transport.acted = true;
    if (unitEntry.type === 'engineer') {
      rt.incrementStrat(unitEntry.owner, 'engineerLandings');
    }
    rt.log(`${typeMeta(unitEntry.type).name}完成登陆。`, 'system');
    rt.captureSite(unitEntry);
    return true;
  }

  // 能为该单位提供补给（回血）的己方据点。陆海分别看不同据点类型。
  function supportSites(unitEntry) {
    return rt.game.sites.filter(siteEntry => rt.areAllies(siteEntry.owner, unitEntry.owner) && ((((siteEntry.kind === 'city' || siteEntry.kind === 'camp' || siteEntry.kind === 'barracksSmall' || siteEntry.kind === 'barracksLarge') && typeMeta(unitEntry.type).domain === 'land')) || ((siteEntry.kind === 'shipyard' || siteEntry.kind === 'fortress') && typeMeta(unitEntry.type).domain === 'sea')));
  }

  return { moveUnit, canLoadTransport, loadTransport, canUnloadTransport, unloadTransport, supportSites };
}
