# dsh-codex-review 多 provider + 账号管理 — 设计文档

- 日期：2026-10-27
- 状态：待评审（用户已选路线 A：多 provider + 账号管理）
- 目标版本：0.12.0（provider 基础）/ 0.13.0（多账号）
- 关联文档：
  - [2026-10-27-gitlab-readonly-provider-design.md](./2026-10-27-gitlab-readonly-provider-design.md)（GitLab 只读细节）
  - [2026-10-26-local-viewer-identity-design.md](./2026-10-26-local-viewer-identity-design.md)（账号判定本地化）

## 1. 背景与决策

用户单位使用自建 GitLab（`http://gitlab.mbse.design:8090`，GitLab 12.9.2），个人使用 GitHub。希望插件能“适配所有 git 账户”，在“多 provider 适配”和“做登录”之间，用户选择**路线 A：多 provider + 账号管理**。

结论：

- Git 本身只是传输协议，各托管平台 API 不同，无法做到“任意服务器零配置”。
- 可行目标是：**内置主流平台适配器 + 用户在设置里添加/切换账号（粘贴 token）**，平台后续可扩展。
- 第一版不做账号密码/OAuth 登录；token（PAT）即登录。密码不进入插件。

## 2. 已验证的现状（2026-10-27）

- GitLab `http://gitlab.mbse.design:8090` 可达；账号 `shims`（石梦帅 / shimengshuai@mbse.com.cn，id 251），版本 **12.9.2**。
- 该账号可见 10 个项目（mdesign、m-cowork 等），当前 open MR 为 0。
- GitLab 12.9 的 API 差异：用 `/merge_requests/:iid/changes`（无 `/diffs`）、`work_in_progress`（无 `draft`）、无 `detailed_merge_status`；approvals/discussions/pipelines 可用。
- GitHub 侧现有实现（`gh` CLI + API）不变。

## 3. 账号模型

### 3.1 阶段 1（0.12.0）：每个平台一个账号

- `provider: 'github' | 'gitlab'`，默认 `github`。
- GitHub：沿用 `gh auth token` / `GH_TOKEN`，无需新增字段。
- GitLab：`gitlabBaseUrl`、`gitlabToken`、`viewerLogin`（用户名，展示用）。
- 设置页提供“数据源”切换：GitHub / GitLab；选 GitLab 时填 baseUrl、token、用户名，并有“测试连接”按钮（调用 `/user` 校验）。
- Token 存 `~/.dsh/secrets/gitlab.token`，通过 `cordis.patch.yml` 的 `!!js` 注入；不写明文到配置文件。

### 3.2 阶段 2（0.13.0）：多账号列表

- 账号存 profile 状态文件 `<profile>/.codex-review/accounts.json`（不含 token，只存 id/provider/host/username）。
- Token 按账号 id 存 `~/.dsh/secrets/codex-review-<id>.token`。
- 设置页支持添加、删除、切换账号；顶部工具栏显示当前账号，可快速切换。
- 活动账号 id 存同一状态文件；路由按活动账号取对应 provider 客户端。

### 3.3 关于“按仓库自动匹配”

插件当前是全局浏览 PR/MR（GitHub search、GitLab `scope=created_by_me`），**没有本地仓库上下文**，所以不能按 `git remote` 自动切账号。第一版用全局活动账号；后续如果增加“当前仓库”视图，再按 remote 自动匹配。

## 4. Provider 接口

所有适配器实现同一组只读方法（写操作由能力位控制，阶段 1 只做只读）：

```js
listPullRequests({ query, limit })   // 列表
getPull(repo, number)                // 详情（含 files / comments / checks / approvals）
getPullHead(repo, number)            // head SHA
getGuidelines(repo, options)         // AGENTS.md（可选）
chatContext(input)                   // 对话上下文
status()                             // 健康检查：{ ok, provider, viewer, error? }
```

适配器：

| 文件 | 平台 | 说明 |
| --- | --- | --- |
| `lib/github.js` | GitHub | 现有实现，保持行为 |
| `lib/gitlab.js` | GitLab | 新增；按 12.9 兼容，`/changes` 分页 |
| 后续 | Gitee / Gitea / Bitbucket | 每个平台一个文件，实现同一接口 |

`index.js` 按活动账号创建对应客户端；路由与审查引擎不感知平台差异。

## 5. 能力位与路由保护

`/codex-review/health` 返回：

```json
{
  "provider": "gitlab",
  "viewer": "shims",
  "capabilities": { "browse": true, "review": true, "chat": true, "autoReview": false, "publish": false, "comment": false, "reply": false, "resolve": false, "merge": false },
  "labels": { "item": "MR", "itemFull": "Merge Request", "reviewers": "Approvals", "checks": "Pipelines" },
  "version": "0.12.0"
}
```

- 写路由（merge / review-publish / comment / reply / resolve）在能力位为 false 时抛 `PROVIDER_UNSUPPORTED`。
- 自动审查阶段 1 仅 GitHub；GitLab 下返回 disabled，设置入口隐藏。
- 客户端按 `capabilities` 隐藏写操作按钮，按 `labels` 替换文案。

## 6. 配置

阶段 1 新增字段（同步 `DEFAULT_CONFIG`、`CONFIG_FIELDS`、`resolveConfig`、`buildSchemastery`、`createFallbackSchema`）：

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `provider` | string（枚举） | `github` | `github` / `gitlab` |
| `gitlabBaseUrl` | string | `''` | 例 `http://gitlab.mbse.design:8090` |
| `gitlabToken` | string | `''` | PAT，建议 `read_api`（只读） |
| `viewerLogin` | string | `''` | GitLab 用户名，展示用 |

示例（`cordis.patch.yml`）：

```yaml
- id: dsh-codex-review
  config:
    provider: gitlab
    gitlabBaseUrl: http://gitlab.mbse.design:8090
    gitlabToken: !!js >-
      (() => { try { return process.getBuiltinModule("node:fs")
      .readFileSync(dshHomePath("secrets", "gitlab.token"), "utf8").trim(); }
      catch { return ""; } })()
    viewerLogin: shims
```

## 7. 设置页 UI

- “数据源”分段选择：GitHub / GitLab。
- GitLab 表单：Base URL、Token、用户名；保存后“测试连接”（`GET /api/v4/user`）。
- 状态行：当前平台、当前账号、连接状态、错误提示（token 无效 / 网络不可达）。
- 阶段 2 增加账号列表与切换。

## 8. GitLab 12.9 兼容要点

- 列表：`GET /merge_requests?scope=created_by_me&state=opened&order_by=updated_at`。
- 详情：`GET /projects/:id/merge_requests/:iid`。
- 变更：`GET /projects/:id/merge_requests/:iid/changes`（返回 `changes` 数组，可能 `overflow`，需分页/截断）。
- 讨论：`GET /projects/:id/merge_requests/:iid/discussions`。
- 审批：`GET /projects/:id/merge_requests/:iid/approvals`。
- Pipeline：`GET /projects/:id/merge_requests/:iid/pipelines`。
- 字段：`work_in_progress` → `isDraft`；`merge_status`/`has_conflicts`；`references.full`。
- 分页：`X-Next-Page`；12.9 的 header 可能不完整，需兼容 `X-Total-Pages` 缺失的情况。

## 9. 测试

- `test/config.test.js`：新字段默认值、provider 枚举。
- `test/provider.test.js`：provider 选择、能力位、写路由拦截、health 形状。
- `test/gitlab.test.js`：12.9 响应 fixture 的归一化、`/changes` 分页、错误码。
- 现有 GitHub 测试全绿；真实 GitLab 联调在 P3 做。

## 10. 里程碑

1. **P0**：config 新字段 + provider 选择点 + health 能力位；GitHub 行为不变。
2. **P1**：`lib/gitlab.js` 只读（12.9 兼容）+ fixture 单测。
3. **P2**：设置页“数据源”表单 + 测试连接；客户端能力位/文案。
4. **P3**：真实 GitLab 联调（当前网络已打通）。
5. **P4（0.13.0）**：多账号列表与切换。
6. **后续**：Gitee/Gitea/Bitbucket 适配器；OAuth 登录（可选）。

## 11. 风险与未决问题

**风险**

- GitLab 12.9.2 已 EOL，接口能力有限；建议单位评估升级。
- 自建 GitLab 为 HTTP，token 明文传输；仅限内网。
- `client.js` 是 418KB 单文件，能力位/文案改动需要回归 GitHub UI。
- 多账号阶段涉及 token 文件管理，需明确权限与清理策略。

**未决问题**

1. 阶段 1 是否只做 GitHub + GitLab，其他平台后续再加？
2. “测试连接”按钮是否必须（会发一次 `/user` 请求）？
3. 多账号（0.13.0）是否现在就要，还是先单账号切换？
4. GitLab token 用 `read_api` 还是 `api`（只读阶段建议 `read_api`）？
