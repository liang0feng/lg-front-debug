#!/usr/bin/env node
/**
 * 灵基对话台 · 独立 Node 应用（零依赖，Node 14+）
 *
 * 一个进程干两件事：
 *   1) 托管前端页面（public/index.html）
 *   2) 把同源 /api/* 请求转发到目标环境（顺带解决 file:// 打开时的 CORS 问题）
 *
 * 用法：
 *   node server.js                              # http://127.0.0.1:3000，默认转发 https://app.lingee.com
 *   PORT=8080 node server.js                    # 换端口
 *   TARGET=https://other-host node server.js    # 换默认目标（页面里仍可覆盖）
 *
 * Windows PowerShell：
 *   $env:TARGET="https://app.lingee.com"; node server.js
 *
 * 说明：页面在「连接设置」里填的服务地址会通过 X-Target 头带上，因此可以随时切换环境；
 *      不填则用本进程的 TARGET。App Secret 始终只在浏览器本地参与签名，服务端不接触。
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const DEFAULT_TARGET = process.env.TARGET || 'https://app.lingee.com';
const ROOT = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res) {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/' || p === '') p = '/index.html';
  const file = path.join(ROOT, path.normalize(p).replace(/^([\\/])+/, ''));
  if (!file.startsWith(ROOT)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 forbidden');
    return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 ' + p);
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  });
}

function proxy(req, res) {
  const raw = String(req.headers['x-target'] || DEFAULT_TARGET).trim();
  let target;
  try {
    target = new URL(raw);
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ code: 'BAD_TARGET', message: '目标地址不合法：' + raw }));
    return;
  }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ code: 'BAD_TARGET', message: '只支持 http/https：' + raw }));
    return;
  }

  const suffix = req.url.replace(/^\/api/, '') || '/';
  const headers = Object.assign({}, req.headers);
  delete headers.host;
  delete headers.origin;
  delete headers.referer;
  delete headers['accept-encoding']; // 关压缩，SSE 才能逐条到达
  delete headers['x-target'];
  headers.host = target.host;

  const lib = target.protocol === 'https:' ? https : http;
  const up = lib.request(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      method: req.method,
      path: target.pathname.replace(/\/+$/, '') + suffix,
      headers,
    },
    (ur) => {
      res.writeHead(ur.statusCode || 502, ur.headers);
      ur.pipe(res); // 流式转发
    }
  );

  up.on('error', (e) => {
    const msg = e && e.message ? e.message : String(e);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    }
    res.end(
      JSON.stringify({
        code: 'PROXY_ERROR',
        message: '转发到 ' + target.origin + ' 失败：' + msg,
        hint: '确认本机能访问该环境，以及页面里「服务地址」是否写对。',
      })
    );
    console.error('[proxy] ✗ ' + req.method + ' ' + suffix + ' → ' + target.origin + ' : ' + msg);
  });

  req.pipe(up);
}

const server = http.createServer((req, res) => {
  const isApi = req.url === '/api' || req.url.indexOf('/api/') === 0;
  if (isApi) {
    if (req.method !== 'GET') {
      console.log('[api] ' + req.method + ' ' + req.url);
    }
    return proxy(req, res);
  }
  return serveStatic(req, res);
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  灵基对话台已启动');
  console.log('  打开   http://' + HOST + ':' + PORT);
  console.log('  默认转发目标 ' + DEFAULT_TARGET + '（页面里可覆盖）');
  console.log('');
  console.log('  首次使用：打开页面 → 连接设置 → 填 App ID / Secret / 租户 → 选代理模式 → 获取令牌');
  console.log('  按 Ctrl+C 停止。');
  console.log('');
});

server.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') {
    console.error('端口 ' + PORT + ' 已被占用，换一个：PORT=3001 node server.js');
  } else {
    console.error('启动失败：', e && e.message);
  }
  process.exit(1);
});