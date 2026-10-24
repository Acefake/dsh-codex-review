# Codex 风格「代码审查」工作台插件 — 设计文档

- 日期：2026-10-24
- 状态：待用户确认
- 目标 profile：`desktop`（DSH 0.2.1-rc.3，Web GUI http://127.0.0.1:2632）
- 参考：用户提供的 Codex 桌面版「代码审查」窗口截图；侦察证据见 `recon/ui-integration.md`、`recon/data-access.md`、`recon/ui-spec.md`

## 1. 背景与目标

用户提供了一张 Codex 桌面版「代码审查」窗口截图：左侧是 `is:open author:@me` 的 PR 列表，中间是 PR 的 Summary / Changes 与逐文件 diff，右侧是 Changes 统计 / Stack / Comments / Reviewers / Checks，右上角有「Review with Codex」与「合并」，底部有「就此 Pull Request 提问」。

目标：以**外部双面插件**（Host ESM + 浏览器 client bundle）把同一套工作台搬进 DSH Web GUI，并用 DSH 当前模型实现「用 AI 审查」（等价于 Review with Codex 的只读版本）。

第一版范围（用户已确认）：**只读浏览 + AI 审查**。不做合并、不发评论、不 approve。

## 2. 非目标（v1 明确不做）

- 合并 PR、发布/回复/解决行内评论、approve / request changes（写操作与审批链路留待 v2）
- 「就此 PR 提问」输入框（需要把消息注入会话，v2 再用会话命令通道）
- 本地工作区未提交改动 / 分支对比的审查（v2）
- 多仓库仪表盘（v1 用 GitHub 搜索语法覆盖：默认 `is:pr is:open author:@me`，可搜任意 query）
- 设置页 UI（v1 配置写在插件 `Config`，必要时改 `cordis.patch.yml`；`settings.section` 留待 v2）

## 3. 产品形态

- 插件包名 `dsh-codex-review`，与已安装的 `@linxin666/dsh-client-ui-git-graph` 同形态：`package.json` 同时声明 `dsh.bundle.patch` 与 `dsh.client`。
- 左栏 `sidebar.panellist` 新增图标「代码审查」（id 与 `main.key` 相同：`codex-review`）；点击后中央 `main` 面板切换到工作台。
- 工作台三栏：
  - 左 288–320px：搜索框 + PR 列表（每行：标题、状态点、相对更新时间、`#编号`、draft 标记）
  - 中 flex-1：PR 头（Open 徽章、`repo#编号`、标题、作者、`head → base`、更新时间）+ 标签页 `Summary` / `Changes +adds −dels` + 内容区
  - 右 300–320px：`Changes`（文件数、+/-）→ `Stack`（依赖链）→ `Comments`（数量）→ `Reviewers` → `Checks` → **AI 审查卡**（按钮 + 进度 + 发现列表）
- 中栏顶部右侧主行动按钮「用 AI 审查」（运行中变成进度条/取消）。
- 全部颜色/边框/背景使用 `--dsw-alias-*` token，跟随浅色/深色；diff 增删用 `--dsw-alias-code-diff-added/deleted`。
- 空态/错误态/加载骨架屏齐全；组件内绝不 throw（slot 组件抛错会导致整块 UI 消失）。

## 4. 数据层（Host）

### 4.1 数据源

`gh` CLI 子进程（`C:\Program Files\GitHub CLI\gh.exe`，已登录账号 `Acefake`，scopes 含 `repo`），**token 永不出 Host、不进前端、不落日志**。工作仓库实测：`Acefake/yingbox`（private），`is:open author:@me` 命中 22 个 PR。

### 4.2 路由（同源 POST JSON）

Host 用 `ctx.webServer.register({ kind: 'prefix', path: '/codex-review', handler })` 注册，返回信封 `{ ok: true, value } | { ok: false, error: { code, message } }`；客户端用**文档相对**路径 `fetch('codex-review/prs', …)`（不可带前导斜杠）。

| 路由 | 入参 | 出参 |
|---|---|---|
| `codex-review/prs` | `{ query?, limit? }` | `{ items: PrSummary[], totalCount, query }` |
| `codex-review/pr` | `{ repo, number }` | `{ summary, body, files: FilePatch[], comments, reviews, checks, stack, review }` |
| `codex-review/review-start` | `{ repo, number }` | `{ jobId, headSha, cached }` |
| `codex-review/review-status` | `{ jobId }` | `{ state, progress, findings, overview, model, headSha, error }` |
| `codex-review/review-cancel` | `{ jobId }` | `{ cancelled }` |

`PrSummary`：`{ repo, number, title, author, authorAvatarUrl?, isDraft, state, updatedAt, createdAt, headRefName, baseRefName, reviewDecision, additions?, deletions?, changedFiles?, url }`（列表先用搜索 API 的轻量字段，打开详情时补齐增删行）。

`FilePatch`：`{ path, previousPath?, status, additions, deletions, patch, patchTruncated }`（`patch` 为 unified diff 文本，含 `@@` hunk 头）。

`stack`：`{ baseRefName, declaredBase?, basePr?, chain: [{ number, title, state }], allBaseMerged }` —— 从 PR body 的 `base: <branch>` / `#NNN` 引用 + base 分支对应 PR 推导（探针已实现同样逻辑）。

### 4.3 采集与缓存

- 列表：`gh api -X GET search/issues -f q='<query> is:pr' -f per_page=<limit>`；`repo` 从 `repository_url` 解析。
- 详情：`gh api repos/{o}/{r}/pulls/{n}`、`…/files --paginate`、`…/comments`、`…/reviews`、`gh pr checks {n} --json`。
- 缓存：列表 TTL 60s；详情 TTL 60s（按 head SHA 关联）；AI 审查结果按 `repo#number@headSha` 缓存到进程内存；`Cache-Control: no-store`。
- 截断：单文件 patch 上限 `maxPatchChars`（默认 24 000）；响应 payload 上限约 1.2 MB；超限置 `patchTruncated/truncated` 并在 UI 明示。

### 4.4 安全围栏（照抄 git-graph 生产实现）

- loopback 校验：`req.socket.remoteAddress` 属 127/8、::1；`Host` 头为 loopback；`sec-fetch-site !== 'cross-site'`；拒绝带 `cf-connecting-ip` / `x-forwarded-for`。
- POST 必须 `content-type: application/json`；body 限长（64 KiB）；每请求 15s deadline；gh 子进程 12s 超时并 kill。
- 路由注册全部包在 `ctx.effect(...)` 内并返回 disposer；`path` 不重复注册。

## 5. AI 审查引擎（Host）

- **触发**：`review-start`。同一 `repo#number@headSha` 已有结果 → 直接返回 `cached: true`；已有运行中 job → 返回该 jobId。
- **模型**：`ctx.agentDefaultModel.currentSelection()`（当前默认 provider/model，本 profile 为 `opencode-go / deepseek-v4.1-flash`）；`Config` 可覆盖 `provider/model/maxOutputTokens`。
- **调用**：`ctx.llm.stream({ provider, model, system, messages: [{ role: 'user', content: [{ type: 'text', text }] }], maxTokens, signal })`；收集 `text-delta` 的 `chunk.text`；终止 `chunk.type === 'finish'` 看 `chunk.reason.kind`（`stop` / `max-tokens` / `error` / `aborted`）。无需 import 任何 Harness 包（request-only user input 结构即可）。
- **分块**：过滤无 patch / 生成物 / lockfile / 二进制文件；按 `reviewChunkChars`（默认 18 000 字符）贪心分组，最多 `maxChunks`（默认 6）组；串行调用（避免限流）；不足部分标注 skipped。
- **Prompt**：system 固定为「资深代码审查者，只报真实缺陷（正确性、安全、数据一致性、并发、边界条件、性能回归、明显可读性陷阱），忽略纯风格/格式/命名偏好；只输出 JSON」。user 含：PR 标题与正文摘要、本组文件 patch（保留 `@@` 头）、逐字段 schema 与「line 用新文件行号」说明、空结果返回 `{"findings":[]}`。
- **输出 schema**：`{ findings: [{ severity: "P0"|"P1"|"P2", file, line, title, why, fix }] }`；解析：剥代码围栏 → 取首个平衡 `{...}` → JSON.parse；失败重试一次（消息追加「只输出 JSON」）；再失败 → job error。
- **合并**：去重（`file + line + title` 归一化）、按 P0>P1>P2、再按 file/line 排序；`overview` 由确定性统计生成（如「共 3 个问题：P0 ×1、P1 ×2」）。
- **状态机**：`queued → running(progress: {filesDone, filesTotal, phase}) → done | error | cancelled`；`review-status` 轮询（客户端 800ms，最长 10 分钟），job 内存表上限 20 条。
- **失败语义**：LLM 未配置 / 无凭据 / 限流 / 超时 / 上下文超限 → 明确 `code` + 可读 `message` + UI「重试」。

## 6. 客户端结构（单文件 `client.js`，module-loader 格式）

- `window.__ModuleLoader__.load({ id: 'dsh-codex-review', factory(require) { const React = require('react'); … return { inject: ['slots','locale','layout'?], apply(ctx){…} } } })`；不用 ESM/JSX/TS。
- 注册：`ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name, id: 'codex-review', order, locale, label: () => t('panel') }, PanelIcon))` + `ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'codex-review', locale }, CodeReviewPage))`。
- 组件拆分（每个都是纯函数组件，内部状态用 hooks）：
  `PanelIcon` / `CodeReviewPage`（编排 + 数据获取）/ `SearchBox` / `PrList` / `PrRow` / `PrHeader` / `TabBar` / `SummaryView` / `ChangesView` / `FileCard` / `DiffHunk`（逐 hunk 渲染，双行号，上下文/增/删着色）/ `RightPanel` / `StackCard` / `CommentsCard` / `ReviewersCard` / `ChecksCard` / `AiReviewCard` / `FindingItem` / `Skeleton` / `ErrorState` / `EmptyState`。
- API 封装：`post(path, body)` 相对 fetch + 15s 超时 + 信封解码 + 统一错误对象；列表搜索 300ms 防抖。
- Markdown（Summary 的 PR 正文）：自写最小渲染器（标题、段落、列表、引用、代码块、行内 code、粗体/斜体、链接），**先转义 HTML 再渲染**，不注入原始 HTML。
- 交互：选中 PR 高亮；点击右栏文件 → 滚动到对应 `FileCard`；点击 finding → 展开该文件、滚动并高亮目标行；AI 审查运行中显示进度与「取消」；失败重试；面板切走再回来重新拉取（root 面板无会话绑定，状态不跨切面保留，Host 缓存兜底）。
- i18n：`locale/en.json` + `locale/zh.json`（`meta.title/description` + 运行期文案），`label` 用 thunk。

## 7. 配置（Host `Config`，schemastery）

`defaultQuery`（默认 `is:open author:@me`）、`limit`（默认 30）、`maxPatchChars`（24000）、`reviewChunkChars`（18000）、`maxChunks`（6）、`provider?` / `model?` / `maxOutputTokens`（默认 4096）、`requestTimeoutMs`（15000）、`ghPath?`（默认 `gh`）。全部带默认值，用户可在 `cordis.patch.yml` 覆盖。

## 8. 错误处理

- 数据层：`GH_UNAVAILABLE`（gh 不存在）、`GH_NOT_AUTHENTICATED`、`GH_FORBIDDEN`（私有仓库/权限）、`GH_NOT_FOUND`、`GH_TIMEOUT`、`GH_LIMIT`（rate limit）、`BAD_REQUEST`、`INTERNAL`；每条带可读文案与恢复建议（如「运行 gh auth login」）。
- 展示层：列表错误显示错误卡 + 重试；详情错误不影响列表；AI 审查错误显示在审查卡内 + 重试；截断提示条。
- 组件级：所有 catch 收敛为数据，不 throw。

## 9. 安全

token 只在 Host 的 gh 子进程环境；前端只收发 `repo/number/query`；路由信任围栏 + JSON content-type + 限长；只读 GitHub API；Markdown 渲染 escape；日志不打印 token/header。

## 10. 测试与验收

- 纯函数单测（`node --test`，不依赖 DSH）：unified diff 解析（hunk/行号/计数）、分块器预算、LLM 输出 JSON 提取与去重、markdown escape/渲染。
- Host 集成：`recon/gh-probe.mjs` 已验证各 gh 调用与 JSON 形状；插件的 `lib/github.js` 沿用同一命令与容错。
- AI 冒烟：对 `Acefake/yingbox#129` 真实跑一次审查（24 文件 / 75k diff 字符 → 预计 4 块），校验 findings schema 与行号可落到 patch。
- 页面验收（需用户可见）：
  1. 左栏出现「代码审查」图标，点击进入工作台；
  2. 列表显示 `is:open author:@me` 的 22 个 PR，与 `gh` 输出一致；
  3. 打开 #129：标题/Open/作者/`feat/intro-detect → feat/skip-intro` 正确，Summary 渲染正文，Changes 列出 24 文件与 +/−，右侧 Stack 显示 #117；
  4. 点「用 AI 审查」：进度推进 → 发现列表（严重度/文件:行/标题/原因/建议）→ 点击定位到 diff 行；
  5. 刷新页面后插件仍在、功能可用；控制台无 `slot entry crashed`。
- 验证限制：本会话 Client `cordis_inspect` 恒超时（页面内 inspect provider 未激活），不以其为准；以真实页面渲染 + 截图 + 控制台为准，并如实报告。

## 11. 里程碑

1. **M1 Host**：package/patch/icon/locale + gh 数据层 + 路由 + 单测（可用 curl / 直接函数调用验证）。
2. **M2 Client 工作台**：入口图标 + 三栏 + 列表/详情/Summary/Changes/diff（未接 AI 审查）。
3. **M3 AI 审查**：引擎 + 审查卡 + 发现定位。
4. **M4 安装与验收**：`plugin_manager install_bundle` → 刷新页面 → 截图核对 → 报告验证状态。

## 12. 风险与对策

| 风险 | 对策 |
|---|---|
| 页面刷新后插件未出现（client bundle 未进入 boot graph） | 安装后查 `Config.listConfigs{name:'dsh-codex-review'}` 行；页面刷新；检查 bundle 路由 `/plugins/dsh-codex-review/client.js` 可访问 |
| `ctx.llm` 在本 profile 不可用或模型路由名不同 | 用 `agentDefaultModel.currentSelection()` 实测；Config 覆盖；失败降级为「仅浏览」并在卡片明示 |
| gh 私有仓库/权限、rate limit | 实测账号有 repo scope；错误码区分并给恢复建议；列表缓存 60s |
| 大 diff 拖慢渲染（75k 字符 / 24 文件） | 文件级懒渲染 + 默认折叠超长文件；patch 截断上限；虚拟滚动不做（先测量再决定） |
| slot 组件异常导致面板空白 | 顶层 ErrorBoundary（React class component）+ 全链路 catch |
| 安装需重启 Host | 新 bundle 走 HMR 激活；若必须重启，明确告知用户（会中断会话） |

## 13. 实现回填：与初版设计的差异（2026-10-24 实测后修正）

实现过程中被真实 DSH/LLM 行为推翻或补强的点，均已落到代码与 `plugin/CONTRACT.md`：

1. **LLM 调用必须过 prepared-call 缝**：直接 `ctx.llm.stream({maxTokens: 4096})` 会被 `opencode-go` 路由拒绝（缺少 `x-opencode-session`），且推理模型会把输出预算全花在隐藏 reasoning 上（finish=`max-tokens`、可见输出 0 字）。
   现行实现：`prepareCall` + `configure` 回调里按 id 优先级选模型支持的最低推理档（`low` → `high` → `max`，不依赖 `efforts[0]` 顺序）；默认不传 `maxTokens`（`maxOutputTokens: 0`），让适配器物化模型自己的输出上限；`sessionId` 用每个 review job 的合成 id。
2. **分块并发**：串行 9 块 × 约 100s 不可接受 → 有界并发（`reviewConcurrency`，默认 3），24 文件/70k patch 的 #129 从 ~15 分钟降到约 3–5 分钟。
3. **partial 语义**：单分块失败（超时/传输错误/不可解析）记 `partial + partialReasons`，不毁掉整个 job；只有全部分块硬失败才 `error`。诊断文案带 `finish.kind / 可见输出字数 / 推理字数 / usage`。
4. **调试路由** `/codex-review/llm-info`：返回当前 selection、模型可用推理档、实际选中的 effort、传输方式、provider 下模型清单，用于排障与换模型。
5. **配置默认值**（用于 `cordis.patch.yml` 覆盖）：`reviewChunkChars=9000`、`maxChunks=9`、`reviewConcurrency=3`、`maxOutputTokens=0`（适配器默认）、单次调用超时 180s。
6. **List 行的 head/base ref 为空**：`search/issues` 不返回 ref（详情接口有），客户端只在详情头显示分支，列表不依赖。

## 14. v1.1 细化回填（2026-10-24 第二轮迭代，版本 0.2.0）

用户要求「继续细化」后，在 v1 只读浏览 + AI 审查的基础上做了 6 组增强；契约见 `plugin/CONTRACT.md` §4，验收见 `verify/REPORT.md` §11（PASS）。

1. **审查选项与深度**：`review-start` 新增 `options { depth: fast|standard|deep, severityThreshold: P0|P1|P2, includeGuidelines }`，服务端 resolve 后回显 `ResolvedReviewOptions`；选项参与 job 缓存 key（同 headSha 不同设置会重跑）。
2. **文件级增量审查**：`repo#number|path|sha1(patch)` LRU≤400；只把未命中文件送模型，命中文件复用历史 findings（含「已审且干净」的空结果）；全命中时 0 次模型调用、<1s 返回。实测 deep 全命中 `reusedFiles=24/24, elapsedMs=0`。
3. **审查质量**：Finding 增加 `evidence`（支持结论的 diff 行原文）与 `confidence`；prompt 给出 P0/P1/P2 严重度定义；`deep` 深度增加一轮「证据复核」，只保留模型判定有 diff 证据的条目；`verdict` 由严重度派生（block/changes/approve）。
4. **仓库审查指引**：自动读取 `AGENTS.md` / `.github/AGENTS.md`（≤4000 字，repo 级缓存 10 分钟）注入每个分块 prompt，`includeGuidelines=false` 可关闭。
5. **diff 行内体验**：finding 行渲染 gutter 圆点，点击在行下方展开卡片（严重度/标题/why/fix/confidence/evidence/定位）；GitHub 已有行内评论按 `path+line` 渲染为只读卡片；右栏审查卡显示 verdict、计数、resolved options、复用文件数、指引状态与本地过滤 chips。
6. **交互与无障碍**：审查设置弹层（depth/阈值/指引，localStorage 持久化）、`j/k` 切 PR、`/` 聚焦搜索、`r` 审查、`Esc` 关弹层、focus-visible/aria-label、详情列 sticky、切换 tab 保留滚动位置、右栏文件点击跳转。

验收结论：真实 DSH 页面 + 真实路由 **v1.1 PASS（90/90 路由断言 + 页面 12 项 PASS + 0 console/pageerror）**；`node --test` 115/115。已知观察项（P3）：真实 open PR 数随仓库活动变化（列表断言已数据感知）、行内评论只对当前展开文件渲染、deep 复核轮的模型侧行为以单测覆盖为主。

