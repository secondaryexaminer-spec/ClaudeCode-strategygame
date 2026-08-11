'use strict';
// 战后统计面板：顶部六张汇总卡 + 一张按时间轴的折线图。
//
// 依赖注入方式见 game/movement.js 顶部对 rt 门面的说明。
//
// 【和 render/board.js 的区别：这里用的是另一块 canvas】
// board.js 画的是 #board，用的是 rt.ctx（main.js 在启动时取好的那个 2D context）。
// 这里画的是 #statsChart，每次都现取 getContext('2d') —— 因为统计面板平时是隐藏的，
// 启动时去取它的 context 没有意义，而且这张图一局只画几次，现取的开销可以忽略。
// 别为了"统一"把它也搬到 rt 上，那样会让 main.js 多持有一个几乎不用的引用。
//
// 【为什么统计数据的读写不在这里】
// incrementStat / incrementStrat / recordStatSnapshot 是写入侧，散布在战斗、生产、
// 占领等各处，属于游戏逻辑；这个文件只负责把 game.stats 画出来，是纯读取侧。
// 两边分开的好处是：改图表样式永远不会碰到计分规则。
//
// 【history 可能是空的】
// 对局刚开始（还没有任何 recordStatSnapshot）时 game.stats.history 是空数组，
// drawStatsChart 里那句 `history.length ? history : [{...}]` 就是给这种情况兜底 ——
// 用当前值造一个单点，图上是一个点而不是崩掉。删掉它会让开局立刻查看统计时报错。
//
// 这个文件不需要任何 import —— 它只读 game.stats 和 rt 上的三个访问器。

export function createStatsRenderer(rt) {
  // 图表可以左右翻页，这个数组的顺序就是翻页顺序，game.stats.chartIndex 是它的下标。
  function chartMetrics() {
    return [
      { key: 'produced', title: '生产单位数对比' },
      { key: 'kills', title: '击杀数对比' },
      { key: 'losses', title: '伤亡数对比' },
      { key: 'captures', title: '占领据点数对比' },
      { key: 'lostSites', title: '丢失据点数对比' }
    ];
  }

  // 图例用的短名。注意它和 core/constants.js 的 OWNER_NAMES 不是一回事 ——
  // 那份带阵营前缀，图例里放不下，所以这里单独算「AI N」。
  function statLabel(owner) {
    return owner === 'player' ? '玩家' : `AI ${Number(owner.slice(2)) + 1}`;
  }

  function renderStatsSummary(animate = true) {
    const game = rt.game;
    if (!game?.stats) {
      return;
    }
    const summary = document.getElementById('statsSummary');
    if (!summary) {
      return;
    }
    const totalProduced = Object.values(game.stats.produced).reduce((sum, value) => sum + value, 0);
    const totalKills = Object.values(game.stats.kills).reduce((sum, value) => sum + value, 0);
    const totalLosses = Object.values(game.stats.losses).reduce((sum, value) => sum + value, 0);
    const totalCaptures = Object.values(game.stats.captures).reduce((sum, value) => sum + value, 0);
    const totalLost = Object.values(game.stats.lostSites).reduce((sum, value) => sum + value, 0);
    const items = [
      { label: '本局时长', value: rt.statTimeSeconds(), suffix: 's' },
      { label: '总生产数', value: totalProduced, suffix: '' },
      { label: '总击杀数', value: totalKills, suffix: '' },
      { label: '总伤亡数', value: totalLosses, suffix: '' },
      { label: '总占领数', value: totalCaptures, suffix: '' },
      { label: '总丢失数', value: totalLost, suffix: '' }
    ];
    summary.innerHTML = items.map((item, index) => `<div class="summary-card"><span class="label">${item.label}</span><span class="value" data-stat-index="${index}" data-final="${item.value}" data-suffix="${item.suffix}">0${item.suffix}</span></div>`).join('');
    // animate=false 用于读档后恢复面板：直接落到终值，不要再从 0 滚一遍。
    if (!animate) {
      summary.querySelectorAll('[data-final]').forEach(node => {
        node.textContent = `${node.dataset.final}${node.dataset.suffix || ''}`;
      });
      return;
    }
    const start = performance.now();
    const duration = 600;
    const values = [...summary.querySelectorAll('[data-final]')];
    function tick(now) {
      const progress = Math.min(1, (now - start) / duration);
      values.forEach(node => {
        const target = Number(node.dataset.final || 0);
        node.textContent = `${Math.round(target * progress)}${node.dataset.suffix || ''}`;
      });
      if (progress < 1) {
        requestAnimationFrame(tick);
      }
    }
    requestAnimationFrame(tick);
  }

  function drawStatsChart() {
    const game = rt.game;
    if (!game?.stats) {
      return;
    }
    const canvasEl = document.getElementById('statsChart');
    const titleEl = document.getElementById('chartTitle');
    if (!canvasEl || !titleEl) {
      return;
    }
    const metric = chartMetrics()[game.stats.chartIndex % chartMetrics().length];
    titleEl.textContent = metric.title;
    const chartCtx = canvasEl.getContext('2d');
    const width = canvasEl.width;
    const height = canvasEl.height;
    chartCtx.clearRect(0, 0, width, height);
    chartCtx.fillStyle = '#101820';
    chartCtx.fillRect(0, 0, width, height);
    chartCtx.strokeStyle = 'rgba(255,255,255,0.08)';
    chartCtx.lineWidth = 1;
    for (let i = 0; i < 5; i++) {
      const y = 20 + i * (height - 40) / 4;
      chartCtx.beginPath();
      chartCtx.moveTo(40, y);
      chartCtx.lineTo(width - 10, y);
      chartCtx.stroke();
    }
    const history = game.stats.history.length ? game.stats.history : [{ time: 0, [metric.key]: { ...game.stats[metric.key] } }];
    // maxTime / maxValue 至少取 1，否则全零的开局会除以 0 得到 NaN 坐标。
    const maxTime = Math.max(1, ...history.map(point => point.time));
    const maxValue = Math.max(1, ...history.flatMap(point => Object.values(point[metric.key] || {})));
    rt.ownerOrder().forEach(owner => {
      chartCtx.strokeStyle = rt.ownerColor(owner);
      chartCtx.lineWidth = 2;
      chartCtx.beginPath();
      history.forEach((point, index) => {
        const x = 40 + (point.time / maxTime) * (width - 60);
        const y = height - 20 - ((point[metric.key]?.[owner] || 0) / maxValue) * (height - 40);
        if (index === 0) {
          chartCtx.moveTo(x, y);
        } else {
          chartCtx.lineTo(x, y);
        }
      });
      chartCtx.stroke();
      chartCtx.fillStyle = rt.ownerColor(owner);
      chartCtx.fillRect(width - 130, 16 + rt.ownerOrder().indexOf(owner) * 16, 10, 10);
      chartCtx.fillStyle = '#d8e6f7';
      chartCtx.font = '11px sans-serif';
      chartCtx.fillText(statLabel(owner), width - 115, 25 + rt.ownerOrder().indexOf(owner) * 16);
    });
    chartCtx.fillStyle = '#8b9bb0';
    chartCtx.font = '11px sans-serif';
    chartCtx.fillText('时间', width / 2 - 10, height - 6);
  }

  return { chartMetrics, statLabel, renderStatsSummary, drawStatsChart };
}
