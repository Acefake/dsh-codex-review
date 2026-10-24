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

### 4.6 v1.1 验收扩展（CONTRACT §4.6）

v1 命令保持不变（默认不加 `--v11` 即纯 v1 回归，不受影响）。v1.1 断言通过显式开关启用：

```powershell
# A) 路由契约 + v1.1 结构断言（不触发新审查；未部署 v1.1 时新断言记 pending）
node $V\api-probe.mjs --v11 --out-dir $V\out --report api-probe-v11.json
# B) 真实选项探测：默认设置(缓存优先) + depth=fast 新 job + 同设置二次 cached=true
node $V\api-probe.mjs --v11 --v11-ai --out-dir $V\out --report api-probe-v11-ai.json
# C) severityThreshold=P0 真实审查（findings 全 P0、verdict 一致）
node $V\api-probe.mjs --v11 --v11-threshold --out-dir $V\out --report api-probe-v11-p0.json
# D) 页面：左栏入口 + 工作台 data-cr-root + 「用 AI 审查」/设置按钮
node $V\page-check.mjs --v11 --out-dir $V\out --report page-check-v11.json
# E) 页面端到端：diff finding 卡、行内评论、设置弹层、j/k/r// 键盘、v11-*.png 截图
node $V\click-panel.mjs --target 代码审查 --v11 --out-dir $V\out --report click-panel-v11.json
```

新增断言（`api-probe --v11`）：
- `ReviewStatus`/`PrDetail.review` 新字段形状：`options`（depth/severityThreshold/includeGuidelines/chunkChars/maxChunks/concurrency）、`verdict`（block/changes/approve 且与 findings 推导一致）、`reusedFiles`（0..filesTotal）、`guidelines`（loaded/files/chars≤4000）；
- `--v11-ai`：默认设置返回 `ResolvedReviewOptions`（standard/P2/true）、`depth=fast` 与默认**不同 job key** 且预算 16000/6/4、同设置同 headSha 二次调用 `cached=true`、fast 复用文件级缓存 `reusedFiles>0`、repo 有 AGENTS.md 时 `guidelines.loaded=true`；
- `--v11-threshold`：`severityThreshold=P0` 时 findings 全 P0、verdict 与过滤后集合一致、overview 统计一致。

新增页面断言（`click-panel --v11`，截图 `verify/out/v11-*.png`）：
`[data-inline-marker]` diff finding 圆点 → 点击展开 `[data-inline-open]` 卡（为什么/怎么改/严重度/可选 confidence/evidence）；
`[data-inline-comment]` 已有 GitHub 行内评论卡（自动挑一个有 inline 评论的 PR，没有则 pending）；
`[data-cr-settings]` 弹层 depth 三档 / severityThreshold 三档 / includeGuidelines 开关 / deep 说明，改设置后 localStorage 持久化，
键盘 `r` 触发的 `review-start` 请求体带当前 `options`；`j/k` 切 PR、`/` 聚焦搜索、`Esc` 关弹层；全程 console/pageerror=0。

**安全约束**：v1.1 的 `--v11-ai/--v11-threshold` 与页面 `r` 键盘都会真实调用 `review-start`（可能新起审查）；
装置**从不调用 review-cancel**，超时只报失败、不终止任何运行中的 job。

### 4.7 v2 验收扩展（CONTRACT §5.4：合并守卫 + PR 对话）

```powershell
# A) 合并守卫（绝不真实合并）+ 真实 PR 对话 SSE + chat BAD_REQUEST 分支
node $V\api-probe.mjs --v2 --out-dir $V\out --report api-probe-v2.json
# B) 只测合并守卫与 chat 参数校验，跳过真实 chat 提问
node $V\api-probe.mjs --v2 --v2-skip-chat --out-dir $V\out --report api-probe-v2-guards.json
# C) 页面：合并按钮可点 + 对话输入框 placeholder（v2-page-check.png）
node $V\page-check.mjs --v2 --out-dir $V\out --report page-check-v2.json
# D) 页面端到端：合并弹层字段/取消不写入、对话流式气泡/Esc/历史隔离（v2-*.png）
node $V\click-panel.mjs --target 代码审查 --v2 --out-dir $V\out --report click-panel-v2.json
```

**合并安全红线（装置内硬约束）**：
- 只测守卫：`confirm:false` / 缺字段 / 非法 method → `BAD_REQUEST`；`confirm:true` 仅配**全零（刻意 stale）expectedHeadSha** → `MERGE_HEAD_MOVED`，且校验 PR 仍 open、headSha 未变；`merge()` 助手在发送前拒绝任何「confirm:true + 非全零 sha」的请求。
- 页面只打开合并弹层并点「取消」，用 Network 断言**没有发出** `/codex-review/merge` 请求；绝不点「确认合并」。
- 不做真实合并（契约 §5.4.2 明确）。

**chat 断言**（`--v2`）：`POST /codex-review/chat` 真实提问「这个 PR 改了什么？」→ `text/event-stream`、≥1 个 `delta` 帧、以 `done` 帧结束、无 `error` 帧、拼接文本非空且含 PR 相关词；
BAD_REQUEST 分支（messages 空 / 最后一条非 user / 单条 >4000 字 / 超过 20 条）；并发 BUSY 跳过（契约允许）。
**会真实调用一次模型**（chat 回答）；合并守卫与 chat 参数校验分支不触发写操作/模型。

新增页面断言（`click-panel --v2`，截图 `verify/out/v2-*.png`）：
合并按钮可点 → 弹层含方式三选/删除分支 checkbox/风险提示/repo#number/head→base/headSha/取消与确认 → 点取消 → 弹层关闭 + 无 merge 请求 + PR 未变；
对话：输入「总结这个 PR 的改动」→ user 气泡 + 流式 assistant 气泡最终非空 + 流式期间停止按钮 → 无 error 气泡 → `Esc` 关闭 → localStorage 按 PR 持久化/切换隔离；全程 console/pageerror=0。

### 4.8 v2.1 验收扩展（CONTRACT §6.5：自动审查）

```powershell
# A) 自动审查路由：status 默认/config 夹取/run 守卫/真实 force cycle/seen 去重/无 GitHub 写
node $V\api-probe.mjs --skip-ai --v21 --out-dir $V\out --report api-probe-v21.json
# B) 只测 status/config/run 守卫（跳过真实 cycle）
node $V\api-probe.mjs --skip-ai --v21 --v21-skip-force --out-dir $V\out --report api-probe-v21-guards.json
# C) 页面：自动审查设置区/状态卡存在（v21-page-check.png）
node $V\page-check.mjs --v21 --out-dir $V\out --report page-check-v21.json
# D) 页面端到端：设置区开关→config 请求、立即检查→run 请求、状态卡/recent、徽章、toast（v21-*.png）
node $V\click-panel.mjs --target 代码审查 --v21 --out-dir $V\out --report click-panel-v21.json
```

**断言（`api-probe --v21`）**：
- `auto-review-status` 默认结构：`config` 默认（enabled=false、interval=180、query=`is:open author:@me`、depth=fast、threshold=P2、includeDrafts=false、maxPerCycle=2）、`running=false`、`recent=[]`、`seenCount≥0`；
- `auto-review-config` 夹取：`{enabled:true, intervalSeconds:30, maxPerCycle:99, depth:'nope', unknownKey:1}` → 回显 interval=60、maxPerCycle=5、depth 回退 fast、未知字段忽略；随后恢复默认并断言 `enabled=false`；
- `auto-review-run {force:false}`（disabled）→ `{started:false, reason}`；`{force:true}` → `{started:true}` 并等待 `running=false`，断言 `recent` 出现 done 且 findings/verdict 合法；第二次 force 断言 seen 命中（recent 不增加）；
- **安全**：cycle 前后 PR `state`/`headSha`/评论数不变（自动审查无 GitHub 写）；测试结束（finally）**一定恢复 `enabled=false`** 并断言状态文件已恢复，避免留下后台周期审查。
- 若当前没有 open PR：`run` 返回 started:true 但 recent 不变，相关断言记 pending（契约允许）。

**页面断言（`click-panel --v21`，截图 `verify/out/v21-*.png`）**：设置弹层含「自动审查」区与开关（interval/depth/threshold/drafts/maxPerCycle/query 控件齐全）；开关切换发出 `auto-review-config` 请求且 `patch.enabled=true`；右栏自动审查卡显示状态/上次/下次/最近并含「立即检查」；点击后发出 `auto-review-run` 请求 `force=true`，等待 cycle 结束、recent 出现 done；完成 toast 与 PR 行「已自动审查」徽章；关闭后 `status.config.enabled=false`；全程 console/pageerror=0。
**副作用**：`--v21` 会真实触发一次自动审查 cycle（depth=fast，可能 1–3 分钟、消耗模型 token）；装置在 finally 中恢复 `enabled=false`，绝不发评论/合并。

### 4.9 v2.2 验收扩展（CONTRACT §7.4：把审查发布到 GitHub）

v1/v1.1/v2/v2.1 命令保持不变（默认不加 `--v22` 即不跑新断言）。v2.2 断言通过显式开关启用：

```powershell
# A) 路由就绪 + 守卫 + REVIEW_NOT_READY（绝不真实发布）
node $V\api-probe.mjs --skip-ai --v22 --out-dir $V\out --report api-probe-v22.json
# B) 页面：发布能力属性 + 自动发布设置区存在（v22-page-check.png）
node $V\page-check.mjs --v22 --out-dir $V\out --report page-check-v22.json
# C) 页面端到端：发布弹层字段/取消（0 发布请求）、自动发布二次确认/取消（v22-*.png）
node $V\click-panel.mjs --target 代码审查 --v22 --out-dir $V\out --report click-panel-v22.json
```

**发布安全红线（装置内硬约束，与 §4.7 合并红线同等）**：

- 装置**绝不**发送「`confirm:true` + 当前 head 已有 `done` 审查」的 `review-publish` 请求——那会真的在用户的 PR 上创建 review 评论。守卫只允许：`confirm` 缺失/false、非法 `mode`/`minSeverity`、`body` 超长，以及（确有）当前 head 没有 done 审查的 PR（预期 `REVIEW_NOT_READY`）。
- 发送任何 `confirm:true` 之前，`publishProbe()` 必先 `POST /codex-review/pr` 确认 `review.state !== 'done'` 且状态可读；若为 done 或不可读 → 记 `pending`（写明原因）并**不发送**。`mode`/`minSeverity`/`body` 守卫之所以能用 `confirm:true`，只是因为 Host 在触达 GitHub 之前就拒绝它们（`index.js` 的 `reviewPublish`），且同样受这条 gate 约束。
- 页面只打开弹层、切换 mode/minSeverity（本地状态）、点「取消」；**绝不点「确认发布」**，并用 Network 断言整个流程 `POST /codex-review/review-publish` 请求数为 **0**。
- 自动发布开关只允许「打开二次确认 → 点取消」；断言没有发出 `publish.enabled=true` 的 `auto-review-config` 请求，且 `data-auto-publish-status` 保持不变。开关当前已是开启状态时按红线直接跳过（不碰写配置）。

**断言（`api-probe --v22`）**：

- 路由就绪：`POST /codex-review/review-publish` 返回合法 `{ok:...}` 信封；`confirm:false` → `BAD_REQUEST`（旧 Host 没有该路由时 HTTP 404 → 全部记 pending，不误报失败；200 但不是信封 → 路由断言失败）。
- 守卫：缺 `confirm`、`confirm:false`、`mode:'nope'`、`minSeverity:'P5'`、`body` 4001 字 → 全部 `BAD_REQUEST`；后三者带 `confirm:true`，发送前逐个过 `/pr` gate。
- `REVIEW_NOT_READY`：从 `/prs` 取候选 PR，逐个 `/pr` 找 `review.state !== 'done'` 的目标 → 发 `{confirm:true, mode:'summary'}` → `REVIEW_NOT_READY`，并断言该 PR 的评论数（total/inline）前后未变；找不到候选 → pending。
- 安全计数（`report.v22.safety.summary`）：请求数 / 实际发出的 `confirm:true` 数 / 被红线跳过数 / 命中 done 审查数 / `published:true` 数；断言「命中 done = 0」「每个 `confirm:true` 都有 gate」「从未出现 `published:true`」。

**页面断言（`page-check --v22`，截图 `v22-page-check.png`）**：工作台根节点暴露 `[data-cr-publish-supported]`（true/false 均记录，值写进报告）；审查设置弹层内存在 `[data-auto-publish-section="ready"]`；console/pageerror=0。

**页面断言（`click-panel --v22`，截图 `v22-publish-dialog.png` / `v22-publish-cancel.png` / `v22-auto-publish-confirm.png`）**：

- 选中一个「done 审查 + findings>0」的 PR，点「发布到 GitHub」→ 弹层字段：`repo#number`、已审查 head（`review.headSha` 前 7 位）、预计评论数 `[data-publish-expected]`、发布方式三选、最低严重度三选、写操作风险提示、取消/确认按钮、`data-publish-phase=idle`；
- 改选 `summary` 与最低严重度 `P0`（`data-publish-mode` 与 checked 生效）→ 点取消 → `data-cr-publish-dialog=closed`，且 0 个 `review-publish` 请求；
- 设置弹层里打开自动发布开关 → `[data-auto-publish-confirm="ready"]` 出现（含写操作警告）→ 点取消 → 确认块消失、开关未开启、0 个 `publish.enabled=true` 请求、`data-auto-publish-status` 未变；
- 全程 console/pageerror=0。

**依赖运行环境的断言**（对应项记 `pending` 是正常结果，不是失败）：

| 依赖 | 缺失时的影响 |
|---|---|
| 至少一个 open PR（`/prs`） | 「候选扫描」与 `REVIEW_NOT_READY` 分支记 pending |
| 一个当前 head **没有** done 审查的 PR | `mode`/`minSeverity`/`body` 三个 `confirm:true` 守卫与 `REVIEW_NOT_READY` 全部 pending（红线不发送） |
| 一个 **done 审查且 findings>0** 的 PR | 发布按钮不出现 → 弹层字段/切换/取消三项 pending（自动发布区断言仍执行） |
| `/auto-review-status` 返回**顶层** `publish`（客户端读它；只放在 `config.publish` 时 `publishConfig=null`） | 发布按钮与自动发布区都不渲染 → 「按钮」与「设置区」两条断言失败，细节里会打印 `publishTopLevel` / `publishInConfig` |

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
│  ├─ v11-dom.mjs       # v1.1 页面探针（data-cr-* / finding 圆点 / 设置弹层 / 键盘 / 行内评论）
│  ├─ v2-dom.mjs        # v2 页面探针（合并弹层 / 对话面板 / chat localStorage）
│  ├─ v21-dom.mjs       # v2.1 页面探针（自动审查设置区/状态卡/徽章/toast）
│  ├─ v22-dom.mjs       # v2.2 页面探针（发布弹层 / 自动发布二次确认）
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
