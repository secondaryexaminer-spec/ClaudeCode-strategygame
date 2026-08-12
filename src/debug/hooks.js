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
import { unit } from '../game/entities.js';
import { MAP_DEFS } from '../core/mapdefs.js';
import { terrainFor } from '../world/mapgen.js';

export function createDebugHooks(rt, deps) {
  const {
    debugSummary, fastRun, fastBatch, newGame, resolveStalemate,
    draw, refresh, renderStatsSummary, drawStatsChart,
    drawPreview, renderSaveList, renderLobbyPreview,
    onBoard, zoomAt, beginPan, panBy, endPan
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

  // 摆棋盘：在指定格子放一个单位，返回它的 id。
  //
  // 为什么需要它：onBoard 的装载 / 卸载 / 攻击 / 工程师下水四条分支，都要求场上
  // 存在特定的组合（运兵船旁边有陆军、敌人在射程内、工程师站在靠海陆格）。
  // 随机开局不保证出现这些组合 —— 上一版烟雾测试就因此只覆盖到"选中"和"移动"
  // 两条分支。与其等运气，不如直接摆出来。
  //
  // ⚠️ 它绕过了所有校验（金币、兵种上限、地形限制），是纯测试设施。
  // 生产代码里没有任何东西调用它。
  function placeUnit(type, owner, x, y) {
    if (!rt.game) {
      return null;
    }
    const entry = unit(type, owner, x, y);
    rt.game.units.push(entry);
    return entry.id;
  }

  // 读一个格子上的单位详情。debugSummary 出于基线稳定性只带最少字段，
  // 这里补上 cargo / move / hasAttacked 这些断言交互链需要的东西。
  function inspectCell(x, y) {
    const entry = rt.getUnit(x, y);
    if (!entry) {
      return null;
    }
    return {
      id: entry.id, type: entry.type, owner: entry.owner,
      x: entry.x, y: entry.y, hp: entry.hp, move: entry.move,
      hasAttacked: !!entry.hasAttacked,
      cargo: (entry.cargo || []).map(item => item.type)
    };
  }

  // 给工程师挂上「待下水」指令，等价于在面板上点了「在相邻海格建造战船」。
  // 之后点海格才会真正造船 —— 那一步走的是 onBoard 的第 2 条分支。
  //
  // 直接写 pendingOrder 而不是模拟点面板按钮：按钮的点击处理在 ui/bindings.js，
  // 那一层已经有「绑定检查」在管；这里要测的是 onBoard 拿到 pendingOrder 之后
  // 的行为。
  function armEngineerLaunch(builderId, product, cargoTypes = []) {
    const game = rt.game;
    if (!game) {
      return false;
    }
    const builder = game.units.find(entry => entry.id === builderId);
    if (!builder || builder.type !== 'engineer') {
      return false;
    }
    game.pendingOrder = { kind: 'engineer-launch', builderId, product, cargoTypes };
    return true;
  }

  // 地形与尺寸查询。烟雾测试要在图上找"空的海格挨着空的陆格"这类位置来摆棋盘，
  // 而 debugSummary 只带单位和据点，不带地形。
  function terrainAt(x, y) {
    if (!rt.game || !rt.inBounds(x, y)) {
      return null;
    }
    return rt.game.terrain[y][x];
  }

  // 不开局，直接生成一张地形出来。
  //
  // 为什么需要：地图定义数据化之后（core/mapdefs.js），一张图的 steps 写错
  // （op 拼错、少个字段、半径写成相对的）**只会毁掉那一张图**。而 verify 的
  // 6 个场景只用到 4 张图、smoke 的用例再补 2 张 —— 12 张里有一半从来没有
  // 任何测试跑过它。逐张开局太慢，所以开一个直通地形生成的口子。
  function probeTerrain(mapId, complexityId, w, h) {
    return terrainFor(mapId, complexityId, w, h);
  }

  // 有哪些地图。让测试遍历时不必自己维护一份清单 —— 那种清单迟早和
  // core/mapdefs.js 对不上，而且是静默对不上。
  function mapCatalog() {
    return Object.entries(MAP_DEFS).map(([id, def]) => ({ id, name: def.name, sea: !!def.sea }));
  }

  function dimensions() {
    return { w: rt.W, h: rt.H, cell: rt.S };
  }

  // 当前选中态。**不放进 debugSummary** —— 那个的字段是行为基线的一部分，
  // 加字段会让 sim/baseline.json 整体失效。这里单开一个入口。
  function selection() {
    const selected = rt.game?.selected;
    return {
      kind: selected?.kind || null,
      id: selected?.ref?.id || null,
      x: selected?.ref?.x ?? null,
      y: selected?.ref?.y ?? null
    };
  }

  // 合成一次滚轮缩放。deltaY < 0 是放大。
  // 走的是真实的 wheel 处理链（zoomAt → clampCam），所以缩放中心的换算写错了
  // 会体现在 cam 上。
  function wheelZoom(deltaY, x = 0, y = 0) {
    if (!rt.game) {
      return null;
    }
    const rect = rt.canvas.getBoundingClientRect();
    zoomAt({ clientX: rect.left + x, clientY: rect.top + y, deltaY, preventDefault() {} });
    return { zoom: rt.zoom, camX: Math.round(rt.cam.x), camY: Math.round(rt.cam.y) };
  }

  // 合成一次右键拖拽：按下 → 移动 → 抬起。返回过程中摄像机有没有真的动。
  // button: 2 是右键 —— beginPan 只认右键，传别的值应该什么都不发生。
  function dragPan(dx, dy, button = 2) {
    if (!rt.game) {
      return null;
    }
    const before = { x: rt.cam.x, y: rt.cam.y };
    beginPan({ button, clientX: 0, clientY: 0 });
    const moved = panBy({ clientX: dx, clientY: dy });
    endPan({ button });
    return { handled: !!moved, camMoved: rt.cam.x !== before.x || rt.cam.y !== before.y };
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
    redraw, repaintUi, repaintStats, repaintLobby,
    clickCell, placeUnit, inspectCell, selection, terrainAt, dimensions,
    probeTerrain, mapCatalog,
    armEngineerLaunch, wheelZoom, dragPan
  };
}
