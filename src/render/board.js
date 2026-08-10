'use strict';
// 棋盘渲染：地形、据点、单位、选中框、小地图，以及摄像机的夹取与居中。
//
// 依赖注入方式见 game/movement.js 顶部对 rt 门面的说明。
//
// 这是第一个真正碰 DOM 的模块 —— 它需要 canvas 和 2D context。无头模拟里这两个
// 都是打桩对象（sim/harness.js 的 ctxStub 是个 Proxy，任何方法调用都是空操作），
// 所以这里的代码在 sim 下会跑但什么也不画。这没问题，因为 refresh() 开头有
// `if (fastSim) return;`，正常情况下根本不会走到这里。
//
// 【为什么摄像机函数也在这个文件】
// clampCam / centerCamOn / minZoom / mapIsPanned 算的是「画布上看得到哪一块」，
// 和绘制共用同一套 S / cam / zoom / canvas 尺寸。分开会让两边都要复制一遍这些
// 换算，而且改缩放逻辑时必须同时改两个文件。
//
// 【cam 是对象，zoom 是数字】
// rt.cam 返回的是 main.js 那个对象的引用，所以这里改 cam.x / cam.y 能直接生效。
// zoom 是原始值，rt 只给 getter —— 本模块只读它，写 zoom 的只有滚轮事件（在
// main.js 里，因为它还要调 minZoom() 夹取）。别在这里给 zoom 赋值，赋不动。
import { TERRAIN } from '../core/constants.js';
import { cellKey, clamp, typeMeta, siteMeta, siteStars } from '../core/utils.js';

export function createBoardRenderer(rt) {
  function drawSelection(x, y, color) {
    const ctx = rt.ctx;
    const S = rt.S;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.strokeRect(x * S + 3, y * S + 3, S - 6, S - 6);
    ctx.restore();
  }

  function draw() {
    const ctx = rt.ctx;
    const canvas = rt.canvas;
    const S = rt.S;
    const W = rt.W;
    const H = rt.H;
    const game = rt.game;
    const cam = rt.cam;
    const zoom = rt.zoom;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.setTransform(zoom, 0, 0, zoom, -cam.x * zoom, -cam.y * zoom);
    const activeUnit = rt.selectedUnit();
    const activeSite = rt.selectedSite();
    const canMoveNow = activeUnit && !activeUnit.hasAttacked && activeUnit.move > 0;
    // 只给玩家显示可达高亮 —— AI 回合不剧透它能走到哪。
    const moves = canMoveNow && game.side === 'player' ? rt.reachable(activeUnit) : new Map();
    const unloadHints = activeUnit && typeMeta(activeUnit.type).transport && activeUnit.cargo.length ? rt.adjacent8(activeUnit.x, activeUnit.y).filter(cell => rt.canUnloadTransport(activeUnit, cell.x, cell.y)) : [];
    const engineerHints = game.pendingOrder?.kind === 'engineer-launch' && activeUnit?.id === game.pendingOrder.builderId ? rt.engineerBuildCells(activeUnit) : [];

    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const tile = TERRAIN[game.terrain[y][x]];
        const px = x * S;
        const py = y * S;
        ctx.fillStyle = tile.color;
        ctx.fillRect(px, py, S, S);
        ctx.strokeStyle = 'rgba(5,15,22,.3)';
        ctx.lineWidth = 1;
        ctx.strokeRect(px, py, S, S);
        if (tile.mark) {
          ctx.fillStyle = 'rgba(255,255,255,.26)';
          ctx.font = `${Math.floor(S * 0.35)}px serif`;
          ctx.textAlign = 'center';
          ctx.fillText(tile.mark, px + S / 2, py + S * 0.64);
        }
        if (moves.has(cellKey(x, y)) && (!activeUnit || x !== activeUnit.x || y !== activeUnit.y)) {
          ctx.fillStyle = 'rgba(77,164,255,.24)';
          ctx.fillRect(px + 2, py + 2, S - 4, S - 4);
        }
        if (unloadHints.some(cell => cell.x === x && cell.y === y)) {
          ctx.fillStyle = 'rgba(86,211,100,.22)';
          ctx.fillRect(px + 4, py + 4, S - 8, S - 8);
        }
        if (engineerHints.some(cell => cell.x === x && cell.y === y)) {
          ctx.fillStyle = 'rgba(242,166,90,.22)';
          ctx.fillRect(px + 6, py + 6, S - 12, S - 12);
        }
      }
    }

    for (const siteEntry of game.sites) {
      const px = siteEntry.x * S;
      const py = siteEntry.y * S;
      const pad = S * 0.14;
      // 阵营色底板铺满大半个格子，让归属一眼可辨。
      ctx.fillStyle = rt.ownerColor(siteEntry.owner);
      ctx.fillRect(px + pad, py + pad, S - pad * 2, S - pad * 2);
      ctx.strokeStyle = 'rgba(6,12,18,.6)';
      ctx.lineWidth = 2;
      ctx.strokeRect(px + pad, py + pad, S - pad * 2, S - pad * 2);
      ctx.fillStyle = '#fff';
      ctx.font = `${Math.floor(S * 0.42)}px serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(siteMeta(siteEntry.kind).icon, px + S / 2, py + S * 0.56);
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = '#ffe08a';
      ctx.font = `${Math.max(8, Math.floor(S * 0.2))}px sans-serif`;
      ctx.fillText('★'.repeat(siteStars(siteEntry)), px + S / 2, py + pad + S * 0.17);
    }

    // 同格可能叠放多个单位（只可能由卸载产生），扇形铺开画，避免完全重合。
    const cellStacks = new Map();
    for (const unitEntry of game.units) {
      const key = cellKey(unitEntry.x, unitEntry.y);
      if (!cellStacks.has(key)) {
        cellStacks.set(key, []);
      }
      cellStacks.get(key).push(unitEntry);
    }
    for (const unitEntry of game.units) {
      const stack = cellStacks.get(cellKey(unitEntry.x, unitEntry.y));
      const stackIndex = stack.indexOf(unitEntry);
      const spread = stack.length > 1 ? (stackIndex - (stack.length - 1) / 2) * S * 0.16 : 0;
      const px = unitEntry.x * S + S / 2 + spread;
      const py = unitEntry.y * S + S / 2 - spread;
      ctx.fillStyle = 'rgba(6,13,20,.72)';
      if (typeMeta(unitEntry.type).domain === 'sea') {
        ctx.fillRect(px - S * 0.28, py - S * 0.22, S * 0.56, S * 0.44);
        ctx.strokeStyle = rt.ownerColor(unitEntry.owner);
        ctx.lineWidth = 3;
        ctx.strokeRect(px - S * 0.28, py - S * 0.22, S * 0.56, S * 0.44);
      } else {
        ctx.beginPath();
        ctx.arc(px, py, S * 0.32, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = rt.ownerColor(unitEntry.owner);
        ctx.lineWidth = 3;
        ctx.stroke();
      }
      ctx.fillStyle = '#fff';
      ctx.font = `${Math.floor(S * 0.44)}px serif`;
      ctx.textAlign = 'center';
      ctx.fillText(typeMeta(unitEntry.type).icon, px, py + S * 0.12);
      ctx.fillStyle = unitEntry.owner === 'player' ? '#55d77a' : '#ff6c66';
      ctx.fillRect(px - S * 0.3, py + S * 0.34, S * 0.6 * unitEntry.hp / unitEntry.maxHp, 4);
      if (unitEntry.cargo?.length) {
        ctx.fillStyle = '#e3b341';
        ctx.font = `${Math.max(9, Math.floor(S * 0.22))}px sans-serif`;
        ctx.fillText(`${unitEntry.cargo.length}`, px + S * 0.22, py - S * 0.18);
      }
      if (stack.length > 1 && stackIndex === 0) {
        ctx.fillStyle = '#7fd0ff';
        ctx.font = `${Math.max(9, Math.floor(S * 0.24))}px sans-serif`;
        ctx.textAlign = 'left';
        ctx.fillText(`≡${stack.length}`, unitEntry.x * S + 3, unitEntry.y * S + S - 4);
        ctx.textAlign = 'center';
      }
    }

    if (activeUnit) {
      drawSelection(activeUnit.x, activeUnit.y, '#9ecbff');
    }
    if (activeSite) {
      drawSelection(activeSite.x, activeSite.y, '#ffd36c');
    }
    ctx.restore();
    drawMinimap();
  }

  function clampCam() {
    // 地图比可视区还小时（比如缩到最小）居中显示，否则夹到边缘。
    const canvas = rt.canvas;
    const S = rt.S;
    const cam = rt.cam;
    const zoom = rt.zoom;
    const viewW = canvas.width / zoom;
    const viewH = canvas.height / zoom;
    cam.x = rt.W * S <= viewW ? (rt.W * S - viewW) / 2 : clamp(cam.x, 0, rt.W * S - viewW);
    cam.y = rt.H * S <= viewH ? (rt.H * S - viewH) / 2 : clamp(cam.y, 0, rt.H * S - viewH);
  }

  function centerCamOn(x, y) {
    const S = rt.S;
    rt.cam.x = x * S + S / 2 - rt.canvas.width / rt.zoom / 2;
    rt.cam.y = y * S + S / 2 - rt.canvas.height / rt.zoom / 2;
    clampCam();
  }

  function minZoom() {
    return clamp(Math.min(rt.canvas.width / (rt.W * rt.S), rt.canvas.height / (rt.H * rt.S)), 0.2, 1);
  }

  function mapIsPanned() {
    return rt.W * rt.S * rt.zoom > rt.canvas.width + 0.5 || rt.H * rt.S * rt.zoom > rt.canvas.height + 0.5;
  }

  // 只在地图大于可视区时才画 —— 否则小地图是多余的。
  function drawMinimap() {
    if (!mapIsPanned()) {
      return;
    }
    const ctx = rt.ctx;
    const canvas = rt.canvas;
    const S = rt.S;
    const W = rt.W;
    const H = rt.H;
    const game = rt.game;
    const mmW = 132;
    const mmH = Math.round(mmW * H / W);
    const ox = canvas.width - mmW - 10;
    const oy = canvas.height - mmH - 10;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = 'rgba(6,12,18,.8)';
    ctx.fillRect(ox - 2, oy - 2, mmW + 4, mmH + 4);
    const sx = mmW / W;
    const sy = mmH / H;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        ctx.fillStyle = TERRAIN[game.terrain[y][x]].color || '#26333f';
        ctx.fillRect(ox + x * sx, oy + y * sy, Math.ceil(sx), Math.ceil(sy));
      }
    }
    for (const siteEntry of game.sites) {
      ctx.fillStyle = rt.ownerColor(siteEntry.owner);
      ctx.fillRect(ox + siteEntry.x * sx, oy + siteEntry.y * sy, Math.max(2, sx), Math.max(2, sy));
    }
    for (const unitEntry of game.units) {
      ctx.fillStyle = rt.ownerColor(unitEntry.owner);
      ctx.fillRect(ox + unitEntry.x * sx, oy + unitEntry.y * sy, Math.max(1, sx * 0.7), Math.max(1, sy * 0.7));
    }
    ctx.strokeStyle = '#ffe08a';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(ox + rt.cam.x / S * sx, oy + rt.cam.y / S * sy, canvas.width / rt.zoom / S * sx, canvas.height / rt.zoom / S * sy);
  }

  return { draw, drawSelection, drawMinimap, clampCam, centerCamOn, minZoom, mapIsPanned };
}
