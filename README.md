# 灵基对话台 · OpenAPI 调试前端

> **v1.0.7 · 2026-11-23**
> 在 v0.9.1 单文件版基础上重构：**SSE 优先 / 轮询兜底、多会话并行、Markdown 渲染、资源缓存与刷新语义、移动端、视觉与交互**。
> v1.0.1 修复：调试看板会话过滤随切换刷新、请求中文标签；一轮多 assistant message（工具调用后继续输出）合并渲染；新增 SSE 原始事件记录与一键复制。
> v1.0.2：按真实 `tool` part 结构实现**工具调用两层折叠**（外层工具组、内层单个调用的参数与输出），默认折叠；输入框高度、SSE 记录等细节回归。
> v1.0.3：`AskUserQuestion` 交互澄清卡片（单选/多选/自定义），提交后自动处理「等待中的轮次」；会话标题只取首条提问，不再被后续澄清回答覆盖。
> v1.0.4：```chart / ```echarts 围栏渲染为内联 SVG 图表（bar/line/pie、横向条形、多系列、stack），含悬停提示与数据表。
> v1.0.5：标题右侧新增「复制会话 ID」与「在灵基中查看」（完整链接悬停显示、可复制链接）。
> v1.0.6：智能体/模型改为可搜索的固定高度选择器（不再被视口裁切）；补齐深色主题下原生控件的 `color-scheme` 适配。
> v1.0.7：支持部署在子路径（自动推导接口前缀）；新增 SSH 自动化部署工具 `deploy/`（真实配置含账号密码，已在 `.gitignore` 中排除）。
> 设计细节见 [docs/DESIGN.md](docs/DESIGN.md)。

一个零依赖、单进程的本地 Web 应用：托管前端页面，并把同源 `/api/*` 请求转发到灵基 OpenAPI 环境。页面与接口同源，**不会再遇到 `file://` 打开时的跨域（CORS）问题**。

---

## 快速开始

三种方式任选，启动器会**自动挑空闲端口**（3000 被占用就顺延到 3001、3002…）并尝试打开浏览器：

| 平台 | 做法 |
|---|---|
| Windows | 双击 `启动-Windows.bat` |
| macOS / Linux | 终端执行 `./启动-macOS-Linux.sh`（首次需 `chmod +x`） |
| 任意平台 | `node start.js` |

```powershell
node start.js
```

指定起始端口 / 不自动开浏览器：

```powershell
node start.js 8080
```

```powershell
$env:NO_OPEN="1"; node start.js
```

最朴素的启动方式（不选端口、不开浏览器）：

```powershell
node server.js
```

> ⚠ `启动-Windows.bat` **故意只写 ASCII 字符**（提示语是英文）。Windows 的 cmd 按字节偏移解析批处理，文件里一旦出现中文，多字节字符会把命令行切碎。要改这个文件请保持纯 ASCII；中文提示交给 `start.js` 输出。

转发目标默认 `https://app.lingee.com`，可在页面里覆盖，也可启动时指定：

```powershell
$env:TARGET="https://other-host"; node start.js
```

## 首次使用

1. 打开页面，点左下角「连接设置」。
2. 填服务地址（例如 `https://app.lingee.com`，只到域名，不带 `/work` 或 `/console`）、App ID、App Secret、租户 Tenant ID。
3. 选代理模式：**固定用户**只发 `tenant_id`；**白名单用户**需再填 `subject_type` 与 `subject`（`erp_user` 还要 `data_center_id`）。令牌请求体预览会显示实际要发的内容。
4. 想以后复用就点「保存为常用」，下拉即可切换。
5. 点「获取令牌」。成功后会自动拉取模型 / 工具 / 智能体。
6. 关掉抽屉，直接提问。

输入框下方可选择智能体、模型与工具（不选工具表示不限制）；右侧 `↻` 重新拉取。

---

## 本版做了什么

### 1. 通道：SSE 优先，轮询兜底

- 每个会话一条**常驻 SSE 通道**（`fetch` + `ReadableStream`，可带 `Authorization`），建会话后即建立，跨轮次复用。
- 发起对话时把**同一个 `event_id`** 同时用于建连与 `POST /chat`（v0.9.1 漏了这一步，事件可能送不到已建立的连接）。
- 校验响应体 `code === "0"`：HTTP 202 只代表受理，不代表成功。
- `5001093001`（SSE 路由未注册）自动重连通道并重发一次；`429 / 5001303003` 按 `Retry-After` 退避重试。
- **轮询只在需要时启动**：提交后 5s 内 SSE 无任何增量、通道断线、或终态缺失。不再「提交即并发打 3 次」。
- 收到同一 part 的最终快照（`time.end`）以快照文本覆盖；`session.idle` 等终态事件按 `turn.finished` 幂等收尾。

### 2. 会话：历史、切换、多会话并行

- 锁在会话上，不在应用上——**全局不再有 `busy` 锁**。
- 切走会话不关 SSE、不丢轮次；后台继续收流，完成后侧栏出现**未读点**。
- 并发上限 3，超出进入**排队**（显示第几位，可取消并把问题放回输入框）。
- 刷新页面后恢复历史与半截输出；有 `task_id` 的未完成会话标「未完成」，提供「继续查询结果」。
- 多标签页：会话按 `sid` 分键存储，索引读-改-写合并，不再整包互相覆盖。
- 会话支持搜索、重命名、删除、导出 Markdown。

### 3. Markdown 渲染

自研渲染器，离线可用、无 CDN：

- 标题、粗/斜/删除线、行内代码、围栏代码块（语言 + 一键复制）、有序/无序/嵌套/任务列表、引用、表格、分隔线、链接与裸 URL。
- **先转义后排版**，原始 HTML 一律转义；仅放行 `http/https/mailto`。
- 流式容忍：未闭合围栏按代码块渲染；60ms 节流绘制。
- 用户消息按纯文本渲染，助手消息按 Markdown 渲染。

### 3.1 工具调用展示（两层折叠）

按真实 SSE 的 `tool` part 结构渲染：

```json
{
  "type": "tool",
  "tool": "WebSearch",
  "callID": "call_...",
  "state": {
    "input": { "query": "..." },
    "output": "Web search results ...",
    "status": "running | completed",
    "time": { "start": 1795..., "end": 1795... },
    "title": "WebSearch"
  }
}
```

- **第一层（工具组）**：一轮内所有工具合并为一个可折叠区块，标题为「任务完成 · 调用 N 个工具」（运行中显示「正在调用 N 个工具」）。
- **第二层（单个调用）**：每个工具单独可折叠，标题为「搜索 <query>」/「获取 <url>」/工具名，右侧显示运行状态或耗时。
- **详情**：展开后显示参数（`state.input`）与输出（`state.output`，按 Markdown 渲染，可复制）。
- 两层均**默认折叠**；用户展开后，流式刷新会保留展开状态与输出区滚动位置。
- 工具输出落盘时截断到 20000 字符，避免撑爆 localStorage。

### 3.2 交互澄清（AskUserQuestion）

当工具为 `AskUserQuestion` 且 `state.input.questions` 有内容时，不再只显示原始 JSON，而是在正文下方渲染**澄清卡片**：

- 每道题显示 `header`、`question`、选项（`label` + `description`）；
- `multiSelect: false` 用单选，`true` 用多选；
- 支持「其他回答」自由输入；
- 至少为每道题选择/填写后才能提交。

OpenAPI 没有「回答工具」的独立接口，因此提交策略是：**先停止当前仍在等待的轮次，再把选择格式化为新消息发送**（提交前会弹窗说明）。若轮次已经空闲，则直接作为新消息发送。提交后的卡片保留为「已提交选择」，并随会话落盘。

### 3.3 图表围栏（```chart / ```echarts）

助手输出里的 `chart` 围栏（ECharts option 的子集）会渲染成**内联 SVG 图表**，而不是源码：

- 支持 `bar` / `line` / `pie`，以及横向条形（`yAxis.type = category`）、多系列分组、`stack`、折线面积、负值；
- 分类色板使用经过明暗两套校验的 8 色顺序；若 JSON 里给了 `series[].itemStyle.color` / `color` 则优先使用；
- 柱宽 ≤24px、数据端 4px 圆角、线宽 2px、网格弱化，符合数据可视化规范；
- 提供悬停提示、图例（≥2 系列）、可展开的数据表、复制原始 JSON；
- 解析失败（例如模型给了非法 JSON）时回退为代码块，不会丢失原文；流式中的半截 JSON 显示「图表生成中…」。

示例：

````markdown
```chart
{
  "title": { "text": "销售金额对比" },
  "xAxis": { "type": "category", "data": ["2025-11", "2026-11"] },
  "yAxis": { "type": "value" },
  "series": [{ "name": "价税合计", "type": "bar", "data": [11300, 300000] }]
}
```
````

### 4. 资源：缓存 + 刷新 + 清空

针对「令牌没过期但列表没选项」：

- 三层缓存：内存 → localStorage → 网络；打开页面先显示缓存（标注来源与时间），超过 10 分钟再自动刷新。
- 获取令牌成功后自动加载；并发请求单飞。
- **刷新**：强制走网络；成功返回空数组时接受空结果并提示「服务端返回 0 项」；失败时**保留旧缓存**并标注。
- **清空缓存并重拉**：先删本地缓存再拉取，**以新结果为准**，失败就显示空态而不是回退旧数据。
- 设置抽屉里逐项显示条数、来源、时间与错误，不再用一句 toast 代替。
- 输入框下方的智能体/模型改为**自定义选择器**：固定高度、可搜索、自动向上展开（移动端为底部弹层），长列表不再超出视口；选中项与请求体实时同步。
- 深色主题同步 `color-scheme`，设置抽屉等处的原生下拉、滚动条与表单控件也使用深色；自定义弹层全部使用主题变量。

### 5. 移动端

- `≤900px` 侧栏转为抽屉：顶栏汉堡按钮打开历史会话，遮罩点击关闭，选中会话后自动收起。
- 设置面板与调试看板全屏；工具选择为底部弹层。
- 输入框 16px 防 iOS 聚焦缩放；底部适配 `safe-area-inset-bottom`。

### 6. 视觉与交互

- 统一设计令牌，浅色 / 深色（跟随系统 + 手动切换）。
- 用户消息右对齐渐变气泡；助手消息带头像、时间、耗时、模型、token 用量。
- 流式光标、思考过程折叠、工具调用标签、产物下载、错误卡片。
- 仅接近底部时自动跟随；离开底部出现「回到底部」。
- `Ctrl/⌘+K` 搜索会话、`Ctrl/⌘+B` 调试看板、`Esc` 关闭浮层、`Ctrl/⌘+Enter` 发送。
- 动效遵循 `prefers-reduced-motion`，焦点环与 `aria-*` 齐备。

---

## 文件结构

```
start.js              启动器：挑空闲端口 + 开浏览器（跨平台）
server.js             本地服务：静态托管 + /api 反向代理（流式透传）
启动-Windows.bat       Windows 双击入口（纯 ASCII）
启动-macOS-Linux.sh    macOS / Linux 入口
package.json          元信息与脚本（无依赖）
public/
  index.html          结构
  assets/styles.css   设计系统 / 响应式 / 深色
  js/
    crypto.js         SHA-256 / HMAC-SHA256 / 随机数
    sse.js            SSE 解析 + 通道（自动重连 / 空闲看门狗）
    markdown.js       Markdown 渲染（安全、流式容忍）
    chart.js          chart 围栏 → 内联 SVG 图表
    store.js          配置 / 会话 / 资源缓存 / 调试 / 迁移
    api.js            令牌签发、Bearer 请求、401 重签、错误分类
    resources.js      模型 / 工具 / 智能体缓存
    turns.js          轮次注册表 + 轮询兜底 + 并发调度
    debug.js          调试看板
    app.js            UI 控制器
test/
  selftest.mjs        纯函数自测（SSE / Markdown / 存储迁移）
deploy/               部署工具（SSH 发布 / 回滚）与 nginx、systemd 模板，用法见 DEPLOY.md
docs/
  DESIGN.md           设计说明
  灵基开放OpenAPI-v3.openapi.json / .yaml
  灵基开放OpenAPI详细接入手册-v3.html
  灵基开放OpenAPI简要调用流程.html
  灵基-对话接口-导入自检.openapi.json
  api在线文档.md
```

## 常用操作

| 操作 | 位置 |
|---|---|
| 新建会话 | 侧栏「新建会话」/ `Ctrl+K` 后 Esc |
| 切换会话 | 侧栏历史；移动端用顶栏汉堡键 |
| 停止本轮 | 输入框右侧「停止」 |
| 续查未完成 | 会话内黄色提示条「继续查询结果」 |
| 刷新资源 | 输入框 `↻`，或连接设置「刷新」 |
| 清空资源缓存 | 连接设置「清空缓存并重拉」 |
| 导出会话 | 历史条目悬停 → 下载图标 |
| 调试看板 | 侧栏「调试看板」/ `Ctrl+B` |
| 复制会话 ID | 标题右侧「复制会话 ID」 |
| 在灵基中查看 | 标题右侧「在灵基中查看」；悬停显示完整链接，可复制 |

会话链接 = 当前连接设置的 `BASE_URL` + `/session/` + `session_id`，例如
`https://app.lingee.com/session/06b93c76-4beb-4474-8f39-68024aef7ad8`。标题右侧的链接在悬停时显示完整 URL，并提供「复制链接」。

## 调试看板

按顺序记录签发令牌、创建会话、建立 SSE、发起对话、轮询、资源列表等每一步的请求地址、请求头、请求体与响应。支持按会话范围、类别过滤与搜索，可复制 cURL。记录保留 24 小时内、最多 200 条；令牌与签名默认打码，勾选「显示令牌」才显示明文。

**SSE 原始事件记录**：勾选「记录 SSE」后，后续收到的每条 SSE 事件都会进入本页内存缓冲（每会话最多 8000 条，刷新即清空）。点「复制 SSE 流」按当前过滤范围导出，格式为带相对时间注释的 SSE 文本：

```
# --- session=<sid> event_id=<eid> events=42 ---
: +0ms
data: {"type":"server.connected","properties":{}}
: +120ms
data: {"type":"message.part.delta","properties":{...}}
```

复制前请确认范围：选「当前会话」只导当前会话，选「全部会话」导出所有已记录会话。

## 隐私

- App Secret 只保存在浏览器 localStorage，命中签名也在浏览器本地完成；Node 服务只做透明转发，不读取、不落盘。
- 访问令牌只放在 `sessionStorage`（关闭标签页即失效），不写入 localStorage。
- 调试看板在**落盘前强制打码**：`Authorization`、`X-Lingee-OpenApi-Signature/Nonce`、`access_token` 等不会以明文进入 localStorage；页面内勾选「显示令牌」只在当前内存中生效。
- 只监听 `127.0.0.1`。若确实需要局域网访问，设置 `HOST=0.0.0.0`（不建议，密钥页面就在里面）。

## 已知限制

| 限制 | 说明 |
|---|---|
| 服务端无「列出会话」接口 | 换浏览器或清缓存后本地记录会丢；只要还记得 `session_id`，仍可继续那条会话 |
| 会话标题 | 服务端推送的标题仅在本地未重命名时采用 |
| 工具/智能体明细 | 目前只用于选择与参数传递，不展示每个工具的调用详情（part 结构以服务端实际返回为准） |
| 并发上限 | 默认 3，可在 `public/js/app.js` 的 `maxConcurrent` 调整；仍受租户并发配额约束 |

## 测试

```powershell
node test/selftest.mjs
```

覆盖 SSE 跨分片解析、Markdown 各类语法与 XSS、资源缓存键、旧版 `lingee.*` 数据迁移。

### 本地 mock 联调（可选）

仓库自带一个零依赖的 Mock 灵基服务，可在没有真实环境时跑通完整链路：

```powershell
node test/mock-server.js 4398
```

把页面「服务地址」填成 `http://127.0.0.1:4398` 即可。提问里的特殊标记：

| 标记 | 行为 |
|---|---|
| 普通提问 | 通过 SSE 逐字推送文本、工具 part 与产物 part，最后 `session.idle` |
| `[poll]` | 故意不推流，5s 后由前端轮询兜底取终态 |
| `[slow]` | 放慢推流，便于观察多会话并行与排队 |
| `[drop]` | 第一次发起对话返回 `5001093001`，验证自动重连重试 |
| `[ask]` | 返回 `AskUserQuestion` 等待输入，验证澄清卡片与「停止后提交」链路 |
| `[chart]` | 回答末尾追加一个 `chart` 围栏，验证图表渲染 |

## 文档

- [部署文档（部署内容 / nginx 独立 location / 后续更新 / 自动化脚本）](DEPLOY.md)
- [设计说明（SSE / 轮询 / 多会话 / 缓存）](docs/DESIGN.md)
- [灵基开放 OpenAPI v3 规范（JSON）](docs/灵基开放OpenAPI-v3.openapi.json)
- [灵基开放 OpenAPI v3 规范（YAML）](docs/灵基开放OpenAPI-v3.openapi.yaml)
- [详细接入手册 v3（HTML）](docs/灵基开放OpenAPI详细接入手册-v3.html)
- [简要调用流程（HTML）](docs/灵基开放OpenAPI简要调用流程.html)
- [对话接口导入自检（OpenAPI）](docs/灵基-对话接口-导入自检.openapi.json)
- 在线文档：<https://vip.kingdee.com/knowledge/888470634605847552?productLineId=44&isKnowledge=2&lang=zh-CN>

## 版本记录

| 版本 | 说明 |
|---|---|
| `v0.9.1-baseline` | 导入原始单文件调试台，作为对照基线 |
| `v1.0.0` | 通道重构（SSE 优先 / 轮询兜底）、多会话并行、Markdown、资源缓存、移动端、视觉与交互 |
| `v1.0.1` | 调试看板过滤/中文标签修复；一轮多 assistant message 合并渲染；SSE 原始事件记录与复制；输入框高度自适应修复 |
| `v1.0.2` | 工具调用两层折叠（工具组 + 单调用参数/输出）、默认折叠、展开状态保持 |
| `v1.0.3` | AskUserQuestion 澄清卡片（单选/多选/自定义）、停止等待轮次后提交、会话标题只取首条提问 |
| `v1.0.4` | chart 围栏渲染为 SVG 图表（bar/line/pie、多系列、stack、悬停与数据表） |
| `v1.0.5` | 标题右侧「复制会话 ID」「在灵基中查看」；完整链接悬停显示并可复制 |
| `v1.0.6` | 智能体/模型可搜索选择器（不裁切、移动端底部弹层）；深色主题原生控件适配 |
| `v1.0.7` | 子路径部署支持（自动推导接口前缀）；SSH 自动化部署工具与 systemd/nginx 模板 |

遇到 `502 PROXY_ERROR`：本地服务连不上目标环境，先确认网络与「服务地址」。
遇到 `5001093001`：SSE 路由未注册，本版会自动重连并重试；仍失败请检查网络后重发。