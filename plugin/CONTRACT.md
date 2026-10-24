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

纯 ESM、**零 npm 依赖**（不 import 任何 `@deepseek-ai/*`；`@deepseek-ai/schemastery` 也不要用，Config 用普通 JSON Schema 形式见 §1.3）。

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
    reviewChunkChars:    { type: 'number', default: 18000 },
    maxChunks:           { type: 'number', default: 6 },
    maxOutputTokens:     { type: 'number', default: 4096 },
    provider:            { type: 'string' },
    model:               { type: 'string' },
    maxJobs:             { type: 'number', default: 20 },
    requestTimeoutMs:    { type: 'number', default: 15000 },
    ghPath:              { type: 'string', default: 'gh' },
  },
}
```

（如果 Loader 校验要求 schemastery 实例，Host 实现先用普通对象试；失败则退回 `import z from '@deepseek-ai/schemastery'` 并在报告中说明。）

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
- 视觉规格：遵循 `recon/ui-spec.md` §1–§3（三栏、内容簇宽度、四层背景色、右栏小节样式、diff 样式）。颜色只允许 `--dsw-alias-*` token（diff 增删用 `--dsw-alias-code-diff-added` / `--dsw-alias-code-diff-deleted`，正文用 `--dsw-alias-label-primary` 等）；允许 `rgba()` 叠加在 token 上做 hover。
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
