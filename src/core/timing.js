'use strict';
// 节奏控制：AI 每步之间等多久、怎么把控制权还给事件循环。
//
// 依赖注入方式见 game/movement.js 顶部对 rt 门面的说明。
//
// 【pause 在 fastSim 下必须是同步 resolve 的】
// 它被 ai/turnloop.js 在每个单位之后调一次。一局几百步，如果无头模拟里每步都真的
// 等，跑完 36 局要几个小时。返回一个已 resolve 的 Promise 让 await 立刻继续 ——
// 注意这仍然会让出一次微任务，所以不会把调用栈撑爆。
//
// 【macroYield 是宏任务，pause 是微任务，两者不能互换】
// 微任务队列在同一个事件循环里跑完才会轮到宏任务。fastRun 的 while 循环全靠
// await pause 推进，它们全是微任务 —— 只让微任务的话，setTimeout / setInterval
// 会被完全饿死，进度条永远不动，Node 里连 process.exit 之前的 IO 都刷不出来。
// 所以 fastRun 每 40 步插一次 macroYield，强制让出一整轮。
//
// 优先用 setImmediate（Node）；浏览器没有它，退回 MessageChannel ——
// **不要用 setTimeout(0) 代替**：浏览器会把嵌套的 setTimeout 钳到最少 4ms，
// 几百次下来就是好几秒的纯等待。MessageChannel 没有这个钳制。
export function createTiming(rt) {
  function pause(ms) {
    if (rt.fastSim) {
      return Promise.resolve();
    }
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function macroYield() {
    if (typeof setImmediate === 'function') {
      return new Promise(resolve => setImmediate(resolve));
    }
    return new Promise(resolve => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => resolve();
      channel.port2.postMessage(0);
    });
  }

  // 观战模式下不等 —— 玩家没有操作，只是在看，慢放没有意义。
  // 否则把设置里的「AI 速度」（秒）换算成每步毫秒数，下限 120ms 保证看得清。
  function aiStepDelay() {
    if (rt.game?.settings?.spectator) {
      return 0;
    }
    return Math.max(120, Math.round((rt.game?.settings?.aiSpeed || 3) * 1000 / 10));
  }

  return { pause, macroYield, aiStepDelay };
}
