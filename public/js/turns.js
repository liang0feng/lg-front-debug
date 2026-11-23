/* 轮次引擎：按会话隔离的 SSE 通道 + 轮次注册表 + 事件驱动的轮询兜底 + 并发调度。
 *
 * 设计要点：
 *  - 锁在会话上，不在应用上；不同会话可并行。
 *  - 切换会话不关通道、不丢轮次；后台继续收流。
 *  - 轮询只在「SSE 静默 5s / 通道断线 / 缺终态」时启动，不并跑。
 *  - session.idle / session.status(idle) 可重复，统一以 turn.finished 幂等收尾。
 */

import { SSEChannel } from './sse.js';
import { newEventId } from './crypto.js';
import { explainError } from './api.js';
import { saveSession } from './store.js';

const MAX_CHANNELS = 6;
const FAST_POLL_DELAYS = [2000, 3000, 4500, 6000, 9000, 13000, 20000];
const SLOW_POLL_DELAY = 30000;
const POLL_GIVE_UP_MS = 5 * 60 * 1000;

let seq = 0;
function uid(prefix) {
  seq++;
  return prefix + '_' + Date.now().toString(36) + seq.toString(36);
}

function titleFrom(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, 30) : '新会话';
}

const TERMINAL = { completed: 1, failed: 1, expired: 1, stopped: 1 };

export class TurnEngine {
  constructor(opts) {
    this.api = opts.api;
    this.onSessionChange = opts.onSessionChange || function () {};
    this.onTurnChange = opts.onTurnChange || function () {};
    this.onSessionIdChange = opts.onSessionIdChange || function () {};
    this.onNotice = opts.onNotice || function () {};
    this.getActiveId = opts.getActiveId || function () { return ''; };
    this.maxConcurrent = opts.maxConcurrent || 3;
    this.runtimes = new Map();
    this.queue = [];
    this.active = 0;
    this.recording = false;
  }

  /** 记录后续 SSE 原始事件（仅内存）。 */
  setRecording(on) {
    this.recording = !!on;
  }

  getSSELogText(sessionId) {
    const rts = Array.from(this.runtimes.values())
      .filter((rt) => rt.sseLog && rt.sseLog.length && (!sessionId || rt.sid === sessionId))
      .sort((a, b) => a.sseLog[0].t - b.sseLog[0].t);
    const lines = ['# 灵基对话台 · SSE 原始事件', '# ' + new Date().toISOString(), ''];
    let count = 0;
    rts.forEach((rt) => {
      const t0 = rt.sseLog[0].t;
      lines.push(
        '# --- session=' + rt.sid + ' event_id=' + (rt.eventId || '') + ' events=' + rt.sseLog.length + ' ---'
      );
      rt.sseLog.forEach((x) => {
        lines.push(': +' + (x.t - t0) + 'ms');
        lines.push('data: ' + JSON.stringify(x.ev));
        count++;
      });
      lines.push('');
    });
    return { text: lines.join('\n'), count, sessions: rts.length };
  }

  clearSSELog(sessionId) {
    this.runtimes.forEach((rt) => {
      if (!sessionId || rt.sid === sessionId) rt.sseLog = [];
    });
  }

  /* ---------------- 运行时 ---------------- */

  attach(session) {
    let rt = this.runtimes.get(session.id);
    if (rt) {
      rt.session = session;
      return rt;
    }
    rt = {
      sid: session.id,
      session,
      channel: null,
      channelState: 'idle',
      eventId: '',
      turn: null,
      queued: null,
      queuePos: 0,
      persistTimer: null,
      authRetried: false,
      lastAssistantMsgIds: new Set(),
      lastAssistantMsgId: '',
    };
    this.runtimes.set(session.id, rt);
    return rt;
  }

  detach(sessionId) {
    const rt = this.runtimes.get(sessionId);
    if (!rt) return;
    if (rt.channel) rt.channel.close();
    if (rt.turn) {
      this._clearTimers(rt.turn);
      rt.turn.finished = true;
      if (rt.turn.paintTimer) clearTimeout(rt.turn.paintTimer);
    }
    clearTimeout(rt.persistTimer);
    const hadTurn = !!rt.turn;
    const wasQueued = !!rt.queued;
    this.runtimes.delete(sessionId);
    this.queue = this.queue.filter((x) => x !== rt);
    if (hadTurn) {
      this._release(rt.turn);
    } else if (wasQueued) {
      this.onSessionChange(rt.sid, 'queue-cancel');
    }
  }

  stateOf(sessionId) {
    const rt = this.runtimes.get(sessionId);
    if (!rt) return { streaming: false, channelState: 'idle', queuePos: 0 };
    return {
      streaming: !!rt.turn && !rt.turn.finished,
      status: rt.turn ? rt.turn.status : '',
      channelState: rt.channelState,
      queuePos: rt.queuePos,
      taskId: rt.turn ? rt.turn.taskId : '',
      polling: !!(rt.turn && rt.turn.poll && rt.turn.poll.active),
    };
  }

  activeCount() {
    return this.active;
  }

  queueLength() {
    return this.queue.length;
  }

  /* ---------------- 会话与通道 ---------------- */

  async prepare(session) {
    const rt = this.attach(session);
    if (!session.serverId) return false;
    try {
      const ch = this._ensureChannel(rt);
      return await ch.open(6000);
    } catch (e) {
      return false;
    }
  }

  async _ensureServerSession(rt) {
    if (rt.session.serverId) return rt.session.serverId;
    const created = await this.api.createSession(null, { sessionId: rt.sid });
    if (!created.session_id) throw new Error('创建会话响应缺少 session_id');
    const oldId = rt.sid;
    const newId = created.session_id;
    rt.session.serverId = newId;
    rt.session.id = newId;
    rt.sid = newId;
    this.runtimes.delete(oldId);
    this.runtimes.set(newId, rt);
    this.onSessionIdChange(oldId, newId);
    return newId;
  }

  _ensureChannel(rt) {
    if (rt.channel) return rt.channel;
    if (!rt.session.serverId) throw new Error('会话尚未创建');
    if (!rt.eventId) rt.eventId = newEventId();

    const api = this.api;
    const ch = new SSEChannel({
      url: () =>
        api._url('/work/openapi/v1/session/' + encodeURIComponent(rt.sid) + '/event', {
          event_id: rt.eventId,
        }),
      headersProvider: async () => {
        await api.ensureToken();
        return api._authHeaders({ Accept: 'text/event-stream' });
      },
      onEvent: (ev) => this._onEvent(rt, ev),
      onState: (state, detail) => this._onChannelState(rt, state, detail),
      idleTimeout: 45000,
    });
    ch.lastUsedAt = Date.now();
    rt.channel = ch;
    rt.channelState = 'idle';
    this._trimChannels(rt);
    return ch;
  }

  _trimChannels(keep) {
    const chans = Array.from(this.runtimes.values()).filter(
      (rt) => rt !== keep && rt.channel && rt.channel.state !== 'closed'
    );
    if (chans.length + 1 <= MAX_CHANNELS) return;
    chans.sort((a, b) => (a.channel.lastUsedAt || 0) - (b.channel.lastUsedAt || 0));
    let over = chans.length + 1 - MAX_CHANNELS;
    for (const rt of chans) {
      if (over <= 0) break;
      if (rt.turn && !rt.turn.finished) continue; // 有进行中轮次的通道不回收
      try {
        rt.channel.close();
      } catch (e) { /* ignore */ }
      rt.channel = null;
      rt.channelState = 'closed';
      over--;
    }
  }

  _onChannelState(rt, state, detail) {
    rt.channelState = state;
    this._logChannel(rt, state, detail);
    if (state === 'auth' && !rt.authRetried) {
      rt.authRetried = true;
      this.api
        .ensureToken(true)
        .then(() => rt.channel && rt.channel.restart(6000))
        .catch(() => {});
    }
    if (state === 'open') rt.authRetried = false;
    if (state === 'retrying' && rt.turn && !rt.turn.finished) {
      this._startPoll(rt, rt.turn, 'SSE 断线');
    }
    this.onSessionChange(rt.sid, 'channel');
  }

  _logChannel(rt, state, detail) {
    const logger = this.api.logger;
    if (!logger) return;
    if (!rt.sseLogId && (state === 'connecting' || state === 'retrying' || state === 'open')) {
      let url = '';
      try {
        url = rt.channel ? rt.channel.opts.url() : '';
      } catch (e) { /* ignore */ }
      rt.sseLogId = logger.start({
        label: '建立 SSE',
        method: 'GET',
        path: '/work/openapi/v1/session/' + rt.sid + '/event',
        url,
        reqHeaders: { Accept: 'text/event-stream', Authorization: 'Bearer ***' },
        sessionId: rt.sid,
        stream: true,
      });
    }
    if (!rt.sseLogId) return;
    if (state === 'open') {
      logger.update(rt.sseLogId, { status: 200, resBody: '（text/event-stream 已建立）' });
    } else if (state === 'error' || state === 'auth') {
      logger.update(rt.sseLogId, {
        status: state === 'auth' ? 401 : 'ERR',
        error: (detail && detail.reason) || state,
        done: true,
      });
    }
  }

  /* ---------------- 发送 ---------------- */

  async send(session, payload) {
    const rt = this.attach(session);
    if (rt.turn && !rt.turn.finished) {
      throw new Error('该会话正在执行，请先停止或等待完成');
    }
    if (rt.queued) {
      throw new Error('该会话已在排队中，请稍候');
    }
    if (this.active >= this.maxConcurrent) {
      if (!rt.session.renamed && (!rt.session.title || rt.session.title === '新会话')) {
        rt.session.title = titleFrom(payload.query);
      }
      rt.session.updatedAt = Date.now();
      rt.queued = payload;
      this.queue.push(rt);
      rt.queuePos = this.queue.length;
      this.onSessionChange(rt.sid, 'queued');
      return { queued: true, pos: rt.queuePos };
    }
    await this._start(rt, payload);
    return { queued: false };
  }

  _drain() {
    while (this.active < this.maxConcurrent && this.queue.length) {
      const rt = this.queue.shift();
      if (!rt) break;
      const payload = rt.queued;
      rt.queued = null;
      rt.queuePos = 0;
      if (rt.turn && !rt.turn.finished) continue;
      this._start(rt, payload);
    }
  }

  async _start(rt, payload) {
    if (!payload || !payload.query) return;
    if (rt.turn && !rt.turn.finished) return;

    this.active++;
    const session = rt.session;
    const now = Date.now();
    const userMsg = {
      id: uid('m'),
      role: 'user',
      text: payload.query,
      time: now,
      status: 'done',
    };
    const botMsg = {
      id: uid('m'),
      role: 'assistant',
      text: '',
      reasoning: '',
      parts: [],
      artifacts: [],
      tools: [],
      status: 'streaming',
      time: now,
      meta: {},
    };
    session.messages.push(userMsg);
    session.messages.push(botMsg);
    if (!session.renamed && (!session.title || session.title === '新会话')) {
      session.title = titleFrom(payload.query);
    }
    session.updatedAt = now;
    if (session.pendingTask) {
      session.pendingTask = '';
      session.pendingAt = 0;
    }

    const turn = {
      id: uid('turn'),
      sid: rt.sid,
      userMsg,
      botMsg,
      parts: botMsg.parts,
      partMap: new Map(),
      artifacts: [],
      tools: [],
      text: '',
      reasoning: '',
      submitted: false,
      finished: false,
      status: 'running',
      taskId: '',
      eventId: rt.eventId,
      assistantMsgId: '',
      userMsgId: '',
      assistantMsgIds: new Set(),
      ignoredMsgIds: new Set(),
      busySeen: false,
      sawActivity: false,
      startedAt: now,
      lastEventAt: now,
      model: '',
      usage: null,
      watchdog: null,
      poll: { active: false, attempts: 0, timer: null, why: '', startedAt: 0 },
      paintTimer: null,
      _persistAt: 0,
    };
    botMsg.turnId = turn.id;
    rt.turn = turn;

    this.onSessionChange(rt.sid, 'turn-start');
    this.onTurnChange(rt.sid, turn);
    this._persist(rt);

    try {
      if (!rt.session.serverId) {
        this.onNotice('info', '正在创建会话…');
        await this._ensureServerSession(rt);
      }
      const ch = this._ensureChannel(rt);
      this.onNotice('info', '正在建立 SSE 通道…');
      const opened = await ch.open(7000);
      if (!opened) this.onNotice('warn', 'SSE 尚未就绪，仍尝试提交');
      await this._submit(rt, turn, payload, 0);
    } catch (e) {
      this._fail(rt, turn, e);
    }
  }

  async _submit(rt, turn, payload, attempt) {
    const body = {
      sessionId: rt.sid,
      eventId: rt.eventId,
      query: payload.query,
      model: payload.model,
      assistantId: payload.assistantId,
      tools: payload.tools,
      skills: payload.skills,
      inboxs: payload.inboxs,
    };
    try {
      const res = await this.api.chat(body, { sessionId: rt.sid });
      if (turn.finished) return;
      turn.submitted = true;
      turn.taskId = (res.data && res.data.task_id) || '';
      turn.eventId = (res.data && res.data.event_id) || rt.eventId;
      if (res.data && res.data.session_id && res.data.session_id !== rt.session.id) {
        // 理论上不会发生（我们显式传了 session_id），保底纠正
        const oldId = rt.sid;
        rt.sid = res.data.session_id;
        rt.session.id = rt.sid;
        this.runtimes.delete(oldId);
        this.runtimes.set(rt.sid, rt);
        this.onSessionIdChange(oldId, rt.sid);
      }
      turn.status = 'running';
      if (turn.taskId) {
        rt.session.pendingTask = turn.taskId;
        rt.session.pendingAt = Date.now();
      }
      this._persist(rt);
      this.onSessionChange(rt.sid, 'submitted');
      this._armWatchdog(rt, turn);
    } catch (e) {
      if (e && e.code === '5001093001' && attempt < 2) {
        // SSE 路由未注册 / 断线：重建通道后重发
        this.onNotice('warn', 'SSE 路由未注册，正在重连并重试…');
        try {
          await rt.channel.restart(7000);
        } catch (err) { /* ignore */ }
        return this._submit(rt, turn, payload, attempt + 1);
      }
      if (e && e.code === '5001303001' && attempt < 2) {
        // 会话仍标记为运行中（例如刚停止等待中的工具、服务端尚未落地），短暂等待后重试
        await new Promise((r) => setTimeout(r, 1000));
        return this._submit(rt, turn, payload, attempt + 1);
      }
      if (e && (e.status === 429 || e.code === '5001303003') && attempt < 1) {
        this.onNotice('warn', '租户并发已达上限，' + (e.retryAfter || 5) + ' 秒后重试…');
        await new Promise((r) => setTimeout(r, (e.retryAfter || 5) * 1000));
        return this._submit(rt, turn, payload, attempt + 1);
      }
      throw e;
    }
  }

  _armWatchdog(rt, turn) {
    clearTimeout(turn.watchdog);
    turn.watchdog = setTimeout(() => {
      if (turn.finished) return;
      const ch = rt.channel;
      // 通道健康 = 仍是 open 且最近 40s 内收到过任何事件（含心跳）
      const channelHealthy =
        !!ch && ch.isOpen && Date.now() - (ch.lastEventAt || 0) < 40000;

      if (!turn.sawActivity) {
        // 20s 还没有任何内容，或通道根本没连上：走轮询兜底
        if (!channelHealthy || Date.now() - turn.startedAt > 20000) {
          this._startPoll(rt, turn, 'SSE 静默');
        }
      } else if (!channelHealthy) {
        this._startPoll(rt, turn, 'SSE 断线');
      } else if (Date.now() - turn.lastEventAt > 60000) {
        // 心跳正常但 60s 没有任何内容：做一次状态兜底（正常工具执行期不会触发）
        this._startPoll(rt, turn, 'SSE 长时间无内容');
      }
      if (!turn.finished) this._armWatchdog(rt, turn);
    }, 5000);
  }

  /* ---------------- SSE 事件 ---------------- */

  _onEvent(rt, ev) {
    const type = ev && ev.type;
    const p = (ev && ev.properties) || {};
    if (this.recording) {
      if (!rt.sseLog) rt.sseLog = [];
      rt.sseLog.push({ t: Date.now(), ev });
      // 单会话最多留 8000 条，避免长连接把内存吃满
      if (rt.sseLog.length > 8000) rt.sseLog.splice(0, rt.sseLog.length - 8000);
    }
    if (rt.channel) rt.channel.lastUsedAt = Date.now();

    if (rt.sseLogId && this.api.logger && rt.channel) {
      const now = Date.now();
      if (!rt._logAt || now - rt._logAt > 500) {
        rt._logAt = now;
        this.api.logger.trackSSE(rt.sseLogId, rt.channel.stats);
      }
    }

    if (type === 'server.heartbeat') return;

    if (type === 'session.updated') {
      const info = p.info || {};
      if (info.title && !rt.session.renamed && info.title !== rt.session.title) {
        rt.session.title = String(info.title).slice(0, 60);
        this._persist(rt);
        this.onSessionChange(rt.sid, 'title');
      }
      return;
    }

    const turn = rt.turn;
    if (!turn || turn.finished) return;

    if (type === 'session.status') {
      const st = p.status && p.status.type;
      if (st === 'busy') {
        turn.busySeen = true;
        turn.sawActivity = true;
        turn.lastEventAt = Date.now();
        this._schedulePaint(rt, turn);
      } else if (st === 'idle') {
        if (turn.busySeen || turn.sawActivity) this._finish(rt, turn, 'completed');
      }
      return;
    }

    if (type === 'message.updated') {
      const info = p.info || {};
      if (info.role === 'user') {
        turn.userMsgId = info.id || turn.userMsgId;
        if (info.id) turn.ignoredMsgIds.add(info.id);
        return;
      }
      if (info.role === 'assistant') {
        if (info.id) {
          // 一轮里可能有多条 assistant message（工具调用后重新进入生成），全部接受
          turn.assistantMsgIds.add(info.id);
          if (!turn.assistantMsgId) turn.assistantMsgId = info.id;
        }
        if (info.model) turn.model = String(info.model);
        if (info.usage) turn.usage = info.usage;
        turn.sawActivity = true;
        this._schedulePaint(rt, turn);
      }
      return;
    }

    if (type === 'message.part.updated') {
      const part = p.part;
      if (!part) return;
      const messageId = p.messageID || part.messageID || '';
      if (!this._isAssistantPart(rt, turn, messageId)) return;
      this._upsertPart(rt, turn, part);
      return;
    }

    if (type === 'message.part.delta') {
      if (p.field !== 'text' || !p.partID) return;
      if (!this._isAssistantPart(rt, turn, p.messageID || '')) return;
      let part = turn.partMap.get(p.partID);
      if (!part) {
        part = { id: p.partID, type: 'text', text: '' };
        turn.parts.push(part);
        turn.partMap.set(p.partID, part);
      }
      if (part.ended) return; // 已收到最终快照，忽略后续增量
      part.text = (part.text || '') + (p.delta || '');
      turn.sawActivity = true;
      turn.lastEventAt = Date.now();
      this._applyParts(turn);
      this._schedulePaint(rt, turn);
    }
  }

  _isAssistantPart(rt, turn, messageId) {
    if (!messageId) return true;
    if (turn.ignoredMsgIds.has(messageId)) return false;
    if (rt.lastAssistantMsgIds && rt.lastAssistantMsgIds.has(messageId)) return false;
    // 不锁定单条 message：工具调用后服务端会用新的 messageID 继续输出正文
    turn.assistantMsgIds.add(messageId);
    if (!turn.assistantMsgId) turn.assistantMsgId = messageId;
    return true;
  }

  _upsertPart(rt, turn, part) {
    const id = part.id || part.partID || uid('part');
    const type = part.type || 'text';
    let item = turn.partMap.get(id);

    if (type === 'artifact') {
      const art = {
        artifactId: part.artifactId || part.artifact_id || id,
        name: part.name || part.filename || '产物',
        mime: part.mime || '',
        size: part.size || 0,
      };
      if (!turn.artifacts.find((a) => a.artifactId === art.artifactId)) {
        turn.artifacts.push(art);
        turn.botMsg.artifacts = turn.artifacts;
      }
      turn.sawActivity = true;
      this._applyParts(turn);
      this._schedulePaint(rt, turn);
      return;
    }

    if (type === 'tool') {
      const st = part.state && typeof part.state === 'object' ? part.state : {};
      const tool = {
        id,
        callID: part.callID || '',
        tool: part.tool || st.title || part.toolName || '工具',
        title: st.title || part.tool || part.toolName || '工具',
        status:
          typeof part.state === 'string'
            ? part.state
            : typeof st.status === 'string'
              ? st.status
              : '',
        input: st.input || null,
        output:
          typeof st.output === 'string'
            ? st.output
            : st.output
              ? JSON.stringify(st.output, null, 2)
              : '',
        start: (st.time && st.time.start) || 0,
        end: (st.time && st.time.end) || 0,
      };
      const idx = turn.tools.findIndex((t) => t.id === id);
      if (idx >= 0) turn.tools[idx] = Object.assign({}, turn.tools[idx], tool);
      else turn.tools.push(tool);
      turn.botMsg.tools = turn.tools;
      turn.sawActivity = true;
      this._applyParts(turn);
      this._schedulePaint(rt, turn);
      return;
    }

    if (type !== 'text' && type !== 'reasoning') {
      // 未知 part.type：按规范忽略，保持前向兼容
      return;
    }

    if (!item) {
      item = { id, type, text: '' };
      turn.parts.push(item);
      turn.partMap.set(id, item);
    }
    if (typeof part.text === 'string') {
      // message.part.updated 是完整快照：直接覆盖
      item.text = part.text;
    }
    if (part.time && part.time.end) item.ended = true;
    turn.sawActivity = true;
    turn.lastEventAt = Date.now();
    this._applyParts(turn);
    this._schedulePaint(rt, turn);
  }

  _applyParts(turn) {
    let text = '';
    let reasoning = '';
    turn.parts.forEach((p) => {
      if (p.type === 'text') text += p.text || '';
      else if (p.type === 'reasoning') reasoning += (reasoning ? '\n\n' : '') + (p.text || '');
    });
    turn.text = text;
    turn.reasoning = reasoning;
    turn.botMsg.text = text;
    turn.botMsg.reasoning = reasoning;
    turn.botMsg.parts = turn.parts;
  }

  _schedulePaint(rt, turn) {
    if (turn.paintTimer) return;
    turn.paintTimer = setTimeout(() => {
      turn.paintTimer = null;
      if (rt.turn !== turn) return;
      // 流式过程中周期性落盘，刷新/关页后可恢复已生成的部分
      if (Date.now() - (turn._persistAt || 0) > 2000) {
        turn._persistAt = Date.now();
        this._persist(rt);
      }
      this.onTurnChange(rt.sid, turn);
    }, 60);
  }

  /* ---------------- 轮询兜底 ---------------- */

  _startPoll(rt, turn, why) {
    if (!turn || turn.finished || turn.poll.active) return;
    turn.poll.active = true;
    turn.poll.why = why || '兜底';
    turn.poll.attempts = 0;
    turn.poll.startedAt = Date.now();
    this.onSessionChange(rt.sid, 'poll-start');
    this._schedulePoll(rt, turn, turn.taskId ? 1200 : 2500);
  }

  _schedulePoll(rt, turn, delay) {
    clearTimeout(turn.poll.timer);
    turn.poll.timer = setTimeout(() => this._pollOnce(rt, turn), Math.max(500, delay));
  }

  async _pollOnce(rt, turn) {
    if (turn.finished) return;
    if (!turn.taskId) {
      if (Date.now() - turn.poll.startedAt > 20000) {
        this._finish(rt, turn, 'pending', { reason: '未拿到 task_id' });
        return;
      }
      this._schedulePoll(rt, turn, 2000);
      return;
    }

    turn.poll.attempts++;
    let res;
    try {
      res = await this.api.pollTask(turn.taskId, { toolCalls: true, reasoning: true }, { sessionId: rt.sid });
    } catch (e) {
      if (turn.finished) return;
      if (e && (e.status === 404 || e.code === '5001053009' || e.status === 403)) {
        rt.session.pendingTask = '';
        this._finish(rt, turn, 'failed', {
          message: '任务在服务端已不存在或无权查看（' + (e.code || e.status) + '）',
        });
        return;
      }
      if (e && e.isNet) {
        // 网络抖动：保持轮询
      }
      this._scheduleNextPoll(rt, turn, 0);
      return;
    }
    if (turn.finished) return;

    const d = (res && res.data) || {};
    const status = d.status || '';
    const terminal = !!TERMINAL[status];
    if (terminal) {
      this._applyTaskResult(rt, turn, d, true);
      const map = { completed: 'completed', failed: 'failed', expired: 'expired', stopped: 'stopped' };
      const detail = {};
      if (status === 'failed' && d.error && d.error.message) detail.message = d.error.message;
      if (status === 'expired') detail.message = '任务已过期，服务端不再保留结果';
      this._finish(rt, turn, map[status] || 'completed', detail);
      return;
    }

    // 非终态：若 SSE 始终无输出，可先用轮询里的 answer 让界面有内容
    if (!turn.text && d.answer) {
      this._applyTaskResult(rt, turn, d, false);
      this._schedulePaint(rt, turn);
    }
    this._scheduleNextPoll(rt, turn, res.retryAfter);
  }

  _scheduleNextPoll(rt, turn, retryAfter) {
    if (Date.now() - turn.poll.startedAt > POLL_GIVE_UP_MS) {
      if (!turn.finished) {
        this._finish(rt, turn, turn.text ? 'completed' : 'pending', {
          reason: '轮询超时',
        });
      }
      return;
    }
    const n = turn.poll.attempts;
    let delay;
    if (retryAfter) delay = retryAfter * 1000;
    else if (n <= FAST_POLL_DELAYS.length) delay = FAST_POLL_DELAYS[n - 1];
    else delay = SLOW_POLL_DELAY;
    this._schedulePoll(rt, turn, delay);
  }

  _applyTaskResult(rt, turn, d, authoritative) {
    if (!d) return;
    if (d.message_id && !turn.assistantMsgId) turn.assistantMsgId = d.message_id;
    const answer = typeof d.answer === 'string' ? d.answer : '';
    if (answer) {
      // 终态轮询是权威结果：若它比 SSE 已累积的更长，用它替换正文（SSE 半截时补全）
      const replace = authoritative && answer.length > turn.text.length;
      if (!turn.text || replace) {
        if (replace) {
          for (let i = turn.parts.length - 1; i >= 0; i--) {
            if (turn.parts[i].type === 'text') turn.parts.splice(i, 1);
          }
          const stale = [];
          turn.partMap.forEach((v, k) => {
            if (v.type === 'text') stale.push(k);
          });
          stale.forEach((k) => turn.partMap.delete(k));
        }
        let part = turn.partMap.get('__answer__');
        if (!part) {
          part = { id: '__answer__', type: 'text', text: '' };
          turn.parts.push(part);
          turn.partMap.set('__answer__', part);
        }
        part.text = answer;
        part.fromPoll = true;
      }
    }
    if (!turn.reasoning && d.reasoning) {
      turn.pendingReasoning =
        typeof d.reasoning === 'string' ? d.reasoning : JSON.stringify(d.reasoning, null, 2);
    }
    if (Array.isArray(d.artifacts)) {
      d.artifacts.forEach((a) => {
        const art = {
          artifactId: a.artifact_id || a.artifactId || '',
          name: a.filename || a.name || '产物',
          mime: a.mime || '',
          size: a.size || 0,
        };
        if (art.artifactId && !turn.artifacts.find((x) => x.artifactId === art.artifactId)) {
          turn.artifacts.push(art);
        }
      });
      turn.botMsg.artifacts = turn.artifacts;
    }
    this._applyParts(turn);
    turn.sawActivity = true;
    this.onTurnChange(rt.sid, turn);
  }

  /* ---------------- 收尾 ---------------- */

  _finish(rt, turn, status, detail) {
    if (!turn || turn.finished) return;
    detail = detail || {};
    turn.finished = true;
    turn.status = status;
    if (turn.assistantMsgId) rt.lastAssistantMsgIds.add(turn.assistantMsgId);
    if (turn.assistantMsgIds) turn.assistantMsgIds.forEach((id) => rt.lastAssistantMsgIds.add(id));
    // 收尾时补一次统计，确保调试看板拿到完整事件数（而不是 500ms 节流时的快照）
    if (rt.sseLogId && this.api.logger && rt.channel) {
      this.api.logger.trackSSE(rt.sseLogId, rt.channel.stats);
    }
    this._clearTimers(turn);
    if (turn.paintTimer) {
      clearTimeout(turn.paintTimer);
      turn.paintTimer = null;
    }

    const msg = turn.botMsg;
    if (turn.pendingReasoning && !turn.reasoning) {
      turn.reasoning = turn.pendingReasoning;
      msg.reasoning = turn.reasoning;
    }

    const text = turn.text || '';
    if (status === 'completed') {
      msg.status = text ? 'done' : 'done';
      if (!text) msg.text = '（本轮没有返回文本）';
      rt.session.pendingTask = '';
      rt.session.pendingAt = 0;
    } else if (status === 'stopped') {
      msg.status = 'stopped';
      if (!text) msg.text = '（已停止）';
      rt.session.pendingTask = '';
      rt.session.pendingAt = 0;
    } else if (status === 'pending') {
      msg.status = 'pending';
      msg.error = '本轮尚未拿到终态（' + (detail.reason || '等待超时') + '）。已保存 task_id，稍后可继续查询。';
      if (turn.taskId) {
        rt.session.pendingTask = turn.taskId;
        rt.session.pendingAt = Date.now();
      }
    } else {
      msg.status = 'error';
      if (!msg.error) msg.error = detail.message || '执行未成功';
      if (!text) msg.text = msg.error;
      if (rt.session.pendingTask === turn.taskId) {
        rt.session.pendingTask = '';
        rt.session.pendingAt = 0;
      }
    }

    msg.meta = Object.assign({}, msg.meta, {
      status,
      model: turn.model || '',
      usage: turn.usage || null,
      elapsed: Date.now() - turn.startedAt,
      via: turn.poll.attempts ? 'poll' : 'sse',
    });
    msg.time = msg.time || Date.now();
    rt.session.updatedAt = Date.now();
    this._persist(rt);

    if (turn.poll.timer) clearTimeout(turn.poll.timer);
    turn.poll.active = false;

    this.onTurnChange(rt.sid, turn);
    this.onSessionChange(rt.sid, 'finished');

    if (status === 'completed' || status === 'failed') {
      if (this.getActiveId() !== rt.sid) {
        rt.session.unread = (rt.session.unread || 0) + 1;
        saveSession(rt.session);
        this.onSessionChange(rt.sid, 'unread');
      }
    }

    this._release(turn);
  }

  _release(turn) {
    if (turn && turn._released) return;
    if (turn) turn._released = true;
    this.active = Math.max(0, this.active - 1);
    this._drain();
  }

  _fail(rt, turn, err) {
    if (!turn || turn.finished) {
      this._release(turn);
      return;
    }
    const code = err && err.code ? String(err.code) : '';
    const base = (err && err.message) || '未知错误';
    const hint = explainError(err);
    turn.botMsg.errorCode = code;
    turn.botMsg.error = (code ? '[' + code + '] ' : '') + base + (hint ? '\n' + hint : '');
    if (!turn.text) turn.botMsg.text = turn.botMsg.error;
    this.onNotice('error', (code ? '[' + code + '] ' : '') + base);
    this._finish(rt, turn, 'failed', { message: err && err.message ? err.message : '请求失败' });
  }

  _clearTimers(turn) {
    clearTimeout(turn.watchdog);
    turn.watchdog = null;
    clearTimeout(turn.poll && turn.poll.timer);
    if (turn.poll) turn.poll.timer = null;
  }

  _persist(rt) {
    const session = rt.session;
    saveSession(session);
    rt.persistTimer = null;
  }

  /* ---------------- 停止 / 续查 ---------------- */

  cancelQueued(sessionId) {
    const rt = this.runtimes.get(sessionId);
    if (!rt || !rt.queued) return null;
    const payload = rt.queued;
    this.queue = this.queue.filter((x) => x !== rt);
    rt.queued = null;
    rt.queuePos = 0;
    this.onSessionChange(rt.sid, 'queue-cancel');
    return payload;
  }

  async stop(session) {
    const rt = this.attach(session);
    if (!rt.turn || rt.turn.finished) return false;
    const turn = rt.turn;
    turn.status = 'stopping';
    this.onSessionChange(rt.sid, 'stopping');
    try {
      await this.api.stopSession(rt.sid, { sessionId: rt.sid });
    } catch (e) {
      // 停止失败也把界面收回来，避免卡在 streaming
    }
    this._finish(rt, turn, 'stopped');
    return true;
  }

  /** 按 task_id 续查未完成的轮次（用户显式触发）。 */
  async resume(session) {
    const rt = this.attach(session);
    if (!session.pendingTask) return false;
    if (rt.turn && !rt.turn.finished) return false;
    if (this.active >= this.maxConcurrent) {
      this.onNotice('warn', '并发已满（' + this.maxConcurrent + '），稍后再试');
      return false;
    }
    this.active++;
    const now = Date.now();
    const botMsg = {
      id: uid('m'),
      role: 'assistant',
      text: '',
      parts: [],
      artifacts: [],
      tools: [],
      status: 'streaming',
      time: now,
      meta: {},
    };
    session.messages.push(botMsg);
    const turn = {
      id: uid('turn'),
      sid: rt.sid,
      userMsg: null,
      botMsg,
      parts: botMsg.parts,
      partMap: new Map(),
      artifacts: [],
      tools: [],
      text: '',
      reasoning: '',
      submitted: true,
      finished: false,
      status: 'running',
      taskId: session.pendingTask,
      eventId: rt.eventId,
      assistantMsgId: '',
      userMsgId: '',
      assistantMsgIds: new Set(),
      ignoredMsgIds: new Set(),
      busySeen: false,
      sawActivity: false,
      startedAt: now,
      lastEventAt: now,
      model: '',
      usage: null,
      watchdog: null,
      poll: { active: true, attempts: 0, timer: null, why: '续查', startedAt: now },
      paintTimer: null,
    };
    rt.turn = turn;
    this.onSessionChange(rt.sid, 'resume');
    this.onTurnChange(rt.sid, turn);
    // 续查不依赖 SSE：直接走轮询
    this._schedulePoll(rt, turn, 600);
    return true;
  }
}