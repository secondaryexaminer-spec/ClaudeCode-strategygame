'use strict';
// 存档结构（SaveState）：一份存档里有什么、哪些字段不进存档、版本怎么升。
//
// 【和 io/saves.js 的分工】
// 这里管**结构**：字段、版本、校验、迁移。saves.js 管**仓储**：存在哪、
// 怎么列表、怎么删。换存档格式只动这里，换存储后端只动 io/storage.js。
//
// 【为什么默认全存，而不是列一份白名单】
// 下面的 toSaveState 用的是"排除法"：game 的字段默认全部进存档，只有
// TRANSIENT_FIELDS 里点名的不进。反过来写白名单看似更严谨，实则更危险 ——
// 往 game 上加一个字段时，忘记加进白名单不会报任何错，只会让读档后那个字段
// 悄悄变成 undefined，而这类 bug 往往要到几十回合后才暴露。
// 排除法的默认行为（存进去）是安全的一侧，遗漏的代价只是存档大了一点。
//
// 【版本号什么时候要升】
//   加字段            → 不用升。旧存档读进来该字段是 undefined，只要代码里
//                       有默认值处理就行。
//   改字段含义 / 改名 → **必须升**，并在 MIGRATIONS 里写一条迁移。
//   删字段            → 必须升。
// 不升版本就改结构，表现是旧存档读进来能开局但行为诡异 —— 比默认崩溃难查得多。

// 当前存档格式版本。
export const SAVE_VERSION = 2;

// 不进存档的运行时字段。键是字段名，值是"为什么不存"—— 写清楚理由，
// 否则后来的人（包括未来的自己）会不确定这是有意排除还是漏了。
const TRANSIENT_FIELDS = {
  selected: '当前选中的是谁，纯界面状态。读档后应当是"什么都没选"',
  pendingOrder: '工程师的待下水指令，是个做到一半的操作。读档后应当清空'
};

// 读档时必须存在的字段。少了任何一个，游戏会在开局后的某一步崩掉或行为异常，
// 而且往往不在读档那一刻崩 —— 所以宁可在入口拦住，给一句明确的错。
const REQUIRED_STATE_FIELDS = [
  'terrain', 'units', 'sites', 'ownerOrder', 'side', 'turn',
  'teams', 'goldByOwner', 'settings'
];

// 版本迁移。键是"从哪个版本升"，值是把 payload 改写成下一版的函数。
//
// 1 → 2：早期存档没有 version 字段。结构本身没变，这一步只是补上版本号
// —— 框架先立起来，等真正改结构时有地方落笔。
const MIGRATIONS = {
  1: payload => ({ ...payload, version: 2 })
};

// 把当前对局打包成可序列化的存档体。
export function toSaveState(game, dimensions, name) {
  const state = {};
  for (const [key, value] of Object.entries(game)) {
    if (!(key in TRANSIENT_FIELDS)) {
      state[key] = value;
    }
  }
  return {
    version: SAVE_VERSION,
    name,
    savedAt: Date.now(),
    turn: game.turn,
    W: dimensions.W,
    H: dimensions.H,
    S: dimensions.S,
    state
  };
}

// 校验一份存档能不能读。返回 null 表示没问题，否则返回一句人话说明哪里不对。
//
// 为什么不抛异常：调用方（读档、导出、导入）都需要把失败转成 toast 文案，
// 抛异常会让每个调用点都得包一层 try/catch。
export function validateSaveState(payload) {
  if (!payload || typeof payload !== 'object') {
    return '存档内容不是一个对象';
  }
  if (!payload.state || typeof payload.state !== 'object') {
    return '存档缺少 state 字段';
  }
  for (const field of REQUIRED_STATE_FIELDS) {
    if (payload.state[field] === undefined) {
      return `存档的 state 里缺少必需字段 ${field}`;
    }
  }
  if (!Number.isFinite(payload.W) || !Number.isFinite(payload.H) || !Number.isFinite(payload.S)) {
    return '存档里的地图尺寸（W / H / S）不是数字';
  }
  if (!Array.isArray(payload.state.terrain) || payload.state.terrain.length !== payload.H) {
    return `存档的地形高度与 H 对不上（H=${payload.H}）`;
  }
  return null;
}

// 把任意版本的存档升到当前版本。无法迁移时返回 null。
//
// 没有 version 字段的一律当作版本 1 —— 那是加版本号之前存下来的档。
export function migrateSaveState(payload) {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  let current = payload;
  let version = Number(current.version) || 1;
  // 比当前版本还新的存档不敢读：它可能含有这个版本理解不了的结构。
  if (version > SAVE_VERSION) {
    return null;
  }
  while (version < SAVE_VERSION) {
    const step = MIGRATIONS[version];
    if (!step) {
      return null;
    }
    current = step(current);
    version = Number(current.version) || version + 1;
  }
  return current;
}

// 读档入口：迁移 + 校验一次做完。返回 { payload } 或 { error }。
export function parseSaveState(raw) {
  const migrated = migrateSaveState(raw);
  if (!migrated) {
    const version = raw && raw.version;
    return { error: version > SAVE_VERSION ? `存档版本 ${version} 比当前支持的 ${SAVE_VERSION} 还新` : '存档版本无法识别' };
  }
  const problem = validateSaveState(migrated);
  return problem ? { error: problem } : { payload: migrated };
}
