/* SSE 解析与通道：fetch 流式读取（可带 Authorization）、自动重连、空闲看门狗。 */

/**
 * 按 SSE 规范解析事件块：
 *  - 行以 \n 结束（内部先归一化 \r\n / \r）
 *  - 空行分隔事件；多行 data: 以 \n 拼接
 *  - 注释行（: 开头）、event:/retry:/id: 不参与数据
 *  - 事件类型只看 JSON 的 type 字段（灵基规范不依赖 event: 行）
 */
export function createSSEParser(onEvent) {
  let buf = '';
  return {
    push(chunk) {
      buf += chunk;
      buf = buf.replace(/\r\n?/g, '\n');
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        emitBlock(block, onEvent);
      }
    },
    flush() {
      if (!buf.trim()) return;
      emitBlock(buf, onEvent);
      buf = '';
    },
  };
}

function emitBlock(block, onEvent) {
  const data = [];
  let eventName = '';
  for (const rawLine of block.split('\n')) {
    const line = rawLine.replace(/^﻿/, '');
    if (!line || line.startsWith(':')) continue;
    const i = line.indexOf(':');
    const field = i < 0 ? line : line.slice(0, i);
    let value = i < 0 ? '' : line.slice(i + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') data.push(value);
    else if (field === 'event') eventName = value;
  }
  if (!data.length) return;
  const text = data.join('\n');
  let ev;
  try {
    ev = JSON.parse(text);
  } catch (e) {
    // 非 JSON 的 data（例如服务端保活文本）直接忽略
    return;
  }
  if (ev && typeof ev === 'object') onEvent(ev, eventName);
}

export class SSEChannel {
  /**
   * @param {object} opts
   * @param {() => string} opts.url
   * @param {() => Promise<object>|object} opts.headersProvider  每次建连前取一次（可刷新 token）
   * @param {(ev:object)=>void} opts.onEvent
   * @param {(state:string, detail:object)=>void} [opts.onState]
   * @param {number} [opts.idleTimeout=45000]  多久没有事件视为假死
   * @param {number} [opts.maxRetryDelay=15000]
   */
  constructor(opts) {
    this.opts = opts;
    this.state = 'idle';
    this.attempt = 0;
    this.lastEventAt = 0;
    this.stats = { count: 0, first: 0, last: 0, types: {} };
    this.closedByUser = false;
    this._abort = null;
    this._retryTimer = null;
    this._idleTimer = null;
    this._waiters = [];
    this._loopPromise = null;
    this._gen = 0;
  }

  get isOpen() {
    return this.state === 'open';
  }

  /** 等待连接就绪；超时返回 false。 */
  waitOpen(timeoutMs = 8000) {
    if (this.state === 'open') return Promise.resolve(true);
    return new Promise((resolve) => {
      const w = { resolve, timer: null };
      w.timer = setTimeout(() => {
        this._waiters = this._waiters.filter((x) => x !== w);
        resolve(false);
      }, timeoutMs);
      this._waiters.push(w);
    });
  }

  /** 打开（或在已打开时复用）。 */
  async open(timeoutMs = 8000) {
    if (this.state === 'open') return true;
    if (this.state === 'idle' || this.state === 'error' || this.state === 'closed') {
      this.closedByUser = false;
      this.attempt = 0;
      this._gen++;
      this._loopPromise = null;
      this._startLoop();
    }
    return this.waitOpen(timeoutMs);
  }

  /** 强制断开并重新建连（用于 5001093001 等可恢复失败）。 */
  restart(timeoutMs = 8000) {
    this._abortCurrent();
    clearTimeout(this._retryTimer);
    clearTimeout(this._idleTimer);
    this._retryTimer = null;
    this._idleTimer = null;
    this.closedByUser = false;
    this.attempt = 0;
    this._gen++;
    this._loopPromise = null;
    this._setState('connecting', { reason: 'restart' });
    this._startLoop();
    return this.waitOpen(timeoutMs);
  }

  close() {
    this.closedByUser = true;
    this._gen++;
    this._loopPromise = null;
    this._abortCurrent();
    clearTimeout(this._retryTimer);
    clearTimeout(this._idleTimer);
    this._retryTimer = null;
    this._idleTimer = null;
    this._settleWaiters(false);
    this._setState('closed', {});
  }

  _startLoop() {
    if (this._loopPromise) return;
    const gen = ++this._gen;
    this._setState('connecting', {});
    this._loopPromise = this._connectLoop(gen).finally(() => {
      if (this._gen === gen) this._loopPromise = null;
    });
  }

  async _connectLoop(gen) {
    if (this.closedByUser || gen !== this._gen) return;
    let res;
    try {
      const headers = await this.opts.headersProvider();
      const ctrl = new AbortController();
      this._abort = ctrl;
      res = await fetch(this.opts.url(), {
        method: 'GET',
        headers,
        signal: ctrl.signal,
        cache: 'no-store',
        credentials: 'omit',
      });
    } catch (e) {
      if (this.closedByUser || (e && e.name === 'AbortError')) return;
      if (gen !== this._gen) return;
      this._scheduleReconnect('网络错误：' + (e && e.message ? e.message : ''));
      return;
    }

    if (gen !== this._gen) return;

    if (res.status === 401) {
      this._setState('auth', { status: 401 });
      this._settleWaiters(false);
      return;
    }
    if (!res.ok) {
      let body = '';
      try {
        body = (await res.text()).slice(0, 200);
      } catch (e) { /* ignore */ }
      this._scheduleReconnect('HTTP ' + res.status + (body ? '：' + body : ''));
      return;
    }
    if (!res.body) {
      this._scheduleReconnect('当前浏览器不支持流式响应');
      return;
    }

    this._setState('connecting', {});
    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    const parser = createSSEParser((ev) => this._handleEvent(ev));
    this._armIdle();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          this.lastEventAt = Date.now();
          this._armIdle();
          parser.push(decoder.decode(value, { stream: true }));
        }
      }
      parser.flush();
    } catch (e) {
      if (this.closedByUser || (e && e.name === 'AbortError')) return;
      if (gen !== this._gen) return;
      this._scheduleReconnect('读取中断：' + (e && e.message ? e.message : ''));
      return;
    }

    if (!this.closedByUser && gen === this._gen) this._scheduleReconnect('连接已结束');
  }

  _handleEvent(ev) {
    const type = ev && ev.type ? ev.type : 'unknown';
    this.stats.count++;
    if (!this.stats.first) this.stats.first = Date.now();
    this.stats.last = Date.now();
    this.stats.types[type] = (this.stats.types[type] || 0) + 1;
    if (type === 'message.part.delta') {
      if (!this.stats.firstDelta) this.stats.firstDelta = Date.now();
      this.stats.lastDelta = Date.now();
    }

    if (type === 'server.connected') {
      this.attempt = 0;
      this._setState('open', {});
      this._settleWaiters(true);
    }
    try {
      this.opts.onEvent(ev);
    } catch (e) {
      // 单个事件处理异常不应打断整条流
      console.warn('[sse] event handler error', e);
    }
  }

  _armIdle() {
    clearTimeout(this._idleTimer);
    const ms = this.opts.idleTimeout || 45000;
    this._idleTimer = setTimeout(() => {
      if (this.closedByUser) return;
      this._abortCurrent();
      this._scheduleReconnect('空闲超时（' + Math.round(ms / 1000) + 's 无事件）');
    }, ms);
  }

  _abortCurrent() {
    if (this._abort) {
      try {
        this._abort.abort();
      } catch (e) { /* ignore */ }
      this._abort = null;
    }
  }

  _scheduleReconnect(reason) {
    if (this.closedByUser) return;
    clearTimeout(this._idleTimer);
    this._idleTimer = null;
    this._abortCurrent();
    this.attempt++;
    const base = 1000 * Math.pow(2, Math.min(this.attempt - 1, 4));
    const delay = Math.min(this.opts.maxRetryDelay || 15000, base);
    this._setState('retrying', { attempt: this.attempt, delay, reason });
    clearTimeout(this._retryTimer);
    this._retryTimer = setTimeout(() => this._startLoop(), delay);
  }

  _settleWaiters(ok) {
    const list = this._waiters;
    this._waiters = [];
    list.forEach((w) => {
      clearTimeout(w.timer);
      w.resolve(ok);
    });
  }

  _setState(state, detail) {
    this.state = state;
    if (this.opts.onState) {
      try {
        this.opts.onState(state, detail || {});
      } catch (e) {
        console.warn('[sse] state handler error', e);
      }
    }
  }
}