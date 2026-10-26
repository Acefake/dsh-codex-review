# dsh-codex-review 账号判定本地化 — 设计文档

- 日期：2026-10-26
- 状态：待评审（推荐方案 A；来源选择见 §10 未决问题）
- 目标版本：0.11.0
- 涉及代码：`plugin/lib/github.js`、`plugin/lib/config.js`、`plugin/lib/publish.js`、`plugin/lib/errors.js`、`plugin/index.js`、`plugin/test/*`
- 关联文档：[2026-10-24-codex-code-review-plugin-design.md](./2026-10-24-codex-code-review-plugin-design.md)

## 1. 背景与现状

### 1.1 诉求

把插件判定“当前账号”的方式，从“依赖 GitHub 令牌与 API”改为“直接读取本地信息”。

### 1.2 现状证据

| 用途 | 代码位置 | 是否依赖登录名 |
| --- | --- | --- |
| PR 列表默认查询 | `lib/github.js:965` 原样拼接 `is:open author:@me` | 否。`@me` 由 GitHub 服务端按 token 解析（2026-10-26 实测：直接调 API，`author:@me` 与 `author:Acefake` 的 open 均为 0、全量同为 244） |
| 发布去重：行内 marker 信任 | `lib/publish.js:641` 取 `author` → `parsePublishMarkers(comments, author)`（`lib/publish.js:181`） | 是 |
| 发布去重：滚动汇总 review 找回 | `lib/publish.js:641` 的 `author` → `findPublishedSummaryReview(reviews, author)`（`lib/publish.js:677`） | 是 |
| 健康检查 | `plugin/index.js:547` 只返回 `gh` / `llm` / `version` | 否，也不展示账号 |

登录名来源是 `GitHubClient.viewer()`（`lib/github.js:744`）：先由 `loadToken()`（`lib/github.js:711`）取 token（`GH_TOKEN` / `GITHUB_TOKEN` 优先，否则 `gh auth token`），再请求 `/user`。`getAuthenticatedUser()`（`lib/github.js:734`）是它对外的唯一出口。

### 1.3 关键结论

1. 登录名在 v0.10.0 里**只有一个消费点**：发布去重的作者信任判定。列表、diff、AI 审查、评论读取都不依赖它。
2. 因此本改造**不改变列表里显示哪些 PR**。若目标是“让列表显示另一个账号的 PR”，正确做法是换 token/账号或改 `defaultQuery`，不是改身份判定来源。
3. 插件的 PR 数据读取本身仍然必须走 token + GitHub API；“不依赖令牌”只能做到“身份判定不依赖令牌”。

## 2. 目标与非目标

### 2.1 目标

- 账号判定改为纯本地读取：不读令牌、不发网络请求。
- 发布去重信任判定在“身份未知”时**显式拒绝**，不再静默退化为“信任任意作者”。
- 判定来源可解释、可配置、可测试；浏览与 AI 审查路径不受影响。

### 2.2 非目标

- 不改 PR 列表语义（仍为 `author:@me`，由 GitHub 解析）。
- 不更换 token、不新增账号切换 UI。
- 不支持 GitHub Enterprise / 多 host（`API_BASE_URL` 仍固定 `https://api.github.com`）。
- 不做 email → GitHub 登录名的在线映射。
- 不引入新的运行时依赖（不装 YAML 库）。

## 3. 本地信息来源评估

| 来源 | 能否给出 GitHub 登录名 | 结论 |
| --- | --- | --- |
| gh 配置 `hosts.yml` | 能。本机 `C:\Users\admin\AppData\Roaming\GitHub CLI\hosts.yml` 中 `github.com.user = Acefake` | 唯一可靠的纯本地来源，且与 gh 登录态同源 |
| 插件配置 `viewerLogin` | 能。纯本地、确定 | 作为最高优先级覆盖，解决 env token / 多账号不一致 |
| git config `user.name` / `user.email` | 不能。本机为 `shimengshuai` / `shimengshuai@mbse.com.cn`，与 `Acefake` 无推导关系 | 不可作为登录名来源 |
| 仓库 remote | 不能，只给 owner/repo | 不可用 |
| 上次 `/user` 结果落盘缓存 | 能，但首次仍依赖 API | 不满足目标，仅可作为可选优化 |

### 3.1 gh `hosts.yml` 的读取细节

文件结构（gh 生成，格式稳定）：

```yaml
github.com:
    git_protocol: https
    users:
        Acefake:
    user: Acefake
```

- 配置目录优先级：`GH_CONFIG_DIR` → Windows `%APPDATA%\GitHub CLI` → `$XDG_CONFIG_HOME/gh` → `~/.config/gh`。
- host 选择：`GH_HOST`，默认 `github.com`；只取该 host 下的 `user`，不猜测多 host。
- 解析范围：只解析顶层 host 键与缩进 `user:`，跳过注释、空行；`users:` 列表不参与判定。解析失败按“未知”处理，不抛错。
- 只提取 `user` 字段，不读取、不缓存、不记录同文件中的其他字段（部分平台 gh 会把 `oauth_token` 写在同一文件里）。

### 3.2 为什么不用 `gh auth status --json hosts`

该命令虽然不访问网络，但仍要启动 gh 进程并读取凭据存储；解析 `hosts.yml` 更轻、无副作用，且不接触任何令牌。gh 版本差异导致的输出结构变化也不会影响我们。

### 3.3 为什么不用 git 提交身份

`git config user.email` 是提交署名，不等于 GitHub 账号；GitHub 通过提交邮箱把 commit 关联到账号，但本地无法在不调用 API 的前提下完成这个映射。把 `user.name` 直接当登录名会让 `author:@me` 语义错位（本机 `shimengshuai` 在 GitHub 上不存在），发布 marker 校验也会全部失配。若确实需要按提交身份判定，只能引入显式的 email → login 映射配置，本质仍是方案 A 的配置项。

## 4. 方案对比

| 方案 | 做法 | 优点 | 缺点 | 结论 |
| --- | --- | --- | --- | --- |
| **A（推荐）** | `config.viewerLogin` → gh `hosts.yml` → 未知则发布拒绝；默认不调 `/user` | 纯本地、可离线、可预测、可测试；与 gh 登录态一致 | `GH_TOKEN` 指向其他账号时需配置项纠正 | 采用 |
| B | 只读 `hosts.yml`，无配置项 | 零配置 | env token / 多账号不一致时静默判错，无法纠正 | 不采用 |
| C | 用 git 提交身份当账号 | 表面“最本地” | 登录名不可推导；需额外映射表，等价于 A 且更易错 | 不采用 |
| D | 保留 `/user`，结果持久化缓存 | 改动最小 | 首次仍依赖 API，不满足目标 | 不采用 |

## 5. 方案 A 的设计

### 5.1 账号解析顺序

1. `config.viewerLogin`（非空即采用，`source = 'config'`）。
2. gh `hosts.yml` 中目标 host 的 `user`（`source = 'gh-config'`）。
3. 都拿不到：`login = ''`，`source = ''`。

`viewerApiFallback`（默认 `false`）为 `true` 时，第 3 步之后才允许回退到现有 `/user` 调用（兼容 `GH_TOKEN` 场景的过渡开关）。

### 5.2 模块与接口

新增 `plugin/lib/viewer-identity.js`，纯函数、依赖可注入，便于单测：

```js
/**
 * 解析当前 GitHub 登录名，不读取令牌、不发起网络请求。
 * @param {{ config?: { viewerLogin?: string }, env?: Record<string, string | undefined>, platform?: string, homedir?: () => string, readFileSync?: (path: string) => string }} options
 * @returns {{ login: string, source: 'config' | 'gh-config' | '' }}
 */
export function resolveViewerLogin(options)
```

内部拆分（不导出也可以，测试通过 `resolveViewerLogin` 覆盖）：

- `ghConfigDir({ env, platform, homedir })`：返回 gh 配置目录。
- `parseHostsUser(text, host)`：从 `hosts.yml` 文本提取该 host 的 `user`，失败返回 `''`。
- 登录名统一小写归一后比较；保留原始大小写用于展示。

### 5.3 `GitHubClient` 接入

- `viewer()`（`lib/github.js:744`）：改为调用 `resolveViewerLogin`；仅当 `viewerApiFallback === true` 且本地为空时，保留原 `/user` 路径。
- `getAuthenticatedUser()`（`lib/github.js:734`）签名与返回类型不变（`Promise<string>`）。
- `invalidateToken()`（`lib/github.js:723`）同时清空 `viewerPromise`，使下次读取重新读 `hosts.yml`。
- 解析结果在进程内缓存一次；不做文件监听。切换 gh 账号需要重载插件（token 本身也已缓存，行为一致）。
- `loadToken()`、`transport()`、`requestJson()` 保持不动，数据读取路径不变。

### 5.4 配置面（`lib/config.js`）

新增两个字段，并在五处同步：`DEFAULT_CONFIG`（`:23`）、`CONFIG_FIELDS`、`resolveConfig`（`:92`）、`buildSchemastery`（`:203`）与 `createFallbackSchema`（`:118`）。

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `viewerLogin` | string | `''` | 显式指定当前 GitHub 登录名；非空时优先于本地文件 |
| `viewerApiFallback` | boolean | `false` | 本地解析失败时是否允许回退 `/user`；仅作为迁移开关 |

`CONTRACT.md` §2 配置表（约 `CONTRACT.md:155`）同步补两行。

注意：`createFallbackSchema`（`lib/config.js:118`）目前只处理 string 与 number 两类值，新增 boolean 字段需要补一个分支，否则 `viewerApiFallback` 会被静默丢弃（Schemastery 路径不受影响）。

### 5.5 发布路径的失败语义（`lib/publish.js` + `lib/errors.js`）

现状：`lib/publish.js:641` 为 `getAuthenticatedUser().catch(() => '')`，而 `parsePublishMarkers` 的 `allowedAuthor === ''` 表示“信任任意作者”（`lib/publish.js:178`）。这会把“身份不可知”退化为“谁写的 marker 都信”，与 v2.5 的安全加固方向相反。

改为：

- `author` 为空时，在**任何 GitHub 写请求之前**抛 `AppError('VIEWER_UNKNOWN')`。
- `lib/errors.js` 的 `USER_MESSAGES`（`:12`）增加文案，例如：`无法从本地确定 GitHub 账号，请在插件配置里设置 viewerLogin 后重试`。
- `parsePublishMarkers` / `findPublishedSummaryReview` 的“空作者 = 任意作者”参数语义保留（供显式调用），但发布路径不再传空值。
- 浏览、AI 审查、评论读取不受影响（它们不调用 `getAuthenticatedUser()`）。

### 5.6 `/health`（可选增强）

`plugin/index.js:547` 的返回中增加 `viewer` 与 `viewerSource`，便于 UI 显示与排障；客户端可后续再展示。默认不改变任何交互。

## 6. 安全与失败模式

| 场景 | marker / 滚动 review 信任 | 最坏后果 |
| --- | --- | --- |
| `viewerLogin` 正确 | 只信该登录名 | 正常 |
| `hosts.yml` 正确 | 只信该登录名 | 正常 |
| 本地解析失败 | 拒绝发布（`VIEWER_UNKNOWN`） | 发布不可用，但零 GitHub 写请求 |
| 配置/文件与 token 账号不一致 | 只信“配置的登录名” | 可能找不到自己的滚动 review → 重复创建汇总 review；或更新他人 review → GitHub 403；不会改写他人 review 内容 |
| 第三方伪造 marker | 作者不匹配，忽略 | 无法压制 finding |
| `hosts.yml` 格式损坏 | 按未知处理 | 发布拒绝，浏览正常 |

明确不接受的退化：`allowedAuthor = ''` 被当作通配。这是本设计要修掉的既有隐患。

## 7. 兼容性与迁移

- 默认 `viewerApiFallback = false` 是一次行为变更：`GH_TOKEN` / `GITHUB_TOKEN` 用户且本地无 gh 配置时，发布会返回 `VIEWER_UNKNOWN`。迁移方式：设置 `viewerLogin`，或临时把 `viewerApiFallback` 设为 `true`。
- 本机（gh 登录 `Acefake`，`hosts.yml` 存在）无需任何配置即可继续发布。
- 版本升 `0.11.0`；README 增加“账号来源”说明；`CONTRACT.md` §2、§7.2 补行为描述。
- 当前 desktop profile 里是复制安装（不是符号链接），生效流程：改源码 → 跑测试 → 同步到 `~/.dsh/profiles/desktop/node_modules/dsh-codex-review` → plugin_manager 先 disable 再 enable。

## 8. 测试策略

全部用 `node --test plugin/test`（仓库现有测试同款跑法）。

| 文件 | 用例 |
| --- | --- |
| 新增 `test/viewer-identity.test.js` | 配置优先；Windows/Unix 配置目录；`GH_CONFIG_DIR`、`GH_HOST`；多 host；缺 `user`；注释与引号；文件缺失；格式损坏；登录名大小写归一 |
| `test/github.test.js` | 解析 viewer 时 fake `fetch` / `execFile` 零调用；`viewerApiFallback` 开关行为；`invalidateToken()` 后重读 |
| `test/publish.test.js` | 身份未知 → 抛 `VIEWER_UNKNOWN` 且零写请求；marker 只信本人；滚动 review 找回仍成立 |
| `test/config.test.js` | 新字段默认值、类型与边界 |
| `test/routes.test.js` | `/health` 含 `viewer` / `viewerSource`（若采纳 5.6） |

手工验收：

1. 断网状态下 `POST /codex-review/health` 仍能返回 `viewer: Acefake`（不触发 `/user`）。
2. 临时把 `viewerLogin` 设为不存在的账号，发布应返回 `VIEWER_UNKNOWN`，GitHub 上无任何新 review/comment。
3. `gh auth switch` 到另一账号后重载插件，`/health` 的 viewer 随之变化。

## 9. 验收标准

- 账号判定路径不再调用 `/user`（默认配置下），单测断言零网络调用。
- 身份未知时发布在写请求前失败，返回稳定错误码 `VIEWER_UNKNOWN`。
- 列表、diff、AI 审查、评论读取行为不变，现有测试全量通过。
- `/health` 能看出插件当前认定的账号与来源（若采纳 5.6）。

## 10. 风险与未决问题

**风险**

- `hosts.yml` 与 token 账号不一致时判错：影响发布去重，不影响数据读取；通过配置项纠正并给出明确错误。
- 自写 YAML 解析只覆盖 gh 生成格式；解析失败按未知处理，不能当空作者放行。
- 企业版 / 多 host 暂不支持；`API_BASE_URL` 固定，后续需要时再按 host 拆分。
- 收益有限：省掉发布路径一次 `/user`（超时上限 10s），列表账号不变，PR 数据仍需 token + API。

**未决问题（需用户确认）**

1. 本地来源选 A（gh `hosts.yml` + `viewerLogin` 覆盖，推荐）、B（仅配置项）、C（git 身份 + 映射表）、D（换 token/query，不改判定）中的哪个？
2. 是否采纳 `/health` 返回 `viewer` 并让 UI 展示“当前账号”？
3. `viewerApiFallback` 默认关闭是否可接受（env-token 用户首次发布需配置）？
4. 是否存在 GitHub Enterprise / 多 host 需求（决定解析是否按 host 泛化）？

## 11. 里程碑（粗）

1. 新增 `lib/viewer-identity.js` 与单测。
2. `lib/config.js` 增加配置字段，`lib/github.js` 接入本地解析与缓存失效。
3. `lib/publish.js` 加 `VIEWER_UNKNOWN` 防护，`lib/errors.js` 加文案与测试。
4. `/health`、README、CONTRACT、版本号。
5. 同步安装目录，插件重载，手工验收。
