'use strict';
// 地图定义（MapDefinition）：每张地图长什么样，用**数据**描述，不用代码描述。
//
// 【为什么要数据化】
// 这些内容原来是 world/mapgen.js 里一个 12 分支的 switch，每个分支几行硬编码的
// 绘制调用。那样写有三个问题：加一张地图要改代码、地图长什么样没法序列化出去、
// 将来做地图编辑器时无处落脚。改成数据之后，`terrainFor` 退化成一个解释器，
// 而"有哪些地图"变成了这张表。
//
// 【坐标约定 —— 只有两种，别再引入第三种】
//   cx / cy      永远是 0~1 的比例，执行时乘 W / H。
//   rx / ry      **绝对格数**（半径 4 就是 4 格）。
//   rxOf / ryOf  **相对比例**，执行时乘 W / H。
// 之所以要区分后两者：原代码里两种都有 —— 森林斑块用固定 4×2 格，而内海用
// W*0.22 × H*0.3。用"小于 1 就当比例"这类隐式约定能少写几个字段，但半径为 1 格
// 时就会歧义，不值得。
//
// 【改这张表 = 改地形 = 让行为基线失效】
// 地形生成消耗随机数，任何步骤的顺序、参数、数量变化都会让 sim/baseline.json
// 整体对不上。改完必须逐条确认差异符合预期，再重新 npm run snap。
//
// 支持的 op 见 world/mapgen.js 里的 STEP_OPS —— 那里是唯一的实现处。

export const MAP_DEFS = {
  frontier: {
    name: '边境河谷',
    sea: false,
    steps: [
      { op: 'river', cx: 0.48, phase: 0 },
      { op: 'ridge', cy: 0.26 }
    ]
  },
  twinrivers: {
    name: '双河走廊',
    sea: false,
    steps: [
      { op: 'river', cx: 0.34, phase: 0.25 },
      { op: 'river', cx: 0.67, phase: 1.15 }
    ]
  },
  highlands: {
    name: '高地山口',
    sea: false,
    steps: [
      { op: 'ridge', cy: 0.38 },
      { op: 'ridge', cy: 0.68 }
    ]
  },
  plains: {
    name: '北方平原',
    sea: false,
    steps: [
      { op: 'roadCross' }
    ]
  },
  heartland: {
    name: '中心平原',
    sea: false,
    steps: [
      { op: 'roadCross' },
      { op: 'ellipse', cx: 0.2, cy: 0.25, rx: 4, ry: 2, fill: 'forest', chance: 0.94 },
      { op: 'ellipse', cx: 0.78, cy: 0.72, rx: 4, ry: 3, fill: 'forest', chance: 0.94 }
    ]
  },
  coast: {
    name: '海岸丘陵',
    sea: true,
    steps: [
      // 西侧一条起伏的海岸线，往东是陆地。
      { op: 'shoreline', base: 0.22, amplitude: 2, frequency: 0.42 },
      { op: 'ridge', cy: 0.7 }
    ]
  },
  islands: {
    name: '群岛与海峡',
    sea: true,
    steps: [
      { op: 'fill', fill: 'water' },
      { op: 'ellipse', cx: 0.22, cy: 0.48, rx: 5, ry: 3, fill: 'plain', chance: 0.96 },
      { op: 'ellipse', cx: 0.5, cy: 0.3, rx: 4, ry: 2, fill: 'plain', chance: 0.95 },
      { op: 'ellipse', cx: 0.72, cy: 0.66, rx: 6, ry: 3, fill: 'plain', chance: 0.95 },
      { op: 'ellipse', cx: 0.45, cy: 0.78, rx: 3, ry: 2, fill: 'plain', chance: 0.92 }
    ]
  },
  innersea: {
    name: '内海争夺',
    sea: true,
    steps: [
      { op: 'ellipse', cx: 0.5, cy: 0.52, rxOf: 0.22, ryOf: 0.3, fill: 'water', chance: 0.98 },
      { op: 'roadCross' }
    ]
  },
  grandbay: {
    name: '海湾登陆',
    sea: true,
    steps: [
      { op: 'ellipse', cx: 0.14, cy: 0.78, rxOf: 0.36, ryOf: 0.42, fill: 'water', chance: 0.98 },
      { op: 'ellipse', cx: 0.42, cy: 0.58, rx: 3, ry: 2, fill: 'water', chance: 0.9 }
    ]
  },
  strait: {
    name: '裂海海峡',
    sea: true,
    steps: [
      // 纵贯南北的水道，两端各留一座浅滩当登陆点。
      { op: 'channel', cx: 0.5, amplitude: 1.1, frequency: 0.42, halfWidth: 2 },
      { op: 'ellipse', cx: 0.48, cy: 0.24, rx: 2, ry: 1, fill: 'plain', chance: 1 },
      { op: 'ellipse', cx: 0.5, cy: 0.73, rx: 2, ry: 1, fill: 'plain', chance: 1 }
    ]
  },
  archipelago: {
    name: '断链群岛',
    sea: true,
    steps: [
      { op: 'fill', fill: 'water' },
      { op: 'ellipse', cx: 0.28, cy: 0.34, rx: 5, ry: 3, fill: 'plain', chance: 0.96 },
      { op: 'ellipse', cx: 0.62, cy: 0.25, rx: 4, ry: 2, fill: 'plain', chance: 0.94 },
      { op: 'ellipse', cx: 0.77, cy: 0.62, rx: 6, ry: 3, fill: 'plain', chance: 0.95 },
      { op: 'ellipse', cx: 0.44, cy: 0.72, rx: 5, ry: 2, fill: 'plain', chance: 0.93 },
      { op: 'ellipse', cx: 0.12, cy: 0.74, rx: 3, ry: 2, fill: 'plain', chance: 0.92 }
    ]
  },
  random: {
    name: '随机大陆',
    sea: true,
    // 唯一一张不做后期点缀的图（见 mapgen 的 scatter 段），因为噪声本身
    // 已经按复杂度铺满了森林/山地/水域。
    skipScatter: true,
    steps: [
      { op: 'noise' },
      { op: 'roadCross' }
    ]
  }
};

// 供 UI 与存档使用的精简视图：只要名字和"有没有海"。
// core/constants.js 的 MAPS 就是它，保持既有调用方一行都不用改。
export const MAP_SUMMARY = Object.fromEntries(
  Object.entries(MAP_DEFS).map(([id, def]) => [id, { name: def.name, sea: def.sea }])
);
