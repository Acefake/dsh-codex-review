# DSH Web GUI 客户端插件集成契约（recon-ui 侦察报告）

> 目标：把「Codex 代码审查工作台」以外部插件的形态搬进 DSH Web GUI（http://127.0.0.1:2632，profile=desktop，DSH 0.2.1-rc.3）。
> 本文所有 API 签名 / 代码片段均来自真实读取：`app.asar` 内技能模板与官方 package 产物、已安装的外部插件源码（`@linxin666/dsh-client-ui-git-graph`、`@perrylink/dsh-github`）、Web 内核 bundle、以及 asar 内嵌的 Client API 目录（`dsh-cordis-client-runner/lib/client.js`，即 `cordis_inspect` 的 Client Provider 数据源）。
> 实时 `cordis_inspect_query` 的 **Client** provider 在本会话一直超时（见 §9.1），改用其同源产物取证；**Host** inspect 正常（`Config.listConfigs` 已列出 `ui-git-graph` 条目）。

---

## 0. 结论速览（TL;DR）

1. **可以无构建步骤发布。** 但前提是：Host 半边是纯 ESM JS（`export const inject` / `export function apply`），**Client 半边不是 ES module**，必须手写成模块加载器格式：
   `window.__ModuleLoader__.load({ id: '<包名>', factory(require) { ...; return { inject, apply } } })`；
   不要 `import`/`export`、不要 JSX/TS、`require('react')` 从平台模块表取。装饰插件官方模板 `templates/decoration/client.js` 就是手写纯 JS，可直接照抄。
2. **最小构建链（仅当想写 TS/JSX 时）**：任意 bundler（git-graph 用 `tsdown`，@perrylink 用自写 `scripts/bundle-client.mjs`）产出 **CJS 闭包 + `window.__ModuleLoader__.load` 包裹**，`react` 等平台模块 external。手写纯 JS 则**一行构建都不需要**。
3. **页面入口的准确组合**：`sidebar.panellist`（list/root，注册 `{name,id,order,label}` + 图标组件，组件收到 owner props `{size, active}`）+
   `main`（keyed/root，注册 `{name, key, locale, inject}` + 页面组件，**key 必须等于 sidebar.panellist 的 id**）。
4. **宿主→客户端数据通道推荐**：Host 插件用 `ctx.webServer.register({ kind:'prefix', path:'/codex-review', handler })` 暴露同源 JSON 路由，Client 用 **文档相对路径** `fetch('codex-review/prs', …)`（**不能带前导斜杠**，页面是 `<base href="./">`）。需要推送再加一条 SSE exact 路由。这是本 profile 里真正跑起来的 `@linxin666/dsh-client-ui-git-graph` 的成熟模式，零 codegen。
   备选：会话命令通道（Host `ctx.commands.register(...)` + Client `ctx.remote.commands.execute(sessionId, line, attachments)`），适合“动作”而非大块数据；配置用 Host `Config`（schemastery，自动生成设置页）。
5. **坑（详见 §10）**：裸 `slots.register` 对未声明的 slot 会抛错，必须 `slots.inject(key, () => slots.register(...))`；`main` 是 root 作用域、没有 sessionId；页面切走会卸载；slot 组件抛错会让该 slot 条目整块消失；路由必须做 loopback/配对信任围栏 + JSON content-type 校验；客户端 bundle 每次改动要刷新页面，替换已安装包代码需重启 Host。

---

## 1. 插件形态与 manifest（准确 schema）

### 1.1 一个包 = 双面（Host + Client）
`package.json` 同时声明 `dsh.bundle.patch`（Host 行）与 `dsh.client`（浏览器 bundle），这是外部 UI 插件的标准形态（git-graph 与装饰模板一致）：

- `dsh.bundle.patch`：指向 `cordis.patch.yml`，由 Loader 把插件行插入 profile 组合。
- `dsh.client`：浏览器半边。**准确字段**（`dsh-client-modules/lib/index.js` 的 `parseDshClient`，第 64–75 行，运行时校验代码）：
  - `platform: string`（必填；只有 `'web'` 会加载）
  - `inject?: string[]`（只做**激活排序**，让被依赖的 Client 包先激活）
  - `external?: string[]`（非平台模块表的精确模块请求，需要由某个包行提供）
  - `immediately?: boolean`（启动时预取；UI 插件必须为 `true`，否则没有消费者去触发它）
- `exports` 必须含 `"./client"` 指向浏览器 bundle；缺失时抛 `client-modules: <pkg> declares dsh.client but exports no "./client" bundle`。
- Host 半边入口由 `exports["."]` 指向（`main` 字段亦可）。

### 1.2 平台模块表（`require()` 唯一可用的同步模块清单）
Web 内核 bundle `dsh-web-frontend/dist/assets/index-BXV-oxvX.js` 中 `staticModules` 的精确内容（运行时源码）：

```
react, react/jsx-runtime, react-dom, react-dom/client,
@deepseek-ai/cordis, zod, @tanstack/react-virtual,
@deepseek-ai/dsh-client-store, @deepseek-ai/dsh-client-ui-slots,
@deepseek-ai/dsh-client-ui-primitives, @deepseek-ai/dsh-client-ui-dockkit
```

超出这张表的模块必须写进 `dsh.client.external` 并由某行提供；宁可不 require。`react` / `react-dom` 无需额外声明。
（`practices.md:35` 明确不建议 `require('@deepseek-ai/dsh-client-ui-primitives')`：host 控制件会变；自写控件 + `--dsw-alias-*` token 更稳。表里另有 `zod`，但 Client 半边通常不需要。）

### 1.3 Client bundle 的加载协议（不可猜）
`dsh-client-modules/README.md`「Lazy-CJS model」：执行 bundle 只**注册工厂**，模块体副作用在 `factory(require)` 物化时才跑；`factory` 的返回值即插件导出对象（`{inject, apply}` 或函数）。同源的官方产物全部长这样（`dsh-client-ui-renderer/lib/client.js:1-5`）：

```js
window.__ModuleLoader__.load({
  id: '@deepseek-ai/dsh-client-ui-renderer',
  factory: (require) => {
    var module = { exports: {} }; var exports = module.exports;
    ...
    exports.apply = apply; exports.inject = inject;
    return module.exports;
  },
});
```

手写模板则直接 `return { inject: ['slots'], apply(ctx) {...} }`（`templates/decoration/client.js`）。两条都成立。
- `id` **必须等于包名**（服务端按 `/plugins/<package>/client.js` 提供，`<id>/client` 与裸 id 等价）。
- 手写文件里 `module`/`exports` 不需要，直接 return 插件对象即可。
- 服务端路径：Host 把每个声明了 `dsh.client` 的 Loader 行构成 boot graph，经 `/plugins/??…` combo 与 `/plugins/<id>/client.js` 提供（同 README）；客户端 Bundle 的产物必须在安装前已存在（对本地 link 安装 = 我们手写的文件）。

### 1.4 Host 半边导出形态（`host-plugin.md:57-64`）
二选一，不可混用：
- `export function apply(ctx, config) {}`（可加 `export const inject = [...]` 与 `export const Config`）；
- 或默认导出 Service class。
所有注册都用 `ctx.effect` / `ctx.on` 包起来并返回清理器。

---

## 2. Slot 系统：准确注册 API

### 2.1 服务方法（来自 `dsh-cordis-client-runner` 的 Client Service Catalog，`slots` 条目；以及 renderer 里 `SlotRegistry` 实现）

```
// 声明感知等待（推荐唯一入口）
ctx.slots.inject(key: keyof SlotMap & string, callback: () => SlotInjectionEffect): () => void
//   - slot 声明已存在 → 立即同步执行 callback；
//   - 尚未声明 → 在声明方 register() 提交后执行；声明坍塌时 dispose，回来再执行；
//   - callback 返回 1 个 disposer 或 disposer 可迭代；controller 归调用方 fiber。
ctx.slots.register(options, component): () => void
//   真实实现是 cordis Service 原型方法，必须通过 ctx.slots 调用，
//   作用域归"调用方 fiber"（renderer/lib/client.js:1813-1820；:1368-1395）。
ctx.slots.registerFactory(options, component): () => void   // 可复用 Factory，本任务不需要
```

**register options 实测字段**（`StoredEntry.options` 实测 + 各 slot `registerOptions` 目录）：

| 字段 | 适用 | 说明 |
|---|---|---|
| `name` | 必填 | slot key，如 `'main'`、`'sidebar.panellist'` |
| `id` | list/keyed 常填 | 本条目 cell key；`sidebar.panellist` 的 id 同时是 main 面板的寻址 id |
| `key` | 仅 keyed（`main`） | 面板 key，必须字符串；占用已有 key 会替换原 occupant |
| `order` | list 可选 | 升序（默认 0） |
| `label` | list 可选 | `string \| (() => string)`；thunk 每次投影重读，locale 切换无需重注册 |
| `locale` | 可选 | 声明本组件使用的 locale namespace，组件会额外收到 `t(...)` prop |
| `inject` | 可选 | `(...args) => object`，把业务函数/回调作为 props 注入组件 |
| `store` | 可选 | Store handle（数据状态），本任务不需要 |
| `select` | 仅 chain | 路由选择器（本任务不需要） |

组件收到的 props = `PropsRuntime`（owner props + key props + inject face + 作用域标准 props）+ `PropsRenderSlots`（声明了 children 时才有有效 `renderSlot`）+ `PropsStore` + locale `t` + …（`TYPE_API` 中 `ComposedProps`）。
root 作用域标准 props 实测含：`useRemoteAccess`、`useResource`、`useWorkspaces`、`usePanelInfo`、`useSessions`、`useSessionStatus`、`useSessionRetainInfo`、`useSessionAccess`、`useWorkspaceAccess`。
关键纪律（`practices.md:36` / `ui-plugin.md:11-13`）：**只用 `ctx.slots.inject(ownerKey, () => ctx.slots.register(...))` 贡献**；不要主动写 DOM、不要替换 root、不要读别的插件的 DOM/CSS。

### 2.2 目标 Slot 精确契约（逐条，来自 Client Slot Catalog）

#### `sidebar.panellist` — 全局面板图标（本工作台入口按钮）
```
kind: list; scope: root
summary: "Global panel icons. Each list id addresses the matching main panel;
          the sidebar owns the button and resolves its label from list metadata."
options: id (required string), order (optional number), label (optional string | (() => string))
ownerProps: { size: number; active: boolean }   // 图标请求的方形边长、是否被选中
declaredBy: "an entry in 'sidebar' (client-ui-sidebar)"
occupants: client-ui-plugin-manager PluginsPanelIcon, client-ui-schedule TaskManagerIcon
source: packages/client/ui-sidebar/src/client/contract/slots.ts:36
```
要点：**同一个 `id` 寻址布局 root 作用域的 `main` keyed slot**；选中一个不存在的 main 条目，`layout.selectPanel` 会抛错且保留当前选择（ui-sidebar README）。

#### `main` — 中央主面板（本工作台页面）
```
kind: keyed; scope: root
summary: "Central panel selected by sidebar entry id. The reserved `conversation`
          key hosts the Conversation; other keys receive no Session binding."
options: key (required string)
ownerProps: []                      // 无
standardProps: root 作用域标准 props（见 §2.1）+ usePanelInfo
declaredBy: "an entry in 'root' (client-ui-layout)"
occupants: client-ui-conversation ConversationPanel key 'conversation',
           client-ui-plugin-manager PluginManagerPage,
           client-ui-schedule TaskManagerPage
replaceRisk: shadows-shipped-ui
source: packages/client/ui-layout/src/client/index.ts:73
```
导航：client Service `layout.selectPanel(panelId: MainPanelId | null): void`（传 `null` 回 Conversation；未注册 key 抛错）。
**root 作用域 → 页面组件没有 `sessionId` prop**；需要当前会话信息时用 `ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd`（git-graph 的做法，`src/client/index.ts:117-118`）或 `useSessions`/`usePanelInfo`。

已装插件里的最佳范本（一模一样的两件套，`dsh-client-ui-schedule/lib/client.js`）：
```js
ctx.slots.inject('main', () => ctx.slots.register({
  name: 'main', key: PANEL_ID, locale: MANAGER_NS,
  inject: () => ({ ...detail, onNewTask: () => { ctx.uiWorkspace.startSession() } }),
}, TaskManagerPage));
ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
  name: 'sidebar.panellist', id: PANEL_ID, order: 10, locale: MANAGER_NS,
  label: () => t('panel'),
}, TaskManagerIcon));
```

#### `shell.overlay` — 帧级浮层（toast / 提示，可选）
```
kind: list; scope: root
options: id (required), order (optional), label (optional)
ownerProps: []
declaredBy: "an entry in 'root' (client-ui-layout)"
doc: 浮层本身 click-through，条目自行恢复 pointer-events；新增 id 与既有条目并存
occupants: chat.quota-notice、plugin-manager.refresh-toast、schedule.delete-toast、
           shortcuts、workspace.session-rename/archive、row-toast 等
```

#### `settings.section` — 设置页的一个整页 section（推荐给“工作台设置”）
```
kind: list; scope: root
options: id (required), order (optional), label (optional)
ownerProps: { close: () => void }   // shell 拥有设置面板开关，section 只拿到 close
declaredBy: "an entry in 'sidebar.settings' (client-ui-settings-general)"
occupants: agent-presets / account / general / models / plugins
```
section 内部排版、文案、读写路径全归注册方；注册方在 locale 变化时自行重注册新 label。

#### `settings.general.item` — General 里单行 preference（轻量开关）
```
kind: list; scope: root
options: id (required), order (optional), label（不投影：owner 不渲染 label）
ownerProps: { children?: never }  // owner props 有意为空
occupants: language / appearance / font-size / composer-enter / permission / shortcuts / ...
doc 原文：该行“不接收任何 props，文案、当前值、写路径都由你自己经 inject face 与 host.call 提供”
```
结论：**工作台设置页用 `settings.section`**；只有单行开关才用 `settings.general.item`。

其他可参考的装饰/附加座位（非本任务必需）：`conversation.input.dock`（模板默认装饰位）、`conversation.composer.dock`、`conversation.session.header.utilities`、`conversation.chat.turnTail`。

---

## 3. 最小可运行骨架（可直接粘贴）

目录（本地 `link:` 安装的包根）：

```
C:\Users\10228\dsh-codex-review\plugin\
├── package.json
├── cordis.patch.yml
├── index.js          # Host 半边：/codex-review/* JSON 路由
├── client.js         # 浏览器半边：module-loader 脚本（非 ESM）
├── icon.svg
└── locale\
    ├── en.json
    └── zh.json
```

### 3.1 `package.json`
```json
{
  "name": "@local/codex-review",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Codex code-review workbench inside the DSH Web GUI: PR list, unified diff, line comments.",
  "exports": {
    ".": "./index.js",
    "./client": "./client.js",
    "./locale/*.json": "./locale/*.json",
    "./icon": "./icon.svg"
  },
  "files": ["index.js", "client.js", "cordis.patch.yml", "locale/*.json", "icon.svg"],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "immediately": true,
      "inject": [
        "@deepseek-ai/dsh-client-ui-renderer",
        "@deepseek-ai/dsh-client-locale"
      ]
    }
  }
}
```

### 3.2 `cordis.patch.yml`
```yaml
- insert:
    - id: codex-review
      name: '@local/codex-review'
```

### 3.3 `index.js`（Host 半边：真实可运行的路由骨架）
```js
/**
 * Host half of the Codex review workbench.
 * Exposes /codex-review/* JSON routes on the shared webserver; the browser half
 * calls them over same-origin document-relative fetch.
 * @module @local/codex-review
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Owned route prefix (must be disjoint from other plugins' routes). */
const ROUTE = '/codex-review'
/** Hard dependency: the browser HTTP carrier. */
export const inject = ['webServer']

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'referrer-policy': 'no-referrer' })
  res.end(JSON.stringify(body))
}

/** Read a bounded JSON body; null for empty/invalid/oversized payloads. */
async function readJsonBody(req, maxBytes = 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) { req.destroy(); return null }
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text === '') return null
  try { const parsed = JSON.parse(text); return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : null } catch { return null }
}

/** Trust fence: loopback socket + loopback Host + same-origin, no proxy headers. */
function isLoopbackRequest(req) {
  const address = (req.socket.remoteAddress ?? '').toLowerCase()
  const isV4Loop = (value) => value.split('.').length === 4 && value.split('.')[0] === '127'
  const loop = address === '::1'
    || (address.startsWith('::ffff:') ? isV4Loop(address.slice(7)) : isV4Loop(address))
  if (!loop) return false
  if (req.headers['cf-connecting-ip'] !== undefined || req.headers['x-forwarded-for'] !== undefined) return false
  const host = req.headers.host
  if (typeof host !== 'string') return false
  let hostUrl
  try { hostUrl = new URL('http://' + host) } catch { return false }
  const hostname = hostUrl.hostname
  const hostLoop = hostname === 'localhost' || hostname === '[::1]' || isV4Loop(hostname)
  if (!hostLoop) return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try { return new URL(origin).host === hostUrl.host } catch { return false }
}

/** `owner/name` repository shape accepted from the browser. */
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
/** Run one `gh` invocation and parse JSON stdout (maxBuffer guards runaway output). */
async function ghJson(args) {
  const { stdout } = await execFileAsync('gh', args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024 })
  return JSON.parse(stdout)
}
const fail = (code, message) => ({ ok: false, error: { code, message } })

/** Open PRs of one repository, normalized for the panel. */
async function listPullRequests(payload) {
  const repo = typeof payload.repo === 'string' ? payload.repo : ''
  if (!REPO_RE.test(repo)) return fail('bad-repo', 'repo must be owner/name')
  const fields = 'number,title,author,headRefName,baseRefName,isDraft,updatedAt,additions,deletions,changedFiles'
  const items = await ghJson(['pr', 'list', '--repo', repo, '--state', 'open', '--limit', '50', '--json', fields])
  return { ok: true, value: { repo, items } }
}

/** Unified diff of one PR (large text: cap before it crosses the wire). */
async function pullRequestDiff(payload) {
  const repo = typeof payload.repo === 'string' ? payload.repo : ''
  const number = Number(payload.number)
  if (!REPO_RE.test(repo) || !Number.isInteger(number) || number <= 0) return fail('bad-request', 'repo + number required')
  const { stdout } = await execFileAsync('gh', ['pr', 'diff', String(number), '--repo', repo], { windowsHide: true, maxBuffer: 32 * 1024 * 1024 })
  const MAX = 2 * 1024 * 1024
  const truncated = stdout.length > MAX
  return { ok: true, value: { diff: truncated ? stdout.slice(0, MAX) : stdout, truncated } }
}

/** One JSON request handler for every /codex-review/* path. */
const handler = async (req, res) => {
  try {
    if (!isLoopbackRequest(req)) { json(res, 403, { error: 'forbidden: loopback-only' }); return }
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
    if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) { res.writeHead(415); res.end(); return }
    const payload = await readJsonBody(req)
    if (payload === null) { json(res, 200, fail('bad-request', 'JSON object body required')); return }
    const pathname = new URL(req.url ?? '/', 'http://x').pathname
    switch (pathname) {
      case ROUTE + '/prs': json(res, 200, await listPullRequests(payload)); return
      case ROUTE + '/diff': json(res, 200, await pullRequestDiff(payload)); return
      default: res.writeHead(404); res.end()
    }
  } catch (error) {
    const message = error && typeof error.message === 'string' ? error.message : String(error)
    try { json(res, 200, fail('gh-failed', message.slice(0, 2000))) } catch { res.destroy() }
  }
}

/** Mount the route family; disposing the plugin fiber removes it. */
export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: ROUTE, handler }), 'codex-review: host routes')
}
```
备注：
- 路由 handler 抛错时 Host 自动回 400（`dsh-host-webserver` README），但仍建议自己收敛成 `{ok:false,error}` 信封。
- 生产实现建议把 `gh` 调用换到 `ctx.subprocess`（DSH 的受管子进程/沙箱缝，`Service.listService` 可见 `subprocess.spawn(spec)`），并复用 git-graph 的 `PollGuard`/SSE 节流经验；`node:child_process` 只是让本骨架零依赖可跑。
- 写操作（发评论/提交 review）在 v1 先不做，或按 `references/user-actions.md`：操作实现为 Host service 方法，UI 走受权入口，agent 走 tool；**授予/确认权威的动作保持 user-only**。

### 3.4 `client.js`（浏览器半边：module-loader 格式，纯 JS）
```js
window.__ModuleLoader__.load({
  id: '@local/codex-review',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'codexReview'
    const PANEL_ID = 'codex-review'
    /** Document-relative route base: the page is served with <base href="./">. */
    const ROUTE = 'codex-review'

    const en = {
      panel: 'Code review',
      heading: 'Codex code review',
      repoPlaceholder: 'owner/repo',
      refresh: 'Load pull requests',
      empty: 'No open pull requests.',
      loading: 'Loading…',
      select: 'Select a pull request to inspect its diff.',
      files: 'Changed files',
    }
    const zh = {
      panel: '代码审查',
      heading: 'Codex 代码审查工作台',
      repoPlaceholder: 'owner/repo',
      refresh: '加载 Pull Request',
      empty: '没有打开的 Pull Request。',
      loading: '加载中…',
      select: '选择一个 Pull Request 查看 diff。',
      files: '改动文件',
    }

    /** POST one JSON payload and decode the {ok,value|error} envelope; never throws. */
    async function post(path, payload) {
      let response
      try {
        response = await fetch(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        })
      } catch {
        return { ok: false, error: { code: 'transport', message: 'host route unavailable' } }
      }
      try {
        const envelope = await response.json()
        if (envelope && envelope.ok === true) return { ok: true, value: envelope.value }
        return { ok: false, error: (envelope && envelope.error) || { code: 'internal', message: 'bad envelope' } }
      } catch {
        return { ok: false, error: { code: 'transport', message: 'non-JSON response' } }
      }
    }

    /** Panel icon: owner supplies size/active; color inherits the host theme. */
    function PanelIcon({ size, active }) {
      return h('svg', {
        viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': true,
        style: { display: 'block', color: active ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-secondary)' },
      }, h('path', {
        fill: 'currentColor',
        d: 'M4 4h11l5 5v11H4V4zm11 1.5V9h3.5L15 5.5zM6.5 12.5h11v1.5h-11v-1.5zm0 3h11V17h-11v-1.5z',
      }))
    }

    const styles = {
      page: { display: 'grid', gridTemplateColumns: 'minmax(260px, 340px) 1fr', height: '100%', minHeight: 0, color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-base)' },
      column: { minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', borderRight: '1px solid var(--dsw-alias-border-l2)' },
      header: { padding: '12px 14px', borderBottom: '1px solid var(--dsw-alias-border-l2)', display: 'flex', gap: 8, alignItems: 'center' },
      input: { flex: 1, minWidth: 0, height: 30, padding: '0 8px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l3)', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)' },
      button: { height: 30, padding: '0 12px', borderRadius: 6, border: 'none', cursor: 'pointer', background: 'var(--dsw-alias-button-primary-fill)', color: 'var(--dsw-alias-label-primary-foreground)' },
      list: { overflow: 'auto', minHeight: 0, flex: 1 },
      row: { display: 'block', width: '100%', textAlign: 'left', padding: '10px 14px', border: 'none', borderBottom: '1px solid var(--dsw-alias-border-l1)', background: 'transparent', color: 'inherit', cursor: 'pointer' },
      rowActive: { background: 'var(--dsw-alias-interactive-bg-active)' },
      meta: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', marginTop: 2 },
      body: { minWidth: 0, minHeight: 0, overflow: 'auto', padding: 14 },
      pre: { margin: 0, fontFamily: 'var(--dsw-font-family-mono, monospace)', fontSize: 12, lineHeight: 1.5, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' },
      muted: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 13 },
      error: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 13 },
    }

    /** The workbench page mounted in the main keyed slot. */
    function Workbench({ api, t }) {
      const [repo, setRepo] = React.useState('')
      const [state, setState] = React.useState({ loading: false, items: [], error: null })
      const [selected, setSelected] = React.useState(null)
      const [diff, setDiff] = React.useState({ loading: false, text: '', error: null })

      const load = React.useCallback(async () => {
        if (repo.trim() === '') return
        setState({ loading: true, items: [], error: null })
        const result = await api.listPullRequests(repo.trim())
        if (result.ok) setState({ loading: false, items: result.value.items || [], error: null })
        else setState({ loading: false, items: [], error: result.error })
      }, [api, repo])

      const select = React.useCallback(async (item) => {
        setSelected(item)
        setDiff({ loading: true, text: '', error: null })
        const result = await api.pullRequestDiff(repo.trim(), item.number)
        if (result.ok) setDiff({ loading: false, text: result.value.diff, error: null })
        else setDiff({ loading: false, text: '', error: result.error })
      }, [api, repo])

      return h('div', { style: styles.page },
        h('div', { style: styles.column },
          h('div', { style: styles.header },
            h('input', {
              style: styles.input, value: repo, placeholder: t('repoPlaceholder'),
              onChange: (event) => setRepo(event.target.value),
              onKeyDown: (event) => { if (event.key === 'Enter') void load() },
            }),
            h('button', { type: 'button', style: styles.button, onClick: () => void load() }, t('refresh'))),
          h('div', { style: styles.list },
            state.loading ? h('div', { style: { ...styles.muted, padding: 14 } }, t('loading'))
              : state.error !== null ? h('div', { style: { ...styles.error, padding: 14 } }, state.error.message)
                : state.items.length === 0 ? h('div', { style: { ...styles.muted, padding: 14 } }, t('empty'))
                  : state.items.map((item) => h('button', {
                    key: item.number, type: 'button',
                    style: { ...styles.row, ...(selected && selected.number === item.number ? styles.rowActive : {}) },
                    onClick: () => void select(item),
                  }, h('div', null, '#' + item.number + '  ' + item.title),
                    h('div', { style: styles.meta }, (item.author && item.author.login ? item.author.login : '?') + ' · ' + item.headRefName + ' → ' + item.baseRefName))))),
        h('div', { style: styles.body },
          h('div', { style: { fontWeight: 600, marginBottom: 10 } }, t('heading')),
          selected === null ? h('div', { style: styles.muted }, t('select'))
            : diff.loading ? h('div', { style: styles.muted }, t('loading'))
              : diff.error !== null ? h('div', { style: styles.error }, diff.error.message)
                : h('pre', { style: styles.pre }, diff.text)))
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'codex-review: dictionaries')
        const t = ctx.locale.bind(NS)

        /** Business face handed to the page through the slot inject option. */
        const api = {
          listPullRequests: (repo) => post(ROUTE + '/prs', { repo }),
          pullRequestDiff: (repo, number) => post(ROUTE + '/diff', { repo, number }),
        }

        // Declaration-aware: a bare register() throws when the slot is not declared.
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: PANEL_ID, order: 20, locale: NS,
          label: () => t('panel'),
        }, PanelIcon))

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main', key: PANEL_ID, locale: NS,
          inject: () => ({ api }),
        }, Workbench))
      },
    }
  },
})
```

### 3.5 `locale/en.json`
```json
{
  "meta": {
    "title": "Codex Code Review",
    "description": "Review GitHub pull requests and inspect unified diffs inside the DSH Web GUI."
  }
}
```
`locale/zh.json`：
```json
{
  "meta": {
    "title": "Codex 代码审查",
    "description": "在 DSH Web GUI 内查看 GitHub Pull Request 并审查统一 diff。"
  }
}
```

### 3.6 `icon.svg`（原创图形，64×64，可被 Plugin Manager 渲染）
```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect x="6" y="10" width="52" height="44" rx="8" fill="#247bbf"/>
  <path d="M18 26h14M18 36h20" stroke="#fff" stroke-width="4" stroke-linecap="round"/>
  <path d="M42 22l6 6-6 6" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
```
要求（`host-plugin.md:29-55`）：title/description 写 `locale/*.json` 的 `meta`，图标 SVG/PNG/JPEG/WebP ≤256 KiB 且留在包内；`files` 必须包含所有运行时文件；本地目录安装是 link，不按 `files` 过滤，但仍要写对。

---

## 4. 宿主 → 客户端数据通道（两种 + 推荐）

### 4.1 方式 A（推荐）：`ctx.webServer` 同源 JSON 路由 + 文档相对 fetch
本 profile 里真正跑起来的 `@linxin666/dsh-client-ui-git-graph` 就是这个模式（Host 半 `src/host/routes.ts` + Client 半 `src/client/api.ts`），零 codegen、可流式（SSE）、可做大 payload 截断。

Host 注册（`webServer` Service 的准确 API，`Service.listService` 实测）：
```
ctx.webServer.register(route: WebRoute): () => void
ctx.webServer.registerUpgrade(route: WebUpgradeRoute): () => void
ctx.webServer.registerFallback(handler): () => void
```
`WebRoute` 实测形状（git-graph 用法 + webserver README）：`{ kind: 'exact' | 'prefix', path: string, handler(req: IncomingMessage, res: ServerResponse) }`；
匹配顺序：exact 全表 → 最长 prefix → fallback；**同一张表里重复 path 直接抛错**；路由与 Host 的 `/api` 桥、插件 bundle 路由互不相交。

Client 调用（`src/client/api.ts:30-50`，注意 `path` 是 **document-relative**）：
```js
fetch('codex-review/prs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
```
> git-graph 源码注释（issue #1707）：页面以 `<base href="./">` 提供，**根绝对路径会逃出子路径部署**，永远用无前导斜杠的相对路径。

返回值信封：`{ ok: true, value } | { ok: false, error: { code, message } }`（git-graph `routes.ts:26-38`）。

安全围栏（必须抄）：请求必须过 loopback/配对信任检查（git-graph `src/host/loopback.ts` + `pair-access.ts`：socket remoteAddress 127/8 或 ::1、Host 头为 loopback、`sec-fetch-site` 非 cross-site、带 `cf-connecting-ip`/`x-forwarded-for` 一律拒绝；配对设备 cookie 是额外放行路径，但不依赖 remote-web-ui 插件）；mutation 要求 `application/json`（CSRF 加固）；body 读入必须限长。

SSE 推送（可选，git-graph `routes.ts:320-361` 完整实现）：
```js
// Host: exact 路由，不能挂在 prefix 下（最长前缀会吃掉它）
ctx.webServer.register({ kind: 'exact', path: '/codex-review/events', handler: sseHandler })
// res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' })
// res.write('retry: 2000\n\n') + 每 15s 写 ': ping\n\n'；subscriber 集合在最后一个关闭时停轮询
// Client:
const source = new EventSource('codex-review/events?repo=' + encodeURIComponent(repo))
source.addEventListener('change', () => { void refresh() })
```
git-graph 的经验值：轮询间隔 30s（Windows 冷启动一次 git.exe ≈0.7s，太短会自激成风暴）、单请求 15s deadline、`PollGuard` 保序。

### 4.2 方式 B：会话命令（Host `ctx.commands.register` + Client `ctx.remote.commands.execute`）
适合“动作”（发起一次审查、应用修复、重跑 CI），也让 agent 能用同一条命令；**不适合大块数据**，且需要 sessionId。

Host（`dsh-commands/README.md:34-44`）：
```js
export const inject = ['commands']
export function apply(ctx) {
  ctx.effect(() => ctx.commands.register({
    name: 'codex-review',
    description: 'Review one pull request',
    input: { hint: '<owner/repo#number>' },
    handler: async ({ agent, rawInput }) => ({ kind: 'success', text: 'review started: ' + rawInput.trim() }),
  }), 'codex-review: command')
}
```
Client（`dsh-client-ui-commands/lib/client.js:1416,1718` 的真实调用）：
```js
// 注入：inject: ['remote', 'remote.commands']
await ctx.remote.commands.execute(sessionId, '/codex-review owner/repo#12', [])
const listed = await ctx.remote.commands.list(sessionId)     // 发现
ctx.remote.$on('commands/change', () => { /* 刷新 */ })
```
限制：`execute` 需要 sessionId（Remote 从 session 解析 agent），而 `main` 面板是 root 作用域、没有会话绑定；在空白页启动时可能拿不到 session。故只作补充通道。

### 4.3 方式 C（配置）：Host `Config`（schemastery）
git-graph 的做法（`src/host/config.ts` 全文 44-47 行）：
```js
import z from '@deepseek-ai/schemastery'
export const Config = z.object({
  repoAllowlist: z.array(z.string()).default([]).volatile(),
})
```
- Host 用同一 schema 校验 profile patch，并**自动生成该插件行的设置页**；`volatile()` 字段写入时直接提交进运行中引用（不 remount），并触发 `loader/volatile-update` 事件，插件在其中重派生（git-graph `src/index.ts:117-122`）。
- 依赖：`@deepseek-ai/schemastery` 在 profile 的 `node_modules` 已存在（已核实 `Test-Path`），外部插件 package.json 声明 dependencies 即可。
- 客户端无法直接读 Config；工作台若要在 UI 里展示/修改设置，用 `settings.section` 页面 + 自己的 Host 路由读/写（或把 `ctx.configEditor` 留给 Host 侧）。

### 4.4 推荐
| 用途 | 通道 |
|---|---|
| PR 列表 / diff / 评论草稿等数据读写 | **A：webServer JSON 路由 + 文档相对 fetch**（需要实时再叠 SSE） |
| 用户点“发起审查 / 应用修复”且希望 agent 也能做 | **B：会话命令**（同一 operation 双调用者，见 user-actions.md） |
| 仓库白名单、token ref、开关 | **C：Host Config**（自动设置页）；工作台自己的设置页用 `settings.section` |
| 需要新增带类型 codegen 的 `ctx.remote.<ns>` | **不推荐**：需要 `@Remote` 装饰器 + typert 生成/构建链，外部零构建插件做不到；git-graph 也刻意用路由而非 Remote |

---

## 5. 主题 token 与样式

- 唯一共享样式契约是 `--dsw-alias-*` CSS 变量；`practices.md:34`：颜色/边框/背景一律用 token，字面色只用于 artwork（图标可以用固定色）。
- 从 shipped CSS（`dsh-web-frontend/dist/assets/index-BNyAYEM7.css`）实测到的 55 个 alias token，常用的：
  `--dsw-alias-bg-base`、`--dsw-alias-bg-layer-1/2/3/4`、`--dsw-alias-bg-mask-1`、
  `--dsw-alias-border-l1/l2/l3/l4`、`--dsw-alias-label-primary/secondary/tertiary/caption/dimmed/error`、
  `--dsw-alias-brand-primary`、`--dsw-alias-interactive-bg-hover/active`、
  `--dsw-alias-button-primary-fill/hover`、`--dsw-alias-button-ghost-active-fill/border`、
  `--dsw-alias-state-success/error/warn-primary`、`--dsw-alias-code-diff-added`、`--dsw-alias-code-diff-deleted`（**diff 高亮直接用这两枚**）、
  `--dsw-alias-markdown-code-block`、`--dsw-alias-tooltip-bg`、`--dsw-alias-toast-bg`、`--dsw-alias-scrollbar-bg-l2`。
- 浅色/深色：token 自动随 `theme` 切换，无需自己判断；确实要覆写时用 Client service `theme.overrideTokens(source: string, tokens: Record<string, {light, dark}>)`（`source` 用包 id；运行时校验，字符串值会抛教学错误）。
- 组件内样式可用 React 元素内联 style（如骨架）或渲染 `<style>{css}</style>` 作为组件子元素（卸载即移除，`ui-plugin.md:13`）；若注入 `<style>` 到 `document.head`，必须在 `ctx.effect` 中注册并返回移除函数。
- **不要** `require('@deepseek-ai/dsh-client-ui-primitives')` 抄组件（会随版本变）；需要按钮/菜单/Modal 时从 shipped 源码复制 markup+CSS，类名改成自己前缀，保留用户依赖的行为（Modal 焦点/Escape、`role="switch"` + `aria-checked`、Tooltip 定位）。

---

## 6. 本地化、图标、显示元数据

- **Client 运行期文案**：`ctx.effect(() => ctx.locale.register(NS, { en, zh }), label)`（git-graph `src/client/index.ts:92-98` 同款；SERVICE_API 还给出 3 参形式 `register(ns, locale, dict)`）；slot 注册带 `locale: NS`，组件即收到 `t`；list 的 `label` 用 `() => t('panel')` 以跟随语言切换。
- **插件管理页显示**：`locale/en.json`、`locale/zh.json` 的 `meta.title` / `meta.description`；`exports` 要导出 `./locale/*.json` 和 `./icon`；图标文件见 §3.6。
- 坑：`label` 是 `string | (() => string)`（`TYPE_API` `SlotLabel` 实测），传静态字符串就不会随 locale 变。

---

## 7. 安装、启用与验证

1. 把 §3 的六个文件写进 `C:\Users\10228\dsh-codex-review\plugin\`。
2. 语法检查（不安装）：`node --check plugin/index.js`、`node --check plugin/client.js`、`node -e "JSON.parse(require('fs').readFileSync('plugin/package.json','utf8'))"`。
3. 安装（二选一）：
   - 会话内：`plugin_manager action=install_bundle target=C:\Users\10228\dsh-codex-review\plugin`（工具会做包安装 + bundle 选择；看返回的 `application` / `warnings` 判断是否生效，不看日志）。
   - CLI：`dsh plugin --profile desktop add link:C:/Users/10228/dsh-codex-review/plugin`（git-graph README 的本地 link 形式；绝对路径）。
   - 本 session 文件策略是 danger-full-access，`plugin_manager` 应可执行；若被审批策略拒绝，只能由用户/Lead 处理（本侦察不改 profile）。
4. 生效：新 bundle 可通过 HMR 激活；**替换已安装包的 JS 代码需要重启 Host**；客户端代码改动后刷新页面（`dsh-client-modules` 的 release/revision 规则）。
5. 验证：
   - `cordis_inspect_query` Host `Config.listConfigs{name:'@local/codex-review'}` 应出现该行（Host inspect 在本会话可用）。
   - 页面右侧栏/Sidebar 出现图标（`size`/`active` 由 owner 传入），点击进入 main 面板；控制台无 `slot entry crashed in '<slot>'`。
   - 若 Client inspect 在本会话始终超时（见 §9.1），改用“插件管理页可见 + 页面实际渲染 + 控制台无错误”作为替代验证，并如实报告“渲染级验证受限”。

---

## 8. 本 profile 的最佳范本文件（照抄优先级）

1. `...\@deepseek-ai\dsh-agent-preset\skills\cordis-plugin-development\templates\decoration\*`（官方最小双面模板）。
2. `C:\Users\10228\.dsh\profiles\desktop\node_modules\@linxin666\dsh-client-ui-git-graph\`
   - `src/client/index.ts`（slots.inject/register、locale、inject face、session cwd 取法）
   - `src/client/api.ts`（同源相对 fetch + 信封解码 + SSE 订阅）
   - `src/host/index.ts`（apply/inject、mountOnce、Config、routes 生命周期）
   - `src/host/routes.ts`（JSON 路由 + SSE + 信任围栏 + 体积/超时）
   - `src/host/loopback.ts` / `src/host/pair-access.ts`（信任围栏原文）
   - `src/host/config.ts`（schemastery volatile Config）
3. `...\@deepseek-ai\dsh-client-ui-schedule\lib\client.js`（shipped 的 `main` + `sidebar.panellist` 完整两件套注册）。
4. `C:\Users\10228\.dsh\profiles\desktop\node_modules\@perrylink\dsh-github\lib\client.js`（另一家的 client bundle 形态 + Plugins 页卡片；Host 半 `lib/index.js` 是零外部依赖、纯 ESM 的 Host 插件样例）。

---

## 9. 证据与验证状态

### 9.1 实时 Client inspect 超时（已如实记录）
本会话对 `cordis_inspect_query` 的 Client provider 共尝试 6 次（`Slots.listSubTree` 带/不带 root、`Service.listService`、`Builtin.listBuiltins`、`Theme.listTokens`），全部 **10s 超时**：
`Client inspect query ... timed out after 10000ms. Open or reconnect the Harness page, then retry.`
Host provider 正常（`Service.listService` 返回完整 catalog；`Config.listConfigs` 返回 `ui-git-graph` 条目）。
原因定位：Client inspect 的 provider 实现在 `@deepseek-ai/dsh-cordis-client-runner` 的浏览器半边（其 `lib/client.js` 里 `clientInspectProviders`/`CLIENT_SLOT_API`），本会话页面里该 Client 插件似乎未激活，因此没有页面响应者。
**补偿**：该文件（asar 内 `dsh/node_modules/@deepseek-ai/dsh-cordis-client-runner/lib/client.js`，411 698 B）正是 inspect 返回数据的生成源，已只读提取后逐条核对（`CLIENT_SLOT_API` 在文件第 2434 行起；`SERVICE_API` 第 1125 行起；`CLIENT_BUILTIN_INSPECTION` 第 7026 行起）。本文所有 slot 契约即取自此处，未凭记忆猜测。

### 9.2 关键证据文件
| 事实 | 证据 |
|---|---|
| client.js 必须是 module-loader 脚本 | `templates/decoration/client.js:1-22`；`dsh-client-ui-renderer/lib/client.js:1-5`；`dsh-client-modules/README.md`「Lazy-CJS model」 |
| `dsh.client` 四字段 | `dsh-client-modules/lib/index.js:64-75`（`parseDshClient`） |
| 平台模块表 11 项 | `dsh-web-frontend/dist/assets/index-BXV-oxvX.js`（`staticModules` 函数，文件偏移 ≈917 844） |
| `ctx.slots.inject/register` 签名与语义 | `dsh-client-ui-renderer/lib/client.js:1362-1395`（inject JSDoc）、`:1602-1623`（_register）、`:1813-1820`（register 原型方法） |
| `main` / `sidebar.panellist` / `shell.overlay` / `settings.section` / `settings.general.item` 契约 | `dsh-cordis-client-runner/lib/client.js` 第 4372 / 5748 / 5481 / 5340 / 5014 行 |
| Client Service API（layout/locale/sessions/slots/theme/timer/uiWorkspace/workspaces） | 同文件第 1125-1689 行 |
| client `ctx.remote.commands.*` 精确调用 | `dsh-client-ui-commands/lib/client.js:1416, 1718` |
| Web 路由 API 与匹配顺序 | `dsh-host-webserver/README.md`「Registering routes」；`Service.listService` 的 `webServer` 条目 |
| 相对 fetch 与 `<base href="./">` | `@linxin666/dsh-client-ui-git-graph/src/client/api.ts:22-50` |
| 信任围栏 / CSRF / SSE | 同包 `src/host/loopback.ts:67-87`、`pair-access.ts:38-43`、`routes.ts:195-226, 320-361` |
| Config + 自动设置页 + volatile | 同包 `src/host/config.ts:42-61`、`src/index.ts:117-132` |
| 主题 token 55 枚 | `dsh-web-frontend/dist/assets/index-BNyAYEM7.css` |
| Host 插件零依赖纯 ESM 样例 | `@perrylink/dsh-github/lib/index.js:1-22` |

（提取/检索用的只读工具在 `C:\Users\10228\dsh-codex-review\recon\tools\asar.mjs`，只读 app.asar，不修改安装目录。）

---

## 10. 坑清单（按踩中概率排序）

1. **Client 半边不能写 ESM**：`import`/`export`/JSX/TS 一律不行；必须 `window.__ModuleLoader__.load({id, factory})`，`id` = 包名，`exports["./client"]` 指向该文件。写错的表现是 bundle 下载后静默不注册/插件行加载失败。
2. **裸 `register` 对未声明 slot 会抛**：必须 `ctx.slots.inject(key, () => ctx.slots.register(...))`（git-graph 注释：SDK SlotCore.register rejects undeclared slots）。root 作用域 slot 只在 layout 的 `root` 条目挂载期间存在，`inject` 会自动等待/重建。
3. **`sidebar.panellist.id` 必须等于 `main.key`**；layout 选中不存在的 key 会抛错并保持原选择。
4. **`main` 是 root 作用域**：组件没有 sessionId；切到别的面板会**卸载**页面（本地 state 丢失），需要跨切换保留的状态放 Host 或 store。需要会话信息用 `ctx.sessions.list.getSnapshot().byId[id]?.cwd`。
5. **slot 组件抛错会让该 slot 条目整块消失**（console: `slot entry crashed in '<slot>'`），且 main 面板直接空白；组件内必须容错（fetch 失败显示错误态，不要 throw）。
6. **静态读取 `<base href="./">` 部署**：fetch 路径不能带前导斜杠，否则在子路径部署下打不到 Host 路由（git-graph issue #1707 实录）。
7. **路由必须过信任围栏**：只用 `remoteAddress` 判断不够；还要 Host 头 loopback、拒绝代理头（`cf-connecting-ip`/`x-forwarded-for`）、`sec-fetch-site !== 'cross-site'`、Origin 与 Host 同源；mutation 还要 `content-type: application/json`。否则本机浏览器之外的请求（配对设备、代理）可操作仓库。
8. **`webServer.register` 重复 path 直接抛错**；且路由注册必须放 `ctx.effect` 内返回 disposer，否则插件卸载/重载后残留。
9. **SSE 必须用 `kind:'exact'`** 独立注册（前缀路由是最长前缀，会吞掉 event path）；要写 `retry:`、15s 心跳、`req.on('close')` 清理订阅者、dispose 时 abort 在途请求。
10. **大 payload 要有上限**：body 读入限长、diff/graph 截断并回 `truncated`，否则一次请求能把页面/主进程拖死。
11. **Windows 子进程成本**：冷启动 git/gh ≈0.7s；不要用短轮询（git-graph 用 30s + 15s deadline），交互刷新走用户动作。
12. **主题只用 `--dsw-alias-*`**；字面色只用于图标等 artwork。浅色/深色都要看（同一 token 两套值）。
13. **不要 `require` primitives**；`practices.md` 明确此举会随 Harness 版本坏掉，抄 markup/CSS 更稳。
14. **locale**：`label` 用 thunk 才能跟随语言；`meta.title/description` 不写会回退到包名/description，Plugin Manager 显示难看；`files`/`exports` 漏 locale、icon 会导致显示元数据缺失。
15. **安装/生效边界**：新建 bundle 可 HMR 激活；**替换已安装包的 JS 需重启 Host**；客户端改动要刷新页面。`plugin_manager` 返回 `application`/`warnings` 才算证据，日志和进程列表不算。
16. **token 不要进前端**：GitHub token 留在 Host（credentials/subprocess 环境），Client 只发 repo/PR 参数；写操作（评论、approve）必须走确认/授权动作，且 agent 不应能自行授予权威（user-actions.md）。
