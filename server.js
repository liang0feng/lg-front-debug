#!/usr/bin/env node
/**
 * 灵基对话台 · 本地服务（零依赖，Node 14+）
 *
 * 一个进程做两件事：
 *   1) 托管 public/ 下的前端（ES Module、CSS、图标）
 *   2) 把同源 /api/* 请求转发到目标环境，顺带解决 file:// 打开时的 CORS
 *
 * 用法：
 *   node server.js                              # http://127.0.0.1:3000
 *   PORT=8080 node server.js
 *   TARGET=https://other-host node server.js    # 页面里仍可用 X-Target 覆盖
 *
 * 页面「连接设置」里的服务地址通过 X-Target 头带上，可随时切换环境。
 * App Secret 只在浏览器本地参与签名，服务端不读取、不落盘。
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.argv[2] || process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const DEFAULT_TARGET = process.env.TARGET || 'https://app.lingee.com';
const ROOT = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
  '.yml': 'text/yaml; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function serveStatic(req, res) {
  let pathname;
  try {
    pathname = decodeURIComponent((req.url || '/').split('?')[0]);
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('400 bad request');
    return;
  }
  if (pathname === '/' || pathname === '') pathname = '/index.html';

  const rel = path.normalize(pathname).replace(/^([\\/])+/, '');
  const file = path.join(ROOT, rel);
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 forbidden');
    return;
  }

  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 ' + pathname);
      return;
    }
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const headers = {
      'Content-Type': type,
      'Content-Length': stat.size,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    };
    if (req.method === 'HEAD') {
      res.writeHead(200, headers);
      res.end();
      return;
    }
    res.writeHead(200, headers);
    fs.createReadStream(file).pipe(res);
  });
}

function proxy(req, res) {
  const raw = String(req.headers['x-target'] || DEFAULT_TARGET).trim();
  let target;
  try {
    target = new URL(raw);
  } catch (e) {
    sendJSON(res, 400, { code: 'BAD_TARGET', message: '目标地址不合法：' + raw });
    return;
  }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') {
    sendJSON(res, 400, { code: 'BAD_TARGET', message: '只支持 http/https：' + raw });
    return;
  }

  const suffix = req.url.replace(/^\/api/, '') || '/';
  const headers = Object.assign({}, req.headers);
  delete headers.host;
  delete headers.origin;
  delete headers.referer;
  delete headers['accept-encoding']; // 关压缩，SSE 才能逐条到达
  delete headers['x-target'];
  delete headers['sec-fetch-site'];
  delete headers['sec-fetch-mode'];
  delete headers['sec-fetch-dest'];
  headers.host = target.host;

  const lib = target.protocol === 'https:' ? https : http;
  const upstreamPath = target.pathname.replace(/\/+$/, '') + suffix;

  const up = lib.request(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      method: req.method,
      path: upstreamPath,
      headers,
    },
    (ur) => {
      const outHeaders = Object.assign({}, ur.headers);
      // 让流式响应不被任何中间层缓冲
      outHeaders['x-accel-buffering'] = 'no';
      res.writeHead(ur.statusCode || 502, outHeaders);
      ur.pipe(res);
    }
  );

  up.setTimeout(0);
  up.on('error', (e) => {
    const msg = e && e.message ? e.message : String(e);
    if (!res.headersSent) {
      sendJSON(res, 502, {
        code: 'PROXY_ERROR',
        message: '转发到 ' + target.origin + ' 失败：' + msg,
        hint: '确认本机能访问该环境，以及页面里「服务地址」是否写对。',
      });
    } else {
      res.end();
    }
    console.error('[proxy] ✗ ' + req.method + ' ' + suffix + ' → ' + target.origin + ' : ' + msg);
  });

  req.on('aborted', () => {
    try {
      up.destroy();
    } catch (e) { /* ignore */ }
  });

  req.pipe(up);
}

const server = http.createServer((req, res) => {
  const url = req.url || '/';
  if (url === '/healthz') {
    sendJSON(res, 200, { ok: true, target: DEFAULT_TARGET, version: require('./package.json').version });
    return;
  }
  const isApi = url === '/api' || url.indexOf('/api/') === 0;
  if (isApi) {
    if (req.method !== 'GET') {
      const t = String(req.headers['x-target'] || '').replace(/\/+$/, '');
      console.log('[api] ' + req.method + ' ' + url + (t ? '  → ' + t : ''));
    }
    return proxy(req, res);
  }
  return serveStatic(req, res);
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  灵基对话台 v1.0 已启动');
  console.log('  打开   http://' + HOST + ':' + PORT);
  console.log('  默认转发目标 ' + DEFAULT_TARGET + '（页面里可覆盖）');
  console.log('');
  console.log('  首次使用：页面 → 连接设置 → 填 App ID / Secret / 租户 → 代理模式 → 获取令牌');
  console.log('  按 Ctrl+C 停止。');
  console.log('');
});

server.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') {
    console.error('端口 ' + PORT + ' 已被占用，换一个：PORT=3001 node server.js（或用 node start.js 自动挑端口）');
  } else {
    console.error('启动失败：', e && e.message);
  }
  process.exit(1);
});