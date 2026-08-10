# 模拟器与回归工具

无浏览器跑游戏本体。所有工具都 `eval` 打包产物 `js/game.js`（不是 `src/`），
所以**跑之前必须先 `node build.js`** —— `npm run snap` / `npm run verify` 已经
自动串好了构建，手动调用 `sim/*.js` 时要自己注意。

## 三套工具的分工

| 命令 | 用途 | 断言强度 |
|---|---|---|
| `npm run sim` | 手工探查：跑几局看指标，调参时的即时反馈 | 无断言，只出数据 |
| `npm run sim:suite` | 防**平衡漂移**：胜率是否还在合理区间 | 宽区间（如 25%~75%） |
| `npm run smoke` | 防**渲染层搬错**：绘制会不会抛错 / 算出 NaN | 只覆盖渲染，不看游戏逻辑 |
| `npm run verify:fast` | 同下，只跑 4 个单 seed 场景，**约 15 秒** | 零容忍（覆盖面较窄）+ 烟雾 |
| `npm run verify` | 防**重构搬错**：行为是否与基线逐字段全等 | 零容忍，一个数字都不能变 + 烟雾 |

`verify` 能成立，是因为 `fastBatch()` 会把 `Math.random` 换成种子化 LCG 再跑、
跑完还原（见 `src/main.js` 的 `makeRng`）。因此同一组 `(config, seed, rounds, cap)`
必然产出逐字节相同的结果 —— 这就是纯结构重构所需要的行为等价性证明。

## ⚠️ verify 有一个盲区：渲染层

`refresh()` 开头有 `if (fastSim) return;`，而 `verify` 跑的全是 `fastBatch`。
**这意味着 `draw()` / `drawMinimap()` / 摄像机换算一行都不会执行** —— 渲染层
整个删掉，行为基线照样全绿。

`npm run smoke`（`sim/smoke-render.js`）专门补这个洞，已并入 `verify` 和
`verify:fast`。它做两件普通烟雾测试不做的事：

1. **strictCanvas 打桩**。默认的 ctx 打桩是个 Proxy，吞掉一切调用 —— 把 `rt.S`
   写成 `rt.SS` 会让所有坐标变成 `NaN` 而测试照样全绿（**这是实测出来的，不是
   假设**：第一版烟雾测试就没抓住这个错）。strictCanvas 模式下任何 `NaN` /
   `undefined` 参数当场抛错。
2. **统计 ctx 调用次数**。一张最小的图也有 1500+ 次调用，个位数说明 `draw` 提前
   返回了。没有这个断言，「绘制没跑」和「绘制没问题」看起来一模一样。

它靠 `__frontierDebug.redraw()` 强制同步绘制 —— 正常流程里 `draw()` 要么被
`fastSim` 挡掉，要么得等 `runLoadingScreen` 的 `setInterval`，两条路都没法在
测试里同步命中。

## 并行执行

场景矩阵按 `(场景, seed)` 拆成 8 个任务单元，由 `sim/pool.js` fork 多个进程并发跑
（默认 `CPU 核数 - 1`，上限 8）。全量校验从 125 秒降到约 34 秒。

```bash
npm run verify              # 并行，约 34 秒
npm run verify:fast         # 4 个单 seed 场景，约 15 秒
node sim/verify.js jobs=1   # 退回单进程串行
```

**并行结果与串行逐字节相同**，这一点是实测验证的、不是推理出来的：接入时用
并行跑了一遍去比对同一份 `baseline.json`，全绿才算数。

如果哪天并行和串行结果对不上，那说明代码里有跨局残留的模块级状态（缓存没清
干净之类），**那本身就是必须修的 bug**，不要靠 `jobs=1` 退回串行来掩盖。

> 踩过的坑：`createHarness(config)` 里的 config 只是 DOM 打桩的**读取兜底**，
> 而 `domReady()` 触发的 `setup()` 会覆写元素的 `_value`。所以建完 harness 后
> 必须再显式 `setConfig()` 一次，否则跑的其实是默认大厅配置 —— 结果依然是一局
> 合法对局，只是和基线对不上。`sim/worker.js` 里已处理。

## 标准工作流

拆模块 / 搬函数 / 改导入这类**不该改变行为**的改动：

```bash
npm run verify          # 动手前先确认是绿的
# ... 拆一个模块 ...
npm run verify:fast     # 改一刀验一次，15 秒
# ... 再拆几个 ...
npm run verify          # 提交前跑全量，34 秒
git commit              # 绿了才提交，红了就回查
```

定位问题时只跑单个场景更快：

```bash
npm run verify -- only=strait-2ai
npm run verify -- only=strait-2ai max=100    # 多打印几条差异
```

差异路径形如 `strait-2ai/bySeed/seed777/runs[0]/byOwner/ai1/cityCaptures`，
可以直接定位到「哪个场景 / 哪个种子 / 第几局 / 哪个 AI / 哪个指标」。

## ⚠️ 一条铁律

**`verify` 变红时，不要习惯性地跑 `npm run snap` 把基线覆盖掉。**

- 如果这次改动**本就打算**改变行为（调数值、换算法、修 bug、加兵种/地形）：
  先逐条看差异是否符合预期，确认后再 `npm run snap` 更新基线，并在提交信息里
  写明「基线已更新，原因是 ___」。
- 如果这次改动**应该是**纯结构重构：那就是搬错了，去改代码，不要动基线。

基线一旦被无脑覆盖，这张安全网就废了。

## 场景矩阵

定义在 `sim/scenarios.js`，共 6 个场景 36 局，覆盖：

- `strait-2ai` / `heartland-2ai` —— 海战（运输、登陆、桥头堡）与纯陆战（距离场寻路）
- `coast-3ai` —— 多阵营交互、盟友判定、拥挤度
- `diff-gap` —— 难度与性格分支（冷酷冲动 vs 简单谨慎）
- `scripted-bridgehead` / `scripted-naval` —— 定向覆盖 `bridgehead*` / `naval*`
  两套脚本对手逻辑（对应 `DIFF` 里的 `bridgehead` / `naval` 测试难度）

增删场景后需要重新 `npm run snap`。改动场景的 `seeds` / `rounds` / `cap`
同样会让基线失效 —— 这几个字段应当视为基线的一部分，非必要不要动。

## 产物文件

| 文件 | 是否入库 |
|---|---|
| `sim/baseline.json` | ✅ **必须入库**，它就是基线本身 |
| `sim/last-result.json`、`sim/last-diag.json`、`sim/suite-result.json` | ❌ 运行产物，已在 `.gitignore` |
