'use strict';
// 大厅与信息页的界面：开局选项的下拉框、AI 配置表、地图预览、规则页、单位图鉴、
// 存档列表。全都是"把常量表渲染成 HTML"，不含任何游戏逻辑。
//
// 依赖注入方式见 game/movement.js 顶部对 rt 门面的说明。
//
// 【这一层的共同特征：只读常量，不读 game】
// fillSelectOptions / renderRules / renderCodex / renderAISettings 在还没有对局时
// 就要能跑（大厅界面在 newGame 之前就显示了），所以它们一律不碰 rt.game。
// 例外只有两个，都明确标注了：drawPreview 画的是**已经生成好的**那局地图，
// renderSaveList 读的是 localStorage 而不是当前对局。
//
// 【renderLobbyPreview 有副作用，而且是故意的】
// 它会写 W / H（通过 rt.setDimensions）—— 因为预览要按当前选的尺寸和纵横比画，
// 而算尺寸的 computeDimensions 和实际开局用的是同一个函数。让预览和开局共用同一
// 份尺寸，好处是"预览里看到的形状"和"开进去看到的形状"必然一致；代价是改动了
// 全局状态。
//
// **这不是可以随手清理的"脏"设计**：如果把它改成只算不写，newGame 里就得再算
// 一次，两处一旦不同步，预览和实际地图就会长得不一样。真要清理的话，正确做法是
// 把 W/H 从可变全局改成 MapDefinition 数据对象的字段，那是更大的一次重构。
//
// 【覆盖情况：比想象中好，但仍有一半是盲的】
// 大厅在 fastBatch 下完全不执行，所以 npm run verify 一行都测不到。但
// sim/smoke-render.js 建 harness 时会触发 DOMContentLoaded → setup() →
// showScreen('setup') → renderLobbyPreview()，于是这条链上的
// fillSelectOptions / syncSliderLabels / renderRules / renderCodex /
// renderAISettings / renderLobbyPreview **都在 strictDom 打桩下真跑过一遍**，
// 拼错属性名会当场抛错（实测验证过）。
// drawPreview / renderSaveList 要靠 __frontierDebug.repaintLobby 才跑得到。
//
// 仍然没覆盖的：下拉框 change 之后的重渲染、选项的实际内容对不对、
// 以及所有布局和样式。改完这个文件还是建议开一次浏览器。
import {
  TEAMS, TYPES, TERRAIN, MAPS, MODES, SIZES, ASPECTS, COMPLEX
} from '../core/constants.js';
import { colorOptions } from '../core/utils.js';
import { terrainFor } from '../world/mapgen.js';

// AI 配置表默认给每个 AI 分配的颜色，按行号轮转。
// 和 sim/harness.js 的 expandAiConfig 里那份是同一个顺序 —— 改这里要同步改那边，
// 否则无头模拟和真实大厅的默认配色会对不上。
const AI_DEFAULT_COLORS = ['crimson', 'violet', 'amber', 'jade', 'steel', 'sand', 'teal'];

export function createLobby(rt) {
  const $ = id => document.getElementById(id);

  // 把常量表灌进各个 <select>。只在 setup() 里调一次 —— 重复调会把选项加两遍。
  function fillSelectOptions() {
    for (const [id, meta] of Object.entries(MAPS)) {
      $('mapSelect').insertAdjacentHTML('beforeend', `<option value="${id}">${meta.name}</option>`);
    }
    for (const [id, name] of Object.entries(MODES)) {
      $('modeSelect').insertAdjacentHTML('beforeend', `<option value="${id}">${name}</option>`);
    }
    for (let count = 1; count <= 7; count++) {
      $('aiSelect').insertAdjacentHTML('beforeend', `<option value="${count}">${count} 名</option>`);
    }
    $('spectatorSelect').insertAdjacentHTML('beforeend', `<option value="off" selected>关闭</option><option value="on">开启</option>`);
    for (const team of TEAMS) {
      $('playerTeamSelect').insertAdjacentHTML('beforeend', `<option value="${team}" ${team === 'A' ? 'selected' : ''}>${team}组</option>`);
    }
    for (const [id, meta] of colorOptions()) {
      $('playerColorSelect').insertAdjacentHTML('beforeend', `<option value="${id}" ${id === 'azure' ? 'selected' : ''}>${meta.name}</option>`);
    }
    for (let count = 0; count <= 6; count++) {
      $('startUnitsSelect').insertAdjacentHTML('beforeend', `<option value="${count}" ${count === 4 ? 'selected' : ''}>${count} 个 / 阵营</option>`);
    }
    for (const [id, meta] of Object.entries(SIZES)) {
      $('sizeSelect').insertAdjacentHTML('beforeend', `<option value="${id}" ${id === 'medium' ? 'selected' : ''}>${meta.name}</option>`);
    }
    for (const [id, meta] of Object.entries(ASPECTS)) {
      $('aspectSelect').insertAdjacentHTML('beforeend', `<option value="${id}" ${id === 'standard' ? 'selected' : ''}>${meta.name}</option>`);
    }
    for (const [id, meta] of Object.entries(COMPLEX)) {
      $('complexitySelect').insertAdjacentHTML('beforeend', `<option value="${id}" ${id === 'medium' ? 'selected' : ''}>${meta.name}</option>`);
    }
    // 默认地图不是常量表里的第一个，单独指定。
    $('mapSelect').value = 'coast';
  }

  // 三个滑块的数值标签。初始化和 input 事件都用它，避免两处各写一遍格式。
  function syncSliderLabels() {
    $('spreadValue').textContent = `${$('citySpread').value}%`;
    $('aiSpeedValue').textContent = `${$('aiSpeed').value}s`;
    $('buildCapValue').textContent = `${$('buildCap').value}`;
  }

  // AI 配置表。注意这些 <select> 的 id 是**动态拼出来的**（ai0Diff、ai1Team……），
  // newGame 靠这套命名去读配置，sim/harness.js 的打桩也靠它。改命名规则要三处同步。
  function renderAISettings() {
    const count = Number($('aiSelect').value);
    $('aiRows').innerHTML = Array.from({ length: count }, (_, i) => {
      const colorOptionsMarkup = colorOptions().map(([key, meta]) => `<option value="${key}" ${key === AI_DEFAULT_COLORS[i % AI_DEFAULT_COLORS.length] ? 'selected' : ''}>${meta.name}</option>`).join('');
      // 默认把 AI 依次排进玩家之后的组，避免开局就全部同组。
      const defaultTeam = TEAMS[(i + 1) % TEAMS.length];
      const teamOptionsMarkup = TEAMS.map(team => `<option value="${team}" ${team === defaultTeam ? 'selected' : ''}>${team}组</option>`).join('');
      return `<tr>
        <td class="pt-name">🤖 AI ${i + 1}</td>
        <td><select id="ai${i}Diff" title="AI 难度"><option value="easy">简单</option><option value="medium" selected>中等</option><option value="brutal">冷酷</option><option value="bridgehead">桥头(测试)</option><option value="naval">海防(测试)</option></select></td>
        <td><select id="ai${i}Color" title="AI 颜色">${colorOptionsMarkup}</select></td>
        <td><select id="ai${i}Team" title="AI 组别">${teamOptionsMarkup}</select></td>
        <td><select id="ai${i}Agg" title="AI 进攻欲"><option value="cautious">谨慎</option><option value="balanced" selected>均衡</option><option value="reckless">冲动</option></select></td>
      </tr>`;
    }).join('');
  }

  // 大厅缩略图。会改 W / H，理由见文件头。
  function renderLobbyPreview() {
    const pv = $('lobbyPreview');
    if (!pv || !pv.getContext) {
      return;
    }
    const dims = rt.computeDimensions($('sizeSelect').value, $('aspectSelect').value);
    rt.setDimensions(dims.w, dims.h);
    const W = rt.W;
    const H = rt.H;
    // 只生成地形不布点：预览不需要城市和单位，而且布点会消耗随机数。
    const terrain = terrainFor($('mapSelect').value, $('complexitySelect').value, W, H);
    const pctx = pv.getContext('2d');
    pctx.clearRect(0, 0, pv.width, pv.height);
    const sx = pv.width / W;
    const sy = pv.height / H;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        pctx.fillStyle = TERRAIN[terrain[y][x]].color || '#26333f';
        pctx.fillRect(x * sx, y * sy, Math.ceil(sx), Math.ceil(sy));
      }
    }
    const aiCount = Number($('aiSelect').value);
    $('lobbyPreviewMeta').textContent = `${MAPS[$('mapSelect').value].name} · ${SIZES[$('sizeSelect').value].name} · ${ASPECTS[$('aspectSelect').value].name} ${W}×${H} · ${aiCount} 名 AI`;
  }

  // 加载画面里的那张小地图。和 renderLobbyPreview 不同，这里画的是**已经生成好的**
  // 那一局（读 rt.game），所以能画出城市归属。
  function drawPreview() {
    const pv = $('previewCanvas');
    if (!pv) {
      return;
    }
    const game = rt.game;
    const W = rt.W;
    const H = rt.H;
    const pctx = pv.getContext('2d');
    pctx.clearRect(0, 0, pv.width, pv.height);
    const sx = pv.width / W;
    const sy = pv.height / H;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        pctx.fillStyle = TERRAIN[game.terrain[y][x]].color || '#26333f';
        pctx.fillRect(x * sx, y * sy, Math.ceil(sx), Math.ceil(sy));
      }
    }
    for (const siteEntry of game.sites) {
      pctx.fillStyle = siteEntry.owner === 'neutral' ? '#9fb0bd' : rt.ownerColor(siteEntry.owner);
      const size = siteEntry.kind === 'city' ? Math.max(3, sx) : Math.max(2, sx * 0.7);
      pctx.fillRect(siteEntry.x * sx - size / 2 + sx / 2, siteEntry.y * sy - size / 2 + sy / 2, size, size);
    }
  }

  // 单位图鉴。直接从 TYPES 生成，所以加兵种不用改这里。
  function renderCodex() {
    $('codex').innerHTML = Object.values(TYPES).map(meta => `<div class="codex-item"><div class="icon">${meta.icon}</div><div><div class="title">${meta.name} · ${meta.cost}🪙 · ${rt.domainName(meta.domain)} ${rt.tierName(meta.level)}</div><div class="desc">攻${meta.atk} 防${meta.def} 移${meta.move} 射${meta.range} · ${meta.text}</div></div></div>`).join('');
  }

  function renderSaveList() {
    const saves = rt.listSaves();
    const body = $('saveListBody');
    if (!saves.length) {
      body.innerHTML = '<div class="save-empty">暂无存档。在游戏中点击「暂停 → 存储游戏」即可保存。</div>';
      return;
    }
    body.innerHTML = saves.map(save => `<button class="save-row" data-key="${save.key}"><span class="save-name">${save.name}</span><span class="save-meta">${save.map} · 第 ${save.turn} 回合</span><span class="save-date">${new Date(save.savedAt).toLocaleString('zh-CN')}</span></button>`).join('');
  }

  // 规则页。整块静态文案，改版本说明就改这里。
  // codex 容器在这段 HTML 里，所以 renderRules 必须在 renderCodex 之前跑 ——
  // 否则 renderCodex 会找不到 #codex，图鉴静默变空。
  function renderRules() {
    $('rulesContent').innerHTML = `
      <div class="rule-version">
        <h3 class="info-section-title">基础玩法</h3>
        <div class="rule-grid">
          <section class="rule-block"><h3>回合流程</h3><ul><li>每个阵营依次行动；回合开始时统一重置移动、结算收入、回血与维修。</li><li>单位可先机动再攻击，但每回合只能攻击一次；攻击后本回合不能再机动。</li><li>玩家和 AI 完全共用同一套伤害、生产、升级、维修和运输规则。</li></ul></section>
          <section class="rule-block"><h3>三种模式</h3><ul><li>征服：占领全部城市，并消灭全部敌对工程师后获胜。</li><li>遭遇战：敌对组全部野战部队被消灭时获胜。</li><li>守城：坚持到第12回合且仍保有己方关键城市时获胜。</li></ul></section>
          <section class="rule-block"><h3>移动与地形</h3><ul><li>陆军只能在陆地移动，不能进入海域与山脉。</li><li>海军只能在海域行动，船坞与海上堡垒也属于海上据点。</li><li>森林提供额外防御但增加移动消耗，道路降低机动成本。</li></ul></section>
          <section class="rule-block"><h3>战斗与反击</h3><ul><li>伤害由兵种攻防、当前生命、地形、驻防和克制共同决定。</li><li>只要射程覆盖，防守方就能反击；先手不再拥有单方面碾压优势。</li><li>长枪兵克制骑兵，战船克制运兵船，骑兵满机动接战时获得冲锋加成。</li></ul></section>
          <section class="rule-block"><h3>据点与经济</h3><ul><li>城市生产陆军，港口/造船厂生产海军与预载运兵船，海上堡垒不能生产但可提供海上防御。</li><li>临时营地视为中级城市，不产金币，只能维持 3 回合，且不能被占领。</li><li>驻军可花费金币修整，AI 也会按局势使用同一功能。</li></ul></section>
          <section class="rule-block"><h3>海军与运输</h3><ul><li>战船负责制海、拦截和海上火力压制。</li><li>运兵船可直接预载 0 到 5 个陆军单位下水，登陆后立即释放兵力。</li><li>港口/造船厂位于水中且紧贴陆地；海上堡垒位于深海，不与陆地相邻。</li></ul></section>
          <section class="rule-block"><h3>工程师与胜利</h3><ul><li>工程师可在靠海陆格的相邻海格造出战船或运兵船，也可原地建立临时营地。</li><li>征服模式中，占领全部城市后还必须清除敌对组全部工程师，才能真正锁定胜利。</li><li>敌方单位进入临时营地所在格时，可将其直接摧毁。</li></ul></section>
          <section class="rule-block"><h3>AI 规则</h3><ul><li>AI 会升级据点、花钱造兵、集火残血、评估反击风险并争夺高价值目标。</li><li>冷酷 AI 额外进行团队级目标规划，优先组织围攻、连续压制、载员登陆和工程师扩张。</li><li>进攻欲改变前压程度与冒险意愿，不会修改基础战斗数值。</li></ul></section>
        </div>
        <h3 class="info-section-title">单位图鉴</h3>
        <div class="codex" id="codex"></div>
        <h3 class="info-section-title">新增海图</h3>
        <ul><li>海岸丘陵：长海岸线，重视沿海登陆与抢港口。</li><li>群岛与海峡：多岛链和狭航道，适合争夺制海权。</li><li>内海争夺：中央内海切割大陆，船坞控制非常关键。</li><li>海湾登陆：大型海湾切入内陆，利于多方向两栖包抄。</li><li>裂海海峡：大陆被宽海峡分割，海军和运兵船决定节奏。</li><li>断链群岛：岛屿极多，海上堡垒和前沿船坞价值极高。</li></ul>
        <h3 class="info-section-title">版本 0.1.2 变更</h3>
        <ul><li>港口/造船厂现在可以直接生产预载 0 到 5 个陆军单位的运兵船。</li><li>新增工程师兵种，可在海边造舰，或建立持续 3 回合的临时营地。</li><li>征服模式改为“占领全部城市并清除全部敌方工程师”才算获胜。</li><li>冷酷 AI 新增工程师扩张、载员登陆和反登陆应对逻辑。</li><li>新增战场纵横比设置，可选宽幅、标准、方阵、纵深。</li><li>预增加：地势高低区分、更多海军、更多海上建筑、更有策略的 AI、更大地图、更多 AI 玩家数、更多组别、战役关卡。</li></ul>
      </div>`;
  }

  return {
    fillSelectOptions, syncSliderLabels, renderAISettings, renderLobbyPreview,
    drawPreview, renderCodex, renderSaveList, renderRules
  };
}
