'use strict';
// 棋盘交互：把一次鼠标事件翻译成一个游戏动作。
//
// 依赖注入方式见 game/movement.js 顶部对 rt 门面的说明。
//
// 【onBoard 的分支顺序就是规则本身，不要重排】
// 玩家只有一个操作入口：在棋盘上点一下。这一下到底是"选中"、"移动"、"攻击"、
// "装载"还是"卸载"，全靠 onBoard 里那一长串 if 的**顺序**来判定 —— 每个分支都以
// return 结尾，先匹配上的赢。所以这些 if 不是可以随便调换的并列条件，它们是有
// 优先级的决策链：
//
//   1. 观战模式  —— 只允许查看，任何操作都不生效
//   2. 待下水指令 —— 有 pendingOrder 时点击海格 = 完成建造，优先于一切
//   3. 装载 / 卸载 —— 运兵船与陆军的交互，优先于"选中"
//   4. 点到自己的单位 —— 选中（同格叠放时循环切换）
//   5. 攻击 —— 点到射程内的敌人
//   6. 点到别人的单位 —— 只选中看信息，不能指挥
//   7. 移动 —— 点到空格
//   8. 点到据点 —— 选中
//
// 举个具体的例子说明顺序为什么要紧：第 4 条（点自己的单位=选中）必须排在第 5 条
// （攻击）前面，否则同盟单位站在一起时会互相攻击；而第 3 条（装载）又必须排在
// 第 4 条前面，否则运兵船永远装不上人 —— 点陆军会变成"改选中它"。
//
// 【能不能做，由被调用的函数说了算】
// onBoard 只负责派发，不重复判定规则：canAttack / canLoadTransport /
// canEngineerLaunch / moveUnit 各自返回真假，onBoard 只看结果。所以改规则改的是
// 那些函数，这个文件不用动。
//
// 【摄像机交互为什么也在这里】
// zoomAt / panBy / beginPan 处理的是"鼠标怎么变成摄像机位移"，和 onBoard 一样是
// 输入翻译；真正的坐标夹取在 render/board.js 的 clampCam 里。分界线是：这个文件
// 只懂事件（clientX/clientY、按键、滚轮方向），board.js 只懂世界坐标。
//
// 【这个模块是 verify 的盲区】
// 行为基线（npm run verify）跑的是 fastBatch，不会有任何鼠标事件 —— 这个文件
// 整个删掉，基线照样全绿。
//
// 兜底的是 sim/smoke-render.js：它通过 __frontierDebug.clickCell(x, y) 把格子
// 坐标反算成 clientX/clientY 再喂给 onBoard，走的是和真实点击**完全相同**的路径
// （包括 getBoundingClientRect 换算），所以坐标换算写错会被抓住；另外还有一个
// 非观战用例专门验"选中 → 点邻格 → 单位真的动了"这条链。
//
// 但覆盖仍然是局部的，**改完还是要开浏览器点一遍**。目前没测到的：
//   - 装载 / 卸载 / 攻击 / 工程师下水这几条分支
//   - 摄像机交互（zoomAt / beginPan / panBy / endPan）一行没跑
//   - contextmenu 抑制逻辑
import { clamp } from '../core/utils.js';

export function createInput(rt) {
  // 右键拖拽平移的状态。moved 用来区分"拖拽结束"和"单纯右键点一下"——
  // 前者要吞掉紧跟着的 contextmenu 事件，后者不用。
  let panState = null;
  let panSuppressContext = false;

  // 屏幕坐标 → 格子坐标。canvas 的 CSS 尺寸和它的像素尺寸可以不一样
  // （响应式布局会拉伸它），所以要先按 width/rect.width 换算回像素，
  // 再除以 zoom 和格子边长 S。少任何一步，缩放后点击就会偏。
  function tileFromEvent(event) {
    const canvas = rt.canvas;
    const rect = canvas.getBoundingClientRect();
    const sx = (event.clientX - rect.left) * canvas.width / rect.width;
    const sy = (event.clientY - rect.top) * canvas.height / rect.height;
    return {
      x: Math.floor((rt.cam.x + sx / rt.zoom) / rt.S),
      y: Math.floor((rt.cam.y + sy / rt.zoom) / rt.S)
    };
  }

  // 换选中目标时清掉待下水指令 —— 否则"选了工程师要造船 → 改选别的单位 →
  // 再点海格"会莫名其妙地把船造出来。同一个目标重复点则保留。
  function selectRef(kind, ref) {
    const game = rt.game;
    if (!ref || game.selected?.ref?.id !== ref.id) {
      rt.clearPendingOrder();
    }
    if (!ref) {
      game.selected = null;
      rt.refresh();
      return;
    }
    game.selected = {
      kind,
      ref,
      unit: kind === 'unit' ? ref : rt.getUnit(ref.x, ref.y),
      site: kind === 'site' ? ref : rt.getSite(ref.x, ref.y)
    };
    rt.refresh();
  }

  // 分支顺序即规则，见文件头。
  function onBoard(event) {
    const game = rt.game;
    if (!game || game.over) {
      return;
    }
    const cell = tileFromEvent(event);
    if (!rt.inBounds(cell.x, cell.y)) {
      return;
    }
    const targetUnit = rt.getUnit(cell.x, cell.y);
    const targetSite = rt.getSite(cell.x, cell.y);
    const currentUnit = game.selected?.kind === 'unit' ? game.selected.ref : null;
    // 只有玩家自己的单位能被指挥；别人的单位可以选中查看，但点不动。
    const ownUnit = currentUnit && currentUnit.owner === 'player' ? currentUnit : null;

    if (game.settings?.spectator) {
      if (targetUnit) {
        selectRef('unit', targetUnit);
        return;
      }
      if (targetSite) {
        selectRef('site', targetSite);
      }
      return;
    }

    if (game.pendingOrder?.kind === 'engineer-launch' && ownUnit && ownUnit.id === game.pendingOrder.builderId && rt.canEngineerLaunch(ownUnit, game.pendingOrder.product, cell, game.pendingOrder.cargoTypes)) {
      rt.engineerLaunch(ownUnit, game.pendingOrder.product, cell, game.pendingOrder.cargoTypes);
      selectRef('unit', ownUnit);
      return;
    }

    if (ownUnit && targetUnit && ownUnit.type === 'transport' && rt.canLoadTransport(ownUnit, targetUnit)) {
      rt.loadTransport(ownUnit, targetUnit);
      selectRef('unit', ownUnit);
      return;
    }
    // 反向也允许：选中陆军后点运兵船，同样是装载。
    if (ownUnit && targetUnit && targetUnit.type === 'transport' && rt.canLoadTransport(targetUnit, ownUnit)) {
      rt.loadTransport(targetUnit, ownUnit);
      selectRef('unit', targetUnit);
      return;
    }
    if (ownUnit && !targetUnit && ownUnit.type === 'transport' && rt.canUnloadTransport(ownUnit, cell.x, cell.y)) {
      rt.unloadTransport(ownUnit, cell.x, cell.y);
      selectRef('unit', ownUnit);
      return;
    }
    if (targetUnit?.owner === 'player') {
      rt.ensureStatsStarted();
      // 同格叠放时反复点同一格 = 在这一摞里循环切换，否则永远只能选到第一个。
      const ownStack = rt.unitsAt(cell.x, cell.y).filter(entry => entry.owner === 'player');
      if (ownStack.length > 1 && ownUnit && ownStack.includes(ownUnit)) {
        selectRef('unit', ownStack[(ownStack.indexOf(ownUnit) + 1) % ownStack.length]);
      } else {
        selectRef('unit', targetUnit);
      }
      return;
    }
    if (ownUnit && targetUnit && rt.canAttack(ownUnit, targetUnit)) {
      rt.attack(ownUnit, targetUnit);
      // 反击可能把自己打没了，所以要先确认它还在场上再重新选中。
      selectRef(game.units.includes(ownUnit) ? 'unit' : null, game.units.includes(ownUnit) ? ownUnit : null);
      return;
    }
    if (targetUnit) {
      selectRef('unit', targetUnit);
      return;
    }
    if (ownUnit && !targetUnit && rt.moveUnit(ownUnit, cell.x, cell.y)) {
      selectRef('unit', ownUnit);
      return;
    }
    if (targetSite) {
      if (targetSite.owner === 'player') {
        rt.ensureStatsStarted();
      }
      selectRef('site', targetSite);
      return;
    }
    rt.toast('请选择己方单位，或点击有效的移动、攻击、装载、卸载目标。');
  }

  function endTurn() {
    const game = rt.game;
    if (!game || game.settings?.spectator || game.side !== 'player' || game.over) {
      return;
    }
    rt.clearPendingOrder();
    game.selected = null;
    rt.advanceTurn();
  }

  // 以光标下那个世界坐标为锚点缩放：先记下光标指着地图上的哪一点，
  // 改完 zoom 再反推 cam，让那一点还停在光标下面。没有这步的话，
  // 缩放会以画布左上角为中心，手感很差。
  function zoomAt(event) {
    const canvas = rt.canvas;
    const rect = canvas.getBoundingClientRect();
    const sx = (event.clientX - rect.left) * canvas.width / rect.width;
    const sy = (event.clientY - rect.top) * canvas.height / rect.height;
    const worldX = rt.cam.x + sx / rt.zoom;
    const worldY = rt.cam.y + sy / rt.zoom;
    rt.zoom = clamp(rt.zoom * (event.deltaY < 0 ? 1.15 : 1 / 1.15), rt.minZoom(), 3);
    rt.cam.x = worldX - sx / rt.zoom;
    rt.cam.y = worldY - sy / rt.zoom;
    rt.clampCam();
  }

  function beginPan(event) {
    if (event.button === 2 && rt.mapIsPanned()) {
      panState = { x: event.clientX, y: event.clientY, moved: false };
    }
  }

  // 返回是否真的平移了，调用方据此决定要不要重绘。
  function panBy(event) {
    if (!panState) {
      return false;
    }
    const canvas = rt.canvas;
    const rect = canvas.getBoundingClientRect();
    const scale = canvas.width / rect.width;
    const dx = event.clientX - panState.x;
    const dy = event.clientY - panState.y;
    // 2 像素的容差：手抖不算拖拽，右键还是要弹出菜单的。
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
      panState.moved = true;
    }
    rt.cam.x -= dx * scale / rt.zoom;
    rt.cam.y -= dy * scale / rt.zoom;
    panState.x = event.clientX;
    panState.y = event.clientY;
    rt.clampCam();
    return true;
  }

  function endPan(event) {
    if (event.button === 2 && panState) {
      panSuppressContext = panState.moved;
      panState = null;
    }
  }

  // 拖拽完成后要吞掉紧随其后的那一次 contextmenu，否则松开右键会弹出菜单。
  // 一次性的：读完就复位。
  function consumeContextSuppression() {
    if (panSuppressContext) {
      panSuppressContext = false;
      return true;
    }
    return false;
  }

  return {
    tileFromEvent, selectRef, onBoard, endTurn,
    zoomAt, beginPan, panBy, endPan, consumeContextSuppression
  };
}
