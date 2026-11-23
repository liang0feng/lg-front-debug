/* 调试看板：记录令牌、建会话、SSE、对话、轮询等每一步的输入输出。
 * - 默认打码令牌/签名；勾选后显示明文
 * - 持久化 24 小时内、最多 200 条
 * - 支持按会话范围、类别过滤、搜索、复制 cURL
 */

const MAX_ENTRIES = 200;
const TTL = 24 * 3600 * 1000;

function esc(s) {
  return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

export function maskSecret(v) {
  let s = String(v === null || v === undefined ? '' : v);
  let prefix = '';
  const m = s.match(/^(Bearer\s+)/i);
  if (m) {
    prefix = m[1];
    s = s.slice(prefix.length);
  }
  if (s.length <= 10) return prefix + '••••••';
  return prefix + s.slice(0, 6) + '••••••' + s.slice(-4);
}

function maskDeep(o, depth) {
  if (!o || typeof o !== 'object' || (depth || 0) > 6) return;
  Object.keys(o).forEach((k) => {
    const v = o[k];
    if (typeof v === 'string' && /^(access_token|app_secret|secret|token)$/i.test(k)) {
      o[k] = maskSecret(v);
    } else if (v && typeof v === 'object') {
      maskDeep(v, (depth || 0) + 1);
    }
  });
}

/** 落盘用的请求头：敏感值一律打码。 */
function scrubHeaders(h) {
  const out = {};
  Object.keys(h || {}).forEach((k) => {
    const lk = k.toLowerCase();
    const sensitive =
      lk === 'authorization' ||
      lk.indexOf('x-lingee-openapi-signature') === 0 ||
      lk.indexOf('x-lingee-openapi-nonce') === 0 ||
      lk === 'cookie';
    out[k] = sensitive ? maskSecret(h[k]) : h[k];
  });
  return out;
}

/** 落盘用的响应体：JSON 里的 access_token / secret 打码；非 JSON 原样保留。 */
function scrubBody(text) {
  try {
    const o = JSON.parse(text);
    maskDeep(o);
    return JSON.stringify(o);
  } catch (e) {
    return String(text)
      .replace(/("access_token"\s*:\s*")[^"]*(")/gi, '$1••••••$2')
      .replace(/("(?:app_secret|secret|token)"\s*:\s*")[^"]*(")/gi, '$1••••••$2');
  }
}

function labelFor(method, path) {
  if (path.indexOf('access-tokens') >= 0) return '签发令牌';
  if (path.indexOf('/event') >= 0) return '建立 SSE';
  if (/\/session$/.test(path)) return '创建会话';
  if (path.indexOf('/chat') >= 0) return '发起对话';
  if (path.indexOf('/task/') >= 0) return '轮询结果';
  if (path.indexOf('/stop') >= 0) return '停止会话';
  if (path.indexOf('/artifact/') >= 0) return '下载产物';
  if (path.indexOf('/inbox') >= 0) return '上传附件';
  if (path.indexOf('/models') >= 0) return '模型列表';
  if (path.indexOf('/tools') >= 0) return '工具列表';
  if (path.indexOf('/agents') >= 0) return '智能体列表';
  return method + ' 请求';
}

function categoryOf(path) {
  if (path.indexOf('access-tokens') >= 0) return 'auth';
  if (path.indexOf('/event') >= 0) return 'sse';
  if (path.indexOf('/chat') >= 0 || path.indexOf('/task/') >= 0 || path.indexOf('/stop') >= 0) return 'chat';
  if (/models|tools|agents|skills/.test(path)) return 'res';
  if (path.indexOf('/session') >= 0) return 'session';
  return 'other';
}

export class DebugBoard {
  constructor({ load, save }) {
    this.load = load;
    this.save = save;
    this.entries = [];
    this.seq = 0;
    this.open = false;
    this.showSecrets = false;
    this.scope = 'current';
    this.cat = 'all';
    this.query = '';
    this._timer = null;
    this._restore();
  }

  _restore() {
    try {
      const arr = this.load() || [];
      const cutoff = Date.now() - TTL;
      this.entries = arr
        .filter((r) => r && r.startedAt && r.startedAt > cutoff)
        .map((r) => Object.assign({}, r, {
          reqHeaders: scrubHeaders(r.reqHeaders),
          reqBody: r.reqBody ? scrubBody(String(r.reqBody)) : null,
          resBody: r.resBody ? scrubBody(String(r.resBody)) : null,
        }));
      this.entries.forEach((r) => {
        if (r.id > this.seq) this.seq = r.id;
      });
    } catch (e) {
      this.entries = [];
    }
  }

  start(rec) {
    const now = Date.now();
    const entry = Object.assign(
      {
        id: ++this.seq,
        startedAt: now,
        status: null,
        resBody: null,
        duration: null,
        error: null,
        done: false,
        open: false,
        sse: null,
        stream: false,
      },
      rec
    );
    if (!entry.label) entry.label = labelFor(entry.method || 'GET', entry.path || '');
    if (entry.sessionId === undefined) entry.sessionId = '';
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) this.entries = this.entries.slice(-MAX_ENTRIES);
    this._schedule();
    return entry.id;
  }

  update(id, patch) {
    const rec = this._find(id);
    if (!rec) return;
    Object.assign(rec, patch);
    if (rec.done && rec.duration === null && rec.startedAt) {
      rec.duration = Date.now() - rec.startedAt;
    }
    this._schedule();
  }

  trackSSE(id, stats) {
    const rec = this._find(id);
    if (!rec || !stats) return;
    rec.sse = {
      count: stats.count,
      first: stats.first,
      last: stats.last,
      firstDelta: stats.firstDelta || 0,
      lastDelta: stats.lastDelta || 0,
      types: Object.assign({}, stats.types),
    };
    rec.resBody = this._sseSummary(rec.sse);
    rec.done = true;
    if (rec.duration === null) rec.duration = Date.now() - rec.startedAt;
    this._schedule();
  }

  bindSession(fromSeq, sessionId) {
    let changed = false;
    this.entries.forEach((r) => {
      if (!r.sessionId && r.id > fromSeq) {
        r.sessionId = sessionId;
        changed = true;
      }
    });
    if (changed) this._schedule();
  }

  clear() {
    this.entries = [];
    this._schedule(true);
  }

  _find(id) {
    return this.entries.find((r) => r.id === id) || null;
  }

  _sseSummary(s) {
    const types = Object.keys(s.types || {})
      .map((k) => k + ' ×' + s.types[k])
      .join('，');
    const deltas = (s.types && s.types['message.part.delta']) || 0;
    const hasDelta = s.firstDelta && s.lastDelta;
    const span = hasDelta ? s.lastDelta - s.firstDelta : (s.last || 0) - (s.first || 0);
    const basis = hasDelta ? '首→末增量' : '首→末事件';
    let verdict = '';
    if (hasDelta && deltas > 1) {
      verdict =
        span < 150
          ? '\n⚠ 全部增量在 ' + span + 'ms 内到达，疑似服务端批量下发'
          : '\n增量跨度 ' + span + 'ms，属于逐条流式';
    }
    return '事件数 ' + s.count + '（增量 ' + deltas + '）\n' + basis + ' ' + span + ' ms' + verdict + '\n类型：' + types;
  }

  _schedule(immediate) {
    if (immediate) {
      clearTimeout(this._dirtyTimer);
      this._dirtyTimer = null;
      this._flush();
      return;
    }
    if (this._dirtyTimer) return;
    this._dirtyTimer = setTimeout(() => {
      this._dirtyTimer = null;
      this._flush();
    }, 320);
  }

  _flush() {
    try {
      const slim = this.entries.slice(-MAX_ENTRIES).map((r) => ({
        id: r.id,
        label: r.label,
        method: r.method,
        path: r.path,
        url: r.url,
        // 落盘前强制打码，避免令牌/签名进入 localStorage
        reqHeaders: scrubHeaders(r.reqHeaders),
        reqBody: r.reqBody ? scrubBody(String(r.reqBody).slice(0, 6000)) : null,
        startedAt: r.startedAt,
        status: r.status,
        duration: r.duration,
        error: r.error,
        resBody: r.resBody ? scrubBody(String(r.resBody).slice(0, 6000)) : null,
        done: !!r.done,
        sessionId: r.sessionId || '',
        sse: r.sse || null,
        stream: !!r.stream,
      }));
      this.save(slim);
    } catch (e) { /* 配额问题忽略 */ }
    if (this._onChange) this._onChange();
  }

  onChange(fn) {
    this._onChange = fn;
  }

  /* ---------------- 渲染 ---------------- */

  view(activeSessionId) {
    const q = this.query.trim().toLowerCase();
    return this.entries.filter((r) => {
      if (this.scope === 'current' && activeSessionId) {
        if ((r.sessionId || '') !== activeSessionId) return false;
      }
      if (this.cat !== 'all' && categoryOf(r.path || '') !== this.cat) return false;
      if (q) {
        const hay = [r.label, r.path, r.url, r.error, r.resBody, r.reqBody].join(' ').toLowerCase();
        if (hay.indexOf(q) < 0) return false;
      }
      return true;
    });
  }

  render({ listEl, subEl, countEl, activeSessionId }) {
    if (!listEl) return;
    const view = this.view(activeSessionId);
    if (countEl) countEl.textContent = String(view.length);
    if (subEl) {
      const total = this.entries.length;
      subEl.textContent = total
        ? view.length + ' / ' + total + ' 条 · ' + (this.scope === 'current' && activeSessionId ? '当前会话' : '全部会话')
        : '尚无请求';
    }
    if (!view.length) {
      listEl.innerHTML =
        '<div class="dempty">' +
        (this.entries.length
          ? '当前筛选下没有记录。切换范围或清空搜索再看看。'
          : '还没有请求。发一次对话后，这里会按顺序列出签发令牌、创建会话、建立 SSE、发起对话等每一步的输入与输出。') +
        '</div>';
      return;
    }
    const atBottom = listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 80;
    listEl.innerHTML = view
      .map((rec) => {
        const stCls = rec.error ? 'err' : rec.done ? (rec.status >= 200 && rec.status < 300 ? 'ok' : 'err') : 'wait';
        const stTxt = rec.error ? 'ERR' : rec.status || (rec.stream ? 'SSE' : '…');
        const dur = rec.error ? '失败' : rec.duration != null ? rec.duration + ' ms' : '进行中';
        const head =
          '<summary><div class="dline1">' +
          '<span class="st ' + stCls + '">' + esc(stTxt) + '</span>' +
          '<span class="mth">' + esc(rec.method || 'GET') + '</span>' +
          '<span class="lbl">' + esc(rec.label) + '</span>' +
          '<span class="ms">' + esc(dur) + '</span>' +
          '</div><div class="dline2">' + esc(rec.path || '') + '</div></summary>';

        let body = '<div class="dbox">' +
          '<div class="dsec">请求地址</div><div class="dpre">' + esc(rec.url || '') + '</div>' +
          '<div class="dsec">会话</div><div class="dpre">' + esc(rec.sessionId || '（尚未绑定会话）') + '</div>' +
          '<div class="dsec">请求头</div><div class="dpre">' + esc(JSON.stringify(this.displayHeaders(rec.reqHeaders), null, 2)) + '</div>';
        if (rec.reqBody) {
          body += '<div class="dsec">请求体</div><div class="dpre">' + esc(this.displayBody(rec.reqBody)) + '</div>';
        }
        body +=
          '<div class="dsec">响应' + (rec.error ? '（异常）' : '') + '</div><div class="dpre">' +
          esc(rec.error ? rec.error : this.displayBody(rec.resBody)) +
          '</div>' +
          '<div class="dact"><button type="button" class="mini-btn wide" data-copy-curl="' + rec.id + '">复制 cURL</button></div>' +
          '</div>';
        return (
          '<details class="ditem" data-id="' + rec.id + '"' + (rec.open ? ' open' : '') + '>' +
          head + body + '</details>'
        );
      })
      .join('');

    listEl.querySelectorAll('details.ditem').forEach((d) => {
      d.addEventListener('toggle', () => {
        const rec = this._find(Number(d.dataset.id));
        if (rec) rec.open = d.open;
      });
    });
    listEl.querySelectorAll('[data-copy-curl]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const rec = this._find(Number(btn.dataset.copyCurl));
        if (rec) this._copyCurl(rec, btn);
      });
    });
    if (this.open && atBottom) listEl.scrollTop = listEl.scrollHeight;
  }

  displayHeaders(h) {
    const out = {};
    Object.keys(h || {}).forEach((k) => {
      const v = h[k];
      const lk = k.toLowerCase();
      const sensitive =
        lk === 'authorization' ||
        lk.indexOf('x-lingee-openapi-signature') === 0 ||
        lk.indexOf('x-lingee-openapi-nonce') === 0 ||
        lk === 'cookie';
      out[k] = !this.showSecrets && sensitive ? maskSecret(v) : v;
    });
    return out;
  }

  displayBody(text) {
    if (text === null || text === undefined || text === '') return '（空）';
    const s = String(text);
    try {
      const o = JSON.parse(s);
      if (!this.showSecrets) maskDeep(o);
      return JSON.stringify(o, null, 2);
    } catch (e) {
      return s.length > 6000 ? s.slice(0, 6000) + '\n…（已截断）' : s;
    }
  }

  _copyCurl(rec, btn) {
    const headers = this.displayHeaders(rec.reqHeaders);
    const lines = ['curl --request ' + (rec.method || 'GET') + ' \\', "  '" + rec.url + "'"];
    Object.keys(headers).forEach((k) => {
      lines.push("  --header '" + k + ': ' + String(headers[k]).replace(/'/g, "'\\''") + "' \\");
    });
    if (rec.reqBody) {
      lines.push("  --data-raw '" + String(rec.reqBody).replace(/'/g, "'\\''") + "'");
    }
    const text = lines.join('\n').replace(/ \\\n?$/, '');
    const done = () => {
      btn.textContent = '已复制';
      setTimeout(() => {
        btn.textContent = '复制 cURL';
      }, 1400);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, done);
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
      } catch (e) { /* ignore */ }
      document.body.removeChild(ta);
      done();
    }
  }
}