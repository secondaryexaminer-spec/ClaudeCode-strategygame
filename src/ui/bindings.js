'use strict';
// 事件绑定：把 DOM 上的点击、输入、按键接到已有的功能函数上。
//
// 依赖注入方式见 game/movement.js 顶部对 rt 门面的说明；这里额外接收一个 deps，
// 理由和 debug/hooks.js 一样 —— 这几十个函数只有绑定层要用，塞进 rt 会让运行时
// 门面里混进一批别的模块根本不关心的项。
//
// 【这一层只做三件事，多一件都不做】
//   1. 从 DOM 读出参数（按钮的 dataset、输入框的 value）
//   2. 调一个已经存在的功能函数
//   3. 按返回值决定 toast 什么、要不要 refresh()
//
// **任何判断"能不能做"的逻辑都不属于这里**。按钮该不该变灰由 ui/panels.js 算，
// 操作合不合法由 game/build.js、game/transport.js 里的 canXxx 判定。这一层如果
// 开始出现 if (金币够不够)，就说明规则被复制到了第二个地方。
//
// 【为什么用事件委托】
// buildGrid / selActions / engineerCard 里的按钮是 updatePanels 每次重画时新建的，
// 直接给按钮绑 onclick 的话，每次重画都要重绑一遍，漏一次就有按钮点不动。
// 绑在不会被替换的容器上、靠 closest('[data-xxx]') 找回目标，就没有这个问题 ——
// 代价是 dataset 的名字成了 panels.js 和这里之间的契约，改名要两边一起改。
//
// 【selectedSaveKey 住在这里】
// 它是"读档页面上当前高亮的是哪一行"，纯界面状态：不进存档、不参与规则、
// 离开读档页就没意义。除了这个文件没有第二处会读它。
//
// 【这一层的覆盖只有一条，但那一条很值】
// sim/smoke-render.js 会检查 MUST_BE_BOUND 清单里的每个元素是不是**真的挂上了
// 处理器** —— 漏掉一行 addEventListener 不会报任何错，那个按钮只是永远点不动，
// 而无头环境里谁也不会去点它。这条断言实跑验证过：注释掉 btnEndTurn 和 btnResume
// 两行就会红。**加新按钮时记得把它的 id 加进那份清单。**
//
// 但"挂上了"不等于"挂对了"：点了会发生什么、参数传得对不对、toast 文案合不合适，
// 一概没测。改这个文件还是要开浏览器实际点一遍。
import { MAPS } from '../core/constants.js';
import { normalizeCargoTypes, effectiveMove } from '../game/entities.js';
import { downloadSaveFile } from '../io/saves.js';

export function createBindings(rt, deps) {
  const $ = id => document.getElementById(id);
  const {
    // 大厅
    renderAISettings, syncSliderLabels, renderSaveList, renderLobbyPreview,
    showScreen, startGameFlow,
    // 面板
    uiState, setCargoPreset, engineerSelected,
    // 棋盘交互
    onBoard, beginPan, panBy, endPan, zoomAt, consumeContextSuppression,
    endTurn, selectRef, draw,
    // 统计
    chartMetrics, drawStatsChart,
    // 生产与据点
    buildAtSite, buildBudgetLeft, sellUnit, upgradeSite, fullHealSite, buildCamp,
    autoLoadAdjacent, autoUnloadAdjacent, endGameNeutral,
    // 存档
    buildSavePayload, saveAsNewSave, overwriteCurrentSave, importSaveToList,
    currentSaveName, loadSave, deleteSave, readSave
  } = deps;

  // 读档页面上当前高亮的那一行，见文件头。
  let selectedSaveKey = null;

  // 大厅：下拉框、滑块、AI 数量。
  function bindLobby() {
    $('aiSelect').addEventListener('change', renderAISettings);
    // 三个滑块共用同一个标签同步函数，格式只写在 ui/lobby.js 一处。
    for (const id of ['citySpread', 'aiSpeed', 'buildCap']) {
      $(id).addEventListener('input', syncSliderLabels);
    }
    // 这几个会改变地图形状，改完要重画预览。
    for (const id of ['mapSelect', 'sizeSelect', 'aspectSelect', 'complexitySelect', 'aiSelect']) {
      $(id)?.addEventListener('change', renderLobbyPreview);
    }
    $('btnStartGame').onclick = startGameFlow;
    $('btnNewGame').onclick = () => showScreen('setup');
    $('btnHelp').onclick = () => $('helpModal').classList.remove('hidden');
    $('btnHelpLobby').onclick = () => $('helpModal').classList.remove('hidden');
    $('btnHelpClose').onclick = () => $('helpModal').classList.add('hidden');
    $('btnInfoPage').onclick = () => showScreen('info');
    $('btnInfoClose').onclick = () => showScreen('setup');
  }

  // 右侧面板：生产、单位动作、工程师、据点管理。全部走事件委托，见文件头。
  function bindPanels() {
    $('buildGrid').addEventListener('click', event => {
      const button = event.target.closest('[data-type]');
      const siteEntry = rt.selectedSite();
      if (!button || !siteEntry) {
        return;
      }
      const cargoTypes = button.dataset.type === 'transport' ? normalizeCargoTypes(uiState.shipyardCargo) : [];
      if (!buildAtSite('player', siteEntry, button.dataset.type, { cargoTypes })) {
        // 分两种提示：造兵额度用完了 vs 这个据点造不了这个兵种。
        rt.toast(buildBudgetLeft('player') <= 0 ? '本回合造兵已达上限。' : '无法在该据点生产该单位。');
      }
      rt.refresh();
    });
    $('buildBody').addEventListener('change', event => {
      const input = event.target.closest('[data-cargo-preset]');
      if (!input) {
        return;
      }
      setCargoPreset(input.dataset.cargoPreset, Number(input.dataset.cargoSlot), input.value);
      rt.refresh();
    });
    $('selActions').addEventListener('click', event => {
      // 同格叠放时列出的"切换到这一个"按钮，优先于下面的动作按钮。
      const pick = event.target.closest('[data-select-unit]');
      if (pick) {
        const chosen = rt.game?.units.find(entry => entry.id === pick.dataset.selectUnit);
        if (chosen) {
          selectRef('unit', chosen);
          rt.refresh();
        }
        return;
      }
      const button = event.target.closest('[data-unit-action]');
      if (!button || !rt.game?.selected || rt.game.selected.kind !== 'unit') {
        return;
      }
      const unitEntry = rt.game.selected.ref;
      if (button.dataset.unitAction === 'load' && !autoLoadAdjacent(unitEntry)) {
        rt.toast('附近没有可装载的己方陆军。');
      }
      if (button.dataset.unitAction === 'unload' && !autoUnloadAdjacent(unitEntry)) {
        rt.toast('附近没有可登陆的空地。');
      }
      if (button.dataset.unitAction === 'sell' && !sellUnit('player', unitEntry)) {
        rt.toast('当前无法变卖该单位。');
      }
      rt.refresh();
    });
    $('engineerCard').addEventListener('change', event => {
      const input = event.target.closest('[data-cargo-preset]');
      if (!input) {
        return;
      }
      setCargoPreset(input.dataset.cargoPreset, Number(input.dataset.cargoSlot), input.value);
      rt.refresh();
    });
    $('engineerCard').addEventListener('click', event => {
      const button = event.target.closest('[data-engineer-build]');
      const engineer = engineerSelected();
      if (!button || !engineer || rt.game.side !== 'player') {
        return;
      }
      if (button.dataset.engineerBuild === 'camp') {
        if (!buildCamp(engineer)) {
          rt.toast('当前无法建立临时营地。');
        }
        rt.refresh();
        return;
      }
      // 造船是两步操作：这里只记下意图，等玩家点海格时才真正下水。
      // 高亮哪些海格可用由 render/board.js 读 pendingOrder 决定。
      rt.game.pendingOrder = {
        kind: 'engineer-launch',
        builderId: engineer.id,
        product: button.dataset.engineerBuild,
        cargoTypes: button.dataset.engineerBuild === 'transport' ? normalizeCargoTypes(uiState.engineerCargo) : []
      };
      rt.refresh();
    });
    $('btnUpgrade').onclick = () => {
      const siteEntry = rt.selectedSite();
      if (!siteEntry || !upgradeSite('player', siteEntry)) {
        rt.toast('无法升级该据点。');
      }
      rt.refresh();
    };
    $('btnFullHeal').onclick = () => {
      const siteEntry = rt.selectedSite();
      if (!siteEntry || !fullHealSite('player', siteEntry)) {
        rt.toast('当前条件下无法修整驻军。');
      }
      rt.refresh();
    };
    $('btnEndTurn').onclick = endTurn;
  }

  // 棋盘：点击、右键拖拽、滚轮缩放。真正的换算在 ui/input.js。
  function bindBoard() {
    const canvas = rt.canvas;
    canvas.addEventListener('click', onBoard);
    canvas.addEventListener('mousedown', beginPan);
    canvas.addEventListener('wheel', event => {
      if (!rt.game || rt.game.over) {
        return;
      }
      event.preventDefault();
      zoomAt(event);
      draw();
    }, { passive: false });
    // 拖拽要在整个窗口上监听：光标划出画布时不能中断。
    window.addEventListener('mousemove', event => {
      if (panBy(event)) {
        draw();
      }
    });
    window.addEventListener('mouseup', endPan);
    canvas.addEventListener('contextmenu', event => {
      event.preventDefault();
      // 刚拖拽完的那一次右键不当成"取消选中"，见 ui/input.js。
      if (consumeContextSuppression()) {
        return;
      }
      rt.clearPendingOrder();
      rt.game.selected = null;
      rt.refresh();
    });
    document.addEventListener('keydown', event => {
      if (event.code === 'Space') {
        // 不 preventDefault 的话空格会滚动页面。
        event.preventDefault();
        endTurn();
      }
      if (event.key === 'n' || event.key === 'N') {
        showScreen('setup');
      }
      if (event.key === 'Escape' && rt.game) {
        rt.game.selected = null;
        rt.refresh();
      }
    });
  }

  // 暂停菜单、结算弹窗、统计图表翻页。
  function bindModals() {
    $('btnPause').onclick = () => {
      if (rt.game && !rt.game.over) {
        $('pauseModal').classList.remove('hidden');
      }
    };
    $('btnResume').onclick = () => $('pauseModal').classList.add('hidden');
    $('btnEndGame').onclick = () => endGameNeutral();
    // 「继续自由游戏」：胜负已定但玩家想接着打。把己方单位的行动力全部恢复，
    // 否则解除 over 之后这一回合所有人都是"已行动"状态，等于白白跳过一回合。
    $('btnModalContinue').onclick = () => {
      const game = rt.game;
      game.over = false;
      game.freeplay = true;
      game.side = 'player';
      for (const unitEntry of game.units.filter(entry => rt.areAllies(entry.owner, 'player'))) {
        unitEntry.maxMove = effectiveMove(unitEntry);
        unitEntry.move = unitEntry.maxMove;
        unitEntry.acted = false;
        unitEntry.hasAttacked = false;
      }
      $('overlay').classList.add('hidden');
      rt.refresh();
    };
    $('btnModalOk').onclick = () => {
      $('overlay').classList.add('hidden');
      showScreen('setup');
    };
    $('btnChartPrev').onclick = () => {
      if (!rt.game?.stats) {
        return;
      }
      // 加 length 再取模，避免下标为 0 时减成 -1。
      rt.game.stats.chartIndex = (rt.game.stats.chartIndex + chartMetrics().length - 1) % chartMetrics().length;
      drawStatsChart();
    };
    $('btnChartNext').onclick = () => {
      if (!rt.game?.stats) {
        return;
      }
      rt.game.stats.chartIndex = (rt.game.stats.chartIndex + 1) % chartMetrics().length;
      drawStatsChart();
    };
  }

  // 存档：保存对话框、读档页、导入导出。
  function bindSaves() {
    $('btnSaveGame').onclick = () => {
      $('pauseModal').classList.add('hidden');
      // 有当前存档才显示"覆盖"按钮，否则只能另存。
      const hasCurrent = !!rt.currentSaveKey;
      $('btnSaveOverwrite').classList.toggle('hidden', !hasCurrent);
      $('saveNameInput').value = hasCurrent ? currentSaveName() : `${MAPS[rt.game.settings.map]?.name || '战局'} · 第 ${rt.game.turn} 回合`;
      $('saveModal').classList.remove('hidden');
      $('saveNameInput').focus();
    };
    $('btnSaveOverwrite').onclick = () => {
      rt.toast(overwriteCurrentSave($('saveNameInput').value.trim()) ? '已覆盖当前存档。' : '覆盖失败。');
      $('saveModal').classList.add('hidden');
    };
    $('btnSaveConfirm').onclick = () => {
      rt.toast(saveAsNewSave($('saveNameInput').value.trim()) ? '已另存为新存档。' : '保存失败，存储空间可能已满。');
      $('saveModal').classList.add('hidden');
    };
    $('btnSaveExport').onclick = () => {
      downloadSaveFile(buildSavePayload($('saveNameInput').value.trim()));
      $('saveModal').classList.add('hidden');
      rt.toast('已导出存档文件，可放入游戏的 saves 文件夹长期保存。');
    };
    $('btnSaveCancel').onclick = () => $('saveModal').classList.add('hidden');
    $('btnLoadPage').onclick = () => { selectedSaveKey = null; showScreen('load'); };
    $('btnLoadBack').onclick = () => showScreen('setup');
    $('saveListBody').addEventListener('click', event => {
      const row = event.target.closest('.save-row');
      if (!row) {
        return;
      }
      selectedSaveKey = row.dataset.key;
      [...$('saveListBody').querySelectorAll('.save-row')].forEach(el => el.classList.toggle('selected', el === row));
    });
    $('btnLoadConfirm').onclick = () => {
      if (!selectedSaveKey) {
        rt.toast('请先选择一个存档。');
        return;
      }
      if (!loadSave(selectedSaveKey)) {
        rt.toast('该存档已损坏，无法读取。');
      }
    };
    $('btnLoadDelete').onclick = () => {
      if (!selectedSaveKey) {
        rt.toast('请先选择一个存档。');
        return;
      }
      deleteSave(selectedSaveKey);
      selectedSaveKey = null;
      renderSaveList();
      rt.toast('已删除该存档。');
    };
    $('btnExportSave').onclick = () => {
      if (!selectedSaveKey) {
        rt.toast('请先选择一个存档再导出。');
        return;
      }
      try {
        // readSave 把「存档损坏」从抛异常变成了返回 null，这里要显式还原成
        // 失败提示 —— 否则损坏的存档会走到下面那句「已导出」，而实际什么都没下载。
        const payload = readSave(selectedSaveKey);
        if (!payload) {
          throw new Error('存档内容无法解析');
        }
        downloadSaveFile(payload);
        rt.toast('已导出存档文件，可放入游戏的 saves 文件夹长期保存。');
      } catch (err) {
        rt.toast('导出失败：该存档已损坏。');
      }
    };
    // <input type="file"> 长得丑，藏起来用按钮触发。
    $('btnImportSave').onclick = () => $('importFile').click();
    $('importFile').addEventListener('change', event => {
      const file = event.target.files?.[0];
      if (!file) {
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        try {
          if (importSaveToList(JSON.parse(reader.result))) {
            renderSaveList();
            rt.toast('已导入存档并加入列表，点击它即可继续。');
          } else {
            rt.toast('导入失败：文件格式不正确。');
          }
        } catch (err) {
          rt.toast('导入失败：文件无法解析。');
        }
      };
      reader.readAsText(file);
      // 清空 value，否则连续导入同一个文件不会再触发 change。
      event.target.value = '';
    });
  }

  function bindAll() {
    bindLobby();
    bindPanels();
    bindBoard();
    bindModals();
    bindSaves();
  }

  return { bindAll, bindLobby, bindPanels, bindBoard, bindModals, bindSaves };
}
