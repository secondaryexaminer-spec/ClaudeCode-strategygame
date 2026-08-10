'use strict';
// 多进程执行器：把场景矩阵拆成 (场景, seed) 任务单元并发跑，产出与
// scenarios.js 的串行版 runScenarios() 结构完全相同的结果树。
//
// 为什么要它：串行跑完 6 个场景要接近 2 分钟，而重构期间每改一刀就得验一次，
// 这个等待直接决定了迭代速度。任务单元之间没有任何数据依赖（每局的随机数由
// seed 独立决定），是标准的易并行问题。
//
// 【结果必须与串行版逐字节一致】—— 否则基线就失效了。这一点不能靠推理保证，
// 只能靠实测：并行跑一遍去比对同一份 baseline.json，全绿才算数。首次接入时
// 已这样验证过。若日后哪天并行与串行结果对不上，那说明代码里有跨局残留的
// 模块级状态（缓存没清干净之类），那本身就是必须修的 bug，不要靠退回串行掩盖。
const os = require('os');
const path = require('path');
const { fork } = require('child_process');
const { SCENARIOS } = require('./scenarios');

const WORKER = path.join(__dirname, 'worker.js');
const MARKER = '__RESULT__';

// 留一个核给主进程和系统；上限 8 是经验值，再多进程启动开销就吃掉收益了。
function defaultJobs() {
  return Math.max(1, Math.min((os.cpus() || []).length - 1 || 1, 8));
}

function runOne(task) {
  return new Promise((resolve, reject) => {
    const child = fork(WORKER, [`scenario=${task.id}`, `seed=${task.seed}`], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    });
    let out = '';
    let err = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { err += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) {
        reject(new Error(`worker ${task.id}/seed${task.seed} 退出码 ${code}\n${err.trim() || out.trim()}`));
        return;
      }
      const idx = out.lastIndexOf(MARKER);
      if (idx < 0) {
        reject(new Error(`worker ${task.id}/seed${task.seed} 没有回传结果\n${err.trim() || out.trim()}`));
        return;
      }
      try {
        resolve(JSON.parse(out.slice(idx + MARKER.length).trim()));
      } catch (parseErr) {
        reject(new Error(`worker ${task.id}/seed${task.seed} 结果解析失败：${parseErr.message}`));
      }
    });
  });
}

async function runScenariosParallel({ only = null, jobs = 0, onProgress = null } = {}) {
  const list = SCENARIOS.filter(scn => !only || only.has(scn.id));
  if (!list.length) {
    throw new Error(`没有匹配的场景（可用：${SCENARIOS.map(s => s.id).join(', ')}）`);
  }

  const tasks = [];
  for (const scn of list) {
    for (const seed of scn.seeds) {
      tasks.push({ id: scn.id, seed, scn });
    }
  }

  // 长任务先派发：seeds 多的场景排前面，避免最后剩一个大任务干等。
  tasks.sort((a, b) => b.scn.rounds * b.scn.cap - a.scn.rounds * a.scn.cap);

  const limit = Math.max(1, Math.min(jobs || defaultJobs(), tasks.length));
  const out = {};
  for (const scn of list) {
    out[scn.id] = { desc: scn.desc, cap: scn.cap, rounds: scn.rounds, bySeed: {} };
  }

  let cursor = 0;
  let done = 0;
  const total = tasks.length;

  async function drain() {
    while (cursor < total) {
      const task = tasks[cursor++];
      const payload = await runOne(task);
      out[task.id].bySeed[`seed${task.seed}`] = payload;
      done += 1;
      if (onProgress) {
        onProgress(task.scn, task.seed, done, total);
      }
    }
  }

  await Promise.all(Array.from({ length: limit }, () => drain()));

  // bySeed 的 key 顺序按派发顺序会乱掉，这里按场景定义里的 seeds 顺序重排。
  // 比对本身用的是 deepDiff（按 key 取值，与顺序无关），但保持顺序稳定能让
  // snapshot 写出的 baseline.json 在 git diff 里干净。
  for (const scn of list) {
    const ordered = {};
    for (const seed of scn.seeds) {
      ordered[`seed${seed}`] = out[scn.id].bySeed[`seed${seed}`];
    }
    out[scn.id].bySeed = ordered;
  }
  return out;
}

module.exports = { runScenariosParallel, defaultJobs };
