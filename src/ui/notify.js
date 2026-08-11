'use strict';
// 两种消息通道：战斗日志（留在面板里）和吐司提示（1.8 秒后消失）。
//
// 依赖注入方式见 game/movement.js 顶部对 rt 门面的说明。
//
// 【为什么分成两个】
// log 是**游戏内的事件记录**，写进 game.logs，会被存档带走，玩家可以回翻。
// toast 是**对玩家操作的即时反馈**（"金币不够"、"这里不能建"），不属于游戏状态，
// 不进存档，也不该被 AI 触发。判断标准：这条消息读档之后还有意义吗？
//
// 【日志上限 80 条是必须的】
// 一局打满 120 回合、几个 AI 各自行动，日志能涨到几千条。它进存档、每次
// updatePanels 都要整个重新拼成 HTML —— 不封顶的话后期每帧都在拼几百 KB 字符串。
// 用 shift() 而不是定期截断，是为了让上限始终精确成立。
//
// 【toastTimer 必须是模块级的】
// 连续两次 toast 时，第二次要取消第一次的隐藏定时器 —— 否则第一次的定时器会在
// 第二条消息还在显示时把它关掉。这就是这个模块有状态的唯一原因。
export function createNotify(rt) {
  const $ = id => document.getElementById(id);

  // 见文件头。上限一旦调整，长局的存档体积和面板刷新开销都会跟着变。
  const MAX_LOGS = 80;
  let toastTimer = null;

  function log(text, kind = '') {
    rt.game.logs.push({ text, kind });
    if (rt.game.logs.length > MAX_LOGS) {
      rt.game.logs.shift();
    }
  }

  function toast(text) {
    $('toast').textContent = text;
    $('toast').classList.remove('hidden');
    // 取消上一条的隐藏定时器，理由见文件头。
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => $('toast').classList.add('hidden'), 1800);
  }

  return { log, toast };
}
