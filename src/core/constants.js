'use strict';
// Pure game data & tuning constants. No mutable runtime state lives here.
// Bundled back into a single IIFE by esbuild; imported by src/main.js.

export const TEAMS = ['A', 'B', 'C', 'D', 'E'];
export const OWNER_NAMES = ['赤岩军团', '紫晶军团', '琥珀军团', '翡翠军团', '钢青军团', '沙金军团', '苍鹰军团'];
export const OWNER_COLORS = ['#ef5c55', '#dc8cff', '#f2a65a', '#56d364', '#7aa2c9', '#d8c06b', '#5ad2c0'];
export const COLOR_PRESETS = {
  azure: { name: '蔚蓝', value: '#55a3ff' },
  crimson: { name: '赤红', value: '#ef5c55' },
  violet: { name: '紫晶', value: '#dc8cff' },
  amber: { name: '琥珀', value: '#f2a65a' },
  jade: { name: '翡翠', value: '#56d364' },
  steel: { name: '钢青', value: '#7aa2c9' },
  sand: { name: '沙金', value: '#d8c06b' },
  teal: { name: '青碧', value: '#5ad2c0' },
  rose: { name: '绯红', value: '#ff8fab' }
};
export const CITY_NAMES = ['曙光堡', '河湾镇', '风暴关', '赤岩城', '白桦城', '鹰巢堡', '晨星镇', '铁壁城', '雾港', '长桥镇', '边陲堡', '松林城', '石桥镇', '北门关', '灰岭城', '麦田堡'];
export const PORT_NAMES = ['东堤港', '蓝湾船坞', '风岬港', '白浪船厂', '深潮港', '南礁造船所', '碎潮军港', '北湾船坞'];
export const FORT_NAMES = ['离岸堡', '玄潮堡', '远洋堡', '深蓝堡', '北礁堡', '灯塔堡'];
export const OIL_NAMES = ['黑沙油田', '烈日油区', '北川油井', '灰岩油田', '长风油井', '东湾油区'];
export const BARRACK_NAMES = ['前线军营', '铁壁军营', '远征军营', '山口军营', '河湾军营', '要塞军营'];

export const VIEW_MAX_W = 1280;
export const VIEW_MAX_H = 820;

export const CAMP_DURATION = 3;
export const CAMP_COST = 24;
export const CITY_INCOME_BY_TIER = { 1: 8, 2: 11, 3: 14 };
export const UNIT_RANK_THRESHOLDS = [0, 2, 5, 9];

export const TYPES = {
  militia: { name: '民兵', icon: '⚒', level: 1, hp: 10, atk: 4, def: 2, move: 3, range: 1, cost: 16, domain: 'land', text: '低成本守备步兵。' },
  scout: { name: '侦察兵', icon: '♞', level: 1, hp: 8, atk: 3, def: 1, move: 5, range: 1, cost: 18, domain: 'land', text: '高机动侦察与抢点单位。' },
  spearman: { name: '长枪兵', icon: '⚔', level: 1, hp: 13, atk: 5, def: 4, move: 3, range: 1, cost: 26, domain: 'land', text: '克制骑兵的坚实前排。', bonusVs: { cavalry: 3 } },
  swordsman: { name: '剑士', icon: '♟', level: 2, hp: 15, atk: 6, def: 5, move: 3, range: 1, cost: 32, domain: 'land', text: '均衡的主力近战。' },
  archer: { name: '弓箭手', icon: '♜', level: 2, hp: 9, atk: 5, def: 2, move: 2, range: 2, cost: 34, domain: 'land', text: '稳定远程输出。' },
  crossbow: { name: '弩手', icon: '✚', level: 2, hp: 10, atk: 7, def: 2, move: 2, range: 2, cost: 40, domain: 'land', text: '高爆发集火兵种。' },
  engineer: { name: '工程师', icon: '⚙', level: 2, hp: 11, atk: 3, def: 2, move: 3, range: 1, cost: 42, domain: 'land', text: '能在海边造船，或就地建立临时营地。', builder: true },
  cavalry: { name: '骑兵', icon: '♘', level: 3, hp: 16, atk: 8, def: 4, move: 5, range: 1, cost: 48, domain: 'land', text: '高机动冲锋单位。', charge: 2 },
  guard: { name: '近卫军', icon: '🛡', level: 3, hp: 20, atk: 7, def: 7, move: 3, range: 1, cost: 54, domain: 'land', text: '重装精锐，擅长守点。' },
  warship: { name: '战船', icon: '⛵', level: 2, hp: 20, atk: 8, def: 5, move: 4, range: 2, cost: 46, domain: 'sea', text: '主力海战单位。', bonusVs: { transport: 4 } },
  transport: { name: '运兵船', icon: '🚢', level: 2, hp: 18, atk: 2, def: 4, move: 5, range: 1, cost: 42, domain: 'sea', text: '一次最多搭载五个陆军单位。', transport: 5 }
};

export const SITE_META = {
  city: { name: '城市', icon: '🏛', income: 10, maxTier: 3, upgradeCosts: { 1: 12, 2: 26 }, domain: 'land' },
  shipyard: { name: '港口/造船厂', icon: '⚓', income: 8, maxTier: 3, upgradeCosts: { 1: 14, 2: 28 }, domain: 'sea' },
  camp: { name: '临时营地', icon: '⛺', income: 0, maxTier: 2, upgradeCosts: {}, domain: 'land' },
  oilSmall: { name: '小型油田', icon: '🛢', income: CITY_INCOME_BY_TIER[3] + CITY_INCOME_BY_TIER[1], maxTier: 1, upgradeCosts: {}, domain: null, supportTier: 0 },
  oilMedium: { name: '中型油田', icon: '🛢', income: CITY_INCOME_BY_TIER[3] + CITY_INCOME_BY_TIER[2], maxTier: 1, upgradeCosts: {}, domain: null, supportTier: 0 },
  oilLarge: { name: '大型油田', icon: '🛢', income: CITY_INCOME_BY_TIER[3] * 2, maxTier: 1, upgradeCosts: {}, domain: null, supportTier: 0 },
  barracksSmall: { name: '小型军营', icon: '🏕', income: 0, maxTier: 1, upgradeCosts: {}, domain: null, supportTier: 2 },
  barracksLarge: { name: '大型军营', icon: '🏕', income: 0, maxTier: 1, upgradeCosts: {}, domain: null, supportTier: 3 },
  fortress: { name: '海上堡垒', icon: '⬣', income: 5, maxTier: 1, upgradeCosts: {}, domain: null }
};

export const TERRAIN = {
  plain: { name: '草原', color: '#638f4e', cost: 1, def: 0, mark: '' },
  forest: { name: '森林', color: '#356641', cost: 2, def: 2, mark: '♣' },
  mountain: { name: '山脉', color: '#696b68', cost: 99, def: 4, mark: '▲' },
  road: { name: '道路', color: '#a4865c', cost: 1, def: 0, mark: '·' },
  water: { name: '海域', color: '#2d6f9e', cost: 1, def: 0, mark: '≈' }
};

export const MAPS = {
  frontier: { name: '边境河谷', sea: false },
  twinrivers: { name: '双河走廊', sea: false },
  highlands: { name: '高地山口', sea: false },
  plains: { name: '北方平原', sea: false },
  heartland: { name: '中心平原', sea: false },
  coast: { name: '海岸丘陵', sea: true },
  islands: { name: '群岛与海峡', sea: true },
  innersea: { name: '内海争夺', sea: true },
  grandbay: { name: '海湾登陆', sea: true },
  strait: { name: '裂海海峡', sea: true },
  archipelago: { name: '断链群岛', sea: true },
  random: { name: '随机大陆', sea: true }
};

export const MODES = { conquest: '征服', skirmish: '遭遇战', survival: '守城' };
export const SIZES = {
  small: { name: '小型 · 约 240 格', cells: 240 },
  medium: { name: '中型 · 约 450 格', cells: 450 },
  large: { name: '大型 · 约 720 格', cells: 720 },
  huge: { name: '巨型 · 约 1050 格', cells: 1056 },
  giant: { name: '超大 · 约 1800 格', cells: 1800 },
  colossal: { name: '史诗 · 约 2880 格', cells: 2880 }
};
export const ASPECTS = {
  wide: { name: '宽幅', ratio: 1.95 },
  standard: { name: '标准', ratio: 1.55 },
  square: { name: '方阵', ratio: 1 },
  tall: { name: '纵深', ratio: 0.72 }
};
export const COMPLEX = {
  low: { name: '低：开阔地', water: 0.03, forest: 0.08, mountain: 0.05 },
  medium: { name: '中：混合地形', water: 0.08, forest: 0.14, mountain: 0.09 },
  high: { name: '高：险峻复杂', water: 0.12, forest: 0.2, mountain: 0.14 }
};
export const DIFF = {
  easy: { name: '简单', lookahead: 1, economy: 0.85, production: 1, risk: 0.75 },
  medium: { name: '中等', lookahead: 2, economy: 1, production: 2, risk: 1 },
  brutal: { name: '冷酷', lookahead: 3, economy: 1.2, production: 3, risk: 1.2 },
  bridgehead: { name: '桥头(测试)', lookahead: 2, economy: 1, production: 2, risk: 1, scripted: true, script: 'bridgehead' },
  naval: { name: '海防(测试)', lookahead: 2, economy: 1, production: 2, risk: 1, scripted: true, script: 'naval' }
};
export const AGG = {
  cautious: { name: '谨慎', push: 0.72, preserve: 1.45, expansion: 0.7, retreatHp: 0.55, chase: 0.5, lowGoldReserve: 55, forestBias: 1.4 },
  balanced: { name: '均衡', push: 1, preserve: 1, expansion: 1, retreatHp: 0.38, chase: 1, lowGoldReserve: 35, forestBias: 1 },
  reckless: { name: '冲动', push: 1.35, preserve: 0.72, expansion: 1.55, retreatHp: 0.22, chase: 1.55, lowGoldReserve: 18, forestBias: 0.4 }
};
export const MAX_TURNS = 120;
export const MAX_CAMPS_PER_SIDE = 3;
export const MAX_STACK = 3;
// Realistic per-transport sealift used by AI overproduction heuristics (below raw capacity: loading + turnaround losses).
export const FERRY_THROUGHPUT = 3;
export const BRIDGEHEAD_DEFEND_FRACTION = 0.75;
