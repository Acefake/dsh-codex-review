# dsh-codex-review — DSH Web GUI 里的「代码审查」工作台

把 Codex 桌面版「代码审查」窗口的核心体验搬进 DeepSeek Harness Web GUI：左栏 PR 列表、中间 Summary / Changes 与逐文件 unified diff、右栏 Changes / Stack / 评论 / Reviewers / Checks、以及用当前 DSH 模型跑的 **AI 审查**（P0/P1/P2 + 文件:行 + 原因 + 修复建议，可点击定位到 diff）。

- **入口**：安装后左栏出现「代码审查」；点开即进入工作台（`main` 面板 key = `codex-review`）。
- **数据**：Host 侧经 `gh` CLI 凭据读取 GitHub（只读），默认搜索 `is:open author:@me`，搜索框支持 GitHub 搜索语法。
- **AI 审查**：Host 侧走 DSH `ctx.llm`，使用当前默认模型（`agentDefaultModel`），失败/未配置时浏览功能不受影响。
- **范围**：v1 只读 + AI 审查；合并、发评论、向 PR 提问、指派 reviewer 为禁用只读态（v2 计划）。

> 本目录同时是 npm 包目录（`package.json` 双面声明：`dsh.bundle.patch` + `dsh.client`），可直接 `plugin_manager install_bundle` 安装。

## 已安装状态

已安装进 `desktop` profile（`plugin_manager` 返回 `application: applied`），Host 代码已生效；**新打开的 Web 页面**会加载其 client bundle。安装形态是符号链接：`~/.dsh/profiles/desktop/node_modules/dsh-codex-review → 本目录`。

修改 Host 代码后需要让插件重新加载（`plugin_manager set_plugin` 先 disable 再 enable 即可，无需重启宿主）；只改 `client.js` 刷新页面即可。

## 使用

1. 刷新 `http://127.0.0.1:2632` 页面，左栏「自动化任务」下方出现「代码审查」。
2. 点开 → 默认列出 `is:open author:@me` 的 PR（搜索框可改，如 `repo:Acefake/yingbox is:open`）。
3. 点 PR → 中间显示 Summary（PR 正文 markdown）/ Changes（逐文件 diff，可折叠、行号、+/- 着色）；右栏显示 Changes 统计、Stack（base 分支链）、评论、Reviewers、Checks。
4. 点右上「用 AI 审查」：
   - 进度：阶段 + `filesDone/filesTotal` + 计时，可取消；
   - 完成：审查卡显示 verdict（阻塞 / 需要修改 / 建议合并）+ P0/P1/P2 计数 + 发现列表；点「定位到 diff」跳到对应文件与行并高亮；
   - **diff 行内**：命中发现的行有 gutter 圆点，点击在行下方展开卡片（严重度、标题、为什么、怎么改、confidence、evidence）；
   - 结果按 `repo#PR@headSha + 审查选项` 缓存，同一提交同设置再次打开秒回；同 PR 新提交只重审变化的文件（文件级增量缓存）。
5. **齿轮「审查设置」**（v1.1）：审查深度（快 / 标准 / 深）、严重度阈值（P0 / P1 / P2+）、是否叠加仓库 `AGENTS.md` 审查指引；设置存浏览器 `localStorage['codex-review:settings']`，随 `review-start` 的 `options` 发给 Host。
6. **键盘**：`j`/`k` 上下切 PR，`/` 聚焦搜索，`r` 用当前设置审查，`Esc` 关闭弹层；所有交互元素有 aria-label 与 focus-visible。
7. 刷新/切面板不丢数据（Host 缓存），审查结果按 head SHA 失效。

## v1.1 新增（0.2.0）

- **审查选项**：`depth = fast | standard | deep`（deep 在单遍审查后加一轮「证据复核」，只保留模型判定有 diff 证据的发现）、`severityThreshold`、`includeGuidelines`；选项参与缓存 key。
- **增量审查**：文件级结果缓存（`repo#PR|path|sha1(patch)`，LRU 400），新提交只审变化文件；全命中时 <1s 返回并回填 `reusedFiles`。
- **仓库审查指引**：自动读取仓库 `AGENTS.md` / `.github/AGENTS.md`（各 ≤4000 字，repo 级缓存 10 分钟），注入每个分块 prompt；不存在时正常审查。
- **发现更可核验**：新增 `evidence`（支持结论的 diff 行原文，≤200 字）与 `confidence`（high/medium/low）；`verdict` 由严重度派生（P0→阻塞、P1→需要修改、否则建议合并）。
- **diff 行内卡片 + 已有评论**：GitHub 行内评论按 `path+line` 渲染为只读卡片，与 AI 发现视觉区分。
- 版本 0.2.0；测试 115 例。


## 配置（可选，写进 profile 的 `cordis.patch.yml`）

```yaml
- id: dsh-codex-review
  name: dsh-codex-review
  config:
    defaultQuery: 'is:open author:@me'   # 列表默认搜索（GitHub 搜索语法）
    limit: 30                            # 列表条数上限
    reviewChunkChars: 9000               # 单次模型调用的 diff 字符预算（standard 深度）
    maxChunks: 9                         # 最多分块数（standard 深度）
    reviewConcurrency: 3                 # 分块并发（1–6；standard 深度）
    maxOutputTokens: 0                   # 0 = 用适配器物化的模型默认输出上限
    provider: ''                         # 留空 = 当前默认模型；可覆盖
    model: ''
    maxPatchChars: 24000                 # 单文件 patch 展示上限
    maxBodyChars: 50000
```

> v1.1 的 `depth` / `severityThreshold` / `includeGuidelines` 由页面里的「审查设置」弹层控制（存浏览器 localStorage），无需改配置；Host 侧 `Config` 只决定 standard 深度的预算与模型路由。

## Host HTTP 路由（同源 POST JSON，`{ok,value}|{ok:false,error}` 信封）

`/codex-review/{health,llm-info,prs,pr,review-start,review-status,review-cancel}`，契约见 [CONTRACT.md](CONTRACT.md) §1。安全：loopback + Host 头校验、拒绝代理头、JSON content-type、body ≤64KiB、15s 请求 deadline；GitHub token 只在 Host 的 gh 子进程/内存中，不进前端、不落日志。

## 结构

```
index.js           Host 入口：Config、路由注册、(llm, agentDefaultModel) 可选注入
lib/http.js        路由分发、信任围栏、body 限长、deadline、JSON 信封
lib/github.js      gh token→fetch（accept-encoding: identity）+ gh CLI 兜底、缓存、截断、stack 推断
lib/review.js      v1.1：审查选项/深度预设、文件级增量缓存、分块并发、复核轮、证据校验、job 状态机
lib/config.js      Standard Schema（Schemastery 或自带兜底）+ 代码级 resolveConfig
client.js          浏览器半边（module-loader bundle，React.createElement）：三栏工作台 + 行内发现卡 + 设置弹层
test/              node --test：115 例（含真实 gh 冒烟、指引读取、缓存/选项/复核全路径）
dev/               开发预览（preview.html + mock 路由 + Edge/CDP 截图校验），不进安装产物
locale/            Plugin Manager 显示元数据（zh/en）
```

## 验证

- `node --test` → **115/115**；`node --check` 全部通过。
- 独立验证装置 `../verify/`：真实 DSH 页面 + 真实路由，v1 **PASS（10/10 项，43/43 路由断言）**、v1.1 见 REPORT §11，证据与截图见 [../verify/REPORT.md](../verify/REPORT.md)。
- AI 审查实测：v1.1 `depth=fast` 真实运行 + 同设置 `cached=true`；`severityThreshold=P0` 服务端过滤；文件级复用 `reusedFiles=24` 且 0 次额外模型调用（见 REPORT）。

## 已知限制

- 只读：合并 / 评论 / reviewer / 提问框均禁用展示（v2 计划）。
- 列表接口（GitHub search）不返回 head/base 分支，列表不显示分支；详情头有真实值。
- GitHub 仓库无 CI 时 Checks 显示“No checks reported”。
- 目标仓库没有评论/Reviewers 时右栏对应卡片为空态。
- `deep` 深度更慢（多一轮复核调用）；`fast` 更适合大 PR 的快速巡检。
- 审查质量取决于当前默认模型；可在配置里覆盖 `provider/model` 或切换页面设置。
- 大 PR 审查耗时数分钟（有进度与取消）；需要更强模型可在配置里覆盖 `provider/model`。
