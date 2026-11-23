/* API 客户端：令牌签发（HMAC）、Bearer 请求、错误分类、401 重签、单飞。 */

import { hmacSha256Hex, newRequestId, randomHex, sha256Hex } from './crypto.js';

const SERVED = /^https?:$/.test(location.protocol);
/* 应用根路径。部署在子路径（如 /lingee-debug/）时，接口前缀随之为 /lingee-debug/api；
 * 部署在站点根或独立域名时为 /api。由当前模块 URL 推导，无需按环境改代码。 */
const APP_BASE = SERVED ? new URL('../', import.meta.url).pathname : '/';

export class ApiError extends Error {
  constructor(code, message, opts = {}) {
    super(message || code || '请求失败');
    this.name = 'ApiError';
    this.code = String(code || '');
    this.status = opts.status || 0;
    this.retryAfter = opts.retryAfter || 0;
    this.isNet = !!opts.isNet;
    this.url = opts.url || '';
  }
}

export const TOKEN_PATH = '/console/openapi/v1/access-tokens';

const TOKEN_HINTS = {
  '5001233062': '验签失败。核对 App Secret（是否已重置）、租户与应用是否一致、请求体是否被改动。',
  '5001233063': '时间戳超出 ±300 秒。检查本机系统时间是否准确。',
  '5001233064': 'Nonce 重复。重试即可，本应用每次都会生成新 Nonce。',
  '5001233075': '代理模式与用户参数不匹配。固定用户不要带 subject；白名单用户须带 subject_type + subject（erp_user 还需 data_center_id）。',
  '5001233065': '应用未启用。到控制台确认应用状态为「启用」。',
  '5001233066': '来源 IP 不在白名单。报备当前出口 IP，或在应用里放宽 IP/CIDR。',
  '5001233071': '接口未授权。在应用「接口授权」里勾选签发接口，或选择「全部接口」。',
  '5001233083': '触发签发限流。同一 appId+IP 每分钟 30 次、同一 appId+用户每分钟 5 次，稍等再试。',
  '5001233081': '鉴权/数据源服务暂不可用，稍后重试。',
  'PROXY_ERROR': '本地服务没能连上目标环境。检查网络/VPN，以及「服务地址」是否写对。',
};

export function tokenHint(code) {
  return TOKEN_HINTS[code] || '';
}

export function explainError(err) {
  const code = err && err.code ? String(err.code) : '';
  const map = {
    '5001093001': 'SSE 路由未注册。已自动重连通道，若仍失败请检查网络后重试。',
    '5001303001': '该会话已有正在运行的任务。稍等它结束，或先停止再发。',
    '5001303003': '租户并发执行数已达上限，已进入排队。',
    '5001053001': '会话不存在或不属于当前用户，可能换了代理用户或服务环境。',
    '5001053004': '会话已归档，不能再发消息，请新建会话。',
    '5001033010': '智能体不可用/未授权/对当前用户不可见，换一个智能体或留空。',
    '5001143001': '本轮 tools 中的工具未激活或未授权。检查工具选择，或改为不指定。',
    '5001023029': '技能不可用或未授权。',
    '5001043005': '模型 ID 不是三段格式，请从模型列表里重新选择。',
    '5001233082': 'Token 无效或过期（或混用了凭证）。已尝试重新签发。',
    '5001003001': '缺少必填参数。',
    '5001003002': '参数格式或长度不合法。',
    'NET': '请求没有送达。确认本地服务仍在运行、服务地址正确、网络可达。',
  };
  if (err && err.isNet) return map.NET;
  return map[code] || TOKEN_HINTS[code] || '';
}

export class ApiClient {
  /**
   * @param {object} opts
   * @param {() => object} opts.getCfg
   * @param {object} [opts.logger]  { start(rec)->id, update(id, patch), trackSSE(id,type) }
   */
  constructor({ getCfg, logger }) {
    this.getCfg = getCfg;
    this.logger = logger || null;
    this.token = '';
    this.tokenExp = 0;
    this._pendingToken = null;
    this._envSig = '';
    this.onTokenChange = null;
    this.syncEnv();
  }

  /** 环境（base/tenant/appId/用户）变化时作废旧令牌。 */
  syncEnv() {
    const c = this.getCfg() || {};
    const sig = [c.base, c.tenant, c.appId, c.mode, c.subType, c.subject].join('|');
    if (sig !== this._envSig) {
      if (this._envSig) this._clearToken();
      this._envSig = sig;
      this._restoreToken(sig);
    }
  }

  _restoreToken(sig) {
    try {
      const j = JSON.parse(sessionStorage.getItem('lg.token.v1') || 'null');
      if (j && j.sig === sig && j.token && j.exp > Date.now() + 30000) {
        this.token = j.token;
        this.tokenExp = j.exp;
      }
    } catch (e) { /* ignore */ }
  }

  _persistToken() {
    try {
      sessionStorage.setItem(
        'lg.token.v1',
        JSON.stringify({ token: this.token, exp: this.tokenExp, sig: this._envSig })
      );
    } catch (e) { /* ignore */ }
  }

  _clearToken() {
    this.token = '';
    this.tokenExp = 0;
    try {
      sessionStorage.removeItem('lg.token.v1');
    } catch (e) { /* ignore */ }
  }

  get base() {
    return String((this.getCfg() || {}).base || '').replace(/\/+$/, '');
  }

  tokenState() {
    const left = Math.max(0, this.tokenExp - Date.now());
    return {
      token: this.token,
      exp: this.tokenExp,
      valid: !!this.token && left > 60000,
      left,
      expiresIn: Math.round(left / 1000),
    };
  }

  _url(path, query) {
    let qs = '';
    if (query) {
      const clean = {};
      Object.keys(query).forEach((k) => {
        if (query[k] !== undefined && query[k] !== null && query[k] !== '') clean[k] = query[k];
      });
      qs = '?' + new URLSearchParams(clean).toString();
    }
    return (SERVED ? APP_BASE + 'api' + path : this.base + path) + qs;
  }

  _baseHeaders(extra) {
    const h = Object.assign({}, extra || {});
    if (SERVED && this.base) h['X-Target'] = this.base;
    return h;
  }

  async _fetchJSON(method, path, { query, body, headers, stream, signal, label, sessionId } = {}) {
    const url = this._url(path, query);
    const reqHeaders = this._baseHeaders(headers || {});
    const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
    const reqBody = body === undefined ? null : isForm ? null : typeof body === 'string' ? body : JSON.stringify(body);
    const logId = this.logger
      ? this.logger.start({
          // 不传 label 时交给调试看板按路径推导中文名（签发令牌 / 发起对话 / 轮询结果…）
          label: label || undefined,
          method,
          path,
          url,
          reqHeaders,
          reqBody: isForm ? '（multipart/form-data）' : reqBody,
          sessionId: sessionId || '',
          stream: !!stream,
        })
      : null;

    let res;
    try {
      res = await fetch(url, {
        method,
        headers: reqHeaders,
        body: reqBody === null ? undefined : reqBody,
        signal,
        cache: 'no-store',
      });
    } catch (e) {
      if (e && e.name === 'AbortError') {
        if (logId && this.logger) this.logger.update(logId, { error: '（已取消）', done: true });
        throw e;
      }
      const err = new ApiError('NET', '请求未能送达（' + (e && e.message ? e.message : '网络错误') + '）', {
        isNet: true,
        url,
      });
      if (logId && this.logger) this.logger.update(logId, { error: err.message, done: true });
      throw err;
    }

    if (stream) {
      if (logId && this.logger) {
        this.logger.update(logId, { status: res.status, stream: true, resBody: '（text/event-stream，事件见统计）' });
      }
      return { res, json: null, logId };
    }

    let text = '';
    try {
      text = await res.text();
    } catch (e) {
      text = '';
    }
    let json = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch (e) {
      json = { code: 'HTTP_' + res.status, message: text.slice(0, 300) };
    }

    if (logId && this.logger) {
      this.logger.update(logId, { status: res.status, resBody: text, done: true });
    }

    const retryAfter = Number(res.headers.get('Retry-After') || 0) || 0;
    if (json && json.code !== undefined && String(json.code) !== '0') {
      throw new ApiError(json.code || 'HTTP_' + res.status, json.message || 'HTTP ' + res.status, {
        status: res.status,
        retryAfter,
        url,
      });
    }
    return { res, json, data: json ? json.data : undefined, retryAfter, logId };
  }

  /* ---------------- 令牌 ---------------- */

  async issueToken() {
    this.syncEnv();
    const c = this.getCfg() || {};
    if (!this.base || !c.appId || !c.secret || !c.tenant) {
      throw new ApiError('CONFIG', '请先在连接设置里填写服务地址、App ID、App Secret 与租户');
    }
    const payload = { tenant_id: c.tenant };
    if (c.mode === 'HEADER_USER') {
      if (!c.subject) throw new ApiError('CONFIG', '白名单用户模式必须填写用户标识');
      payload.subject_type = c.subType;
      payload.subject = c.subject;
      if (c.subType === 'erp_user') {
        if (!c.dcId) throw new ApiError('CONFIG', 'erp_user 模式必须填写 data_center_id');
        payload.data_center_id = c.dcId;
      }
    }
    const body = JSON.stringify(payload);
    const ts = String(Date.now());
    const nonce = randomHex(16);
    const rid = newRequestId();
    const hash = sha256Hex(body);
    const canonical = ['v1', 'POST', TOKEN_PATH, '', c.appId, ts, nonce, rid, '', hash].join('\n');
    const sig = hmacSha256Hex(c.secret, canonical);

    const { data } = await this._fetchJSON('POST', TOKEN_PATH, {
      body,
      label: '签发令牌',
      headers: {
        'Content-Type': 'application/json',
        'X-Tenant-Id': c.tenant,
        'X-Lingee-OpenApi-App-Id': c.appId,
        'X-Lingee-OpenApi-Timestamp': ts,
        'X-Lingee-OpenApi-Nonce': nonce,
        'X-Lingee-OpenApi-Signature': sig,
        'Request-Id': rid,
      },
    });

    if (!data || !data.access_token) throw new ApiError('TOKEN', '签发响应缺少 data.access_token');
    this.token = data.access_token;
    this.tokenExp = Date.now() + (Number(data.expires_in) || 7200) * 1000;
    this._persistToken();
    if (this.onTokenChange) this.onTokenChange(this.tokenState());
    return data;
  }

  async ensureToken(force = false) {
    this.syncEnv();
    const st = this.tokenState();
    if (!force && st.valid) return this.token;
    if (this._pendingToken) return this._pendingToken;
    this._pendingToken = this.issueToken().finally(() => {
      this._pendingToken = null;
    });
    return this._pendingToken;
  }

  _authHeaders(extra) {
    const c = this.getCfg() || {};
    return this._baseHeaders(
      Object.assign(
        {
          Authorization: 'Bearer ' + this.token,
          'X-Tenant-Id': c.tenant || '',
          'Request-Id': newRequestId(),
        },
        extra || {}
      )
    );
  }

  /** 通用 Bearer 请求：401 时重签一次并重试。 */
  async request(method, path, opts = {}) {
    await this.ensureToken();
    const headers = this._authHeaders(opts.headers);
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    try {
      return await this._fetchJSON(method, path, Object.assign({}, opts, { headers }));
    } catch (e) {
      const authFail = e && (e.status === 401 || e.code === '5001233082');
      if (authFail && opts.retry !== false) {
        this._clearToken();
        await this.ensureToken(true);
        return this.request(method, path, Object.assign({}, opts, { retry: false }));
      }
      throw e;
    }
  }

  /* ---------------- 业务接口 ---------------- */

  async createSession(externalRef, opts = {}) {
    const body = externalRef ? { external_ref: externalRef } : {};
    const { data } = await this.request('POST', '/work/openapi/v1/session', Object.assign({ body }, opts));
    return data || {};
  }

  /**
   * 发起异步对话。event_id 必须与已建立的 SSE 通道一致。
   * 返回 { data, retryAfter }。
   */
  async chat({ sessionId, eventId, query, model, assistantId, tools, skills, inboxs, externalRef }, opts = {}) {
    const body = { query, session_id: sessionId };
    if (model) body.model = model;
    if (assistantId) body.assistant_id = assistantId;
    if (Array.isArray(tools) && tools.length) body.tools = tools;
    if (Array.isArray(skills) && skills.length) body.skill_names = skills;
    if (Array.isArray(inboxs) && inboxs.length) body.inboxs = inboxs;
    if (externalRef) body.external_ref = externalRef;
    const { data, retryAfter } = await this.request('POST', '/work/openapi/v1/chat', Object.assign({
      query: { event_id: eventId },
      body,
    }, opts));
    return { data: data || {}, retryAfter };
  }

  async pollTask(taskId, { toolCalls = true, reasoning = true, todo = false } = {}, opts = {}) {
    const { data, retryAfter, res } = await this.request(
      'GET',
      '/work/openapi/v1/task/' + encodeURIComponent(taskId),
      Object.assign({
        query: {
          tool_calls: toolCalls ? 'true' : 'false',
          reasoning: reasoning ? 'true' : 'false',
          todo: todo ? 'true' : 'false',
        },
      }, opts)
    );
    return { data: data || {}, retryAfter, httpStatus: res ? res.status : 200 };
  }

  async stopSession(sessionId, opts = {}) {
    const { data } = await this.request('POST', '/work/openapi/v1/session/' + encodeURIComponent(sessionId) + '/stop', opts);
    return data || {};
  }

  async uploadInbox(sessionId, files, opts = {}) {
    await this.ensureToken();
    const form = new FormData();
    Array.from(files).forEach((f) => form.append('files', f, f.name));
    const { data } = await this._fetchJSON('POST', '/work/openapi/v1/session/' + encodeURIComponent(sessionId) + '/inbox', Object.assign({
      body: form,
      headers: this._authHeaders({}),
    }, opts));
    return data || [];
  }

  artifactUrl(sessionId, artifactId) {
    return this._url('/work/openapi/v1/session/' + encodeURIComponent(sessionId) + '/artifact/' + encodeURIComponent(artifactId));
  }

  /** 产物是二进制且需要 Bearer，用 fetch 取回后转 blob URL。 */
  async downloadArtifact(sessionId, artifactId) {
    await this.ensureToken();
    const res = await fetch(this.artifactUrl(sessionId, artifactId), {
      headers: this._authHeaders({}),
      cache: 'no-store',
    });
    if (!res.ok) {
      let msg = 'HTTP ' + res.status;
      try {
        const t = await res.text();
        const j = JSON.parse(t);
        msg = j.message || msg;
      } catch (e) { /* ignore */ }
      throw new ApiError('ARTIFACT', msg, { status: res.status });
    }
    const blob = await res.blob();
    return URL.createObjectURL(blob);
  }
}

export { SERVED };