'use strict';
// 阵营：名字、颜色、组别、敌友判定。
//
// 依赖注入方式见 game/movement.js 顶部对 rt 门面的说明。
//
// 【owner 是字符串，不是对象】
// 全局只有三种取值：'player'、'ai0'~'ai6'、'neutral'。AI 的编号靠
// `Number(owner.slice(2))` 从字符串里切出来 —— 所以 **owner 的命名格式是个隐式契约**，
// 大厅的 `ai${i}Diff` 下拉框 id、sim/harness.js 的打桩、存档格式全都依赖它。
// 想改成 `{ id, team }` 这样的对象，得连存档迁移一起做。
//
// 【敌友是按"组"判定的，不是按 owner】
// 每个 owner 属于一个组（game.teams），同组即盟友。所以 3 个 AI 可以两两结盟对抗
// 玩家，也可以互为敌人。areAllies 的三条捷径顺序不能换：
//   1. 任一方为空 → 不是盟友（防御性判断，别让 undefined 传染）
//   2. 两者相同   → 是盟友（自己和自己）
//   3. 任一方中立 → 不是盟友（中立不结盟，但也不主动敌对）
// 少了第 3 条，中立据点会被当成同组，AI 就不去占它了。
//
// 【areEnemies ≠ !areAllies】
// 中立方对所有人都既非盟友也非敌人。写成取反会让 AI 去打中立城市里的空气。
import { OWNER_NAMES, OWNER_COLORS, SIZES, ASPECTS } from '../core/constants.js';

export function createOwners(rt) {
  function teamOf(owner) {
    return rt.game?.teams?.[owner] || 'A';
  }

  function areAllies(a, b) {
    if (!a || !b) {
      return false;
    }
    if (a === b) {
      return true;
    }
    if (a === 'neutral' || b === 'neutral') {
      return false;
    }
    return teamOf(a) === teamOf(b);
  }

  // 见文件头：不能写成 !areAllies。
  function areEnemies(a, b) {
    return !!a && !!b && a !== 'neutral' && b !== 'neutral' && !areAllies(a, b);
  }

  // 玩家在大厅里选的颜色存在 game.ownerColors 里；没有对局时退回默认色板。
  function ownerColor(owner) {
    if (rt.game?.ownerColors?.[owner]) {
      return rt.game.ownerColors[owner];
    }
    if (owner === 'player') {
      return '#55a3ff';
    }
    if (owner === 'neutral') {
      return '#d4b15a';
    }
    return OWNER_COLORS[Number(owner.slice(2))] || OWNER_COLORS[0];
  }

  // 带组别的全名，用于日志和面板。
  function ownerName(owner) {
    if (owner === 'player') {
      return `蓝方·${teamOf(owner)}组`;
    }
    if (owner === 'neutral') {
      return '中立势力';
    }
    return `${OWNER_NAMES[Number(owner.slice(2))] || '敌军'}·${teamOf(owner)}组`;
  }

  // 不带组别的短名，用于空间紧张的地方。
  function ownerShort(owner) {
    if (owner === 'player') {
      return '你方';
    }
    if (owner === 'neutral') {
      return '中立';
    }
    return `AI ${Number(owner.slice(2)) + 1}`;
  }

  // 出手顺序 = game.ownerOrder。没有对局时返回空数组 —— 调用方（图例、统计图表）
  // 都是 forEach，空数组等于什么都不画，正好是想要的。
  function ownerOrder() {
    return rt.game ? rt.game.ownerOrder : [];
  }

  function ownerExists(owner) {
    return rt.game.units.some(entry => entry.owner === owner) || rt.game.sites.some(entry => entry.owner === owner);
  }

  function tierName(tier) {
    return ['', '初级', '中级', '高级'][tier] || '特殊';
  }

  function domainName(domain) {
    return domain === 'sea' ? '海军' : '陆军';
  }

  // 由「尺寸档位 + 纵横比」算出格数。先按面积和比例求宽，再反推高，
  // 最后按 tall / wide 强制方向 —— 因为四舍五入可能让结果偏到反方向去。
  // 大厅预览和实际开局都用它，两边必须一致（见 ui/lobby.js 文件头）。
  function computeDimensions(sizeKey, aspectKey) {
    const base = SIZES[sizeKey];
    const ratio = ASPECTS[aspectKey].ratio;
    const area = base.cells;
    let width = Math.max(16, Math.round(Math.sqrt(area * ratio)));
    let height = Math.max(12, Math.round(area / width));
    if (aspectKey === 'tall' && height < width) {
      [width, height] = [height, width];
    }
    if (aspectKey === 'wide' && width < height) {
      [width, height] = [height, width];
    }
    return { w: width, h: height };
  }

  return {
    teamOf, areAllies, areEnemies, ownerColor, ownerName, ownerShort,
    ownerOrder, ownerExists, tierName, domainName, computeDimensions
  };
}
