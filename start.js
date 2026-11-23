#!/usr/bin/env node
/**
 * 灵基对话台 · 启动器（Windows / macOS / Linux 通用）
 *
 * 作用：自动挑一个空闲端口，然后启动 server.js，并尝试打开浏览器。
 *       端口被占用时不再报错退出，而是顺延找下一个可用端口。
 *
 * 用法：
 *   node start.js            # 从 3000 开始找空闲端口
 *   node start.js 8080       # 从 8080 开始找
 *   NO_OPEN=1 node start.js  # 不自动打开浏览器
 *
 * 放在与 server.js 同一目录下即可。
 */

const net = require('net');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const ROOT = __dirname;
const BASE_PORT = Number(process.argv[2] || process.env.PORT || 3000);
const MAX_TRY = 30;

function isFree(port) {
  return new Promise(function (resolve) {
    const srv = net.createServer();
    srv.once('error', function () { resolve(false); });
    srv.once('listening', function () {
      srv.close(function () { resolve(true); });
    });
    srv.listen(port, '127.0.0.1');
  });
}

async function pickPort() {
  for (let i = 0; i < MAX_TRY; i++) {
    const p = BASE_PORT + i;
    if (await isFree(p)) return p;
  }
  return null;
}

function openBrowser(url) {
  if (process.env.NO_OPEN === '1') return;
  let cmd;
  if (process.platform === 'win32') cmd = 'start "" "' + url + '"';
  else if (process.platform === 'darwin') cmd = 'open "' + url + '"';
  else cmd = 'xdg-open "' + url + '"';
  exec(cmd, function () { /* 打不开就算了，地址已经打印出来了 */ });
}

(async function () {
  if (!fs.existsSync(path.join(ROOT, 'server.js'))) {
    console.error('');
    console.error('  ✗ 找不到 server.js');
    console.error('    请把 start.js 放在「灵基对话台」目录下（与 server.js 同级）。');
    console.error('');
    process.exit(1);
  }

  if (!Number.isFinite(BASE_PORT) || BASE_PORT < 1 || BASE_PORT > 65535) {
    console.error('  ✗ 端口不合法：' + process.argv[2]);
    process.exit(1);
  }

  const port = await pickPort();
  if (!port) {
    console.error('');
    console.error('  ✗ ' + BASE_PORT + '–' + (BASE_PORT + MAX_TRY - 1) + ' 全被占用');
    console.error('    可以手动指定一个：node start.js 8080');
    console.error('');
    process.exit(1);
  }
  if (port !== BASE_PORT) {
    console.log('');
    console.log('  提示：端口 ' + BASE_PORT + ' 已被占用，自动改用 ' + port + '。');
  }

  process.env.PORT = String(port);
  process.env.HOST = process.env.HOST || '127.0.0.1';

  const url = 'http://' + process.env.HOST + ':' + port;
  require(path.join(ROOT, 'server.js'));

  // 等监听起来再开浏览器
  setTimeout(function () { openBrowser(url); }, 900);
})().catch(function (e) {
  console.error('启动失败：', e && e.message);
  process.exit(1);
});