'use strict';
// 存档读写：存档列表、序列化、导入导出、删除。
//
// 与 io/storage.js 的分工：storage.js 是 KV 后端抽象（今天是 localStorage，将来
// 换文件系统只动那一个文件）；这里是存档的业务层 —— 存档长什么样、怎么命名、
// 损坏了怎么办。换后端不该影响这里，换存档格式不该影响那里。
//
// 【为什么 loadPayload 不在这个文件里】
// 读档恢复要写 W/H/S、重置摄像机与缩放、清空寻路缓存、切屏、居中视野、触发 AI
// 续跑 —— 那是把存档「应用」到运行时的编排逻辑，横跨状态、视图和流程三层，不是
// IO。它留在 main.js，属于最终会沉淀在装配层的那类代码。这里的 loadSave 只负责
// 把字节读出来交给它。
import { MAPS } from '../core/constants.js';
import { saveStore } from './storage.js';
import { toSaveState, parseSaveState } from './savestate.js';

const SAVE_PREFIX = 'frontier_save_';

// 纯 DOM 操作，不碰任何游戏状态，所以不进工厂、直接导出。
// 浏览器没法直接写游戏目录，导出走的是下载一个 .json，用户自己收进 /saves。
export function downloadSaveFile(payload) {
  if (!payload) {
    return;
  }
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  const safeName = String(payload.name || 'save').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60);
  link.href = url;
  link.download = `${safeName}.frontiersave.json`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function createSaves(rt) {
  // 最近一次读档 / 导入失败的原因，供界面提示用。比笼统的"存档已损坏"有用得多
  // —— "版本比当前支持的还新"和"地形高度对不上"该给玩家不同的提示。
  let lastLoadError = null;

  function listSaves() {
    const saves = [];
    for (const key of saveStore.keys()) {
      if (!key || !key.startsWith(SAVE_PREFIX)) {
        continue;
      }
      try {
        const data = JSON.parse(saveStore.getItem(key));
        saves.push({ key, name: data.name || '未命名', savedAt: data.savedAt || 0, map: data.map || '', turn: data.turn || 1 });
      } catch (err) {
        // 跳过损坏的存档条目。
      }
    }
    return saves.sort((a, b) => b.savedAt - a.savedAt);
  }

  // 存档体的结构、版本与排除字段都在 io/savestate.js —— 这里只补上"叫什么名字、
  // 属于哪张地图"这类仓储层才知道的信息。
  function buildSavePayload(name) {
    const payload = toSaveState(
      rt.game,
      { W: rt.W, H: rt.H, S: rt.S },
      name || `存档 ${new Date().toLocaleString('zh-CN')}`
    );
    payload.map = MAPS[rt.game.settings.map]?.name || rt.game.settings.map;
    return payload;
  }

  function saveAsNewSave(name) {
    if (!rt.game) {
      return false;
    }
    const key = SAVE_PREFIX + Date.now();
    try {
      saveStore.setItem(key, JSON.stringify(buildSavePayload(name)));
      rt.currentSaveKey = key;
      return true;
    } catch (err) {
      return false;
    }
  }

  function overwriteCurrentSave(name) {
    if (!rt.game || !rt.currentSaveKey) {
      return false;
    }
    try {
      saveStore.setItem(rt.currentSaveKey, JSON.stringify(buildSavePayload(name)));
      return true;
    } catch (err) {
      return false;
    }
  }

  // 导入外部存档文件。**入口处就迁移并校验**，而不是等读档时才发现问题 ——
  // 否则一份坏档会先安静地进列表，玩家点它才报错，看起来像是读档功能坏了。
  // 迁移后再存，所以列表里躺着的永远是当前版本。
  function importSaveToList(rawPayload) {
    const { payload, error } = parseSaveState(rawPayload);
    if (error) {
      lastLoadError = error;
      return false;
    }
    try {
      saveStore.setItem(SAVE_PREFIX + Date.now(), JSON.stringify({
        ...payload,
        name: payload.name || '导入的存档',
        savedAt: payload.savedAt || Date.now(),
        map: payload.map || '',
        turn: payload.turn || 1
      }));
      lastLoadError = null;
      return true;
    } catch (err) {
      lastLoadError = '写入存储失败，空间可能已满';
      return false;
    }
  }

  function currentSaveName() {
    if (!rt.currentSaveKey) {
      return '';
    }
    try {
      return JSON.parse(saveStore.getItem(rt.currentSaveKey))?.name || '';
    } catch (err) {
      return '';
    }
  }

  // 读档：解析 → 迁移到当前版本 → 校验 → 交给运行时装载。
  // 任何一步失败都返回 false，让调用方转成 toast —— 读档失败是常见情况
  // （存档损坏、版本太新），不该让它抛异常冒到界面层。
  function loadSave(key) {
    let raw;
    try {
      raw = JSON.parse(saveStore.getItem(key));
    } catch (err) {
      return false;
    }
    const { payload, error } = parseSaveState(raw);
    if (error) {
      lastLoadError = error;
      return false;
    }
    if (rt.loadPayload(payload)) {
      rt.currentSaveKey = key;
      lastLoadError = null;
      return true;
    }
    return false;
  }

  function lastSaveError() {
    return lastLoadError;
  }

  function deleteSave(key) {
    saveStore.removeItem(key);
  }

  // 按 key 取出原始存档对象（导出成文件时用）。损坏或不存在都返回 null，
  // 让调用方不必自己包 try/catch —— main.js 不该知道存档是 JSON 存的。
  function readSave(key) {
    try {
      return JSON.parse(saveStore.getItem(key));
    } catch (err) {
      return null;
    }
  }

  return {
    SAVE_PREFIX,
    listSaves, buildSavePayload, saveAsNewSave, overwriteCurrentSave,
    importSaveToList, currentSaveName, loadSave, deleteSave, readSave,
    lastSaveError
  };
}
