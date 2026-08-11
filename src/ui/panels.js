'use strict';
// 右侧信息面板：资源栏、选中单位卡、工程师卡、据点生产卡、战斗日志。
// 每次 refresh() 都会整块重画一遍。
//
// 依赖注入方式见 game/movement.js 顶部对 rt 门面的说明。
//
// 【为什么是"整块重画"而不是增量更新】
// updatePanels 每次都把几个容器的 innerHTML 全部重新拼一遍。这看起来很浪费，但它
// 换来一个重要性质：面板永远是 game 的纯函数，不存在"某个字段变了却忘了刷新对应
// 元素"这类 bug。这个游戏的面板一共就几十个节点，一回合最多刷新几十次，代价可以
// 忽略。**不要**为了性能改成增量 diff —— 那会把状态同步的责任重新塞回调用方。
//
// 【uiState 住在这里，而且不进存档】
// shipyardCargo / engineerCargo 是"运兵船预载哪几种兵"的下拉框选择，属于纯界面偏好：
// 玩家点了建造按钮的那一刻才会被读出来变成真正的 cargoTypes。它不参与任何规则计算，
// 也不该被存档带走（读档后重新选一次即可），所以它不在 game 上而在这个模块里。
// main.js 的 setup 通过解构拿到同一个对象引用来处理下拉框的 change 事件。
//
// 【disabled 判定的顺序不能随便调】
// 生产按钮的 disabled 是三个条件的或：不可管理 / 金币不够 / 格子上已有单位。
// 这几条和 game/build.js 里 buildAtSite 的实际校验是两套代码 —— 界面这边只是"提前
// 变灰"，真正拦下非法操作的是 build.js。两边不一致的表现是按钮能点但点了没反应，
// 不会产生非法状态。改建造规则时记得两边都看一眼。
//
// 【这个模块是 verify 的盲区】
// refresh() 开头有 `if (fastSim) return;`，行为基线（npm run verify）跑的全是
// fastBatch，所以 updatePanels 一行都不会执行。兜底的是 sim/smoke-render.js ——
// 它用 strictDom 打桩，任何写进 innerHTML / textContent 的 "undefined" / "NaN"
// 当场抛错。改这个文件后请跑 npm run smoke，光跑 verify 是全绿的假象。
import { CAMP_DURATION, CAMP_COST } from '../core/constants.js';
import { siteMeta, typeMeta } from '../core/utils.js';
import { cargoOptionTypes, cargoLabel, describeCargo, transportCost } from '../game/entities.js';

export function createPanels(rt) {
  const $ = id => document.getElementById(id);

  // 运兵船预载的界面偏好。见文件头说明：不进存档，不参与规则计算。
  const uiState = {
    shipyardCargo: ['none', 'none', 'none', 'none', 'none'],
    engineerCargo: ['none', 'none', 'none', 'none', 'none']
  };

  // 船厂和工程师共用同一段下拉框 markup，靠 presetKey 区分写到 uiState 的哪一份。
  // data-cargo-preset / data-cargo-slot 这两个 dataset 是 main.js 事件委托的锚点，
  // 改名字要同步改 setup 里的 querySelector。
  function transportConfigMarkup(presetKey, title) {
    const capacity = typeMeta('transport').transport;
    const rows = [];
    for (let slot = 0; slot < capacity; slot++) {
      const options = ['none', ...cargoOptionTypes()].map(type => `<option value="${type}" ${uiState[presetKey][slot] === type ? 'selected' : ''}>${cargoLabel(type)}</option>`).join('');
      rows.push(`<label class="cargo-row"><span>槽位${slot + 1}</span><select data-cargo-preset="${presetKey}" data-cargo-slot="${slot}">${options}</select></label>`);
    }
    return [
      '<div class="build-config">',
      `<h3>${title}</h3>`,
      '<div class="cargo-grid">',
      rows.join(''),
      '</div>',
      `<div class="config-note">当前配置：${describeCargo(uiState[presetKey])} · 总价 ${transportCost(uiState[presetKey])} 🪙</div>`,
      '</div>'
    ].join('');
  }

  function setCargoPreset(presetKey, slot, value) {
    if (!uiState[presetKey]) {
      return;
    }
    uiState[presetKey][slot] = value;
  }

  function engineerSelected() {
    return rt.game?.selected?.kind === 'unit' && rt.game.selected.ref.type === 'engineer' ? rt.game.selected.ref : null;
  }

  function updatePanels() {
    const game = rt.game;
    // 观战模式下显示当前行动方的金币，正常模式恒显示玩家的。
    $('gold').textContent = game.settings?.spectator ? (game.goldByOwner[game.side] ?? 0) : game.goldByOwner.player;
    $('turn').textContent = game.turn;
    $('sideLabel').textContent = rt.sideLabel();
    $('sideLabel').classList.toggle('enemy', game.side !== 'player');
    $('btnEndTurn').disabled = game.settings?.spectator || game.side !== 'player' || game.over;

    const activeUnit = rt.selectedUnit();
    const activeSite = rt.selectedSite();
    $('selectionEmpty').classList.toggle('hidden', !!activeUnit || !!activeSite);
    $('selectionBody').classList.toggle('hidden', !activeUnit);

    if (activeUnit) {
      const unitEntry = activeUnit;
      const meta = typeMeta(unitEntry.type);
      const siteEntry = rt.getSite(unitEntry.x, unitEntry.y);
      const attackBuff = rt.siteBonus(siteEntry, unitEntry, 'attack');
      const defenseBuff = rt.siteBonus(siteEntry, unitEntry, 'defense');
      $('selIcon').textContent = meta.icon;
      $('selName').textContent = meta.name;
      $('selOwner').textContent = rt.ownerName(unitEntry.owner);
      $('selHp').textContent = `${unitEntry.hp}/${unitEntry.maxHp}`;
      $('selMove').textContent = `${Math.floor(unitEntry.move)}/${unitEntry.maxMove}`;
      $('selHpBar').style.width = `${unitEntry.hp / unitEntry.maxHp * 100}%`;
      $('selMoveBar').style.width = `${unitEntry.move / unitEntry.maxMove * 100}%`;
      $('selAttrs').innerHTML = [
        `<div><span>军种：</span>${rt.domainName(meta.domain)}</div>`,
        `<div><span>射程：</span>${meta.range}</div>`,
        `<div><span>等级：</span>${unitEntry.rank}</div>`,
        `<div><span>击杀：</span>${unitEntry.kills}</div>`,
        `<div><span>攻击：</span>${meta.atk + attackBuff}</div>`,
        `<div><span>防御：</span>${meta.def + defenseBuff}</div>`,
        `<div><span>状态：</span>${unitEntry.hasAttacked ? '已攻击' : unitEntry.move < unitEntry.maxMove ? '已机动' : '待命'}</div>`,
        `<div><span>特性：</span>${meta.transport ? `载员 ${unitEntry.cargo.length}/${meta.transport}` : meta.text}</div>`
      ].join('');
      const actions = [];
      if (meta.transport) {
        actions.push(`<button class="btn" data-unit-action="load" ${unitEntry.cargo.length >= meta.transport ? 'disabled' : ''}>装载邻近陆军</button>`);
        actions.push(`<button class="btn" data-unit-action="unload" ${unitEntry.cargo.length ? '' : 'disabled'}>自动卸载到临近空地</button>`);
      }
      if (unitEntry.owner === 'player' && game.side === 'player') {
        actions.push(`<button class="btn" data-unit-action="sell">变卖回收 ${rt.sellRefund(unitEntry)} 🪙</button>`);
      }
      // 同格叠放只可能由卸载产生。列出全部，方便点选被压在下面的那个。
      const cellStack = rt.unitsAt(unitEntry.x, unitEntry.y);
      if (cellStack.length > 1) {
        actions.push(`<div class="config-note">同格单位（${cellStack.length}）：</div>`);
        cellStack.forEach(entry => {
          actions.push(`<button class="btn" data-select-unit="${entry.id}" ${entry === unitEntry ? 'disabled' : ''}>${typeMeta(entry.type).icon} ${typeMeta(entry.type).name}</button>`);
        });
      }
      $('selActions').innerHTML = actions.join('');
      let selectionHint = meta.text;
      if (game.pendingOrder?.kind === 'engineer-launch' && unitEntry.id === game.pendingOrder.builderId) {
        const productText = game.pendingOrder.product === 'transport'
          ? `运兵船（${describeCargo(game.pendingOrder.cargoTypes)}）`
          : typeMeta(game.pendingOrder.product).name;
        selectionHint = `已选择建造${productText}，请点击相邻海格下水。`;
      } else if (siteEntry) {
        const attackText = attackBuff ? `攻击 +${attackBuff}` : '';
        const defenseText = defenseBuff ? `防御 +${defenseBuff}` : '';
        const joinText = attackText && defenseText ? '，' : '';
        selectionHint = `${siteEntry.name}提供${attackText}${joinText}${defenseText}。`;
      }
      $('selHint').textContent = selectionHint;
    } else {
      $('selActions').innerHTML = '';
    }

    const engineer = engineerSelected();
    $('engineerCard').classList.toggle('hidden', !engineer || game.side !== 'player');
    if (engineer && game.side === 'player') {
      const coastCells = rt.engineerBuildCells(engineer);
      const warshipDisabled = coastCells.length && game.goldByOwner.player >= typeMeta('warship').cost && !engineer.acted ? '' : 'disabled';
      const transportDisabled = coastCells.length && game.goldByOwner.player >= transportCost(uiState.engineerCargo) && !engineer.acted ? '' : 'disabled';
      const campDisabled = rt.canBuildCamp(engineer) ? '' : 'disabled';
      const engineerPendingText = game.pendingOrder?.kind === 'engineer-launch' && game.pendingOrder.builderId === engineer.id
        ? '待下水：点击高亮海格完成建造。'
        : coastCells.length
          ? '海边施工可用。'
          : '先移动到靠海陆格，才能下水建造舰船。';
      $('engineerBody').innerHTML = [
        '<div class="engineer-panel">',
        `<h3>${typeMeta(engineer.type).icon} ${typeMeta(engineer.type).name}</h3>`,
        `<div class="config-note">工程师可在相邻海格建造舰船，也可在当前位置建立可维持 ${CAMP_DURATION} 回合的临时营地。</div>`,
        transportConfigMarkup('engineerCargo', '工程师运兵船预载'),
        '<div class="engineer-actions">',
        `<button class="btn" data-engineer-build="warship" ${warshipDisabled}>在相邻海格建造战船（${typeMeta('warship').cost} 🪙）</button>`,
        `<button class="btn" data-engineer-build="transport" ${transportDisabled}>在相邻海格建造运兵船（${transportCost(uiState.engineerCargo)} 🪙）</button>`,
        `<button class="btn" data-engineer-build="camp" ${campDisabled}>建立临时营地（${CAMP_COST} 🪙）</button>`,
        '</div>',
        `<div class="engineer-pending">${engineerPendingText}</div>`,
        '</div>'
      ].join('');
    } else {
      $('engineerBody').innerHTML = '';
    }

    const showSite = !!activeSite;
    // 能看 ≠ 能管：敌方据点也会显示信息，但所有按钮都是灰的。
    const manageable = !!activeSite && activeSite.owner === 'player' && game.side === 'player';
    $('buildEmpty').classList.toggle('hidden', showSite);
    $('buildBody').classList.toggle('hidden', !showSite);
    if (showSite) {
      const siteEntry = activeSite;
      const occupant = rt.getUnit(siteEntry.x, siteEntry.y);
      const cost = siteEntry.kind === 'city' || siteEntry.kind === 'camp' ? 5 : siteEntry.kind === 'shipyard' ? 6 : 7;
      $('cityName').textContent = siteEntry.name;
      $('cityTier').textContent = `${rt.tierName(siteEntry.tier)}${siteMeta(siteEntry.kind).name}`;
      $('cityIncome').textContent = `+${siteEntry.income}`;
      $('cityBonus').textContent = siteEntry.kind === 'city' ? `生产陆军，驻军攻击 +${siteEntry.tier}，防御 +${siteEntry.tier * 2}。` : siteEntry.kind === 'shipyard' ? `生产海军；运兵船可直接预载 0~5 个陆军单位下水。` : siteEntry.kind === 'camp' ? `视为中级城市，不产金币，可存在 ${siteEntry.duration ?? CAMP_DURATION} 回合。` : siteEntry.kind.startsWith('oil') ? `不可升级、不可造兵；每回合收益 ${siteEntry.income} 🪙。` : siteEntry.kind.startsWith('barracks') ? `不可升级、不可产金币；驻军加成等同 ${siteMeta(siteEntry.kind).supportTier} 级普通据点。` : '海上堡垒不可生产单位，但提供海上防御。';
      $('btnUpgrade').textContent = siteEntry.tier < siteMeta(siteEntry.kind).maxTier ? `升级至${rt.tierName(siteEntry.tier + 1)}（${rt.siteUpgradeCost(siteEntry)} 🪙）` : '已达最高等级';
      $('btnUpgrade').disabled = !manageable || siteEntry.tier >= siteMeta(siteEntry.kind).maxTier || game.goldByOwner.player < rt.siteUpgradeCost(siteEntry);
      $('btnFullHeal').textContent = occupant ? `花费${cost}金币：驻军修整` : '当前据点无驻军';
      $('btnFullHeal').disabled = !manageable || !occupant || game.goldByOwner.player < cost;
      $('shipyardConfig').classList.toggle('hidden', siteEntry.kind !== 'shipyard');
      $('shipyardConfig').innerHTML = siteEntry.kind === 'shipyard' ? transportConfigMarkup('shipyardCargo', '运兵船预载') : '';
      const types = rt.buildableTypes(siteEntry);
      $('buildGrid').innerHTML = types.length ? types.map(type => {
        const costText = type === 'transport' ? transportCost(uiState.shipyardCargo) : typeMeta(type).cost;
        const disabled = !manageable || game.goldByOwner.player < costText || rt.getUnit(siteEntry.x, siteEntry.y);
        const suffix = type === 'transport' ? `<small> 预载：${describeCargo(uiState.shipyardCargo)}</small>` : `<small> ${rt.domainName(typeMeta(type).domain)} ${rt.tierName(typeMeta(type).level)}</small>`;
        return `<button class="btn build" data-type="${type}" ${disabled ? 'disabled' : ''}><span>${typeMeta(type).icon} ${typeMeta(type).name}${suffix}</span><span class="cost">${costText} 🪙</span></button>`;
      }).join('') : '<div class="muted">该据点不能生产单位。</div>';
    } else {
      $('shipyardConfig').classList.add('hidden');
      $('shipyardConfig').innerHTML = '';
    }

    $('log').innerHTML = game.logs.map(entry => `<div class="entry ${entry.kind}">${entry.text}</div>`).join('');
  }

  return { uiState, updatePanels, transportConfigMarkup, setCargoPreset, engineerSelected };
}
