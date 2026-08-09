'use strict';
// 地形生成：给定地图 ID、复杂度与地图尺寸，产出一张 H×W 的二维地形数组。
//
// 这里是纯函数 —— 除 Math.random 外不读任何外部状态（Math.random 在无头模拟中
// 会被 fastBatch 换成种子化 LCG，所以同 seed 的地形完全可复现）。地图尺寸由
// W、H 参数显式传入，而不是读 main.js 的模块级变量。
import { COMPLEX, MAPS } from '../core/constants.js';
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

export function terrainFor(mapId, complexityId, W, H) {
  const terrain = makeGrid(W, H, 'plain');
  const complexity = COMPLEX[complexityId];
  switch (mapId) {
    case 'frontier':
      paintRiver(W, H, terrain, W * 0.48, 0);
      paintRidge(W, H, terrain, H * 0.26);
      break;
    case 'twinrivers':
      paintRiver(W, H, terrain, W * 0.34, 0.25);
      paintRiver(W, H, terrain, W * 0.67, 1.15);
      break;
    case 'highlands':
      paintRidge(W, H, terrain, H * 0.38);
      paintRidge(W, H, terrain, H * 0.68);
      break;
    case 'plains':
      addRoadCross(W, H, terrain);
      break;
    case 'heartland':
      addRoadCross(W, H, terrain);
      createEllipse(W, H, terrain, W * 0.2, H * 0.25, 4, 2, 'forest', 0.94);
      createEllipse(W, H, terrain, W * 0.78, H * 0.72, 4, 3, 'forest', 0.94);
      break;
    case 'coast':
      for (let y = 0; y < H; y++) {
        const shore = Math.floor(W * 0.22 + Math.sin(y * 0.42) * 2);
        for (let x = 0; x <= shore; x++) {
          terrain[y][x] = 'water';
        }
      }
      paintRidge(W, H, terrain, H * 0.7);
      break;
    case 'islands':
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          terrain[y][x] = 'water';
        }
      }
      createEllipse(W, H, terrain, W * 0.22, H * 0.48, 5, 3, 'plain', 0.96);
      createEllipse(W, H, terrain, W * 0.5, H * 0.3, 4, 2, 'plain', 0.95);
      createEllipse(W, H, terrain, W * 0.72, H * 0.66, 6, 3, 'plain', 0.95);
      createEllipse(W, H, terrain, W * 0.45, H * 0.78, 3, 2, 'plain', 0.92);
      break;
    case 'innersea':
      createEllipse(W, H, terrain, W * 0.5, H * 0.52, W * 0.22, H * 0.3, 'water', 0.98);
      addRoadCross(W, H, terrain);
      break;
    case 'grandbay':
      createEllipse(W, H, terrain, W * 0.14, H * 0.78, W * 0.36, H * 0.42, 'water', 0.98);
      createEllipse(W, H, terrain, W * 0.42, H * 0.58, 3, 2, 'water', 0.9);
      break;
    case 'strait':
      for (let y = 0; y < H; y++) {
        const seaX = Math.floor(W * 0.5 + Math.sin(y * 0.42) * 1.1);
        for (let dx = -2; dx <= 2; dx++) {
          if (inBounds(W, H, seaX + dx, y)) {
            terrain[y][seaX + dx] = 'water';
          }
        }
      }
      createEllipse(W, H, terrain, W * 0.48, H * 0.24, 2, 1, 'plain', 1);
      createEllipse(W, H, terrain, W * 0.5, H * 0.73, 2, 1, 'plain', 1);
      break;
    case 'archipelago':
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          terrain[y][x] = 'water';
        }
      }
      createEllipse(W, H, terrain, W * 0.28, H * 0.34, 5, 3, 'plain', 0.96);
      createEllipse(W, H, terrain, W * 0.62, H * 0.25, 4, 2, 'plain', 0.94);
      createEllipse(W, H, terrain, W * 0.77, H * 0.62, 6, 3, 'plain', 0.95);
      createEllipse(W, H, terrain, W * 0.44, H * 0.72, 5, 2, 'plain', 0.93);
      createEllipse(W, H, terrain, W * 0.12, H * 0.74, 3, 2, 'plain', 0.92);
      break;
    case 'random':
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const roll = Math.random();
          terrain[y][x] = roll < complexity.water ? 'water' : roll < complexity.water + complexity.mountain ? 'mountain' : roll < complexity.water + complexity.mountain + complexity.forest ? 'forest' : 'plain';
        }
      }
      addRoadCross(W, H, terrain);
      break;
    default:
      break;
  }
  if (mapId !== 'random') {
    scatter(W, H, terrain, 'forest', Math.max(2, Math.round(W * H * complexity.forest / 24)), 2, ['plain']);
    scatter(W, H, terrain, 'mountain', Math.max(1, Math.round(W * H * complexity.mountain / 34)), 1, ['plain']);
    if (!MAPS[mapId].sea) {
      scatter(W, H, terrain, 'water', Math.max(0, Math.round(W * H * complexity.water / 70)), 1, ['plain']);
    }
  }
  return terrain;
}
