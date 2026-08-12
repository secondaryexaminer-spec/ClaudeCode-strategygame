# 源码结构

35 个模块 + 一个装配层。`src/main.js` 里**没有游戏逻辑** —— 它只持有全局状态、
用 `rt` 门面把状态交出去、按依赖顺序把模块接起来。

想改游戏行为，去下面对应的模块，不要往 `main.js` 加函数。

## 依赖方向

箭头表示"谁依赖谁"。**没有反向箭头** —— 下层永远不 import 上层。

```
                    main.js（装配层，412 行）
                        │  持有 8 个 let + rt 门面
      ┌─────────────┬───┴───┬──────────────┬────────────┐
      ▼             ▼       ▼              ▼            ▼
   ui/ (6)      render/(2) debug/(2)    io/ (2)     world/ (2)
   1319 行       379 行    424 行       186 行       482 行
      └─────────────┴───┬───┴──────────────┴────────────┘
                        ▼
                    ai/ (6) 1373 行
                        ▼
                   game/ (9) 1303 行
                        ▼
                   core/ (6) 467 行
```

`ui/` 和 `render/` 是**叶子层**：除了 `main.js` 没有任何模块 import 它们。
这也是重构时先拆它们的原因 —— 只有"它依赖别人"一个方向，搬过去就完事。

## 各层职责

| 层 | 模块 | 管什么 |
|---|---|---|
| `core/` | constants, utils, grid, owners, queries, timing | 常量表、纯函数、格子几何、阵营关系、场上查询、异步节流 |
| `game/` | entities, movement, combat, build, transport, turn, turnflow, stats, newgame | 规则本身：单位、移动、战斗、生产、运输、回合推进、开局 |
| `ai/` | scoring, pathing, intent, decide, scripted, turnloop | 四层单向：scoring（值多少分）→ intent（想干什么）→ decide（怎么做）→ turnloop（谁先动） |
| `world/` | mapgen, worldgen | 地形生成、城市布点、初始部署 |
| `render/` | board, stats | 棋盘绘制、统计图表。只读状态，不改状态 |
| `ui/` | panels, input, lobby, bindings, screens, notify | 面板刷新、鼠标翻译、大厅、事件绑定、屏幕切换、日志与提示 |
| `io/` | storage, saves | KV 后端抽象、存档业务层 |
| `debug/` | fastsim, hooks | 无头快跑、`window.__frontierDebug` 的 18 个测试入口 |

## rt 门面：三条必须遵守的规则

所有模块通过 `createXxx(rt)` 拿到运行时门面。它是全局状态的唯一出入口。

### 1. 状态用 getter，不传值

开新局时 `game` 会被整体替换。getter 保证模块永远读到最新的那个，不会攥着旧引用。
**这是这套写法相对全局单例的关键好处**：状态只有一处真相（`main.js` 的 8 个
`let`），没有需要手动同步的副本。

### 2. 指向已拆出模块的项，必须写成箭头函数转发

`rt` 这个对象字面量在任何 `createXxx(rt)` **之前**就求值完了。所以：

```js
// ✅ 指向别的模块 —— 惰性转发
checkEnd: (...args) => turnApi.checkEnd(...args),
// ✅ 指向 main.js 自己的东西 —— 简写属性
canvas, ctx, refresh,
// ❌ 指向别的模块却用简写 —— 这一行就 TDZ 报错
checkEnd,
```

违反的表现是"战斗能打但对局永远不结束"这类**局部失灵**，不是整体崩溃，
所以很容易被误判成规则 bug。`main.js` 里有 18 个 `let xxxApi` 前置声明就是
为了打破这类循环依赖。

### 3. 写入口是函数，不是裸 setter

`setDimensions(w, h)` / `setCellSize` / `setGame` / `resizeCanvas` / `resetCamera` /
`setFastSim`。理由是这些值几乎从不单独改 —— W 和 H 永远一起改，cam 和 zoom 复位
也永远一起。分开写迟早漏一个。

例外是 `zoom` 和 `currentSaveKey`，它们确实会被单独改（滚轮缩放、存档回写），
所以保留了裸访问器。

## 什么时候用 deps 而不是 rt

`bindings`（37 个）、`turnloop`（25 个）、`hooks`（17 个）、`fastsim`（5 个）走的是
`createXxx(rt, deps)` 的显式第二参数，不是把函数塞进 `rt`。

判断标准：**这些函数是不是只有这一个模块要用**。是的话就走 `deps` ——
塞进 `rt` 会让运行时门面里混进一批别的模块根本不关心的项，读的人分不清
哪些是真依赖。

## 改代码时该动哪里

| 想改什么 | 动哪个文件 | 不要动 |
|---|---|---|
| 数值平衡（造价、攻防、移动力） | `core/constants.js` | 别在别处写死数字 |
| 某个操作能不能做 | `game/` 里对应的 `canXxx` | 不要在 `ui/bindings.js` 里加判断 |
| 点击后发生什么 | `ui/input.js` 的 `onBoard` | 那串 if 的**顺序就是规则**，不要重排 |
| 按钮该不该变灰 | `ui/panels.js` | 不要在绑定层算 |
| AI 的取舍 | `ai/scoring.js`（估值）或 `ai/intent.js`（战略） | `decide.js` 只负责执行 |
| 存档格式 | `io/saves.js` | 换后端只动 `io/storage.js` |

## 两个容易踩的约束

**`Math.random` 必须晚绑定。** 绝不能写 `const { random } = Math` —— 打包时会
捕获原生实现，`fastBatch` 的种子覆写就**静默**失效，确定性回放随之失效而没有
任何报错。

**随机数消耗量是行为基线的一部分。** 地形生成、城市布点、出兵位置的调用次数或
顺序一旦变化，`sim/baseline.json` 整体失效。`captureSite` 里那个 12% 的降级
概率也是消耗点。改这些要重新 `npm run snap` 并在提交信息里写明原因。

已知技术债：`shuffle = items => [...items].sort(() => Math.random() - 0.5)`
分布不均且依赖引擎排序实现，换 Fisher-Yates 需要单独提交并重新生成基线。

## 验证

改完跑 `npm run verify`（行为基线 + 界面烟雾）。测试工具的说明见
[`sim/README.md`](../sim/README.md)。
