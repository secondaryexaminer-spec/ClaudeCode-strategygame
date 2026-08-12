# 模拟器与回归工具

无浏览器跑游戏本体。所有工具都 `eval` 打包产物 `js/game.js`（不是 `src/`），
所以**跑之前必须先 `node build.js`** —— `npm run snap` / `npm run verify` 已经
自动串好了构建，手动调用 `sim/*.js` 时要自己注意。

## 三套工具的分工

| 命令 | 用途 | 断言强度 |
|---|---|---|
| `npm run sim` | 手工探查：跑几局看指标，调参时的即时反馈 | 无断言，只出数据 |
| `npm run sim:suite` | 防**平衡漂移**：胜率是否还在合理区间 | 宽区间（如 25%~75%） |
| `npm run smoke` | 防**界面层搬错**：绘制/面板/点击/存档会不会抛错、算出 NaN | 只覆盖界面与存档，不看游戏逻辑 |
| `npm run verify:fast` | 同下，只跑 4 个单 seed 场景，**约 15 秒** | 零容忍（覆盖面较窄）+ 烟雾 |
| `npm run verify` | 防**重构搬错**：行为是否与基线逐字段全等 | 零容忍，一个数字都不能变 + 烟雾 |

`verify` 能成立，是因为 `fastBatch()` 会把 `Math.random` 换成种子化 LCG 再跑、
跑完还原（见 `src/main.js` 的 `makeRng`）。因此同一组 `(config, seed, rounds, cap)`
必然产出逐字节相同的结果 —— 这就是纯结构重构所需要的行为等价性证明。

## ⚠️ verify 有一个盲区：整个界面层

`refresh()` 开头有 `if (fastSim) return;`，而 `verify` 跑的全是 `fastBatch`。
**这意味着 `draw()` / `drawMinimap()` / `updatePanels()` / 摄像机换算一行都不会
执行** —— `render/` 和 `ui/` 两个目录整个删掉，行为基线照样全绿。

`npm run smoke`（`sim/smoke-render.js`）专门补这个洞，已并入 `verify` 和
`verify:fast`。它覆盖六层，各自单独计数：

| 层 | 文件 | 度量 | 下限 |
|---|---|---|---|
| 棋盘绘制 | `src/render/board.js` | ctx 调用数 | 200（实测 1000+） |
| 面板刷新 | `src/ui/panels.js` | DOM 写入数 | 30（实测 63~84） |
| 统计图表 | `src/render/stats.js` | ctx 调用数 | 20（实测 28~38） |
| 汇总卡 | `src/render/stats.js` | DOM 写入数 | 6（实测 8） |
| 棋盘点击 | `src/ui/input.js` | 命中数 | 2（实测 2~3） |
| 大厅预览 | `src/ui/lobby.js` | ctx 调用数 | 100（实测 900+） |

统计层被量了两遍是有意的：ctx 掉下去说明折线图没画，DOM 掉下去说明汇总卡那六个
数字没填 —— 两者互不替代。

外加一项不分用例的**事件绑定检查**：`src/ui/bindings.js` 里漏掉一行
`addEventListener` 不会报任何错，那个按钮只是永远点不动。harness 的元素打桩会
记下每个元素被挂了哪些事件（含 `onclick` 赋值），烟雾测试拿 `MUST_BE_BOUND`
清单逐个核对。**加新按钮时记得把 id 加进那份清单** —— 它是绑定层的第一道保护。
第二道是下面的交互链，其中三条会真的把按钮点下去看结果。

大厅还有一部分是在 **`createHarness()` 那一行**就跑完的：它触发
`DOMContentLoaded` → `setup()` → `showScreen('setup')` → `renderLobbyPreview()`，
所以 `fillSelectOptions` / `renderRules` / `renderCodex` / `renderAISettings`
都在 strictDom 下真跑过。这一行单独包了 try/catch —— 否则它抛错会在用例循环之外
冒出去，进程直接崩，报错里看不出是哪一层的事。

它做四件普通烟雾测试不做的事：

1. **strictCanvas 打桩**。默认的 ctx 打桩是个 Proxy，吞掉一切调用 —— 把 `rt.S`
   写成 `rt.SS` 会让所有坐标变成 `NaN` 而测试照样全绿（**这是实测出来的，不是
   假设**：第一版烟雾测试就没抓住这个错）。strictCanvas 模式下任何 `NaN` /
   `undefined` 参数当场抛错。
2. **strictDom 打桩**。面板不画图，它拼字符串写进 `innerHTML` / `textContent`；
   属性名写错不抛异常，只会让页面上多出一串 `undefined`。strictDom 模式下任何写进
   这两个属性的 `"undefined"` / `"NaN"` 字面量当场抛错。
3. **分层计数**。「没抛异常」和「压根没跑」看起来一模一样，所以每层都有调用量下限。
   **必须分层量**：面板正常写 84 次 DOM、统计面板只写 2 次，合在一起断言总数的话，
   统计面板整个熄火也能蒙混过关。
4. **固定种子**。布点和地形全靠 `Math.random`，不固定的话每次跑的是不同的局，
   断言会时绿时红 —— 而红的原因往往是"这次敌人恰好离得近"而不是代码坏了。
   用的是和 `fastBatch` 相同的 LCG，跑完还原。

它靠 `__frontierDebug` 的 `redraw()` / `repaintUi()` / `repaintStats()` /
`repaintLobby()` / `clickCell()` 强制同步执行 —— 正常流程里这些要么被 `fastSim`
挡掉，要么得等 `runLoadingScreen` 的 `setInterval`，两条路都没法在测试里同步命中。

- `repaintUi()` 会依次切换六种选中态（无 / 普通单位 / 工程师 / 运兵船 / 据点 /
  船厂）各刷一遍，因为面板的分支几乎全挂在「当前选中的是什么」上，只刷默认状态
  等于只覆盖了其中一段。
- `clickCell(x, y)` 把格子坐标反算成 `clientX/clientY` 再喂给 `onBoard`，走的是和
  真实点击**完全相同**的路径（包括 `getBoundingClientRect` 换算），而不是绕过去
  直接调内部函数 —— 绕过去就测不到坐标换算写错这类错。
- `repaintLobby()` 必须放在一个用例的**最后**：里面的 `renderLobbyPreview` 会按
  大厅下拉框重算 `W` / `H`，之后这局的棋盘尺寸就对不上了。

**六层的阳性对照都实跑验证过**：改错属性名 → 红、改错函数名 → 红、
让 `updatePanels` 提前 return → 红、把格子换算的除数改成 `S * 2` → 红、
把移动分支短路掉 → 红、大厅文案里的 `.name` 改成 `.nam` → 红、
删掉两行按钮绑定 → 红、让汇总卡那段循环跑不到 → 红。

### 交互链：十一条操作路径

`onBoard` 的每条分支、面板按钮、摄像机、键盘、存档各验一条。局面用
`__frontierDebug.placeUnit` 直接摆出来 —— 随机开局不保证出现「运兵船旁边有陆军」
这类组合。

| 链 | 验的是 | 阳性对照 |
|---|---|---|
| 装载 | 点陆军再点运兵船 → 上船 | 短路反向装载分支 → 红 |
| 卸载 | 点运兵船再点空陆格 → 下船 | 注释掉 `unloadTransport` → 红 |
| 攻击 | 点自己再点敌人 → 掉血或阵亡 | 注释掉 `attack` → 红 |
| 工程师下水 | 有 `pendingOrder` 时点海格 → 造出船 | 注释掉 `engineerLaunch` → 红 |
| 缩放 | 滚轮改变 `zoom` | `rt.zoom = rt.zoom` → 红 |
| 拖拽 | 右键平移、左键不平移 | `beginPan` 去掉按键判断 → 红；后端 `delta` 归零 → 红 |
| 键盘 | Escape 清掉选中 | 短路 Escape 分支 → 红 |
| 面板变卖 | 点变卖按钮 → 单位消失 | 短路 `sellUnit` → 红 |
| 面板生产 | 点生产按钮 → 场上多一个单位 | 短路 `buildAtSite` → 红 |
| 存档往返 | 存 → 改脏 → 读回 → 局面复原 | 短路 `setItem` → 红；短路 `loadPayload` → 红 |
| 存档迁移 | 老档可迁移、超前档与残档被拒、烂设置被修正 | 断迁移链 / 不拒超前版本 / 不校验字段 / 不规范化 → 各红 |

另有三项独立检查（不在链里）：

- **事件绑定**：`MUST_BE_BOUND` 里 37 个元素是否都挂上了处理器。
- **地图定义**：12 张图 × 3 复杂度 × 3 尺寸 = 108 次地形生成，断言不抛错、
  地形值合法、`sea: true` 的图必须真的有水格。
- **大厅重渲染**：换地图触发 `renderLobbyPreview`、改 AI 数量触发
  `renderAISettings`。

> 为什么地图自检值得单列：`verify` 的 6 个场景只用到 4 张图，上面 4 个用例
> 再补 2 张 —— 12 张里有一半（frontier / twinrivers / highlands / islands /
> innersea / random）**从来没有任何测试跑过**。地图定义数据化之后，一张图的
> steps 写错只会毁掉那一张，而那张图可能永远没人跑，也就永远不会红。
> 三条断言的阳性对照都实跑过：op 拼错 → 红、地形值非法 → 红、海图没海 → 红。

三个必须注意的陷阱，都是实测踩到的：

- **拖拽要先放大到地图超出视口**。否则 `mapIsPanned()` 为假，`beginPan` 根本不
  记录状态，"拖不动"是正确行为 —— 第一版就是这样假绿通过的。
- **工程师造的是空载运兵船（42）而不是战船（46）**。开局金币 45，战船差一块钱，
  那条链会因为"钱不够"失败，看起来却像派发链断了。
- **变卖链必须排在生产链前面，而且要卖两个**。开局紧密部署，己方城市上全站着
  单位，而 `buildAtSite` 要求据点那一格是空的 —— 所以先卖掉城里的兵腾位置。
  卖两个是因为总预算只有 45 金而工程师下水那条链要花 42：卖一个民兵回收 8、
  生产再花 16，净支出 8 就会把下水链挤掉，报错却长得像"派发链断了"。
  卖两个 +16、生产一个 -16，净支出不为正，两条链互不干扰。

**整个用例都跑在固定种子下，不只是 `newGame`。** 交互链里的战斗同样消耗随机数
—— 只包 `newGame` 的那一版，同一次攻击实测跑出过 `10→1`、`10→2`、`目标阵亡`
三种结果。当时的断言宽容到不会因此假红，但下一条更严格的断言就会时绿时红。
用 `beginSeed` + `finally` 覆盖整个用例后，连跑三次输出完全一致。

**大厅重渲染必须放在所有用例内容之后**：`renderLobbyPreview` 会按大厅下拉框重算
`W` / `H`，而 `counts.lobby` 里的 `drawPreview` 读的是当前这局的 `game.terrain`
—— 顺序反了会越界读出 `undefined`。这和 `repaintLobby` 是同一个坑。

`findInteractionSpots` 会在图上找**两对**"空海格挨着空陆格"加一对"相邻空陆格"。
需要两对是因为第一对上会站着卸载下来的民兵，工程师摆上去会和它叠在同一格，而
`inspectCell` 只返回最上面那个。凑不出格子时直接抛错，不跳过 —— 跳过等于静默
减少覆盖。（`heartland` 图海岸线太短只能凑出一对，所以交互用例用的是 `coast`。）

### ⚠️ 打桩的"天花板"多半是自己砌的

有三块覆盖曾经被记成「打桩做不到」，后来发现全都只是 harness 没接上：

| 曾经的说法 | 真实原因 | 怎么拆的 |
|---|---|---|
| 汇总卡数字填不了 | `querySelectorAll` 恒返回 `[]` | 加最小的 innerHTML 解析 |
| 面板按钮点不了 | `closest` 恒返回 `null`，而按钮全走事件委托 | 加最小的 `closest` |
| 存档链路测不了 | 压根没装 `localStorage` | 加内存版 KV |

共同点是**打桩返回的零值让整段代码变成死代码，而死代码不抛异常**。所以看到
"这个测不了"的结论时，先确认那是环境的限制，还是打桩自己返回的空值。

`localStorage` 有个额外的时序要求：**必须在 `eval(gameSrc)` 之前装好**。
`src/io/storage.js` 在模块求值那一刻就执行 `typeof localStorage !== 'undefined'`
并把结果冻进 `saveStore.available`，晚一步装，保存和读档会静默变成空操作。
这个因果做过对照实测：把那段挪到 `eval` 之后，存档往返链会红在"存档条目有 0 份"。

### 它测不到什么

别把它当成完整的 UI 测试。已知的边界：

- **面板按钮只验了三个**（生产、变卖，加存档那一组）。升级据点、修整驻军、
  工程师建营地、运兵船预载下拉、统计翻页、暂停菜单、结算弹窗的按钮**仍然只验
  "挂上了处理器"**，点了会发生什么没测。
- **导入存档没测**：`FileReader` 没有打桩，`importFile` 的 change 回调进不去。
  导出、保存、读档、删除这四条走的是同步路径，已经覆盖。
- **观战分支、同格叠放的循环切换、contextmenu 抑制**没测。
- **布局、样式、文案内容一概不验**。只验「跑得通、不产生 undefined/NaN」。

> 踩过的坑：第一版移动测试只试第一个玩家单位的 8 个邻格，结果某个种子下它正好在
> 地图右下角 —— 5 个邻格越界、剩下 3 个被队友占满，一格都动不了。**那是合法局面，
> 不是 bug**。现在改成遍历所有玩家单位，任意一个动起来就算通过。



## 并行执行

场景矩阵按 `(场景, seed)` 拆成 8 个任务单元，由 `sim/pool.js` fork 多个进程并发跑
（默认 `CPU 核数 - 1`，上限 8）。全量校验从 125 秒降到 30~50 秒（含烟雾测试，
具体看机器负载）。

```bash
npm run verify              # 并行，约 30~50 秒
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
npm run verify          # 提交前跑全量，30~50 秒
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
