'use strict';
// 统计的写入侧：计数器、时间、历史快照。读取侧（画出来）在 render/stats.js。
//
// 依赖注入方式见 game/movement.js 顶部对 rt 门面的说明。
//
// 【为什么读写分开在两个文件】
// 这里的函数散布在战斗、生产、占领各处被调用；render/stats.js 只在打开统计面板时
// 跑。分开的好处是改图表样式永远碰不到计分规则，反之亦然。
//
// 【incrementStat 的判空写法看着别扭，但是对的】
//   if (!game?.stats?.[bucket]?.[owner] && game?.stats?.[bucket]?.[owner] !== 0)
// 不能简写成 `if (!game?.stats?.[bucket]?.[owner])` —— **计数器为 0 时那样会直接
// return**，于是所有阵营的第一次计数都会丢。这里要区分的是"这个键不存在"和
// "这个键的值是 0"，可选链本身做不到。
//
// 【时间统计不进基线】
// statTimeSeconds 读的是 Date.now()，每次跑都不一样。它只出现在 game.stats.history
// 的 time 字段里，而 sim/scenarios.js 的指纹**没有采集 history** —— 所以行为基线
// 不受墙上时钟影响。加字段进指纹之前先确认这一点还成立。
//
// 【strat 这一组是 AI 行为的可观测量】
// stalls / reserves / reroutes / retreats 等等，全都由 ai/turnloop.js 和
// ai/decide.js 在做出对应决策时 +1。它们是 verify 判断"AI 行为有没有变"的主要依据 ——
// 换句话说，**这些计数器就是 AI 的行为契约**。删一个等于失去一项回归保护。
export function createStats(rt) {
  // 玩家第一次真正操作时才开始计时，避免把"打开页面发呆十分钟"算进对局时长。
  function ensureStatsStarted() {
    const game = rt.game;
    if (game && !game.stats.startTime) {
      game.stats.startTime = Date.now();
      recordStatSnapshot('start');
    }
  }

  function statTimeSeconds() {
    const game = rt.game;
    if (!game?.stats?.startTime) {
      return 0;
    }
    // 对局结束后用 endTime 冻住，否则统计面板上的时长会一直涨。
    const end = game.stats.endTime || Date.now();
    return Math.max(0, Math.round((end - game.stats.startTime) / 1000));
  }

  // 折线图的一个数据点。每个计数器都要浅拷贝 —— 直接存引用的话，
  // 后续回合的累加会把历史上所有的点一起改掉，图会变成一条水平线。
  function recordStatSnapshot(label = '') {
    const game = rt.game;
    if (!game?.stats) {
      return;
    }
    game.stats.history.push({
      label,
      time: statTimeSeconds(),
      produced: { ...game.stats.produced },
      kills: { ...game.stats.kills },
      losses: { ...game.stats.losses },
      captures: { ...game.stats.captures },
      lostSites: { ...game.stats.lostSites }
    });
  }

  // 判空写法的理由见文件头，不要"简化"。
  function incrementStat(bucket, owner, value = 1) {
    const game = rt.game;
    if (!game?.stats?.[bucket]?.[owner] && game?.stats?.[bucket]?.[owner] !== 0) {
      return;
    }
    game.stats[bucket][owner] += value;
  }

  // strat 这一组用 typeof 检查，比上面那个直白 —— 因为它的键是固定的一批，
  // 拼错键名应该静默忽略而不是新增一个字段（那会污染基线指纹）。
  function incrementStrat(owner, key, value = 1) {
    const bucket = rt.game?.stats?.strat?.[owner];
    if (!bucket || typeof bucket[key] !== 'number') {
      return;
    }
    bucket[key] += value;
  }

  return { ensureStatsStarted, statTimeSeconds, recordStatSnapshot, incrementStat, incrementStrat };
}
