'use strict';
// 无头测试钩子：挂到 window.__frontierDebug 上，供 sim/ 下的工具调用。
//
// 【为什么这些东西存在于生产代码里】
// 这个游戏没有 DOM 环境之外的入口 —— 打包产物就是一个立即执行的闭包，内部函数
// 一个都不导出。sim/harness.js 靠 eval 加载同一份 js/game.js，只能通过这个对象
// 拿到内部状态。所以这不是"调试残留"，而是无头测试**唯一**的接口。
//
// 【接收 deps 而不是全塞进 rt】
// 下面用到的十几个函数（fastBatch、drawPreview、renderSaveList……）只有测试会调，
// 游戏模块之间谁也不需要它们。塞进 rt 会让运行时门面里混进一批"只为测试而存在"
// 的项，读的人分不清哪些是真依赖。所以这里走一个显式的 deps 参数。
//
// 【三个 repaint* 是干什么的】
// refresh() 开头有 `if (fastSim) return;`，而行为基线（npm run verify）跑的全是
// fastBatch —— 界面层一行都不会执行。非 fastSim 下也不行：newGame 把首回合交给
// runLoadingScreen 的 setInterval，同步代码里等不到。这三个入口就是强行同步跑一遍
// 界面层，让 sim/smoke-render.js 能在无头环境里抓到 undefined / NaN。
//
// 加新钩子前先想清楚：它是不是**只能**从这里进？如果游戏逻辑本身能提供等价的
// 观测点，优先改那边 —— 这个对象越大，生产代码为测试付出的代价越高。
import { typeMeta } from '../core/utils.js';

export function createDebugHooks(rt, deps) {
  const {
    debugSummary, fastRun, fastBatch, newGame, resolveStalemate,
    draw, refresh, renderStatsSummary, drawStatsChart,
    drawPreview, renderSaveList, renderLobbyPreview, onBoard
  } = deps;

  // 强制同步走一遍棋盘绘制。
  function redraw() {
    if (!rt.game) {
      return false;
    }
    draw();
    return true;
  }

  // 同上，但覆盖面板层（src/ui/panels.js）。
  //
  // 面板的分支几乎全挂在「当前选中的是什么」上：没选中 / 选中普通单位 /
  // 选中工程师 / 选中运兵船 / 选中据点 / 选中船厂，各走一段不同的代码。
  // 只刷一次默认状态（没选中）等于只覆盖了其中一段，剩下的照样是盲区。
  // 所以这里逐个换选中态各刷一遍，最后还原。
  //
  // 直接写 game.selected 而不是走 selectRef()：selectRef 会顺手清掉
  // pendingOrder，属于操作语义；这里只想触发重绘，不想改游戏状态。
  function repaintUi() {
    const game = rt.game;
    if (!game) {
      return false;
    }
    const prevSelected = game.selected;
    const pickUnit = predicate => game.units.find(predicate) || null;
    const refs = [
      { kind: 'unit', ref: pickUnit(entry => entry.owner === 'player') || game.units[0] || null },
      { kind: 'unit', ref: pickUnit(entry => entry.type === 'engineer') },
      { kind: 'unit', ref: pickUnit(entry => typeMeta(entry.type).transport) },
      { kind: 'site', ref: game.sites[0] || null },
      { kind: 'site', ref: game.sites.find(entry => entry.kind === 'shipyard') || null },
      { kind: null, ref: null }
    ];
    for (const item of refs) {
      game.selected = item.ref
        ? {
          kind: item.kind,
          ref: item.ref,
          unit: item.kind === 'unit' ? item.ref : rt.getUnit(item.ref.x, item.ref.y),
          site: item.kind === 'site' ? item.ref : rt.getSite(item.ref.x, item.ref.y)
        }
        : null;
      refresh();
    }
    game.selected = prevSelected;
    refresh();
    return true;
  }

  // 统计面板也在 fastSim 短路之后，同样需要一个同步入口。
  // animate=false：动画走 requestAnimationFrame，无头环境里那个回调永远不会跑。
  function repaintStats() {
    if (!rt.game) {
      return false;
    }
    renderStatsSummary(false);
    drawStatsChart();
    return true;
  }

  // 大厅那几个渲染函数里，只有 fillSelectOptions / renderRules / renderCodex /
  // renderAISettings / renderLobbyPreview 会在 setup() → showScreen('setup') 里
  // 跑到（harness 建立时就触发了）；drawPreview 要等 runLoadingScreen、
  // renderSaveList 要等进读档页 —— 这两个在无头环境里一次都不会执行。
  //
  // ⚠️ 顺序不能换：renderLobbyPreview 会按大厅的下拉框重算 W / H，
  // 而 drawPreview 读的是当前这局的 game.terrain。反过来的话尺寸对不上，
  // 会越界读出 undefined。也因为它改全局尺寸，调用方应该把它放在一个用例的
  // 最后 —— 之后再调 redraw() 画出来的就不是这局的地图了。
  function repaintLobby() {
    if (!rt.game) {
      return false;
    }
    drawPreview();
    renderSaveList();
    renderLobbyPreview();
    return true;
  }

  // 合成一次棋盘点击。ui/input.js 的 onBoard 是玩家唯一的操作入口，而它在无头
  // 环境里本来完全没有覆盖 —— fastBatch 不产生鼠标事件。
  //
  // 这里把格子坐标反算成 clientX/clientY 再喂给 onBoard，走的是和真实点击一模
  // 一样的路径（包括 getBoundingClientRect 的换算），而不是绕过它直接调内部
  // 函数 —— 绕过去就测不到坐标换算写错这类错了。
  //
  // 返回点击后的选中态摘要，方便调用方断言"点了确实有反应"。
  function clickCell(x, y) {
    const game = rt.game;
    if (!game) {
      return null;
    }
    const canvas = rt.canvas;
    const rect = canvas.getBoundingClientRect();
    const scaleX = rect.width ? canvas.width / rect.width : 1;
    const scaleY = rect.height ? canvas.height / rect.height : 1;
    // tileFromEvent 的逆运算，取格子中心避免落在边界上。
    const px = ((x + 0.5) * rt.S - rt.cam.x) * rt.zoom;
    const py = ((y + 0.5) * rt.S - rt.cam.y) * rt.zoom;
    onBoard({ clientX: rect.left + px / scaleX, clientY: rect.top + py / scaleY });
    return {
      kind: game.selected?.kind || null,
      id: game.selected?.ref?.id || null,
      x: game.selected?.ref?.x ?? null,
      y: game.selected?.ref?.y ?? null
    };
  }

  return {
    summary: () => debugSummary(),
    run: (cap = 150) => fastRun(cap),
    batch: (cap = 150, rounds = 10, seed = 20260804) => fastBatch(cap, rounds, seed),
    // 强行判定当前对局，用来在跑飞了的时候拿到一个结果而不是死等。
    stop: () => {
      if (rt.game && !rt.game.over) {
        resolveStalemate();
      }
      return debugSummary();
    },
    newGame: () => newGame(),
    redraw, repaintUi, repaintStats, repaintLobby, clickCell
  };
}
