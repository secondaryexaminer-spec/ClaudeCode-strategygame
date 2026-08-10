'use strict';
// 实体工厂与派生属性：造单位、造据点、货舱规则、军衔换算。
//
// 这个模块没有工厂函数、不接 rt —— 全部是纯函数，只依赖参数和常量表。
// 它是目前唯一一个「零运行时依赖」的游戏逻辑模块，worldgen 和 build 都建立在
// 它之上。保持它干净是有价值的：任何时候都能直接 import 来写单元测试，不用
// 先造一个 game 对象。
//
// ⚠️ randomId 里的 Math.random() 必须保持这种「调用时查属性」的写法。
// 无头模拟（sim/）靠把全局 Math.random 替换成种子化 LCG 来实现确定性回放，
// 一旦写成 const { random } = Math 就会在打包时捕获原生实现，确定性会**静默**
// 失效 —— 不报错，只是基线再也对不上。
//
// 同理，每创建一个 unit 或 site 就消耗一次随机数。调用方必须保持「先校验、
// 后构造」的顺序：提前构造再判断要不要用，会让失败路径多消耗一次抽签，
// 整条随机数流随之错位。
import { TYPES, CAMP_DURATION, UNIT_RANK_THRESHOLDS } from '../core/constants.js';
import { siteMeta, typeMeta } from '../core/utils.js';

export function randomId() {
  return Math.random().toString(36).slice(2);
}

export function unit(type, owner, x, y) {
  const meta = typeMeta(type);
  return {
    id: randomId(),
    type,
    owner,
    x,
    y,
    hp: meta.hp,
    maxHp: meta.hp,
    move: meta.move,
    maxMove: meta.move,
    baseMove: meta.move,
    acted: false,
    hasAttacked: false,
    lastAttacked: false,
    kills: 0,
    rank: 0,
    cargo: meta.transport ? [] : null
  };
}

// 货舱里的单位不是完整 unit —— 没有 id、没有行动力。它们上岸时才会被实例化。
// 因此装 5 个货的运兵船只消耗 1 次随机数（船自己那次）。
export function createCargoPayload(owner, type) {
  return {
    type,
    owner,
    hp: typeMeta(type).hp,
    maxHp: typeMeta(type).hp,
    lastAttacked: false
  };
}

export function createLoadedTransport(owner, x, y, cargoTypes = []) {
  const transport = unit('transport', owner, x, y);
  transport.cargo = normalizeCargoTypes(cargoTypes).map(type => createCargoPayload(owner, type));
  return transport;
}

export function site(kind, owner, x, y, name, tier = 1, income = null) {
  return {
    id: randomId(),
    kind,
    owner,
    x,
    y,
    name,
    tier,
    income: income == null ? siteMeta(kind).income : income
  };
}

export function createCamp(owner, x, y) {
  const camp = site('camp', owner, x, y, '临时营地', 2, 0);
  camp.duration = CAMP_DURATION;
  camp.uncapturable = true;
  return camp;
}

export function cargoOptionTypes() {
  return Object.keys(TYPES).filter(type => typeMeta(type).domain === 'land');
}

export function normalizeCargoTypes(types) {
  return (types || []).filter(type => type && type !== 'none' && TYPES[type] && typeMeta(type).domain === 'land').slice(0, typeMeta('transport').transport);
}

export function transportCost(cargoTypes = []) {
  return typeMeta('transport').cost + normalizeCargoTypes(cargoTypes).reduce((sum, type) => sum + typeMeta(type).cost, 0);
}

export function cargoLabel(type) {
  return type === 'none' ? '空位' : `${typeMeta(type).icon} ${typeMeta(type).name}`;
}

export function describeCargo(cargoTypes = []) {
  const types = normalizeCargoTypes(cargoTypes);
  return types.length ? types.map(type => typeMeta(type).name).join('、') : '空舱';
}

export function rankFromKills(kills) {
  let rank = 0;
  for (let index = 0; index < UNIT_RANK_THRESHOLDS.length; index++) {
    if (kills >= UNIT_RANK_THRESHOLDS[index]) {
      rank = index;
    }
  }
  return rank;
}

export function effectiveMove(unitEntry) {
  return unitEntry.baseMove + Math.floor(unitEntry.rank / 2);
}

export function healMultiplier(unitEntry) {
  return 1 + unitEntry.rank * 0.15;
}
