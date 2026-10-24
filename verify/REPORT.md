# dsh-codex-review · 端到端验收报告

> **状态：模板（待执行填充）**
> 插件安装完成后，按 §附录 A 依次运行命令，把真实输出/退出码/截图路径填入
> §1–§7，最后给出 §9 结论。JSON 证据字段名与本模板一一对应，可直接摘录。
>
> 填完后删除本「模板」提示，并把「状态」改为 `PASS` / `FAIL`。

- 生成时间：`{{待填：YYYY-MM-DD HH:mm}}`
- 执行人：`{{待填：verifier / lead}}`
- 装置版本：`verify/`（README 同目录，2026-10-24）
- 插件路径：`C:\Users\10228\dsh-codex-review\plugin`
- 插件版本：`{{待填：package.json version}}`
- 安装方式：`{{待填：plugin_manager install_bundle <spec>，application/生效信息}}`
- DSH Web GUI：`http://127.0.0.1:2632`（profile：desktop）
- 宿主是否重启：`{{待填：未重启 / 已重启（原因）}}`
- 认证方式：`{{待填：local-credentials / launch-token}}`
- 模型（AI 审查）：`{{待填：provider / model}}`

---

## 1. 结论摘要

| # | 验收项 | 期望 | 实际 | 证据 | 判定 |
|---|---|---|---|---|---|
| 1 | 插件安装生效 | 插件管理器出现「代码审查」，左栏出现入口 | `{{待填}}` | `{{截图/安装返回}}` | `{{PASS/FAIL}}` |
| 2 | `api-probe.mjs` 全量 | 退出码 0，全部断言通过 | `{{退出码、通过数/总数}}` | `{{report 路径}}` | `{{}}` |
| 3 | `health` | `ok:true`，gh/llm/version 合法 | `{{gh=? llm=? version=?}}` | `report.routes.health` | `{{}}` |
| 4 | `prs` | ≥20 条且字段形状合法 | `{{count=? totalCount=?}}` | `report.routes.prs` | `{{}}` |
| 5 | `pr` Acefake/yingbox#129 | 24 文件、body 非空、stack 含 #117 | `{{files=? bodyLen=? chain=?}}` | `report.routes.pr` | `{{}}` |
| 6 | AI 审查 | `review-start`→`review-status` 终态 `done`，findings schema 合法 | `{{jobId=? 耗时=? findings=?}}` | `report.routes.review` | `{{}}` |
| 7 | `review-cancel` | 合法信封，`cancelled` 布尔 | `{{cancelled=?}}` | `report.routes.reviewCancel` | `{{}}` |
| 8 | 页面检查 | 无 console.error / pageerror | `{{consoleErrors=? pageErrors=?}}` | `baseline/或 out/…page-check*.json` | `{{}}` |
| 9 | 点击左栏入口 | 找到「代码审查」并点击成功 | `{{入口文本、坐标、targetSource}}` | `click-panel-*.json` | `{{}}` |
| 10 | 三栏工作台 | 列带 ≥3 / AI 审查文案命中 | `{{threeColumns=? bands=?}}` | `click-after-*.png` | `{{}}` |
| 11 | 视觉人工核对 | 对照 `recon/ui-spec.md`，无空白/错位/溢出 | `{{描述}}` | 截图 | `{{}}` |

**总体判定：`{{PASS / FAIL}}`**

---

## 2. 环境与命令

### 2.1 环境

| 项 | 值 |
|---|---|
| OS | Windows（`{{版本}}`） |
| Node | `{{node --version}}` |
| Edge | `{{msedge --version / Browser 字段}}` |
| gh | `{{gh --version / gh auth status 摘要}}` |
| 页面标题 | `{{page-check report.title}}` |
| 视口 | `{{width×height}}`（默认 1600×1100） |

### 2.2 执行命令与退出码

```powershell
$V = 'C:\Users\10228\dsh-codex-review\verify'

# A1 页面基线 / 插件安装后页面检查
node $V\page-check.mjs --out-dir $V\out --shot gui-after-install.png --report page-check-after-install.json
# A2 插件路由契约（真实 AI 审查一次）
node $V\api-probe.mjs --report $V\out\api-probe.json
# A3 点击左栏入口 + 三栏工作台
node $V\click-panel.mjs --out-dir $V\out --before click-before.png --after click-after.png --report click-panel.json
```

| 步骤 | 退出码 | 备注 |
|---|---|---|
| A1 page-check | `{{}}` | `{{}}` |
| A2 api-probe | `{{}}` | `{{}}` |
| A3 click-panel | `{{}}` | `{{}}` |

---

## 3. API 契约结果（`verify/out/api-probe.json`）

### 3.1 关键数字

| 项 | 值 |
|---|---|
| `routesReady` | `{{true/false}}` |
| 断言总数 / 通过 | `{{n}} / {{m}}` |
| prs 条数（期望 ≥20） | `{{}}` |
| pr 文件数（期望 24） | `{{}}` |
| pr body 长度 | `{{}}` |
| stack 链 PR 编号 | `{{[117, ...]}}` |
| 审查 jobId / headSha | `{{}} / {{}}` |
| 审查终态 / 耗时 / 轮询次数 | `{{done}} / {{ms}} / {{n}}` |
| findings 数量 / overview | `{{}} / {{}}` |
| 模型 | `{{provider / model}}` |
| cancel 返回 | `{{cancelled:false}}` |
| 信任围栏 3 项 | `{{通过/失败}}` |

### 3.2 断言明细

粘贴 `api-probe.mjs` stdout 的逐条 `✓/✗` 列表（或从 report `checks[]` 摘录）：

```
{{粘贴}}
```

失败断言及分析：`{{无 / 逐条说明}}`

---

## 4. 页面检查（`verify/out/page-check-after-install.json`）

| 项 | 值 |
|---|---|
| 标题 | `{{}}` |
| console.error 数 | `{{}}` |
| console.warning 数 | `{{}}` |
| pageerror 数 | `{{}}` |
| 失败请求数 | `{{}}` |
| 模态框 | `{{有无、如何关闭}}` |
| 左栏是否含「代码审查」 | `{{是/否，见 dom.sidebar}}` |
| 良性噪音 | `/api/experimental-inspector/bootstrap` 404（如仍出现，说明为 web profile 预期） |

console.error / pageerror 原文（若有，逐条给出并解释）：

```
{{粘贴}}
```

---

## 5. 点击入口与三栏工作台（`verify/out/click-panel.json`）

| 项 | 值 |
|---|---|
| 模态框清除方式 | `{{button/escape/backdrop/none}}` |
| 入口来源 | `{{sidebar-text / left-region-scan}}` |
| 命中元素 | `{{tag / aria / title / text}}` |
| 点击坐标 | `{{x, y}}` |
| 点击后页面变化 | `{{bodyText a→b；列带 before→after}}` |
| 三栏列带 | `{{bands}}` |
| AI 审查文案命中 | `{{true/false}}` |
| slot entry crashed | `{{false}}` |
| 截图 | `click-before.png` / `click-after.png` |

人工核对（对照 `recon/ui-spec.md` 与用户提供的 Codex 截图）：

- 左栏列表：`{{搜索框/PR 条目/选中态}}`
- 中间：`{{Summary/Changes、PR 头、diff 渲染}}`
- 右栏：`{{Changes/Stack/Comments/Reviewers/Checks/AI 审查}}`
- 与规格差异/缺陷：`{{逐条}}`

---

## 6. AI 审查端到端证据

| 项 | 值 |
|---|---|
| 触发按钮 | 右栏「用 AI 审查」`{{成功/未测}}` |
| 进度阶段可见 | `{{preparing→reviewing→done}}` |
| 终态 | `{{done}}` |
| findings 渲染 | `{{0 条 / N 条；截图}}` |
| finding 点击定位 diff | `{{成功/未测}}` |
| 取消按钮 | `{{未测/成功}}` |
| 截图 | `{{ai-review-done.png}}` |

---

## 7. 截图证据清单

| 文件 | 说明 | 人工检查 |
|---|---|---|
| `verify/baseline/baseline-gui.png` | 插件安装前基线（装置自证） | 已核对 |
| `verify/out/gui-after-install.png` | 安装后页面 + 左栏入口 | `{{}}` |
| `verify/out/click-before.png` | 点击前（入口可见） | `{{}}` |
| `verify/out/click-after.png` | 点击后三栏工作台 | `{{}}` |
| `verify/out/{{ai-review-done.png}}` | AI 审查结果态 | `{{}}` |
| `verify/out/{{changes-view.png}}` | Changes diff 态 | `{{}}` |

---

## 8. 已知限制与风险

- **AI 审查非确定性**：同一 PR 可能返回不同 findings，甚至 0 条；断言只校验 schema 与终态。
- **一次模型调用成本**：`api-probe` 默认执行一次；只读场景用 `--skip-ai`。
- **三栏判定是启发式**：列带 + 文案信号，视觉正确性仍需人眼核对截图。
- **无 CI checks / 无评论**：目标 PR 可能本来就没有 checks、comments，属数据实际状态。
- **GUI 文案依赖**：入口按文本「代码审查」（别名含 `Code Review`）匹配；若本地化文案不同，用 `--target` 指定。
- **认证依赖本机凭据**：cookie 由 `client-connection/browser-session` 签名密钥 mint（只读）；若 DSH 升级改变该格式，需改用 `--token`。
- `{{其它本次发现的问题}}`

---

## 9. 最终结论

- **判定：`{{PASS / FAIL}}`**
- **用户可见变化**：刷新 `http://127.0.0.1:2632` 后，左栏（「新会话」下方）出现「代码审查」；
  点开后中间为三栏 PR 审查工作台，真实数据来自 `Acefake/yingbox`，右栏可发起 AI 审查。
- 未解决的问题 / 需要用户操作：`{{无 / 如需重启宿主：…}}`

---

## 附录 A · 执行顺序（复制即用）

```powershell
$V = 'C:\Users\10228\dsh-codex-review\verify'

# 0) 确认插件已安装：插件管理器出现「代码审查」；路由就绪探测（不跑 AI）
node $V\api-probe.mjs --skip-ai --out-dir $V\out

# 1) 全量契约（含一次 AI 审查）
node $V\api-probe.mjs --out-dir $V\out --report api-probe.json

# 2) 页面检查（安装后）
node $V\page-check.mjs --out-dir $V\out --shot gui-after-install.png --report page-check-after-install.json

# 3) 点击入口 + 三栏
node $V\click-panel.mjs --out-dir $V\out --before click-before.png --after click-after.png --report click-panel.json
```

## 附录 B · 判读速查

- 退出码 `3`：插件未装/未加载（路由 405/404）→ 先安装，再重跑；
- 退出码 `2`：装置/认证/浏览器问题 → 看 stderr，尝试 `--token`；
- `api-probe` 失败项看 `checks[]` 中 `pass:false` 的 `name/detail`；
- `click-panel` 找不到入口：看 stdout 左栏候选按钮（text/aria/title/rect）；
- 三栏未检出但截图正常：属启发式误判，人工确认后记录在 §5。
