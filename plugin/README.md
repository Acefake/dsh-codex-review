# dsh-codex-review — DSH Web GUI 里的「代码审查」工作台

把 Codex 桌面版「代码审查」窗口的核心体验搬进 DeepSeek Harness Web GUI：左栏 PR 列表、中间 Summary / Changes 与逐文件 unified diff、右栏 Changes / Stack / 评论 / Reviewers / Checks、以及用当前 DSH 模型跑的 **AI 审查**（P0/P1/P2 + 文件:行 + 原因 + 修复建议，可点击定位到 diff）。

- **入口**：安装后左栏出现「代码审查」；点开即进入工作台（`main` 面板 key = `codex-review`）。
- **数据**：Host 侧经 `gh` CLI 凭据读取 GitHub，或经 GitLab REST v4 读取 GitLab（只读，见下文）。GitHub 默认搜索 `is:open author:@me`。
- **AI 审查**：Host 侧走 DSH `ctx.llm`，使用当前默认模型（`agentDefaultModel`），失败/未配置时浏览功能不受影响。
- **范围**：v1 只读 + AI 审查；合并、发评论、向 PR 提问、指派 reviewer 为禁用只读态（v2 计划）。

> 本目录与仓库根目录都是有效的 npm / DSH 组合包入口（声明 `dsh.bundle.patch` + `dsh.client`）。从 Git 地址安装时使用根目录声明；已有 `plugin/` 目录安装继续兼容。详见[根目录安装说明](../README.md)。

## GitLab 只读（0.12.0）

新增 GitLab REST v4 只读通道（兼容 GitLab 12.9）。在 profile patch 里切换数据源：

```yaml
- id: dsh-codex-review
  config:
    dataSource: gitlab
    gitlabBaseUrl: http://gitlab.mbse.design:8090
    gitlabToken: !!js >-
      (() => { try { return process.getBuiltinModule("node:fs")
      .readFileSync(dshHomePath("secrets", "gitlab.token"), "utf8").trim(); }
      catch { return ""; } })()
    viewerLogin: shims
```

- 列表用 `scope=created_by_me`（GitLab 服务端解析，不需要本地登录名）；12.9 用 `/merge_requests/:iid/changes`，草稿字段是 `work_in_progress`。
- 只读：合并、发布评论、回复、解决讨论在 GitLab 下返回 `PROVIDER_UNSUPPORTED`，界面隐藏对应按钮；自动审查仅 GitHub。
- Token 建议 `read_api` 权限；自建 HTTP 实例只在内网使用。
- GitHub 行为不变，默认 `dataSource: github`。

## 统一审查设置

审查深度、严重度阈值和仓库指引由手动与自动审查共用，统一保存在宿主当前 profile 的自动审查配置文件中。工具栏齿轮与 DSH 设置 → 代码审查复用同一份表单；自动审查区域仅保留开关、检查间隔、查询范围、草稿和每轮上限。

升级时沿用宿主原有的自动审查参数，缺少的仓库指引开关默认开启；浏览器旧版手动参数不再覆盖宿主。手动审查请求默认读取宿主共享参数，浏览器 localStorage 只用于显示缓存。修改审查参数不自动开启自动审查或自动发布。

PR 提问栏聚焦时只显示一圈中性边框，不再显示内外两层绿色框。

## 审查结果恢复

切换 PR 会先显示缓存内容，再向宿主核对最新审查状态，因此后台或其他标签页完成的审查可以正常显示。刷新页面后由宿主返回该 PR 当前 head 的结果。

新完成的审查结果（含失败信息）保存在当前 profile 的 `.codex-review/review-results.json`；没有 profile 配置时使用 `~/.dsh/codex-review/review-results.json`。保留范围受 `maxJobs` 限制，默认最近 20 个任务，文件上限 20 MiB；不保存完整 diff、提示词或未完成任务。插件重载后仍可恢复结果，PR head 改变后不会沿用旧结果。旧版宿主重载前未落盘且已经丢失的结果，需要重新审查；已发布到 GitHub 的评论仍可在 PR 中查看。

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
5. **齿轮「审查设置」**（v1.1）：审查深度（快 / 标准 / 深）、严重度阈值（P0 / P1 / P2+）、是否叠加仓库 `AGENTS.md` 审查指引；设置统一保存在 Host，手动和自动审查共用；浏览器仅缓存显示值。
6. **键盘**：`j`/`k` 上下切 PR，`/` 聚焦搜索，`r` 用当前设置审查，`Esc` 关闭弹层；所有交互元素有 aria-label 与 focus-visible。
7. 刷新/切面板不丢数据（Host 缓存），审查结果按 head SHA 失效。
8. **合并 PR**（v2，写操作）：右上「合并」→ 确认弹层（合并方式 Squash / Merge commit / Rebase、删除源分支、head 版本、风险提示）→「确认合并」才会真正调用 GitHub。服务端会校验 `confirm===true`、`expectedHeadSha` 未移动、mergeable 状态；失败给出 `MERGE_HEAD_MOVED` / `MERGE_CONFLICT` / `MERGE_NOT_ALLOWED` 等明确原因。
9. **就此 PR 提问**（v2）：底部输入框输入问题 → 右侧浮起对话面板，流式回答（可停止、清空、重试、三枚快捷提问）；回答上下文包含 PR 元信息/正文/文件清单/最近一次 AI 审查摘要/当前展开文件 patch；每个 PR 的历史独立保存在 `localStorage['codex-review:chat:<repo>#<number>']`（≤20 条）。
10. **自动审查**（v2.1）：在「审查设置」里打开自动审查后，Host 每 180 秒（可调 60–3600）扫描一次，对新的/有新提交的 PR 自动跑审查；右栏「自动审查」卡显示状态与最近结果，列表行显示徽章，新结果会 toast。默认关闭；「立即检查」可手动触发一次。
11. **发布审查到 GitHub**（v2.2，写操作）：审查完成且有发现时，审查卡出现「发布到 GitHub」→ 确认弹层（行内 / 汇总 / 两者、最低严重度、预计评论数、写操作警告）→「确认发布」才真正在 PR 上创建 review 评论；成功后显示「已发布 · 在 GitHub 查看」。「审查设置」里的自动发布开关默认关闭，开启需二次确认。**v2.4 起一个 PR 只保留一条汇总 review：后续审查原地更新它，不再每次新增。**
12. **评论写操作**（v2.3，写操作）：diff 内已有行内评论可「回复」或「解决」讨论线程；PR 头部「评论」可发表 PR 总评论。三条写路径都要 `confirm:true`，失败有明确错误码，成功后自动刷新。

## v1.1 新增（0.2.0）

- **审查选项**：`depth = fast | standard | deep`（deep 在单遍审查后加一轮「证据复核」，只保留模型判定有 diff 证据的发现）、`severityThreshold`、`includeGuidelines`；选项参与缓存 key。
- **增量审查**：文件级结果缓存（`repo#PR|path|sha1(patch)`，LRU 400），新提交只审变化文件；全命中时 <1s 返回并回填 `reusedFiles`。
- **仓库审查指引**：自动读取仓库 `AGENTS.md` / `.github/AGENTS.md`（各 ≤4000 字，repo 级缓存 10 分钟），注入每个分块 prompt；不存在时正常审查。
- **发现更可核验**：新增 `evidence`（支持结论的 diff 行原文，≤200 字）与 `confidence`（high/medium/low）；`verdict` 由严重度派生（P0→阻塞、P1→需要修改、否则建议合并）。
- **diff 行内卡片 + 已有评论**：GitHub 行内评论按 `path+line` 渲染为只读卡片，与 AI 发现视觉区分。
- 版本 0.2.0；测试 115 例。

## v2 新增（0.3.0）

- **合并写操作**：`POST /codex-review/merge`；显式确认 + head SHA 校验 + mergeable 守卫，成功后清缓存；删除源分支失败只降级告警、不影响合并结果。
- **PR 对话（流式）**：`POST /codex-review/chat`（text/event-stream）；上下文含 PR 元信息/正文/文件清单/最近审查摘要/当前文件 patch，总预算 ≤24000 字；并发上限 2，客户端可中止上游。
- **安全边界**：合并只在用户点击「确认合并」后执行；插件自身不做任何自动写；README 与契约均记录了网络围栏与请求校验。

## v2.1 新增（0.4.0）：自动审查

- **后台定时扫描**：Host 侧 `AutoReviewer` 按间隔拉取 `query`（默认 `is:open author:@me`），发现新 PR 或 PR 有新提交（headSha 变化）时自动跑 AI 审查；已审过的提交不会重复审查（seen 游标持久化）。
- **默认关闭**：只有你在设置里打开才运行；关闭时立刻停止后台调度与页面轮询。间隔 60–3600 秒（默认 180），每次最多审 1–5 个（默认 2），深度默认 `fast`，阈值默认 `P2`，可排除草稿。
- **结果可见**：右栏「自动审查」卡显示开关状态、上次/下次检查、最近结果（点击可跳到对应 PR）；PR 列表行显示自动审查徽章（问题数 / ✓）；新结果完成时页面 toast。
- **持久化**：配置与 seen 游标存 `<DSH_PROFILE_DIR>/.codex-review/auto-review.json`（无 profile 时回退 `~/.dsh/codex-review/auto-review.json`），插件重载/宿主重启后继续生效（不会重复审同一提交）。
- **安全**：自动审查只读 GitHub（绝不自动发评论、不合并、不改仓库）；手动「立即检查」可随时触发一次，勾选 force 时即使开关关闭也只跑一次。
- 版本 0.4.0。

## v2.2 新增（0.5.0 / 0.5.1）：把审查发布到 GitHub

- **发布审查（写操作，显式确认）**：AI 审查完成且有点时，审查卡出现「发布到 GitHub」；确认弹层可选发布方式（行内评论 / 汇总评论 / 行内+汇总）与最低严重度，并显示预计评论数；只有点「确认发布」才调用 `POST /codex-review/review-publish`（带 `confirm: true`）。成功后在 GitHub 上创建一条 `event: 'COMMENT'` 的 PR Review，按钮变为「已发布 · 在 GitHub 查看」。
- **幂等与去重**：每个 `repo#number@headSha` 只发布一次；重复发布回放已存结果、不发写请求；服务端对同一 head 的并发发布做 in-flight 去重，双击/多标签页不会产生两条 review；行内评论带 `<!-- dsh-codex-review:<hash> -->` marker，重发时跳过 GitHub 上已存在的评论。
- **自动发布（0.5.1 起覆盖手动审查）**：开启后，完成的 AI 审查会自动发布到对应 PR——无论是点「用 AI 审查」手动发起的，还是自动审查 cycle 跑出来的；默认关闭，开启需二次确认（写操作警告）。失败只记 `lastError` / Host 日志，不重试风暴；同一 head 仍只发布一次。
- **已发布状态跨刷新**：`/pr` 的 review 快照与 `/review-status` 都带 `published` 记录（`url`/`reviewId`/`publishedAt`），刷新页面或审查刚完成时都能显示已发布徽章；发布记录持久化在 auto-review 状态文件。
- **安全**：发布只创建 review 评论，绝不修改代码、不推送、不合并；GitHub token 只留在 Host；手动发布必须 `confirm:true`，自动发布默认关闭。
- 版本 0.5.1；测试 231 例。

## v2.3 新增（0.6.0）：评论写操作

- **回复行内评论**：diff 里已有的 GitHub 行内评论卡新增「回复」→ 行内输入框 →「发送回复」才真正写入 GitHub（`POST /codex-review/reply`，`commentId` + `confirm:true`）。
- **解决讨论线程**：评论卡「解决」→ 确认条 → 确认后调用 GraphQL `resolveReviewThread`；解决后显示「已解决」并隐藏操作。需要 token 写权限；GraphQL 不可用时该操作自动隐藏，回复仍可用。
- **发表 PR 总评论**：PR 头部「评论」→ 弹层 →「发表评论」（`POST /codex-review/comment`）。
- **安全与一致性**：三条路由都要求 `confirm:true`；body ≤4000 字；失败回显 `BAD_REQUEST` / `GH_FORBIDDEN` / `GH_NOT_FOUND` / `GH_RATE_LIMIT` / `GH_NETWORK`；写入成功后自动失效 PR 详情缓存并刷新页面，新评论即时可见。
- 版本 0.6.1；测试 238 例。

## v2.4 新增（0.7.0）：发布改为「一个 PR 一条滚动 review」

- **不再每次新增评论**：首次发布创建一条汇总 review；之后同一 PR 的审查只 `PUT` 更新这条 review 的 body（GitHub 时间线显示 edited），不会每 push 一个 commit 就多一条。
- **没变化就不写**：按「汇总 body + 行内评论」算内容指纹；同一 head 重发，或新 head 但审查结果完全相同 → 0 个 GitHub 写请求，只刷新本地「已发布」记录。
- **行内评论只补新的**：GitHub 不允许给已提交的 review 追加行内评论，所以只有从未发布过的 finding 会以一条无 body 的新 review 补发；汇总那条 review 的 id 不变。
- **状态丢失可找回**：汇总 review 末尾带隐藏 marker `<!-- dsh-codex-review:summary -->`；本机状态文件丢失后先列出 PR reviews 按 marker 找回再更新，不会重复创建。
- **并发**：同一 head 并发发布仍只写一次；同一 PR 的不同 head 串行执行，避免滚动记录竞争。
- 版本 0.7.0；测试 246 例。


## v0.8 界面改版（0.8.0）：Claude Code 桌面端风格

- **桌面应用观感**：暖中性底色（宿主 token 与暖纸色混合，深/浅主题都成立），比例字体承担界面与正文，等宽字体只留给 diff、代码、文件路径、分支和 SHA。
- **形状**：10–14px 圆角卡片、1px 发丝描边、单一陶土红强调色（主操作 / 选中 / 焦点），不再用彩色胶囊堆叠；标签页是分段控件，弹层是悬浮卡片。
- **更紧凑**：工具栏 46px、列表行约 58px、正文 14/24、右栏小节 12px 间距；三栏宽度 224 / 700–712 / 288。
- **更少滚动条**：文档与右栏共用一个滚动容器（全页只剩列表 + 主体两条，6px 细滚动条）；输入框从浮动胶囊改为文档列下方居中的桌面式输入卡。
- **性能**：`.cr-file` / `.cr-finding` / `.cr-row` 启用 `content-visibility` 跳过视口外渲染；`FileCard` / `DiffView` / `ChangesView` 使用 `React.memo` 与稳定空数组/回调，审查轮询时不再重渲染整个 diff。
- 版本 0.8.0；测试 246 例（UI 改动由 dev 预览 11 个场景与真实 GUI 验收覆盖）。

## v1.0 视觉：按 Codex 参考 1:1 回填工作台

按 `recon/ui-spec.md`（Codex 桌面版「代码审查」窗口的逐像素规格）重做工作台，不再保留自定义皮肤：

- **布局**：左列表 238 / 文档列 760 / 详情列 300，列距 44；主区与详情列同底色、无分隔线；三列各自独立滚动（列表 / 文档 / 详情）。
- **配色（暗色实测值）**：应用底 `#202020`、左栏 `#1B1B1B`、主区 `#181818`、抬升层 `#2D2D2D`、选中分段 `#383838`；正文白、次文本 `#AEAEAE`、弱文本 `#6E6E6E`；语义色 `#40C977` / `#FA423E` / `#FF8549` / `#E3B341`。浅色主题为同构浅色值。
- **排版**：PR 标题 28/36、正文 17/26、h2 19/28、行内代码 13 mono 底 `#303030`、列表标题 14/20、meta 13、diff 13/20 mono；比例字体做界面，等宽只给代码、diff、路径、分支、SHA。
- **组件**：搜索 222×36 胶囊、列表卡 212×72 圆角 12（选中 `#2D2D2D`）、分段控件 33 高（选中 `#383838`）、徽章 93×27、合并按钮白底 `#171717` 字、底部提问条 557×43 胶囊、diff 文件头 36 高、增删行 10% 透明底、hunk `#232323`。
- **顶部审查汇总**：AI 审查结果卡从右栏移到 PR 头部与正文之间（Summary / Changes 都可见），显示 verdict、P0/P1/P2 计数、耗时/文件数/模型/最近完成时间，以及按严重度排序的发现列表（三段式：标题 / 为什么 / 怎么改）与重新审查、发布入口。
- **Comments 按线程展示**：右栏把行内评论按 thread 归并（渲染前 5 个线程，其余「显示更多」），每条显示严重度徽章（从 `**[P1] 标题**` 解析）、作者头像、回复数与「解决」按钮；已解决线程显示勾选与删除线；PR 会话评论单独列出并截断正文。之前只平铺 `inline.slice(0,3)` 的原始正文，38 条行内评论只能看到 3 条。
- **真实 GitHub 头像**：列表、PR 头部、Comments 线程、Reviewers 使用接口返回的 `avatarUrl`（`user.avatar_url`）；图片加载失败时回退到首字母。
- **冷路径并行**：`/pr` 不再先等 `pull` 再并行取子资源——files/comments/reviews/inline/threads 与 `pull` 同时发出，只有 checks/stack 依赖 head SHA；冷请求平均 1351ms → 1133ms。右栏先用列表摘要渲染「Changes」占位（含骨架），详情到达后再填充；首绘 1.0–1.7s → **12–20ms**。
- **切换 PR 更快**：鼠标悬停或键盘聚焦列表行就开始预取该 PR 详情（与点击共享同一个在飞请求，不会重复请求）；每个 PR 的详情在内存缓存 120s，回访直接渲染（0 请求），过期则先渲染缓存再后台刷新；切换时右栏显示骨架而不是上一个 PR 的内容。
- **设置页不变**：DSH 设置 → 代码审查 仍是行式布局 + 分段控件 + 开关，颜色跟随宿主 token；`?scene=settings` 验证照旧。
- 验证：dev 预览 11/11 场景（238/760/300 精确命中）、真实 GUI 插件 console 0 error、v23 交互断言通过；证据见 `verify/REPORT.md` §19。

## v0.9（0.9.0）：设置进入 DSH 设置面板 + 颜色回到宿主主题

- **设置面板**：新增 `settings.section` 注册（DSH 设置 → 代码审查），按 DSH 设置页的原生语言重做——行式布局（标签/说明在左、控件在右）、分段控件选枚举、开关选布尔、没有 fieldset 边框；三块「审查选项 / 自动审查 / 发布审查到 GitHub / 状态」。审查选项写浏览器 localStorage（与工作台齿轮共用同一个 key），自动审查/发布走 Host `auto-review-config` 持久化；开启自动发布需二次确认，开启后才显示方式/最低严重度/评论上限。
- **工作台齿轮保留**为快捷方式，弹层里注明「更多设置已移到 DSH 设置 → 代码审查」。
- **颜色修正**：界面不再使用暖色硬编码或固定品牌色，所有 surface/text/border/强调色都来自宿主 `--dsw-alias-*` token（或在其上做 color-mix）；主按钮改为中性高对比（label-primary 底 + bg 字），深浅主题都跟随 DSH。
- 版本 0.9.1；测试 246 例；dev 预览 11/11 场景通过（另含设置页 `?scene=settings` 渲染场景）。

## v2.5 加固（0.10.0）：发布链路的 19 个漏洞与不完善点

审计 v2.4 滚动发布实现后发现的问题，逐个修掉（契约见 CONTRACT.md §7.6）：

- **不完整审查不再发布**：`partial` 的审查在宿主与客户端都被拦住（`REVIEW_PARTIAL`），不会把漏审文件的结论当成完整结果写进 PR。
- **发布绑定到具体那次审查**：请求与自动发布都带上 `headSha`/`jobId`，发布前用未缓存的接口复核 head；变了就 `REVIEW_HEAD_MOVED`，不再可能把 A 次审查的结果发到 B 个 head 上。
- **同 head 幂等只在同一请求内成立**：head 记录里加 `request` 指纹，改了 mode/最低严重度/摘要正文会真的重新发布，而不是静默返回"0 条评论"。
- **纯行内发布不再抢走滚动身份**：只有带汇总 body 的 review 才能写 `repo#number`，时间线不会出现两条带 summary marker 的 review。
- **汇总不再被 `maxComments` 截断**：摘要列出全部满足严重度阈值的问题，`maxComments` 只限制行内条数。
- **恢复只信自己**：marker 与滚动 review 的 `author` 必须是当前 token 用户；同时兼容 v2.4 之前没有 marker 的历史汇总（固定标题 + 作者），升级后不会给老 PR 再建一条。
- **分页读全**：reviews 20×100、review comments 10×100，状态丢失后旧 marker 不会漏。
- **记录不再回放空链接**：`reviewId <= 0` 或 `url` 为空的记录不落盘；head + rolling 两条记录一次原子写入。
- **状态文件有界、失败可重试**：`published` 只留最新 200 条 head 记录（滚动记录全留），失败重试由持久化的 `failedAt` 决定，不依赖会被挤出的 `recent`。
- **发布有 30 秒预算**：路由 deadline 是 35 秒、客户端也等 35 秒；预算耗尽返回 `PUBLISH_UNKNOWN`，明确告诉用户 GitHub 上可能已经写入。
- **422 不再一条不发**：行内锚点被 GitHub 拒绝时去掉评论重试一次，至少保住汇总，并返回真实的评论数。
- **模型文本净化**：发布前剥掉 HTML 注释、转义 `@`，模型输出既不能伪造 marker，也不能误 @ 真人。
- **UI 不再误报**：成功提示区分「已创建 / 已更新 / 无变化」；`GH_NOT_FOUND` 不再被当成"旧宿主没有发布路由"而把按钮藏掉。
- 版本 0.10.0；测试 267 例。

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

## Host HTTP 路由

JSON 路由（同源 POST，`{ok,value}|{ok:false,error}` 信封）：`/codex-review/{health,llm-info,prs,pr,review-start,review-status,review-cancel,merge,auto-review-status,auto-review-config,auto-review-run,review-publish,comment,reply,resolve}`；SSE 路由：`POST /codex-review/chat`（`text/event-stream`，`data: {"delta"}` / `{"done":true}` / `{"error"}`）。契约见 [CONTRACT.md](CONTRACT.md) §1、§5、§6、§7、§8。安全：loopback + Host 头校验、拒绝代理头、JSON content-type、body ≤64KiB（chat 512KiB）、15s 请求 deadline（chat 单独 5 分钟）、合并与发布必须 `confirm:true` + head SHA 校验；GitHub token 只在 Host 的 gh 子进程/内存中，不进前端、不落日志。

## 结构

```
index.js           Host 入口：Config、路由注册、(llm, agentDefaultModel) 可选注入、merge/发布/SSE chat 路由
lib/http.js        路由分发、信任围栏、body 限长、deadline、JSON 信封
lib/github.js      gh token→fetch + gh CLI 兜底、缓存、截断、stack 推断、合并写操作、发布 review、对话上下文
lib/review.js      v1.1：审查选项/深度预设、文件级增量缓存、分块并发、复核轮、证据校验、job 状态机
lib/chat.js        v2：PR 对话上下文拼装、SSE 帧编码、并发限流、错误映射
lib/auto-review.js v2.1：自动审查调度器（定时扫描、seen 游标、状态持久化、配置夹取、自动发布）
lib/publish.js     v2.2/v2.4/v2.5：发布审查到 GitHub（finding→评论映射、marker 去重、幂等记录、并发去重、滚动汇总 review 原地更新、partial/head 绑定/超时预算/422 降级）
lib/config.js      Standard Schema（Schemastery 三路解析或自带兜底）+ 代码级 resolveConfig
lib/errors.js      错误码与面向用户的中文文案
client.js          浏览器半边（module-loader bundle，React.createElement）：三栏工作台 + 行内发现卡 + 设置弹层 + 合并确认 + PR 对话 + 发布弹层
test/              node --test：合并守卫/对话/自动审查/发布/SSE 编码等 267 例
dev/               开发预览（preview.html + mock 路由 + Edge/CDP 截图校验），不进安装产物
locale/            Plugin Manager 显示元数据（zh/en）
```

## 验证

- `node --test` → **267/267**（v1 74 → v1.1 115 → v2 163 → v2.1 186 → v2.2 228 → v2.3 238 → v2.4 246 → v2.5 267；含真实 gh 冒烟、指引读取、缓存/选项/复核、合并守卫、对话上下文/SSE 编码、自动审查调度与持久化、发布映射/marker 去重/并发去重/滚动更新、partial 拦截/head 绑定/请求指纹/分页/原子持久化、评论写校验与 GraphQL 线程映射）；`node --check` 全部通过。
- 独立验证装置 `../verify/`：真实 DSH 页面 + 真实路由；v1 **PASS（10/10 项，43/43 路由断言）**、v1.1 见 REPORT §11、v2 见 REPORT §12、v2.1 见 REPORT §13、v2.2 见 REPORT §14、v2.3 见 REPORT §15，证据与截图见 [../verify/REPORT.md](../verify/REPORT.md)。
- AI 审查实测：v1.1 `depth=fast` 真实运行 + 同设置 `cached=true`；`severityThreshold=P0` 服务端过滤；文件级复用 `reusedFiles=24` 且 0 次额外模型调用（见 REPORT）。
- 合并：**只做守卫测试，未对真实 PR 执行合并**（避免误操作）；对话：真实流式问答验证（SSE delta→done，1.4s 返回 603 字上下文相关回答）。
- 发布：装置侧校验分支与页面取消路径 **0 写入**；功能侧做过一次真实自动发布验证（2026-10-25：#139 → review `5640905093` / 19 条行内评论，#141 → 13 条），未合并。
- 评论写操作：**只做校验分支与页面取消路径验证，未真实回复/解决/发评论**（`--v23` 硬约束：confirmTrueSent=0、writes=0）。
- 滚动发布（v2.4）：单测覆盖原地更新/无变化不写/marker 找回/404 回退/并发；**未主动对用户 PR 发写请求**，真实滚动更新会在你下一次审查（自动发布开启时）自然发生。
- 发布加固（v2.5）：14 项修复都有单测（partial 拦截、head 绑定、请求指纹、纯行内不抢滚动身份、摘要不再被 maxComments 截断、marker/review 作者校验、分页、空记录不回放、原子持久化、状态有界、30s 预算、422 降级、模型文本净化、dispose 清理）；真实侧只做只读验证（`getPullHead` / `getAuthenticatedUser` / 分页读 reviews 与 comments / 汇总 review 找回），**没有新增任何 GitHub 写请求**。

## 已知限制

- 合并：需要 GitHub 仓库写权限；受保护分支/合并队列策略由 GitHub 决定，失败会回显 code/message。成功后不自动推送本地分支。
- 发布：需要 GitHub token 有 `repo` 写权限（只读 token 会返回 `GH_FORBIDDEN`）；finding 的 `line` 必须落在 diff 的 RIGHT 行，越界时 GitHub 会拒绝整条 review——v2.5 起自动去掉行内评论重试一次保住汇总，并在错误信息里回显 GitHub 给出的首个原因。发布记录（每个 head + 该 PR 的滚动 review）存在本机状态文件，多机不同步；同一 head 同一请求重复发布只回放记录；同一 PR 后续审查原地更新汇总 review（内容相同则 0 写入）。
- 自动发布默认关闭；开启后，之后完成的 AI 审查会真实写入 GitHub：首次创建一条汇总 review，后续原地更新，只有新行内问题会补发。可在「审查设置」里随时关闭。
- 发布不做 auto-fix：不会修改代码、不会向分支推送提交（另行评估）。
- 对话：回答基于 PR 上下文（元信息/正文/文件清单/最近审查摘要/当前文件 patch），不是全仓库检索；上下文预算 24k 字。
- 评论功能（发评论/回复/解决评论线程）仍未接入（只读展示已有评论）。
- 列表接口（GitHub search）不返回 head/base 分支，列表不显示分支；详情头有真实值。
- GitHub 仓库无 CI 时 Checks 显示“No checks reported”。
- 目标仓库没有评论/Reviewers 时右栏对应卡片为空态。
- `deep` 深度更慢（多一轮复核调用）；`fast` 更适合大 PR 的快速巡检。
- 审查质量取决于当前默认模型；可在配置里覆盖 `provider/model` 或切换页面设置。
- 大 PR 审查耗时数分钟（有进度与取消）。
