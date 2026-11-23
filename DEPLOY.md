# 灵基对话台（lg-front-debug）· 部署文档

> 适用版本：v1.0.6 及以上（实际版本号以 `package.json` 的 `version` 为准，`/healthz` 也会返回它）
> 目标环境：Linux 服务器 + nginx + systemd
> 相关文件：[deploy/deploy.js](deploy/deploy.js)（自动化脚本）、[deploy/deploy.config.example.json](deploy/deploy.config.example.json)（配置模板）、[deploy/templates/](deploy/templates/)（nginx / systemd 模板）

---

## 0. 一页速览

```text
浏览器
  │  https://<你的域名>/lingee-debug/
  ▼
nginx ── /lingee-debug/       → /opt/lingee-debug/current/public/     （静态文件直接读）
      └─ /lingee-debug/api/   → http://127.0.0.1:38080/api/           （SSE 流式转发）
                                        │
                                        ▼
                              server.js（systemd 托管，只监听 127.0.0.1）
                                        │  页面「服务地址」通过 X-Target 头指定目标环境
                                        ▼
                              灵基 OpenAPI 环境（默认 https://app.lingee.com）
```

| 项 | 值 |
|---|---|
| 部署形态 | 前端静态文件 + 一个零依赖 Node 转发进程 |
| 构建 | **不需要构建**，仓库里就是产物；服务器上不执行 `npm install` |
| Node 版本 | 18+（建议 20 LTS），仅运行 `server.js` |
| 进程端口 | `127.0.0.1:38080`（可改，不对外开放） |
| 对外入口 | 由 nginx 提供，建议 HTTPS |
| 首次部署 | `node deploy/deploy.js all` + 在站点里 include 一个 location 文件 |
| 日常更新 | `node deploy/deploy.js deploy` |
| 回滚 | `node deploy/deploy.js rollback` |

---

## 1. 部署内容

### 1.1 上线哪些文件

每次发布实际传输的只有这三项（`deploy/deploy.js` 自动打包）：

| 路径 | 作用 | 是否必需 |
|---|---|---|
| `public/` | 前端页面、样式、JS 模块（ES Module，无构建） | 必需 |
| `server.js` | 同源 `/api/*` 转发 + 静态托管 + `/healthz` 健康检查 | 必需 |
| `package.json` | 版本号（`/healthz` 会读取）与元信息 | 必需 |

以下目录/文件**不上线**：`docs/`（接口文档）、`test/`（自测与 mock）、`start.js`、`启动-*.bat/sh`、`README.md`（可选，systemd 的 Documentation 指向它，不存在也不影响运行）、`deploy/`（部署工具，只在本地用）。

`public/` 内清单：

```text
public/
├── index.html
├── assets/styles.css
└── js/
    ├── app.js        界面控制器
    ├── api.js        令牌签发 / Bearer 请求 / 401 重签
    ├── sse.js        SSE 解析与通道
    ├── turns.js      轮次与轮询兜底
    ├── resources.js  模型 / 工具 / 智能体缓存
    ├── store.js      配置与会话存储
    ├── markdown.js   Markdown 渲染
    ├── chart.js      图表围栏渲染
    ├── debug.js      调试看板
    ├── crypto.js     SHA-256 / HMAC
    └── package.json  "type": "module"
```

### 1.2 服务器上的目录结构

```text
/opt/lingee-debug/                 ← remoteDir，可改
├── releases/
│   ├── 20261123-141530/           ← 每个版本一个目录：server.js / package.json / public/
│   └── 20261123-163000/           ← 新版本
├── current -> releases/20261123-163000   ← 原子切换的软链接，nginx 与 systemd 都指向它
└── shared/
    └── app.env                    ← 运行参数（HOST / PORT / TARGET），首次初始化生成

/etc/systemd/system/lingee-debug.service            ← 由 init 生成
/etc/nginx/snippets/lingee-debug.locations.conf     ← 由 nginx 命令生成（独立 location 文件）
```

> `current` 是软链接：切换版本 = 改指向，秒级生效、可随时回滚；旧版本目录保留最近 5 个（可配）。

### 1.3 前置条件（部署前逐项确认）

| 项 | 要求 | 检查命令 |
|---|---|---|
| 操作系统 | 主流 Linux，带 systemd | `systemctl --version` |
| Node.js | 18 及以上（20 LTS 建议） | `node -v` |
| nginx | 1.18 及以上，已作为站点服务运行 | `nginx -v` |
| SSH | 本机能用密码或私钥登录部署机 | `ssh user@host` |
| 部署账号 | 对 `remoteDir` 有写权限；能 `sudo` 执行 systemctl / nginx | `sudo -n true` |
| 端口 | `appPort`（默认 38080）未被占用 | `ss -lntp \| grep 38080` |
| 网络 | 部署机能访问灵基环境（默认 `app.lingee.com:443`） | `curl -I https://app.lingee.com` |
| 域名 | 已备案/解析到该服务器（对外访问用） | — |

Node 未安装时（Debian/Ubuntu）：

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

（RHEL/CentOS：`sudo dnf install -y nodejs`；内网离线环境用二进制包解压后把路径填到配置的 `nodeBin`。）

### 1.4 端口与路径规划建议

| 用途 | 默认值 | 说明 |
|---|---|---|
| Node 服务端口 | `38080` | 只监听 `127.0.0.1`，由 nginx 转发；冲突时改配置里的 `appPort` |
| 对外路径 | `/lingee-debug/` | 改 `nginx.pathPrefix`；页面内部接口前缀自动跟随，见 §2.6 |
| 部署目录 | `/opt/lingee-debug` | 改 `remoteDir` |
| 服务名 | `lingee-debug` | 改 `serviceName` |

---

## 2. nginx 配置（独立 location 文件）

### 2.1 先选方案

| 方案 | 适用 | 访问地址 | 需要改页面代码 |
|---|---|---|---|
| **A. 子路径（推荐，本文主方案）** | 已有站点/域名，挂一个独立前缀 | `https://域名/lingee-debug/` | 不需要（接口前缀自动推导） |
| B. 独立域名/子域名 | 给工具单独分配域名 | `https://lingee-debug.域名/` | 不需要 |

两种方案都由 `deploy/deploy.js nginx` 安装，模板分别见 §2.2 与 §2.4。

### 2.2 独立 location 文件（方案 A，部署后的实际内容）

文件：`/etc/nginx/snippets/lingee-debug.locations.conf`
（生成来源：[deploy/templates/lingee-debug.locations.conf.tpl](deploy/templates/lingee-debug.locations.conf.tpl)；下面是与默认配置对应的渲染结果，路径/端口不同时不要手改，改配置后重新执行 `nginx` 命令）

```nginx
# 带路径不带结尾斜杠时补斜杠：页面相对路径与接口前缀都依赖这个尾斜杠
location = /lingee-debug {
    return 301 /lingee-debug/;
}

# 前端静态文件：nginx 直接读取发布目录，不经过 Node 进程
# ^~ 表示命中后不再尝试同级的正则 location，避免站点已有的 .js/.css 规则抢走请求
location ^~ /lingee-debug/ {
    alias /opt/lingee-debug/current/public/;
    index index.html;
    autoindex off;

    # 文件名不带内容哈希，用 ETag 协商缓存，避免更新后浏览器继续用旧文件
    etag on;
    add_header Cache-Control "no-cache" always;
    add_header X-Content-Type-Options "nosniff" always;
}

# 接口转发：/lingee-debug/api/... → Node 的 /api/...
location ^~ /lingee-debug/api/ {
    proxy_pass http://127.0.0.1:38080/api/;
    proxy_http_version 1.1;

    proxy_set_header Connection "";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Accept-Encoding "";

    # SSE 必须关闭缓冲与压缩，否则流式输出会被整段缓存后一次性下发
    proxy_buffering off;
    proxy_request_buffering off;
    proxy_cache off;
    gzip off;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    chunked_transfer_encoding on;

    client_max_body_size 20m;
}
```

要点解释：

| 配置 | 原因 |
|---|---|
| `alias .../current/public/` | 直接由 nginx 出静态文件，Node 只负责 `/api`，省资源且与本地表现一致 |
| `current` 软链 | 发布时只切换链接，无需改 nginx、无需 reload |
| `location = /xxx` 301 | 页面里的 `./js/app.js` 与自动推导的接口前缀都要求 URL 以 `/` 结尾 |
| `^~` | 防止站点已有的 `location ~* \.(js\|css)$` 一类正则把请求截走 |
| `proxy_buffering off` + `gzip off` | 本应用是 SSE 流式输出，任何缓冲/压缩都会让回答“憋”到最后才出现 |
| `proxy_read_timeout 3600s` | 长回答可能持续数分钟，默认 60s 会被 nginx 掐断 |
| `proxy_pass .../api/` 尾部斜杠 | 把 `/lingee-debug/api/` 前缀剥掉，Node 只认 `/api/...` |
| `Cache-Control: no-cache` + ETag | 文件未变命中 304，文件变了立即拿到新内容 |

### 2.3 挂载步骤（方案 A）

1. 找到承载该域名的 `server { ... }` 块（通常是 `/etc/nginx/conf.d/xxx.conf` 或 `/etc/nginx/sites-enabled/xxx`；HTTPS 站点就是监听 443 的那个）。
2. 在块内加一行 include（路径与配置里的 `nginx.locationFile` 一致）：

   ```nginx
   server {
       listen 443 ssl;
       server_name your.domain.com;

       include /etc/nginx/snippets/lingee-debug.locations.conf;

       # ... 原有配置
   }
   ```

   > 不要把这个文件放进会被 `include /etc/nginx/conf.d/*.conf;` 自动加载的目录——那样 location 会出现在 server 之外，`nginx -t` 会报错。

3. 校验并生效：

   ```bash
   sudo nginx -t && sudo nginx -s reload
   ```

4. 浏览器打开 `https://your.domain.com/lingee-debug/`。

### 2.4 方案 B：独立域名 server 块

模板：[deploy/templates/lingee-debug.server.conf.tpl](deploy/templates/lingee-debug.server.conf.tpl)（配置里把 `nginx.mode` 设为 `server`，`locationFile` 设为如 `/etc/nginx/conf.d/lingee-debug.conf`，脚本安装后会自动 reload）。

```nginx
server {
    listen 80;
    server_name lingee-debug.example.com;

    client_max_body_size 20m;

    location ^~ / {
        alias /opt/lingee-debug/current/public/;
        index index.html;
        autoindex off;
        etag on;
        add_header Cache-Control "no-cache" always;
        add_header X-Content-Type-Options "nosniff" always;
    }

    location ^~ /api/ {
        proxy_pass http://127.0.0.1:38080/api/;
        # 其余 SSE 相关参数与 §2.2 完全相同
    }
}
```

HTTPS 在该 server 块补 `listen 443 ssl;` 与证书，或由外层统一 80 → 443 跳转。

### 2.5 生成与安装（脚本方式）

```powershell
node deploy/deploy.js nginx --show   # 只打印将生成的配置，不上传
node deploy/deploy.js nginx          # 上传 → 备份旧文件 → nginx -t → reload（失败自动回滚）
```

脚本行为：目标文件已存在时备份为 `*.bak-<时间戳>`；`nginx -t` 不通过就把备份还原并退出，不会把坏配置留在线上。

### 2.6 路径部署为什么不用改代码

前端启动时会根据自身模块地址推导接口前缀：

- 页在 `/lingee-debug/` → 接口走 `/lingee-debug/api/...`
- 页在站点根或独立域名 → 接口走 `/api/...`

所以 `nginx.pathPrefix` 改成任意前缀（如 `/lg/`）都能直接工作，不需要重新打包或改代码。

---

## 3. 后续更新

### 3.1 日常发布（一条命令）

```powershell
node deploy/deploy.js deploy
```

脚本按顺序做：

1. 本地打包 `server.js + package.json + public/`；
2. 通过 SFTP 上传到 `/opt/lingee-debug/shared/release-<时间戳>.tgz`；
3. 解压到 `releases/<时间戳>/`，补读权限（`a+rX`，让 nginx 可读）；
4. `ln -sfn releases/<时间戳> current` 原子切换；
5. `systemctl restart lingee-debug`；
6. 本机 `curl 127.0.0.1:38080/healthz` 健康检查；
7. 失败自动回滚到上一版本并打印日志；成功则清理旧版本（保留最近 `keepReleases` 个，默认 5）。

> 不重启 nginx、不改 nginx 配置：静态文件每次请求都按 `current` 解析，切换后新页面立即生效。

### 3.2 验证发布结果

```powershell
node deploy/deploy.js status
```

输出服务状态、健康检查、版本列表（`●` 为当前版本）。也可以手工验证：

```bash
curl -s http://127.0.0.1:38080/healthz
curl -I https://your.domain.com/lingee-debug/
curl -s https://your.domain.com/lingee-debug/js/app.js | head -n 3
```

浏览器侧：刷新页面即可；`index.html` 与 JS 都带 ETag，未变则 304，变了立即取新文件。已经打开的旧标签页建议刷新一次。

### 3.3 回滚

```powershell
node deploy/deploy.js rollback                 # 回到上一版本
node deploy/deploy.js rollback --steps=2       # 往前退两版
node deploy/deploy.js rollback --to=20261123-141530
```

回滚同样会重启服务并做健康检查。版本目录按时间戳排序，`releases/` 下随时可查。

### 3.4 只改了 nginx 配置

```powershell
# 改 deploy/templates/*.tpl 或 deploy.config.json 的 nginx 段
node deploy/deploy.js nginx --show   # 先看内容
node deploy/deploy.js nginx          # 安装并 reload（自带 nginx -t 与回滚）
```

### 3.5 改运行参数（端口 / 默认目标环境）

编辑服务器上的 `/opt/lingee-debug/shared/app.env`：

```ini
HOST=127.0.0.1
PORT=38080
TARGET=https://app.lingee.com
```

```bash
sudo systemctl restart lingee-debug
```

若改了 `PORT`，记得同步 nginx location 里的 `proxy_pass` 端口，再 `nginx -t && nginx -s reload`。
（更省事的做法：改 `deploy.config.json` 的 `appPort`，执行 `init --force` 重写 env，再执行 `nginx`，最后 `deploy`。）

`TARGET` 只是默认值；页面「连接设置 → 服务地址」会用 `X-Target` 头覆盖，支持在同一部署上切换多个环境。

### 3.6 每次更新后的检查清单

- [ ] `node deploy/deploy.js status` 健康检查通过
- [ ] 页面能打开，控制台无 404 / MIME 报错
- [ ] 「连接设置 → 获取令牌」成功，模型/工具/智能体列表能拉取
- [ ] 发一条消息，回答**逐字**出现（验证 SSE 未被缓冲）
- [ ] 如本次改了 nginx：`sudo nginx -t` 通过，站点其他应用未受影响

---

## 4. 部署命令（自动化脚本）

工具：[deploy/deploy.js](deploy/deploy.js)（基于 `ssh2`，Windows / macOS / Linux 通用）。

### 4.1 准备配置

```powershell
cd D:\workspace\202611-灵基OPENAPI\lg-front-debug
npm install --prefix deploy
copy deploy\deploy.config.example.json deploy\deploy.config.json
```

编辑 `deploy/deploy.config.json`（**含密码，已在 .gitignore 中，不要提交**）：

```json
{
  "host": "192.168.1.20",
  "port": 22,
  "username": "deploy",
  "password": "部署机登录密码",
  "privateKeyPath": "",
  "passphrase": "",
  "sudoPassword": "",
  "remoteDir": "/opt/lingee-debug",
  "serviceName": "lingee-debug",
  "runUser": "",
  "appPort": 38080,
  "target": "https://app.lingee.com",
  "nodeBin": "",
  "keepReleases": 5,
  "nginx": {
    "mode": "location",
    "locationFile": "/etc/nginx/snippets/lingee-debug.locations.conf",
    "serverName": "lingee-debug.example.com",
    "pathPrefix": "/lingee-debug/"
  }
}
```

字段说明：

| 字段 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `host` | 是 | — | 部署机 IP / 域名 |
| `port` | 否 | `22` | SSH 端口 |
| `username` | 是 | — | SSH 用户 |
| `password` | 二选一 | — | SSH 密码；也可用环境变量 `LINGEE_DEPLOY_PASSWORD` 覆盖 |
| `privateKeyPath` | 二选一 | — | 私钥路径（相对路径按配置文件目录解析）；优先于密码 |
| `passphrase` | 否 | — | 私钥口令 |
| `sudoPassword` | 否 | 同 `password` | sudo 密码；目标账号 `NOPASSWD` 时可不填 |
| `remoteDir` | 否 | `/opt/lingee-debug` | 部署根目录（绝对路径） |
| `serviceName` | 否 | `lingee-debug` | systemd 服务名 |
| `runUser` | 否 | 同 `username` | 服务运行用户；改它需保证该用户可读部署目录 |
| `appPort` | 否 | `38080` | Node 监听端口（只绑 127.0.0.1） |
| `target` | 否 | `https://app.lingee.com` | 默认转发目标，写入 `shared/app.env` |
| `nodeBin` | 否 | 自动探测 | Node 可执行文件绝对路径（nvm 环境建议显式填写） |
| `keepReleases` | 否 | `5` | 保留的历史版本数 |
| `nginx.mode` | 否 | `location` | `location`=子路径独立文件；`server`=独立域名整个 server 块 |
| `nginx.locationFile` | 否 | 见上 | 安装到的绝对路径 |
| `nginx.serverName` | server 模式必填 | — | 独立域名 |
| `nginx.pathPrefix` | 否 | `/lingee-debug/` | location 模式的访问前缀 |

### 4.2 首次部署（三步）

```powershell
node deploy/deploy.js check    # 1. 连通性、Node/nginx/systemd、权限、端口
node deploy/deploy.js init     # 2. 建目录、写 app.env、安装并启用 systemd 服务
node deploy/deploy.js deploy   # 3. 发布第一个版本并健康检查
node deploy/deploy.js nginx    # 4. 安装独立 location 文件并 reload
```

也可以一条命令：

```powershell
node deploy/deploy.js all
```

（`all` 之后仍需按 §2.3 在站点 `server { }` 里加 include 并 reload——这一步要改的是你现有站点的配置文件，脚本不替你做。）

### 4.3 日常命令

| 命令 | 作用 |
|---|---|
| `node deploy/deploy.js check` | 上线前体检：SSH、Node、nginx、systemd、sudo、目录、端口 |
| `node deploy/deploy.js init` | 初始化/修复：目录、`shared/app.env`、systemd 服务（`--force` 覆盖 env） |
| `node deploy/deploy.js deploy` | 发布新版本（原子切换 + 重启 + 健康检查 + 自动回滚） |
| `node deploy/deploy.js nginx` | 安装/更新 location 文件（`nginx -t` 失败自动还原），`--show` 只预览 |
| `node deploy/deploy.js rollback` | 回滚上一版（`--steps=N` / `--to=版本名`） |
| `node deploy/deploy.js status` | 服务状态、健康检查、版本列表 |
| `node deploy/deploy.js logs` | 最近 120 行 `journalctl` 日志 |
| `node deploy/deploy.js all` | init → deploy → nginx |

通用参数：`--config=路径` 指定配置文件；`--show`（仅 nginx）只渲染不安装。

### 4.4 脚本的安全与边界

- **不会**覆盖已存在的 `shared/app.env`（除 `init --force`），避免误改线上端口。
- 安装 systemd / nginx 配置前会备份为 `*.bak-<时间戳>`；`nginx -t` 失败自动还原。
- 健康检查失败自动回滚到上一版本（若存在），并输出最近日志。
- 只重启自己的 systemd 服务，不重启 nginx（除非执行 `nginx` 命令）。
- 密码只保存在本地 `deploy/deploy.config.json`（建议 `chmod 600` / Windows 下不与他人共享目录），不写入服务器、不进入发布包。

### 4.5 使用密钥登录（推荐）

```json
{
  "privateKeyPath": "C:/Users/you/.ssh/id_ed25519",
  "passphrase": "",
  "password": ""
}
```

---

## 5. 附录

### A. 纯手工部署（不用脚本，供对照/应急）

```bash
# 1) 目录
sudo mkdir -p /opt/lingee-debug/{releases,shared}
sudo chown -R $USER /opt/lingee-debug

# 2) 上传（在本地执行）
scp -r public server.js package.json user@host:/tmp/lg-release/
ssh user@host 'mkdir -p /opt/lingee-debug/releases/$(date +%Y%m%d-%H%M%S)'

# 3) 落位并切换
ssh user@host '
  R=/opt/lingee-debug/releases/$(date +%Y%m%d-%H%M%S)
  mkdir -p $R && tar -C /tmp/lg-release -cf - . | tar -C $R -xf -
  chmod -R a+rX $R
  ln -sfn $R /opt/lingee-debug/current
'

# 4) app.env
sudo tee /opt/lingee-debug/shared/app.env >/dev/null <<'EOF'
HOST=127.0.0.1
PORT=38080
TARGET=https://app.lingee.com
NODE_ENV=production
EOF

# 5) systemd
sudo tee /etc/systemd/system/lingee-debug.service >/dev/null <<'EOF'
[Unit]
Description=lingee-debug
After=network-online.target
[Service]
Type=simple
User=deploy
WorkingDirectory=/opt/lingee-debug/current
EnvironmentFile=/opt/lingee-debug/shared/app.env
ExecStart=/usr/bin/env node server.js
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload && sudo systemctl enable --now lingee-debug

# 6) 健康检查
curl -s http://127.0.0.1:38080/healthz

# 7) nginx：把 §2.2 的 location 文件写到 /etc/nginx/snippets/，
#    在站点 server 块 include，然后 nginx -t && nginx -s reload
```

### B. 故障排查

| 现象 | 常见原因 | 处理 |
|---|---|---|
| `502 Bad Gateway` / 页面能开但接口 502 | Node 服务没起来、端口不一致 | `systemctl status lingee-debug`；`journalctl -u lingee-debug -n 50`；`curl 127.0.0.1:38080/healthz`；核对 `app.env` 的 `PORT` 与 nginx `proxy_pass` |
| 接口 404（`/lingee-debug/api/...`） | include 未生效 / 被别的 location 抢走 / `proxy_pass` 少了尾部 `/api/` | `sudo nginx -T \| grep -n "lingee-debug"`；确认 `location ^~ /lingee-debug/api/` 与 `proxy_pass http://127.0.0.1:38080/api/;` |
| 回答不是逐字出现，而是一次性整段刷出 | nginx 缓冲/压缩没关 | 确认该 location 里 `proxy_buffering off; gzip off;` 且没有更靠前的正则 location 覆盖 |
| 回答几分钟后中断 | 读超时太短 | `proxy_read_timeout 3600s;`（默认 60s） |
| 静态文件 403 | nginx 用户无读权限 | `sudo chmod -R a+rX /opt/lingee-debug/releases/*` |
| 静态文件 404，目录访问正常 | 访问 URL 少了尾斜杠 / `alias` 路径写错 | 用 `curl -I https://域名/lingee-debug/` 看是否为 301 到带斜杠 |
| 页面白屏，控制台报 MIME 类型错误 | nginx 未加载 `mime.types` | 主配置 `http { include mime.types; }` |
| `502 PROXY_ERROR`（应用内错误卡片） | Node 到目标环境网络不通 | 在部署机 `curl -I https://app.lingee.com`；检查出网策略/代理 |
| `5001233062 验签失败` | App Secret / 租户 / 应用不一致 | 页面「连接设置」核对；Secret 只在浏览器本地 |
| `5001233063 时间戳超时` | 服务器/浏览器时间偏差超过 300 秒 | 校时（`timedatectl`） |
| `5001233066 来源 IP 不在白名单` | 出口 IP 未报备 | 在灵基应用里放宽 IP/CIDR |
| 首次 `init` 报 sudo 相关错误 | 账号无 sudo 或密码不同 | 配 `sudoPassword`，或给该账号 `NOPASSWD` 权限 |
| `deploy` 报“服务未安装” | 跳过了 init | 先执行 `node deploy/deploy.js init` |
| 健康检查失败但服务是 active | 端口/路径不对，或服务启动后立即退出 | 看 `logs`；确认 `app.env` 端口与 `appPort` 一致 |

### C. 安全建议

1. **对外必须上 HTTPS**：页面里要填 App Secret（仅存浏览器 localStorage，但传输需加密）。
2. Node 进程保持 `HOST=127.0.0.1`，只让 nginx 访问；不要把 38080 开到公网。
3. `deploy/deploy.config.json` 含密码：不要提交、不要放共享盘；建议改用 SSH 密钥并给 `sudo` 最小权限（仅 `systemctl restart lingee-debug`、`nginx -t/reload`、写配置文件）。
4. 建议在 nginx 上限制来源（内网网段/办公 IP），例如：

   ```nginx
   location ^~ /lingee-debug/ {
       allow 10.0.0.0/8;
       allow 192.168.0.0/16;
       deny all;
       # ... 同 §2.2
   }
   ```

   `/lingee-debug/api/` 同样加一份。
5. 调试看板会把请求记录写入浏览器本地存储（令牌默认打码）；仍建议只在受控环境开放本工具。
6. 定期清理旧版本目录（脚本自动保留最近 N 个），避免磁盘被发布包占满。