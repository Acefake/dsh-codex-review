# 代码审查插件 · GitHub PR 数据访问方案（Recon B 结论）

> 环境：Windows 10+ · `cwd=C:\Users` · gh **2.102.0** · Node **v24.21.0** · 2026-10-24
> 验证产物：`recon/gh-probe.mjs`（只读探针）+ `recon/probe-output.json`（27 条真实 gh 命令 / 30.3 s / 274,645 bytes）
> 说明：标「实测」的数字来自本机真实命令输出；标「官方 spec」的来自 GitHub OpenAPI 描述文件（仓库 `github/rest-api-description`，文件 `descriptions/api.github.com/api.github.com.2022-11-28.yaml`，用 `gh api ... -H "Accept: application/vnd.github.raw"` 实际读取，附行号）。

---

## 0. TL;DR（给插件实现者）

1. **仓库已确认：`Acefake/yingbox`**（私有、`main` 为默认分支、TypeScript、owner 就是本机 gh 登录账号）。截图中的 PR 就是 **#129**：`feat(player): 自动检测片头片尾（音频指纹，基于 #117）`，+2117/−25、24 文件、base `feat/skip-intro`、head `feat/intro-detect`。截图里作者显示 `Acfake` 是字体渲染，API 里 `author.login = Acefake`（`author.name = "s"` 是 profile 显示名）。
2. **推荐架构：宿主侧 Node 进程内做，绝不在浏览器做。** 首选 **B = `gh auth token` 取凭据 + Node `fetch` 直连 REST/GraphQL**；`gh` CLI 子进程（A）作为**凭据来源、兜底通道和零依赖模式**。两种通道拿到的 diff 经 sha256 校验**逐字节一致**（`b480b94e…`），可随时互换。
3. **一个 PR 详情页最少 3 个请求**：① GraphQL 单请求（详情+文件列表+reviews+comments+reviewThreads+checks 一次拿全，实测 10,571 bytes / 1 请求）② REST `Accept: application/vnd.github.diff`（全文 diff，实测 75,069 chars）③ REST `/pulls/{n}/files` 拿每文件 patch（仅 AI 审查需要时）。要显示 stack/依赖关系再 **+1** 次 REST 查询（`head=owner:<baseRef>`，§3.7）。
4. **实测数据量级**：本仓库 22 个 open PR；单 PR 24–39 个文件；diff 65–122 KB（字符）；每文件 patch 合计 ~70 KB；单文件 patch 最大 **21,324 chars**（#130 的测试文件）。必须做截断预算（建议 diff 200 KB / 单 patch 30 KB / body 50 KB，见 §6）。
5. **五个必踩的坑**（均已实测复现）：`gh api --paginate` 输出是数组**拼接**不是合法 JSON；`--slurp` 不能和 `--jq` 同时用；本仓库无 CI 时 `gh pr checks` **exit=1**；私有仓库「无权限」与「不存在」都返回 **404**；`reviewDecision` 在 gh CLI 是 `""` 而 GraphQL 是 `null`。Windows 下必须用 Buffer→UTF-8，PowerShell 管道会把 LF 改成 CRLF（同一条 diff 从 75,069 变 77,536 chars）。

---

## 1. 环境与仓库确认（真实命令）

```powershell
gh --version                     # gh version 2.102.0 (2026-09-30)
gh auth status
# github.com / ✓ Logged in to github.com account Acefake (keyring)
# - Token scopes: 'gist', 'read:org', 'repo', 'workflow'
# - Git operations protocol: https
# 环境变量 GH_TOKEN / GITHUB_TOKEN 均未设置（凭据在 Windows 凭据管理器/keyring）

gh api repos/Acefake/yingbox
# 200：full_name=Acefake/yingbox  private=true  visibility=private
# default_branch=main  language=TypeScript  size=125880(KB)  pushed_at=2026-10-24T06:14:06Z
# permissions={admin,maintain,push,triage,pull 全 true}   ← 用户本人所有，读权限没问题
```

PR #129 关键信息（`gh pr view 129 --json ...` 实测）：

| 字段 | 值 |
|---|---|
| number / state / isDraft | 129 / OPEN / false |
| title | feat(player): 自动检测片头片尾（音频指纹，基于 #117） |
| author | `{login:"Acefake", name:"s", is_bot:false}` |
| additions / deletions / changedFiles | 2117 / 25 / 24 |
| baseRefName / headRefName | `feat/skip-intro` / `feat/intro-detect` |
| headRefOid / baseRefOid | `f31cec5c712d…` / `2e4024f903d8…` |
| mergeable / mergeStateStatus | MERGEABLE / CLEAN |
| body 长度 | 3,671 chars（正文明确写「stacked PR：base 为 `feat/skip-intro`」并引用 #117） |
| comments / reviews / commits | 0 / 0 / 1 |
| statusCheckRollup | `[]`（仓库没有 CI） |

> 仓库很活跃：侦察期间 open PR 从 20 → 22（#111–#132），实现时不要硬编码数量，列表每次拉取。

---

## 2. 推荐架构

### 2.1 数据流（宿主插件内）

```
渲染层（DSH Web UI）                       宿主进程（Electron main / Node ESM）
  PR 列表页  ──IPC──▶  GitHubClient.listPulls()  ──▶ GraphQL search（1 req） 或 gh pr list --json
  PR 详情页  ──IPC──▶  GitHubClient.getPull()    ──▶ GraphQL detail（1 req）
  文件/diff  ──IPC──▶  GitHubClient.getDiff()    ──▶ REST pull + Accept: application/vnd.github.diff
                       GitHubClient.getFiles()   ──▶ REST /pulls/{n}/files?per_page=100（按需分页）
  已有评论   ──IPC──▶  GitHubClient.getThreads() ──▶ GraphQL reviewThreads（详情请求里已含）
  CI 状态    ──IPC──▶  GitHubClient.getChecks()  ──▶ statusCheckRollup（详情请求里已含）
  栈信息     ──IPC──▶  GitHubClient.getStack()   ──▶ REST /pulls?head=owner:<baseRef>&state=all（1 req）

凭据：启动时 `gh auth token`（1 次，缓存于宿主内存；401 时重取一次；绝不写盘、绝不进渲染层、绝不写日志）
缓存：宿主内存 LRU + ETag/If-None-Match（304 不消耗配额，已实测）；可选磁盘缓存 plugin data 目录
```

### 2.2 A / B 两方案对比（含实测）

| 维度 | A：`gh` CLI 子进程 | B：`gh auth token` + Node `fetch` 直连 |
|---|---|---|
| 凭据 | 复用 gh 已登录态（keyring），**插件不碰 token** | 需调用一次 `gh auth token` 拿 `gho_` token 放内存（实测 len=40, prefix=`gho_`） |
| 依赖 | 用户机器必须装 gh（本机路径 `C:\Program Files\GitHub CLI\gh.exe`） | 仍需要 gh 取 token；也可支持 `GH_TOKEN`/PAT 环境变量替代 |
| 单次耗时（实测） | 每条命令 **0.7–2.2 s**（进程启动开销）；27 条命令共 30.3 s | 首次请求 0.5–1.4 s（含 DNS/TLS），同连接后续更快；文件页 519 ms |
| diff 一致性 | `gh pr diff` 75,069 chars | REST diff 75,069 chars，**sha256 相同** `b480b94e…` |
| 分页/错误处理 | `--paginate` 数组拼接、`--slurp` 与 `--jq` 互斥；错误信息在 stderr（如 exit 4 未登录） | 标准 HTTP 状态码 + `Link` 头，完全可控 |
| 缓存 | `gh api --cache 3600s` 可用（实测 902 ms → 74 ms，同输出）；粒度粗 | 自己实现 ETag/条件请求（实测 200→304，`x-ratelimit-remaining` 不变）、并发、超时、Abort |
| 数据完整性 | `gh pr view --json files` **没有 patch**；`--json reviews` **没有行内评论**，需另调 API | 直接 REST，字段全（PR 对象 48 个顶层 key） |
| 阻塞风险 | 插件里若用 `spawnSync` 会**卡住宿主事件循环**，必须用异步 `execFile`/`spawn` | 天然异步、可取消 |
| 并发/批处理 | 并发 spawn 可行但进程成本高 | 可并行、可合并（GraphQL 一次拿全） |
| 适用场景 | **兜底**：token 拿不到/失效、企业版 host、用户只装了 gh；或作为「零 token 处理」的保守模式 | **默认主通道**：高频浏览、需要缓存/并发/取消/精确错误 |

**推荐实现：`GitHubClient` 抽象 + 双 transport**
- 主：B（token + fetch），详情页 1 个 GraphQL + 1 个 REST diff；列表 1 个 GraphQL。
- 兜底：A（`gh` 异步子进程），当 token 不可用或请求 401 时整体降级；错误信息按 §4 映射。
- 判定顺序：`GH_TOKEN`/`GITHUB_TOKEN` 环境变量 → `gh auth token` → `gh` CLI 兜底；三者都没有 → 引导 `gh auth login`。

### 2.3 为什么必须在宿主侧，不能在浏览器

1. **CORS**：浏览器直连 `https://api.github.com` 时，GitHub REST/GraphQL **不返回** 允许任意站点跨域的 `Access-Control-Allow-Origin`，`fetch` 会被浏览器拦截（页面脚本拿不到响应体）；即便能拿到，也需要把用户 token 放进渲染进程。
2. **凭据安全**：`gho_` token 一旦进渲染进程，等同暴露给页面脚本/DevTools/任何被注入的前端代码；宿主进程内持有、只把**数据**通过 IPC 给 UI，才是安全边界。
3. **能力只存在于宿主**：gh CLI/Windows keyring、`child_process`、本地缓存目录、请求级超时/取消/并发控制都只有 Node 宿主侧能做。
4. **一致性**：限流、缓存、错误提示集中在一处；渲染层只渲染模型（§附录 A），不感知 GitHub 协议细节。

### 2.4 为什么还要 GraphQL（相对纯 REST 的价值）

- 详情页所需数据（详情 + 文件清单 + reviews + 会话评论 + **行内评论线程** + checks 状态）**一次请求**拿全：实测 #129 response 10,571 bytes / 7,323 chars，请求数 1。
- 列表页也一次拿全 22 条（含 `comments.totalCount` / `reviews.totalCount`）：实测 10,477 bytes / 1 请求。
- 限制：GraphQL **拿不到 diff 文本和每文件 patch**（`PullRequestChangedFile` 只有 path/additions/deletions/changeType），这两类仍走 REST；GraphQL `files(first:100)` 单页最多 100，需要 `pageInfo.endCursor` 翻页（>100 文件时）。

---

## 3. 各数据源实测（命令 / 大小 / 字段形状）

### 3.1 PR 列表

```powershell
gh pr list --repo Acefake/yingbox --state open --limit 100 \
  --json number,title,author,createdAt,updatedAt,headRefName,baseRefName,isDraft,reviewDecision,additions,deletions,changedFiles,url
```

- **实测**：22 条、JSON **9,120 chars**（中文使 UTF-8 字节更大）、1 个 GraphQL 请求（内部）、耗时 1,463 ms。
- 单条形状（真实输出，字段顺序按命令）：
```json
{ "number": 129,
  "title": "feat(player): 自动检测片头片尾（音频指纹，基于 #117）",
  "author": { "id": "MDQ6VXNlcjM0OTAzNTYy", "is_bot": false, "login": "Acefake", "name": "s" },
  "createdAt": "2026-10-24T06:05:38Z", "updatedAt": "2026-10-24T06:05:38Z",
  "headRefName": "feat/intro-detect", "baseRefName": "feat/skip-intro",
  "isDraft": false, "reviewDecision": "",
  "additions": 2117, "deletions": 25, "changedFiles": 24,
  "url": "https://github.com/Acefake/yingbox/pull/129" }
```
- 注意：
  - `reviewDecision` 无审查时是 **`""`（空串）**；GraphQL 同字段是 `null`，做归一化（§附录 A）。
  - `author.name` 是 profile 显示名（这里 `"s"`），UI 主展示建议 `login`。
  - `additions/deletions/changedFiles` 是 PR 总计，不是文件列表。
- 等价 REST（字段更全但体积爆炸）：`gh api --paginate 'repos/Acefake/yingbox/pulls?state=open&per_page=100'`；本仓库全量 131 个 PR（含 closed）实测 **2,186,139 chars**，平均 ~16.8 KB/PR。**列表页不要用**。
- 分页坑（实测）：`--paginate` 输出是「`[...][...]` 数组拼接」，不能直接 `JSON.parse`；`--slurp` 可得到真数组（同一请求 2,204,460 chars），但 **`--slurp` 不能与 `--jq/--template` 同用**（gh 报 `the --slurp option is not supported with --jq or --template`）。推荐：`--paginate --slurp` 后本地解析，或 `--paginate --jq` 逐页处理。

### 3.2 单 PR 详情 + body

```powershell
gh pr view 129 --repo Acefake/yingbox --json number,title,body,author,createdAt,updatedAt,headRefName,baseRefName,isDraft,reviewDecision,additions,deletions,changedFiles,url,state,mergeable,mergeStateStatus,files,comments,reviews,commits,labels,assignees,reviewRequests,statusCheckRollup,headRefOid,baseRefOid
```

- **实测**：**7,765 chars**、`body` 3,671 chars、1,126 ms。REST 原始 PR 对象：`gh api repos/…/pulls/129` = **21,810 bytes / 48 顶层 key**（字段最全，含 `diff_url`/`patch_url`/`mergeable_state`/`_links` 等）。
- `--json files` 的元素只有 **4 个字段、没有 patch**：`{path, additions, deletions, changeType}`；`changeType` 是 `ADDED/MODIFIED/REMOVED/RENAMED`。
- `--json comments` 是 **对话区 issue 评论**（不是行内 review 评论）；`--json reviews` 形状被裁剪为 `{id, author{login}, authorAssociation, body, submittedAt, includesCreatedEdit, reactionGroups, state, commit{oid}}`，**不含 html_url、不含行内评论**。
- `commits` 形状：`{authoredDate, authors[{email,id,login,name}], committedDate, messageBody, messageHeadline, oid}`。
- 建议：详情页主数据走 GraphQL（§3.8），`gh pr view` 作为「A 通道」的简化实现即可。

### 3.3 diff

```powershell
gh pr diff 129 --repo Acefake/yingbox --color never
# 或 REST：gh api repos/Acefake/yingbox/pulls/129 -H "Accept: application/vnd.github.diff"
```

- **实测（#129）**：75,069 chars / **86,281 bytes UTF-8** / 2,468 行 / 24 个 `diff --git` 文件头；单次返回**没有分页**；1,816 ms。
- **A/B 一致性**：REST diff 与 `gh pr diff` 的 sha256 均为 `b480b94e2071cc5aa98ace8aa28ead91e9d94d280b0fbc786b9857f3cf7ac0bd` —— 换 transport 不会改变内容。
- `Accept: application/vnd.github.patch` 得到 mbox 格式（多 `From/Subject/Date` 头、quoted-printable），实测 80,812 chars；插件用 **diff** 即可，patch 只有需要逐 commit 时才用。
- 本仓库 open PR 的 diff 实测量级（Node 直读字节，非 PowerShell）：
  | PR | 文件数 | diff chars | bytes | 行数 |
  |---|---|---|---|---|
  | #121 最大 | 39 | 118,313 | 136,055 | 3,633 |
  | #130 | 29 | 101,026 | 111,841 | 3,381 |
  | #127 | 25 | 89,071 | 97,679 | 3,051 |
  | #125 | 25 | 85,932 | 96,309 | 2,949 |
  | #132 | 31 | 78,104 | 89,719 | 2,383 |
  | #129（目标） | 24 | 75,069 | 86,281 | 2,468 |
  | #131 | 15 | 65,849 | 75,138 | 2,172 |
- 服务端限制（官方 spec `pulls/get` L60529–60537）：diff 媒体类型返回 `git-diff` 文本；spec 未给字符上限，但**超大 diff 可能超时/5xx**（commits diff 注释 L48955 写明 "Larger diffs may time out and return a 5xx status code."）。→ 客户端必须自带截断与降级（见 §6）。
- 别用 PowerShell 量大小：`Out-String` 会把 LF→CRLF，#129 从 75,069 → 77,536 chars（+2,467，正好等于行数−1），用于 hash/对比会出错。

### 3.4 文件列表 + 每文件 patch

```powershell
gh api 'repos/Acefake/yingbox/pulls/129/files?per_page=100' --paginate --slurp
```

- **实测（#129）**：24 个文件、1 页、原始 JSON **87,491 chars**、`patch` 合计 **69,929 chars**、**单文件 patch 最大 17,003 chars**（`tests/intro-detect.test.ts`）、缺失 patch 的文件 **0**。
- 元素字段（真实顺序）：`sha, filename, status, additions, deletions, changes, blob_url, raw_url, contents_url, patch`。
  - `patch` 只含 hunk（从 `@@` 开始），**不含** `diff --git`/文件头；需要整文件上下文时用 `raw_url` 或 contents API（只读）。
  - `status`: `added/removed/modified/renamed/changed/copied/unchanged`；renamed 时有 `previous_filename`（本仓库 open PR 未触发）。
  - **二进制文件没有 `patch`**（官方 spec：diff/patch 媒体类型 "Diffs with binary data will have no `patch` property"，L48956）；本仓库 open PR 扫描 0 个二进制文件（全是 `.ts/.vue/.css/.json/.md/.yaml`），实现时按缺失处理即可。
- 本仓库跨 PR 实测：扫描 #111–#130 共 20 个 open PR 的全部文件，**0 个文件缺 patch**；单文件 patch 最大 **21,324 chars**（#130 `tests/ai-subtitles.test.ts`），Top5 全是测试文件（20.4K/18.9K/17.0K/15.7K）。
- 官方分页/上限（spec `pulls/list-files` L61083–61084）：**最多 3000 个文件；默认每页 30**。`per_page` 按 GitHub 通用约定最大 100（本次用 100 实测 1 页取回 24 个文件），实现按 100/页翻，超过预算就停并标记 partial。
- 另：`gh pr diff` 与 files API 的 patch 合计（69,929）与 diff 全文（75,069）不等 —— 前者只有 hunk、后者含文件头/上下文行，AI 审查看 diff 全文或按需 patch 均可，不要混用做校验。

### 3.5 已有评论 / reviews / 行内 review 评论

```powershell
gh api 'repos/Acefake/yingbox/issues/129/comments?per_page=100'   --paginate --slurp   # 对话区评论
gh api 'repos/Acefake/yingbox/pulls/129/reviews?per_page=100'     --paginate --slurp   # review 汇总
gh api 'repos/Acefake/yingbox/pulls/129/comments?per_page=100'    --paginate --slurp   # 行内评论（含 diff_hunk）
```

- **#129 实测：三个接口都是空数组 `[]`**（这个 PR 还没人评论）。
- 仓库里有历史评论可参考形状：全仓 issue 评论共 **24 条**；本仓库 **#117** 上有一条 Codex 机器审查：
  - `reviews` 1 条（2,522 chars raw）：`state: "COMMENTED"`，`user.login: "chatgpt-codex-connector[bot]"`，`commit_id` = head sha，`submitted_at`；
    REST 原始 key：`id,node_id,user,body,state,html_url,pull_request_url,author_association,_links,is_copilot_code_review,copilot_code_review_effort,submitted_at,commit_id`。
  - 行内 `pulls/comments` 1 条（10,107 chars raw）：`path` = `src/renderer/src/features/player/skip/use-skip-segments.ts`、`line: 255`、`start_line: 252`、`side: "RIGHT"`、`body` 572 chars、**`diff_hunk` 6,715 chars**；
    原始 28 个 key：`url,pull_request_review_id,id,node_id,diff_hunk,path,commit_id,original_commit_id,user,body,created_at,updated_at,html_url,pull_request_url,_links,reactions,start_line,original_start_line,start_side,line,original_line,side,author_association,original_position,position,subject_type,is_copilot_code_review,copilot_code_review_sources`。
  - issue 评论 key：`url,html_url,issue_url,id,node_id,user,created_at,updated_at,body,author_association,reactions,performed_via_github_app,minimized`。
- **行内评论 UI 首选 GraphQL `reviewThreads`**（详情请求里一次拿全，实测 #117 响应 17,787 bytes）：
```json
{ "isResolved": false, "isOutdated": false,
  "path": "src/renderer/src/features/player/skip/use-skip-segments.ts",
  "line": 255, "startLine": 252, "diffSide": "RIGHT",
  "comments": { "totalCount": 1, "nodes": [{
    "id": "PRRC_kwDOSZK-Wc8AAAABBD0HKg", "path": "...", "line": 255,
    "body": "…", "diffHunk": "@@ -0,0 +1,260 @@ …", "author": {"login": "chatgpt-codex-connector"},
    "createdAt": "2026-10-24T05:08:30Z",
    "url": "https://github.com/Acefake/yingbox/pull/117#discussion_r4366075690" }] } }
```
  - 注意 bot 名称差异：GraphQL 里 `chatgpt-codex-connector`，REST 里 `chatgpt-codex-connector[bot]`；展示时归一化。
- 数据量警告：行内评论的 `diff_hunk` 可达数 KB，评论多时响应体积大（1 条就 10 KB）；必须截断（建议 body 4 KB / hunk 2 KB，见 §6）。

### 3.6 CI / checks

```powershell
gh pr checks 129 --repo Acefake/yingbox --json name,state,bucket,link,event,workflow
gh api repos/Acefake/yingbox/commits/<headRefOid>/check-runs
gh api repos/Acefake/yingbox/commits/<headRefOid>/status
```

- **本仓库没有 CI，实测全部为空**：
  - `gh pr checks`：**exit code 1**、stdout 空、stderr `no checks reported on the 'feat/intro-detect' branch` → 语义是「没有检查」，**不是错误**，UI 显示「无 CI」且不要弹错误。
  - REST check-runs：`{"total_count":0,"check_runs":[]}`。
  - REST combined status：`{"state":"pending","total_count":0,"statuses":[]}` → **`state:"pending"` + `total_count:0` 是「没有 status」，不能当「进行中」**。
  - GraphQL `statusCheckRollup{state}`：无 rollup 时是 **`null`**。
- 有 CI 的仓库：`gh pr checks --json` 字段为 `name,state,bucket,link,event,workflow`（bucket 用于 UI：pass/fail/pending/skipping/cancel，建议把 bucket 映射成 4 色状态）；本条形状来自命令声明，本仓库无条目可观测，接入真实 CI 仓库时再补验一次即可。
- 建议：详情页直接用 GraphQL `statusCheckRollup{state}`（0 成本，已在详情请求里）；要展示具体 check 列表再调 `gh pr checks`。

### 3.7 stack / 依赖 PR（本仓库的真实场景）

- #129 是 **stacked PR**：body 写「基于 #117（feat/skip-intro，手动标记）的后续，**stacked PR：base 为 `feat/skip-intro`**，#117 合并后再改 base 到 main」。
- 解析实测：`referencedPrs = [117]`（body 中 `#117`），`declaredBaseFromBody = "feat/skip-intro"`（正则 `base\s*(?:为|是|:)\s*`([^`]+)``）。
- 结构化确认用 1 次 REST：`gh api 'repos/Acefake/yingbox/pulls?head=Acefake%3Afeat%2Fskip-intro&state=all&per_page=100'`
  → 命中 **#117**：`state=open`、`base=main`、`merged_at=null`。由此得到链 **#117 → #129，父 PR 未合并（`allBaseMerged=false`）**。
- 通用做法：
  1. 用当前 PR 的 `baseRefName` 回查 `head=owner:baseRefName` 的 PR → 父 PR；
  2. 父 PR 的 `baseRefName` 继续回溯，直到默认分支（`main`）→ 完整栈；
  3. 父 PR 未 merge 时，UI 提示「依赖 #117 先合并」，并禁止把本 PR 的 base 当作 main 比较；
  4. body 里的 `#123` 引用只作展示线索（可能是 issue 或兄弟 PR），以 branch 回查为准。
- 注意跨仓库 fork 的 PR：`head=owner:branch` 要用 head repo 的 owner（本仓库都是本人分支，未触发）。

### 3.8 GraphQL 单请求（推荐详情页主通道）

```powershell
gh api graphql -f query='query($owner:String!,$name:String!,$number:Int!){ repository(owner:$owner,name:$name){ pullRequest(number:$number){ number title body … files(first:100){…} reviews(first:50){…} comments(first:50){…} reviewThreads(first:50){…} statusCheckRollup{state} } } }' -f owner=Acefake -f name=yingbox -F number=129
```

- **实测**：详情请求 1 次 = **10,571 bytes / 7,323 chars**，含 24 files、0 reviews、0 comments、0 threads、1 commit、rollup=null；列表 search 请求 1 次 = **10,477 bytes / 9,561 chars**，`issueCount=22`。
- 值差异（必须归一化）：`reviewDecision` 为 `null`（gh CLI 是 `""`）；`statusCheckRollup` 为 `null`；bot 登录名无 `[bot]` 后缀。
- 分页：`files(first:100)` 需要 `pageInfo{hasNextPage endCursor}` 循环；`reviews/comments/reviewThreads` 同理（建议首屏各取 50，点「查看全部」再翻）。
- 速率：GraphQL 5000 points/hr（实测独立池），单次查询约 1 point 级；比 5 个 REST 调用省。
- **GraphQL 拿不到 diff/patch** → 与 REST 组合使用（§2.1）。

---

## 4. 错误场景矩阵（全部为本机真实输出）

| 场景 | 实测命令与输出 | 插件处理 |
|---|---|---|
| 仓库不存在 | `gh api repos/Acefake/no-such-repo-…` → **exit 1**，stderr `gh: Not Found (HTTP 404)`，stdout `{"message":"Not Found","documentation_url":"https://docs.github.com/rest/repos/repos#get-a-repository","status":"404"}` | 提示「仓库不存在或无权访问」；**不要暗示它存在**（私有仓库无权限也返回 404）；提供「检查 owner/repo」与「重新登录」两个操作 |
| PR 不存在 | `gh pr view 999999 --repo …` → **exit 1**，stderr `GraphQL: Could not resolve to a PullRequest with the number of 999999. (repository.pullRequest)`，stdout 空 | 提示「PR 可能已删除或链接过期」＋刷新列表；不要重试 3 次以上 |
| token 无效/过期 | `GH_TOKEN=ghp_invalid… gh api user` → **exit 1**，stderr `gh: Bad credentials (HTTP 401)`，stdout `{"message":"Bad credentials","status":"401"}` | 重新执行一次 `gh auth token`；仍 401 → 引导 `gh auth login`；不要循环重试 |
| 未登录 | `gh auth status` → **exit 1**，stderr `You are not logged into any GitHub hosts. To log in, run: gh auth login`；`gh pr list` → **exit 4**，stderr `To get started with GitHub CLI, please run: gh auth login \| Alternatively, populate the GH_TOKEN environment variable…` | 识别 exit 4 / 文案，显示「未登录 GitHub」CTAp（运行 `gh auth login` 或配置 PAT）；清空 token 缓存 |
| 权限不足（私有库/scope 不够） | 仓库级：与「不存在」同样 **404**；scope 不足通常 403/404；本机 token scopes 实测 `repo, read:org, gist, workflow`，读私有仓库足够 | 同 404 文案；若是 scope 问题提示 `gh auth refresh -s repo` |
| 无 CI | `gh pr checks` → **exit 1**，stderr `no checks reported on the '<branch>' branch`，stdout 空 | 视作正常「无 CI」，不报错（§3.6） |
| 超大 diff | 本仓库未触发 5xx；官方 spec 注明更大 diff 可能 timeout/5xx；files 接口上限 3000 文件 | 见 §6 截断与降级：先截断；若 REST diff 5xx/超时 → 降级为 files API 的 per-file patch（再截断），UI 标注「已降级」 |
| rate limit | 本机未触发；官方行为：**403** + `X-RateLimit-Remaining: 0`、`X-RateLimit-Reset`（epoch 秒），message `API rate limit exceeded for user ID …`；次限制（secondary）也 403，可能带 `Retry-After` | 读响应头显示重置时间；指数退避（≥60 s），暂停自动刷新；切 REST/GraphQL 分池并缓存（§5） |
| gh 未安装 | `spawnSync` 报 `ENOENT`（探针里已处理：`GH_BIN` → `where.exe gh` → 安装路径 → PATH 依次找） | 提示安装 https://cli.github.com/ 或设置 `GH_BIN`/`GH_TOKEN` |
| 网络失败 | `fetch` 抛 `TypeError: fetch failed`（底层 ECONNRESET/ETIMEDOUT/ENOTFOUND） | 显示网络错误 + 重试按钮；区分「离线」与「GitHub 不可达」；请求超时建议 15–30 s |

**归一化建议**：把上述失败统一映射为 `{kind: 'not-found'|'unauthorized'|'not-logged-in'|'forbidden'|'rate-limited'|'no-checks'|'network'|'unknown', status?, message, retryAfter?, resetAt?}`，渲染层只按 kind 出 UI；原始信息（stderr 前 3 行）折叠展示，便于用户复制求助。

---

## 5. Rate limit 与缓存

**实测池子（`gh api rate_limit`）**：core **5000/h**、graphql **5000 points/h**、search **30/min**；probe 一轮 27 条命令消耗 core **18**、graphql **5**、search **2**（搜索池重置很快，正常浏览不会成为瓶颈）。

**实测缓存能力**：
- `gh api --cache 3600s repos/Acefake/yingbox/pulls/129`：第一次 **902 ms** / 18,590 chars，第二次 **74 ms** / 同内容（gh 自己落盘缓存，兜底模式可直接用）。
- 条件请求（B 通道）：首次 200 带 `ETag`，带 `If-None-Match` 重取 → **304**，`x-ratelimit-remaining` 前后都是 **4337 不变** → 304 **不消耗配额**（DOM 内存缓存可放心用）。

**缓存键与 TTL 建议**（宿主内存 LRU，key 含 repo+pr+headSha）：

| 数据 | key | TTL | 备注 |
|---|---|---|---|
| PR 列表 | repo + state + query | 30–60 s | 用户手动刷新可绕过 |
| PR 详情/GraphQL | repo#pr + headSha | 60–120 s | `updatedAt` 变化即失效 |
| diff | repo#pr + baseSha + headSha | **永久（内容不可变）** | 强缓存，审查结果可复用 |
| 文件 patch | 同上 | 永久 | 内容不可变 |
| 评论/reviews/threads | repo#pr + updatedAt | 60 s | 发评论后手动失效 |
| checks | repo#pr + headSha | 30 s | CI 在变 |
| 仓库元数据 | repo | 5–10 min | private/default_branch/permissions |

其他建议：
- **请求合并**：同一 PR 的「详情+评论+checks」用 GraphQL 一次拿全；diff 与 files 可并行（但 files 只有 AI 审查需要时才取）。
- **in-flight 去重**：同一 key 并发请求只发一次；UI 关闭面板时 `AbortController.abort()`。
- **并发上限**：宿主侧全局 2–3 个 GitHub 请求并发（gh 模式尤其要限制 spawn 数）。
- **限流退避**：403 + `X-RateLimit-Remaining: 0` → 按 `reset - now + 1s` 等待，期间读缓存不可用则显示「限流中，HH:mm 恢复」；不要用频繁重试试探。
- **搜索池单独对待**：search 30/min 只在「全仓找 PR/issue」时用；日常列表用 GraphQL/REST list 别用 search。

---

## 6. 截断与体积预算（实测依据 + 策略）

**实测依据**：本仓库 open PR diff 最大 118 KB（#121，39 文件）；文件 patch 合计 70 KB；单文件 patch 最大 21 KB；review diff_hunk 单条 6.7 KB；PR body 3.7 KB；行内评论 10 KB/条。

**建议默认预算（超出即截断并标注，绝不静默丢数据）**：

| 数据 | 预算 | 策略 |
|---|---|---|
| diff 全文 | **200,000 chars**（默认；AI 审查可配置更低如 120–150K） | 保留前 N chars + 尾部 marker `…[truncated: kept N, dropped M, total T chars (diff)]`；同时保留 `rawChars/droppedChars`；UI 标「diff 过大，仅显示前 N 字符，查看 GitHub」；更优：按文件聚合，超预算时优先保留非测试文件和 hunk 头 |
| 每文件 patch | **30,000 chars**（实测最大 21K，覆盖当前仓库） | 单文件超限截断 + `patchTruncated=true`；UI 折叠该文件并提供「在 GitHub 查看」 |
| PR body | 50,000 chars | 当前最长 3.7K，足够 |
| review/issue 评论 body | 4,000 chars | 超长截断 |
| review diff_hunk | 2,000 chars | 只用于定位上下文，够用 |
| 评论数量 | 100/页，首屏 50 | 翻页按需 |
| 文件列表 | 100/页；全局上限 3000（官方 spec） | 超过 100 时按页拉取；超出预算停止并标记 `partial=true`；超过 3000 明确提示 |
| PR 列表 | 100 条/页 | `gh pr list --limit` 或 GraphQL `first:100` + cursor |

**截断元数据必须结构化**（`originalChars/keptChars/droppedChars/truncated` 四件套，探针已按此实现）；UI 与 AI prompt 都依赖它判断「是否还有未看内容」。AI 审查时另设 prompt 预算（建议把 diff 按文件切片，单次 prompt 控制在 ~150K chars，超出走分批审查），不要直接把 200K diff 塞进一个请求。

---

## 7. Windows / 编码 / 进程注意（全部实测）

1. **gh 输出解码**：用 `spawn`/`execFile` 的 **Buffer** 输出再 `.toString('utf8')`；不要依赖 `chcp`/PowerShell 控制台代码页。实测 #129 标题 70 bytes / 36 chars、中文完整、`U+FFFD` 替换字符 0 个（probe `meta.encoding.utf8RoundTripOk=true`）。
2. **不要在 PowerShell 里量字节/算 hash**：`Out-String` 会把 native stdout 的 LF 改写成 CRLF —— 同一条 diff 在 pwsh 里 77,536 chars、Node 字节流里 75,069 chars（差值 = 行数−1）；用于 sha256 对比会假失败。Node 直读与 REST 原始响应完全一致（sha256 相同）。
3. **gh 路径**：本机是 `C:\Program Files\GitHub CLI\gh.exe`（含空格，`spawn` 用非 shell 模式传数组参数没问题）；解析顺序建议 `GH_BIN` env → `where.exe gh` → 已知路径 → `PATH`。
4. **宿主插件不要用 `spawnSync`**（探针为了简单用了它）：会阻塞 Electron main/DSH 宿主事件循环最多数秒。插件实现用异步 `execFile`/`spawn` + `maxBuffer`（建议 ≥64 MB，全量 PR 列表 2 MB+）+ 超时 + `AbortSignal`。
5. **编码输出**：写 JSON/日志统一 UTF-8；不要 `JSON.stringify` 后再 `Buffer.from(s)` 用错误编码；Windows 换行统一按 `\n` 处理（diff 解析按行）。
6. 时间：GitHub 返回 UTC ISO8601（`2026-10-24T06:05:38Z`），UI 层再转本地时区。

---

## 8. Probe 脚本与产物

**运行命令（本次真实执行，exit 0）**：

```powershell
node C:\Users\10228\dsh-codex-review\recon\gh-probe.mjs `
  --repo Acefake/yingbox --pr 129 --review-sample-pr 117 `
  --max-diff-chars 60000 --max-patch-chars 16000
```

（低预算是有意为之，为了在真实数据上演示截断：diff 75,069 → 60,000，保留 15,069 丢弃；`tests/intro-detect.test.ts` patch 17,003 → 16,000。脚本默认预算更大：diff 200,000 / patch 30,000。）

**脚本能力**（`--help` 可查）：仓库信息、open PR 列表、PR 视图、REST PR 原始体、diff、files+patch、issue comments/reviews/行内 comments、checks（含无 CI 归一化）、stack 链、GraphQL 详情/列表/已有评论样本、token 模式（不打印 token）、错误场景（404/401/未登录）、rate limit before/after/消耗。只发 GET，绝不写 GitHub。

**`probe-output.json` 索引**（274,645 bytes / 268 KiB，27 条命令，30.3 s）：

| 顶层 key | 内容 / 关键实测值 |
|---|---|
| `meta` | gh/node 版本、27 条命令日志（每条 exit/耗时/stdout 大小）、UTF-8 校验、截断说明 |
| `repo` | 5362 chars；private=true, default_branch=main, permissions 全 true |
| `openPrs` | 22 条 / 9120 chars / 字段列表 PR_LIST_FIELDS |
| `pr` | view 7765 chars、body 3671、REST 原始 21810 bytes/48 key、files 样本 |
| `diff` | 75069 chars / 86281 bytes / 2468 行 / 24 文件头 / sha256 / 截断记录 |
| `files` | 24 文件、patch 合计 69929、单文件最大 17003、缺失 0、截断清单 |
| `comments` | 目标 PR 三个空数组；`samples` 为 #117 的真实 review/行内评论/issue 评论（含 28 个 REST key） |
| `checks` | noChecks 归一化、check-runs total 0、combined state=pending+0 |
| `stack` | base #117（open/未合并）、refs [117]、inferredChain [117,129] |
| `graphql` | 详情 10571 bytes、列表 10477 bytes/22 条、#117 评论样本 17787 bytes/threads=1 |
| `tokenMode` | token len/prefix（token 已 redact）、直连 200/21810 bytes、diff sha 与 CLI 相等 |
| `errors` | 404 / PR 不存在 / 401 / 未登录 / exit 4 的真实 stderr+body |
| `rateLimit` | before/after/consumed（core 18、graphql 5、search 2） |

---

## 9. 未验证 / 风险 / 后续

- **>300 文件 / 超大 diff 的 5xx**：本仓库最大 39 文件，未触发；files API「3000 文件上限、默认 30/页」来自官方 spec（L61083–61084），未实测 3000 上限；实现时按 §6 兜底即可。
- **有 CI 的仓库**：本仓库无 CI，`gh pr checks --json` 的非空条目形状未观测（字段名来自命令声明）；接入第一个带 Actions 的 PR 时补验。
- **二进制文件 patch 缺失**：文档写明但本仓库未出现二进制变更，未实测。
- **企业版 GHES / 非 github.com**：只验证了 github.com；实现时 host 应可配置（gh 的 `--hostname`/`GH_HOST`，REST base URL）。
- **token 过期/refresh 的真实时序**：未模拟；按 §4 401 → 重取一次 → 引导重新登录处理。
- **rate limit 403 响应体**：未触发实测；按官方头 + 文案处理。
- **截图作者名**：API 为 `Acefake`，截图显示 `Acfake` 应是字体/渲染差异；不要用 body 里的昵称做身份判断。
- 本仓库是用户本人的私有仓库（admin 权限）；插件上线前建议再跑一次「非 admin 的只读账号」验证权限降级路径。

---

## 附录 A · 归一化数据模型（建议宿主侧 TypeScript）

```ts
type ISO = string;
type ReviewDecision = 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
type ChangeType = 'ADDED' | 'MODIFIED' | 'REMOVED' | 'RENAMED' | 'COPIED' | 'CHANGED' | 'UNCHANGED';
type CheckBucket = 'pass' | 'fail' | 'pending' | 'skipping' | 'cancel';

interface PrSummary {
  number: number; title: string;
  author: { login: string; name?: string | null; isBot: boolean } | null;
  createdAt: ISO; updatedAt: ISO;
  headRefName: string; baseRefName: string;
  isDraft: boolean;
  reviewDecision: ReviewDecision;          // gh CLI: "" | GraphQL: null  → 统一成 null
  additions: number; deletions: number; changedFiles: number;
  url: string;
  commentCount?: number; reviewCount?: number;   // 仅 GraphQL 列表有
}

interface PrDetail extends PrSummary {
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  body: string; bodyChars: number;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' | null;
  mergeStateStatus: string | null;
  headRefOid: string; baseRefOid: string;
  files: { path: string; additions: number; deletions: number; changeType: ChangeType }[];
  commits: { oid: string; headline: string; author: string | null; authoredDate: ISO }[];
  checks: { state: string | null /* rollup */; items: { name: string; bucket: CheckBucket; link?: string }[] };
  commentCount: number; reviewCount: number; reviewThreadCount: number;
}

interface ChangedFile {
  filename: string; status: string; additions: number; deletions: number; changes: number;
  sha: string; patch: string | null; patchChars: number; patchTruncated: boolean;
  rawUrl: string; blobUrl: string; previousFilename?: string;
}

interface ReviewThread {
  isResolved: boolean; isOutdated: boolean;
  path: string | null; line: number | null; startLine: number | null; diffSide: 'LEFT' | 'RIGHT' | null;
  comments: { id: string; body: string; diffHunk: string; author: string; createdAt: ISO; url: string }[];
}

interface StackInfo {
  baseRefName: string;
  declaredBaseFromBody: string | null;
  referencedPrs: number[];
  chain: { pr: number; ref: string; merged: boolean }[];
  allBaseMerged: boolean;
}
```

## 附录 B · 命令速查

```powershell
# 凭据（B 通道）
gh auth token                     # 输出 gho_…（len 40）；缓存于宿主内存，不落盘不打印

# 列表
gh pr list --repo O/R --state open --limit 100 --json <13 字段>            # 简单稳，A 通道
gh api graphql -f query='…search…' -F first=100                            # 一次拿全含计数，B 通道

# 详情（B 通道：1 请求）
gh api graphql -f query='…pullRequest…' -f owner=O -f name=R -F number=N

# diff / patch
gh pr diff N --repo O/R --color never                                      # 文本
gh api repos/O/R/pulls/N -H 'Accept: application/vnd.github.diff'          # 等价，可拿 headers/status
gh api repos/O/R/pulls/N -H 'Accept: application/vnd.github.patch'         # mbox（少用）

# 文件 + 每文件 patch
gh api 'repos/O/R/pulls/N/files?per_page=100' --paginate --slurp

# 评论
gh api 'repos/O/R/issues/N/comments?per_page=100' --paginate --slurp
gh api 'repos/O/R/pulls/N/reviews?per_page=100'   --paginate --slurp
gh api 'repos/O/R/pulls/N/comments?per_page=100'  --paginate --slurp

# checks
gh pr checks N --repo O/R --json name,state,bucket,link,event,workflow      # 无 CI 时 exit 1
gh api repos/O/R/commits/<sha>/check-runs
gh api repos/O/R/commits/<sha>/status

# stack
gh api 'repos/O/R/pulls?head=OWNER%3A<baseRefName>&state=all&per_page=100'

# 限流 / 缓存
gh api rate_limit
gh api --cache 3600s repos/O/R/pulls/N
```

