'use strict';
// 地形生成：给定地图 ID、复杂度与地图尺寸，产出一张 H×W 的二维地形数组。
//
// 这里是纯函数 —— 除 Math.random 外不读任何外部状态（Math.random 在无头模拟中
// 会被 fastBatch 换成种子化 LCG，所以同 seed 的地形完全可复现）。地图尺寸由
// W、H 参数显式传入，而不是读 main.js 的模块级变量。
//
// 【这个文件只剩"怎么画"，"画什么"在 core/mapdefs.js】
// 原来这里是一个 12 分支的 switch，每个分支硬编码几行绘制调用。现在每张地图是
// 一串 steps 数据，下面的 STEP_OPS 是唯一的执行处 —— 加地图改数据，加画法改这里。
//
// ⚠️ **随机数消耗顺序就是行为基线的一部分**。下面每个 op 的实现都必须和原来那段
// 代码逐次调用一致，包括看似无意义的调用：createEllipse 里即使 chance === 1 也会
// 求一次 Math.random()，少调一次，后面所有地形、布点、出兵位置就全变了，
// 而 sim/baseline.json 会整体对不上。
import { COMPLEX } from '../core/constants.js';
import { MAP_DEFS } from '../core/mapdefs.js';
import { clamp, rnd } from '../core/utils.js';
import { makeGrid, inBounds } from '../core/grid.js';

function createEllipse(W, H, terrain, cx, cy, rx, ry, fillTerrain, chance = 1) {
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const nx = (x - cx) / rx;
      const ny = (y - cy) / ry;
      if (nx * nx + ny * ny <= 1 && Math.random() <= chance) {
        terrain[y][x] = fillTerrain;
      }
    }
  }
}

function paintRiver(W, H, terrain, center, phase = 0) {
  for (let y = 0; y < H; y++) {
    const riverX = Math.round(center + Math.sin(y * 0.65 + phase) * 1.6 + Math.sin(y * 0.19) * 0.8);
    terrain[y][clamp(riverX, 1, W - 2)] = 'water';
    if (y % 5 === 2) {
      terrain[y][clamp(riverX, 1, W - 2)] = 'road';
    }
  }
}

function paintRidge(W, H, terrain, center) {
  for (let x = 0; x < W; x++) {
    const ridgeY = Math.round(center + Math.sin(x * 0.52) * 1.7 + Math.sin(x * 0.18) * 1.1);
    for (let dy = -1; dy <= 1; dy++) {
      const y = clamp(ridgeY + dy, 1, H - 2);
      terrain[y][x] = 'mountain';
    }
    if (x % 7 === 3) {
      terrain[clamp(ridgeY, 1, H - 2)][x] = 'road';
    }
  }
}

function addRoadCross(W, H, terrain) {
  const midY = Math.floor(H / 2);
  const midX = Math.floor(W / 2);
  for (let x = 1; x < W - 1; x++) {
    if (terrain[midY][x] !== 'water' && terrain[midY][x] !== 'mountain') {
      terrain[midY][x] = 'road';
    }
  }
  for (let y = 1; y < H - 1; y++) {
    if (terrain[y][midX] !== 'water' && terrain[y][midX] !== 'mountain') {
      terrain[y][midX] = 'road';
    }
  }
}

function scatter(W, H, terrain, type, count, radius, allowed) {
  for (let i = 0; i < count; i++) {
    const cx = rnd(W);
    const cy = rnd(H);
    const r = 1 + rnd(radius);
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (!inBounds(W, H, x, y) || !allowed.includes(terrain[y][x])) {
          continue;
        }
        if (Math.hypot(dx, dy) <= r + 0.4 && Math.random() > 0.18) {
          terrain[y][x] = type;
        }
      }
    }
  }
}

// 全图铺一种地形。不消耗随机数。
function fillAll(W, H, terrain, type) {
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      terrain[y][x] = type;
    }
  }
}

// 一侧的海岸线：每行从左边界铺水铺到 shore 列，shore 随 y 起伏。
function paintShoreline(W, H, terrain, base, amplitude, frequency) {
  for (let y = 0; y < H; y++) {
    const shore = Math.floor(W * base + Math.sin(y * frequency) * amplitude);
    for (let x = 0; x <= shore; x++) {
      terrain[y][x] = 'water';
    }
  }
}

// 纵贯南北的水道，中心线随 y 摆动，左右各铺 halfWidth 格。
function paintChannel(W, H, terrain, cx, amplitude, frequency, halfWidth) {
  for (let y = 0; y < H; y++) {
    const seaX = Math.floor(W * cx + Math.sin(y * frequency) * amplitude);
    for (let dx = -halfWidth; dx <= halfWidth; dx++) {
      if (inBounds(W, H, seaX + dx, y)) {
        terrain[y][seaX + dx] = 'water';
      }
    }
  }
}

// 按复杂度逐格掷骰。每格消耗一次随机数。
function paintNoise(W, H, terrain, complexity) {
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const roll = Math.random();
      terrain[y][x] = roll < complexity.water ? 'water' : roll < complexity.water + complexity.mountain ? 'mountain' : roll < complexity.water + complexity.mountain + complexity.forest ? 'forest' : 'plain';
    }
  }
}

// 半径既可以写绝对格数（rx），也可以写相对比例（rxOf）。两者只能选一个，
// 理由见 core/mapdefs.js 顶部的坐标约定。
function radiusOf(step, key, span) {
  const ratio = step[`${key}Of`];
  return ratio === undefined ? step[key] : span * ratio;
}

// 每个 op 一个实现。这是"画法"的唯一定义处 —— core/mapdefs.js 只描述画什么。
const STEP_OPS = {
  river: (W, H, terrain, step) => paintRiver(W, H, terrain, W * step.cx, step.phase),
  ridge: (W, H, terrain, step) => paintRidge(W, H, terrain, H * step.cy),
  roadCross: (W, H, terrain) => addRoadCross(W, H, terrain),
  fill: (W, H, terrain, step) => fillAll(W, H, terrain, step.fill),
  shoreline: (W, H, terrain, step) => paintShoreline(W, H, terrain, step.base, step.amplitude, step.frequency),
  channel: (W, H, terrain, step) => paintChannel(W, H, terrain, step.cx, step.amplitude, step.frequency, step.halfWidth),
  noise: (W, H, terrain, step, complexity) => paintNoise(W, H, terrain, complexity),
  ellipse: (W, H, terrain, step) => createEllipse(
    W, H, terrain,
    W * step.cx, H * step.cy,
    radiusOf(step, 'rx', W), radiusOf(step, 'ry', H),
    step.fill, step.chance
  )
};

export function terrainFor(mapId, complexityId, W, H) {
  const terrain = makeGrid(W, H, 'plain');
  const complexity = COMPLEX[complexityId];
  const def = MAP_DEFS[mapId];
  // 未知地图 ID 保持原来 switch 的 default 行为：什么都不画，只走下面的点缀。
  for (const step of def?.steps || []) {
    const run = STEP_OPS[step.op];
    if (!run) {
      throw new Error(`地图 ${mapId} 用了未知的绘制步骤 "${step.op}"`);
    }
    run(W, H, terrain, step, complexity);
  }
  // 后期点缀：撒森林、撒山，纯陆图再撒几个小水塘。
  // random 图跳过 —— 它的噪声已经按复杂度铺满了这三种地形。
  if (!def?.skipScatter) {
    scatter(W, H, terrain, 'forest', Math.max(2, Math.round(W * H * complexity.forest / 24)), 2, ['plain']);
    scatter(W, H, terrain, 'mountain', Math.max(1, Math.round(W * H * complexity.mountain / 34)), 1, ['plain']);
    if (!def?.sea) {
      scatter(W, H, terrain, 'water', Math.max(0, Math.round(W * H * complexity.water / 70)), 1, ['plain']);
    }
  }
  return terrain;
}
