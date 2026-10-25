# dsh-codex-review 插件：Host ↔ Client 契约（实现规范）

> 所有写代码的队友必须以此文件为准。契约变更先改这里再改代码。
> 设计背景：`docs/superpowers/specs/2026-10-24-codex-code-review-plugin-design.md`
> 侦察证据：`recon/ui-integration.md`（客户端集成）、`recon/data-access.md`（GitHub 数据）、`recon/ui-spec.md`（视觉规格）

## 0. 包形态

- 包名：`dsh-codex-review`；显示名：zh「代码审查」/ en `Code Review`
- 目录：`C:\Users\10228\dsh-codex-review\plugin\`
- `package.json`：`type: "module"`、`main: "index.js"`、`exports` 含 `"."`、`"./client"`、`"./package.json"`、`"./locale/*.json"`；`dsh.bundle.patch: "./cordis.patch.yml"`；`dsh.client: { platform: "web", immediately: true, inject: [] }`；`files` 覆盖 index.js/lib/client.js/cordis.patch.yml/icon.svg/locale。
- `cordis.patch.yml`：插入一行 `id: dsh-codex-review` / `name: dsh-codex-review`。
- `icon.svg`：原创 64×64 线性图标（深色/浅色均可读）。
- `locale/en.json`、`locale/zh.json`：`meta.title`、`meta.description` + 运行期文案（client 用 `ctx.locale.register` 注册自己的 NS，不依赖这两个文件）。

## 1. Host 半边（`plugin/index.js` + `plugin/lib/*`）

纯 ESM、**零运行时依赖**。Host 代码不 import 任何其他插件/平台包；唯一例外是 Config 的 schema 校验：`lib/config.js` 优先按三路解析（自身 `node_modules` → `DSH_PROFILE_DIR` / `DSH_HOME/profiles/<profile>` → 自包含兜底）加载 `@deepseek-ai/schemastery`（profile 已自带），解析不到时退回自包含 Standard Schema，保证 link 安装与 `node --test` 都能挂载。业务代码一律不依赖它。

```js
export const name = 'dsh-codex-review'
export const inject = ['webServer']              // 必需服务
export const Config = { /* 见 §1.3 */ }
export function apply(ctx, config) { /* 注册路由 + 缓存 + 审查引擎 */ }
```

可选服务（LLM、默认模型）用 `ctx.inject(['llm', 'agentDefaultModel'], (sub) => { ... })` 包起来，缺失时插件仍可浏览、AI 审查报 `LLM_UNAVAILABLE`。

### 1.1 路由（全部同源 POST JSON）

前缀注册：`ctx.webServer.register({ kind: 'prefix', path: '/codex-review', handler })`，全部包在 `ctx.effect(...)` 并返回 disposer。handler 内部按 `req.url` 的 pathname 分发。所有请求：
- 信任围栏（照抄 `@linxin666/dsh-client-ui-git-graph/src/host/loopback.ts` + `pair-access.ts`）：socket 远端地址 `127.0.0.0/8`/`::1`/`::ffff:127.*`；`Host` 头是 loopback；拒绝 `cf-connecting-ip` / `x-forwarded-for`；`sec-fetch-site === 'cross-site'` 拒绝；存在 `Origin` 时必须与 `Host` 同源。
- `content-type` 必须 `application/json`；body ≤ 64 KiB；读 body 用异步流并限长。
- 每个请求 15s deadline（用 AbortController + timer），超时回 `INTERNAL/Timeout`。
- 响应头 `content-type: application/json; charset=utf-8`、`cache-control: no-store`、`referrer-policy: no-referrer`。
- 信封：成功 `{ "ok": true, "value": <T> }`；失败 `{ "ok": false, "error": { "code": "...", "message": "..." } }`。

路由（客户端 fetch 路径必须是**文档相对**：`codex-review/prs`，无前导斜杠）：

| pathname | 请求 | 响应 value |
|---|---|---|
| `/codex-review/health` | `{}` | `{ gh: "ok"\|"not-logged-in"\|"missing", llm: "ok"\|"unavailable", version: "0.1.0" }` |
| `/codex-review/llm-info` | `{}` | `{ selection, reasoningEffort, efforts, transport, models?, pluginConfig }`（调试路由；LLM 不可用时报 `LLM_UNAVAILABLE`） |
| `/codex-review/prs` | `{ query?: string, limit?: number }` | `{ query, totalCount, items: PrSummary[] }` |
| `/codex-review/pr` | `{ repo, number }` | `PrDetail` |
| `/codex-review/review-start` | `{ repo, number }` | `{ jobId, headSha, cached }` |
| `/codex-review/review-status` | `{ jobId }` | `ReviewStatus` |
| `/codex-review/review-cancel` | `{ jobId }` | `{ cancelled: boolean }` |

错误码（`code`）：`BAD_REQUEST`、`GH_MISSING`（gh 未安装）、`GH_NOT_LOGGED_IN`、`GH_FORBIDDEN`、`GH_NOT_FOUND`、`GH_RATE_LIMIT`、`GH_TIMEOUT`、`GH_NETWORK`、`LLM_UNAVAILABLE`、`LLM_ERROR`、`REVIEW_TIMEOUT`、`INTERNAL`。`message` 为面向用户的中文短句（可含恢复建议）。

### 1.2 数据模型（JSON）

```ts
type PrSummary = {
  repo: string            // "owner/name"
  number: number
  title: string
  author: string
  isDraft: boolean
  state: 'open' | 'closed'
  createdAt: string       // ISO
  updatedAt: string       // ISO
  headRefName: string
  baseRefName: string
  reviewDecision?: string // "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | ""
  additions?: number
  deletions?: number
  changedFiles?: number
  url: string
}

type FilePatch = {
  path: string
  previousPath?: string
  status: 'added' | 'modified' | 'removed' | 'renamed' | 'copied' | 'changed' | 'unchanged'
  additions: number
  deletions: number
  patch: string           // unified diff hunks（不含 ---/+++ 头），可能为空
  patchTruncated: boolean
}

type PrDetail = {
  summary: PrSummary & { additions: number, deletions: number, changedFiles: number }
  body: string            // PR 正文 markdown（≤ 50 000 字符，超出截断并置 bodyTruncated）
  bodyTruncated: boolean
  files: FilePatch[]
  filesTruncated: boolean // payload 超限时 true
  comments: {
    total: number
    issue: Array<{ author: string, body: string, createdAt: string }>   // ≤ 20，body ≤ 4 000
    reviews: Array<{ author: string, state: string, body: string }>     // ≤ 20
    inline: Array<{ path: string, line: number | null, body: string, author: string, createdAt: string }> // ≤ 50
  }
  checks: {
    state: 'none' | 'pending' | 'success' | 'failure' | 'neutral' | 'unknown'
    items: Array<{ name: string, state: string, url?: string }>
  }
  stack: {
    baseRefName: string
    declaredBase?: string
    basePr?: { number: number, title: string, state: string }
    chain: Array<{ number: number, title: string, state: string }>
    allBaseMerged: boolean
  }
  review: {               // 已有审查结果摘要；没有则 state 'none'
    state: 'none' | 'running' | 'done' | 'error'
    jobId?: string
    headSha: string
    findings: Finding[]
    overview?: string
  }
}

type Finding = {
  id: string              // 稳定：`${file}:${line}:${slug(title)}` 的 hash 或序号
  severity: 'P0' | 'P1' | 'P2'
  file: string
  line: number            // 新文件行号（RIGHT side）
  lineEnd?: number
  title: string           // ≤ 80 字
  why: string             // 触发条件 → 后果
  fix: string             // 可执行动作
  category?: string       // correctness | security | data | concurrency | performance | api | test
}

type ReviewStatus = {
  jobId: string
  state: 'queued' | 'running' | 'done' | 'error' | 'cancelled'
  progress: {
    phase: 'preparing' | 'reviewing' | 'merging' | 'done'
    filesDone: number
    filesTotal: number
    startedAt: number     // epoch ms
    elapsedMs: number
  }
  headSha: string
  model?: { provider: string, model: string }
  findings: Finding[]
  overview?: string
  partial?: boolean       // 部分分块失败
  error?: { code: string, message: string }
}
```

### 1.3 Config（`export const Config`）

Cordis Loader 接受普通 JSON Schema（对象字面量）。默认值由代码兜底（`resolveConfig`），Config 只声明字段：

```js
export const Config = {
  type: 'object',
  additionalProperties: false,
  properties: {
    defaultQuery:        { type: 'string', default: 'is:open author:@me' },
    limit:               { type: 'number', default: 30 },
    maxPatchChars:       { type: 'number', default: 24000 },
    maxBodyChars:        { type: 'number', default: 50000 },
    reviewChunkChars:    { type: 'number', default: 9000 },
    maxChunks:           { type: 'number', default: 9 },
    reviewConcurrency:   { type: 'number', default: 3 },
    maxOutputTokens:     { type: 'number', default: 0 },  // 0 = 用适配器物化的模型默认上限
    provider:            { type: 'string' },
    model:               { type: 'string' },
    maxJobs:             { type: 'number', default: 20 },
    requestTimeoutMs:    { type: 'number', default: 15000 },
    ghPath:              { type: 'string', default: 'gh' },
  },
}
```

（Loader 校验接受 Standard Schema；`lib/config.js` 优先构造 Schemastery（profile 已带 `@deepseek-ai/schemastery`），解析不到时用自包含 Standard Schema。两种形态字段一致，默认值仍由 `resolveConfig` 兜底。）

### 1.4 GitHub 数据通道（`lib/github.js`）

- **主通道**：`gh auth token`（异步 `execFile`，结果缓存在内存，401 时重取一次）→ Node `fetch` 直连 `https://api.github.com`。请求头必须带 `accept-encoding: identity`（DSH 宿主注入了 undici 代理，会自动解压失效）、`user-agent: dsh-codex-review`、`x-github-api-version: 2022-11-28`。
- **兜底通道**：token 拿不到时用 `execFile('gh', ['api', ...])`（异步，绝不 spawnSync）。
- 命令/接口（`recon/data-access.md` 有逐条实测）：
  - 列表：`GET /search/issues?q=<query> is:pr&per_page=<limit>&sort=updated&order=desc`；`repo` 从 `repository_url` 解析。
  - 详情：`GET /repos/{o}/{r}/pulls/{n}`；`GET /repos/{o}/{r}/pulls/{n}/files?per_page=100&page=…`（≤ 3 页）；`GET /repos/{o}/{r}/issues/{n}/comments`；`GET /repos/{o}/{r}/pulls/{n}/reviews`；`GET /repos/{o}/{r}/commits/{headSha}/check-runs` + `/status`。
  - stack：PR body 里 `base: <branch>` 与 `#NNN` 引用 → `GET /repos/{o}/{r}/pulls?head={owner}:{baseRefName}&state=all`。
- 并发：详情各请求 `Promise.allSettled`，部分失败降级（如 checks 失败 → state 'unknown'，不整页失败）。
- 缓存（进程内存，LRU 上限 200 条）：列表 60s；PR 详情 60s；patch 内容按 headSha 缓存 30min；checks 30s。in-flight 去重（同 key 并发只跑一次）。
- 截断：单文件 patch ≤ `maxPatchChars`；响应总 patch 字符 ≤ 1.2MB（超出按文件顺序截断并置 `filesTruncated`）；body ≤ `maxBodyChars`。
- 子进程必须设置 `windowsHide: true`、超时、`maxBuffer`。

### 1.5 AI 审查引擎（`lib/review.js`）

调用方式（dsh-llm README 实测，无需 import）：

```js
const sel = ctx.agentDefaultModel.currentSelection()   // { provider, model }
const provider = config.provider ?? sel.provider
const model = config.model ?? sel.model
const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), 120_000)
let text = ''; let reason
for await (const chunk of ctx.llm.stream({
  provider, model,
  system,                                  // 字符串
  messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
  maxTokens: config.maxOutputTokens,
  signal: ac.signal,
})) {
  if (chunk.type === 'text-delta') text += chunk.text
  else if (chunk.type === 'finish') reason = chunk.reason   // { kind: 'stop'|'max-tokens'|'error'|'aborted', ... }
}
clearTimeout(timer)
```

- 分块：过滤 `patch === ''`/二进制/lockfile（`package-lock.json`、`pnpm-lock.yaml`、`*.lock`、`*.min.js`、`*.snap`）/`node_modules/`；按 `reviewChunkChars` 贪心分组，最多 `maxChunks` 组；未覆盖文件计入 `skippedFiles`。
- 每块一次串行调用；块间 yield 给事件循环（`await new Promise(r => setTimeout(r, 200))`）避免阻塞宿主。
- Prompt system（固定）：
  > 你是资深代码审查者。只报告本次 diff 引入的**真实缺陷**：正确性、安全、数据一致性、并发、边界条件、API 契约破坏、性能回归、测试缺失导致的回归风险。不要报告纯风格/格式/命名偏好，不要报告 diff 之外的问题，不要复述代码。输出严格 JSON，不要 markdown 代码围栏。
- Prompt user（每块）：PR 标题 + 正文摘要（≤ 4000 字）+ 本块文件 patch（保留 `@@` 头）+ 输出 schema：
  `{"findings":[{"severity":"P0"|"P1"|"P2","file":"路径","line":新文件行号,"lineEnd":可选,"title":"≤80字","why":"触发条件→后果","fix":"具体动作","category":"correctness|security|data|concurrency|performance|api|test"}]}`
  并声明：无问题返回 `{"findings":[]}`；`file` 必须来自所给文件列表；`line` 必须落在该文件 patch 的新增/上下文行。
- 解析：去掉 ``` 围栏 → 从第一个 `{` 找平衡括号切片 → `JSON.parse`；失败重试 1 次（追加「上一次输出不是合法 JSON，只输出 JSON」）；仍失败该块记 `partial`。
- 校验 finding：severity 白名单、file 在白名单内、line 为正整数，否则丢弃该条。
- 合并：id = `${file}:${line}:${title 归一化 hash}`；去重；排序 P0>P1>P2，再 file/line；`overview` = 确定性中文统计（如「2 个 P0 · 3 个 P1」）；`partial` = 任一块失败。
- job 表：内存 Map，上限 `maxJobs`；状态机 `queued → running → done|error|cancelled`；`review-start` 对同 `repo#number@headSha` 复用已完成 job（`cached: true`）或复用运行中 job；`review-cancel` abort。
- 失败码映射：llm 未注入 → `LLM_UNAVAILABLE`；`NO_ADAPTER`/`MISSING_CREDENTIAL`/`AUTH` → `LLM_ERROR`（带原文摘要）；超时 → `REVIEW_TIMEOUT`。

### 1.6 单测（`plugin/test/*.test.js`，`node --test`）

必须覆盖（纯函数抽到 `lib/` 里以便测试）：
- 分块器：预算/最大块数/跳过 lockfile/空 patch 文件；
- prompt 构造包含文件清单与 `@@` 头；
- 输出解析：纯 JSON / 带围栏 / 前后夹废话 / 非法 JSON / 非法字段过滤；
- 合并去重排序、overview 统计；
- 归一化：search item → PrSummary（`repository_url` 解析、`author.login`、draft、reviewDecision 空值）；
- 截断：patch/body/total payload；
- 错误映射：401/403/404/429/网络 → 错误码。
- 信任围栏单测：伪造 req 对象（remoteAddress/Host/x-forwarded-for/sec-fetch-site/Origin/content-type）→ allow/deny。

### 1.7 本地冒烟（不装 DSH 也能跑）

`plugin/test/smoke-gh.mjs`：直接 import `lib/github.js` 的 `GitHubClient`，用真实 gh 凭据拉 `Acefake/yingbox#129` 的列表与详情，打印字段形状 + 计时 + 截断标记，exit 0/1。必须实际跑通并在报告中贴输出摘要。

## 2. Client 半边（`plugin/client.js`，单文件）

必须写成 module-loader 脚本（不是 ESM、不是 JSX）：

```js
window.__ModuleLoader__.load({
  id: 'dsh-codex-review',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    // ……组件与逻辑……
    return { inject: ['slots', 'locale'], apply(ctx) { /* 注册 panellist + main */ }, __test: { /* 纯函数 */ } }
  },
})
```

- 注册（两个都要，id === key === `'codex-review'`）：
```js
ctx.effect(() => ctx.locale.register('codex-review', { en, zh }), 'codex-review: locale')
ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
  { name: 'sidebar.panellist', id: 'codex-review', order: 5, locale: 'codex-review', label: () => t('panel') },
  PanelIcon))
ctx.slots.inject('main', () => ctx.slots.register(
  { name: 'main', key: 'codex-review', locale: 'codex-review' }, CodeReviewPage))
```
- 数据：`post(path, body)` → `fetch(path, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body), signal })`，路径**无前导斜杠**；15s 超时；解 `{ok,value}|{ok:false,error}`。
- 所有 API 值类型见 §1.2。渲染必须对缺字段容错（`?.`+默认值），任何组件不得 throw。
- 视觉规格（v0.8 起）：Claude Code 桌面端风格的工作站——三栏 224 / 700–712 / 288（窄屏按既有媒体查询收起右栏/左栏），暖中性 surfaces（宿主 token 与暖纸色混合），比例字体做 UI 与正文，等宽字体只用于 diff/代码/路径/分支/SHA；10–14px 卡片圆角、1px 发丝描边、单一陶土红强调色（主操作/选中/焦点）。
- 颜色只允许 `--dsw-alias-*` token 或在其上做 `color-mix`/`rgba()` 叠加（diff 增删用 `--dsw-alias-code-diff-added` / `--dsw-alias-code-diff-deleted`，正文用 `--dsw-alias-label-primary` 等）；强调色 `--cr-accent` 固定为 `#B04E2E`（白字对比度 5.28:1，满足 AA）。
- 滚动：文档与右栏共用一个滚动容器（`.cr-body`），全页最多两条滚动条（左侧列表 + 主体）；不得为右栏再开独立滚动区。
- 视觉（v1.0，按 `recon/ui-spec.md`）：三栏 238 / 760 / 300、列距 44、主区与详情列同底色无分隔线；三列独立滚动（列表 / 文档 / 详情），文档列 = `.cr-doc`（`docRef` 挂这里，文件跳转与 tab 滚动记忆都相对它）。
- 配色（v1.0）：暗色实测 `#202020` 应用底 / `#1B1B1B` 左栏 / `#181818` 主区 / `#2D2D2D` 抬升 / `#383838` 选中；浅色用同构浅色值。比例字体做界面，等宽只用于代码/diff/路径/分支/SHA。
- 顶部审查汇总（v1.0）：AI 审查结果卡（`ReviewCard`，`data-review-state`）渲染在 PR 头部与正文之间，Summary / Changes tab 都可见；idle（无审查结果）时不渲染，符合规格的 idle 语义。
- 切换性能（客户端）：列表行 hover/focus 触发 `/pr` 预取（`prefetchDetail`，与点击共享在飞 promise）；详情按 `repo#number` 内存缓存 120s，命中即时渲染、过期先渲染再后台刷新；切换到不同 PR 时必须清空旧 `detail.value` 并渲染右栏骨架（`data-cr-details-loading`），不得继续显示上一个 PR 的右栏内容。
- 设置页（v0.9.1）不回退：行式布局 + 分段控件 + 开关，颜色跟随宿主 `--dsw-alias-*` token，禁止退回弹窗 fieldset 形式。
- 设置入口（v0.9）：注册 `settings.section`（id `codex-review`，order 60，label = 「代码审查」），内容含审查选项（localStorage `codex-review:settings`）、自动审查/发布（Host `auto-review-config`）与 health 状态；工作台齿轮弹层保留为快捷方式。修改审查选项时派发 `codex-review:settings-changed` 事件，工作台监听后重读 localStorage。
- 颜色：只能使用 `--dsw-alias-*` token 或其 color-mix/透明叠加；不得硬编码品牌色/暖色（v0.8 初版的暖底+陶土红已按用户反馈移除，见 REPORT §18）。
- 性能：`.cr-file` / `.cr-finding` / `.cr-row` 使用 `content-visibility: auto`；`FileCard` / `DiffView` / `ChangesView` 用 `React.memo` 且 props 需引用稳定（空列表用共享 `EMPTY_LIST`）。
- 组件清单（全部 `h(...)` 函数组件，状态用 hooks）：
  `PanelIcon`（接 `{size, active}`）、`CodeReviewPage`、`SearchBox`、`PrList`、`PrRow`、`PrHeader`、`TabBar`、`SummaryView`（自写 markdown 渲染：h2/h3/段落/有序无序列表/引用/代码块/行内 code/粗体/斜体/链接/分隔线，先 escape 再拼 React 元素，禁止 `dangerouslySetInnerHTML`）、`ChangesView`、`FileCard`、`DiffView`（解析 `@@ -a,b +c,d @@`，双行号列 + 内容，`+`/`-`/空格着色，上下文行；大文件默认折叠/截断）、`RightPanel`、`Section`、`StackCard`、`CommentsCard`、`ReviewersCard`、`ChecksCard`、`AiReviewCard`、`FindingItem`、`EmptyState`、`ErrorState`、`Skeleton`、`ErrorBoundary`（class 组件）。
- 交互：
  1. 进页面自动 `health` + `prs`（默认 query `is:open author:@me`）；搜索框 300ms 防抖后重拉；
  2. 点列表项 → `pr` 拉详情，选中态高亮；列表滚动位置保留；
  3. Summary/Changes 切换；Changes 里文件可折叠、可点右栏文件跳转；
  4. 「用 AI 审查」→ `review-start` → 800ms 轮询 `review-status` 直到终态；运行中显示阶段 + `filesDone/filesTotal` + 计时 + 取消；done 后渲染 findings（严重度徽章/标题/文件:行/why/fix），点 finding → 切到 Changes、展开对应文件、滚动并高亮 `line` 1.6s；
  5. error → 卡片显示 `message` + 重试；`health` 不 ok 时显示顶部提示条（gh 未登录等）；
  6. 头部放 GitHub 外链按钮（`window.open(url)`），不实现合并/评论。
- 视觉细节：等宽字体 `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`；列表行高 ~56px；文件名 `13px`；diff `12px/18px`；不使用第三方 UI 库；不使用 `require` 平台模块表以外的模块。
- 纯函数（diff 解析、markdown 分词、相对时间格式化、severity 排序）挂到返回对象的 `__test` 上供 `node --test` 引用；不得在 factory 执行期做副作用。

### 2.1 预览装置（仅开发期，`plugin/dev/`）

- `plugin/dev/preview.html` + `plugin/dev/serve.mjs`（零依赖 Node 静态服务 + mock API 端点，路径与真实路由同名）：用 `plugin/dev/mock/*.json`（从 `recon/probe-output.json` 归一化生成）渲染工作台。
- 预览页自己实现 `window.__ModuleLoader__` 桩 + 从 `plugin/dev/vendor/` 提供 react（可从 app.asar 提取 `node_modules/react/umd/react.development.js`，用 `tools/asar-read.mjs`）。**不得**把 vendor 或 dev 目录打进安装包的 `files`。

## 3. 验收（Lead + verifier 执行）

见设计文档 §10。关键断言：
1. `cordis_inspect_query` Host `Config.listConfigs{name:'dsh-codex-review'}` 出现该行；
2. `POST /codex-review/prs` 返回 22 条左右（与 `gh pr list` 一致）；
3. `POST /codex-review/pr` 对 #129 返回 24 个文件、body、stack 含 #117；
4. `POST /codex-review/review-start` + 轮询 → done，findings schema 合法（可 0 条）；
5. 页面出现「代码审查」图标，点开后三栏渲染、无 console error、无 `slot entry crashed`；
6. 运行中/错误/空态截图。

## 4. v1.1 细化契约（2026-10-24 第二轮迭代）

### 4.1 审查选项（review-start 请求体扩展）

```ts
type ReviewOptions = {
  depth?: 'fast' | 'standard' | 'deep'        // 默认 'standard'
  severityThreshold?: 'P0' | 'P1' | 'P2'      // 默认 'P2'（全部保留）；服务端据此过滤输出
  includeGuidelines?: boolean                 // 默认 true：把仓库 AGENTS.md 作为审查指引注入 prompt
}
// POST /codex-review/review-start { repo, number, options?: ReviewOptions }
// → { jobId, headSha, cached, options: ResolvedReviewOptions }   // cached=true 表示命中同 headSha+同选项的结果
```

`ResolvedReviewOptions = { depth, severityThreshold, includeGuidelines, chunkChars, maxChunks, concurrency }`（服务端把 depth 展开成具体预算，回显给 UI 展示）。

depth 预设：

| depth | chunkChars | maxChunks | concurrency | 额外行为 |
|---|---|---|---|---|
| fast | 16000 | 6 | 4 | 单遍审查 |
| standard | 9000 | 9 | 3 | 单遍审查（默认） |
| deep | 6000 | 20 | 2 | 单遍审查后加一轮「复核」模型调用：把每条 finding 连同对应 patch 行发回模型，仅保留它判定有 diff 证据的条目 |

### 4.2 Finding 扩展

```ts
type Finding = {
  // …既有字段不变…
  evidence?: string   // ≤200 字：支持该结论的 diff 行原文（可含 ± 前缀），无则为空
  confidence?: 'high' | 'medium' | 'low'   // 模型自评，可选
}
```

`ReviewStatus` / `PrDetail.review` 增加：
```ts
options?: ResolvedReviewOptions
guidelines?: { loaded: boolean, files: string[], chars: number }   // AGENTS.md 注入情况
reusedFiles?: number        // 增量审查复用的文件数（命中文件级缓存）
verdict?: 'block' | 'changes' | 'approve'   // P0>0 → block；P1>0 → changes；否则 approve
```
`findings` 依旧按 P0→P2、file/line 排序；`overview` 统计随 severityThreshold 过滤后的集合计算。

### 4.3 增量审查（文件级缓存）

- 文件级缓存 key：`repo#number|path|sha1(patch)`（进程内存 LRU ≤ 400 条，按 headSha 自然失效；切换 depth 不影响文件级结果）。
- 一次审查只把**未命中缓存**的文件送模型；命中文件直接复用其历史 findings；`reusedFiles` 回报复用数量。
- 若全部命中，直接 `done`（耗时 <1s），并置 `reusedFiles = filesTotal`。
- findings 归属：模型返回的 `file` 落在本块文件内的才接受（沿用现有白名单校验），因此文件级复用是安全的。

### 4.4 仓库审查指引（AGENTS.md）

- `includeGuidelines !== false` 时，Host 依次尝试 `gh api repos/{o}/{r}/contents/AGENTS.md`、`.github/AGENTS.md`（raw 内容，各 ≤4000 字，repo 级缓存 10 分钟），命中后作为 system 之外的「## 仓库审查指引」段落注入每个分块 prompt。
- 失败/不存在不阻塞审查：`guidelines: { loaded: false, files: [], chars: 0 }`。
- 指引内容只作为审查偏好（例如该仓库特有的约束），不能覆盖「只报 diff 引入的真实缺陷」这条系统约束。

### 4.5 客户端（client.js）细化项

1. **diff 行内 finding 卡片**：命中 `finding.line` 的 diff 行渲染 gutter 圆点；点击圆点/卡片在行下方展开卡片（严重度、标题、为什么、怎么改、confidence、evidence、定位按钮）。同一行多条时折叠为「N 条」。
2. **已有 GitHub 行内评论**：把 `PrDetail.comments.inline` 按 `path + line` 渲染为只读评论卡（作者、正文前 400 字、时间），与 finding 卡视觉区分（灰/蓝边 vs 严重度色）。
3. **审查设置弹层**（齿轮）：depth（快/标准/深）、severityThreshold（P0 / P1 / P2+）、includeGuidelines（开关），存 `localStorage['codex-review:settings']`，审查时作为 `options` 传 `review-start`；弹层内说明「deep 多一轮复核、耗时更长」。
4. **审查卡改版**：verdict 徽章（block 阻塞 / changes 需要修改 / approve 建议合并）+ P0/P1/P2 计数 + 本地过滤 chips（全部/P0/P1/P2，纯前端过滤，不重跑）+ reusedFiles/guidelines 状态行 + 重新审查（带当前设置）。
5. **体验细节**：详情列 sticky；`j/k` 上下切 PR、`/` 聚焦搜索、`r` 触发审查、`Esc` 关弹层；所有可点元素有 focus-visible 与 aria-label；切换 Summary/Changes 保留滚动位置；右栏文件列表点击滚动到对应文件。
6. 文案全部走 locale（zh/en），不新增硬编码英文。

### 4.6 v1.1 验收补充

1. `review-start` 带 `{depth:'fast'}` 与默认设置产生**不同 job key**，各自完成；同设置同 headSha 第二次调用 `cached=true`。
2. 同一 PR 在 headSha 不变时把某文件 patch 改小（测试用 mock）→ `reusedFiles > 0` 且耗时显著下降（单元测试即可，不要求真实 PR）。
3. `includeGuidelines: true` 且仓库存在 AGENTS.md 时，`guidelines.loaded=true`、prompt 中包含指引段落；不存在时 `loaded=false` 且审查正常。
4. severityThreshold=`P0` 时输出 findings 全为 P0；`P2` 时保留全部。
5. deep 复核轮次在单测中用 fake stream 验证：证据不足（模型返回空保留列表）的 finding 被丢弃。
6. 页面：diff 内 finding 卡片可展开、已有评论可见、设置弹层改设置后审查请求带对应 options、`j/k/r//` 生效、console 0 error。

## 5. v2 契约：合并（写操作）与 PR 对话（2026-10-24 第三轮迭代，版本 0.3.0）

用户要求把右侧「合并」与底部「就此 Pull Request 提问」真正接上。v1/v1.1 的只读约束在此解除，但**写操作必须有显式用户确认**，且默认不做任何自动写。

### 5.1 合并路由（写操作）

```ts
// POST /codex-review/merge
type MergeRequest = {
  repo: string
  number: number
  method: 'merge' | 'squash' | 'rebase'   // 必填；无默认，由 UI 弹层选择
  expectedHeadSha: string                  // 必填：用户看到的 head；服务端校验未移动
  commitTitle?: string                     // squash/rebase 可覆盖标题；≤ 256
  commitMessage?: string                   // ≤ 2000
  deleteBranch?: boolean                   // 默认 false；合并后删 head 分支
  confirm: true                            // 必填且必须为 true（缺省/否 → BAD_REQUEST）
}
// 成功 → { merged: true, sha: string, message: string, branchDeleted?: boolean }
```

服务端守卫（顺序执行，失败即返回错误信封）：
1. `confirm !== true` → `BAD_REQUEST`（400 语义，信封 code）。
2. 拉 PR：`state !== 'open'` → `MERGE_NOT_ALLOWED`（已合并/已关闭说明原因）；`isDraft` → `MERGE_NOT_ALLOWED`。
3. `head.sha !== expectedHeadSha` → `MERGE_HEAD_MOVED` + `message` 带当前 headSha 前 12 位（客户端提示刷新后重试，**绝不合并**）。
4. mergeable 检查：`mergeable === false` → `MERGE_CONFLICT`；`mergeable === null`（GitHub 计算中）最多重取 2 次、每次间隔 800ms，仍为 null 时按 `mergeStateStatus` 判断，无法判定 → `MERGE_NOT_ALLOWED`。
5. 调 GitHub `PUT /repos/{o}/{r}/pulls/{n}/merge`，body `{ merge_method, sha: expectedHeadSha, commit_title?, commit_message? }`；HTTP 405/409 → `MERGE_CONFLICT`；403 → `GH_FORBIDDEN`；404 → `GH_NOT_FOUND`。
6. `deleteBranch === true` 且 head 分支属于本仓库 → `DELETE /repos/{o}/{r}/git/refs/heads/{headRefName}`；失败（受保护分支/已删除）不改变合并成功结果，回 `branchDeleted: false` 并附 `branchWarning`。
7. 成功后清掉该 PR 的详情缓存与 `repo#number@*` 审查 job（head 已失效）。

错误码新增：`MERGE_CONFLICT`、`MERGE_NOT_ALLOWED`、`MERGE_HEAD_MOVED`。所有分支必须有单测（fake GitHub client），**成功合并路径只做单测，不在真实 PR 上执行**。

### 5.2 PR 对话（流式）

- 路由：`POST /codex-review/chat`，`kind: 'exact'` 独立注册；响应 `text/event-stream`，帧格式：
  - 文本：`data: {"delta":"…"}\n\n`
  - 结束：`data: {"done":true,"model":{"provider","model"},"usage"?:…}\n\n`
  - 错误：`data: {"error":{"code","message"}}\n\n` 后关闭
- 请求：
```ts
type ChatRequest = {
  repo: string
  number: number
  messages: Array<{ role: 'user' | 'assistant', content: string }> // 客户端持有历史，最后一条必须是 user
  focusFile?: string        // 可选：当前展开文件的路径，附带该文件 patch 作为上下文
}
```
- 服务端上下文（总预算 ≤ 24 000 字）：
  1. system：`你是该 Pull Request 的代码审查助手。只依据给出的 PR 信息回答；不确定就直说，不要编造文件或行号。回答用中文、简洁，可用列表/代码片段。`
  2. PR 元信息：标题、编号、作者、状态、head→base、增删行数、变更文件清单（路径 + 状态 + +/−）。
  3. PR 正文（≤ 3000 字）。
  4. 最近一次 AI 审查结果摘要（若有缓存）：overview + findings 的 severity/file:line/title（≤ 30 条）。
  5. `focusFile` 存在时附该文件 patch（≤ 4000 字）。
  6. 对话历史：最多取最后 10 条、每条 ≤ 4000 字。
- 模型：沿用 prepared-call seam；`sessionId = chat-<repo>#<number>`（同一 PR 对话复用 provider 路由缓存）；`maxTokens` 用配置默认；单次回答 180s deadline；请求级 5 分钟 deadline。
- 限流/防护：同时最多 2 个 chat 流（超出返回 `BUSY`）；客户端 abort 时 Host 中止上游模型流。
- 错误码：`LLM_UNAVAILABLE`、`LLM_ERROR`、`BUSY`、`BAD_REQUEST`。
- 客户端：
  - 底部输入框接入：占位「就此 Pull Request 提问」，Enter 发送、Shift+Enter 换行；
  - 右侧浮动对话面板（宽 ≤ 420、高 ≤ 60%），消息气泡（user/assistant）、流式光标、停止按钮、清空对话、错误气泡与重试；
  - 快捷提问：`总结这个 PR 的改动`、`有哪些风险点`、`怎么测试`；
  - 每个 PR 的对话历史存 `localStorage['codex-review:chat:<repo>#<number>']`（≤ 20 条，切换 PR 时恢复）；
  - 「定位到 diff」等既有能力不受影响。

### 5.3 合并 UI

- 顶栏「合并」按钮：`state=open && !merged` 时可点；点击打开确认弹层：
  - 展示 `repo#number`、标题、`head → base`、headSha 前 7 位；
  - 合并方式单选：Squash（推荐）/ Merge commit / Rebase；删除源分支 checkbox（默认关）；
  - 风险提示：这是写操作，会真实改变 GitHub 仓库；
  - 确认按钮「确认合并」→ `POST /codex-review/merge`（带 `expectedHeadSha`）；成功 toast + 刷新详情；`MERGE_HEAD_MOVED` 时提示「PR 有新提交，已刷新」并刷新；
  - 失败展示 code/message；按钮在处理中禁用并显示进度。
- 已合并/已关闭/草稿：按钮禁用并给出 title 说明。

### 5.4 v2 验收补充

1. 单测：合并路由 confirm 缺失、head 移动、mergeable=false、成功（fake client）、deleteBranch 失败降级、错误码映射；chat 的上下文拼装（预算/历史裁剪/focusFile/审查摘要注入）与 SSE 帧编码。
2. 真实环境：**不做真实合并**；只验证守卫（`confirm:false` → BAD_REQUEST；stale `expectedHeadSha` → MERGE_HEAD_MOVED）与 UI 弹层字段/取消。
3. 真实 chat：对 #129 提一个真实问题（如「这个 PR 改了什么」），验证流式返回非空、含 PR 上下文、无 console error。
4. 页面：合并按钮可点并打开弹层、取消不写入；输入框发送 → 面板出现流式回答；历史按 PR 隔离；`Esc` 关闭面板；console 0 error。

## 6. v2.1 契约：自动审查（2026-10-24 第四轮迭代，版本 0.4.0）

目标：后台定时扫描开放 PR，发现「新 PR / 新提交」时自动运行 AI 审查，结果进入既有审查缓存与 UI；**默认关闭，且绝不自动向 GitHub 写任何内容**（不发评论、不合并）。

### 6.1 配置（Host 持久化，UI 可改）

Host 在插件自有的状态文件里持久化配置与「已审查到哪个 head」的游标：

- 文件：`<DSH_PROFILE_DIR>/.codex-review/auto-review.json`（无 profile 时回退 `~/.dsh/codex-review/auto-review.json`）；目录不存在则创建；原子写（tmp + rename）；损坏则重建并保留 `backup` 后缀。
- 结构：
```ts
type AutoReviewFile = {
  version: 1
  config: {
    enabled: boolean            // 默认 false
    intervalSeconds: number     // 默认 180，范围 60–3600
    query: string               // 默认 'is:open author:@me'
    depth: 'fast' | 'standard' | 'deep'   // 默认 'fast'
    severityThreshold: 'P0' | 'P1' | 'P2' // 默认 'P2'
    includeDrafts: boolean      // 默认 false
    maxPerCycle: number         // 默认 2，范围 1–5
  }
  seen: Record<string, { headSha: string, at: number }>  // key = repo#number
  lastCycleAt?: number
}
```
- `enabled` 变更立即生效（不需重载插件）；`intervalSeconds` 变更在当前计时结束后生效。

### 6.2 调度器（Host）

- 插件 apply 时创建 `AutoReviewer`（`lib/auto-review.js`），由 `ctx.effect(() => () => reviewer.dispose())` 管理；内部用可注入的 `setInterval/clearInterval` 与 `now()` 便于单测。
- 每 `intervalSeconds` 一个 cycle：
  1. 若 `enabled !== true` → 记 `skipped: disabled` 并结束。
  2. 用 `query` 拉 PR 列表（复用 `GitHubClient.listPullRequests`）；过滤：`state==='open'`、`isDraft && !includeDrafts` 跳过、`repo#number` 已有进行中 job 跳过。
  3. 取 PR 详情拿 `headSha`（列表接口没有 head sha）；与 `seen[key].headSha` 相同则跳过（已审过该提交）。
  4. 对需要审查的 PR 依次（并发 1）调用 `ReviewEngine.start(repo, number, headSha, files, { depth, severityThreshold, includeGuidelines:true })`；最多 `maxPerCycle` 个；其余留到下一 cycle。
  5. 每次审查结束后（done/error/cancelled）更新 `seen[key] = {headSha, at}` 并写入 `recent` 结果（内存，最多 20 条）：`{repo, number, headSha, state, findings, verdict, overview, finishedAt, error?}`；`error` 也写 seen（避免每轮重试同一失败），但 30 分钟后允许重试一次（`retryAfterMs`）。
- 手动触发：`auto-review-run` 立即执行一次 cycle（不看间隔，enabled 关闭时也允许一次手动检查？——不：必须先 enabled=true 或带 `{ force: true }`，force 仅本次运行）。
- 并发：同一时刻最多 1 个 cycle；cycle 中同时最多 1 个审查 job（串行）。
- 失败隔离：单个 PR 失败只记录，不影响后续 PR 与后续 cycle。

### 6.3 路由

| pathname | 请求 | 响应 value |
|---|---|---|
| `/codex-review/auto-review-status` | `{}` | `AutoReviewStatus` |
| `/codex-review/auto-review-config` | `{ patch: Partial<Config> }` | `AutoReviewStatus`（校验/夹取后回显） |
| `/codex-review/auto-review-run` | `{ force?: boolean }` | `{ started: boolean, reason?: string }` |

```ts
type AutoReviewStatus = {
  config: AutoReviewConfig            // 当前生效配置（含 config.publish，状态文件形态）
  publish: PublishConfig              // 发布配置的顶层副本（客户端发布 UI 读这里，见 §7.1）
  running: boolean                    // cycle 进行中
  lastCycleAt?: number
  nextCycleAt?: number                // 预计下一次（running 时省略）
  seenCount: number
  recent: Array<{ repo, number, headSha, state: 'done'|'error'|'cancelled', findings: number, verdict?, overview?, finishedAt, error? }>  // 最新在前，≤20
  lastError?: { code: string, message: string }   // 最近一次 cycle 级错误（如 gh 失败）
}
```
- 非法 patch 字段忽略并夹取（interval 60–3600 等）；未知字段忽略。
- `auto-review-run` 在 `running===true` 或 `enabled!==true && force!==true` 时返回 `{started:false, reason}`。

### 6.4 客户端

- 「审查设置」弹层顶部新增「自动审查」区：开关（默认关）、间隔（60/180/600 秒预设 + 自定义 60–3600）、深度、严重度阈值、是否包含草稿、每次最多审查数（1–5）、查询语句；改动即 `POST auto-review-config` 持久化，回显以 Host 为准。
- 右栏新增「自动审查」卡（可折叠）：状态（开启/关闭、上次/下次、最近结果列表，点击结果跳转并打开对应 PR）、「立即检查」按钮（force）、`running` 时禁用并显示进度。
- 页面级：每 15 秒轮询 `auto-review-status`（仅工作台可见时）；发现 `recent` 出现新的 `done` 结果 → toast「自动审查完成：repo#n · X 个问题」+ 列表行显示「已自动审查」徽章（有 findings 时显示数量）。审查结果本身通过既有 `/pr` 返回（按 head sha 命中缓存）。
- 关闭自动审查后停止轮询与通知（仍显示历史 recent）。

### 6.5 v2.1 验收补充

1. 单测：配置夹取/未知字段、状态文件读写（损坏/回退）、cycle 判定（disabled / draft / 已审同 head / 已审失败重试窗口 / maxPerCycle 截断）、串行与并发 1、cycle 级错误记录、`auto-review-run` 的 running/force 语义。
2. Host 集成（真实数据 + fake LLM 或短间隔）：`enabled=true, intervalSeconds=60, depth='fast'` → 手动 force cycle 对当前 open PR 触发审查；第二轮 cycle 不重复（seen 命中）；`auto-review-status` 回显 recent。
3. 页面：设置弹层可开关自动审查并持久化；状态卡显示上次/下次与结果；手动「立即检查」；关闭后不再触发；console 0 error。
4. 安全：自动审查**不调用任何 GitHub 写接口**（单测断言 `/merge`、评论接口零调用）；默认 `enabled=false`；不改用户仓库。

## 7. v2.2 契约：把审查发布到 GitHub（2026-10-24 第五轮迭代，版本 0.5.0）

用户问「审查后会自动提交问题到对应分支吗」。当前回答：**不会**——自动审查只读，结果在插件内展示。v2.2 提供「把审查意见作为 GitHub PR Review 发布」：手动必须显式确认；自动发布默认关闭、需用户显式打开并二次确认。**仍然不会自动修改代码或向分支推送提交**（不做 auto-fix，另行评估）。

### 7.1 配置（并入 auto-review 状态文件）

```ts
type PublishConfig = {
  enabled: boolean              // 自动发布开关：开启后自动审查与手动「用 AI 审查」完成的审查都会自动发布；默认 false（用户点「确认发布」不受此开关限制）
  mode: 'inline' | 'summary' | 'both'   // 默认 'inline'
  minSeverity: 'P0' | 'P1' | 'P2'       // 默认 'P2'（全部）
  maxComments: number           // 默认 20，范围 1–50
}
// auto-review-config 的 patch 可带 publish: Partial<PublishConfig>；夹取同上。
```

`/auto-review-status` 的返回值在**顶层**同时暴露 `publish`（客户端发布 UI 读顶层；状态文件与 `config` 里仍是 `config.publish`）。两边必须一致，否则发布按钮与自动发布设置区不渲染。

### 7.2 路由：`POST /codex-review/review-publish`

```ts
// 请求
type PublishRequest = {
  repo: string
  number: number
  mode?: 'inline' | 'summary' | 'both'   // 默认 config.publish.mode
  minSeverity?: 'P0' | 'P1' | 'P2'       // 默认 config.publish.minSeverity
  body?: string                          // 可选：覆盖摘要正文（≤4000）
  headSha?: string                       // v2.5：绑定到用户看到的那次审查的 head
  jobId?: string                         // v2.5：绑定到具体 job，取该 job 的结果而不是"最新 job"
  confirm: true                          // 必填
}
// 成功 → { published: true, reviewId: number, url: string, comments: number, skipped: number, headSha: string, action: 'created' | 'updated' | 'unchanged' }
```

行为：
1. `confirm !== true` → `BAD_REQUEST`；`mode`/`minSeverity` 非法 → `BAD_REQUEST`。
2. 确定 head 与审查结果：带 `jobId` 时用该 job 的 `status()`（未知 id → `REVIEW_NOT_READY`），否则取当前 PR headSha 后在 engine 里找该 head 已完成（`done`）的结果；没有 → `REVIEW_NOT_READY`。head 不一致 → `REVIEW_NOT_READY`。
   - v2.5：`partial === true` 的审查不能发布 → `REVIEW_PARTIAL`（结果不完整时不允许当作完整结论写进 PR）。
   - v2.5：发布前用**未缓存**的接口重新读一次 head，与目标 head 不同 → `REVIEW_HEAD_MOVED`（60 秒缓存里的 head 可能已经过期）。
3. 过滤：`severity` 按 P0>P1>P2 不弱于 `minSeverity`；`file` 非空、`line` 正整数；按严重度/file/line 排序；行内评论最多 `maxComments` 条。
4. 去重：先拉该 PR 已有 review comments，解析 marker `<!-- dsh-codex-review:<findingHash> -->`；**只信任当前 token 登录用户写的评论**（v2.5：别人伪造的 marker 不能压制 finding）；命中 marker 的 finding 跳过（`skipped` 计数）。`findingHash = sha1(file:line:title)` 同 review 内的 id。
5. 构造并提交 GitHub review：`POST /repos/{o}/{r}/pulls/{n}/reviews`，`event: 'COMMENT'`；
   - `mode` 含 inline：`comments: [{ path, line, side: 'RIGHT', body }]`，body = `**[P1] 标题**\n\n为什么：…\n\n建议：…\n\n<!-- dsh-codex-review:<hash> -->`（每条 ≤2000 字；标题/why/fix 截断；v2.5：模型文本里的 HTML 注释被剥掉、`@` 转义，避免伪造 marker 或误 @ 通知）；
   - `mode` 含 summary 或 inline 为空：`body` = `**代码审查（dsh-codex-review）**\n\n<overview>\n\n` + 逐条 `- [P1] file:line 标题`（v2.5：列出**全部满足严重度阈值的 findings**，既不受行内 marker 去重影响、也不受 `maxComments` 截断；`maxComments` 只限制行内评论条数），末尾固定追加隐藏 marker `\n\n<!-- dsh-codex-review:summary -->`（总长 ≤4000 字，含 marker）；若请求带 `body` 则用它覆盖生成内容（同样追加 marker）。
   - v2.5：一次 `POST` 被 GitHub 422 拒绝（典型原因：行内评论的 `line` 不在 diff 内）时，自动去掉行内评论重试一次，保住汇总；此时 `comments: 0`。错误信息带上 GitHub `errors[]` 里的首个原因。
6. 记录已发布（v2.4 起两套记录，都持久化在 auto-review 状态文件）：`repo#number@headSha` → `{publishedAt, reviewId, url, fingerprint, request}`（同一 head + 同一请求参数幂等，重复调用直接回放、0 次 GitHub 读与写；v2.5：`request = sha1(mode+minSeverity+maxComments+body)`，参数变了就必须真的发布，不能被同 head 的旧记录挡掉）；`repo#number` → `{publishedAt, reviewId, url, fingerprint}`（该 PR 的滚动汇总 review 身份 + 本次内容指纹，供重启后继续原地更新）。
   - v2.5：两条记录用**一次**状态文件原子替换写入（`setPublishedMany`），避免交错写入留下半条记录；`reviewId <= 0` 或 `url` 为空的记录不落盘（否则会永久回放一个空链接）。
7. 错误码：`BAD_REQUEST`、`REVIEW_NOT_READY`、`REVIEW_PARTIAL`、`REVIEW_HEAD_MOVED`、`GH_FORBIDDEN`、`GH_NOT_FOUND`、`GH_RATE_LIMIT`、`GH_NETWORK`、`PUBLISH_UNKNOWN`、`INTERNAL`。`PUBLISH_UNKNOWN` 表示**写请求结果未知**，出现在两种情况：发布自身的 30 秒预算耗尽；或 GitHub 对写请求返回 5xx。写可能已经落库，提示用户先刷新 PR 再决定重试，不直接映射成 `GH_NETWORK`（那会被理解成"什么都没发生"）。
8. 自动发布：auto-review cycle 审查 `done` 后，若 `config.publish.enabled === true` → 自动调用同一发布逻辑（同一套过滤/去重/滚动更新）；失败只记 `lastError`，不重试风暴；重载/重启后同 head 不重复发布（published 记录持久化）。0.5.1 起同一自定发布逻辑也适用于**手动 `review-start`** 产生的 job：完成后（`done`）在后台自动发布，fire-and-forget、失败只记日志，发布前重新读取开关（审查期间关掉则不发布）。
   - v2.5：自动发布把当次 cycle 的 `headSha` 与 `jobId` 一起传下去，发布器不再自己去猜"最新 job"；`partial` 的审查直接跳过并记日志。
9. 滚动更新（v2.4）：同一 PR 只保留**一条**汇总 review。首次发布 `POST` 创建；之后内容变化时 `PUT /repos/{o}/{r}/pulls/{n}/reviews/{id}` 只替换 body，不新增 review 条目（GitHub 时间线只标记 edited）。`fingerprint = sha1(summaryBody + 行内评论 bodies)` 与 `repo#number` 记录相同 → 不写 GitHub（新 head 只刷新本地 head 记录）。行内评论提交后 GitHub 不允许追加：只有从未发布过的 finding 会以一条无 body 的新 review 补发，汇总 review 的 id 保持不变。状态文件丢失时先 `GET /pulls/{n}/reviews`，按 `<!-- dsh-codex-review:summary -->` 找回既有汇总 review 再更新，绝不重复创建；本地记录的 review 在 GitHub 已不存在（404）时才回退为新建。同一 PR 的不同 head 发布串行（per-PR lock），避免滚动记录竞争。
   - v2.5：找回时**只认当前 token 用户本人**的 review（`author` 必须匹配），且兼容 v2.4 之前没有 marker 的历史汇总 review（以固定标题 `**代码审查（dsh-codex-review）**` 开头 + 作者匹配即可采纳，采纳后立即补上 marker）。别人写的带 marker 的 review 不会被接管、也不会被 `PUT` 改写。
   - v2.5：只有真正带汇总 body 的 review 才写入 `repo#number` 滚动记录；纯行内发布（无 body）不再覆盖滚动身份，避免时间线上出现两条带 marker 的 review。
   - v2.5：`listPullReviews` / `listPullReviewComments` 都翻页读完（review 最多 20 页 × 100，评论最多 10 页 × 100），状态丢失后旧 marker 不会因为分页而漏掉。
   - v2.5：发布器在 dispose 时清空 in-flight 与 per-PR 锁，插件重载不会让排队中的发布永远等待。

### 7.3 客户端

- 审查卡：`done` 且有点 `findings` 时显示「发布到 GitHub」；点击弹确认弹层（mode 三选、最低严重度、预计评论数=过滤后条数、「这会真的在 PR 上创建 review 评论」警告、发布/取消）；成功 → 按钮变「已发布 · 在 GitHub 查看」（新窗口打开 url）；已有发布记录时显示已发布徽章。
- v2.5：请求体会带上当前审查的 `headSha` 与 `jobId`；发布请求的超时预算放宽到 35 秒（宿主内是 30 秒，多出来的时间留给响应回传）。
- v2.5：成功提示按 `action` 区分：`created` → 「已发布到 GitHub（N 条评论）」、`updated` → 「已更新 GitHub 上的审查（没有新增行内评论）」、`unchanged` → 「和上次发布相比没有变化」。不再用 `comments: 0` 冒充失败。
- v2.5：`partial` 的审查在客户端就拦下来（提示重新审查），不留到宿上报错。
- 自动审查设置区：新增「发布审查到 GitHub」开关（默认关）+ mode/minSeverity/maxComments；打开开关时二次确认（写操作警告：一个 PR 会保留一条汇总 review，后续审查原地更新它，只有新行内问题会补发）。
- 错误：`REVIEW_NOT_READY` → 提示先审查；`REVIEW_PARTIAL` → 提示审查不完整需重跑；`REVIEW_HEAD_MOVED` → 提示重新审查；`PUBLISH_UNKNOWN` → 提示先刷新 PR 确认；`GH_FORBIDDEN` → 提示 token 权限；旧 Host 无路由 → 按钮隐藏并降级（v2.5：`GH_NOT_FOUND` 不再被当成"旧 Host 无路由"，仓库/PR 不存在时按钮要留着）。

### 7.4 v2.2 验收

1. 单测：finding→inline 评论映射（path/line/side/body/marker/截断）、severity 过滤、maxComments 截断、已有 marker 去重、confirm/mode/minSeverity 校验、错误码映射、发布记录持久化、自动发布仅在 `publish.enabled` 时发生、自动发布失败不重试风暴。
2. 真实环境：**默认不做真实发布**（避免在用户 PR 上产生未经请求的评论）；只验证守卫（confirm:false → BAD_REQUEST；mode 非法 → BAD_REQUEST；无审查结果 → REVIEW_NOT_READY）与 UI 弹层字段/取消（Network 0 publish 请求）。
3. 若用户明确要求，可对某个 PR 发布一次并在报告记录 URL（默认不做）。
4. 页面：发布按钮/弹层/取消、自动发布开关与二次确认、已发布徽章/链接、旧 Host 降级、console 0 error。

### 7.5 v2.4 验收（滚动发布）

1. 单测：`publishFingerprint` 稳定性/变化；同一 PR 新 head 内容未变 → 0 次 create/update；内容变化 → 1 次 `updatePullReview`（reviewId 不变、无新 review）；`both` 模式新 finding → 更新汇总 + 一条无 body 的新 review（只含新评论）；状态丢失后按 summary marker 找回并更新；记录中的 review 404 → 回退新建；同 head 并发仍只写一次；不同 head 串行（per-PR lock 释放）。
2. 真实环境：默认仍只验证「同 head 回放 0 写」与 health/version；不主动对用户 PR 发写请求。真实滚动更新在用户下一次审查（自动发布开启时）自然发生，可在 PR 时间线确认只有一条 review 被 edited。

### 7.6 v2.5 验收（发布链路的正确性与不变量）

针对 v2.4 审计出的 19 项问题，逐项落地并验收：

1. `partial` 的审查不可发布：`publish()` 与两处自动发布都在 `done` 之外再检查 `partial`，命中 → `REVIEW_PARTIAL`，0 次 GitHub 写。快照（`engine.existing`）与 `engine.status` 都带上 `partial`/`partialReasons`，UI 在打开发布弹层前就拦住。
2. 发布绑定到具体 job/head：请求可带 `headSha`/`jobId`（客户端一定带）；自动发布传当次 cycle 的 `headSha` 与 `jobId`。发布前用未缓存的 `getPullHead` 复核 head，变了 → `REVIEW_HEAD_MOVED`。
3. 同 head 幂等只在"同一请求"成立：head 记录存 `request = sha1(mode+minSeverity+maxComments+body)`，改 mode/严重度/正文后会重新发布，不再静默 0 写。
4. 纯行内发布不再接管滚动身份：只有带汇总 body 的 review 写 `repo#number`，避免时间线上出现两条带 marker 的 review。
5. 汇总完整：`preparePublish` 用未截断的 `eligible` 渲染 summary，`maxComments` 只限制行内条数。
6. 摘要恢复只信任本人：`findPublishedSummaryReview(reviews, author)` 校验 `author`；并兼容 v2.4 之前无 marker 的历史汇总（固定标题 + 作者）。
7. 行内去重只信任本人 marker：`parsePublishMarkers(comments, author)`。
8. 空记录不再回放：`sanitizePublishedMap` / `setPublished` / `setPublishedMany` 要求 `reviewId > 0` 且 `url != ''`。
9. 分页读全：`listPullReviews`（20×100）、`listPullReviewComments`（10×100）。
10. 原子持久化：`setPublishedMany` 一次写好 head + rolling 记录；`persistState` 用临时文件 + rename，且不再 pretty-print。
11. 状态文件有界：`prunePublishedMap` 保留全部滚动记录 + 最新 200 条 head 记录；失败重试改由 `seen[key].failedAt` 决定，不再依赖会被挤掉的 `recent`。
12. 发布有时间预算：发布器 `PUBLISH_TIMEOUT_MS = 30s`，路由 deadline 为 35s，客户端等待 35s；预算耗尽 → `PUBLISH_UNKNOWN`（写可能已落库）。
13. 422 降级：去掉行内评论重试一次保住汇总，`comments` 报实际落地的数量；错误信息带 GitHub `errors[]` 首个原因。
14. 模型文本净化：`sanitizeModelText` 去掉 HTML 注释、转义 `@`。
15. 客户端不再把 `GH_NOT_FOUND` 当成"旧 Host 无路由"；成功提示按 `action` 区分 created/updated/unchanged。
16. dispose 清理：`ReviewPublisher.dispose()` 清空 in-flight 与 per-PR 锁，并拒绝后续发布。

真实验证（只读）：`getPullHead` / `getAuthenticatedUser` / 分页 `listPullReviews` / `listPullReviewComments` 在 Acefake/yingbox 上跑通；PR #139（23 reviews）、#141（19）、#145（4）都只解析出**一条**汇总 review，`findPublishedSummaryReview` 与本地 `repo#number` 记录一致；#141 的历史汇总（无 marker，id 5641425505）被"固定标题 + 作者"规则识别。#139/#141 的 marker 均属于当前 token 用户，伪造作者时解析结果为 0（`foreignMarkers=0`）。

## 8. v2.3 契约：评论写操作（2026-10-25 第六轮迭代，版本 0.6.0）

目标：接上「回复已有行内评论 / 解决讨论线程 / 发表 PR 总评论」。三者都是写操作，必须显式确认；插件仍然**不修改代码、不推送提交、不合并**。

### 8.1 路由

| pathname | 请求 | 响应 value |
|---|---|---|
| `/codex-review/comment` | `{ repo, number, body, confirm:true }` | `{ id, url, createdAt }`（`POST issues/{n}/comments`） |
| `/codex-review/reply` | `{ repo, number, commentId, body, confirm:true }` | `{ id, url, createdAt }`（`POST pulls/{n}/comments/{commentId}/replies`） |
| `/codex-review/resolve` | `{ repo, number, threadId, confirm:true }` | `{ resolved: boolean }`（GraphQL `resolveReviewThread`） |

校验顺序：`repo/number` → `confirm===true` → 其余字段（`body` 1..4000、`commentId` 正整数、`threadId` 1..200）。错误码：`BAD_REQUEST`、`GH_FORBIDDEN`、`GH_NOT_FOUND`、`GH_RATE_LIMIT`、`GH_NETWORK`、`GH_TIMEOUT`、`INTERNAL`。

### 8.2 数据层（`lib/github.js`）

- `loadInlineComments` 补充 `id`、`inReplyToId`、`reviewId`；`loadPull` 并行调用 `loadReviewThreads`，把 GraphQL `reviewThreads` 的 comment `databaseId` → `{ threadId, isResolved }` 合并进 `PrDetail.comments.inline`。GraphQL 不可用时该查询失败只降级为「无 resolve 操作」，不影响详情加载。
- `createIssueComment` / `replyToReviewComment` 走既有 token→fetch 主通道 + `gh api` 兜底，成功后 `invalidatePullCache(repo, number)`；`resolveReviewThread` 走 GraphQL（fetch `/graphql`，兜底 `gh api graphql`）。
- 写请求永不缓存；`body` 在数据层再校验一次（边界纪律，不依赖路由层）。

### 8.3 客户端

- 行内评论卡：`[data-action="inline-reply"]` 打开 `[data-inline-reply-composer="ready"]`（发送 `[data-action="inline-reply-send"]`、取消 `[data-action="inline-reply-cancel"]`）；`[data-action="inline-resolve"]` 打开 `[data-inline-resolve-confirm="ready"]`（`[data-action="inline-resolve-confirm"]` / `inline-resolve-cancel`）。已解决显示「已解决」并隐藏操作；没有 commentId/threadId 时对应按钮不渲染（旧 Host 自动降级）。
- PR 头 `[data-action="pr-comment"]` → 弹层 `[data-cr-comment-dialog="open|closed"]`、`[data-comment-phase="idle|submitting|error"]`，`[data-action="comment-send"]` / `comment-cancel`。
- 取消/关闭一律不发请求；成功后 toast + 重新拉取 `/pr`（不重置审查卡）；失败回显错误码文案。

### 8.4 验收

1. 单测：行内评论 id/thread 映射、GraphQL 错误映射、三个写请求的方法/路径/body、缓存失效、参数校验；路由的 confirm 与字段校验及转发；客户端 normalize 新字段。
2. 装置 `--v23`：只发会被校验拒绝的请求（缺/假 confirm、非法字段），安全计数 `confirmTrueSent=0`、`writes=0`；页面只打开编辑器/弹层后取消，Network 断言 0 个写请求。
3. 真实回复/解决/发表评论默认不做（需用户明确要求）；若执行，在报告记录 URL。



