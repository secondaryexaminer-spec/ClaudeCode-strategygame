'use strict';
// 网格几何工具。只依赖地图尺寸，不读任何运行时状态 —— 尺寸通过 W、H 参数显式传入。
//
// 为什么传两个标量而不是 { W, H } 对象：inBounds 处在寻路热路径上，一局会被调用
// 几十万次，传对象会产生大量短命临时分配。调用点稍长一点换掉这个开销是划算的。

export function makeGrid(W, H, fill) {
  return Array.from({ length: H }, () => Array(W).fill(fill));
}

export function inBounds(W, H, x, y) {
  return x >= 0 && y >= 0 && x < W && y < H;
}

export function adjacent4(W, H, x, y) {
  return [[1, 0], [-1, 0], [0, 1], [0, -1]]
    .map(([dx, dy]) => ({ x: x + dx, y: y + dy }))
    .filter(cell => inBounds(W, H, cell.x, cell.y));
}

export function adjacent8(W, H, x, y) {
  return [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]
    .map(([dx, dy]) => ({ x: x + dx, y: y + dy }))
    .filter(cell => inBounds(W, H, cell.x, cell.y));
}
