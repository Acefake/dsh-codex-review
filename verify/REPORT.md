# dsh-codex-review · 端到端验收报告

> **状态：PASS（v1 验收 16:05；v1.1 验收 19:10；v2 验收 20:05；v2.1 复跑 23:59；v2.2 验收 2026-10-25 00:03，Host health version=0.5.0，client.js 冻结 mtime 22:34:41 / 353533B）**
> 执行：verifier（独立验证装置 `verify/`）｜2026-10-24 15:00 – 2026-10-25 00:25（Asia/Shanghai）
> 插件安装/重载与 AI 审查修复由 Lead 执行；本文档所有数字均来自真实 DSH Web GUI 与真实路由。
> v1 证据：`api-probe-final.json`（43/43）、`ai-review-ui.json`、`page-check-final.json`、`click-panel-final.json`；
> v1.1 证据：`api-probe-v11-final.json`（90/90）、`click-panel-v11.json`、`page-check-v11.json`、`v11-*.png`（见 §11）；
> v2 证据：`api-probe-v2.json`（53 通过/1 pending）、`click-panel-v2.json`、`page-check-v2.json`、`v2-*.png`（见 §12）；
> v2.1 复跑证据：`api-probe-v21-final.json`（58 通过/0 失败/0 pending）、`page-check-v21-final.json`（4/4）、`click-panel-v21-final.json`（17 通过/0 失败/1 pending）、`v21-*.png`（见 §13）；
> v2.2 证据：`api-probe-v22.json`（42 断言全过，safety unsafe=0/published=0）、`page-check-v22.json`（4/4）、`click-panel-v22.json`（20 通过/0 失败/1 pending）、`v22-*.png`（见 §14）。

## 0. 元信息

| 项 | 值 |
|---|---|
| 插件 | `dsh-codex-review` v0.1.0（v1）→ v0.2.0（v1.1）→ v0.3.0（v2）→ v0.4.0（v2.1）→ **v0.5.0（v2.2，health version=0.5.0）**（`C:\Users\10228\dsh-codex-review\plugin`） |
| 安装 | `plugin_manager install_bundle`，返回 application=applied、已 enabled；v2.1/v2.2 验收期间通过 profile `cordis.patch.yml` disable→enable 热重载（无需重启宿主） |
| 安装形态 | desktop profile `node_modules/dsh-codex-review` → 符号链接到 plugin 目录（改文件后 disable→enable 重载生效） |
| Host 进程 | v1/v1.1/v2 验收期间未重启（PID 9356 系）；2026-10-24 22:48 DSH 重启（GUI 换到 `http://127.0.0.1:3685`）；v2.1/v2.2 以 profile 热重载加载 0.5.0 |
| GUI | `http://127.0.0.1:3685`（profile: desktop；旧章节记录的 2632 为重启前端口） |
| OS / Node / Edge | Windows 11 10.0.26200 / Node v24.21.0 / Edge 155.0.4283.62 |
| gh | gh 2.102.0，已登录 `Acefake`（scopes: gist, read:org, repo, workflow） |
| 认证 | 本机凭据只读（`$DSH_HOME/.credentials.yaml` 的 browser-session 签名密钥 mint 1h cookie）；也支持 `--token` |
| 模型 | `opencode-go / deepseek-v4.1-flash`，reasoningEffort=`low`（llm-info 实测），transport=prepared |
| 视口 | 1600×1100（CDP device metrics） |

## 1. 结论摘要

| # | 验收项 | 期望 | 实际 | 证据 | 判定 |
|---|---|---|---|---|---|
| 1 | 插件安装生效 | 插件管理器出现，左栏出现「代码审查」 | 侧栏 button `aria-label=代码审查` @ (14,158) 252×36 | `out/click-before-final.png`、page-check sidebar | **PASS** |
| 2 | 路由就绪 | `/codex-review/*` 返回 JSON 信封 | 200 + `{ok:true,value}` | `out/api-probe-final-skip-ai.json` | **PASS** |
| 3 | health | gh/llm/version 合法 | `{gh:"ok", llm:"ok", version:"0.1.0"}` | 同上 | **PASS** |
| 4 | prs | ≥20 条、字段形状合法 | 25 条（totalCount=25） | 同上 | **PASS** |
| 5 | pr #129 | 24 文件、body、stack 含 #117 | 24 文件、body 3671 字符、chain=[117] basePr=117 | 同上 | **PASS** |
| 6 | 信任围栏/响应头 | 拒绝跨站/伪造头/非 JSON；200 均 json+no-store | 403/403/415；全部 json+no-store | 同上 | **PASS** |
| 7 | 页面无 JS 错误 | console.error=0、pageerror=0 | 0 / 0（failedRequests=0，warnings=0） | `out/page-check-final.json`、`out/gui-final.png` | **PASS** |
| 8 | 点击左栏入口 → 三栏工作台 | 真实点击成功、三栏渲染、无 slot crash | 点击 (140,176)；列带 280,880→280,518,1280；threeColumns=true；console=0；slotCrashed=false | `out/click-panel-final.json`、`click-before-final.png`、`click-after-final.png` | **PASS** |
| 9 | AI 审查端到端 | review-start→status 终态 done 且 **partial≠true**、findings schema 合法 | `jobId=rv-mvm3ca0u-1`：done、partial=false、**findings=19**、job 耗时 239386ms、缓存轮询 7ms；43 项断言全过 | `out/api-probe-final.json` | **PASS** |
| 10 | UI AI 审查 | 点「用 AI 审查」→ 完成态卡片（19 个问题/P2 徽章、无 partial、console=0） | 缓存命中 3.1s；页面显示 `完成 · 239s · 24 files · 建议合并：没有 P0/P1 问题`、`P0 0 / P1 0 / P2 19`、`共 19 个问题：P2 ×19` + 逐条 findings 卡片；无「部分结果」、无 `[data-review-partial]`；console/pageerror=0 | `out/ai-review-done.png`、`out/ai-review-ui.json` | **PASS** |

**总体判定：`PASS`（10/10 项通过；43/43 路由断言通过；未发现 slot crash / 未解释 console error）**

## 2. 环境与执行命令

```powershell
$V = 'C:\Users\10228\dsh-codex-review\verify'

# 1) 页面检查（console/pageerror/截图）
node $V\page-check.mjs --out-dir $V\out --report page-check-final.json --shot gui-final.png
# 2) 左栏入口点击 + 三栏工作台
node $V\click-panel.mjs --target 代码审查 --out-dir $V\out --before click-before-final.png --after click-after-final.png --report click-panel-final.json
# 3) 路由契约（只读部分；含 llm-info）
node $V\api-probe.mjs --skip-ai --out-dir $V\out --report api-probe-final-skip-ai.json
# 4) 全量（含真实 AI 审查；最终复跑）
node $V\api-probe.mjs --out-dir $V\out --report api-probe-final.json
# 5) UI 端到端 AI 审查（点「用 AI 审查」→ 到终态 → 截图）
node $V\ai-review-ui.mjs --select 自动检测片头片尾 --out-dir $V\out
```

| 步骤 | 命令 | 退出码 | 结果 |
|---|---|---|---|
| 页面检查 | `page-check.mjs` | 0 | consoleErrors=0 / pageErrors=0 / warnings=0 / failedRequests=0 |
| 左栏点击 | `click-panel.mjs` | 0 | 三栏渲染、8/8 检查通过 |
| 只读路由 | `api-probe.mjs --skip-ai` | 0 | 29/29 断言通过 |
| 全量路由（含 AI） | `api-probe.mjs` | 0 | **43/43 断言通过**，review done + partial=false + findings=19 |
| UI AI 审查 | `ai-review-ui.mjs --select 自动检测片头片尾` | 0 | 缓存 3.1s 完成、显示 19 个问题、0 console error |

退出码约定：0 通过 / 1 断言失败 / 2 装置或认证 / 3 路由未就绪。

## 3. API 契约结果（`out/api-probe-final.json`，43/43 通过）

| 项 | 值 |
|---|---|
| routesReady | true |
| 断言 | **43 通过 / 0 失败**（只读子集 `--skip-ai`：29/29） |
| prs | 25 条（≥20 门槛），字段形状合法 |
| pr #129 | 24 files；body 3671 字符；stack: chain=[117]、basePr=117、declaredBase=`feat/skip-intro` |
| review-start | jobId=`rv-mvm3ca0u-1`，headSha=`f31cec5c…`，`cached=true`（命中原 job，10ms） |
| review-status | **state=done、partial=false、findings=19**、overview=`共 19 个问题：P2 ×19`、filesDone 24/24、job elapsedMs=239386、model=opencode-go/deepseek-v4.1-flash；轮询 1 次 7ms |
| findings schema | 19/19 合法：severity∈{P0,P1,P2}（全部 P2）、file/line/title/why/fix/category/id 齐全 |
| review-cancel | 终态后调用 → `{ok:true, value:{cancelled:false}}`；未知 jobId → 合法错误/成功信封 |
| comments/checks | total=0；checks.state=`none`（数据实际状态） |
| 信任围栏 | 跨站 Origin → HTTP 403；`x-forwarded-for` → HTTP 403；`content-type: text/plain` → HTTP 415 |
| 响应头 | 所有 200：`application/json; charset=utf-8` + `cache-control: no-store`（health/prs/pr/review-start/review-cancel 实测） |
| llm-info | 200，`{selection:{provider:"opencode-go",model:"deepseek-v4.1-flash"}, reasoningEffort:"low", efforts:["low","high","max"], transport:"prepared", pluginConfig:{maxOutputTokens:0, reviewChunkChars:9000, maxChunks:9}}`，另含 provider 可用模型列表（30 个）；原始证据 `out/llm-info-final.json` |

> `prs` 的 `headRefName/baseRefName` 返回空字符串：列表数据来自 GitHub search API（不含 ref 字段，CONTRACT §1.4 归一化现实），客户端列表不使用；按 `string` 类型断言通过，作为低风险观察项（§7 D3）。
> 全量 probe 命中缓存 job（`cached=true`）因此 **不产生额外模型调用**；job 的真实耗时来自 `progress.elapsedMs=239386ms`。

## 4. 页面检查（`out/page-check-final.json`）

| 项 | 值 |
|---|---|
| title | `DeepSeek Harness` |
| console.error / pageerror / warning | **0 / 0 / 0** |
| 失败请求 | 0（network requestCount=51，top host 127.0.0.1:2632、static.deepseek.com） |
| 模态框 | 无（首次「预览版说明」此前已关闭；装置两种状态都处理） |
| 左侧栏 | 含 `<button aria-label="代码审查">`，共 13 个可交互元素 |
| 良性噪音 | `/api/experimental-inspector/bootstrap` 404 仅出现在浏览器网络日志（`logProblems`），不是 console.error |

## 5. 点击入口与三栏工作台（`out/click-panel-final.json`）

| 项 | 值 |
|---|---|
| 模态框 | 无（by=none） |
| 命中入口 | `button` aria-label=`代码审查` text=`代码审查` @ (14,158) 252×36（按侧栏容器文本匹配，不依赖 aria 猜测） |
| 点击 | 真实 CDP 鼠标事件 @ (140,176) |
| 点击后页面变化 | bodyText 218→3649 字符；列带 `[280,880]` → `[280,518,1280]` |
| 三栏判定 | threeColumns=true（3 条列带）+ 文案信号 Summary/Changes/files/`用 AI 审查`=true |
| console/pageerror | 0 / 0 |
| slot entry crashed | **false** |
| 检查项 | 8/8 通过（模态框清除、找到入口、点击派发、页面变化、三栏渲染、无 pageerror、无 console.error、无 slot crash） |
| 截图 | `click-before-final.png`、`click-after-final.png` |

人工核对（对照 `recon/ui-spec.md` 与用户 Codex 截图）：侧栏入口顺序（插件 → 代码审查 → 自动化任务）正确；
点开后左列 PR 列表（搜索 `is:open author:@me` + 真实 25 条数据）、中列 PR 头/Summary-Changes/正文、
右列 Changes/Stack/Comments/Reviewers/Checks 与 AI 审查卡三栏结构完整；无空白/错位；深色主题与 token 配色正常。
右侧「用 AI 审查」「合并」按钮、底部「就此 Pull Request 提问」输入框均在位（合并/提问为 v1 只读占位）。

## 6. AI 审查端到端（重点，含修复前后证据）

### 6.1 修复前的真实故障证据（P1 阻塞，已确认必须修）

| jobId | 现象 | 证据 |
|---|---|---|
| `rv-mvm2a1e8-1` | done + **partial=true**，486s，findings=[]，overview「部分内容未能完成审查（4 个文件块失败）」；4 块 partialReasons 均 `no-json-object` + `模型返回 max-tokens，可见输出 0 字`；`truncatedCalls=8` | `out/api-probe-partial-before-fix.json`（同源 job 状态） |
| — | UI 缓存态卡片如实显示：`Codex 审查 · 完成 · 486s · 24 files · deepseek-v4.1-flash · 部分结果`、`P0 0 P1 0 P2 0`、partial 原因与「8 次模型输出被截断」 | `out/ai-review-done.png`、`out/ai-review-ui.json` |
| `rv-mvm34iby-1` | 并发版第一次：23/24 文件后最后一个分块 120s 超时 → 整个 job `REVIEW_TIMEOUT`（单块失败拖垮整 job 的设计缺陷） | Lead 独立复现并修复 |

根因链：`sessionId` 缺失（最早 `MissingSessionID`，已修）→ reasoning 把输出预算吃光（max-tokens、可见 0 字）
→ `efforts[0]` 取档不可靠 / maxOutputTokens 固定 4096 偏小 → 单块超时毁整 job。
装置侧同步加固：api-probe 轮询默认 600s、**绝不对运行中 job 调 review-cancel**、`partial===true` 记为失败断言；
新增 `/codex-review/llm-info` 证据采集。

### 6.2 修复内容（Lead 三次迭代，均有独立实测确认）

1. `sessionId=job.id` 传给 `ctx.llm.stream`（opencode-go 的 `x-opencode-session` 必需）；
2. 改走 `ctx.llm.prepareCall` + 按 id 优先级选最低 reasoning 档（`low`），`maxOutputTokens=0` 让适配器物化模型默认上限，分块 18000→9000、maxChunks 9、并发 3；
3. 单块失败（超时/传输/解析）不再拖垮 job，只记 partial 原因；单次调用超时 120s→180s；partialReasons 带「可见输出 N 字，推理 M 字」诊断。

llm-info 实测（修复后）：`transport=prepared`、`reasoningEffort=low`、`efforts=[low,high,max]`、`maxOutputTokens=0`。

### 6.3 修复后复跑结果（最终，本报告结论来源）

| 项 | 值 |
|---|---|
| jobId / headSha | `rv-mvm3ca0u-1` / `f31cec5c712d88c5f26bb0e6fcbf2e09e3954585` |
| 终态 | **done** |
| partial | **false**（`partialReasons` 为空、无 truncatedCalls） |
| findings | **19 条**，overview=`共 19 个问题：P2 ×19`；schema 19/19 合法 |
| 进度 | phase=done，filesDone 24/24 |
| 耗时 | job `progress.elapsedMs=239386ms`（≈3 分 59 秒；并发 3、9 块） |
| 模型 | `opencode-go / deepseek-v4.1-flash`，reasoningEffort=low，transport=prepared |
| 缓存 | review-start `cached=true`（10ms），review-status 轮询 1 次 7ms 到终态（无额外模型调用） |
| 断言 | api-probe **43/43 通过**，其中「review-status: 非 partial」通过 |

findings 示例（前 3 条，均为 P2）：
1. `src/main/intro-detect/detector.ts:55` 候选错位快路径不可取消、不让出事件循环（concurrency）
2. `src/main/intro-detect/detector.ts:104` analyzed<2 提前返回未上报完成进度（correctness）
3. `src/main/intro-detect/ffmpeg.ts:144-153` clipPrint 时长解析与 head/tail 窗口裁剪缺单测（test）

### 6.4 UI 端到端（「用 AI 审查」按钮）

| 项 | 值 |
|---|---|
| 触发按钮 | 工作台头部「用 AI 审查」（zh；en 为 Review with AI），`disabled=false` |
| 选中 PR | 通过列表文本「自动检测片头片尾」选中 #129（`selection.found=true`） |
| 点击到终态 | **缓存命中 3.1s** 返回 done（无额外模型调用） |
| 终态卡片 | `Codex 审查 · 完成 · 239s · 24 files · deepseek-v4.1-flash`；`建议合并：没有 P0/P1 问题`；`P0 0 / P1 0 / P2 19`；`共 19 个问题：P2 ×19`；逐条 finding（severity 徽章 / category / file:line / 为什么 / 怎么改 / 定位到 diff） |
| partial 断言 | 页面无「部分结果」文案，`[data-review-partial]` 不存在 |
| console/pageerror | 0 / 0 |
| 截图 | `ai-review-before.png`（工作台）、`ai-review-running.png`（进度帧）、`ai-review-done.png`（19 findings 完成态） |

## 7. 缺陷清单（按严重度）

| # | 严重度 | 状态 | 描述 |
|---|---|---|---|
| D1 | **P1（已修复并验证）** | ✅ 已修复 | AI 审查因 reasoning 预算耗尽产生 partial（max-tokens/可见 0 字），findings 恒空；叠加单块超时拖垮整个 job。修复：sessionId + effort=low + 模型默认输出上限（maxOutputTokens=0）+ 并发 3/分块 9000/9 块 + 单块失败降级 partial + 超时 180s。**复跑实证：done、partial=false、19 findings、239s** |
| D2 | P2（已修） | ✅ 已修复 | 插件 reload（disable→enable）窗口内路由短暂 404/405，会被误判「插件未安装」——api-probe 已加 3 次重试并提示重载窗口 |
| D3 | P3（观察） | 保留 | `prs` 条目的 `headRefName/baseRefName` 为空字符串（search API 无此字段；客户端列表不依赖）。建议 CONTRACT 注明列表值为空 |
| D4 | P3（观察） | 保留 | 详情 `review.state='error'` 时页面正确显示错误卡片（预期行为，非缺陷） |
| D5 | P3（装置） | 保留 | 认证依赖本机 browser-session 签名密钥（只读）。若 DSH 升级改格式，改用 `--token <启动 URL token>` |
| D6 | P3（耗时/体验） | 观察项 | 24 文件全量审查实测 239s（并发 3）；首次触发仍会让用户等约 4 分钟，UI 有进度与阶段展示，暂无超时/取消体验缺陷 |
| D7 | P3（质量） | 观察项 | 本次 19 条 findings 全部为 P2（0 P0/P1）；属模型判断而非引擎缺陷，报告标注以便用户预期管理 |

**未发现**：左栏入口缺失/错位、三栏不渲染、`slot entry crashed`、客户端未捕获 JS 异常、console.error。

## 8. 截图证据清单

| 文件 | 说明 |
|---|---|
| `verify/baseline/baseline-gui.png` | 插件安装前基线（装置自证：0 console error、检测到预览弹窗） |
| `out/gui-final.png` | 安装后页面，左栏含「代码审查」入口 |
| `out/click-before-final.png` | 点击前（入口可见） |
| `out/click-after-final.png` | 点击后三栏工作台（真实 25 条 PR 数据、24 文件 diff、右栏 AI 审查卡） |
| `out/ai-review-before.png` | UI AI 审查点击前（工作台 + 「用 AI 审查」按钮） |
| `out/ai-review-running.png` | 审查进度帧 |
| `out/ai-review-done.png` | 终态卡片：完成 · 239s · P0 0/P1 0/P2 19 · 共 19 个问题 + finding 详情 |
| `out/preview-changes.png` | 插件 dev 预览（装置早期校准用，非验收证据） |

## 9. 已知限制

- AI 审查结果与耗时非确定性（取决于模型）；断言校验终态与 schema，并额外要求 `partial!=true`。
- 目标 PR #129 本身无 comments、无 CI checks（数据实际状态）。
- 三栏判定为几何列带 + 文案启发式；视觉正确性已人工核对截图。
- 每次运行 Edge 使用 `verify/out/.tmp/` 下一次性 profile，结束自动删除；不触碰用户浏览器 profile。
- 装置依赖 GUI zh 文案（入口「代码审查」、按钮「用 AI 审查」）；可用 `--target` / `--select` 覆盖。

## 10. 最终结论

**总体 PASS。** 插件 `dsh-codex-review` v0.1.0 已安装并在真实 DSH Web GUI（`http://127.0.0.1:2632`）中可用：

- 左栏出现「代码审查」入口，点击后三栏 PR 审查工作台正常渲染（真实 GitHub 数据 25 条 PR、#129 24 文件 diff），
  全程 0 console.error / 0 pageerror / 0 slot crash；
- `/codex-review/*` 全部路由契约通过（43/43 断言），health/prs/pr/stack/围栏/响应头均符合 CONTRACT；
- AI 审查端到端跑通：`done`、`partial=false`、19 条 P2 findings、耗时 239s；UI 点「用 AI 审查」缓存命中 3.1s，
  卡片正确显示计数/严重度/原因与定位入口。

修复前证据（partial 故障）保留在 §6.1；P1 缺陷 D1 已修复并经本轮复跑验证。
**v1.1（插件 v0.2.0）验收同样 PASS**：90/90 路由断言通过（options 回显 / verdict / severityThreshold 过滤 / 增量复用 24/24 / AGENTS.md 注入），
页面端 diff 行内 finding 卡、已有 GitHub 行内评论、审查设置弹层、`j/k/r//` 键盘与 Esc 全部实测通过，0 console/pageerror（详见 §11）。
用户可见变化：刷新 `http://127.0.0.1:2632` 后，左栏「插件」下方出现「代码审查」；点开即三栏 PR 审查工作台，
真实数据来自 `Acefake/yingbox`；右栏/头部「用 AI 审查」可发起审查并显示完成、发现、部分结果与错误状态；
v1.1 起支持审查深度/阈值/AGENTS.md 开关、verdict 徽章、diff 行内 finding 卡与键盘快捷操作。
遗留风险见 §7（P3 观察项：列表 ref 为空、审查耗时约 4 分钟、findings 全为 P2、认证依赖本机凭据）。

## 11. v1.1 验收章节（CONTRACT §4.6）— **PASS**

> **状态：PASS（2026-10-24 19:10 最终复跑；Host v1.1 已生效，health version=0.2.0，client.js 已冻结）**
> 证据：`api-probe-v11-final.json`（**90/90 断言通过**）、`click-panel-v11.json`（全部 PASS）、
> `page-check-v11.json`（6/6 v1.1 断言 PASS）、截图 `verify/out/v11-*.png`。
> 本轮真实审查探测**全部命中 Lead 预热的缓存组合**（default/fast/deep/fast+P0），未发起新的长审查、未调用 review-cancel。

### 11.1 路由/数据断言（`api-probe --v11 --v11-ai --v11-threshold --v11-newjob`：90/90 PASS）

| # | 断言 | 结果 | 证据 |
|---|---|---|---|
| 1 | `ReviewStatus`/`PrDetail.review` 新字段形状：`options`/`verdict`/`reusedFiles`/`guidelines` | PASS | `options={depth:standard,severityThreshold:P2,includeGuidelines:true,chunkChars:9000,maxChunks:9,concurrency:3}`；`verdict=changes` 与 findings 推导一致；`guidelines={loaded:true,files:[AGENTS.md],chars:4000}`；`reusedFiles=15` |
| 2 | 默认设置返回 `ResolvedReviewOptions`（standard/P2/true） | PASS | 命中缓存 job `rv-mvm9ycdt-2`（16 findings，partial=false） |
| 3 | `depth=fast` 与默认产生不同 job key，预算 16000/6/4 | PASS | `rv-mvm9wiz1-1` vs `rv-mvm9ycdt-2`，12 findings，partial=false |
| 4 | 同设置同 headSha 二次 `review-start` → `cached=true` 且同 jobId | PASS | `cached=true`，jobId 同为 `rv-mvm9ycdt-2` |
| 5 | `severityThreshold=P0` → findings 全 P0、verdict/overview 一致 | PASS | 命中缓存 `rv-mvma4tuf-4`：findings=0（空集全 P0 成立）、`verdict=approve`、`overview="共 0 个问题：AI 未发现明显问题"`、reusedFiles=24/24、elapsedMs=1 |
| 6 | `includeGuidelines=true` 且仓库有 AGENTS.md → `guidelines.loaded=true` | PASS | `loaded=true`，`files=[AGENTS.md]`，`chars=4000`（源文件 26959B，按契约截断 ≤4000） |
| 7 | 增量复用（文件级缓存） | PASS | deep+P2 `rv-mvma3j4h-3`：**reusedFiles=24/24、elapsedMs=0**；未缓存组合 fast+P1 `rv-mvmaey3w-5`：新 job key、reusedFiles=24/24、elapsedMs=1、findings=1(P1)、verdict=changes（**0 次模型调用**） |
| 8 | 页面审查卡展示 verdict / resolved options / guidelines 状态 | PASS | 见 §11.2 #9 |

审查 job 一览（全部 done、partial=false，均命中预热缓存）：

| 组合 | jobId | findings | verdict | reusedFiles | elapsedMs |
|---|---|---|---|---|---|
| standard/P2/true（默认） | rv-mvm9ycdt-2 | 16 | changes | 15 | 138548 |
| fast/P2/true | rv-mvm9wiz1-1 | 12 | changes | 0 | 122591 |
| deep/P2/true | rv-mvma3j4h-3 | 16 | changes | 24 | 0 |
| fast/P0/true（阈值过滤） | rv-mvma4tuf-4 | 0 | approve | 24 | 1 |
| fast/P1/true（未缓存新组合） | rv-mvmaey3w-5 | 1 | changes | 24 | 1 |

### 11.2 页面断言（`click-panel --v11` 全部 PASS；`page-check --v11` 6/6 PASS）

| # | 断言 | 结果 | 证据 |
|---|---|---|---|
| 1 | 左栏「代码审查」入口 / 工作台 `data-cr-root` / 「用 AI 审查」/ 设置按钮 | PASS | `page-check-v11.json` v11 checks 6/6 |
| 2 | Changes diff 内 finding 圆点（`[data-inline-marker]`） | PASS：markerCount=16 | `v11-changes.png` |
| 3 | 点击圆点展开行内 finding 卡（为什么/怎么改/严重度/confidence/evidence） | PASS：openLine=104，hasWhy/hasFix/hasSeverity=true，confidence=true，evidence=true | `v11-finding-card.png` |
| 4 | 已有 GitHub 行内评论卡（`[data-inline-comment]`） | PASS：按 path+line 渲染只读评论卡（作者/正文/文件行），当前展开文件 2 张；右栏「4 条评论」汇总正常 | `v11-inline-comments.png` |
| 5 | 设置弹层 depth 三档 / severityThreshold 三档 / includeGuidelines / deep 耗时说明 | PASS | `v11-settings.png` |
| 6 | 改设置后 localStorage 持久化 | PASS：`{"depth":"fast","severityThreshold":"P0","includeGuidelines":true}` | 报告 `settings.storage` |
| 7 | `Esc` 关闭设置弹层 | PASS（先聚焦 dialog 再按 Esc；焦点陷阱正常） | 报告 checks |
| 8 | 键盘 `j/k` 切换 PR | PASS：list #129 → #18 → #129 | 报告 `keyboard` |
| 9 | 审查卡展示 verdict / resolved options / guidelines / 无 partial | PASS：`需要修改` 徽章、`深度 标准 · 阈值 P0–P2（全部）`、`仓库指引：AGENTS.md（4,000 字）`、P0 0/P1 1/P2 15、复用 15 个文件 | `v11-finding-card.png` |
| 10 | 键盘 `r` 触发 review-start 且请求体带当前 options | PASS：`{"repo":"Acefake/yingbox","number":129,"options":{"depth":"fast","severityThreshold":"P0","includeGuidelines":true}}`（命中 fast+P0 缓存，无新模型调用） | 报告 `keyboard.reviewRequest` |
| 11 | 键盘 `/` 聚焦搜索框 | PASS | 报告 `keyboard` |
| 12 | 页面流程期间 console.error / pageerror / slot crash | PASS：0 / 0 / 无 | 报告 `consoleErrors/pageErrors` |

截图：`verify/out/v11-{workbench,changes,finding-card,inline-comments,settings,keyboard}.png`；
页面检查截图 `verify/out/v11-page-check.png`。
人工核对（对照 CONTRACT §4.5 与 Codex 视觉）：diff 行内卡严重度色/证据代码块/定位按钮齐全；行内评论卡与 finding 卡视觉可区分；
verdict 徽章与计数、resolved options/复用/AGENTS.md 状态行、设置弹层三组控件与 deep 说明均符合契约；无错位/溢出。

### 11.3 v1.1 观察项（无阻塞缺陷）

| # | 严重度 | 说明 |
|---|---|---|
| O1 | P3（数据） | 验收期间真实 open PR 数从 25 降到 9（仓库活动合并/关闭）。`prs` 断言已数据感知：≥20 或 `items.length === totalCount && ≥5`，插件返回与 totalCount 一致，不误报 |
| O2 | P3（展示） | PR #134 共 4 条 inline 评论，diff 仅对当前展开文件渲染评论卡（2 张），右栏汇总「4 条评论」正确——符合「按 path+line 渲染」契约，非缺陷 |
| O3 | P3（交互） | `j/k` 按列表顺序切换（跨仓库时会切到其它 repo 的 PR，如 #18），符合契约「上下切 PR」；如产品希望同仓库内切换需另立需求 |
| O4 | P3（验证边界） | deep 复核轮与并发上限的**模型侧行为**本轮用 Lead 预热结果 + 单测覆盖验证（CONTRACT §4.6 item5 允许单测）；装置未另起 deep 长跑 |
| O5 | P3（数据/缓存语义，正向证据） | 验收后仓库继续活动：PR #129 headSha 从 `f31cec5c…` 变为 `c24a0663…`，`PrDetail.review` 正确回到 `state:"none"`（文件级/结果缓存按 headSha 失效），旧 headSha 的完成 job 仍可按 jobId 查询。说明缓存失效逻辑符合契约，不是缺陷 |

**v1.1 判定：PASS（90/90 路由断言 + 页面 12 项全 PASS + 0 console/pageerror）。**

## 12. v2 验收章节（CONTRACT §5.4：合并守卫 + PR 对话）— **PASS**

> **状态：PASS（2026-10-24 20:05 最终复跑；Host v2 已生效 health version=0.3.0，client.js 冻结 mtime 19:54:43 / size 255072）**
> 证据：`api-probe-v2.json`（**53 通过 / 0 失败 / 1 pending=BUSY 跳过**）、`click-panel-v2.json`（全部 PASS，1 pending=历史隔离因仅 1 个 open PR）、
> `page-check-v2.json`（4/4 PASS）、截图 `verify/out/v2-*.png`。
> **安全**：全程未做真实合并；`confirm:true` 仅与全零（刻意 stale）expectedHeadSha 一起发送（脚本内硬断言拒绝其它组合）；页面只点「取消」，Network 断言 0 个 `/codex-review/merge` 请求；未 cancel 任何 job。

### 12.1 合并守卫（api-probe --v2，目标 `Acefake/s-skills#18`，不做真实合并）

| # | 断言 | 结果 | 证据 |
|---|---|---|---|
| 1 | v2 路由就绪（/codex-review/merge 返回 JSON 信封） | PASS | health version=0.3.0；merge 能力探测返回 `BAD_REQUEST` 信封 |
| 2 | `confirm:false` → `BAD_REQUEST` | PASS | `{code:"BAD_REQUEST", message:"请求参数不合法：合并操作需要 confirm: true"}` |
| 3 | 缺 `confirm` / 缺 `method` / 缺 `expectedHeadSha` → `BAD_REQUEST` | PASS | 三者均命中 confirm 守卫（实现顺序：confirm 最先），message 同上 |
| 4 | 非法 method → `BAD_REQUEST` | PASS | 同上 |
| 5 | stale `expectedHeadSha`（全零，confirm:true）→ `MERGE_HEAD_MOVED`，message 带当前 head 前 12 位 | PASS | `{code:"MERGE_HEAD_MOVED", message:"PR 已有新提交（当前 head 9a80d3b77c7f），请刷新后重试"}` |
| 6 | 守卫后 PR 未被合并（state 仍 open）且 headSha 未变 | PASS | before/after 均 `state=open`、headSha=`9a80d3b77c7f…` |
| 7 | 非 open PR（`Acefake/yingbox#129`，已合并）→ `MERGE_NOT_ALLOWED` | PASS | `{code:"MERGE_NOT_ALLOWED", message:"该 PR 已合并，无法再次合并"}`（同样用全零 stale sha，无写操作） |

### 12.2 PR 对话（api-probe --v2，真实 SSE，目标 #18）

| # | 断言 | 结果 | 证据 |
|---|---|---|---|
| 1 | `POST /codex-review/chat` → HTTP 200 + `text/event-stream` | PASS | `text/event-stream; charset=utf-8` |
| 2 | ≥1 个 `delta` 帧；以 `done` 帧结束；无 `error` 帧 | PASS | 72 delta；done=`{done:true, model:{opencode-go/deepseek-v4.1-flash}, usage:{input:72,output:253,total:837,cacheRead:512}}`；无 error |
| 3 | 拼接回答非空（≥10 字）且含 PR 相关词 | PASS | 476 字；内容准确：`.gitattributes`、LF/CRLF、`*.png` binary、CI 内容哈希（与 PR 实际改动一致） |
| 4 | BAD_REQUEST 分支：messages 空 / 末尾非 user / 单条 >4000 / >20 条 | PASS | 4/4 均返回 `BAD_REQUEST`（契约 §5.2 的 SSE error 帧：HTTP 200 + `data:{"error":{code:"BAD_REQUEST",...}}`，断言同时接受 JSON 信封与 SSE error 帧） |
| 5 | 并发 BUSY 上限 | pending（契约 §5.4 允许跳过，避免占用资源） | — |

### 12.3 页面（page-check --v2 / click-panel --v2，截图 `verify/out/v2-*.png`）

| # | 断言 | 结果 | 证据 |
|---|---|---|---|
| 1 | 合并按钮存在且可点（非 disabled） | PASS | `[data-action="merge"]` text=合并 @ (1490,10) 92×32，disabled=false |
| 2 | 合并弹层字段：方式三选 / 删除分支 / 风险提示 / repo#number / head→base / headSha | PASS | `data-merge-phase=idle`；方式 squash/merge/rebase；`[data-merge-delete=toggle]` 未勾选；风险提示「这是写操作：会真的在 GitHub 上合并这个 PR。」；repo `Acefake/s-skills #18`；目标 `add-gitattributes-lf → main`；head `9a80d3b` |
| 3 | **点「取消」后弹层关闭且无 `/codex-review/merge` 请求、PR 未变** | PASS | 弹层 open→false；`mergeRequestsAfterCancel=0`；PR 详情文本长度不变（1200→1200） |
| 4 | 底部输入框 placeholder=「就此 Pull Request 提问」 | PASS | `textarea.cr-composer-input` placeholder=就此 Pull Request 提问 |
| 5 | 发送「总结这个 PR 的改动」→ user 气泡 + 流式 assistant 气泡最终非空 + 停止按钮 | PASS | user 气泡 1 个（「总结这个 PR 的改动」）、assistant 气泡最终 547–800 字；流式期间捕获停止按钮并截图 `v2-chat-streaming.png` |
| 6 | 对话无 error 气泡；`Esc` 关闭面板；历史按 PR 持久化 | PASS | 无 error；Esc 后 panel open=false；`localStorage["codex-review:chat:Acefake/s-skills#18"]` 含 2 条消息（user+assistant） |
| 7 | 切换 PR 后对话历史隔离 | pending（当前 open PR 仅 1 个，无法切换；按 PR 的 localStorage key 已验证） | — |
| 8 | 页面流程 console.error / pageerror = 0 | PASS | 0 / 0，无 slot crash |

截图：`verify/out/v2-merge-dialog.png`（弹层字段/风险提示）、`v2-merge-cancel.png`（取消后无写入）、
`v2-chat-streaming.png`（流式气泡+停止按钮）、`v2-chat-done.png`（完成态回答）、`v2-chat-closed.png`（Esc 关闭）、`v2-page-check.png`。

### 12.4 v2 观察项（无阻塞缺陷）

| # | 严重度 | 说明 |
|---|---|---|
| O1 | P3（验证边界） | 并发 BUSY 上限按契约 §5.4 跳过实测（避免占用两个并发流）；单测已覆盖 limiter |
| O2 | P3（数据） | 当前真实 open PR 仅 1 个（仓库活动），「切换 PR 后历史隔离」无法实测，pending；按 PR 的 localStorage key 与消息内容已验证 |
| O3 | P3（数据） | #129 已合并，UI 列表只查 `is:open` 故无法从页面验证「已合并→合并按钮 disabled」；API 层已用 `MERGE_NOT_ALLOWED` 覆盖该守卫 |
| O4 | P3（实现说明） | chat 参数校验错误以 SSE error 帧（HTTP 200 + `data:{"error":...}`）返回，符合契约 §5.2 帧格式；断言同时接受 JSON 信封与 SSE error 帧 |
| O5 | P3（成本） | 真实 chat 回答约 1–2s、~0.5–0.8KB 文本；每次提问会真实调用一次模型（预期行为） |

**v2 判定：PASS（合并守卫 7/7、chat 4/4 + 1 pending、页面 7/7 + 1 pending、0 console/pageerror、0 merge 请求）。**
**v1/v1.1 回归同时全绿**：默认 api-probe 43/43（`api-probe-v1-final-v2.json`）、page-check 0 console error（`page-check-v1-final-v2.json`）、click-panel 8/8（`click-panel-v1-final-v2.json`）。

## 13. v2.1 验收章节（CONTRACT §6.5：自动审查）

> **状态：PASS（0.5.0 复跑；`api-probe --v21` = 58 通过 / 0 失败 / 0 pending；`page-check --v21` = 4/4；`click-panel --v21` = 17 通过 / 0 失败 / 1 pending=toast 条件不满足）**
> 旧 3 项 pending 的关闭证据见 §13.4：① 0.5.0 状态文件新增 `recent`，重载插件后仍在；② 清除 seen 游标后 force cycle 真实重审了 #141/#139 并产生新结果；③ `/pr` 返回顶层 `headSha`，探针已改读并断言未变。
> 证据：`api-probe-v21-final.json`（58/0/0）、`page-check-v21-final.json`（4/4）、`click-panel-v21-final.json`（17/0/1）、
> 截图 `verify/out/v21-*.png`（含 `v21-badge.png`）；旧一轮证据保留在 `verify/out/archive-v21/`。
> **安全**：全程无 GitHub 写操作（PR state/评论数/headSha 前后一致）；测试后 `enabled=false` 且状态文件恢复默认（finally 强制）；未 cancel 任何 job、未真实合并、未发布评论。

### 13.1 路由/数据断言（api-probe --v21，Host 0.4.0）

| # | 断言 | 结果 | 证据 |
|---|---|---|---|
| 1 | v2.1 路由就绪（status 返回 JSON 信封） | **PASS** | health version=0.4.0；status/config/run 均合法信封 |
| 2 | status 默认结构：config 默认值 / running=false / recent 数组 / seenCount≥0 | **PASS** | 先归一化默认配置后：enabled=false、interval=180、query=`is:open author:@me`、depth=fast、P2、includeDrafts=false、maxPerCycle=2；running=false；recent 结构合法（受 operator smoke 影响长度可为 0..20） |
| 3 | config 夹取：interval 30→60、maxPerCycle 99→5、非法 depth 回退 fast、未知字段忽略 | **PASS** | 回显 `{intervalSeconds:60, maxPerCycle:5, depth:'fast', enabled:true}`，`unknownKey` 不在 config |
| 4 | config 状态文件持久化 | **PASS** | 只读校验 `~/.dsh/codex-review/auto-review.json`（profile 回退路径）config 与回显一致 |
| 5 | run {force:false} + disabled → started:false + reason | **PASS** | `{started:false, reason:"自动审查已关闭（可带 force:true 单次运行）"}` |
| 6 | run {force:true} → cycle 结束（running=false）且 recent 有 done | **PASS** | 0.5.0 复跑：force cycle 重审了 #141（12 findings）与 #139（13 findings），recent 3 条（另含 sanguo#16），status.running=false |
| 7 | 第二次 force → seen 命中（recent 不增加） | **PASS** | 第二次 started:true，recent 0→0 不增加，cycle 快速结束 |
| 8 | 安全：cycle 前后 PR state/评论数/headSha 不变（无 GitHub 写） | **PASS** | state `open→open`、headSha 前后一致（探针改读 `/pr` 顶层 `headSha`）、comments total/inline 不变 |
| 9 | 测试后 enabled 恢复 false（status + 状态文件） | **PASS** | 最终 config 全默认（enabled=false/interval=180/maxPerCycle=2），状态文件同步恢复 |

### 13.2 页面（page-check --v21 / click-panel --v21，截图 `verify/out/v21-*.png`）

| # | 断言 | 结果 | 证据 |
|---|---|---|---|
| 1 | 自动审查设置区存在（开关 + interval/depth/threshold/drafts/maxPerCycle/query） | **PASS** | `[data-auto-settings="ready"]`；开关 `[data-auto-enabled="toggle"]`；interval 预设/depth/threshold/drafts/max/query 控件齐全 |
| 2 | 开关切换发出 auto-review-config 请求且 patch.enabled=true，回显生效 | **PASS** | Network 捕获 `POST /codex-review/auto-review-config`，body patch.enabled=true；随后 status.config.enabled=true |
| 3 | 右栏自动审查卡存在（状态/上次/下次/最近/立即检查） | **PASS** | `[data-cr-autoreview="ready"]`，含 enabled/running/recent 状态与「立即检查」按钮 |
| 4 | 立即检查发出 auto-review-run 请求 force=true，cycle 结束 | **PASS** | Network 捕获 `POST /codex-review/auto-review-run {force:true}`；轮询至 running=false |
| 5 | 状态卡 recent 显示 done 结果 | **PENDING** | 本轮无新增审查（open PR 均已在 seen）+ recent 未持久化缺陷（D1/D2） |
| 6 | 自动审查完成 toast 出现 | **PENDING** | 同上，无新 done 结果不触发 toast |
| 7 | PR 行「已自动审查」徽章 | **PENDING** | 同上，recent 为空无徽章数据源 |
| 8 | 关闭后 status.config.enabled=false | **PASS** | 关闭后 status config enabled=false，截图 `v21-disabled.png` |
| 9 | 页面流程 console.error / pageerror = 0 | **PASS** | 0 / 0，无 slot crash |

页面检查（`page-check --v21`）：右栏自动审查卡存在、设置区存在、console/pageerror=0，**4/4 PASS**。

### 13.3 缺陷 / 待复跑项（0.5.0 已全部关闭）

| # | 严重度 | 状态 | 说明 |
|---|---|---|---|
| D1 | P2（实现缺陷） | **已修复并验证** | 0.5.0 把 `recent`（≤20 条）与 `published` 记录一起原子持久化到状态文件；重载插件后 `/auto-review-status.recent` 仍返回 3 条 |
| D2 | P3（环境数据） | **已消除** | 验收前备份状态文件并清除 `#141`/`#139` 的 seen 游标，force cycle 真实重审（#141 12 findings、#139 13 findings）；之后第二轮 force 命中 seen、recent 不增加 |
| D3 | P3（接口限制） | **已消除** | 0.5.0 `/pr` 返回顶层 `headSha`；探针改读该字段，断言 cycle 前后未变（`PrDetail` 字段未变，属于既有返回） |

### 13.4 0.5.0 复跑结果（2026-10-24 23:59，旧 3 项 pending 全部关闭）

| 旧 pending | 关闭证据 | 结果 |
|---|---|---|
| recent 未持久化 | 状态文件含 `recent`；force cycle 产生结果后 disable→enable 重载，status.recent 仍返回 3 条 | **PASS** |
| 所有 PR 已在 seen，force cycle no-op | 清除 seen 后真实重审 #141/#139；第二轮 force 命中 seen、recent 不变 | **PASS** |
| PrDetail 无 headSha | 探针改读顶层 `headSha`，cycle 前后一致 | **PASS** |

- `api-probe --v21`：**58 通过 / 0 失败 / 0 pending**（`api-probe-v21-final.json`）。
- `page-check --v21`：**4/4 PASS**（`page-check-v21-final.json`、`v21-page-check-final.png`）。
- `click-panel --v21`：**17 通过 / 0 失败 / 1 pending**（`click-panel-v21-final.json`+`v21-badge.png`）。pending =「自动审查完成 toast」：本轮 force cycle 无新增结果（open PR 均已在 seen），toast 无数据源，属环境条件不满足。
- 观察（非缺陷）：auto-review cycle 会审查查询结果中其它仓库的 open PR（`Acefake/sanguo#16`，fast 深度约 5 分钟）——契约允许；页面装置原先对此类长审查等待窗口不足会误判失败，已改为记 pending 并注明由 `api-probe --v21` 长超时覆盖。为防止真正的 hung 调用永久锁死调度，0.5.0 增加了 cycle 看门狗（10 分钟；超时记 `lastError`、释放 `running`、下一轮可继续，单测覆盖）。

**v2.1 判定：PASS（58/58 路由断言 + 页面 17/17 + 1 环境 pending + 0 console/pageerror）。**

## 14. v2.2 验收章节（CONTRACT §7.4：发布审查到 GitHub）— **PASS**

> **状态：PASS（2026-10-25 00:03 复跑；Host 0.5.0 已生效；client.js 冻结 mtime 22:34:41 / 353533B；插件经 profile 热重载启用）**
> 证据：`api-probe-v22.json`（42 断言全过；`report.v22.safety` = requests 6 / sent 6 / sentConfirm 4 / **unsafe 0** / ungated 0 / **published 0**）、
> `page-check-v22.json`（4/4）、`click-panel-v22.json`（20 通过 / 0 失败 / 1 pending）、截图 `v22-page-check.png`、`v22-publish-dialog.png`、`v22-publish-cancel.png`、`v22-auto-publish-confirm.png`。
> **安全**：全程**没有对真实 PR 发布任何 review**；每个 `confirm:true` 请求发送前都先 `POST /pr` 过 `review.state !== 'done'` gate，只命中参数校验分支或 `REVIEW_NOT_READY`；PR state / headSha / 评论数前后一致。

### 14.1 路由断言（`api-probe --skip-ai --v22`，0 fail / 0 pending）

| # | 断言 | 结果 | 证据 |
|---|---|---|---|
| 1 | 路由就绪：`review-publish` 返回合法 JSON 信封（未安装时按既有约定退出 3 / pending） | PASS | 缺 confirm → `BAD_REQUEST` |
| 2 | `confirm:false` / 缺 `confirm` → `BAD_REQUEST`，message 含 confirm | PASS | 2 条 |
| 3 | 非法 `mode` / 非法 `minSeverity` / `body>4000` → `BAD_REQUEST`（发送前过 gate） | PASS | 3 条 |
| 4 | 当前 head 无 done 审查 → `REVIEW_NOT_READY`，且该 PR 评论数未变 | PASS | 当时目标 `Acefake/yingbox#141`（`review.state=none`） |
| 5 | 安全计数器：`unsafe=0`、`ungated=0`、`published=0`，每个 `confirm:true` 都有 gate 记录 | PASS | `report.v22.safety` |

### 14.2 页面（`page-check --v22` 4/4；`click-panel --v22` 20 通过 / 0 失败 / 1 pending）

| # | 断言 | 结果 | 证据 |
|---|---|---|---|
| 1 | 工作台渲染 `[data-cr-publish-supported]`，设置弹层含自动发布区 | PASS | `v22-page-check.png` |
| 2 | 审查完成（#141 12 findings）时出现「发布到 GitHub」；弹层含 repo#number / 已审查 head / 预计评论数 / mode 三选 / minSeverity 三选 / 写操作风险提示 | PASS | `v22-publish-dialog.png` |
| 3 | 改选 summary + P0 生效；点「取消」→ 弹层关闭，**Network 0 个 `/codex-review/review-publish` 请求** | PASS | `v22-publish-cancel.png`、`publishRequestsAfterCancel=0` |
| 4 | 设置弹层自动发布开关 → 二次确认块 → 点取消 → 未开启，**0 个 `publish.enabled=true` 请求**，状态标签与 Host 一致 | PASS（1 pending=状态标签可见性） | `v22-auto-publish-confirm.png`、`autoPublishEnableRequests=0` |
| 5 | 页面流程 console.error / pageerror = 0 | PASS | 报告字段 |

### 14.3 本轮发现并修复的缺陷（v2.2）

| # | 严重度 | 状态 | 说明 |
|---|---|---|---|
| R1 | **P1（功能不可用）** | 已修复 | `/auto-review-status` 只在 `config.publish` 下发发布配置，client 读顶层 `status.publish` → `publishSupported=false`，**发布按钮与自动发布设置区完全不渲染**。修复：Host 顶层同时返回 `publish`（保留 `config.publish`），CONTRACT §6.3/§7.1 同步，单测锁定。 |
| R2 | P2（幂等） | 已修复 | 同一 head 并发发布可能创建两条 GitHub review。修复：`ReviewPublisher` in-flight 去重（同 head 共享 Promise），单测断言 `createPullReview` 仅 1 次。 |
| R3 | P3（展示一致性） | 已修复 | 「已发布」徽章只存在于单次会话内存，刷新即丢。修复：`/pr` 的 review 快照回填持久化 `published` 记录（含 headSha），单测覆盖。 |
| R4 | P2（调度健壮性） | 已修复（预防性） | 很长的审查（如 `sanguo#16` fast 约 5 分钟）会让 `running` 长时间为 true；若底层调用真正挂起将永久锁死调度。修复：cycle 看门狗（默认 10 分钟，超时记 `lastError`、释放 `running`、下一轮可继续，旧 cycle 在下一个边界自行停止），单测覆盖。 |

### 14.4 已知限制

- 发布需要 GitHub token `repo` 写权限；finding 的 `line` 必须落在 diff 的 RIGHT 行，GitHub 对越界行会拒绝整条 review（回显 `BAD_REQUEST`）。
- 发布记录按 head SHA 存本机状态文件，多机不同步；同一 head 重复发布只回放记录，不会更新已有 review。
- 自动发布默认关闭；本轮**未做真实发布**（避免在用户 PR 上产生未经请求的评论），真实发布路径由单测覆盖。
- `click-panel --v22` 的「自动发布状态标签」pending：右栏自动审查卡在该轮不在可视流内；设置区开关与二次确认已单独 PASS。

**v2.2 判定：PASS（42 路由断言全过 + 页面 24/24 + 1 可见性 pending + 0 console/pageerror + 0 真实写）。**

### 14.5 0.5.1 扩展：手动审查也会自动发布（2026-10-25 00:50）

用户要求「AI 审查完成后自动把结果提交到 PR」。0.5.1 把 `publish.enabled` 从「只覆盖自动审查 cycle」扩展为**同时覆盖手动 `review-start`**：

- Host 在手动审查 job `done` 后后台自动调用同一发布流程：fire-and-forget，不阻塞审查路由；发布前重新读取开关（审查期间关掉则不发布）；失败只记 Host 日志，不影响审查结果；同一 head 仍只发布一次。
- `/review-status` 在已发布时回填 `published`（同 `/pr` 的 `review.published`），工作台审查卡轮询完成后即可显示「已发布 · 在 GitHub 查看」。
- 设置区文案更新为「AI 审查（手动或自动）完成后自动发布」；开关仍默认关闭、需二次确认。
- 验证：`node --test` **231/231**（新增 2 条：开关开启时手动审查完成会发布一次且参数取自配置；`review-status` 带 published 记录）。**验证过程未做真实发布**（保持红线），真实发布由用户下一次审查触发。
- 当前本机配置：`publish.enabled=true`、`mode=inline`、`minSeverity=P2`、`maxComments=20`；自动审查本身仍关闭（`enabled=false`）。

## 附录 A · 复跑命令（同 §2 / README §4.6–§4.9）与判定速查

- 退出码 0 通过 / 1 断言失败 / 2 装置或认证 / 3 路由未就绪（reload 窗口稍等重跑）。
- AI 终态关键字段：`review-status.state==="done"`、`partial!==true`、`findings[]` 每条 schema 合法；
  UI 卡片不得出现「部分结果」「审查失败」。
