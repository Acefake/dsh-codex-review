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
   - 完成：发现列表（严重度徽章 / 文件:行 / 为什么 / 怎么改 / 分类），点「定位到 diff」跳到对应文件与行并高亮；
   - 结果按 `repo#PR@headSha` 缓存，同一提交再次打开秒回；
   - 首个真审查耗时取决于 diff 大小：`Acefake/yingbox#129`（24 文件 / 70KB patch）实测约 **239s**。
5. 刷新/切面板不丢数据（Host 缓存），审查结果按 head SHA 失效。

## 配置（可选，写进 profile 的 `cordis.patch.yml`）

```yaml
- id: dsh-codex-review
  name: dsh-codex-review
  config:
    defaultQuery: 'is:open author:@me'   # 列表默认搜索（GitHub 搜索语法）
    limit: 30                            # 列表条数上限
    reviewChunkChars: 9000               # 单次模型调用的 diff 字符预算
    maxChunks: 9                         # 最多分块数
    reviewConcurrency: 3                 # 分块并发（1–6）
    maxOutputTokens: 0                   # 0 = 用适配器物化的模型默认输出上限
    provider: ''                         # 留空 = 当前默认模型；可覆盖
    model: ''
    maxPatchChars: 24000                 # 单文件 patch 展示上限
    maxBodyChars: 50000
```

## Host HTTP 路由（同源 POST JSON，`{ok,value}|{ok:false,error}` 信封）

`/codex-review/{health,llm-info,prs,pr,review-start,review-status,review-cancel}`，契约见 [CONTRACT.md](CONTRACT.md) §1。安全：loopback + Host 头校验、拒绝代理头、JSON content-type、body ≤64KiB、15s 请求 deadline；GitHub token 只在 Host 的 gh 子进程/内存中，不进前端、不落日志。

## 结构

```
index.js           Host 入口：Config、路由注册、(llm, agentDefaultModel) 可选注入
lib/http.js        路由分发、信任围栏、body 限长、deadline、JSON 信封
lib/github.js      gh token→fetch（accept-encoding: identity）+ gh CLI 兜底、缓存、截断、stack 推断
lib/review.js      分块/并发、prompt、JSON 解析重试、校验合并、job 状态机、partial 语义
lib/config.js      Standard Schema（Schemastery 或自带兜底）+ 代码级 resolveConfig
client.js          浏览器半边（module-loader bundle，React.createElement）：三栏工作台
test/              node --test：74 例（含真实 gh 冒烟与 review 引擎全路径）
dev/               开发预览（preview.html + mock 路由 + Edge/CDP 截图校验），不进安装产物
locale/            Plugin Manager 显示元数据（zh/en）
```

## 验证

- `node --test` → **74/74**；`node --check` 全部通过。
- 独立验证装置 `../verify/`：真实 DSH 页面 + 真实路由，**最终 PASS（10/10 项，43/43 路由断言）**，证据与截图见 [../verify/REPORT.md](../verify/REPORT.md)。
- AI 审查实测（修复后）：`done`、`partial=false`、`findings=19`、239s、模型 `opencode-go/deepseek-v4.1-flash`（`reasoningEffort=low`）。

## 已知限制

- 只读：合并 / 评论 / reviewer / 提问框均禁用展示。
- 列表接口（GitHub search）不返回 head/base 分支，列表不显示分支；详情头有真实值。
- GitHub 仓库无 CI 时 Checks 显示“No checks reported”。
- 目标仓库没有评论/Reviewers 时右栏对应卡片为空态。
- 大 PR 审查耗时数分钟（有进度与取消）；需要更强模型可在配置里覆盖 `provider/model`。
