# dsh-codex-review GitLab 只读 provider — 设计文档

- 日期：2026-10-27
- 状态：待评审
- 目标版本：0.12.0
- 范围：只读浏览 + AI 审查（用户已确认）；不包含发布评论、回复、解决讨论、合并
- 关联文档：[2026-10-26-local-viewer-identity-design.md](./2026-10-26-local-viewer-identity-design.md)、[2026-10-24-codex-code-review-plugin-design.md](./2026-10-24-codex-code-review-plugin-design.md)
- 涉及代码：`plugin/index.js`、`plugin/lib/config.js`、`plugin/lib/gitlab.js`（新增）、`plugin/lib/errors.js`、`plugin/client.js`、`plugin/CONTRACT.md`、`plugin/test/*`

## 1. 背景

单位使用自建 GitLab：`http://gitlab.mbse.design:8090`，`D:\project` 下 8 个工作仓库（m-design 系列、jinghang 系列）都以它为 origin。当前插件（v0.10.0）的数据层是 GitHub 专用：

- API base 固定 `https://api.github.com`（`lib/github.js:33`）
- 认证走 `gh auth token`（`lib/github.js:711`）
- 列表走 `/search/issues`（`lib/github.js:964`）
- 发布/评论/合并走 GitHub 的 review、GraphQL review thread、marker 等

因此 GitLab 不是改一个配置项就能用，需要新增一条数据通道。

### 1.1 本机现状（2026-10-27 实测）

- GitLab 地址 `http://gitlab.mbse.design:8090`，解析到内网 `192.168.123.10`；无 HTTPS。
- 没有 `glab` CLI、没有 `GITLAB_TOKEN` 环境变量、没有 glab 配置；Windows 凭据管理器里有 `git:http://gitlab.mbse.design:8090` 的 git 凭据（Node 侧不可用）。
- 工作仓库本地 git 身份为 `shimengshuai <shimengshuai@mbse.com.cn>`；GitLab 用户名大概率是 `shimengshuai`，但本地无法严格证明。
- 网络可达性不稳定：曾出现 TCP 可连但 HTTP 空响应（需要内网/VPN 或 Clash 分流正确）。开发期以 fixture 单测为主，联调另做。

## 2. 目标与非目标

### 2.1 目标

- 新增 GitLab provider，实现只读浏览：MR 列表、MR 详情（正文/文件 diff/讨论/审批/pipeline）、AI 审查、PR 对话。
- GitHub 路径行为不变，默认仍为 `provider: github`。
- 账号判定沿用“本地优先”：列表用 GitLab 的 `scope=created_by_me`（服务端解析），不需要本地登录名；`viewerLogin` 仅用于展示与后续写操作。
- 写操作（发布评论、回复、解决、合并）在 GitLab 下明确禁用并给出稳定错误码。

### 2.2 非目标

- 不做 GitLab 写操作（第二期）。
- 不做 GitHub Enterprise / 多 host 的泛化；GitLab 只支持配置的单一 base URL。
- 不做 `glab` CLI 集成（本机未安装，直接用 PAT + fetch）。
- 不做自动审查（auto-review）的 GitLab 支持（其查询语法与 GitHub 不同，第二期再做）。
- 不重构现有 GitHub 客户端实现（只抽 provider 选择点与能力位）。

## 3. 方案

### 3.1 架构

在现有插件内加 provider 选择点，不复制整个插件：

```text
index.js
  ├─ config.provider === 'github' → GitHubClient（现有，保持不动）
  └─ config.provider === 'gitlab' → GitLabClient（新增 lib/gitlab.js）
```

只读阶段 `GitLabClient` 只需实现 routes 用到的读路径：

| 方法 | 用途 |
| --- | --- |
| `ghStatus()` | `/health` 的连通性/凭据状态（改名为 `providerStatus`，GitHub 侧保留别名） |
| `listPullRequests({ query, limit })` | MR 列表 |
| `getPull(repo, number)` | MR 详情 + 文件 diff + 讨论 + 审批 + pipeline |
| `getPullHead(repo, number)` | head SHA（审查缓存与状态用） |
| `getGuidelines(repo, opts)` | 仓库 `AGENTS.md` 指引（可选增强） |
| `chatContext(input)` | PR 对话上下文（复用 `lib/chat.js` 的 `buildChatContext`） |

写路径方法（`mergePull`、`createIssueComment`、`replyToReviewComment`、`resolveReviewThread`、`listPullReviews`、`listPullReviewComments`、`createPullReview`、`updatePullReview`、`getAuthenticatedUser` 的发布用途）在 GitLab provider 下不实现，由路由层用能力位拦截。

### 3.2 能力位与路由保护

`/codex-review/health` 增加：

```json
{
  "provider": "gitlab",
  "capabilities": {
    "browse": true,
    "review": true,
    "chat": true,
    "autoReview": false,
    "publish": false,
    "comment": false,
    "reply": false,
    "resolve": false,
    "merge": false
  },
  "labels": { "item": "MR", "itemFull": "Merge Request", "reviewers": "Approvals", "checks": "Pipelines" },
  "viewer": "shimengshuai",
  "version": "0.12.0"
}
```

- 所有写路由（`merge`、`review-publish`、`comment`、`reply`、`resolve`）在 `capabilities` 为 false 时直接抛 `PROVIDER_UNSUPPORTED`，不进入业务逻辑。
- 自动审查路由在 GitLab 下返回 disabled 状态，配置入口不显示。
- 客户端根据 `capabilities` 隐藏合并/发布/评论按钮，按 `labels` 替换 PR→MR、Reviewers→Approvals、Checks→Pipelines 等文案。

### 3.3 配置

在 `lib/config.js` 增加（同步 `DEFAULT_CONFIG`、`CONFIG_FIELDS`、`resolveConfig`、`buildSchemastery`、`createFallbackSchema`）：

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `provider` | `'github' \| 'gitlab'` | `'github'` | 数据通道 |
| `gitlabBaseUrl` | string | `''` | 例 `http://gitlab.mbse.design:8090`；为空时 provider=gitlab 视为未配置 |
| `gitlabToken` | string | `''` | PAT；建议从 `~/.dsh/secrets/gitlab.token` 经 `!!js` 注入，或读 `GITLAB_TOKEN` |
| `viewerLogin` | string | `''` | 当前 GitLab 用户名；只读阶段仅用于展示 |

凭据建议（照 ONES MCP 的写法，见 `~/.dsh/profiles/desktop/cordis.patch.yml:62`）：

```yaml
- id: dsh-codex-review
  config:
    provider: gitlab
    gitlabBaseUrl: http://gitlab.mbse.design:8090
    gitlabToken: !!js >-
      (() => { try { return process.getBuiltinModule("node:fs")
      .readFileSync(dshHomePath("secrets", "gitlab.token"), "utf8").trim(); }
      catch { return ""; } })()
    viewerLogin: shimengshuai
```

Token 需要 `read_api` 权限即可（只读）；不要 `api` 全权。HTTP 明文传输 token 是已知风险：仅限内网，后续确认能否上 HTTPS。

### 3.4 GitLab API 映射

`{base}/api/v4`，认证头 `PRIVATE-TOKEN: <token>`。项目标识用 URL 编码的完整路径（如 `mdesign%2Fm-design-graph`）。

| 现有数据 | GitLab 接口 | 说明 |
| --- | --- | --- |
| MR 列表 | `GET /merge_requests?scope=created_by_me&state=opened&order_by=updated_at&per_page={limit}` | `scope` 由服务端解析，等价 `author:@me`；`query` 作为 `search` 参数 |
| MR 详情 | `GET /projects/:id/merge_requests/:iid` | `description`、`diff_refs`、`detailed_merge_status`、`draft` |
| 文件 diff | `GET /projects/:id/merge_requests/:iid/diffs?per_page=100` | 分页；`diff` 字段是 unified diff 文本；旧版本（<15.7）回退 `/changes` |
| 讨论/行内评论 | `GET /projects/:id/merge_requests/:iid/discussions?per_page=100` | `notes[].position` 给 `new_path`/`new_line`/`old_line` |
| 审批 | `GET /projects/:id/merge_requests/:iid/approvals` | `approved`、`approved_by`；CE/Premium 差异要降级处理 |
| Pipeline | `GET /projects/:id/merge_requests/:iid/pipelines` | 取最近一条，jobs 可选 |
| 仓库指引 | `GET /projects/:id/repository/files/AGENTS.md/raw?ref={target_branch}` | 404 时再试 `.github/AGENTS.md`，仍无则忽略 |

归一化目标仍是 `CONTRACT.md` §1.2 的 `PrSummary` / `PrDetail`：

- `repo` = 完整项目路径（`group/sub/project`），`number` = `iid`，`url` = `web_url`。
- `state`：`opened`→`open`；`closed`/`merged`/`locked`→`closed`。
- `isDraft` = `draft === true || work_in_progress === true`。
- `reviewDecision`：`approved` → `APPROVED`，否则 `''`（GitLab 无 GitHub 的 CHANGES_REQUESTED 语义，不伪造）。
- `checks`：pipeline `success`→`success`，`failed/canceled`→`failure`，`running/pending/created`→`pending`，`skipped/manual`→`neutral`，无→`none`。
- `stack`：`chain` 为空，`baseRefName` 取 `target_branch`。
- `comments.issue`：非 system、无 position 的 notes；`comments.inline`：带 position 的 notes；`comments.reviews`：留空（GitLab 无 review 对象）。
- `reviewers`：`approved_by[].user.username`（右栏展示为 Approvals）。

### 3.5 仓库路径校验

GitLab 支持嵌套 group（本机就有 `mdesign/beijing/graphics-library-v2`，3 段）。现有 `REPO_RE`（`lib/github.js:42`）只允许 `owner/name` 两段，需要改为 provider 感知：

- GitHub：保持两段校验。
- GitLab：`^[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+){0,19}$`（最多 20 段）。

`requirePullRef`（`index.js:500`）改为调用 provider 的校验函数，避免 GitLab 项目路径被拒。

### 3.6 错误码

新增（`lib/errors.js` 的 `USER_MESSAGES`）：

- `GL_MISSING_CONFIG`：未配置 `gitlabBaseUrl` / token
- `GL_UNAUTHORIZED`：401/403，token 无效或权限不足
- `GL_NOT_FOUND`：项目/MR 不存在或无权限
- `GL_RATE_LIMIT`：限流
- `GL_TIMEOUT` / `GL_NETWORK`：超时/网络失败
- `PROVIDER_UNSUPPORTED`：当前 provider 不支持该操作

GitHub 的 `GH_*` 保持不变；客户端按错误码显示中文提示。

### 3.7 缓存与分页

沿用现有 TTL：列表 60s、详情 60s、diff 30min、pipeline 30s。分页上限：diffs 最多 30 页 × 100（与 GitHub 的 3000 文件上限对齐）；discussions 最多 10 页 × 100。`X-Next-Page` 为空即停止；`X-Total` 超限时置 `filesTruncated: true`。

### 3.8 客户端改动

- `/health` 结果驱动：provider 名称、能力位、文案标签。
- 隐藏 GitLab 下不可用的写操作按钮（合并、发布、评论、回复、解决）与自动审查入口。
- 设置页的“GitHub CLI”状态行改为 provider 感知（GitHub CLI / GitLab Token）。
- 其余布局、diff、审查卡、对话不变；`client.js` 只加分支，不重写。

### 3.9 身份判定

只读阶段不需要登录名：列表用 `scope=created_by_me`，GitLab 服务端按 token 解析。`viewerLogin` 只用于 `/health` 展示和后续写操作的 marker 信任。本地来源顺序（与 10-26 文档一致）：`viewerLogin` 配置 →（可选）`glab` 配置（本机没有）→ 空；不调用 `/user`。

## 4. 测试策略

全部 `node --test plugin/test`，不依赖真实 GitLab：

| 文件 | 覆盖 |
| --- | --- |
| 新增 `test/gitlab.test.js` | MR 列表归一化、详情（diff/讨论/审批/pipeline）、嵌套 group 路径、分页、错误码映射、缓存、超时 |
| 新增 `test/provider.test.js` | provider 选择、能力位、写路由被 `PROVIDER_UNSUPPORTED` 拦截、health 形状 |
| `test/config.test.js` | 新字段默认值、provider 枚举校验 |
| `test/routes.test.js` | GitLab 下 `/prs`、`/pr`、`/review-start`、`/chat` 正常；写路由被拒 |
| `test/client-utils.test.js` | labels/capabilities 选择逻辑（若客户端逻辑可单测） |

fixture 按 GitLab REST v4 真实响应结构手写，放 `plugin/dev/mock/gitlab-*.json`；后续可用真实响应替换。

## 5. 验收标准

1. 默认 `provider: github` 时，现有全部测试与行为不变。
2. `provider: gitlab` + 有效 token 时，列表返回当前用户创建的 open MR（`scope=created_by_me`）。
3. 打开 MR 能显示正文、逐文件 diff、讨论、审批、pipeline 状态。
4. AI 审查可运行，结果与 GitHub 路径同样展示（P0/P1/P2、文件:行、定位）。
5. 合并/发布/评论/回复/解决按钮在 GitLab 下不可见；直接调用路由返回 `PROVIDER_UNSUPPORTED`。
6. 网络/凭据失败时给出明确中文错误，不崩溃、不空白页。

## 6. 风险与未决问题

**风险**

- GitLab 版本差异：`/diffs`（15.7+）与旧 `/changes` 字段不同；审批接口在 CE/Premium 能力不同。需要按响应降级，不能假定字段存在。
- 自建 GitLab 为 HTTP，token 明文传输；建议确认内网隔离或推动 HTTPS。
- 网络可达性不稳定（本机时通时不通），联调与验收可能被阻塞；单测用 fixture 规避。
- 客户端文案/能力位改动涉及 `client.js` 多处分支，需回归现有 GitHub UI。
- 自动审查、发布、合并不在本期，用户若需要要另开一期。

**未决问题**

1. GitLab 版本是多少（决定 diff/审批接口的兼容分支）？
2. 能否提供只读 PAT（`read_api`）用于联调？放在 `~/.dsh/secrets/gitlab.token` 是否可接受？
3. 只读阶段是否需要“按指派人/全部”筛选，还是先固定 `created_by_me`？
4. 项目路径是否都用嵌套 group（决定 `repo` 校验放宽范围）？
5. 后续写操作（评论/合并）是否在下一期做？

## 7. 里程碑

1. **P0**：provider 选择点 + 能力位 + health 形状；GitHub 回归全绿。
2. **P1**：`lib/gitlab.js` 只读实现（列表/详情/diff/讨论/审批/pipeline）+ fixture 单测。
3. **P2**：客户端 labels/capabilities + 写操作隐藏；路由保护与错误码。
4. **P3**：guidelines、chat、AI 审查联调；真实 GitLab 验收（网络可用后）。
5. **P4（下一期）**：发布评论/回复/解决/合并。
