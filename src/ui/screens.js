'use strict';
// 屏幕切换与加载动画。
//
// 依赖注入方式见 game/movement.js 顶部对 rt 门面的说明；额外的 deps 见
// debug/hooks.js 的说明。
//
// 【四块屏幕是互斥的，靠 hidden 类切换】
// setup（大厅）/ game（对局）/ info（规则页）/ load（读档页）任何时刻只显示一个。
// showScreen 是唯一的切换入口 —— 不要在别处直接 classList.toggle('hidden')，
// 否则会出现两块屏幕同时可见或者全都不可见。
//
// 【两个加载动画看着像，但语义不同，不要合并】
//   runLoadingScreen —— 新开局。进度条按**阵营**分条推进，每条随机在 70~100%
//     之间"卡一下"再冲到底，营造多方同时部署的感觉。它是新局的必经之路。
//   runLoadProgress  —— 读档。没有阵营条，但**保证至少显示 1 秒**：读档本身是
//     同步的、几乎瞬时，不兜一下的话进度条会闪一下就没，看起来像出了错。
// 合并成一个带参数的版本试过之后会发现分支比重复代码还多。
//
// 【它们都是异步的，这一点会传染】
// 两个函数都用 setInterval 驱动，完成后才调 done()。所以「开新局」这件事在非
// fastSim 下**不是同步完成的**：newGame() 返回时首回合还没开始。
// 这正是 sim/smoke-render.js 必须用 __frontierDebug.redraw() 强制绘制的原因 ——
// 测试里等不到那个 setInterval。
//
// 【LOADING_TIPS 消耗随机数】
// 挑提示语用了 Math.random()。它只在非 fastSim 下执行，所以不影响行为基线的
// 确定性 —— 但如果哪天有人把加载画面搬进 fastSim 路径，基线会整体失效。
import { VIEW_MAX_W, VIEW_MAX_H, MAPS, SIZES } from '../core/constants.js';

const LOADING_TIPS = [
  '战术：长枪兵对骑兵有克制加成，把它们摆在骑兵冲锋的正面。',
  '战术：战船克制运兵船，护航或拦截时优先让战船贴身。',
  '技巧：运兵船现在最多可搭载 5 个陆军单位，登陆后立即释放。',
  '技巧：运兵船卸下的单位可在同一格堆叠（每格最多 3 个），点击堆叠格可循环选择操控。',
  '技巧：大地图下长按右键并拖动鼠标即可平移视野，右下角小地图显示当前视口。',
  '战术：工程师能在海边直接造舰，也能原地建立可维持 3 回合的临时营地。',
  '经济：占领油田和军营能显著增强产能，冷酷 AI 会优先争夺它们。',
  '战术：骑兵满机动接战时获得冲锋加成，保留移动力再发起冲锋。',
  '技巧：驻军可花金币修整，残血精锐撤回城市回血再战更划算。',
  '历史：两栖登陆的关键从来不是抢滩，而是能否持续把后续兵力运上岸。',
  '战术：弩手爆发高但脆弱，用剑士与近卫在前排为其挡刀。',
  '技巧：单位击杀累积可晋升老兵，提升机动与续航，注意保护高阶单位。',
  '提示：设置里可调收入倍率与每回合造兵上限，用来打造快节奏或持久战。',
  '战术：把富余陆军用空运兵船循环转运到敌军薄弱的海岸，是破解岛屿僵局的钥匙。',
  '历史：制海权决定制陆权——失去海上补给线的滩头阵地终将枯萎。'
];

const BLOCK_COUNT = 44;

export function createScreens(rt, deps) {
  const $ = id => document.getElementById(id);
  const {
    newGame, drawPreview, renderLobbyPreview, renderSaveList,
    centerCamOn, clearDistFieldCache, clearLandReachCache, aiTurn
  } = deps;

  // 铺满进度条的小方块，返回它们的引用供后续点亮。
  function makeBlocks() {
    $('loadingBlocks').innerHTML = Array.from({ length: BLOCK_COUNT }, () => '<i class="lblock"></i>').join('');
    return [...$('loadingBlocks').querySelectorAll('.lblock')];
  }

  function lightBlocks(blocks, progress) {
    const lit = Math.round(BLOCK_COUNT * progress / 100);
    blocks.forEach((block, index) => block.classList.toggle('on', index < lit));
    $('loadingPercent').textContent = Math.round(progress);
  }

  // 新开局的加载画面，按阵营分条。
  function runLoadingScreen(owners, done) {
    const screen = $('loadingScreen');
    if (!screen) {
      // 没有这个元素（比如精简版页面）就直接开局，不要卡住。
      done();
      return;
    }
    const game = rt.game;
    drawPreview();
    $('loadingMapName').textContent = `${MAPS[game.settings.map].name} · 部署中`;
    $('loadingMapMeta').textContent = `${SIZES[game.settings.size].name} · ${rt.W}×${rt.H} · ${game.sites.filter(e => e.kind === 'city').length} 城 / ${game.sites.filter(e => e.kind === 'shipyard').length} 船坞`;
    const blocks = makeBlocks();
    // target 是这一条"卡一下"的位置：到了之后加速冲刺，制造节奏差。
    const sides = owners.map(owner => ({ owner, target: 70 + Math.random() * 30, value: 0 }));
    $('loadingSides').innerHTML = sides.map(side => `<div class="lside"><span class="ldot" style="background:${rt.ownerColor(side.owner)}"></span><span class="lname">${rt.ownerName(side.owner)}</span><span class="lbar"><i data-owner="${side.owner}"></i></span><span class="lpct" data-pct="${side.owner}">0%</span></div>`).join('');
    let tipIndex = Math.floor(Math.random() * LOADING_TIPS.length);
    $('loadingTip').textContent = LOADING_TIPS[tipIndex];
    screen.classList.remove('hidden');
    let progress = 0;
    let tipTick = 0;
    const timer = setInterval(() => {
      progress = Math.min(100, progress + 2 + Math.random() * 4);
      lightBlocks(blocks, progress);
      for (const side of sides) {
        side.value = Math.min(100, side.value + (progress >= side.target ? 6 + Math.random() * 8 : 2 + Math.random() * 5));
        const bar = $('loadingSides').querySelector(`i[data-owner="${side.owner}"]`);
        const pct = $('loadingSides').querySelector(`span[data-pct="${side.owner}"]`);
        if (bar) {
          bar.style.width = `${side.value}%`;
        }
        if (pct) {
          pct.textContent = `${Math.round(side.value)}%`;
        }
      }
      // 约每 1.3 秒换一条提示语。
      if (++tipTick % 14 === 0) {
        tipIndex = (tipIndex + 1) % LOADING_TIPS.length;
        $('loadingTip').textContent = LOADING_TIPS[tipIndex];
      }
      // 总进度和每条阵营进度都满了才收 —— 只看总进度会让阵营条停在半截。
      if (progress >= 100 && sides.every(side => side.value >= 100)) {
        clearInterval(timer);
        setTimeout(() => {
          screen.classList.add('hidden');
          done();
        }, 350);
      }
    }, 90);
  }

  // 读档的加载画面。保证至少显示 1 秒，理由见文件头。
  function runLoadProgress(done) {
    const screen = $('loadingScreen');
    if (!screen) {
      done();
      return;
    }
    const game = rt.game;
    drawPreview();
    $('loadingMapName').textContent = `读取存档 · ${MAPS[game.settings.map]?.name || '战局'}`;
    $('loadingMapMeta').textContent = `第 ${game.turn} 回合 · ${SIZES[game.settings.size]?.name || `${rt.W}×${rt.H}`}`;
    $('loadingSides').innerHTML = '';
    $('loadingTip').textContent = LOADING_TIPS[Math.floor(Math.random() * LOADING_TIPS.length)];
    const blocks = makeBlocks();
    screen.classList.remove('hidden');
    const started = performance.now();
    const minMs = 1000;
    let progress = 0;
    const timer = setInterval(() => {
      const elapsed = performance.now() - started;
      // 取"自然增长"和"按时间应该到哪"的较大值：既不会太慢，也不会早于 minMs 结束。
      progress = Math.min(100, Math.max(progress + 3 + Math.random() * 6, elapsed / minMs * 100));
      lightBlocks(blocks, progress);
      if (progress >= 100 && elapsed >= minMs) {
        clearInterval(timer);
        setTimeout(() => {
          screen.classList.add('hidden');
          done();
        }, 200);
      }
    }, 60);
  }

  // 四块屏幕的唯一切换入口，见文件头。
  function showScreen(name) {
    const setupEl = $('setupScreen');
    const gameEl = $('gameScreen');
    const infoEl = $('infoScreen');
    if (setupEl) {
      setupEl.classList.toggle('hidden', name !== 'setup');
    }
    if (gameEl) {
      gameEl.classList.toggle('hidden', name !== 'game');
    }
    if (infoEl) {
      infoEl.classList.toggle('hidden', name !== 'info');
    }
    $('loadScreen')?.classList.toggle('hidden', name !== 'load');
    if (name === 'setup') {
      // 回大厅时把结算框和加载画面一起收掉，否则从"战败"退回来会看到残留的遮罩。
      $('overlay')?.classList.add('hidden');
      $('loadingScreen')?.classList.add('hidden');
      renderLobbyPreview();
    }
    if (name === 'load') {
      renderSaveList();
    }
  }

  function startGameFlow() {
    showScreen('game');
    newGame();
  }

  // 把一份存档装进当前运行时。
  //
  // 它横跨三层：改全局尺寸（状态）、切屏幕并居中摄像机（视图）、决定接下来轮到谁走
  // （流程）。之所以不拆得更细，是因为这三件事**必须按这个顺序**发生：尺寸没设好
  // 就居中会算错，屏幕没切就刷新会画到隐藏的画布上，AI 没接管则轮次会停住。
  function loadPayload(payload) {
    if (!payload?.state) {
      return false;
    }
    rt.setDimensions(payload.W, payload.H);
    rt.setCellSize(payload.S);
    rt.resizeCanvas(Math.min(payload.W * payload.S, VIEW_MAX_W), Math.min(payload.H * payload.S, VIEW_MAX_H));
    rt.resetCamera();
    // 两个缓存都依赖地形/单位位置，换局必须清 —— 不清会让寻路读到上一局的地图。
    clearDistFieldCache();
    clearLandReachCache();
    rt.setGame(payload.state);
    const game = rt.game;
    game.selected = null;
    game.pendingOrder = null;
    showScreen('game');
    // 镜头落在己方（观战时是首个阵营）的第一座城上，比落在 (0,0) 有意义。
    const focusOwner = game.settings?.spectator ? game.ownerOrder[0] : 'player';
    const focusCity = game.sites.find(entry => entry.kind === 'city' && entry.owner === focusOwner);
    if (focusCity) {
      centerCamOn(focusCity.x, focusCity.y);
    }
    const finishLoad = () => {
      rt.refresh();
      // 存档可能停在 AI 的回合中间，读完要把控制权交回去，否则游戏卡住不动。
      // 延迟 300ms 只是为了让玩家看清局面再开始动。
      if (!game.over && game.side !== 'player' && !rt.fastSim) {
        setTimeout(() => {
          if (!game.over && game.side !== 'player') {
            void aiTurn(game.side);
          }
        }, 300);
      }
    };
    if (rt.fastSim) {
      finishLoad();
    } else {
      runLoadProgress(finishLoad);
    }
    return true;
  }

  return { runLoadingScreen, runLoadProgress, showScreen, startGameFlow, loadPayload };
}
