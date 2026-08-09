'use strict';
// Pure, stateless helpers. Anything that reads mutable runtime state (W/H/game/cam)
// stays in main.js for now; only side-effect-free utilities live here.
import { SITE_META, TYPES, COLOR_PRESETS } from './constants.js';

export const cellKey = (x, y) => `${x},${y}`;
export const rnd = n => Math.floor(Math.random() * n);
export const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
export const dist = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
export const shuffle = items => [...items].sort(() => Math.random() - 0.5);

export function diagonalDist(a, b) {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

export function inUnitRange(range, fromCell, targetCell) {
  return range <= 1 ? diagonalDist(fromCell, targetCell) <= range : dist(fromCell, targetCell) <= range;
}

export function siteMeta(kind) {
  return SITE_META[kind];
}

// Star count shown on a site: oil/barracks reflect their size variant; others use tier.
export function siteStars(siteEntry) {
  switch (siteEntry.kind) {
    case 'oilSmall': return 1;
    case 'oilMedium': return 2;
    case 'oilLarge': return 3;
    case 'barracksSmall': return 1;
    case 'barracksLarge': return 2;
    default: return siteEntry.tier;
  }
}

export function typeMeta(type) {
  return TYPES[type];
}

export function colorOptions() {
  return Object.entries(COLOR_PRESETS);
}
