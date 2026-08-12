'use strict';
// 规则配置（RulesConfig）：一局游戏的所有可调参数，以及它们从哪来、怎么兜底。
//
// 【为什么要有这一层】
// 这些字段原来是 game/newgame.js 里一串 `$('xxxSelect').value` 直接读 DOM。
// 那样有三个问题：
//   1. 没有 DOM 就构造不出配置 —— 测试、回放、将来的关卡预设都无从下手
//   2. 控件缺失或被手改时 `Number('')` 得到 0、`Number('abc')` 得到 NaN，
//      而 NaN 会一路飘进地图生成，直到某个坐标算出 NaN 才炸
//   3. "有哪些可调参数"这个问题，答案散在读取代码里
//
// 现在读取源是可替换的：`readRules(id => ...)` 传什么进去都行，大厅的下拉框
// 只是其中一种。
//
// 【范围是照抄 index.html 的，不是拍脑袋定的】
// min / max 必须和控件上写的完全一致，否则钳制会**改变现有行为**。
// 实际差点踩到：citySpread 的 min 是 0（不是 1），buildCap 的 max 是 100
// （不是随手写的 999）。改这里之前先去 index.html 核对那个控件。
//
// 【select 类字段不钳范围】
// 它们的合法值是一份动态填充的选项列表（见 ui/lobby.js 的 fillSelectOptions），
// 钳成数值区间没有意义。这类字段只做类型转换和空值兜底。

// kind: text 原样取字符串 / int 取整数 / number 取小数
// min、max 只在**控件上确实标了范围**时才写，见文件头。
export const RULES_FIELDS = {
  map: { from: 'mapSelect', kind: 'text', fallback: 'strait' },
  mode: { from: 'modeSelect', kind: 'text', fallback: 'conquest' },
  start: { from: 'startUnitsSelect', kind: 'int', fallback: 6 },
  size: { from: 'sizeSelect', kind: 'text', fallback: 'medium' },
  aspect: { from: 'aspectSelect', kind: 'text', fallback: 'standard' },
  complexity: { from: 'complexitySelect', kind: 'text', fallback: 'medium' },
  deploy: { from: 'deploymentSelect', kind: 'text', fallback: 'tight' },
  // 以下三个是 <input type="range">，范围抄自 index.html。
  aiSpeed: { from: 'aiSpeed', kind: 'int', fallback: 3, min: 1, max: 10 },
  spread: { from: 'citySpread', kind: 'int', fallback: 50, min: 0, max: 100 },
  buildCap: { from: 'buildCap', kind: 'int', fallback: 100, min: 1, max: 100 },
  // 以下两个是 <select>，值是 0.5 / 1 / 1.5 这类倍率，不钳范围。
  incomeMult: { from: 'incomeMult', kind: 'number', fallback: 1 },
  siteDensity: { from: 'siteDensity', kind: 'number', fallback: 1 }
};

// 不来自单个控件的字段，必须由调用方显式给出：
//   spectator —— 观战开关，还要看有没有玩家阵营
//   ai        —— AI 数量，要数 AI 配置块
//   teams / ownerColors / aiProfiles 同理，它们在 readLobbyConfig 里算
const EXTERNAL_FIELDS = ['spectator', 'ai'];

function coerce(raw, field) {
  if (field.kind === 'text') {
    // 空字符串当成"没选"，而不是一个叫 "" 的地图。
    return raw === undefined || raw === null || raw === '' ? field.fallback : String(raw);
  }
  const value = field.kind === 'int' ? parseInt(raw, 10) : Number(raw);
  if (!Number.isFinite(value)) {
    return field.fallback;
  }
  // 只有声明了范围的字段才钳，理由见文件头。
  if (field.min !== undefined && value < field.min) {
    return field.min;
  }
  if (field.max !== undefined && value > field.max) {
    return field.max;
  }
  return value;
}

// 从任意读取源构造一份规则配置。
//
// readValue(id) 返回那个控件的原始值（通常是字符串）。传 DOM 读取器就是从大厅读，
// 传一个查表函数就是从预设读 —— 这一层不关心。
export function readRules(readValue, external = {}) {
  const out = {};
  for (const [key, field] of Object.entries(RULES_FIELDS)) {
    out[key] = coerce(readValue(field.from), field);
  }
  for (const key of EXTERNAL_FIELDS) {
    out[key] = external[key];
  }
  return out;
}

// 校验一份已有的配置（例如从存档里读出来的 settings），补齐缺失字段。
// 返回 { config, fixed }，fixed 列出被兜底或钳制过的字段名 —— 调用方可以据此
// 决定要不要提示用户"这份存档的某些设置已被修正"。
//
// 未知字段原样保留：将来加了新选项、用新版存的档拿到旧版打开时，旧版认不出
// 那个字段，但也不该把它丢掉 —— 存回去时还能带着。
export function normalizeRules(raw) {
  const source = raw || {};
  const out = {};
  const fixed = [];
  for (const [key, field] of Object.entries(RULES_FIELDS)) {
    const before = source[key];
    const after = coerce(before, field);
    out[key] = after;
    // 字符串和数字分开比：'6' 和 6 在语义上一致，不该报成"被修正"。
    if (before !== undefined && String(before) !== String(after)) {
      fixed.push(key);
    }
  }
  return { config: { ...source, ...out }, fixed };
}
