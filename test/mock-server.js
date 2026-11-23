#!/usr/bin/env node
/**
 * 本地联调用的 Mock 灵基服务（零依赖）。
 *
 *   node test/mock-server.js [port]     # 默认 4398
 *
 * 然后在页面的「连接设置 → 服务地址」填 http://127.0.0.1:4398。
 *
 * 行为：
 *  - 签发令牌 / 会话 / 模型 / 工具 / 智能体 均返回固定数据
 *  - SSE 建连后先发 server.connected，随后每 10s 心跳
 *  - POST /chat 要求同一 event_id 已有 SSE 连接，否则返回 HTTP 202 + 5001093001
 *  - 普通提问：通过 SSE 逐字推送文本、一个工具 part 与一个 artifact part，最后 session.idle
 *  - 提问里包含 "[poll]"：故意不推流，让前端 5s 后走轮询兜底
 *  - GET /task/{id}：2.5s 后返回 completed 与答案
 */

const http = require('http');

const PORT = Number(process.argv[2] || 4398);
const sessions = new Map();
const streams = new Map(); // event_id -> res
const tasks = new Map(); // task_id -> {query, sessionId, createdAt}
const taskDropped = Object.create(null); // session_id -> true（[drop] 只摘一次）

let seq = 0;
const nextId = (p) => p + '_' + (++seq) + '_' + Date.now().toString(36);

function sendJSON(res, status, obj, extraHeaders) {
  const body = JSON.stringify(obj);
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  }, extraHeaders || {}));
  res.end(body);
}

function ok(res, data, status) {
  sendJSON(res, status || 200, { code: '0', message: '', timestamp: Date.now(), data });
}

function emit(eventId, obj) {
  const res = streams.get(eventId);
  if (!res) return false;
  try {
    res.write('data: ' + JSON.stringify(obj) + '\n\n');
    return true;
  } catch (e) {
    return false;
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', (c) => { buf += c; });
    req.on('end', () => {
      try { resolve(buf ? JSON.parse(buf) : {}); } catch (e) { resolve({}); }
    });
  });
}

function sseHandler(req, res, url) {
  const eventId = url.searchParams.get('event_id') || '';
  if (!eventId) {
    sendJSON(res, 400, { code: '400', message: 'event_id required' });
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  if (res.flushHeaders) res.flushHeaders();
  streams.set(eventId, res);
  res.write('data: ' + JSON.stringify({ type: 'server.connected', properties: {} }) + '\n\n');

  const hb = setInterval(() => {
    res.write('data: ' + JSON.stringify({ type: 'server.heartbeat', properties: {} }) + '\n\n');
  }, 10000);

  const cleanup = () => {
    clearInterval(hb);
    if (streams.get(eventId) === res) streams.delete(eventId);
  };
  req.on('close', cleanup);
  res.on('close', cleanup);
}

function playStream(sessionId, eventId, task) {
  // 固定本轮的消息/段落 ID：seq 会被其它请求递增，不能边发边取
  const msgU = 'msg_u_' + seq;
  const msgA = 'msg_a_' + seq;
  const textId = 'prt_text_' + seq;
  const toolId = 'prt_tool_' + seq;
  const artId = 'prt_art_' + seq;
  const t0 = Date.now();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  (async () => {
    emit(eventId, { type: 'session.status', properties: { sessionID: sessionId, status: { type: 'busy' } } });
    emit(eventId, {
      type: 'message.updated',
      properties: { info: { id: msgU, sessionID: sessionId, role: 'user', time: { created: Date.now() } } },
    });
    emit(eventId, {
      type: 'message.updated',
      properties: {
        info: {
          id: msgA, sessionID: sessionId, role: 'assistant',
          model: 'work/expert/HSP_INF', time: { created: Date.now() },
        },
      },
    });
    emit(eventId, {
      type: 'message.part.updated',
      properties: {
        sessionID: sessionId,
        messageID: msgA,
        part: { id: textId, messageID: msgA, type: 'text', text: '', time: { start: Date.now() } },
      },
    });

    const answer = [
      '## 模拟回答',
      '',
      '这是 **SSE 流式**输出，用来验证：',
      '',
      '1. 逐段到达与 Markdown 渲染',
      '2. 工具 part 与产物 part',
      '3. `session.idle` 幂等收尾',
      '',
      '```js',
      'console.log("streaming ok");',
      '```',
      '',
      '> 来自本地 mock 服务。',
    ].join('\n');

    const chunks = answer.match(/[\s\S]{1,8}/g) || [];
    const slow = /\[slow\]/.test(task.query);
    for (const c of chunks) {
      await sleep(slow ? 110 : 28);
      emit(eventId, {
        type: 'message.part.delta',
        properties: { sessionID: sessionId, messageID: msgA, partID: textId, field: 'text', delta: c },
      });
    }

    emit(eventId, {
      type: 'message.part.updated',
      properties: {
        sessionID: sessionId,
        messageID: msgA,
        part: { id: toolId, messageID: msgA, type: 'tool', toolName: 'Kingdee-SaaS', state: 'completed' },
      },
    });
    emit(eventId, {
      type: 'message.part.updated',
      properties: {
        sessionID: sessionId,
        messageID: msgA,
        part: {
          id: artId, messageID: msgA, type: 'artifact',
          artifactId: 'art_mock_1', name: '经营汇总.xlsx', mime: 'application/vnd.ms-excel', size: 20480,
        },
      },
    });
    // 最终快照（带 time.end），验证「以快照覆盖累积值」
    emit(eventId, {
      type: 'message.part.updated',
      properties: {
        sessionID: sessionId,
        messageID: msgA,
        part: { id: textId, messageID: msgA, type: 'text', text: answer, time: { start: t0, end: Date.now() } },
      },
    });

    await sleep(120);
    tasks.get(task.taskId).completedAt = Date.now();
    emit(eventId, { type: 'session.idle', properties: { sessionID: sessionId } });
    emit(eventId, { type: 'session.status', properties: { sessionID: sessionId, status: { type: 'idle' } } });
  })();
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;
  const method = req.method;

  if (method === 'POST' && path === '/console/openapi/v1/access-tokens') {
    await readBody(req);
    ok(res, { access_token: 'mock-token-' + Date.now().toString(36), expires_in: 7200 });
    return;
  }

  if (method === 'GET' && path === '/work/openapi/v1/models') {
    ok(res, [
      { id: 'work/auto/default', displayName: '自动', autoRouting: true },
      { id: 'work/expert/HSP_INF', displayName: '专家' },
      { id: 'work/standard/STD_INF', displayName: '标准' },
    ]);
    return;
  }
  if (method === 'GET' && path === '/work/openapi/v1/tools') {
    ok(res, {
      records: [
        { id: 'Kingdee-SaaS', name: '金蝶SaaS', displayName: '金蝶SaaS', description: '内置 ERP 工具' },
        { id: 'kb-001', name: '企业知识中心', displayName: '企业知识中心', description: '知识检索' },
      ],
      total: 2, page: 1, pageSize: 100,
    });
    return;
  }
  if (method === 'GET' && path === '/work/openapi/v1/agents') {
    ok(res, {
      records: [{ id: 'agent-1', name: '财务助手', displayName: '财务助手', description: '模拟智能体' }],
      total: 1, page: 1, pageSize: 100,
    });
    return;
  }

  if (method === 'POST' && path === '/work/openapi/v1/session') {
    await readBody(req);
    const sid = 'mock-' + Date.now().toString(36) + '-' + (++seq);
    sessions.set(sid, { createdAt: Date.now() });
    ok(res, { session_id: sid, active: false, created_at: new Date().toISOString() });
    return;
  }

  const eventMatch = path.match(/^\/work\/openapi\/v1\/session\/([^/]+)\/event$/);
  if (method === 'GET' && eventMatch) {
    sseHandler(req, res, url);
    return;
  }

  if (method === 'POST' && path === '/work/openapi/v1/chat') {
    const body = await readBody(req);
    const sid = body.session_id;
    const eventId = url.searchParams.get('event_id');
    // 用于验证「5001093001 后自动重连重试」：第一次故意把路由摘掉
    if (eventId && /\[drop\]/.test(body.query) && !taskDropped[sid]) {
      taskDropped[sid] = true;
      streams.delete(eventId);
    }
    if (!sid || !sessions.has(sid)) {
      sendJSON(res, 404, { code: '5001053001', message: '会话不存在' });
      return;
    }
    if (!eventId || !streams.has(eventId)) {
      // 模拟「SSE 路由未注册」：202 + 业务码
      sendJSON(res, 202, {
        code: '5001093001',
        message: 'SSE 路由未注册，请先调用 sse_register',
        timestamp: Date.now(),
      });
      return;
    }
    const taskId = 'task_' + (++seq) + '_' + Date.now().toString(36);
    const task = { taskId, sessionId: sid, eventId, query: body.query || '', createdAt: Date.now(), completedAt: 0 };
    tasks.set(taskId, task);
    ok(res, { task_id: taskId, session_id: sid, status: 'running', event_id: eventId }, 202);
    if (!/[[]poll[\]]/.test(task.query)) playStream(sid, eventId, task);
    return;
  }

  const taskMatch = path.match(/^\/work\/openapi\/v1\/task\/([^/]+)$/);
  if (method === 'GET' && taskMatch) {
    const task = tasks.get(taskMatch[1]);
    if (!task) {
      sendJSON(res, 404, { code: '5001053009', message: '任务不存在' });
      return;
    }
    const done = Date.now() - task.createdAt > 2500;
    const answer = '## 轮询兜底结果\n\nSSE 没有推送内容，本回答来自 `GET /task/{id}` 轮询。\n\n- 任务：`' + task.taskId + '`\n- 问题：' + task.query;
    ok(res, {
      task_id: task.taskId,
      session_id: task.sessionId,
      status: done ? 'completed' : 'running',
      answer: done ? answer : undefined,
      artifacts: done ? [{ artifact_id: 'art_mock_1', session_id: task.sessionId, filename: '轮询结果.xlsx', mime: 'application/vnd.ms-excel', size: 1024 }] : undefined,
      created_at: new Date(task.createdAt).toISOString(),
      completed_at: done ? new Date().toISOString() : undefined,
    }, done ? 200 : 202);
    return;
  }

  const stopMatch = path.match(/^\/work\/openapi\/v1\/session\/([^/]+)\/stop$/);
  if (method === 'POST' && stopMatch) {
    ok(res, { session_id: stopMatch[1], status: 'stopped' });
    return;
  }

  const artMatch = path.match(/^\/work\/openapi\/v1\/session\/([^/]+)\/artifact\/([^/]+)$/);
  if (method === 'GET' && artMatch) {
    const body = Buffer.from('mock artifact content for ' + artMatch[2] + '\n');
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': body.length,
      'Content-Disposition': 'attachment; filename="mock-artifact.bin"',
    });
    res.end(body);
    return;
  }

  sendJSON(res, 404, { code: '404', message: 'mock 未实现：' + method + ' ' + path });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('Mock 灵基服务已启动：http://127.0.0.1:' + PORT);
  console.log('把页面「服务地址」填成它即可联调；提问含 [poll] 可验证轮询兜底。');
});