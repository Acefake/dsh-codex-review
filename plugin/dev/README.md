# 开发预览装置（dev-only，不进安装包）

这套文件让「代码审查」工作台不用安装 DSH、不用起 Host 就能真实渲染和截图。
它加载的**就是** `plugin/client.js`（磁盘上的同一份文件），只是用下面的桩替代宿主：

- `preview.html`：窗口外壳（标题栏 / 左侧 rails 都是**预览专用**，真实 DSH 由宿主提供）、
  `--dsw-alias-*` 主题 token（深色 = 从 Codex 参考截图实测的配色，浅色为同构浅色值）、
  `window.__ModuleLoader__` 桩、`ctx.locale` / `ctx.slots` 桩、场景驱动脚本。
- `serve.mjs`：零依赖静态服务 + 与 Host 同名同信封（`{ok,value}` / `{ok:false,error}`）的
  mock 路由：`/codex-review/health|prs|pr|review-start|review-status|review-cancel`。
- `mock/*.json`：由 `build-mocks.mjs` 从 `recon/probe-output.json`（真实 `gh` 抓取）归一化成
  CONTRACT.md §1.2 的形状；`review-*.json` 是 done / running / error / empty 四种审查终态。
- `build-mocks.mjs`：重新生成 mock；findings 的行号从真实 patch 的新增行里取，保证能定位到 diff。
- `loader-stub.mjs`：在 Node 里按 `window.__ModuleLoader__.load({id, factory})` 语义加载 bundle
  （React 用极简桩），供 `plugin/test/client-utils.test.js` 使用。
- `check-preview.mjs`：用 Edge + CDP 跑场景，断言无 console error / 无未捕获异常，
  并量出三栏宽度（238 / 760 / 300）、列表行数、diff 行数、审查状态；v1.1 追加
  verdict / 过滤 chips / options+guidelines+reusedFiles 行 / 行内 finding 卡展开 /
  设置弹层 / 已有评论 / `j` `/` `Esc` 键盘断言。
- `shots.mjs`：用同一套 CDP 装置给全部场景出图（1600×1100），一次重建 `shots/`。
- `vendor/react/`：React 18.3.1 UMD（dev-only，见该目录 README 的来源说明）。
- `shots/`：默认态、Changes、审查结果、运行中、错误、空列表、浅色、部分完成，
  以及 v1.1 的行内 finding 卡 / 设置弹层 / 已有评论。

## 跑起来

```bash
node plugin/dev/build-mocks.mjs          # 需要 recon/probe-output.json，已生成的 mock 已入库
node plugin/dev/serve.mjs --port 4317    # http://127.0.0.1:4317/
node plugin/dev/check-preview.mjs        # 无头校验（另开一个终端）
node plugin/dev/shots.mjs                # 重出全部截图（另开一个终端）
```

## 场景

| URL | 内容 |
|---|---|
| `/?scene=default` | PR #129 选中 + Summary（对应 Codex 参考截图） |
| `/?scene=changes` | Changes：展开两个文件，展示统一 diff |
| `/?scene=review` | AI 审查 done：verdict 徽章 / P0-P2 计数 / 过滤 chips / options+guidelines+reusedFiles / 三段式 findings |
| `/?scene=partial` | 部分完成的审查：partial 徽章 + partialReasons + 截断次数（deep 预算回显） |
| `/?scene=running` | 审查中：阶段 + 已分析 n/m + 计时 + 取消 |
| `/?scene=error` | 审查失败：错误码 + 人话 + 重试（guidelines 降级态） |
| `/?scene=empty` | 搜索无结果的空列表态 |
| `/?scene=health` | gh 未登录提示条 |
| `/?scene=v11-inline-findings` | 审查后点「定位到 diff」：Changes 展开文件、行高亮、行内 finding 卡展开 |
| `/?scene=v11-settings` | 齿轮审查设置弹层（depth / severityThreshold / includeGuidelines） |
| `/?scene=v11-existing-comments` | 已有 GitHub 行内评论卡（含 >400 字截断与文件级评论） |
| `&theme=light` | 浅色主题（验证 token 双主题可用） |

```bash
# 单张截图（Edge / Chromium headless）
"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --headless=new --disable-gpu \
  --force-device-scale-factor=1 --window-size=1600,1100 --virtual-time-budget=12000 \
  --screenshot=C:\Users\10228\dsh-codex-review\plugin\dev\shots\01-default.png \
  "http://127.0.0.1:4317/?scene=default"
```

## 注意

- mock 的审查流程：`review-start` 里多带一个 `mockMode`（preview 的 fetch 包装注入，真实 Host 不看这个字段），
  mock server 据此返回 running / done / empty / error / partial。
- 设置弹层写入 `localStorage['codex-review:settings']`，`review-start` 会带 `options`
  （depth / severityThreshold / includeGuidelines）；mock server 按深度预设回显
  `chunkChars / maxChunks / concurrency`，并演示 `cached: true`。
- `v11-existing-comments` 场景由 preview 在 `/codex-review/pr` 请求里注入
  `mockScenario: 'comments'`，serve.mjs 据此返回 `mock/pr-129-comments.json`。
- `POST /codex-review/dev-reset` 清空 mock 的 job 缓存；`shots.mjs` 每张图前都会调用，
  避免上一场景的 `cached` toast 留在截图里（dev-only 路由，真实 Host 没有）。
- 预览页的标题栏、左侧图标 rails、`PREVIEW` 角标只存在于 `preview.html`，`client.js` 不渲染它们。
- `mock/`、`vendor/`、`shots/`、本文件都不应进入安装包 `files`（Host 侧 package.json 负责）。
