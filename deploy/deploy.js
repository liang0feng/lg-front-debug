#!/usr/bin/env node
/**
 * 灵基对话台（lg-front-debug）· 自动化部署工具
 *
 * 通过 SSH 把前端与 Node 转发服务发布到 Linux 部署机：
 *   releases/<时间戳>/  ← 每次发布一个目录
 *   current -> releases/<时间戳>   ← 原子切换，回滚只需改指向
 * 由 systemd 托管 Node 进程，nginx 直接托管静态文件并转发 /api。
 *
 * 依赖：Node 18+、本机 tar、deploy/ 下安装 ssh2（npm install --prefix deploy）
 * 用法：见 DEPLOY.md，或 node deploy/deploy.js help
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

let Client;
try {
  ({ Client } = require('ssh2'));
} catch (e) {
  console.error('\n  缺少依赖 ssh2。先执行：\n\n    npm install --prefix deploy\n');
  process.exit(2);
}

const ROOT = path.resolve(__dirname, '..');
const TPL_DIR = path.join(__dirname, 'templates');
const DEFAULT_CONFIG = path.join(__dirname, 'deploy.config.json');

/* ------------------------------------------------------------------ 输出 */
const color = process.stdout.isTTY ? (code) => (s) => `\x1b[${code}m${s}\x1b[0m` : () => (s) => s;
const cyan = color('36'), green = color('32'), yellow = color('33'), red = color('31'), dim = color('2');
const log = {
  step: (m) => console.log('\n' + cyan('▶ ' + m)),
  ok: (m) => console.log(green('  ✓ ') + m),
  info: (m) => console.log('    ' + String(m).replace(/\n/g, '\n    ')),
  dim: (m) => console.log(dim('    ' + m)),
  warn: (m) => console.log(yellow('  ! ') + m),
  err: (m) => console.error(red('  ✗ ') + m),
};
function die(msg, code = 1) {
  log.err(msg);
  process.exit(code);
}

/* -------------------------------------------------------------- 通用工具 */
function shq(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}
function toPosix(p) {
  return p.replace(/\\/g, '/');
}
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function readTpl(name) {
  return fs.readFileSync(path.join(TPL_DIR, name), 'utf8');
}
function render(tpl, vars) {
  return tpl.replace(/\{\{(\w+)\}\}/g, (m, k) => {
    if (!(k in vars)) throw new Error('模板变量未提供：' + k);
    return String(vars[k]);
  });
}

/* ------------------------------------------------------------------ 配置 */
function loadConfig(file) {
  const configPath = path.resolve(file || process.env.LINGEE_DEPLOY_CONFIG || DEFAULT_CONFIG);
  if (!fs.existsSync(configPath)) {
    log.err('找不到配置文件：' + configPath);
    log.info('复制示例后修改：');
    log.info('  Windows : copy deploy\\deploy.config.example.json deploy\\deploy.config.json');
    log.info('  macOS/Linux : cp deploy/deploy.config.example.json deploy/deploy.config.json');
    process.exit(2);
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
  } catch (e) {
    die('配置文件不是合法 JSON：' + e.message);
  }

  const cfg = Object.assign(
    {
      port: 22,
      password: process.env.LINGEE_DEPLOY_PASSWORD || '',
      privateKeyPath: '',
      passphrase: '',
      sudoPassword: '',
      remoteDir: '/opt/lingee-debug',
      serviceName: 'lingee-debug',
      runUser: '',
      appPort: 38080,
      target: 'https://app.lingee.com',
      nodeBin: '',
      keepReleases: 5,
    },
    raw
  );
  cfg.nginx = Object.assign(
    { mode: 'location', locationFile: '', serverName: 'lingee-debug.example.com', pathPrefix: '/lingee-debug/' },
    raw.nginx || {}
  );

  if (!cfg.host) die('配置缺少 host（部署机地址）');
  if (!cfg.username) die('配置缺少 username（SSH 用户名）');
  if (!cfg.privateKeyPath && !cfg.password) die('配置需要 password 或 privateKeyPath（SSH 认证）');
  if (!path.isAbsolute(cfg.remoteDir) || cfg.remoteDir.includes('..')) die('remoteDir 必须是绝对路径，例如 /opt/lingee-debug');
  cfg.remoteDir = cfg.remoteDir.replace(/\/+$/, '');
  if (!(cfg.appPort > 0 && cfg.appPort < 65536)) die('appPort 不合法：' + cfg.appPort);
  if (['location', 'server'].indexOf(cfg.nginx.mode) < 0) die('nginx.mode 只能是 location 或 server');
  if (!/^[a-zA-Z0-9._-]+$/.test(cfg.serviceName)) die('serviceName 只能包含字母、数字、点、下划线、连字符');
  cfg.keepReleases = Math.max(1, Math.min(50, Number(cfg.keepReleases) || 5));

  cfg.pathPrefix = String(cfg.nginx.pathPrefix || '/lingee-debug/').replace(/^\/+|\/+$/g, '');
  if (cfg.nginx.mode === 'location' && !cfg.pathPrefix) die('location 模式下 nginx.pathPrefix 不能为空');

  if (!cfg.nginx.locationFile) {
    cfg.nginx.locationFile =
      cfg.nginx.mode === 'server'
        ? `/etc/nginx/conf.d/${cfg.serviceName}.conf`
        : `/etc/nginx/snippets/${cfg.serviceName}.locations.conf`;
  }
  cfg.runUser = cfg.runUser || cfg.username;

  return { cfg, configPath, configDir: path.dirname(configPath) };
}

/* ---------------------------------------------------------------- SSH 层 */
class SSH {
  constructor(cfg, configDir) {
    this.cfg = cfg;
    this.configDir = configDir;
    this.client = null;
    this.isRoot = false;
    this.remoteTmp = `/tmp/${cfg.serviceName}-deploy-${crypto.randomBytes(4).toString('hex')}`;
  }

  connect() {
    const c = this.cfg;
    const opts = {
      host: c.host,
      port: Number(c.port) || 22,
      username: c.username,
      readyTimeout: 20000,
      keepaliveInterval: 10000,
      keepaliveCountMax: 3,
    };
    if (c.privateKeyPath) {
      const keyPath = path.isAbsolute(c.privateKeyPath)
        ? c.privateKeyPath
        : path.resolve(this.configDir, c.privateKeyPath);
      if (!fs.existsSync(keyPath)) throw new Error('私钥文件不存在：' + keyPath);
      opts.privateKey = Buffer.from(fs.readFileSync(keyPath, 'utf8').replace(/\r\n/g, '\n'), 'utf8');
      if (c.passphrase) opts.passphrase = c.passphrase;
    } else {
      opts.password = c.password;
    }
    const client = new Client();
    this.client = client;
    return new Promise((resolve, reject) => {
      let settled = false;
      client.once('ready', () => { settled = true; resolve(); });
      client.once('error', (e) => { if (!settled) reject(e); });
      client.connect(opts);
    });
  }

  end() {
    try { if (this.client) this.client.end(); } catch (e) { /* ignore */ }
  }

  exec(command, opts = {}) {
    const client = this.client;
    return new Promise((resolve, reject) => {
      client.exec(command, { pty: false }, (err, stream) => {
        if (err) return reject(err);
        let stdout = '';
        let stderr = '';
        stream.on('data', (d) => { stdout += d.toString('utf8'); });
        stream.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
        stream.on('close', (code) => {
          const res = { code: code == null ? -1 : code, stdout, stderr };
          if (res.code === 0 || opts.allowFail) return resolve(res);
          const detail = (stderr || stdout || '').trim();
          reject(Object.assign(new Error(`远程命令失败（exit ${res.code}）：${command}${detail ? '\n' + detail : ''}`), res));
        });
        stream.end(opts.stdin != null ? opts.stdin : '');
      });
    });
  }

  sudo(command, opts = {}) {
    if (this.isRoot) return this.exec(command, opts);
    const pw = this.cfg.sudoPassword || this.cfg.password || '';
    return this.exec(`sudo -S -p '' bash -c ${shq(command)}`, Object.assign({}, opts, { stdin: pw + '\n' }));
  }

  upload(local, remote) {
    return new Promise((resolve, reject) => {
      this.client.sftp((err, sftp) => {
        if (err) return reject(err);
        sftp.fastPut(local, remote, (e) => {
          sftp.end();
          e ? reject(e) : resolve();
        });
      });
    });
  }

  writeFile(remote, content, mode = 0o600) {
    return new Promise((resolve, reject) => {
      this.client.sftp((err, sftp) => {
        if (err) return reject(err);
        const ws = sftp.createWriteStream(remote, { mode });
        ws.on('close', () => { sftp.end(); resolve(); });
        ws.on('error', (e) => { sftp.end(); reject(e); });
        ws.end(String(content));
      });
    });
  }

  /** 把一段 bash 脚本写到远端临时文件再执行，避免层层引号 */
  async runScript(script, { sudo = false, allowFail = false } = {}) {
    const remote = `${this.remoteTmp}-${crypto.randomBytes(3).toString('hex')}.sh`;
    await this.writeFile(remote, '#!/usr/bin/env bash\nset -euo pipefail\n' + script + '\n', 0o700);
    try {
      return await (sudo ? this.sudo('bash ' + shq(remote), { allowFail }) : this.exec('bash ' + shq(remote), { allowFail }));
    } finally {
      await this.exec('rm -f ' + shq(remote), { allowFail: true }).catch(() => {});
    }
  }
}

/* -------------------------------------------------------------- 探测信息 */
async function probe(ssh) {
  const r = await ssh.exec(
    [
      'echo "USER=$(id -un)"',
      'echo "UID=$(id -u)"',
      'echo "OS=$(uname -srm 2>/dev/null || uname -a)"',
      'echo "NODE=$(command -v node >/dev/null 2>&1 && node -v || echo none)"',
      'echo "NODEBIN=$(command -v node 2>/dev/null || echo none)"',
      'echo "NGINX=$(command -v nginx >/dev/null 2>&1 && nginx -v 2>&1 | tr -d \'\\n\' || echo none)"',
      'echo "SYSTEMD=$(command -v systemctl >/dev/null 2>&1 && echo yes || echo no)"',
      'echo "CURL=$(command -v curl >/dev/null 2>&1 && echo yes || echo no)"',
    ].join('; '),
    { allowFail: true }
  );
  const out = r.stdout;
  const pick = (k) => {
    const m = out.match(new RegExp('^' + k + '=(.*)$', 'm'));
    return m ? m[1].trim() : '';
  };
  const info = {
    user: pick('USER'),
    uid: pick('UID'),
    os: pick('OS'),
    node: pick('NODE'),
    nodeBin: pick('NODEBIN'),
    nginx: pick('NGINX'),
    systemd: pick('SYSTEMD') === 'yes',
    curl: pick('CURL') === 'yes',
  };
  ssh.isRoot = info.uid === '0';
  return info;
}

/* ------------------------------------------------------------ 部署相关 */
async function ensureRemoteDirs(ssh, cfg) {
  const dirs = [`${cfg.remoteDir}`, `${cfg.remoteDir}/releases`, `${cfg.remoteDir}/shared`];
  const script = dirs.map((d) => `mkdir -p ${shq(d)}`).join('\n') + `\nchmod 755 ${shq(cfg.remoteDir)}`;
  try {
    await ssh.runScript(script);
  } catch (e) {
    await ssh.runScript(script, { sudo: true });
    // 交给运行用户，同时保证 nginx 可读
    await ssh.runScript(`chown -R ${shq(cfg.runUser)} ${shq(cfg.remoteDir)}\nchmod -R a+rX ${shq(cfg.remoteDir)}`, { sudo: true });
  }
}

async function currentRelease(ssh, cfg) {
  const r = await ssh.exec(`readlink -f ${shq(cfg.remoteDir + '/current')}`, { allowFail: true });
  return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : '';
}

async function listReleases(ssh, cfg) {
  const r = await ssh.exec(`ls -1 ${shq(cfg.remoteDir + '/releases')} 2>/dev/null || true`, { allowFail: true });
  return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean).sort();
}

async function checkHealth(ssh, cfg) {
  const url = `http://127.0.0.1:${cfg.appPort}/healthz`;
  const nodeExpr = `fetch(${JSON.stringify(url)}).then(async r=>{const t=await r.text();console.log(t);process.exit(r.ok?0:1)}).catch(e=>{console.error(String((e&&e.message)||e));process.exit(1)})`;
  const cmd =
    `if command -v curl >/dev/null 2>&1; then curl -fsS --max-time 5 ${shq(url)}; ` +
    `elif command -v wget >/dev/null 2>&1; then wget -qO- -T 5 ${shq(url)}; ` +
    `else node -e ${shq(nodeExpr)}; fi`;
  const r = await ssh.exec(cmd, { allowFail: true });
  return { ok: r.code === 0, out: (r.stdout || r.stderr || '').trim(), url };
}

/** 服务刚重启时可能还没监听，重试几次再判定失败 */
async function waitHealthy(ssh, cfg, attempts = 5, delayMs = 2000) {
  let last = null;
  for (let i = 0; i < attempts; i++) {
    last = await checkHealth(ssh, cfg);
    if (last.ok) return last;
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
  return last;
}

async function restartService(ssh, cfg) {
  await ssh.runScript(`systemctl restart ${shq(cfg.serviceName)}\nsleep 2\nsystemctl is-active --quiet ${shq(cfg.serviceName)}`, { sudo: true });
}

async function unitInstalled(ssh, cfg) {
  const r = await ssh.exec(`systemctl list-unit-files ${shq(cfg.serviceName + '.service')} --no-pager --no-legend 2>/dev/null || true`, { allowFail: true });
  return !!r.stdout.trim();
}

async function tailLogs(ssh, cfg, n = 40) {
  const r = await ssh.exec(`journalctl -u ${shq(cfg.serviceName)} -n ${n} --no-pager 2>&1 || true`, { allowFail: true });
  return r.stdout.trim();
}

async function pruneReleases(ssh, cfg) {
  const all = await listReleases(ssh, cfg);
  const stale = all.slice(0, Math.max(0, all.length - cfg.keepReleases));
  if (!stale.length) return;
  await ssh.runScript(`cd ${shq(cfg.remoteDir + '/releases')}\nrm -rf ${stale.map(shq).join(' ')}`);
  log.info(`已清理 ${stale.length} 个旧版本，保留最近 ${cfg.keepReleases} 个`);
}

/* ------------------------------------------------------------ 各命令实现 */
async function cmdHelp() {
  console.log(`
${cyan('灵基对话台 · 部署工具')}

  node deploy/deploy.js <命令> [--config=路径] [--show]

命令：
  check      检查连接、Node / nginx / systemd、目录权限、端口占用
  init       首次初始化：目录、运行环境文件、systemd 服务（不启动）
  deploy     发布新版本：打包上传 → 解压 releases → 切换 current → 重启 → 健康检查
  nginx      安装/更新独立 location 文件，nginx -t 校验后 reload（--show 只打印内容）
  rollback   回滚到上一个版本（可加 --to=版本目录名，或 --steps=N）
  status     查看服务状态、健康检查结果、版本列表
  logs       查看最近 120 行服务日志
  all        依次执行 init → deploy → nginx（首次部署一条命令完成）

配置文件默认读取 deploy/deploy.config.json，可用 --config= 指定；
字段说明见 DEPLOY.md。
`);
}

async function cmdCheck({ ssh, cfg }) {
  log.step('探测部署机');
  const info = await probe(ssh);
  log.info(`用户       ${info.user}（uid ${info.uid}${ssh.isRoot ? '，root' : ''}）`);
  log.info(`系统       ${info.os}`);
  log.info(`Node       ${info.node === 'none' ? red('未安装') : info.node + '（' + info.nodeBin + '）'}`);
  log.info(`nginx      ${info.nginx === 'none' ? red('未安装') : info.nginx}`);
  log.info(`systemd    ${info.systemd ? '可用' : red('不可用')}`);
  log.info(`curl       ${info.curl ? '可用' : '缺失（健康检查会用 node 兜底）'}`);

  log.step('检查 sudo 与目录');
  if (!ssh.isRoot) {
    const s = await ssh.exec(`sudo -n true 2>/dev/null && echo SUDO_NOPASSWD || echo SUDO_NEEDS_PASSWORD`, { allowFail: true });
    if (s.stdout.includes('SUDO_NOPASSWD')) log.ok('sudo 免密可用');
    else if (cfg.sudoPassword || cfg.password) log.warn('sudo 需要密码，将使用配置中的密码（sudoPassword 优先）');
    else log.warn('sudo 需要密码且未配置，init / nginx 可能失败');
  } else {
    log.ok('root 用户，无需 sudo');
  }

  const dirCheck = await ssh.exec(
    `echo "DIR_EXISTS=$( [ -d ${shq(cfg.remoteDir)} ] && echo yes || echo no )"; ` +
      `echo "DIR_WRITABLE=$( { [ -w ${shq(cfg.remoteDir)} ] && echo yes; } || { [ -w ${shq(path.posix.dirname(cfg.remoteDir))} ] && echo parent-only; } || echo no )"`,
    { allowFail: true }
  );
  const exists = /DIR_EXISTS=yes/.test(dirCheck.stdout);
  const writable = /DIR_WRITABLE=yes/.test(dirCheck.stdout);
  log.info(`部署目录   ${cfg.remoteDir}（${exists ? '已存在' : '不存在'}，${writable ? '可写' : '当前用户不可写，将尝试 sudo 创建'}）`);

  log.step('检查端口');
  const port = await ssh.exec(
    `(ss -lntp 2>/dev/null || netstat -lntp 2>/dev/null || true) | grep -E '[:.]${cfg.appPort}\\b' || echo FREE`,
    { allowFail: true }
  );
  if (port.stdout.includes('FREE')) log.ok(`端口 ${cfg.appPort} 空闲`);
  else {
    log.warn(`端口 ${cfg.appPort} 已被占用：`);
    log.info(port.stdout.trim());
    log.info(`若不是本服务，请在 deploy.config.json 里换一个 appPort。`);
  }

  log.step('检查服务单元');
  if (await unitInstalled(ssh, cfg)) {
    const st = await ssh.exec(`systemctl is-active ${shq(cfg.serviceName)} 2>/dev/null || true`, { allowFail: true });
    log.ok(`systemd 服务 ${cfg.serviceName} 已安装，当前状态：${st.stdout.trim() || '未知'}`);
  } else {
    log.warn(`systemd 服务 ${cfg.serviceName} 未安装（首次部署执行 init）`);
  }
}

async function cmdInit({ ssh, cfg, flags }) {
  const info = await probe(ssh);
  if (info.node === 'none') {
    die('部署机没有 Node.js。先安装 Node 18 LTS，例如：\n' +
      '  curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash - && sudo apt-get install -y nodejs\n' +
      '  或使用 nvm 安装后在 deploy.config.json 填 nodeBin');
  }
  const nodeBin = cfg.nodeBin || info.nodeBin;
  if (!nodeBin) die('无法确定 node 路径，请在 deploy.config.json 填写 nodeBin（如 /usr/bin/node）');

  log.step('创建部署目录');
  await ensureRemoteDirs(ssh, cfg);
  log.ok(`${cfg.remoteDir}/{releases,shared} 就绪`);

  log.step('写入运行环境文件 shared/app.env');
  const envPath = `${cfg.remoteDir}/shared/app.env`;
  const exists = await ssh.exec(`test -f ${shq(envPath)} && echo yes || echo no`, { allowFail: true });
  if (exists.stdout.trim() === 'yes' && !flags.force) {
    log.warn('已存在，保持不动（改端口/默认目标请手动编辑该文件，或用 --force 覆盖）');
  } else {
    const envBody = render(readTpl('app.env.tpl'), { appPort: cfg.appPort, target: cfg.target });
    await ssh.writeFile(envPath, envBody, 0o644);
    log.ok(`已写入 ${envPath}`);
  }

  log.step('安装 systemd 服务');
  const unitBody = render(readTpl('lingee-debug.service.tpl'), {
    serviceName: cfg.serviceName,
    runUser: cfg.runUser,
    remoteDir: cfg.remoteDir,
    nodeBin,
  });
  const unitTmp = `${ssh.remoteTmp}-service`;
  await ssh.writeFile(unitTmp, unitBody, 0o644);
  const unitPath = `/etc/systemd/system/${cfg.serviceName}.service`;
  const r = await ssh.runScript(
    `if [ -f ${shq(unitPath)} ]; then cp -a ${shq(unitPath)} ${shq(unitPath + '.bak-' + stamp())}; echo "已备份原服务文件"; fi
install -m 644 ${shq(unitTmp)} ${shq(unitPath)}
rm -f ${shq(unitTmp)}
systemctl daemon-reload
systemctl enable ${shq(cfg.serviceName)} >/dev/null 2>&1 || true
echo "UNIT_OK"`,
    { sudo: true }
  );
  log.info(r.stdout.trim());
  log.ok(`已安装并设为开机自启：${unitPath}`);

  log.step('初始化完成');
  log.info('下一步：node deploy/deploy.js deploy   发布第一个版本');
  log.info('然后：  node deploy/deploy.js nginx    安装 location 文件并 reload');
}

function makeBundle() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lingee-deploy-'));
  const tarPath = path.join(tmpDir, 'release.tgz');
  const tarArgs = ['-czf', toPosix(tarPath), 'server.js', 'package.json', 'public'];
  try {
    execFileSync('tar', tarArgs, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    const detail = e && e.stderr ? e.stderr.toString().trim() : e.message;
    throw new Error('本地打包失败（需要系统自带 tar 命令）：' + detail);
  }
  const size = fs.statSync(tarPath).size;
  return {
    tarPath,
    size,
    cleanup() {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    },
  };
}

async function cmdDeploy({ ssh, cfg }) {
  if (!(await unitInstalled(ssh, cfg))) {
    die('systemd 服务尚未安装。先执行：node deploy/deploy.js init');
  }

  const releaseId = stamp();
  const releaseDir = `${cfg.remoteDir}/releases/${releaseId}`;
  const previous = await currentRelease(ssh, cfg);

  log.step('打包本地文件');
  const bundle = makeBundle();
  try {
    log.ok(`server.js + package.json + public/ → ${(bundle.size / 1024).toFixed(1)} KB`);

    log.step('上传到部署机');
    await ensureRemoteDirs(ssh, cfg);
    const remoteTgz = `${cfg.remoteDir}/shared/release-${releaseId}.tgz`;
    await ssh.upload(bundle.tarPath, remoteTgz);
    log.ok(`已上传 ${remoteTgz}`);

    log.step(`解压到 releases/${releaseId}`);
    await ssh.runScript(
      `mkdir -p ${shq(releaseDir)}
tar -xzf ${shq(remoteTgz)} -C ${shq(releaseDir)}
rm -f ${shq(remoteTgz)}
chmod -R a+rX ${shq(releaseDir)}
test -f ${shq(releaseDir + '/server.js')} || { echo "发布包缺少 server.js"; exit 1; }
test -d ${shq(releaseDir + '/public')} || { echo "发布包缺少 public/"; exit 1; }
echo OK`
    );
    log.ok('解压完成');

    log.step('切换 current 并重启服务');
    await ssh.runScript(
      `cd ${shq(cfg.remoteDir)}
ln -sfn ${shq('releases/' + releaseId)} current
ls -l current`
    );
    log.info((await ssh.exec(`ls -l ${shq(cfg.remoteDir + '/current')}`, { allowFail: true })).stdout.trim());
    await restartService(ssh, cfg);
    log.ok(`服务 ${cfg.serviceName} 已重启`);

    log.step('健康检查');
    const health = await waitHealthy(ssh, cfg);
    if (!health.ok) {
      log.err(`健康检查失败：${health.url} 无响应`);
      const logs = await tailLogs(ssh, cfg, 40);
      if (logs) log.info('最近日志：\n' + logs);
      if (previous) {
        log.warn('尝试回滚到 ' + path.posix.basename(previous));
        await ssh.runScript(`cd ${shq(cfg.remoteDir)}\nln -sfn ${shq(path.posix.relative(cfg.remoteDir, previous))} current`, { allowFail: true });
        await restartService(ssh, cfg).catch(() => {});
        const again = await waitHealthy(ssh, cfg);
        log.warn(again.ok ? '已回滚，服务恢复' : '回滚后仍不健康，请人工介入');
      }
      throw new Error('发布失败，旧版本保持不变或已回滚');
    }
    log.ok(`健康检查通过：${health.out}`);

    log.step('清理旧版本');
    await pruneReleases(ssh, cfg);

    console.log('');
    log.ok(`发布完成：${releaseId}`);
    if (previous) log.info(`上一版本：${path.posix.basename(previous)}（可用 rollback 回退）`);
  } finally {
    bundle.cleanup();
  }
}

async function cmdNginx({ ssh, cfg, flags }) {
  const isServerMode = cfg.nginx.mode === 'server';
  const tplName = isServerMode ? 'lingee-debug.server.conf.tpl' : 'lingee-debug.locations.conf.tpl';
  const body = render(readTpl(tplName), {
    serviceName: cfg.serviceName,
    remoteDir: cfg.remoteDir,
    appPort: cfg.appPort,
    serverName: cfg.nginx.serverName || cfg.host,
    pathPrefix: cfg.pathPrefix,
    prefix: cfg.pathPrefix,
    locationFile: cfg.nginx.locationFile,
  });

  if (flags.show) {
    console.log('\n' + dim('# ' + tplName + ' → ' + cfg.nginx.locationFile) + '\n');
    console.log(body);
    return;
  }

  log.step('上传 nginx 配置');
  const hasNginx = await ssh.exec('command -v nginx >/dev/null 2>&1 && echo yes || echo no', { allowFail: true });
  if (!hasNginx.stdout.includes('yes')) die('部署机未安装 nginx（或不在 PATH 中），请先安装后再执行 nginx 命令');
  const tmp = `${ssh.remoteTmp}-nginx.conf`;
  await ssh.writeFile(tmp, body, 0o644);
  const target = cfg.nginx.locationFile;
  const backup = `${target}.bak-${stamp()}`;
  const r = await ssh.runScript(
    `TARGET=${shq(target)}
TMP=${shq(tmp)}
BACKUP=${shq(backup)}
mkdir -p "$(dirname "$TARGET")"
if [ -f "$TARGET" ]; then cp -a "$TARGET" "$BACKUP"; echo "已备份：$BACKUP"; else echo "首次安装：$TARGET"; fi
install -m 644 "$TMP" "$TARGET"
rm -f "$TMP"
if nginx -t; then
  if systemctl reload nginx >/dev/null 2>&1; then echo "RELOAD=systemctl"; else nginx -s reload; echo "RELOAD=nginx -s"; fi
  echo "NGINX_OK"
else
  echo "NGINX_TEST_FAILED"
  if [ -f "$BACKUP" ]; then cp -a "$BACKUP" "$TARGET"; echo "已回滚 nginx 配置"; fi
  exit 1
fi`,
    { sudo: true, allowFail: true }
  );
  log.info(r.stdout.trim());
  if (r.code !== 0 || !/NGINX_OK/.test(r.stdout)) {
    die('nginx 配置未通过校验，已保留/回滚原配置，未 reload');
  }
  log.ok('nginx 配置已安装并 reload');

  if (isServerMode) {
    log.info(`访问入口：http://${cfg.nginx.serverName || cfg.host}/`);
    log.info('如需 HTTPS，请在该 server 块补 443 监听与证书，或由外层统一跳转。');
  } else {
    log.info(`若尚未挂载，请在目标站点的 server { } 内加入：`);
    log.info(`    include ${target};`);
    log.info(`访问入口：https://<你的域名>/${cfg.pathPrefix}/`);
  }
  log.info('挂载后请执行：nginx -t && nginx -s reload');
}

async function cmdRollback({ ssh, cfg, flags }) {
  const all = await listReleases(ssh, cfg);
  if (all.length < 2) die('只有一个版本，无法回滚');
  const current = path.posix.basename(await currentRelease(ssh, cfg));
  let target;
  if (flags.to) {
    if (all.indexOf(String(flags.to)) < 0) die('版本不存在：' + flags.to + '（可用：' + all.join(', ') + '）');
    target = String(flags.to);
  } else {
    const steps = Math.max(1, Number(flags.steps) || 1);
    const idx = all.indexOf(current);
    const fromIndex = idx >= 0 ? idx : all.length - 1;
    target = all[Math.max(0, fromIndex - steps)];
  }
  if (target === current) die('目标版本与当前版本相同：' + target);

  log.step(`回滚：${current} → ${target}`);
  await ssh.runScript(`cd ${shq(cfg.remoteDir)}\nln -sfn ${shq('releases/' + target)} current`);
  await restartService(ssh, cfg);
  const health = await waitHealthy(ssh, cfg);
  if (!health.ok) {
    log.err('回滚后健康检查未通过');
    log.info(await tailLogs(ssh, cfg, 40));
    die('请人工检查');
  }
  log.ok(`已回滚到 ${target}，健康检查通过：${health.out}`);
}

async function cmdStatus({ ssh, cfg }) {
  log.step('服务状态');
  const active = await ssh.exec(`systemctl is-active ${shq(cfg.serviceName)} 2>/dev/null || true`, { allowFail: true });
  const enabled = await ssh.exec(`systemctl is-enabled ${shq(cfg.serviceName)} 2>/dev/null || true`, { allowFail: true });
  log.info(`systemd    ${cfg.serviceName}：${active.stdout.trim() || '未安装'}（开机自启：${enabled.stdout.trim() || '未知'}）`);

  const health = await checkHealth(ssh, cfg);
  if (health.ok) log.ok(`健康检查  ${health.url} → ${health.out}`);
  else log.err(`健康检查  ${health.url} 无响应`);

  const current = path.posix.basename(await currentRelease(ssh, cfg));
  const all = await listReleases(ssh, cfg);
  log.step('版本列表');
  if (!all.length) log.info('（无）');
  all.slice().reverse().forEach((v) => {
    log.info((v === current ? green('● ') : '  ') + v + (v === current ? '  ← current' : ''));
  });

  const unit = await ssh.exec(`systemctl status ${shq(cfg.serviceName)} --no-pager 2>&1 | head -n 12 || true`, { allowFail: true });
  if (unit.stdout.trim()) {
    log.step('最近状态输出');
    log.info(unit.stdout.trim());
  }
}

async function cmdLogs({ ssh, cfg }) {
  log.step(`最近日志（${cfg.serviceName}）`);
  const logs = await tailLogs(ssh, cfg, 120);
  log.info(logs || '（无日志）');
}

async function cmdAll(ctx) {
  await cmdInit(ctx);
  await cmdDeploy(ctx);
  await cmdNginx(ctx);
  log.step('全部完成');
  if (ctx.cfg.nginx.mode === 'location') {
    log.warn('若 location 文件是第一次安装，请确认已在目标 server { } 中 include 它：');
    log.info(`    include ${ctx.cfg.nginx.locationFile};`);
    log.info('改完执行 nginx -t && nginx -s reload');
  } else {
    log.info(`访问入口：http://${ctx.cfg.nginx.serverName || ctx.cfg.host}/`);
  }
}

const COMMANDS = {
  check: cmdCheck,
  init: cmdInit,
  deploy: cmdDeploy,
  nginx: cmdNginx,
  rollback: cmdRollback,
  status: cmdStatus,
  logs: cmdLogs,
  all: cmdAll,
  help: cmdHelp,
};

/* ------------------------------------------------------------------ 入口 */
(async function main() {
  const args = process.argv.slice(2);
  const flags = {};
  const positional = [];
  for (const a of args) {
    if (a === '--help' || a === '-h') positional.push('help');
    else if (a.startsWith('--')) {
      const body = a.slice(2);
      const eq = body.indexOf('=');
      if (eq >= 0) flags[body.slice(0, eq)] = body.slice(eq + 1);
      else flags[body] = true;
    } else positional.push(a);
  }
  const command = positional[0] || 'help';

  if (command === 'help' || !COMMANDS[command]) {
    if (command !== 'help') log.err('未知命令：' + command);
    await cmdHelp();
    process.exit(command === 'help' ? 0 : 2);
  }
  if (command === 'nginx' && flags.show) {
    // 只渲染不改远端：不建立 SSH 连接
    const { cfg } = loadConfig(flags.config);
    const tplName = cfg.nginx.mode === 'server' ? 'lingee-debug.server.conf.tpl' : 'lingee-debug.locations.conf.tpl';
    const body = render(readTpl(tplName), {
      serviceName: cfg.serviceName,
      remoteDir: cfg.remoteDir,
      appPort: cfg.appPort,
      serverName: cfg.nginx.serverName || cfg.host,
      pathPrefix: cfg.pathPrefix,
      prefix: cfg.pathPrefix,
      locationFile: cfg.nginx.locationFile,
    });
    console.log('\n' + dim('# ' + tplName + ' → ' + cfg.nginx.locationFile) + '\n');
    console.log(body);
    return;
  }

  const { cfg, configDir } = loadConfig(flags.config);
  const ssh = new SSH(cfg, configDir);
  log.step(`连接 ${cfg.username}@${cfg.host}:${cfg.port || 22}`);
  try {
    await ssh.connect();
  } catch (e) {
    ssh.end();
    die('SSH 连接失败：' + (e && e.message ? e.message : e));
  }
  log.ok('已连接');

  try {
    await COMMANDS[command]({ ssh, cfg, flags });
  } finally {
    ssh.end();
  }
})().catch((e) => {
  log.err(e && e.message ? e.message : String(e));
  process.exitCode = 1;
});