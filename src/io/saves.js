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

  function buildSavePayload(name) {
    const { selected, pendingOrder, ...rest } = rt.game;
    return {
      name: name || `存档 ${new Date().toLocaleString('zh-CN')}`,
      savedAt: Date.now(),
      map: MAPS[rt.game.settings.map]?.name || rt.game.settings.map,
      turn: rt.game.turn,
      W: rt.W, H: rt.H, S: rt.S,
      state: rest
    };
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

  function importSaveToList(payload) {
    if (!payload?.state) {
      return false;
    }
    try {
      saveStore.setItem(SAVE_PREFIX + Date.now(), JSON.stringify({
        name: payload.name || '导入的存档',
        savedAt: payload.savedAt || Date.now(),
        map: payload.map || '',
        turn: payload.turn || 1,
        W: payload.W,
        H: payload.H,
        S: payload.S,
        state: payload.state
      }));
      return true;
    } catch (err) {
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

  function loadSave(key) {
    let payload;
    try {
      payload = JSON.parse(saveStore.getItem(key));
    } catch (err) {
      return false;
    }
    if (rt.loadPayload(payload)) {
      rt.currentSaveKey = key;
      return true;
    }
    return false;
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
    importSaveToList, currentSaveName, loadSave, deleteSave, readSave
  };
}
