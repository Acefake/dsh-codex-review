# dsh-codex-review · 独立验证装置

对真实 DSH Web GUI（默认 `http://127.0.0.1:2632`）做**独立、可复现**的端到端验证：
headless Edge + Chrome DevTools Protocol 截图 / 抓 console / 点击左栏入口，以及对插件
`/codex-review/*` 路由的真实 POST 契约断言。

本目录只做**验证**：不安装插件、不改 profile、不重启服务、不安装 npm 包。
所有脚本零第三方依赖（Node 24 内置 `fetch` / `WebSocket` / `node:crypto`）。

---

## 1. 前置条件

| 项 | 要求 |
|---|---|
| 系统 | Windows（用 Edge 二进制；其它平台可用 `EDGE_PATH` 指 Chrome/Edge） |
| Node | ≥ 22（需要全局 `fetch` 与 `WebSocket`；实测 v24.21.0） |
| 浏览器 | `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`（可用 `EDGE_PATH` 覆盖） |
| GUI | DSH Web GUI 正在运行，默认 `http://127.0.0.1:2632`（不改动它） |
| 数据 | `gh` CLI 已安装并登录（`prs` / `pr` 需要）；宿主已配置可用 LLM（`review-start` 需要） |
| 插件 | 装好并在左栏出现「代码审查」（否则 `api-probe.mjs` 会以退出码 3 报「路由未就绪」） |

不需要 Playwright，不需要 `npm install`。

---

## 2. 认证：为什么脚本能访问 GUI

DSH Web 的**所有** Host 路由（含插件用 `ctx.webServer.register()` 注册的 `/codex-review` 前缀）
都由浏览器会话 cookie 保护：

- 正常启动时打印的 URL 带一次性 `?token=`；浏览器用它换到签名 cookie；
- 之后每个请求靠 `dsh-auth-<sha256(authority)>` cookie 认证；
- `DSH_WEB_URL` 环境变量**不含** token（官方设计），所以脚本提供两种取 cookie 的方式：

1. **`--token <token>` / 环境变量 `DSH_WEB_TOKEN`**：脚本像浏览器一样
   `GET /?token=…`（303）拿到 `Set-Cookie`。手上有启动 URL 时用这个，最干净。
2. **本机凭据（默认）**：读取 `$DSH_HOME/.credentials.yaml` 里的
   `client-connection/browser-session` 签名密钥，用与服务端相同的算法
   （`lib/types/browser-auth.js`）mint 一个 1 小时有效的 v1 cookie。
   该文件**只读**，密钥不会打印、不会写进任何报告。

```powershell
# 显式用启动 URL 里的 token
node .\verify\page-check.mjs --token <token> ...
# 或让脚本读本机凭据（默认）
node .\verify\page-check.mjs ...
```

> 安全说明：方案 2 等价于本机已登录浏览器会话，仅适用于本机 loopback 验证。
> 不要把本装置或 cookie 暴露到非可信机器。

---

## 3. 快速开始

```powershell
$V = 'C:\Users\10228\dsh-codex-review\verify'

# 1) 页面基线：截图 + 收集 console / pageerror（装置自证）
node $V\page-check.mjs --out-dir $V\baseline --shot baseline-gui.png --report baseline-page-check.json

# 2) 路由契约：health / prs / pr / review-start→review-status / review-cancel
#    会真实调用一次模型（约 1–2 分钟），不想调用就加 --skip-ai
node $V\api-probe.mjs --report $V\out\api-probe.json

# 3) 点击左栏「代码审查」入口 → 三栏工作台 → 截图 + console 报告
node $V\click-panel.mjs --out-dir $V\out

# 4) 任意页面截图（独立 CLI）
node $V\shot.mjs --url http://127.0.0.1:2632 --out $V\out\gui.png
```

每个脚本的 stdout 都同时给出人可读摘要和 JSON 摘要；完整证据写到 JSON 报告文件。
退出码见 §5。

---

## 4. 工具说明

### 4.1 `shot.mjs` — 截图 CLI

| 参数 | 默认 | 说明 |
|---|---|---|
| `--url` | `$DSH_WEB_URL` 或 `http://127.0.0.1:2632` | 目标页面（也接受第 1 个位置参数） |
| `--out` | 必填 | PNG 输出路径（也接受第 2 个位置参数） |
| `--width` / `--height` | 1600 / 1100 | 视口尺寸（写入 CDP device metrics） |
| `--wait-ms` | 1200 | 网络空闲后的额外稳定等待（毫秒） |
| `--timeout-ms` | 45000 | 导航/加载超时 |
| `--full-page` | 关 | 截整页而非视口 |
| `--token` / `--no-auth` | — | 认证方式 / 关闭 cookie 注入（截非 GUI 页面时自动不注入） |
| `--headful` | 关 | 有窗口模式（排查渲染差异） |
| `--json` | 关 | 只输出 JSON 摘要 |

等待策略：`load` 事件 → 网络空闲（`Page.lifecycleEvent networkIdle` + inflight 计数）→
`document.readyState=complete` → `#root` 有子节点 → `--wait-ms`。
任何失败以非 0 退出（环境/参数/导航/截图失败统一为 2）。

### 4.2 `page-check.mjs` — 页面检查 + JSON 报告

打开 GUI，从**第一字节**开始收集：

- `Runtime.consoleAPICalled` → `consoleMessages` / `consoleErrors` / `consoleWarnings`
- `Runtime.exceptionThrown` → `pageErrors`（含 stack）
- `Log.entryAdded` → `logProblems`（网络 4xx/5xx 等浏览器日志）
- `Network.loadingFailed` → `failedRequests`；`network.requestCount` / `topHosts`
- DOM：`title`、`readyState`、`#root` 子节点数、是否有一等模态框、body 文本片段、
  左栏可交互元素快照 `dom.sidebar`（tag / aria-label / title / text / rect）

报告文件名由 `--report` 指定（默认 `verify/out/page-check-<时间>.json`），截图由 `--shot` 指定。
**退出码：0 = 无 console.error / pageerror；1 = 发现错误（`--allow-console-errors` 可降级）；
2 = 装置错误。**

> 已知良性噪音：web profile 下 `/api/experimental-inspector/bootstrap` 会 404，
> 只会出现在 `logProblems`（浏览器网络日志），不是 `console.error`；基线就是这种情况。

### 4.3 `api-probe.mjs` — 插件路由契约断言

对 `plugin/CONTRACT.md` §1.1/§1.2 逐项断言（同源 POST、`content-type: application/json`、
带浏览器 cookie 与同源 `Origin`）：

| 路由 | 断言 |
|---|---|
| `/codex-review/health` | HTTP 200；信封 `{ok:true,value}`；`gh ∈ {ok,not-logged-in,missing}`、`llm ∈ {ok,unavailable}`、`version` 非空 |
| `/codex-review/prs` | 信封合法；`items` 数组且 **≥ 20 条**（`--min-prs`）；`totalCount` 数字；每条 PrSummary 的 `repo`（owner/name）/`number`/`title`/`author`/`isDraft`/`state`/`createdAt`/`updatedAt`/`headRefName`/`baseRefName`/`url` 形状合法 |
| `/codex-review/pr` | 信封合法；`summary.repo/number` 与请求一致；`body` 字符串；`files` **= 24 个**（`--expect-files`）且 FilePatch 字段合法；`stack` 链路**含 #117**（`--stack-ref`）；`review` 状态对象合法 |
| `/codex-review/review-start` | 信封合法且 `ok:true`；`jobId`/`headSha` 非空；`cached` 布尔 |
| `/codex-review/review-status` | 轮询到终态（`done/error/cancelled`）；ReviewStatus 形状合法（`progress.phase/filesDone/filesTotal/startedAt/elapsedMs`、`headSha`、`findings[]`）；终态必须 `done`；`Finding` 每条校验 `id/severity(P0-P2)/file/line 正整数/title/why/fix/category` |
| `/codex-review/review-cancel` | 信封合法；`ok:true` 时 `cancelled` 为布尔；未知 `jobId` 也返回合法信封。**仅在审查到终态后**才 cancel 真实 job（终态返回 `cancelled:false`）；轮询超时不会去 cancel 运行中的 job，避免干扰 |
| `/codex-review/llm-info`（调试路由，可选） | 若存在则校验信封并记录 `selection` / `reasoning efforts` / 实际 effort / `transport` / 插件配置；不存在只记录、不判失败 |
| 响应头 | 所有 200 响应 `content-type: application/json` + `cache-control: no-store` |
| 信任围栏（`--skip-security` 可跳过） | 跨站 `Origin`、`x-forwarded-for`、非 JSON `content-type` 必须被拒绝（HTTP ≥400 或 `ok:false`） |

**未安装插件时**：POST 命中静态/SPA 处理器会返回 **HTTP 405**（GET 为 404，空响应体），
脚本打印「路由未就绪」并以 **退出码 3** 结束，不会崩。
`--skip-ai` 跳过一次真实模型调用（只跑只读路由）；`--review-timeout-ms` 默认 **600000**
（分块越多、reasoning 越慢，按需加大；超时只报失败，不会取消运行中的 job）。
`review-status.partial === true` 会作为**失败断言**（分块截断/解析失败导致的空 findings 不能当成
「明确 0 问题」）。

### 4.4 `click-panel.mjs` — 点击左栏入口并验证三栏工作台

流程：

1. 打开 GUI、等 SPA 侧栏渲染（出现「插件」+「工作区」）并等网络空闲；
2. **清模态框**：优先点对话框里「继续/知道了/关闭/…」按钮 → 失败按 `Esc` → 再失败点遮罩；
3. 点击前截图（`click-before-*.png`）；
4. **按文本**在左栏容器（`nav/aside/[role=navigation]/[data-sidebar]`）里找最深匹配节点的
   可点击祖先，按真实鼠标事件点其中心（不依赖 aria-label、不点会话列表）；
5. 等网络空闲 + `--wait-ms` 稳定，点击后截图（`click-after-*.png`）；
6. 判定：模态框清除、找到入口、点击已派发、页面有变化、**三栏工作台**（列带 ≥3 或命中
   `AI 审查`/`Summary|Changes` 文案）、无 pageerror、无 console.error、无 `slot entry crashed`。

找不到入口时（或任意检查失败时）stdout 会打印**当时左栏所有候选按钮**的
text / aria-label / title / 矩形，报告 `report.lookup.sidebarCandidates` 同样保存，
可直接据此排查插件 DOM，而不是猜。

**自检装置**（不依赖插件，点一个现成入口验证“弹窗→定位→点击→渲染”链路）：

```powershell
node $V\click-panel.mjs --target 插件 --expect click --out-dir $V\out\selftest
```

### 4.5 `ai-review-ui.mjs` — （可选）UI 端到端 AI 审查

打开 GUI → 点左栏「代码审查」→（`--select <文本>` 可在 PR 列表里选中指定 PR，
默认用客户端自动选中的第一条）→ 等列表/详情真正加载、触发按钮可点击 → 点
「Review with Codex」→ 轮询审查卡直到终态，抓三类截图 + console/pageerror：

- `ai-review-before.png`：点击前工作台；
- `ai-review-running.png`：能观察到「审查中…/准备中…/已分析 n/m 文件」时抓的进度帧
  （命中缓存会跳过）；
- `ai-review-done.png`：终态（`n 条发现` / `未发现 P0/P1 问题` / `审查失败` / `部分结果`）。

判定：终态出现、非「审查失败」、无 pageerror/console.error。
UI 文案来自客户端内置 locale（zh/en 都识别），报告保留 `bodyTextSample` 供人工核对。
**注意**：点按钮会调用 `review-start`；对同一 `repo#number@headSha` 已有完成 job 时
契约会命中缓存（`cached:true`，不产生额外模型调用）。

```powershell
node $V\ai-review-ui.mjs --select 自动检测片头片尾 --out-dir $V\out
```

---

## 5. 退出码约定

| 码 | 含义 | 出现在 |
|---|---|---|
| 0 | 所有断言通过 / 操作成功 | 全部 |
| 1 | 验证失败（装置正常，但被验证对象不符合契约） | `page-check` / `api-probe` / `click-panel` |
| 2 | 装置/环境错误（参数、认证、Edge 启动、导航超时等） | 全部 |
| 3 | 插件路由未就绪（`/codex-review/*` 尚未注册，插件未安装/未加载） | `api-probe` |

---

## 6. 判读标准

**插件可用**需同时满足：

1. `api-probe.mjs` 退出码 0：health 正常、prs ≥20 条、#129 详情 24 文件 + body + stack 含 #117、
   AI 审查跑到 `done` 且 findings schema 合法、所有信封/响应头断言通过；
   **并且** `review-status.partial` 不为 `true`（分块失败/截断会让 findings 为空，属于审查质量缺陷，
   不能当作“明确 0 问题”通过）；
2. `click-panel.mjs` 退出码 0：左栏能找到「代码审查」并点击，**三栏工作台**渲染，console/pageerror 为空；
3. 人工看 `click-after-*.png`：三栏布局、PR 列表有真实数据、无空白/错位（工具只能证明“渲染了”，
   视觉好坏需人眼确认）；
4. `page-check.mjs` 的 `consoleErrors` / `pageErrors` 为空（`logProblems` 里的 404 噪音单独解释）。

**失败排查**：

| 现象 | 建议 |
|---|---|
| api-probe 退出 3 / HTTP 405 | 插件没装或未加载：先安装并在插件管理器确认「代码审查」出现，再重跑 |
| API 返回 401 | cookie 失效：用 `--token <启动 URL token>` 重跑 |
| click-panel 找不到入口 | 看 stdout 候选按钮列表：入口文本是否叫「代码审查」？是否渲染在左栏？可用 `--target` 试别名 |
| 三栏未检出但截图正常 | 三栏判定是启发式：看截图人工确认；若确实渲染了可把 `report.after.panels` 反馈给装置维护者 |
| console error `slot entry crashed` | 客户端组件抛异常：看 `report.consoleErrors[].stack` 定位 |

---

## 7. 基线（装置自证，2026-10-24 已跑通）

插件安装**前**的状态，证明装置本身可用：

- `baseline/baseline-gui.png`：1600×1100 真实 GUI 截图，标题 `DeepSeek Harness`；
- `baseline/baseline-page-check.json`：`consoleErrors=0`、`pageErrors=0`、`failedRequests=0`，
  网络请求 46 个（含 2 条良性 `experimental-inspector` 404 网络日志），
  检测到「预览版说明」模态框（1 个「继续」按钮）与左栏快照（插件/自动化任务/更多/会话树）；
- `click-panel.mjs --target 插件 --expect click`：模态框由按钮关闭、按文本定位到「插件」、
  点击后页面切换为插件管理页（`out/selftest/click-after-*.png`），0 console error；
- `api-probe.mjs --skip-ai`：`POST /codex-review/health` → HTTP 405 → 输出「路由未就绪」并退出 3；
- `click-panel.mjs --target 代码审查`（插件未装时）：正确报“找不到入口”，并打印左栏全部候选按钮。

---

## 8. 目录与产物

```
verify/
├─ shot.mjs             # 截图 CLI
├─ page-check.mjs       # 页面 + console 检查（JSON 报告）
├─ api-probe.mjs        # 插件路由契约断言
├─ click-panel.mjs      # 左栏入口点击 + 三栏验证
├─ ai-review-ui.mjs     # （可选）UI 端到端 AI 审查：点触发按钮 → 轮询终态 → 截图
├─ lib/
│  ├─ auth.mjs          # GUI 浏览器会话 cookie（token 交换 / 本机凭据只读计算）
│  ├─ cdp.mjs           # headless Edge + CDP 最小驱动
│  ├─ gui.mjs           # 同源 JSON POST 客户端
│  ├─ dom.mjs           # 页面内 DOM 探针表达式（侧栏/模态框/布局/工作台）
│  └─ util.mjs          # CLI 公共设施（退出码、目录、JSON 输出）
├─ baseline/            # 装置自证基线（插件安装前）
│  ├─ baseline-gui.png
│  └─ baseline-page-check.json
├─ out/                 # 每次运行的截图/报告（机器生成，可删）
│  └─ .tmp/             # 一次性 Edge profile（运行结束自动删除）
├─ README.md            # 本文件
└─ REPORT.md            # 验收报告（装好后执行并填真实结果）
```

---

## 9. 副作用与安全

- **只读 GUI**：页面加载与点击「继续」、左栏入口；不提交表单、不合并 PR、不发评论。
- **一次模型调用**：`api-probe.mjs` 默认执行一次 `review-start`（会产生 LLM 计费/耗时）；
  只读场景用 `--skip-ai`。这是任务允许的预期行为。
- **临时浏览器 profile**：每次运行在 `verify/out/.tmp/` 下创建独立 Edge user-data-dir，
  结束（含失败路径）自动删除；**不碰**用户已登录的 Edge profile。
- **凭据**：仅只读 `.credentials.yaml`；密钥不打印、不写入报告。
- **不改插件/profile/服务**：不安装、不启停、不改配置。
