/* UI 控制器：把 store / api / 通道 / 轮次 / 资源 / 调试看板串起来。 */

import { ApiClient, SERVED, explainError, tokenHint } from './api.js';
import { TurnEngine } from './turns.js';
import { ResourceManager } from './resources.js';
import { DebugBoard } from './debug.js';
import { renderMarkdown, escapeHtml } from './markdown.js';
import * as Store from './store.js';

const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

const S = {
  cfg: null,
  presets: [],
  activePreset: '',
  prefs: { theme: 'auto' },
  sessions: new Map(),
  index: [],
  activeId: '',
  sel: { model: '', agent: '', tools: [] },
  selKey: '',
  search: '',
  msgNodes: new Map(),
  nearBottom: true,
  logMark: 0,
  resourcesOpened: false,
  dlgResolve: null,
};

function cfgComplete() {
  const c = S.cfg || {};
  return !!(c.base && c.appId && c.secret && c.tenant);
}

function normalizeBase(u) {
  return String(u || '').trim().replace(/\/+$/, '');
}

function newLocalId() {
  return 'local-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/* ---------------- 基础设施 ---------------- */

const debug = new DebugBoard({ load: Store.loadDebug, save: Store.saveDebug });

const api = new ApiClient({
  getCfg: () => S.cfg || {},
  logger: debug,
});

const res = new ResourceManager({
  api,
  getCfg: () => S.cfg || {},
  onChange: onResourcesChanged,
});

const engine = new TurnEngine({
  api,
  onSessionChange,
  onTurnChange,
  onSessionIdChange,
  onNotice: (kind, msg) => {
    if (kind === 'error' || kind === 'warn') toast(msg, kind === 'error' ? 'err' : 'warn');
  },
  getActiveId: () => S.activeId,
  maxConcurrent: 3,
});

function activeSession() {
  return S.activeId ? S.sessions.get(S.activeId) || null : null;
}

function toast(msg, kind) {
  const t = $('#toast');
  if (!t) return;
  t.textContent = msg;
  t.className = 'toast on' + (kind ? ' ' + kind : '');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    t.className = 'toast';
  }, kind === 'err' ? 5200 : 3200);
}

/* ---------------- 确认框 ---------------- */

function dialogConfirm(opts) {
  return new Promise((resolve) => {
    S.dlgResolve = resolve;
    $('#dlgTitle').textContent = opts.title || '确认';
    $('#dlgText').textContent = opts.text || '';
    const input = $('#dlgInput');
    if (input) {
      input.hidden = opts.input ? false : true;
      input.value = opts.value || '';
      input.placeholder = opts.placeholder || '';
    }
    $('#dlgOk').textContent = opts.ok || '确定';
    $('#dlgOk').className = 'btn sm ' + (opts.danger ? 'danger-solid' : 'primary');
    $('#dialog').hidden = false;
    setTimeout(() => {
      if (opts.input && input) input.focus();
      else $('#dlgOk').focus();
    }, 30);
  });
}

function closeDialog(ok) {
  const resolve = S.dlgResolve;
  S.dlgResolve = null;
  $('#dialog').hidden = true;
  if (resolve) {
    const input = $('#dlgInput');
    resolve(ok ? (input && !input.hidden ? input.value.trim() : true) : false);
  }
}

/* ---------------- 配置 ---------------- */

function readForm() {
  S.cfg = {
    base: normalizeBase($('#fBase').value),
    appId: $('#fAppId').value.trim(),
    secret: $('#fSecret').value,
    tenant: $('#fTenant').value.trim(),
    mode: $('#fMode').value,
    subType: $('#fSubType').value,
    subject: $('#fSubject').value.trim(),
    dcId: $('#fDcId').value.trim(),
  };
  api.syncEnv();
}

function writeForm() {
  const c = S.cfg || {};
  $('#fBase').value = c.base || '';
  $('#fAppId').value = c.appId || '';
  $('#fSecret').value = c.secret || '';
  $('#fTenant').value = c.tenant || '';
  $('#fMode').value = c.mode || 'FIXED_PROXY';
  $('#fSubType').value = c.subType || 'mobile';
  $('#fSubject').value = c.subject || '';
  $('#fDcId').value = c.dcId || '';
  syncModeUI();
}

function persistCfg() {
  Store.saveConfig({
    presets: S.presets,
    activeId: S.activePreset,
    current: S.cfg,
    prefs: S.prefs,
  });
}

function syncModeUI() {
  const white = $('#fMode').value === 'HEADER_USER';
  const erp = $('#fSubType').value === 'erp_user';
  $('#userBox').classList.toggle('muted', !white);
  $('#fSubType').disabled = !white;
  $('#fSubject').disabled = !white;
  $('#dcBox').hidden = !(white && erp);
  $('#fDcId').disabled = !white || !erp;

  const hint = $('#modeHint');
  if (white) {
    hint.className = 'hintline';
    hint.textContent = erp
      ? '白名单用户（erp_user）：请求体会带 subject_type、subject 与 data_center_id。'
      : '白名单用户：请求体会带 subject_type 与 subject，服务端会校验该用户是否在代理白名单内。';
  } else {
    hint.className = 'hintline warn';
    hint.textContent = '固定用户：请求体只发 tenant_id。要按用户签发，切到「白名单用户」并填写用户标识。';
  }
  renderTokenPreview();
}

function renderTokenPreview() {
  const box = $('#tokenPreview');
  if (!box) return;
  const tenant = $('#fTenant').value.trim();
  const payload = { tenant_id: tenant || '{{lingee_tenant_id}}' };
  if ($('#fMode').value === 'HEADER_USER') {
    payload.subject_type = $('#fSubType').value;
    payload.subject = $('#fSubject').value.trim() || '{{lingee_subject}}';
    if ($('#fSubType').value === 'erp_user') {
      payload.data_center_id = $('#fDcId').value.trim() || '{{lingee_data_center_id}}';
    }
  }
  box.textContent = JSON.stringify(payload, null, 2);
}

function renderPresets() {
  const sel = $('#presetSel');
  sel.innerHTML = '<option value="">（新建）</option>';
  S.presets.forEach((p) => {
    const o = document.createElement('option');
    o.value = p.id;
    o.textContent = p.name;
    sel.appendChild(o);
  });
  sel.value = S.activePreset || '';
}

function savePreset() {
  readForm();
  if (!S.cfg.base || !S.cfg.appId) {
    toast('至少填写服务地址与 App ID', 'err');
    return;
  }
  const name = $('#presetName').value.trim() || S.cfg.appId + ' @ ' + S.cfg.base.replace(/^https?:\/\//, '');
  let id = S.activePreset;
  if (!id) id = 'p' + Date.now().toString(36);
  const rec = Object.assign({ id, name }, S.cfg);
  const i = S.presets.findIndex((p) => p.id === id);
  if (i >= 0) S.presets[i] = rec;
  else S.presets.push(rec);
  S.activePreset = id;
  persistCfg();
  renderPresets();
  toast('已保存为常用：' + name, 'ok');
}

function loadPreset(id) {
  const p = S.presets.find((x) => x.id === id);
  if (!p) return;
  S.activePreset = id;
  S.cfg = {
    base: p.base || '',
    appId: p.appId || '',
    secret: p.secret || '',
    tenant: p.tenant || '',
    mode: p.mode || 'FIXED_PROXY',
    subType: p.subType || 'mobile',
    subject: p.subject || '',
    dcId: p.dcId || '',
  };
  api.syncEnv();
  writeForm();
  persistCfg();
  renderPresets();
  onEnvChanged();
  toast('已切换配置：' + p.name, 'ok');
}

function delPreset() {
  if (!S.activePreset) {
    toast('当前没有选中已保存的配置', 'err');
    return;
  }
  S.presets = S.presets.filter((p) => p.id !== S.activePreset);
  S.activePreset = '';
  persistCfg();
  renderPresets();
  toast('已删除该配置');
}

/* ---------------- 连接与令牌 ---------------- */

function renderConn() {
  const el = $('#connState');
  const txt = $('#connText');
  const hint = $('#footCfgHint');
  let cls = 'conn';
  let label;
  if (!cfgComplete()) {
    label = '未配置连接';
  } else {
    const t = api.tokenState();
    if (t.valid) {
      label = '令牌有效 · 剩 ' + Math.max(1, Math.round(t.left / 60000)) + ' 分钟';
      cls += ' ok';
    } else if (t.exp) {
      label = '令牌已过期，请重新获取';
      cls += ' warn';
    } else {
      label = '已配置 · 未获取令牌';
      cls += ' warn';
    }
  }
  el.className = cls;
  el.dataset.state = cls.indexOf('ok') >= 0 ? 'ok' : cls.indexOf('warn') >= 0 ? 'warn' : 'idle';
  txt.textContent = label;
  hint.textContent = S.cfg && S.cfg.base ? S.cfg.base.replace(/^https?:\/\//, '') : '令牌 · 密钥 · 缓存';
  renderTokenLine();
  updateTopStatus();
}

function renderTokenLine() {
  const line = $('#tokLine');
  const t = api.tokenState();
  if (!t.token) {
    line.className = 'tokline';
    line.textContent = '尚未获取令牌';
    return;
  }
  const short = t.token.length > 18 ? t.token.slice(0, 10) + '…' + t.token.slice(-6) : t.token;
  const expired = t.left <= 0;
  line.className = 'tokline ' + (expired ? 'err' : 'ok');
  line.textContent =
    (expired ? '已过期：' : '有效：') +
    short +
    '　到期 ' +
    new Date(t.exp).toLocaleTimeString();
}

function clearTokenDiag() {
  const box = $('#tokDiag');
  if (box) {
    box.hidden = true;
    box.innerHTML = '';
  }
}

function reportTokenError(err, url) {
  const code = err && err.code ? String(err.code) : '';
  const line = $('#tokLine');
  if (line) {
    line.className = 'tokline err';
    line.textContent = '获取令牌失败' + (code ? '：' + code : '');
  }
  const box = $('#tokDiag');
  if (!box) return;
  let hint = tokenHint(code);
  if (!hint) {
    hint = err && err.isNet
      ? '请求没送到服务端。确认本地服务还在运行（node start.js），以及「服务地址」是否正确。'
      : '按返回信息逐项检查：凭证、租户、代理模式与用户参数。';
  }
  box.hidden = false;
  box.innerHTML =
    '<b>签发失败</b>' +
    '<div class="drow">请求地址：<code>' + escapeHtml(url) + '</code></div>' +
    '<div class="drow">结果：' +
    (err && err.status ? 'HTTP ' + escapeHtml(err.status) + ' · ' : '') +
    '业务码 <code>' + escapeHtml(code || '—') + '</code></div>' +
    '<div class="drow">返回信息：' + escapeHtml((err && err.message) || '—') + '</div>' +
    '<div class="dhint">' + escapeHtml(hint) + '</div>' +
    '<div class="drow soft">完整请求与响应已记入「调试看板」。</div>';
}

async function fetchToken(btn) {
  readForm();
  persistCfg();
  renderConn();
  if (btn) {
    btn.disabled = true;
    btn.textContent = '获取中…';
  }
  clearTokenDiag();
  try {
    const d = await api.issueToken();
    renderConn();
    toast('令牌获取成功，有效期 ' + (d.expires_in || 7200) + ' 秒', 'ok');
    // 有令牌后自动加载资源（有新鲜缓存则直接用缓存）
    await res.load({});
    renderSelectors();
    renderResources();
  } catch (e) {
    reportTokenError(e, api._url('/console/openapi/v1/access-tokens'));
    toast((e && e.code ? '[' + e.code + '] ' : '') + ((e && e.message) || '获取失败'), 'err');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '获取令牌';
    }
  }
}

/* ---------------- 资源 ---------------- */

function onResourcesChanged() {
  renderSelectors();
  renderResources();
}

function renderResources() {
  const st = res.state;
  const fmt = (slot) => {
    if (!slot.fetchedAt && !slot.items.length) {
      return '<span class="rv muted">未加载</span>';
    }
    const n = slot.items.length;
    const when = new Date(slot.fetchedAt || Date.now()).toLocaleTimeString();
    const src = slot.source === 'network' ? '网络' : '缓存';
    let html = '<span class="rv">' + n + ' 项</span><span class="rv-sub">' + src + ' · ' + when + '</span>';
    if (slot.error) {
      html += '<span class="rv-err" title="' + escapeHtml(slot.error.message) + '">刷新失败</span>';
    }
    return html;
  };
  $('#resModels').innerHTML = fmt(st.models);
  $('#resTools').innerHTML = fmt(st.tools);
  $('#resAgents').innerHTML = fmt(st.agents);

  const counts = [st.models.items.length, st.tools.items.length, st.agents.items.length];
  const total = counts[0] + counts[1] + counts[2];
  const badge = $('#resBadge');
  if (st.loading) {
    badge.textContent = '加载中…';
    badge.className = 'res-badge loading';
  } else if (st.lastError) {
    badge.textContent = '部分失败';
    badge.className = 'res-badge err';
  } else if (total) {
    badge.textContent = '共 ' + total + ' 项';
    badge.className = 'res-badge ok';
  } else {
    badge.textContent = '未加载';
    badge.className = 'res-badge';
  }

  const notes = [];
  if (st.models.error) notes.push('模型：' + st.models.error.message);
  if (st.tools.error) notes.push('工具：' + st.tools.error.message);
  if (st.agents.error) notes.push('智能体：' + st.agents.error.message);
  const note = $('#resNote');
  if (notes.length) {
    note.textContent = '刷新失败，已保留旧缓存：' + notes.join('；');
    note.className = 'res-note err';
  } else if (st.loadedKey && total === 0 && st.models.fetchedAt) {
    note.textContent = '服务端返回 0 项：模型可能未开放选择，工具/智能体可能未安装或未授权。';
    note.className = 'res-note warn';
  } else {
    note.textContent = '首次获取令牌后自动加载；缓存 10 分钟内不会重复请求。点「清空缓存并重拉」可强制以新结果为准。';
    note.className = 'res-note';
  }

  const status = $('#resStatus');
  if (st.loading) status.textContent = '正在加载模型 / 工具 / 智能体…';
  else if (total) status.textContent = '模型 ' + counts[0] + ' · 工具 ' + counts[1] + ' · 智能体 ' + counts[2];
  else if (st.lastError) status.textContent = '资源加载失败（详见连接设置）';
  else status.textContent = '模型 / 工具未加载';

  // 选择项在刷新后可能已不存在
  let selChanged = false;
  if (S.sel.model && !st.models.items.find((m) => m.id === S.sel.model)) {
    S.sel.model = '';
    selChanged = true;
  }
  if (S.sel.agent && !st.agents.items.find((a) => a.id === S.sel.agent)) {
    S.sel.agent = '';
    selChanged = true;
  }
  const before = S.sel.tools.length;
  S.sel.tools = S.sel.tools.filter((id) => st.tools.items.find((t) => t.id === id));
  if (before !== S.sel.tools.length) selChanged = true;
  if (selChanged) saveSelection();
  syncSelectors();
}

function renderSelectors() {
  const st = res.state;
  const selModel = $('#selModel');
  const selAgent = $('#selAgent');
  const prevModel = S.sel.model;
  const prevAgent = S.sel.agent;

  selModel.innerHTML = '<option value="">服务端默认</option>';
  st.models.items.forEach((m) => {
    const o = document.createElement('option');
    o.value = m.id;
    o.textContent = (m.displayName || m.modelLevelDesc || m.name || m.id) + (m.autoRouting ? '（自动路由）' : '');
    selModel.appendChild(o);
  });

  selAgent.innerHTML = '<option value="">默认搭档</option>';
  st.agents.items.forEach((a) => {
    const o = document.createElement('option');
    o.value = a.id;
    o.textContent = a.displayName || a.name || a.id;
    selAgent.appendChild(o);
  });

  selModel.value = prevModel;
  if (selModel.value !== prevModel) selModel.value = '';
  selAgent.value = prevAgent;
  if (selAgent.value !== prevAgent) selAgent.value = '';

  renderToolPop();
  updateToolCount();
}

function syncSelectors() {
  const selModel = $('#selModel');
  const selAgent = $('#selAgent');
  if (selModel && selModel.value !== S.sel.model) selModel.value = S.sel.model;
  if (selAgent && selAgent.value !== S.sel.agent) selAgent.value = S.sel.agent;
  updateToolCount();
  // 勾选态同步
  $$('#toolPop input[type=checkbox]').forEach((cb) => {
    cb.checked = S.sel.tools.indexOf(cb.value) >= 0;
  });
}

function renderToolPop() {
  const pop = $('#toolPop');
  pop.innerHTML = '';
  const items = res.state.tools.items;
  if (!items.length) {
    pop.innerHTML =
      '<div class="pop-head">工具列表为空</div>' +
      '<div class="pop-empty">先获取令牌后刷新；若仍为空，可能是该用户未安装工具，或服务端暂不可用（503）。</div>';
    return;
  }
  const head = document.createElement('div');
  head.className = 'pop-head';
  head.innerHTML = '<b>本轮工具</b><span>不勾选 = 不限制，沿用会话既有工具集</span>';
  pop.appendChild(head);

  const list = document.createElement('div');
  list.className = 'pop-list';
  items.forEach((t) => {
    const lab = document.createElement('label');
    lab.className = 'pi';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = t.id;
    cb.checked = S.sel.tools.indexOf(t.id) >= 0;
    cb.addEventListener('change', () => {
      const idx = S.sel.tools.indexOf(t.id);
      if (cb.checked && idx < 0) S.sel.tools.push(t.id);
      if (!cb.checked && idx >= 0) S.sel.tools.splice(idx, 1);
      updateToolCount();
      saveSelection();
    });
    const box = document.createElement('span');
    box.className = 'pi-text';
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = t.displayName || t.name || t.id;
    const ds = document.createElement('span');
    ds.className = 'ds';
    ds.textContent = t.description || t.id;
    box.appendChild(nm);
    box.appendChild(ds);
    lab.appendChild(cb);
    lab.appendChild(box);
    list.appendChild(lab);
  });
  pop.appendChild(list);

  const foot = document.createElement('div');
  foot.className = 'pop-foot';
  const clear = document.createElement('button');
  clear.className = 'btn ghost xs';
  clear.textContent = '清空选择';
  clear.addEventListener('click', () => {
    S.sel.tools = [];
    syncSelectors();
    saveSelection();
  });
  const refresh = document.createElement('button');
  refresh.className = 'btn ghost xs';
  refresh.textContent = '刷新工具列表';
  refresh.addEventListener('click', () => {
    toggleToolPop(false);
    loadResources(true, { silent: false });
  });
  foot.appendChild(clear);
  foot.appendChild(refresh);
  pop.appendChild(foot);
}

function updateToolCount() {
  const n = S.sel.tools.length;
  $('#toolCount').textContent = String(n);
  $('#btnTools').classList.toggle('on', n > 0);
}

function selectionKey() {
  return 'lg.sel.v1.' + Store.resCacheKey(S.cfg || {});
}

function loadSelection() {
  const key = selectionKey();
  S.selKey = key;
  const rec = Store.readJSON(key, null);
  S.sel = {
    model: rec && rec.model ? rec.model : '',
    agent: rec && rec.agent ? rec.agent : '',
    tools: rec && Array.isArray(rec.tools) ? rec.tools.slice() : [],
  };
}

function saveSelection() {
  Store.writeJSON(selectionKey(), S.sel);
}

async function loadResources(force, opts = {}) {
  if (!cfgComplete()) {
    openDrawer();
    toast('请先填写连接配置并获取令牌', 'err');
    return;
  }
  const btn = $('#btnRefreshRes');
  if (btn) btn.classList.add('spin');
  const st = await res.load({ force: !!force });
  if (btn) btn.classList.remove('spin');
  renderSelectors();
  renderResources();
  if (opts.silent) return;
  const counts = [st.models.items.length, st.tools.items.length, st.agents.items.length];
  const total = counts[0] + counts[1] + counts[2];
  if (st.lastError) {
    toast('部分加载失败，已保留缓存', 'err');
  } else if (total === 0) {
    toast('服务端返回 0 项（模型可能未开放；工具/智能体可能未安装）', 'warn');
  } else {
    toast('已更新：模型 ' + counts[0] + ' · 工具 ' + counts[1] + ' · 智能体 ' + counts[2], 'ok');
  }
}

function onEnvChanged() {
  loadSelection();
  res.hydrate();
  renderSelectors();
  renderResources();
  renderConn();
  renderPresets();
  renderTokenPreview();
}

/* ---------------- 标题 / 状态 ---------------- */

function updateTitle() {
  const s = activeSession();
  const title = $('#convTitle');
  const sub = $('#convSub');
  if (!s) {
    title.textContent = '新会话';
    sub.textContent = '尚未创建 · 发送后自动建会话';
  } else {
    title.textContent = s.title || '新会话';
    const st = engine.stateOf(s.id);
    let text = s.serverId ? 'session ' + s.serverId.slice(0, 8) + '…' : '准备创建会话';
    if (st.streaming) text += ' · 生成中';
    else if (st.queuePos) text += ' · 排队第 ' + st.queuePos + ' 位';
    if (s.pendingTask && !st.streaming) text += ' · 未完成';
    sub.textContent = text;
  }
  updateTopStatus();
}

function updateTopStatus() {
  const chip = $('#topStatus');
  const span = chip.querySelector('span');
  const s = activeSession();
  let state = 'idle';
  let label = '未连接';
  if (s) {
    const st = engine.stateOf(s.id);
    if (st.streaming) {
      state = 'live';
      label = '生成中';
    } else if (st.queuePos) {
      state = 'warn';
      label = '排队中';
    } else if (st.channelState === 'open') {
      state = 'ok';
      label = 'SSE 已连接';
    } else if (st.channelState === 'retrying') {
      state = 'warn';
      label = 'SSE 重连中';
    } else if (st.channelState === 'auth') {
      state = 'err';
      label = '鉴权失效';
    } else {
      label = 'SSE 未连接';
    }
  } else if (cfgComplete() && api.tokenState().valid) {
    state = 'ok';
    label = '已配置';
  }
  chip.dataset.state = state;
  span.textContent = label;
}

/* ---------------- 会话列表 ---------------- */

function dayBucket(ts) {
  const d = new Date(ts);
  const today = new Date();
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  if (ts >= startOfToday) return '今天';
  if (ts >= startOfToday - 86400000) return '昨天';
  if (ts >= startOfToday - 7 * 86400000) return '近 7 天';
  return '更早';
}

function timeText(ts) {
  const d = new Date(ts);
  const today = new Date();
  const sameDay =
    d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
  if (sameDay) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return (d.getMonth() + 1) + '-' + d.getDate();
}

function renderSessions() {
  const list = $('#sessList');
  if (!list) return;
  const q = S.search.trim().toLowerCase();
  let items = S.index.slice();
  // 尚未落库的草稿/排队会话也出现在列表里（例如排队中还没开始执行的那条）
  const known = new Set(items.map((x) => x.id));
  S.sessions.forEach((s) => {
    if (!known.has(s.id)) {
      items.push({
        id: s.id,
        title: s.title || '新会话',
        updatedAt: s.updatedAt || Date.now(),
        messageCount: (s.messages || []).length,
        pendingTask: s.pendingTask || '',
        unread: s.unread || 0,
        preview: '',
      });
    }
  });
  if (q) items = items.filter((s) => String(s.title || '').toLowerCase().includes(q) || String(s.preview || '').toLowerCase().includes(q));
  items.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

  if (!items.length) {
    list.innerHTML =
      '<div class="sess-empty">' +
      (S.index.length ? '没有匹配的会话' : '还没有记录。对话后会自动保存在本机，最多保留 50 条。') +
      '</div>';
    return;
  }

  let html = '';
  let lastBucket = '';
  items.forEach((s) => {
    const bucket = dayBucket(s.updatedAt || Date.now());
    if (bucket !== lastBucket) {
      html += '<div class="sess-group">' + bucket + '</div>';
      lastBucket = bucket;
    }
    const st = engine.stateOf(s.id);
    const isActive = s.id === S.activeId;
    let statusHtml = '';
    if (st.queuePos) {
      statusHtml = '<span class="sess-badge queue">排队 ' + st.queuePos + '</span>';
    } else if (st.streaming) {
      statusHtml = '<span class="sess-badge live"><i></i>生成中</span>';
    } else if (s.pendingTask) {
      statusHtml = '<span class="sess-badge pending">未完成</span>';
    } else if (s.unread) {
      statusHtml = '<span class="sess-badge unread">' + s.unread + '</span>';
    }
    const meta = timeText(s.updatedAt || Date.now()) + ' · ' + (s.messageCount || 0) + ' 条';
    html +=
      '<div class="sess-item' + (isActive ? ' on' : '') + '" role="button" tabindex="0" data-id="' + escapeHtml(s.id) + '">' +
      '<span class="sess-dot' + (st.streaming ? ' live' : s.pendingTask ? ' pending' : s.unread ? ' unread' : '') + '"></span>' +
      '<span class="sess-main">' +
      '<span class="sess-title">' + escapeHtml(s.title || '新会话') + '</span>' +
      '<span class="sess-meta">' + escapeHtml(meta) + (s.preview ? ' · ' + escapeHtml(s.preview) : '') + '</span>' +
      '</span>' +
      statusHtml +
      '<span class="sess-actions">' +
      '<button class="icon-btn tiny" data-act="export" title="导出 Markdown"><svg class="icon"><use href="#i-download"/></svg></button>' +
      '<button class="icon-btn tiny" data-act="rename" title="重命名"><svg class="icon"><use href="#i-edit"/></svg></button>' +
      '<button class="icon-btn tiny" data-act="delete" title="删除"><svg class="icon"><use href="#i-trash"/></svg></button>' +
      '</span>' +
      '</div>';
  });
  list.innerHTML = html;
}

function sessionFromStore(id) {
  const rec = Store.loadSession(id);
  if (!rec) return null;
  const messages = (rec.messages || []).map((m) => {
    // 上次关闭时正在流式的消息：恢复成「已完成/未完成」，避免永远转圈
    if (m.status === 'streaming') {
      m.status = m.text ? 'done' : 'pending';
      if (!m.text) m.error = m.error || '上次关闭页面时本轮尚未完成。';
    }
    return m;
  });
  return {
    id: rec.id,
    serverId: rec.id,
    title: rec.title || '新会话',
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
    messages,
    pendingTask: rec.pendingTask || '',
    pendingAt: rec.pendingAt || 0,
    unread: rec.unread || 0,
    renamed: false,
  };
}

function openSession(id) {
  if (S.activeId === id) {
    closeOverlays();
    return;
  }
  let s = S.sessions.get(id);
  if (!s) {
    s = sessionFromStore(id);
    if (!s) {
      toast('会话记录已不存在', 'err');
      return;
    }
    S.sessions.set(id, s);
  }
  S.activeId = id;
  if (s.unread) {
    s.unread = 0;
    Store.saveSession(s);
  }
  S.index = Store.loadIndex();
  engine.attach(s);
  renderChat({ forceBottom: true });
  updateTitle();
  updateComposer();
  renderSessions();
  closeOverlays();
  Store.setMeta({ lastSession: id });
  if (cfgComplete() && s.serverId) {
    engine.prepare(s).catch(() => {});
  }
  setTimeout(() => {
    if (window.innerWidth > 900) $('#input').focus();
  }, 60);
}

function newChat() {
  S.activeId = '';
  S.sessions.delete('__draft__');
  renderChat({ forceBottom: true });
  updateTitle();
  updateComposer();
  renderSessions();
  closeOverlays();
  Store.setMeta({ lastSession: '' });
  setTimeout(() => $('#input').focus(), 40);
}

function ensureActiveSession() {
  const cur = activeSession();
  if (cur) return cur;
  const s = {
    id: newLocalId(),
    serverId: null,
    title: '新会话',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [],
    pendingTask: '',
    pendingAt: 0,
    unread: 0,
    local: true,
    renamed: false,
  };
  S.sessions.set(s.id, s);
  S.activeId = s.id;
  engine.attach(s);
  return s;
}

function onSessionIdChange(oldId, newId) {
  const s = S.sessions.get(oldId);
  if (s) {
    S.sessions.delete(oldId);
    s.id = newId;
    s.serverId = newId;
    s.local = false;
    S.sessions.set(newId, s);
  }
  if (S.activeId === oldId) S.activeId = newId;
  Store.removeSession(oldId);
  if (s) Store.saveSession(s);
  debug.bindSession(S.logMark || 0, newId);
  S.index = Store.loadIndex();
  renderSessions();
  updateTitle();
  Store.setMeta({ lastSession: S.activeId });
}

function deleteSession(id) {
  const s = S.sessions.get(id) || { id };
  engine.detach(id);
  S.sessions.delete(id);
  Store.removeSession(id);
  S.index = Store.loadIndex();
  if (S.activeId === id) {
    S.activeId = '';
    renderChat({ forceBottom: true });
    updateTitle();
    updateComposer();
  }
  renderSessions();
  toast('已删除本地会话记录（服务端上下文不受影响）');
}

function renameSession(id) {
  const rec = S.index.find((x) => x.id === id);
  if (!rec) return;
  dialogConfirm({
    title: '重命名会话',
    text: '只改本机显示名称，服务端标题不受影响。',
    input: true,
    value: rec.title || '',
    ok: '保存',
  }).then((val) => {
    if (val === false) return;
    const name = String(val).trim();
    if (!name) return;
    const s = S.sessions.get(id);
    if (s) {
      s.title = name;
      s.renamed = true;
      Store.saveSession(s);
    } else {
      const loaded = sessionFromStore(id);
      if (loaded) {
        loaded.title = name;
        loaded.renamed = true;
        Store.saveSession(loaded);
      }
    }
    S.index = Store.loadIndex();
    renderSessions();
    if (S.activeId === id) updateTitle();
    toast('已重命名', 'ok');
  });
}

function exportSession(id) {
  let s = S.sessions.get(id);
  if (!s) s = sessionFromStore(id);
  if (!s) return;
  const lines = ['# ' + (s.title || '会话'), '', '> session_id: `' + (s.serverId || s.id) + '`', ''];
  (s.messages || []).forEach((m) => {
    lines.push(m.role === 'user' ? '## 我' : '## 灵基');
    lines.push('');
    if (m.reasoning) {
      lines.push('> 思考过程：', '', m.reasoning, '');
    }
    lines.push(m.text || '', '');
    if (m.artifacts && m.artifacts.length) {
      lines.push('产物：' + m.artifacts.map((a) => a.name).join('、'), '');
    }
  });
  const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
  downloadBlob(blob, safeFileName(s.title || 'session') + '.md');
}

function safeFileName(s) {
  return String(s || 'session').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 50);
}

function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 500);
}

/* ---------------- 消息渲染 ---------------- */

function renderChat(opts = {}) {
  const chat = $('#chat');
  const empty = $('#emptyState');
  Array.from(chat.children).forEach((c) => {
    if (c !== empty) c.remove();
  });
  S.msgNodes.clear();

  const s = activeSession();
  const messages = s ? s.messages || [] : [];
  const showEmpty = !messages.length;
  if (empty) empty.hidden = !showEmpty;
  if (showEmpty) {
    updateEmptyHint(s);
    return;
  }

  messages.forEach((m) => {
    const node = createMessageEl(m, s);
    chat.appendChild(node);
    S.msgNodes.set(m.id, node);
  });

  renderResumeBar(s);
  if (opts.forceBottom) scrollBottom();
}

function updateEmptyHint(s) {
  const p = $('#emptyState p');
  if (!p) return;
  if (s) {
    p.textContent = '直接输入问题继续这条会话。服务端上下文仍在，本地只恢复了你看到的回答。';
  } else {
    p.textContent = '先在「连接设置」里填好应用凭证并获取令牌，然后直接提问。默认走 SSE 流式，断了会自动用轮询兜底。';
  }
}

function createMessageEl(msg, session) {
  const article = document.createElement('article');
  article.className = 'msg ' + (msg.role === 'user' ? 'user' : 'bot');
  article.dataset.mid = msg.id;
  article._msg = msg;

  if (msg.role === 'user') {
    article.innerHTML =
      '<div class="msg-body"><div class="bubble"></div><div class="msg-foot"><time></time></div></div>' +
      '<div class="avatar" aria-hidden="true">我</div>';
    article.querySelector('.bubble').textContent = msg.text || '';
    article.querySelector('time').textContent = formatClock(msg.time);
    return article;
  }

  article.innerHTML =
    '<div class="avatar" aria-hidden="true">灵</div>' +
    '<div class="msg-body">' +
    '<div class="msg-head"><b>灵基</b><span class="msg-meta"></span></div>' +
    '<div class="bubble">' +
    '<div class="msg-extra"></div>' +
    '<div class="md"></div>' +
    '<div class="msg-after"></div>' +
    '<span class="typing" hidden><i></i><i></i><i></i></span>' +
    '</div>' +
    '<div class="msg-foot"><time></time><span class="via"></span>' +
    '<span class="foot-actions">' +
    '<button class="link-btn" data-copy-msg="1">复制</button>' +
    '<button class="link-btn" data-retry-msg="1" hidden>重试</button>' +
    '</span></div>' +
    '</div>';

  article._refs = {
    extra: article.querySelector('.msg-extra'),
    after: article.querySelector('.msg-after'),
    md: article.querySelector('.md'),
    typing: article.querySelector('.typing'),
    time: article.querySelector('time'),
    via: article.querySelector('.via'),
    meta: article.querySelector('.msg-meta'),
    copy: article.querySelector('[data-copy-msg]'),
    retry: article.querySelector('[data-retry-msg]'),
  };
  paintMessage(article, msg, session);
  return article;
}

function paintMessage(node, msg, session) {
  if (!node || msg.role === 'user') return;
  const refs = node._refs;
  if (!refs) return;
  const streaming = msg.status === 'streaming';
  node.classList.toggle('is-streaming', streaming);
  node.classList.toggle('is-error', msg.status === 'error');
  node.classList.toggle('is-pending', msg.status === 'pending');

  // 附加区：思考过程 / 工具在正文前；错误 / 产物在正文后
  const top = [];
  const bottom = [];
  if (msg.reasoning) {
    top.push(
      '<details class="reasoning"><summary>思考过程</summary><div class="md">' +
        renderMarkdown(msg.reasoning, { streaming }) +
        '</div></details>'
    );
  }
  if (msg.tools && msg.tools.length) {
    top.push(
      '<div class="tool-row">' +
        msg.tools
          .map(
            (t) =>
              '<span class="tool-chip" title="' + escapeHtml(t.state || '') + '">' +
              escapeHtml(t.name || '工具') +
              '</span>'
          )
          .join('') +
        '</div>'
    );
  }
  if (msg.error) {
    bottom.push('<div class="msg-error">' + escapeHtml(msg.error) + '</div>');
  }
  if (msg.artifacts && msg.artifacts.length) {
    bottom.push(
      '<div class="artifacts">' +
        msg.artifacts
          .map(
            (a) =>
              '<button class="artifact" data-artifact="' +
              escapeHtml(a.artifactId) +
              '" data-art-session="' +
              escapeHtml(session ? session.id : '') +
              '" title="' +
              escapeHtml(a.name) +
              '"><svg class="icon"><use href="#i-download"/></svg><span>' +
              escapeHtml(a.name) +
              '</span></button>'
          )
          .join('') +
        '</div>'
    );
  }
  refs.extra.innerHTML = top.join('');
  refs.after.innerHTML = bottom.join('');

  // 正文
  if (msg.text) {
    const hash = msg.text.length + ':' + msg.status + ':' + msg.text.slice(-40);
    if (node._hash !== hash) {
      refs.md.innerHTML = renderMarkdown(msg.text, { streaming });
      node._hash = hash;
    }
  } else {
    refs.md.innerHTML = '';
    node._hash = '';
  }
  refs.md.hidden = !msg.text;
  refs.typing.hidden = !(streaming && !msg.text);

  // 页脚
  refs.time.textContent = formatClock(msg.time);
  const meta = msg.meta || {};
  let via = '';
  if (msg.status === 'streaming') via = '生成中…';
  else if (msg.status === 'pending') via = '未完成';
  else if (msg.status === 'error') via = '失败';
  else if (msg.status === 'stopped') via = '已停止';
  else if (meta.elapsed) via = (meta.via === 'poll' ? '轮询 · ' : 'SSE · ') + formatDuration(meta.elapsed);
  refs.via.textContent = via;
  const bits = [];
  if (meta.model) bits.push(meta.model);
  if (meta.usage && (meta.usage.total_tokens || meta.usage.totalTokens)) {
    bits.push((meta.usage.total_tokens || meta.usage.totalTokens) + ' tokens');
  }
  refs.meta.textContent = bits.join(' · ');
  refs.copy.hidden = !msg.text;
  refs.retry.hidden = msg.status !== 'error' && msg.status !== 'pending';
}

function updateMessage(msg) {
  const node = S.msgNodes.get(msg.id);
  if (!node) return;
  node._msg = msg;
  paintMessage(node, msg, activeSession());
}

function renderResumeBar(session) {
  const old = $('#resumeBar');
  if (old) old.remove();
  if (!session || !session.pendingTask) return;
  const st = engine.stateOf(session.id);
  if (st.streaming) return;
  const bar = document.createElement('div');
  bar.id = 'resumeBar';
  bar.className = 'resume-bar';
  bar.innerHTML =
    '<span>上一轮没有拿到终态（task <code>' + escapeHtml(String(session.pendingTask).slice(0, 10)) + '…</code>）。凭 task_id 仍可查到结果。</span>' +
    '<button class="btn ghost sm" id="btnResume">继续查询结果</button>';
  $('#chat').appendChild(bar);
  const btn = $('#btnResume');
  if (btn) {
    btn.addEventListener('click', async () => {
      bar.remove();
      const ok = await engine.resume(session);
      if (!ok) toast('暂时无法续查（并发已满或已有进行中的轮次）', 'warn');
    });
  }
}

function formatClock(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDuration(ms) {
  if (!ms) return '';
  if (ms < 1000) return ms + 'ms';
  const s = Math.round(ms / 1000);
  if (s < 60) return s + 's';
  return Math.floor(s / 60) + 'm' + (s % 60 ? ' ' + (s % 60) + 's' : '');
}

function scrollBottom() {
  const el = $('#chatScroll');
  el.scrollTop = el.scrollHeight;
  S.nearBottom = true;
  $('#btnScrollBottom').hidden = true;
}

/* ---------------- 引擎回调 ---------------- */

function onSessionChange(sid, reason) {
  S.index = Store.loadIndex();
  if (sid === S.activeId) {
    if (reason === 'turn-start' || reason === 'resume') {
      renderChat({ forceBottom: true });
    }
    if (reason === 'finished') {
      renderResumeBar(activeSession());
      updateComposer();
    }
    if (reason === 'queued' || reason === 'queue-cancel' || reason === 'submitted' || reason === 'channel') {
      updateComposer();
    }
    updateTitle();
  }
  renderSessions();
}

function onTurnChange(sid, turn) {
  if (sid !== S.activeId) return;
  const msg = turn.botMsg;
  const node = S.msgNodes.get(msg.id);
  if (node) {
    paintMessage(node, msg, activeSession());
    if (S.nearBottom) scrollBottom();
  }
  updateTitle();
}

/* ---------------- 发送 / 停止 ---------------- */

function currentPayload(query) {
  return {
    query,
    model: S.sel.model || '',
    assistantId: S.sel.agent || '',
    tools: S.sel.tools.slice(),
  };
}

async function send() {
  const input = $('#input');
  const text = input.value.trim();
  if (!text) return;
  if (!cfgComplete()) {
    openDrawer();
    toast('请先填写连接配置并获取令牌', 'err');
    return;
  }
  const s = activeSession();
  const st = s ? engine.stateOf(s.id) : { streaming: false, queuePos: 0 };
  if (st.streaming) {
    toast('该会话正在执行，先停止或等它完成', 'warn');
    return;
  }
  if (st.queuePos) {
    toast('该会话已在排队中', 'warn');
    return;
  }

  const session = ensureActiveSession();
  S.logMark = debug.seq;
  input.value = '';
  autoGrow();
  updateSendEnabled();

  try {
    const r = await engine.send(session, currentPayload(text));
    if (r && r.queued) toast('并发已满，已排队 · 第 ' + r.pos + ' 位', 'warn');
  } catch (e) {
    input.value = text;
    autoGrow();
    updateSendEnabled();
    toast((e && e.code ? '[' + e.code + '] ' : '') + ((e && e.message) || '发送失败'), 'err');
  }
  updateComposer();
}

async function stopActive() {
  const s = activeSession();
  if (!s) return;
  await engine.stop(s);
  updateComposer();
  toast('已请求停止');
}

function updateComposer() {
  const s = activeSession();
  const st = s ? engine.stateOf(s.id) : { streaming: false, queuePos: 0, channelState: 'idle' };
  const streaming = !!st.streaming;
  $('#btnStop').hidden = !streaming;
  $('#btnSend').hidden = streaming;
  $('#inputShell').classList.toggle('busy', streaming);

  const qb = $('#queueBar');
  if (st.queuePos) {
    const info = engine.runtimes.get(s.id);
    const q = info && info.queued ? info.queued.query : '';
    qb.hidden = false;
    qb.innerHTML =
      '<span>排队中 · 第 ' + st.queuePos + ' 位（并发上限 ' + engine.maxConcurrent + '）' +
      (q ? '：<b>' + escapeHtml(q.slice(0, 40)) + '</b>' : '') +
      '</span><button class="link-btn" id="btnQueueCancel">取消</button>';
    const cancel = $('#btnQueueCancel');
    if (cancel) {
      cancel.addEventListener('click', () => {
        const payload = engine.cancelQueued(s.id);
        if (payload && payload.query) {
          $('#input').value = payload.query;
          autoGrow();
          $('#input').focus();
        }
        // 排队被取消且这条会话还没产生任何消息：收回草稿，避免列表里留下空条目
        if (s && (!s.messages || !s.messages.length) && !s.serverId) {
          engine.detach(s.id);
          S.sessions.delete(s.id);
          if (S.activeId === s.id) S.activeId = '';
          renderChat({ forceBottom: true });
          updateTitle();
        }
        renderSessions();
        updateComposer();
        updateSendEnabled();
      });
    }
  } else {
    qb.hidden = true;
    qb.innerHTML = '';
  }

  let hint = '';
  if (streaming) {
    const t = engine.stateOf(s.id);
    hint = t.channelState === 'open' ? 'SSE 收流中' : t.channelState === 'retrying' ? 'SSE 重连中，轮询兜底' : '正在执行';
  }
  $('#hint').textContent = hint;
  updateSendEnabled();
  updateTopStatus();
}

function updateSendEnabled() {
  const input = $('#input');
  const s = activeSession();
  const st = s ? engine.stateOf(s.id) : { streaming: false, queuePos: 0 };
  const disabled = !input.value.trim() || st.streaming || !!st.queuePos;
  $('#btnSend').disabled = disabled;
}

function autoGrow() {
  const t = $('#input');
  t.style.height = 'auto';
  t.style.height = Math.min(200, t.scrollHeight) + 'px';
}

/* ---------------- 工具浮层 / 抽屉 ---------------- */

function positionToolPop() {
  if (window.innerWidth <= 900) return;
  const pop = $('#toolPop');
  const btn = $('#btnTools');
  const r = btn.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const gap = 8;
  const margin = 12;
  const w = Math.min(340, vw - margin * 2);
  pop.style.width = w + 'px';
  pop.style.maxHeight = 'none';
  const natural = pop.offsetHeight || 320;
  const left = Math.min(Math.max(margin, r.left), Math.max(margin, vw - w - margin));
  const below = vh - r.bottom - gap - margin;
  const above = r.top - gap - margin;
  const openUp = below < Math.min(natural, 220) && above > below;
  let top;
  let maxH;
  if (openUp) {
    maxH = Math.min(natural, above);
    top = r.top - gap - Math.max(maxH, 0);
  } else {
    maxH = Math.min(natural, below);
    top = r.bottom + gap;
  }
  pop.style.left = left + 'px';
  pop.style.top = Math.max(margin, top) + 'px';
  pop.style.maxHeight = Math.max(160, maxH) + 'px';
}

function toggleToolPop(force) {
  const pop = $('#toolPop');
  const show = typeof force === 'boolean' ? force : !pop.classList.contains('on');
  pop.classList.toggle('on', show);
  document.body.classList.toggle('pop-open', show);
  if (show) {
    renderToolPop();
    positionToolPop();
  }
}

function openDrawer() {
  $('#drawer').classList.add('on');
  $('#drawer').setAttribute('aria-hidden', 'false');
  $('#scrim').hidden = false;
  document.body.classList.add('locked');
  writeForm();
  renderPresets();
  renderResources();
  res.hydrate();
  // 已有令牌但无资源时，静默补一次
  if (cfgComplete() && api.tokenState().valid && !res.hasAny() && !res.state.loading) {
    loadResources(false, { silent: true });
  }
}

function closeDrawer() {
  $('#drawer').classList.remove('on');
  $('#drawer').setAttribute('aria-hidden', 'true');
  readForm();
  persistCfg();
  renderConn();
  onEnvChanged();
  maybeUnlockBody();
}

function openSidebar() {
  $('#app').classList.add('side-open');
  $('#scrim').hidden = false;
  document.body.classList.add('locked');
}

function closeSidebar() {
  $('#app').classList.remove('side-open');
  maybeUnlockBody();
}

function closeOverlays() {
  closeSidebar();
  if ($('#drawer').classList.contains('on')) {
    $('#drawer').classList.remove('on');
    $('#drawer').setAttribute('aria-hidden', 'true');
    readForm();
    persistCfg();
  }
  toggleToolPop(false);
  maybeUnlockBody();
}

function maybeUnlockBody() {
  const anyOpen = $('#drawer').classList.contains('on') || $('#app').classList.contains('side-open');
  if (!anyOpen) {
    $('#scrim').hidden = true;
    document.body.classList.remove('locked');
  }
}

function openDebug() {
  $('#debug').classList.add('on');
  $('#debug').setAttribute('aria-hidden', 'false');
  $('#app').classList.add('debug-open');
  debug.open = true;
  renderDebug();
  const list = $('#dbgList');
  list.scrollTop = list.scrollHeight;
}

function closeDebug() {
  $('#debug').classList.remove('on');
  $('#debug').setAttribute('aria-hidden', 'true');
  $('#app').classList.remove('debug-open');
  debug.open = false;
}

function renderDebug() {
  debug.render({
    listEl: $('#dbgList'),
    subEl: $('#dbgSub'),
    countEl: $('#dbgCount'),
    activeSessionId: S.activeId,
  });
}

/* ---------------- 主题 ---------------- */

function systemDark() {
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function applyTheme() {
  const resolved = S.prefs.theme === 'auto' ? (systemDark() ? 'dark' : 'light') : S.prefs.theme;
  document.documentElement.dataset.theme = resolved;
  const icon = $('#themeIcon use');
  if (icon) icon.setAttribute('href', resolved === 'dark' ? '#i-sun' : '#i-moon');
  $('#themeText').textContent = resolved === 'dark' ? '浅色' : '深色';
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', resolved === 'dark' ? '#0d1118' : '#f5f7fb');
}

function toggleTheme() {
  const resolved = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
  S.prefs.theme = resolved === 'dark' ? 'light' : 'dark';
  persistCfg();
  applyTheme();
}

/* ---------------- 初始化与事件 ---------------- */

function bindEvents() {
  // 会话列表
  $('#sessList').addEventListener('click', (e) => {
    const item = e.target.closest('.sess-item');
    if (!item) return;
    const id = item.dataset.id;
    const act = e.target.closest('[data-act]');
    if (act) {
      e.stopPropagation();
      if (act.dataset.act === 'delete') {
        dialogConfirm({
          title: '删除会话',
          text: '只删除本机记录，服务端上下文仍保留。确定删除？',
          ok: '删除',
          danger: true,
        }).then((ok) => ok && deleteSession(id));
      } else if (act.dataset.act === 'rename') {
        renameSession(id);
      } else if (act.dataset.act === 'export') {
        exportSession(id);
      }
      return;
    }
    openSession(id);
  });
  $('#sessList').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      const item = e.target.closest('.sess-item');
      if (item) {
        e.preventDefault();
        openSession(item.dataset.id);
      }
    }
  });

  $('#sessionSearch').addEventListener('input', (e) => {
    S.search = e.target.value;
    renderSessions();
  });

  $('#btnNew').addEventListener('click', newChat);
  $('#btnClearHist').addEventListener('click', () => {
    if (!S.index.length) return;
    dialogConfirm({
      title: '清空会话记录',
      text: '清空本机保存的全部会话记录？服务端会话不受影响，但本地将无法找回。',
      ok: '清空',
      danger: true,
    }).then((ok) => {
      if (!ok) return;
      // 先摘掉所有运行时，避免进行中的轮次在清空后又把记录写回索引
      Array.from(S.sessions.keys()).forEach((id) => engine.detach(id));
      Store.clearSessions();
      S.sessions.clear();
      S.activeId = '';
      S.index = [];
      renderChat({ forceBottom: true });
      updateTitle();
      updateComposer();
      renderSessions();
      toast('已清空本地会话记录');
    });
  });

  // 连接设置
  $('#btnSettings').addEventListener('click', openDrawer);
  $('#btnCloseDrawer').addEventListener('click', closeDrawer);
  $('#btnSavePreset').addEventListener('click', savePreset);
  $('#btnDelPreset').addEventListener('click', delPreset);
  $('#presetSel').addEventListener('change', function () {
    if (this.value) loadPreset(this.value);
  });
  $('#presetName').addEventListener('input', () => {});
  $('#btnToken').addEventListener('click', function () {
    fetchToken(this);
  });
  $('#btnLoadRes').addEventListener('click', () => {
    readForm();
    persistCfg();
    loadResources(true);
  });
  $('#btnResRefresh').addEventListener('click', () => {
    readForm();
    persistCfg();
    loadResources(true);
  });
  $('#btnResClear').addEventListener('click', () => {
    dialogConfirm({
      title: '清空资源缓存',
      text: '删除该环境的模型 / 工具 / 智能体缓存，并立即重新拉取。若拉取失败，将显示空态而不是回退旧数据。',
      ok: '清空并重拉',
      danger: true,
    }).then((ok) => {
      if (!ok) return;
      readForm();
      persistCfg();
      res.clearAndReload().then(() => {
        renderSelectors();
        renderResources();
        toast('缓存已清空并以新结果为准', 'ok');
      });
    });
  });

  $('#fMode').addEventListener('change', syncModeUI);
  $('#fSubType').addEventListener('change', syncModeUI);
  const dbody = $('#drawer .panel-body');
  if (dbody) {
    dbody.addEventListener('input', () => {
      readForm();
      renderConn();
      renderTokenPreview();
      persistCfg();
      res.hydrate();
      renderResources();
    });
    dbody.addEventListener('change', () => {
      readForm();
      syncModeUI();
      persistCfg();
      res.hydrate();
      renderResources();
    });
  }

  // 调试
  $('#btnDebug').addEventListener('click', () => {
    if ($('#debug').classList.contains('on')) closeDebug();
    else openDebug();
  });
  $('#dbgClose').addEventListener('click', closeDebug);
  $('#dbgClear').addEventListener('click', () => {
    debug.clear();
    renderDebug();
  });
  $('#dbgScope').addEventListener('change', function () {
    debug.scope = this.value;
    renderDebug();
  });
  $('#dbgCat').addEventListener('change', function () {
    debug.cat = this.value;
    renderDebug();
  });
  $('#dbgSecrets').addEventListener('change', function () {
    debug.showSecrets = this.checked;
    renderDebug();
  });
  $('#dbgSearch').addEventListener('input', function () {
    debug.query = this.value;
    renderDebug();
  });
  debug.onChange(() => {
    if (debug.open) renderDebug();
    else $('#dbgCount').textContent = String(debug.entries.length);
  });

  // 发送与停止
  $('#btnSend').addEventListener('click', send);
  $('#btnStop').addEventListener('click', stopActive);
  $('#input').addEventListener('input', () => {
    autoGrow();
    updateSendEnabled();
  });
  $('#input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });

  // 模型 / 智能体 / 工具
  $('#selModel').addEventListener('change', function () {
    S.sel.model = this.value;
    saveSelection();
  });
  $('#selAgent').addEventListener('change', function () {
    S.sel.agent = this.value;
    saveSelection();
  });
  $('#btnTools').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleToolPop();
  });
  $('#btnRefreshRes').addEventListener('click', () => loadResources(true));

  document.addEventListener('click', (e) => {
    const pop = $('#toolPop');
    if (!pop.classList.contains('on')) return;
    if (!pop.contains(e.target) && !e.target.closest('#btnTools')) toggleToolPop(false);
  });

  // 移动端
  $('#btnMenu').addEventListener('click', openSidebar);
  $('#btnCloseSide').addEventListener('click', closeSidebar);
  $('#btnTopMore').addEventListener('click', openDrawer);
  $('#scrim').addEventListener('click', () => {
    closeSidebar();
    if ($('#drawer').classList.contains('on')) closeDrawer();
    toggleToolPop(false);
  });

  // 主题
  $('#btnTheme').addEventListener('click', toggleTheme);
  if (window.matchMedia) {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    if (mq.addEventListener) {
      mq.addEventListener('change', () => {
        if (S.prefs.theme === 'auto') applyTheme();
      });
    }
  }

  // 滚动
  const scroller = $('#chatScroll');
  scroller.addEventListener('scroll', () => {
    S.nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120;
    $('#btnScrollBottom').hidden = S.nearBottom;
  });
  $('#btnScrollBottom').addEventListener('click', scrollBottom);

  // 消息内操作（委托）
  $('#chat').addEventListener('click', (e) => {
    const copyCode = e.target.closest('[data-copy-code]');
    if (copyCode) {
      const code = copyCode.closest('.md-code').querySelector('code');
      copyText(code ? code.textContent : '');
      copyCode.textContent = '已复制';
      setTimeout(() => {
        copyCode.textContent = '复制';
      }, 1400);
      return;
    }
    const copyMsg = e.target.closest('[data-copy-msg]');
    if (copyMsg) {
      const article = copyMsg.closest('.msg');
      const msg = article && article._msg;
      if (msg) copyText(msg.text || '');
      copyMsg.textContent = '已复制';
      setTimeout(() => {
        copyMsg.textContent = '复制';
      }, 1400);
      return;
    }
    const art = e.target.closest('[data-artifact]');
    if (art) {
      downloadArtifact(art.dataset.artSession, art.dataset.artifact, art);
      return;
    }
    const retry = e.target.closest('[data-retry-msg]');
    if (retry) {
      const article = retry.closest('.msg');
      const msg = article && article._msg;
      const s = activeSession();
      if (!s || !msg) return;
      const idx = s.messages.indexOf(msg);
      const prevUser = idx > 0 ? s.messages[idx - 1] : null;
      if (prevUser && prevUser.role === 'user') {
        $('#input').value = prevUser.text;
        autoGrow();
        updateSendEnabled();
        $('#input').focus();
        toast('已把上一条问题放回输入框');
      }
      return;
    }
  });

  // 问答示例
  $('#chips').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    $('#input').value = chip.textContent;
    autoGrow();
    updateSendEnabled();
    $('#input').focus();
  });

  // 对话框
  $('#dlgOk').addEventListener('click', () => closeDialog(true));
  $('#dlgCancel').addEventListener('click', () => closeDialog(false));
  $('#dialog').addEventListener('click', (e) => {
    if (e.target.id === 'dialog') closeDialog(false);
  });
  $('#dlgInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      closeDialog(true);
    }
  });

  // 快捷键
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!$('#dialog').hidden) closeDialog(false);
      else if ($('#toolPop').classList.contains('on')) toggleToolPop(false);
      else if ($('#drawer').classList.contains('on')) closeDrawer();
      else if ($('#app').classList.contains('side-open')) closeSidebar();
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (window.innerWidth <= 900) openSidebar();
      $('#sessionSearch').focus();
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
      e.preventDefault();
      if ($('#debug').classList.contains('on')) closeDebug();
      else openDebug();
    }
  });

  window.addEventListener('resize', () => {
    if ($('#toolPop').classList.contains('on')) positionToolPop();
    if (window.innerWidth > 900 && $('#app').classList.contains('side-open')) closeSidebar();
  });

  window.addEventListener('storage', onStorage);
  window.addEventListener('beforeunload', () => {
    const s = activeSession();
    if (s) Store.saveSession(s);
  });

  setInterval(() => {
    renderConn();
    updateTopStatus();
  }, 30000);
}

function onStorage(e) {
  if (!e.key) return;
  if (e.key === Store.KEYS.index || e.key === Store.KEYS.cfg) {
    S.index = Store.loadIndex();
    renderSessions();
    return;
  }
  if (e.key.indexOf(Store.KEYS.sessPrefix) === 0) {
    const id = e.key.slice(Store.KEYS.sessPrefix.length);
    if (id === S.activeId) {
      const st = engine.stateOf(id);
      if (st.streaming) return; // 本标签页正在收流，避免被其它标签页覆盖
      const rec = sessionFromStore(id);
      if (rec) {
        S.sessions.set(id, rec);
        engine.attach(rec);
        renderChat();
        updateTitle();
      }
    }
    S.index = Store.loadIndex();
    renderSessions();
  }
}

function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
  } else {
    fallbackCopy(text);
  }
}

function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
  } catch (e) { /* ignore */ }
  ta.remove();
}

async function downloadArtifact(sessionId, artifactId, btn) {
  if (!sessionId || !artifactId) return;
  const label = btn.querySelector('span');
  const old = label ? label.textContent : '';
  if (label) label.textContent = '下载中…';
  try {
    const url = await api.downloadArtifact(sessionId, artifactId);
    const a = document.createElement('a');
    a.href = url;
    a.download = old || 'artifact';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      a.remove();
    }, 800);
    toast('已开始下载', 'ok');
  } catch (e) {
    toast('下载失败：' + (e.message || ''), 'err');
  } finally {
    if (label) label.textContent = old;
  }
}

/* ---------------- 启动 ---------------- */

function init() {
  Store.migrateLegacy();
  const cfg = Store.loadConfig();
  S.presets = cfg.presets;
  S.activePreset = cfg.activeId;
  S.prefs = cfg.prefs;
  S.cfg = cfg.current || {
    base: '',
    appId: '',
    secret: '',
    tenant: '',
    mode: 'FIXED_PROXY',
    subType: 'mobile',
    subject: '',
    dcId: '',
  };
  if (!cfg.current && S.activePreset) {
    const p = S.presets.find((x) => x.id === S.activePreset);
    if (p) {
      S.cfg = {
        base: p.base || '',
        appId: p.appId || '',
        secret: p.secret || '',
        tenant: p.tenant || '',
        mode: p.mode || 'FIXED_PROXY',
        subType: p.subType || 'mobile',
        subject: p.subject || '',
        dcId: p.dcId || '',
      };
    }
  }

  applyTheme();
  api.syncEnv();
  writeForm();
  renderPresets();
  loadSelection();
  res.hydrate();
  renderSelectors();
  renderResources();
  renderConn();
  renderTokenLine();
  renderDebug();
  $('#dbgCount').textContent = String(debug.entries.length);

  S.index = Store.loadIndex();

  bindEvents();

  // 任何途径拿到令牌（手动获取 / 发送时隐式签发）都补一次资源加载
  api.onTokenChange = () => {
    renderConn();
    if (cfgComplete() && !res.hasAny() && !res.state.loading) {
      loadResources(false, { silent: true });
    }
  };

  if (!SERVED) {
    $('#fileBanner').hidden = false;
    toast('当前是 file:// 直接打开，接口会被浏览器拦截。请用 node start.js 启动。', 'err');
  }

  // 恢复上次会话（只恢复已存在记录的会话）
  const meta = Store.getMeta();
  if (meta.lastSession && S.index.find((x) => x.id === meta.lastSession)) {
    openSession(meta.lastSession);
  } else {
    renderChat({ forceBottom: true });
    updateTitle();
    updateComposer();
  }
  renderSessions();
  updateComposer();
  updateSendEnabled();

  // 便于在本机控制台排查（本应用本身就是调试工具）
  window.__lg = { S, engine, api, res, debug, Store };

  // 有令牌（sessionStorage 恢复）且配置齐全时，后台静默拉一次资源
  if (cfgComplete() && api.tokenState().valid && !res.hasAny()) {
    loadResources(false, { silent: true });
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}