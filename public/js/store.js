/* 本地持久化：配置、会话索引、单会话、资源缓存、调试记录、旧版迁移。
 * 会话按 sid 分键存储，避免多标签页互相整包覆盖；索引只存摘要并做读-改-写合并。
 */

export const KEYS = {
  cfg: 'lg.cfg.v2',
  index: 'lg.index.v2',
  sessPrefix: 'lg.sess.v2.',
  resPrefix: 'lg.res.v1.',
  debug: 'lg.debug.v2',
  meta: 'lg.meta.v2',
  migrated: 'lg.migrated.v2',
};

const memory = new Map();
let storageOk = true;
try {
  const probe = '__lg_probe__';
  localStorage.setItem(probe, '1');
  localStorage.removeItem(probe);
} catch (e) {
  storageOk = false;
}

export function storageAvailable() {
  return storageOk;
}

function readRaw(key) {
  if (!storageOk) return memory.has(key) ? memory.get(key) : null;
  try {
    return localStorage.getItem(key);
  } catch (e) {
    return null;
  }
}

function writeRaw(key, value) {
  if (!storageOk) {
    memory.set(key, value);
    return true;
  }
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (e) {
    return false;
  }
}

function removeRaw(key) {
  if (!storageOk) {
    memory.delete(key);
    return;
  }
  try {
    localStorage.removeItem(key);
  } catch (e) { /* ignore */ }
}

export function readJSON(key, dft) {
  const raw = readRaw(key);
  if (!raw) return dft;
  try {
    return JSON.parse(raw);
  } catch (e) {
    return dft;
  }
}

export function writeJSON(key, value) {
  return writeRaw(key, JSON.stringify(value));
}

/* ---------------- 配置 ---------------- */

const EMPTY_CFG = {
  presets: [],
  activeId: '',
  current: null,
  prefs: { theme: 'auto', toolsCollapsed: false },
};

export function loadConfig() {
  const cfg = readJSON(KEYS.cfg, null);
  if (!cfg || typeof cfg !== 'object') return JSON.parse(JSON.stringify(EMPTY_CFG));
  return {
    presets: Array.isArray(cfg.presets) ? cfg.presets : [],
    activeId: cfg.activeId || '',
    current: cfg.current && typeof cfg.current === 'object' ? cfg.current : null,
    prefs: Object.assign({}, EMPTY_CFG.prefs, cfg.prefs || {}),
  };
}

export function saveConfig(cfg) {
  return writeJSON(KEYS.cfg, cfg);
}

/* ---------------- 会话索引 ---------------- */

export function loadIndex() {
  const idx = readJSON(KEYS.index, []);
  return Array.isArray(idx) ? idx.filter((x) => x && x.id) : [];
}

export function saveIndex(list) {
  return writeJSON(KEYS.index, list);
}

function summaryOf(rec) {
  const msgs = rec.messages || [];
  const last = msgs[msgs.length - 1];
  return {
    id: rec.id,
    title: rec.title || '新会话',
    createdAt: rec.createdAt || Date.now(),
    updatedAt: rec.updatedAt || Date.now(),
    preview: last ? String(last.text || '').replace(/\s+/g, ' ').slice(0, 80) : '',
    messageCount: msgs.length,
    pendingTask: rec.pendingTask || '',
    unread: rec.unread || 0,
  };
}

/** 合并写入索引中的一条摘要（多标签页安全：先读最新再改）。 */
export function upsertIndex(rec) {
  const idx = loadIndex();
  const s = summaryOf(rec);
  const i = idx.findIndex((x) => x.id === s.id);
  if (i >= 0) idx[i] = Object.assign({}, idx[i], s);
  else idx.unshift(s);
  saveIndex(idx);
  return idx;
}

export function removeFromIndex(id) {
  const idx = loadIndex().filter((x) => x.id !== id);
  saveIndex(idx);
  return idx;
}

/* ---------------- 单会话 ---------------- */

export function loadSession(id) {
  const rec = readJSON(KEYS.sessPrefix + id, null);
  if (!rec || typeof rec !== 'object') return null;
  rec.messages = Array.isArray(rec.messages) ? rec.messages : [];
  return rec;
}

export function saveSession(rec) {
  if (!rec || !rec.id) return false;
  const payload = {
    id: rec.id,
    title: rec.title || '新会话',
    createdAt: rec.createdAt || Date.now(),
    updatedAt: rec.updatedAt || Date.now(),
    messages: (rec.messages || []).map(slimMessage),
    pendingTask: rec.pendingTask || '',
    pendingAt: rec.pendingAt || 0,
    unread: rec.unread || 0,
  };
  let ok = writeJSON(KEYS.sessPrefix + rec.id, payload);
  if (!ok) {
    // 配额不足：丢一半旧消息再试一次，尽量保住最近内容
    payload.messages = payload.messages.slice(-40);
    ok = writeJSON(KEYS.sessPrefix + rec.id, payload);
  }
  upsertIndex(rec);
  return ok;
}

function slimMessage(m) {
  return {
    id: m.id,
    role: m.role,
    text: m.text || '',
    parts: Array.isArray(m.parts) ? m.parts : undefined,
    artifacts: Array.isArray(m.artifacts) && m.artifacts.length ? m.artifacts : undefined,
    tools: Array.isArray(m.tools) && m.tools.length ? m.tools : undefined,
    status: m.status || 'done',
    time: m.time || Date.now(),
    meta: m.meta || undefined,
  };
}

export function removeSession(id) {
  removeRaw(KEYS.sessPrefix + id);
  removeFromIndex(id);
}

export function clearSessions() {
  loadIndex().forEach((s) => removeRaw(KEYS.sessPrefix + s.id));
  saveIndex([]);
}

/* ---------------- 资源缓存 ---------------- */

export function resCacheKey(cfg) {
  const parts = [
    String(cfg.base || '').replace(/\/+$/, ''),
    cfg.tenant || '',
    cfg.appId || '',
    cfg.mode === 'HEADER_USER' ? cfg.subType + ':' + (cfg.subject || '') : 'FIXED',
  ];
  return KEYS.resPrefix + parts.join('|');
}

export function loadResCache(key) {
  const rec = readJSON(key, null);
  return rec && typeof rec === 'object' ? rec : null;
}

export function saveResCache(key, data) {
  return writeJSON(key, data);
}

export function clearResCache(key) {
  removeRaw(key);
}

/* ---------------- 调试 ---------------- */

export function loadDebug() {
  const arr = readJSON(KEYS.debug, []);
  return Array.isArray(arr) ? arr : [];
}

export function saveDebug(entries) {
  return writeJSON(KEYS.debug, entries);
}

/* ---------------- 元信息 ---------------- */

export function getMeta() {
  return readJSON(KEYS.meta, {});
}

export function setMeta(patch) {
  const meta = Object.assign({}, getMeta(), patch);
  writeJSON(KEYS.meta, meta);
  return meta;
}

export function tabId() {
  const meta = getMeta();
  if (meta.tabId) return meta.tabId;
  const id = 'tab-' + Math.random().toString(36).slice(2, 10);
  setMeta({ tabId: id });
  return id;
}

/* ---------------- 旧版迁移 ---------------- */

export function migrateLegacy() {
  if (readJSON(KEYS.migrated, false)) return { migrated: false };

  const legacySessions = readJSON('lingee.sessions', []);
  const legacyPresets = readJSON('lingee.presets', []);
  const legacyActive = readJSON('lingee.activePreset', '');
  let count = 0;

  if (Array.isArray(legacySessions) && legacySessions.length) {
    const idx = loadIndex();
    legacySessions.forEach((s) => {
      if (!s || !s.id) return;
      if (readRaw(KEYS.sessPrefix + s.id)) return; // 已存在则不覆盖
      const rec = {
        id: s.id,
        title: s.title || '新会话',
        createdAt: s.createdAt || s.updatedAt || Date.now(),
        updatedAt: s.updatedAt || Date.now(),
        messages: (s.messages || []).map((m, i) => ({
          id: 'mig-' + s.id + '-' + i,
          role: m.role === 'user' ? 'user' : 'assistant',
          text: m.text || '',
          status: 'done',
          time: m.time || Date.now(),
        })),
        pendingTask: s.pendingTask || '',
        pendingAt: s.pendingAt || 0,
        unread: 0,
      };
      writeJSON(KEYS.sessPrefix + rec.id, {
        id: rec.id,
        title: rec.title,
        createdAt: rec.createdAt,
        updatedAt: rec.updatedAt,
        messages: rec.messages,
        pendingTask: rec.pendingTask,
        pendingAt: rec.pendingAt,
        unread: 0,
      });
      if (!idx.find((x) => x.id === rec.id)) idx.push(summaryOf(rec));
      count++;
    });
    saveIndex(idx);
  }

  const cfg = loadConfig();
  if (!cfg.presets.length && Array.isArray(legacyPresets) && legacyPresets.length) {
    cfg.presets = legacyPresets;
    cfg.activeId = legacyActive || legacyPresets[0].id || '';
    saveConfig(cfg);
    count++;
  }

  writeJSON(KEYS.migrated, true);
  return { migrated: count > 0, count };
}