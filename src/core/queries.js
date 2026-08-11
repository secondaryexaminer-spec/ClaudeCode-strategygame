'use strict';
// 棋盘查询：格子里有什么、这一格能不能走、边界在哪。全是纯读取，没有任何副作用。
//
// 依赖注入方式见 game/movement.js 顶部对 rt 门面的说明。
//
// 【这一层是整个项目调用最频繁的代码】
// getUnit / isLandTile 这类函数在 AI 的每次寻路里都会被调几千次。它们现在是
// 数组线性查找（`game.units.find(...)`），在几百个单位的规模下完全够用 ——
// **不要提前优化成 Map 索引**：那需要在每次移动/生成/阵亡时同步索引，而那些写入
// 点散布在 combat / transport / build / worldgen 四个模块里，漏一处就会产生
// "看得见但查不到"的幽灵单位。真要优化，先给写入点收口。
//
// 【inBounds 的检查不能省】
// isLandTile / isWaterTile 都先查边界再读 game.terrain[y][x]。少了这一步，
// 越界访问会拿到 undefined 而不是抛错 —— 然后 `undefined !== 'water'` 是 true，
// 地图外面就全变成了陆地，AI 会试图走出去。
//
// 【isDeepWater 扫的是 5×5 而不是 3×3】
// 深海的定义是"离陆地至少两格"，用来决定海上堡垒能放在哪。改成 3×3 会让堡垒
// 贴着海岸生成，失去"深海据点"的意义；改大则可能在小地图上一个都放不下。
import { inBounds as gridInBounds, adjacent4 as gridAdjacent4, adjacent8 as gridAdjacent8 } from './grid.js';

export function createQueries(rt) {
  // 下面三个是 core/grid.js 的薄封装，替调用方补上当前地图尺寸 W、H。
  function inBounds(x, y) {
    return gridInBounds(rt.W, rt.H, x, y);
  }

  function adjacent4(x, y) {
    return gridAdjacent4(rt.W, rt.H, x, y);
  }

  function adjacent8(x, y) {
    return gridAdjacent8(rt.W, rt.H, x, y);
  }

  // 同一格可能叠放多个单位（只可能由运输船卸载产生）。getUnit 返回最上面那个，
  // unitsAt 返回全部 —— 需要遍历整摞时（选中切换、堆叠计数）必须用后者。
  function getUnit(x, y) {
    return rt.game.units.find(entry => entry.x === x && entry.y === y);
  }

  function unitsAt(x, y) {
    return rt.game.units.filter(entry => entry.x === x && entry.y === y);
  }

  // 据点每格最多一个，不存在叠放。
  function getSite(x, y) {
    return rt.game.sites.find(entry => entry.x === x && entry.y === y);
  }

  // 山脉不算陆地：陆军进不去，但它也不是水，海军同样进不去。
  function isLandTile(x, y) {
    return inBounds(x, y) && rt.game.terrain[y][x] !== 'water' && rt.game.terrain[y][x] !== 'mountain';
  }

  function isWaterTile(x, y) {
    return inBounds(x, y) && rt.game.terrain[y][x] === 'water';
  }

  // 贴岸的水格：港口和船坞只能建在这里，运输船也只能从这里卸载。
  function isCoastalWater(x, y) {
    return isWaterTile(x, y) && adjacent8(x, y).some(cell => isLandTile(cell.x, cell.y));
  }

  // 离陆地至少两格的水格，海上堡垒专用。范围见文件头。
  function isDeepWater(x, y) {
    if (!isWaterTile(x, y)) {
      return false;
    }
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        if (isLandTile(x + dx, y + dy)) {
          return false;
        }
      }
    }
    return true;
  }

  // 比较的是坐标不是引用 —— 调用方常常拿一个 {x, y} 字面量来比。
  function sameCell(a, b) {
    return !!a && !!b && a.x === b.x && a.y === b.y;
  }

  // game.selected 记的是「点了什么」，但面板要分别显示单位卡和据点卡。
  // 点单位时 selected.site 是它脚下的据点，点据点时 selected.unit 是驻军 ——
  // 所以这两个函数都要看 kind 再决定读 ref 还是读另一个字段。
  // 写成 `selected.unit` 一把梭会在"点据点"时拿不到 ref 本身。
  function selectedUnit() {
    const game = rt.game;
    if (!game?.selected) {
      return null;
    }
    return game.selected.kind === 'unit' ? game.selected.ref : game.selected.unit || null;
  }

  function selectedSite() {
    const game = rt.game;
    return game?.selected?.kind === 'site' ? game.selected.ref : game?.selected?.site || null;
  }

  return {
    inBounds, adjacent4, adjacent8,
    getUnit, unitsAt, getSite,
    isLandTile, isWaterTile, isCoastalWater, isDeepWater, sameCell,
    selectedUnit, selectedSite
  };
}
