#!/usr/bin/env node
/**
 * Click the plugin's left-sidebar entry ("代码审查") and verify that the
 * three-column review workbench renders.
 *
 *   node verify/click-panel.mjs --out-dir verify/out
 *
 * Flow: launch headless Edge → open the DSH Web GUI with the browser-session
 * cookie → wait for the SPA sidebar → dismiss the "预览版说明" first-run modal
 * (click 继续, else Escape, else backdrop) → find the sidebar row by *text*
 * (aria-label independent, per the DSH sidebar contract) → click its center with
 * real CDP mouse events → wait for network idle + a settle window → capture a
 * screenshot → report console errors / page errors / workbench geometry.
 *
 * When the click target is missing, the report and stdout include every sidebar
 * candidate's text/aria/title/rectangle so the plugin's DOM can be fixed without
 * guessing.
 *
 * Exit codes: 0 all checks pass, 1 verification failed, 2 harness/environment
 * error. Use `--expect click` to self-test the harness against an existing
 * sidebar row (e.g. `--target 插件`).
 */
import { parseArgs } from 'node:util'
import { statSync } from 'node:fs'
import path from 'node:path'
import { launchBrowser, PageSession } from './lib/cdp.mjs'
import { GuiClient } from './lib/gui.mjs'
import {
  dialogState,
  findClickableInSidebar,
  findSidebarTargets,
  interactiveSnapshot,
  layoutProbe,
  pageState,
  workbenchProbe,
} from './lib/dom.mjs'
import {
  diffFindingProbe,
  expandedFindingProbe,
  findPrRow,
  inlineCommentProbe,
  keyboardState,
  pressableByText,
  reviewMetaProbe,
  scrollToElement,
  settingsPopoverProbe,
  v11Surface,
} from './lib/v11-dom.mjs'
import {
  chatInputTarget,
  chatPanelProbe,
  chatSendTarget,
  chatStorageProbe,
  mergeDialogProbe,
  v2Surface,
} from './lib/v2-dom.mjs'
import {
  autoCardProbe,
  autoSettingsProbe,
  autoToggleTarget,
  prBadgeProbe,
  toastProbe,
  v21Surface,
} from './lib/v21-dom.mjs'
import {
  autoPublishProbe,
  autoPublishStatusProbe,
  autoPublishToggleTarget,
  publishCancelTarget,
  publishDialogProbe,
  publishMinTarget,
  publishModeTarget,
  publishTriggerTarget,
  v22Surface,
} from './lib/v22-dom.mjs'
import {
  cookieForUrl,
  EXIT,
  fail,
  isoTimestamp,
  OUT_ROOT,
  scratchDir,
  timestampForFile,
  writeJson,
} from './lib/util.mjs'

const DEFAULT_TARGETS = ['代码审查', 'Code Review', 'codex-review']
const DISMISS_KEYWORDS = ['继续', '知道了', '我知道了', '开始使用', '确定', '关闭', 'Continue', 'Got it', 'Dismiss', 'Close', 'OK']

const USAGE = `用法: node verify/click-panel.mjs [选项]

选项:
  --url <url>             目标页面（默认 http://127.0.0.1:2632）
  --target <text>         左栏入口文本，逗号分隔可给多个别名（默认 "代码审查,Code Review,codex-review"）
  --out-dir <dir>         截图与报告目录（默认 verify/out）
  --before <png>          点击前截图文件名（默认 click-before-<时间>.png）
  --after <png>           点击后截图文件名（默认 click-after-<时间>.png）
  --report <json>         报告文件名（默认 click-panel-<时间>.json）
  --width <px>            视口宽度（默认 1600）
  --height <px>           视口高度（默认 1100）
  --wait-ms <ms>          点击后网络空闲再等待的稳定时间（默认 1800）
  --timeout-ms <ms>       导航超时（默认 45000）
  --expect <mode>         workbench（默认，要求三栏工作台）| click（只要求点击生效，用于自检装置）
  --v11                   启用 v1.1 页面断言：Changes diff finding 卡、行内评论、设置弹层、j/k/r// 键盘
  --v11-select <text>     v1.1 finding 断言使用的 PR（列表标题包含该文本，默认 "自动检测片头片尾" = #129）
  --v11-inline-select <text> 行内评论断言指定的 PR（默认自动挑一个有 inline 评论的 PR）
  --v11-skip-review-key   v1.1 跳过键盘 r 的真实 review-start（避免与 Lead 冒烟抢 job）
  --v2                    启用 v2 页面断言：合并弹层字段/取消不写入、PR 对话流式面板、历史隔离、v2-*.png
  --v2-select <text>      v2 断言使用的 PR 列表标题关键字（默认用当前自动选中的 open PR）
  --v21                   启用 v2.1 页面断言：自动审查设置区/开关 config 请求/立即检查/状态卡/徽章/toast、v21-*.png
  --v22                   启用 v2.2 页面断言：发布弹层字段/取消（0 发布请求）、自动发布二次确认/取消、v22-*.png
  --token <token>         DSH 启动 URL 里的 token（不传则用本机凭据自动认证）
  --no-auth               不注入 DSH 浏览器会话 cookie
  --headful               有窗口模式启动 Edge
  --allow-console-errors  存在 console/page error 时仍以 0 退出（报告仍记录）
  --json                  只输出 JSON 摘要
  -h, --help              显示本帮助`

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function parseCli() {
  let parsed
  try {
    parsed = parseArgs({
      allowPositionals: false,
      options: {
        url: { type: 'string', default: process.env.DSH_WEB_URL ?? 'http://127.0.0.1:2632' },
        target: { type: 'string', default: DEFAULT_TARGETS.join(',') },
        'out-dir': { type: 'string', default: OUT_ROOT },
        before: { type: 'string' },
        after: { type: 'string' },
        report: { type: 'string' },
        width: { type: 'string', default: '1600' },
        height: { type: 'string', default: '1100' },
        'wait-ms': { type: 'string', default: '1800' },
        'timeout-ms': { type: 'string', default: '45000' },
        expect: { type: 'string', default: 'workbench' },
        v11: { type: 'boolean', default: false },
        'v11-select': { type: 'string', default: '自动检测片头片尾' },
        'v11-inline-select': { type: 'string', default: '' },
        'v11-skip-review-key': { type: 'boolean', default: false },
        v2: { type: 'boolean', default: false },
        'v2-select': { type: 'string', default: '' },
        v21: { type: 'boolean', default: false },
        v22: { type: 'boolean', default: false },
        token: { type: 'string' },
        'no-auth': { type: 'boolean', default: false },
        headful: { type: 'boolean', default: false },
        'allow-console-errors': { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    })
  } catch (error) {
    fail(`参数解析失败：${error.message}\n\n${USAGE}`, EXIT.ENV)
  }
  const { values } = parsed
  if (values.help) {
    console.log(USAGE)
    process.exit(EXIT.OK)
  }
  if (values.expect !== 'workbench' && values.expect !== 'click') {
    fail(`--expect 只能是 workbench 或 click，收到 ${JSON.stringify(values.expect)}`, EXIT.ENV)
  }
  const numeric = (name, fallback) => {
    const raw = values[name] ?? String(fallback)
    const value = Number(raw)
    if (!Number.isFinite(value) || value < 0) fail(`--${name} 必须是非负数字，收到 ${JSON.stringify(raw)}`, EXIT.ENV)
    return Math.round(value)
  }
  const outDir = path.resolve(values['out-dir'])
  const stamp = timestampForFile()
  const targets = String(values.target).split(',').map((item) => item.trim()).filter(Boolean)
  if (targets.length === 0) fail('--target 不能为空', EXIT.ENV)
  return {
    url: values.url,
    targets,
    outDir,
    beforePath: path.resolve(outDir, values.before ?? `click-before-${stamp}.png`),
    afterPath: path.resolve(outDir, values.after ?? `click-after-${stamp}.png`),
    reportPath: path.resolve(outDir, values.report ?? `click-panel-${stamp}.json`),
    width: numeric('width', 1600),
    height: numeric('height', 1100),
    waitMs: numeric('wait-ms', 1800),
    timeoutMs: numeric('timeout-ms', 45_000),
    expect: values.expect,
    v11: values.v11,
    v11Select: String(values['v11-select'] ?? '').trim(),
    v11InlineSelect: String(values['v11-inline-select'] ?? '').trim(),
    v11SkipReviewKey: values['v11-skip-review-key'],
    v2: values.v2,
    v2Select: String(values['v2-select'] ?? '').trim(),
    v21: values.v21,
    v21Paths: {
      settings: path.resolve(outDir, 'v21-settings.png'),
      autoReview: path.resolve(outDir, 'v21-auto-review.png'),
      toast: path.resolve(outDir, 'v21-toast.png'),
      badge: path.resolve(outDir, 'v21-badge.png'),
      disabled: path.resolve(outDir, 'v21-disabled.png'),
    },
    v22: values.v22,
    v22Paths: {
      dialog: path.resolve(outDir, 'v22-publish-dialog.png'),
      cancel: path.resolve(outDir, 'v22-publish-cancel.png'),
      autoPublish: path.resolve(outDir, 'v22-auto-publish-confirm.png'),
    },
    v2Paths: {
      mergeDialog: path.resolve(outDir, 'v2-merge-dialog.png'),
      mergeCancel: path.resolve(outDir, 'v2-merge-cancel.png'),
      chatStreaming: path.resolve(outDir, 'v2-chat-streaming.png'),
      chatDone: path.resolve(outDir, 'v2-chat-done.png'),
      chatClosed: path.resolve(outDir, 'v2-chat-closed.png'),
      chatIsolation: path.resolve(outDir, 'v2-chat-isolation.png'),
    },
    v11Paths: {
      workbench: path.resolve(outDir, 'v11-workbench.png'),
      changes: path.resolve(outDir, 'v11-changes.png'),
      finding: path.resolve(outDir, 'v11-finding-card.png'),
      inline: path.resolve(outDir, 'v11-inline-comments.png'),
      settings: path.resolve(outDir, 'v11-settings.png'),
      keyboard: path.resolve(outDir, 'v11-keyboard.png'),
    },
    token: values.token,
    noAuth: values['no-auth'],
    headful: values.headful,
    allowConsoleErrors: values['allow-console-errors'],
    jsonOnly: values.json,
  }
}

/**
 * Close the first-run modal. Order: matching dialog button → Escape →
 * backdrop click. Returns how it was dismissed plus every attempt.
 * @param {PageSession} page
 * @returns {Promise<{dismissed: boolean, by: string, attempts: Array<Record<string, unknown>>}>}
 */
async function dismissModals(page) {
  const attempts = []
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const state = await page.evaluate(dialogState())
    if (!state.hasDialog) return { dismissed: true, by: attempts.at(-1)?.method ?? 'none', attempts }
    const button = state.buttons.find((candidate) => DISMISS_KEYWORDS.some((keyword) => String(candidate.label ?? '').toLowerCase().includes(keyword.toLowerCase())))
    if (button && button.rect.width > 0 && button.rect.height > 0) {
      const point = { x: button.rect.x + button.rect.width / 2, y: button.rect.y + button.rect.height / 2 }
      await page.click(point.x, point.y)
      attempts.push({ method: 'button', label: button.label, text: button.text, point })
      await delay(800)
      continue
    }
    if (!attempts.some((entry) => entry.method === 'escape')) {
      await page.pressKey('Escape', { code: 'Escape', windowsVirtualKeyCode: 27 })
      attempts.push({ method: 'escape' })
      await delay(600)
      continue
    }
    if (state.rect) {
      const viewport = await page.evaluate('({ width: window.innerWidth, height: window.innerHeight })')
      const outside = state.rect.x > 80
        ? { x: Math.max(10, state.rect.x - 40), y: Math.min(viewport.height - 10, state.rect.y + 20) }
        : { x: Math.min(viewport.width - 10, state.rect.x + state.rect.width + 40), y: Math.min(viewport.height - 10, state.rect.y + 20) }
      await page.click(outside.x, outside.y)
      attempts.push({ method: 'backdrop', point: outside })
      await delay(600)
      continue
    }
    break
  }
  const final = await page.evaluate(dialogState())
  return { dismissed: !final.hasDialog, by: attempts.at(-1)?.method ?? 'none', attempts }
}

/**
 * Pick the first clickable element's rect center, clamped into the viewport.
 * @param {{rect: {x: number, y: number, width: number, height: number}}} target
 * @param {{width: number, height: number}} viewport
 * @returns {{x: number, y: number, inViewport: boolean}}
 */
function clickPointFor(target, viewport) {
  const center = { x: target.rect.x + target.rect.width / 2, y: target.rect.y + target.rect.height / 2 }
  const inViewport = center.x >= 0 && center.y >= 0 && center.x < viewport.width && center.y < viewport.height
  return {
    x: Math.min(Math.max(center.x, 1), viewport.width - 2),
    y: Math.min(Math.max(center.y, 1), viewport.height - 2),
    inViewport,
  }
}

/**
 * Click the center of a rect returned by a page probe.
 * @param {PageSession} page
 * @param {{x: number, y: number, width: number, height: number}} rect
 */
async function clickRect(page, rect) {
  await page.bringToFront()
  await page.click(rect.x + rect.width / 2, rect.y + rect.height / 2)
}

/**
 * Wait until a network request matching a predicate appears after an index.
 * @param {PageSession} page
 * @param {number} fromIndex
 * @param {(request: {url: string, method: string, postData?: string}) => boolean} matcher
 * @param {{timeoutMs?: number}} [options]
 * @returns {Promise<{url: string, method: string, postData?: string} | null>}
 */
async function waitForRequest(page, fromIndex, matcher, { timeoutMs = 20_000 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const match = page.networkRequests.slice(fromIndex).find((request) => matcher(request))
    if (match) return match
    await delay(250)
  }
  return null
}

// ---------------------------------------------------------------------------
// v1.1 page checks (CONTRACT.md §4.5/§4.6) — opt-in via --v11
// ---------------------------------------------------------------------------
const v11Checks = []
function v11Check(name, pass, detail = '') {
  v11Checks.push({ name, pass: Boolean(pass), detail })
}
function v11Pending(name, detail) {
  v11Checks.push({ name, pass: null, pending: true, detail })
}

/**
 * Run the v1.1 page checks on the already-open workbench page.
 * Called after the v1 flow so `page`, `options` and `report` are initialized.
 * @returns {Promise<void>}
 */
async function runV11Checks() {
  const v11 = { enabled: true, screenshots: {}, checks: v11Checks, runs: [] }
  report.v11 = v11
  const client = new GuiClient(options.url, { token: options.token })
  try {
    let surface = await page.evaluate(v11Surface())
    v11.surface = surface
    const surfaceReady = surface.settingsButtons.length > 0 || surface.reviewTriggers.length > 0
    v11Check(
      'v1.1 工作台：设置按钮与「用 AI 审查」入口存在',
      surfaceReady,
      JSON.stringify({ settings: surface.settingsButtons.map((entry) => entry.label ?? entry.aria), triggers: surface.reviewTriggers.map((entry) => entry.label ?? entry.text) }),
    )
    if (!surfaceReady) {
      v11Pending('v1.1 diff finding 卡 / 行内评论 / 设置弹层 / 键盘', '工作台 v1.1 入口未就绪')
    } else {
      /** Select a PR list row whose title contains `keyword`, then wait for its detail. */
      const selectRow = async (keyword) => {
        const row = await page.evaluate(findPrRow(keyword))
        if (!row.found) return { ok: false, prNumber: null }
        await clickRect(page, row.rect)
        await page.waitForNetworkIdle({ timeoutMs: 15_000, idleMs: 600 }).catch(() => false)
        const prNumber = row.prNumber ?? null
        if (prNumber !== null) {
          await page.waitFor(
            `(() => { const root = document.querySelector('[data-cr-detail="ready"]'); const head = document.querySelector('[data-cr-pr-head]'); return Boolean(root) && Boolean(head) && (head.innerText || '').includes('#${prNumber}'); })()`,
            { timeoutMs: 15_000, label: `PR #${prNumber} 详情` },
          ).catch(() => {})
        } else {
          await delay(1200)
        }
        await delay(500)
        return { ok: true, prNumber }
      }
      /** Open the Changes tab of the current detail. */
      const openChanges = async () => {
        surface = await page.evaluate(v11Surface())
        const tab = surface.tabs.find((entry) => entry.dataTab === 'changes') || surface.tabs.find((entry) => /changes|变更/i.test(String(entry.text ?? entry.label ?? '')))
        if (!tab) return false
        await clickRect(page, tab.rect)
        await page.waitForNetworkIdle({ timeoutMs: 10_000, idleMs: 600 }).catch(() => false)
        await delay(900)
        return true
      }

      /**
       * Make the diff carry findings before probing gutter markers: pick the
       * cached standard/P2 result (16 findings) and load it via the UI. The
       * review-start call hits the pre-warmed cache (no model call).
       */
      const ensureFindingsReview = async () => {
        surface = await page.evaluate(v11Surface())
        const gear0 = surface.settingsButtons[0]
        if (gear0) {
          await clickRect(page, gear0.rect)
          await page.waitFor('document.querySelector("[role=\\"dialog\\"][aria-modal=\\"true\\"]") !== null', { timeoutMs: 6000, label: '设置弹层' }).catch(() => {})
          await delay(500)
          const pop = await page.evaluate(settingsPopoverProbe())
          const standard = (pop.depthInputs ?? []).find((entry) => entry.depth === 'standard')
          const p2 = (pop.thresholdInputs ?? []).find((entry) => entry.threshold === 'P2')
          if (standard) await clickRect(page, standard.rect)
          if (p2) await clickRect(page, p2.rect)
          await page.evaluate(`(() => { const d = document.querySelector('[role="dialog"][aria-modal="true"]'); if (d) d.focus(); return true; })()`)
          await page.pressKey('Escape', { code: 'Escape', windowsVirtualKeyCode: 27 })
          await delay(600)
        }
        surface = await page.evaluate(v11Surface())
        const trigger = surface.reviewTriggers[0]
        if (!trigger) return false
        await clickRect(page, trigger.rect)
        await page.waitFor(
          `(() => { const text = document.body.innerText || ''; return /\\d+ 条发现|未发现 P0\\/P1 问题/.test(text) && !/审查中…|准备中…/.test(text); })()`,
          { timeoutMs: 30_000, label: '缓存审查结果加载' },
        ).catch(() => {})
        await page.waitForNetworkIdle({ timeoutMs: 10_000, idleMs: 600 }).catch(() => false)
        await delay(1000)
        return true
      }

      // 1) Target PR with cached findings (#129) → Changes → gutter markers → card.
      if (options.v11Select) {
        const selected = await selectRow(options.v11Select)
        v11Check(`v1.1 选中目标 PR（标题含「${options.v11Select}」）`, selected.ok, selected.ok ? `PR #${selected.prNumber ?? '?'}` : 'row not found')
        const loaded = await ensureFindingsReview()
        v11Check('v1.1 通过 UI 加载含 findings 的缓存审查结果（standard/P2）', loaded, loaded ? 'loaded' : 'review trigger missing')
      }
      const changesOpened = await openChanges()
      v11Check('v1.1 切到 Changes 视图', changesOpened, changesOpened ? 'Changes' : JSON.stringify(surface.tabs.map((entry) => entry.text ?? entry.label)))
      await page.screenshot(options.v11Paths.workbench)
      v11.screenshots.workbench = options.v11Paths.workbench
      const expand = await page.evaluate(pressableByText('全部展开|Expand all|展开全部'))
      if (expand.length > 0) {
        await clickRect(page, expand[0].rect)
        await delay(900)
      }
      const diff = await page.evaluate(diffFindingProbe())
      v11.diff = diff
      v11Check(
        'v1.1 diff 内存在 finding 行内标记（gutter 圆点/卡片触发点）',
        diff.markerCount > 0,
        `markerCount=${diff.markerCount}，cardCount=${diff.cardCount}，hasWhyFix=${diff.hasWhyFix}`,
      )
      if (diff.markerCount > 0) {
        // Markers can sit far below the viewport; scroll one in before clicking.
        const marker = await page.evaluate(scrollToElement('[data-inline-marker]', 0))
        v11.markerScrolled = marker
        if (marker.found) {
          await clickRect(page, marker.rect)
          await page.waitFor('document.querySelector("[data-inline-open]") !== null', { timeoutMs: 6000, label: 'diff finding 卡展开' }).catch(() => {})
          await delay(400)
        }
        const expanded = await page.evaluate(expandedFindingProbe())
        v11.expanded = expanded
        v11Check('v1.1 点击 finding 标记展开卡片（含「为什么/怎么改」）', expanded.hasWhy && expanded.hasFix, `hasWhy=${expanded.hasWhy}，hasFix=${expanded.hasFix}，cards=${expanded.cardCount}，openLine=${expanded.openLine}`)
        v11Check('v1.1 finding 卡展示严重度徽章', expanded.hasSeverity, `hasSeverity=${expanded.hasSeverity}`)
        v11Check(
          'v1.1 finding 卡展示 confidence/evidence（v1.1 可选字段，返回则展示）',
          true,
          `confidence=${expanded.hasConfidence}，evidence=${expanded.hasEvidence}（可选字段缺失不算失败）`,
        )
        await page.screenshot(options.v11Paths.finding)
        v11.screenshots.finding = options.v11Paths.finding
      }
      await page.screenshot(options.v11Paths.changes)
      v11.screenshots.changes = options.v11Paths.changes

      // 1b) v1.1 review card metadata (verdict / resolved options / guidelines).
      const reviewMeta = await page.evaluate(reviewMetaProbe())
      v11.reviewMeta = reviewMeta
      v11Check('v1.1 审查卡展示 verdict 徽章', Boolean(reviewMeta.verdict?.value), JSON.stringify(reviewMeta.verdict))
      v11Check('v1.1 审查卡展示 resolved options（depth/threshold）', Boolean(reviewMeta.options), JSON.stringify(reviewMeta.options))
      v11Check('v1.1 审查卡展示 AGENTS.md guidelines 状态', Boolean(reviewMeta.guidelines), JSON.stringify(reviewMeta.guidelines))
      v11Check('v1.1 审查卡无 partial 标记（当前 #129 缓存结果为非 partial）', !reviewMeta.partial, `partial=${reviewMeta.partial}`)

      // 2) Existing GitHub inline comments: pick a PR that actually has them.
      let inlineKeyword = options.v11InlineSelect
      if (!inlineKeyword) {
        const listResponse = await client.post('codex-review/prs', { query: 'is:open author:@me', limit: 30 }, { timeoutMs: 20_000 })
        const items = listResponse.json?.value?.items ?? []
        for (const item of items.slice(0, 10)) {
          const detail = await client.post('codex-review/pr', { repo: item.repo, number: item.number }, { timeoutMs: 20_000 })
          const inline = detail.json?.value?.comments?.inline
          if (Array.isArray(inline) && inline.length > 0) {
            inlineKeyword = String(item.title).slice(0, 14)
            v11.inlinePr = { repo: item.repo, number: item.number, inline: inline.length, title: item.title }
            break
          }
        }
      }
      if (!inlineKeyword) {
        v11Pending('v1.1 已有 GitHub 行内评论渲染', '没有找到含 inline 评论的 PR（跳过）')
      } else {
        const selectedInline = await selectRow(inlineKeyword)
        if (!selectedInline.ok) {
          v11Check('v1.1 已有 GitHub 行内评论可见', false, '无法在列表中选中含 inline 评论的 PR')
        } else {
          const inlineChanges = await openChanges()
          if (!inlineChanges) v11Check('v1.1 行内评论 PR 的 Changes 视图', false, 'Changes tab not found')
          const expandInline = await page.evaluate(pressableByText('全部展开|Expand all|展开全部'))
          if (expandInline.length > 0) {
            await clickRect(page, expandInline[0].rect)
            await delay(1200)
          }
          let inlineProbe = await page.evaluate(inlineCommentProbe())
          if (inlineProbe.count === 0) {
            await delay(1200)
            inlineProbe = await page.evaluate(inlineCommentProbe())
          }
          v11.inline = inlineProbe
          v11Check(
            'v1.1 已有 GitHub 行内评论可见（按 path+line 只读评论卡）',
            inlineProbe.count > 0 && inlineProbe.sample.some((sample) => String(sample).length > 20),
            `count=${inlineProbe.count}，sample=${JSON.stringify(inlineProbe.sample.slice(0, 2))}`,
          )
          await page.screenshot(options.v11Paths.inline)
          v11.screenshots.inline = options.v11Paths.inline
        }
      }

      // 3) Review settings popover: depth / severityThreshold / includeGuidelines.
      // Return to the pre-warmed PR first so the later keyboard `r` probe hits the
      // cached fast+P0 combination instead of starting a new long review.
      if (options.v11Select) {
        const reselect = await selectRow(options.v11Select)
        v11Check('v1.1 键盘 r 前切回目标 PR（命中缓存组合）', reselect.ok, reselect.ok ? `PR #${reselect.prNumber ?? '?'}` : 'reselect failed')
      }
      surface = await page.evaluate(v11Surface())
      const gear = surface.settingsButtons[0]
      if (!gear) {
        v11Pending('v1.1 审查设置弹层', '未找到设置按钮')
      } else {
        await clickRect(page, gear.rect)
        await page.waitFor('document.querySelector("[role=\\"dialog\\"][aria-modal=\\"true\\"], [data-cr-settings=\\"ready\\"]") !== null', { timeoutMs: 6000, label: '设置弹层打开' }).catch(() => {})
        await delay(600)
        const popover = await page.evaluate(settingsPopoverProbe())
        const depths = (popover.depthInputs ?? []).map((entry) => entry.depth)
        const thresholds = (popover.thresholdInputs ?? []).map((entry) => entry.threshold)
        v11Check(
          'v1.1 设置弹层可打开',
          popover.open,
          `open=${popover.open}，depths=${JSON.stringify(depths)}，thresholds=${JSON.stringify(thresholds)}，guidelinesToggle=${Boolean(popover.guidelineToggle)}`,
        )
        v11Check(
          'v1.1 设置弹层含 depth 三档（fast/standard/deep）',
          depths.includes('fast') && depths.includes('standard') && depths.includes('deep'),
          JSON.stringify(depths),
        )
        v11Check(
          'v1.1 设置弹层含 severityThreshold 三档（P0/P1/P2）',
          thresholds.includes('P0') && thresholds.includes('P1') && thresholds.includes('P2'),
          JSON.stringify(thresholds),
        )
        v11Check('v1.1 设置弹层含 includeGuidelines 开关', Boolean(popover.guidelineToggle), JSON.stringify(popover.guidelineToggle))
        v11Check('v1.1 设置弹层含 deep 耗时/复核说明', popover.hasDeepHint, `hasDeepHint=${popover.hasDeepHint}`)

        const fastInput = (popover.depthInputs ?? []).find((entry) => entry.depth === 'fast')
        if (fastInput) {
          await clickRect(page, fastInput.rect)
          await delay(500)
        }
        const p0Input = (popover.thresholdInputs ?? []).find((entry) => entry.threshold === 'P0')
        if (p0Input) {
          await clickRect(page, p0Input.rect)
          await delay(500)
        }
        const storageRaw = await page.evaluate(`(() => { try { return window.localStorage.getItem('codex-review:settings'); } catch { return null; } })()`)
        let storage = null
        try {
          storage = storageRaw ? JSON.parse(storageRaw) : null
        } catch {
          storage = null
        }
        v11.settings = { popover, storage, changedDepth: Boolean(fastInput), changedThreshold: Boolean(p0Input) }
        v11Check(
          'v1.1 修改 depth/severityThreshold 后设置持久化到 localStorage',
          Boolean(storageRaw && /fast/i.test(storageRaw) && /P0/.test(storageRaw)),
          storageRaw ?? 'null',
        )
        await page.screenshot(options.v11Paths.settings)
        v11.screenshots.settings = options.v11Paths.settings
        // Esc is handled by the dialog's own keydown handler, so focus it first.
        await page.evaluate(`(() => { const dialog = document.querySelector('[role="dialog"][aria-modal="true"], [data-cr-settings="ready"]'); if (!dialog) return false; dialog.focus(); return document.activeElement === dialog || dialog.contains(document.activeElement); })()`)
        await page.pressKey('Escape', { code: 'Escape', windowsVirtualKeyCode: 27 })
        await delay(700)
        let closed = await page.evaluate(settingsPopoverProbe())
        const escClosed = !closed.open
        if (!escClosed) {
          // Fallback so the keyboard assertions below start from a clean state.
          const closeButton = closed.closeButton
          if (closeButton) {
            await clickRect(page, closeButton.rect)
            await delay(600)
            closed = await page.evaluate(settingsPopoverProbe())
          }
        }
        v11Check('v1.1 Esc 关闭设置弹层', escClosed, `escClosed=${escClosed}，finalOpen=${closed.open}`)

        // 4) Keyboard: j/k switch PR, r reviews with the popover options, / focuses search.
        const pollKeyboard = async (predicate, timeoutMs = 9000) => {
          const deadline = Date.now() + timeoutMs
          let last = await page.evaluate(keyboardState())
          while (Date.now() < deadline) {
            if (predicate(last)) return last
            await delay(300)
            last = await page.evaluate(keyboardState())
          }
          return last
        }
        const state0 = await page.evaluate(keyboardState())
        await page.pressKey('j', { code: 'KeyJ', windowsVirtualKeyCode: 74 })
        const stateJ = await pollKeyboard((state) => state.selectedRowNumber !== state0.selectedRowNumber || state.prNumber !== state0.prNumber)
        await page.pressKey('k', { code: 'KeyK', windowsVirtualKeyCode: 75 })
        const stateK = await pollKeyboard((state) => state.selectedRowNumber === state0.selectedRowNumber || state.prNumber === state0.prNumber)
        v11.keyboard = { state0, stateJ, stateK }
        v11Check(
          'v1.1 键盘 j 切换下一个 PR',
          stateJ.selectedRowNumber !== state0.selectedRowNumber || stateJ.prNumber !== state0.prNumber,
          `list #${state0.selectedRowNumber ?? state0.prNumber} → #${stateJ.selectedRowNumber ?? stateJ.prNumber}`,
        )
        v11Check(
          'v1.1 键盘 k 切回上一个 PR',
          stateK.selectedRowNumber === state0.selectedRowNumber || stateK.prNumber === state0.prNumber,
          `list #${stateJ.selectedRowNumber ?? stateJ.prNumber} → #${stateK.selectedRowNumber ?? stateK.prNumber}`,
        )
        // r must run before '/' (the search input counts as "typing" and suppresses shortcuts).
        // `--v11-skip-review-key` keeps the probe from competing with an operator-run
        // review: it records the r assertions as pending instead of starting one.
        if (options.v11SkipReviewKey) {
          v11Pending('v1.1 键盘 r 触发 review-start 请求', '按 --v11-skip-review-key 跳过（避免与 Lead 冒烟抢 job）')
          v11Pending('v1.1 审查请求体带设置弹层的 options（depth=fast）', '按 --v11-skip-review-key 跳过')
          v11Pending('v1.1 审查请求体 options.severityThreshold=P0', '按 --v11-skip-review-key 跳过')
          v11Pending('v1.1 审查请求体 options.includeGuidelines 为布尔', '按 --v11-skip-review-key 跳过')
        } else {
          const requestIndexBefore = page.networkRequests.length
          await page.pressKey('r', { code: 'KeyR', windowsVirtualKeyCode: 82 })
          const reviewRequest = await waitForRequest(page, requestIndexBefore, (request) => request.url.includes('/codex-review/review-start'), { timeoutMs: 20_000 })
          let requestOptions = null
          if (reviewRequest?.postData) {
            try {
              requestOptions = JSON.parse(reviewRequest.postData).options ?? null
            } catch {
              requestOptions = null
            }
          }
          v11.keyboard.reviewRequest = reviewRequest ? { url: reviewRequest.url, postData: reviewRequest.postData } : null
          v11Check('v1.1 键盘 r 触发 review-start 请求', Boolean(reviewRequest), reviewRequest ? reviewRequest.url : '未观察到 review-start 请求')
          v11Check('v1.1 审查请求体带设置弹层的 options（depth=fast）', Boolean(requestOptions && requestOptions.depth === 'fast'), JSON.stringify(requestOptions))
          v11Check('v1.1 审查请求体 options.severityThreshold=P0', Boolean(requestOptions && requestOptions.severityThreshold === 'P0'), JSON.stringify(requestOptions))
          v11Check('v1.1 审查请求体 options.includeGuidelines 为布尔', Boolean(requestOptions && typeof requestOptions.includeGuidelines === 'boolean'), JSON.stringify(requestOptions))
        }
        await page.pressKey('/', { code: 'Slash', windowsVirtualKeyCode: 191 })
        await delay(700)
        const stateSlash = await page.evaluate(keyboardState())
        v11Check(
          'v1.1 键盘 / 聚焦搜索框',
          stateSlash.activeTag === 'input' && /is:open|筛选|Search|filter/i.test(`${stateSlash.activePlaceholder ?? ''} ${stateSlash.activeAria ?? ''}`),
          JSON.stringify(stateSlash),
        )
        await page.screenshot(options.v11Paths.keyboard)
        v11.screenshots.keyboard = options.v11Paths.keyboard
      }
    }
  } catch (error) {
    v11Check('v1.1 页面流程执行', false, error instanceof Error ? error.message : String(error))
    v11.error = error instanceof Error ? { message: error.message, stack: error.stack } : { message: String(error) }
  }
  v11.pendingCount = v11Checks.filter((entry) => entry.pending === true).length
  v11.failedCount = v11Checks.filter((entry) => entry.pending !== true && entry.pass === false).length
}


// ---------------------------------------------------------------------------
// v2 page checks (CONTRACT §5.3/§5.4): merge dialog (cancel ONLY, never confirm)
// and the PR chat panel.
// ---------------------------------------------------------------------------
const v2Checks = []
function v2Check(name, pass, detail = '') {
  v2Checks.push({ name, pass: Boolean(pass), detail })
}
function v2Pending(name, detail) {
  v2Checks.push({ name, pass: null, pending: true, detail })
}

async function runV2Checks() {
  const v2 = { enabled: true, checks: v2Checks, screenshots: {}, network: {} }
  report.v2 = v2
  try {
    // --- surface -----------------------------------------------------------
    let surface = await page.evaluate(v2Surface())
    v2.surface = surface
    const mergeReady = Boolean(surface.mergeButton && !surface.mergeButton.disabled)
    v2Check('v2 合并按钮存在且可点（open PR）', mergeReady, JSON.stringify(surface.mergeButton ?? null))
    v2Check('v2 底部对话输入框存在（placeholder 就此 Pull Request 提问）', Boolean(surface.chatInput), JSON.stringify(surface.chatInput ?? null))
    if (!mergeReady && !surface.chatInput) {
      v2Pending('v2 合并弹层 / 对话流程', 'v2 UI 未就绪')
    }

    // --- merge dialog: inspect then CANCEL (never confirm) ------------------
    if (mergeReady) {
      const beforeText = (await page.evaluate(pageState())).bodyTextSample ?? ''
      const networkBefore = page.networkRequests.length
      await clickRect(page, surface.mergeButton.rect)
      await page.waitFor(
        'document.querySelector("[role=\\"dialog\\"], [data-merge-dialog], [data-cr-merge]") !== null',
        { timeoutMs: 8000, label: '合并弹层' },
      ).catch(() => {})
      await delay(700)
      const dialog = await page.evaluate(mergeDialogProbe())
      v2.mergeDialog = dialog
      v2Check('v2 合并弹层打开', dialog.open, JSON.stringify(dialog).slice(0, 500))
      if (dialog.open) {
        const methodLabels = (dialog.methods ?? []).map((entry) => String(entry.label ?? entry.text ?? ''))
        v2Check('v2 合并方式三选（Squash / Merge commit / Rebase）', methodLabels.length >= 3, JSON.stringify(methodLabels))
        v2Check('v2 删除源分支 checkbox 存在', (dialog.deleteBranch ?? []).length >= 1, JSON.stringify(dialog.deleteBranch ?? []))
        v2Check('v2 风险提示文案存在（写操作/真实改变仓库）', dialog.hasRiskWarning, dialog.dialogText?.slice(0, 200))
        v2Check(
          'v2 弹层展示 repo#number / head→base / headSha',
          dialog.hasRepoNumber && dialog.hasBranches && dialog.hasHeadSha,
          JSON.stringify({ repo: dialog.hasRepoNumber, branches: dialog.hasBranches, sha: dialog.hasHeadSha }),
        )
        v2Check('v2 弹层含取消按钮（只点取消）', Boolean(dialog.cancel), JSON.stringify(dialog.cancel))
        await page.screenshot(options.v2Paths.mergeDialog)
        v2.screenshots.mergeDialog = options.v2Paths.mergeDialog
        if (dialog.cancel) {
          await clickRect(page, dialog.cancel.rect)
          await delay(900)
          const closed = await page.evaluate(mergeDialogProbe())
          v2Check('v2 点击取消后弹层关闭', !closed.open, `open=${closed.open}`)
        }
        const mergeRequests = page.networkRequests.slice(networkBefore).filter((request) => request.url.includes('/codex-review/merge'))
        v2.network.mergeRequestsAfterCancel = mergeRequests.length
        v2Check('v2 取消后未发出任何 /codex-review/merge 请求（无写操作）', mergeRequests.length === 0, JSON.stringify(mergeRequests.map((request) => request.url)))
        const afterText = (await page.evaluate(pageState())).bodyTextSample ?? ''
        v2Check('v2 取消后 PR 详情未被改写（仍显示同一 PR）', /#\d+/.test(afterText) && afterText.length > 0, `beforeLen=${beforeText.length} afterLen=${afterText.length}`)
        await page.screenshot(options.v2Paths.mergeCancel)
        v2.screenshots.mergeCancel = options.v2Paths.mergeCancel
      }
    }

    // --- PR chat: real question over the streaming panel -------------------
    if (surface.chatInput) {
      const inputTarget = await page.evaluate(chatInputTarget())
      v2.chatInput = inputTarget
      if (!inputTarget.found) {
        v2Check('v2 定位对话输入框', false, 'not found')
      } else {
        await clickRect(page, inputTarget.rect)
        await delay(400)
        await page.insertText('总结这个 PR 的改动')
        const sendTarget = await page.evaluate(chatSendTarget())
        v2.sendTarget = sendTarget
        if (sendTarget.found && !sendTarget.disabled) {
          await clickRect(page, sendTarget.rect)
        } else {
          await page.pressKey('Enter', { code: 'Enter', windowsVirtualKeyCode: 13 })
        }
        let streamingSeen = false
        let capturedStreaming = false
        let panel = null
        const deadline = Date.now() + 240_000
        while (Date.now() < deadline) {
          panel = await page.evaluate(chatPanelProbe())
          if (panel.streaming && !capturedStreaming) {
            capturedStreaming = true
            streamingSeen = true
            await page.screenshot(options.v2Paths.chatStreaming)
            v2.screenshots.chatStreaming = options.v2Paths.chatStreaming
          }
          const assistantLen = String(panel.assistantText ?? '').trim().length
          if (panel.userBubbleCount >= 1 && !panel.streaming && assistantLen >= 10) break
          if (panel.error) break
          await delay(1200)
        }
        v2.chat = panel
        v2Check('v2 对话面板出现 user 气泡（提问已发送）', Boolean(panel && panel.userBubbleCount >= 1), JSON.stringify({ bubbles: panel?.bubbleCount, user: panel?.userBubbleCount }))
        v2Check('v2 assistant 气泡流式输出并最终非空（≥10 字）', Boolean(panel && String(panel.assistantText ?? '').trim().length >= 10), `len=${String(panel?.assistantText ?? '').trim().length}`)
        v2Check('v2 流式期间出现停止按钮 / streaming 状态', streamingSeen || Boolean(panel?.stop), JSON.stringify(panel?.stop))
        v2Check('v2 对话无 error 气泡', !panel?.error, JSON.stringify(panel?.error))
        v2Check(
          'v2 回答包含 PR 相关内容（文件/改动/PR/代码）',
          /(PR|文件|改动|diff|代码|审查|修改)/iu.test(String(panel?.assistantText ?? '')),
          String(panel?.assistantText ?? '').slice(0, 200),
        )
        await page.screenshot(options.v2Paths.chatDone)
        v2.screenshots.chatDone = options.v2Paths.chatDone
        await page.pressKey('Escape', { code: 'Escape', windowsVirtualKeyCode: 27 })
        await delay(700)
        const closedPanel = await page.evaluate(chatPanelProbe())
        v2Check('v2 Esc 关闭对话面板', !closedPanel.open, `open=${closedPanel.open}`)
        await page.screenshot(options.v2Paths.chatClosed)
        v2.screenshots.chatClosed = options.v2Paths.chatClosed
        const storage = await page.evaluate(chatStorageProbe())
        v2.chatStorage = storage
        v2Check('v2 对话历史按 PR 持久化（localStorage codex-review:chat:*）', (storage.keys ?? []).length >= 1, JSON.stringify(storage.keys))
        try {
          const apiClient = new GuiClient(options.url, { token: options.token })
          const listResponse = await apiClient.post('codex-review/prs', { query: 'is:open author:@me', limit: 30 }, { timeoutMs: 20_000 })
          const items = listResponse.json?.value?.items ?? []
          if (items.length >= 2) {
            const other = items[1]
            const row = await page.evaluate(findPrRow(String(other.title).slice(0, 12)))
            if (row.found) {
              await clickRect(page, row.rect)
              await page.waitForNetworkIdle({ timeoutMs: 15_000, idleMs: 600 }).catch(() => false)
              await delay(800)
              const input2 = await page.evaluate(chatInputTarget())
              if (input2.found) {
                await clickRect(page, input2.rect)
                await delay(500)
              }
              const panel2 = await page.evaluate(chatPanelProbe())
              v2Check(
                'v2 切换 PR 后对话历史隔离（另一 PR 面板为空）',
                panel2.bubbleCount === 0 || String(panel2.assistantText ?? '').trim() === '',
                JSON.stringify({ bubbles: panel2.bubbleCount, user: panel2.userBubbleCount }),
              )
              await page.screenshot(options.v2Paths.chatIsolation)
              v2.screenshots.chatIsolation = options.v2Paths.chatIsolation
            } else {
              v2Pending('v2 切换 PR 后对话历史隔离', '第二个 PR 行未找到')
            }
          } else {
            v2Pending('v2 切换 PR 后对话历史隔离', `当前 open PR 仅 ${items.length} 个，无法切换`)
          }
        } catch (error) {
          v2Pending('v2 切换 PR 后对话历史隔离', error instanceof Error ? error.message : String(error))
        }
      }
    }
  } catch (error) {
    v2Check('v2 页面流程执行', false, error instanceof Error ? error.message : String(error))
    v2.error = error instanceof Error ? { message: error.message, stack: error.stack } : { message: String(error) }
  }
  v2.pendingCount = v2Checks.filter((entry) => entry.pending === true).length
  v2.failedCount = v2Checks.filter((entry) => entry.pending !== true && entry.pass === false).length
}

// ---------------------------------------------------------------------------
// v2.1 page checks (CONTRACT §6.4/§6.5): auto-review settings section, toggle
// config request, immediate check, status card, badge, toast. Auto-review is
// always turned back off in a finally block.
// ---------------------------------------------------------------------------
const v21Checks = []
function v21Check(name, pass, detail = '') {
  v21Checks.push({ name, pass: Boolean(pass), detail })
}
function v21Pending(name, detail) {
  v21Checks.push({ name, pass: null, pending: true, detail })
}

async function runV21Checks() {
  const v21 = { enabled: true, checks: v21Checks, screenshots: {}, network: {} }
  report.v21 = v21
  const apiClient = new GuiClient(options.url, { token: options.token })
  const getStatus = async () => {
    const response = await apiClient.post('codex-review/auto-review-status', {}, { timeoutMs: 20_000 })
    return response.json?.value ?? null
  }
  let hostReady = false
  try {
    const probe = await apiClient.post('codex-review/auto-review-status', {}, { timeoutMs: 20_000 })
    hostReady = probe.status !== 404 && probe.status !== 405 && probe.json?.ok === true
    v21.capability = { status: probe.status, envelope: probe.json?.ok ?? null }
  } catch (error) {
    v21.capability = { error: error.message }
  }
  v21Check('v2.1: Host 已部署自动审查路由（status 返回 JSON 信封）', hostReady, JSON.stringify(v21.capability))
  try {
    if (!hostReady) {
      v21Pending('v2.1 自动审查设置区/开关/立即检查/状态卡/徽章/toast', 'v2.1 Host 尚未生效')
    } else {
    let surface = await page.evaluate(v21Surface())
    v21.surface = surface
    const uiReady = Boolean(surface.settingsSection || surface.card)
    v21Check(
      'v2.1 自动审查 UI 存在（设置区/状态卡）',
      uiReady,
      JSON.stringify({ settingsSection: Boolean(surface.settingsSection), card: Boolean(surface.card) }),
    )
    if (!uiReady) {
      v21Pending('v2.1 自动审查设置/开关/立即检查/状态卡/徽章/toast', 'v2.1 UI 未就绪')
    } else {
      // --- settings dialog: auto-review section + toggle -> config request ----
      const settingsSurface = await page.evaluate(v11Surface())
      const gear = settingsSurface.settingsButtons?.[0]
      if (!gear) {
        v21Check('v2.1 打开审查设置弹层', false, '设置按钮未找到')
      } else {
        await clickRect(page, gear.rect)
        await page.waitFor('document.querySelector("[role=\\"dialog\\"][aria-modal=\\"true\\"]") !== null', { timeoutMs: 8000, label: '设置弹层' }).catch(() => {})
        await delay(800)
        const settings = await page.evaluate(autoSettingsProbe())
        v21.settings = settings
        v21Check('v2.1 设置弹层含「自动审查」区', settings.open, String(settings.text ?? '').slice(0, 200))
        v21Check('v2.1 自动审查区含开关', Boolean(settings.toggle), JSON.stringify(settings.toggle))
        v21Check(
          'v2.1 自动审查区含 interval/depth/threshold/drafts/maxPerCycle/query 控件',
          settings.hasInterval && settings.hasDepth && settings.hasThreshold && settings.hasDrafts && settings.hasMaxPerCycle && settings.hasQuery,
          JSON.stringify({ interval: settings.hasInterval, depth: settings.hasDepth, threshold: settings.hasThreshold, drafts: settings.hasDrafts, maxPerCycle: settings.hasMaxPerCycle, query: settings.hasQuery }),
        )
        const toggleTarget = await page.evaluate(autoToggleTarget())
        v21.toggleTarget = toggleTarget
        const netBefore = page.networkRequests.length
        if (toggleTarget.found) {
          await clickRect(page, toggleTarget.rect)
          await delay(500)
        }
        const configRequest = await waitForRequest(page, netBefore, (request) => request.url.includes('/codex-review/auto-review-config'), { timeoutMs: 12_000 })
        let configPatch = null
        if (configRequest?.postData) {
          try {
            configPatch = JSON.parse(configRequest.postData).patch ?? null
          } catch {
            configPatch = null
          }
        }
        v21.network.toggleConfigPatch = configPatch
        v21Check('v2.1 开关切换发出 auto-review-config 请求', Boolean(configRequest), configRequest ? configRequest.url : '未观察到请求')
        v21Check('v2.1 开关请求体 patch.enabled=true', Boolean(configPatch && configPatch.enabled === true), JSON.stringify(configPatch))
        await delay(800)
        const statusAfterToggle = await getStatus()
        v21.statusAfterToggle = statusAfterToggle
        v21Check('v2.1 开关开启后 status.config.enabled=true', statusAfterToggle?.config?.enabled === true, JSON.stringify(statusAfterToggle?.config))
        await page.screenshot(options.v21Paths.settings)
        v21.screenshots.settings = options.v21Paths.settings
        await page.evaluate(`(() => { const dialog = document.querySelector('[role="dialog"][aria-modal="true"]'); if (dialog) dialog.focus(); return true; })()`)
        await page.pressKey('Escape', { code: 'Escape', windowsVirtualKeyCode: 27 })
        await delay(700)

        // --- auto-review card + immediate check ------------------------------
        const card = await page.evaluate(autoCardProbe())
        v21.card = card
        v21Check(
          'v2.1 右栏自动审查卡存在（状态/上次/下次/最近/立即检查）',
          card.open && card.hasLastCycle && card.hasNextCycle && card.hasRecent && Boolean(card.immediate),
          JSON.stringify({ open: card.open, last: card.hasLastCycle, next: card.hasNextCycle, recent: card.hasRecent, immediate: Boolean(card.immediate) }),
        )
        // Data-aware baseline: an operator smoke may have already reviewed every
        // open PR, in which case a force cycle correctly produces no new result.
        const statusBeforeRun = await getStatus()
        const recentBeforeRun = Array.isArray(statusBeforeRun?.recent) ? statusBeforeRun.recent.length : 0
        let openCount = null
        try {
          const openList = await apiClient.post('codex-review/prs', { query: 'is:open author:@me', limit: 30 }, { timeoutMs: 20_000 })
          openCount = openList.json?.value?.items?.length ?? null
        } catch {
          openCount = null
        }
        v21.openPrCount = openCount
        const runNetBefore = page.networkRequests.length
        if (card.immediate) {
          await clickRect(page, card.immediate.rect)
          await delay(500)
        }
        const runRequest = await waitForRequest(page, runNetBefore, (request) => request.url.includes('/codex-review/auto-review-run'), { timeoutMs: 15_000 })
        let runBody = null
        if (runRequest?.postData) {
          try {
            runBody = JSON.parse(runRequest.postData)
          } catch {
            runBody = null
          }
        }
        v21.network.immediateRunBody = runBody
        v21Check('v2.1 立即检查发出 auto-review-run 请求', Boolean(runRequest), runRequest ? runRequest.url : '未观察到请求')
        v21Check('v2.1 立即检查请求体 force=true', Boolean(runBody && runBody.force === true), JSON.stringify(runBody))

        const deadline = Date.now() + options.timeoutMs
        let lastStatus = null
        while (Date.now() < deadline) {
          lastStatus = await getStatus()
          if (lastStatus && lastStatus.running === false) break
          await delay(1500)
        }
        v21.statusAfterRun = lastStatus
        if (Boolean(lastStatus) && lastStatus.running === false) {
          v21Check('v2.1 立即检查后 cycle 结束（running=false）', true, 'running=false')
        } else {
          // A force cycle may legitimately be reviewing a PR that takes longer
          // than this page's wait window; api-probe --v21 awaits the terminal
          // state with a long timeout, so the page run records it as pending.
          v21Pending(
            'v2.1 立即检查后 cycle 结束（running=false）',
            `页面等待窗口（${options.timeoutMs}ms）内 cycle 仍在运行（可能在审查新出现的 PR）；cycle 终态由 api-probe --v21 长超时断言`,
          )
        }
        const recent = Array.isArray(lastStatus?.recent) ? lastStatus.recent : []
        const doneEntry = recent.find((entry) => entry?.state === 'done')
        const newEntries = recent.length - recentBeforeRun
        v21.runStats = { recentBeforeRun, recentAfter: recent.length, newEntries, openCount }
        if (doneEntry) {
          v21Check('v2.1 状态卡数据：recent 含 done 结果', true, JSON.stringify(recent.slice(0, 3)).slice(0, 400))
        } else if (newEntries === 0) {
          v21Pending(
            'v2.1 状态卡数据：recent 含 done 结果',
            `本轮无新增审查（open PR ${openCount ?? '?'} 个均已在 seen 中，契约允许 cycle no-op）`,
          )
        } else {
          v21Check('v2.1 状态卡数据：recent 含 done 结果', false, JSON.stringify(recent.slice(0, 3)).slice(0, 400))
        }
        await page.screenshot(options.v21Paths.autoReview)
        v21.screenshots.autoReview = options.v21Paths.autoReview

        // --- toast + PR row badge -------------------------------------------
        let toast = null
        for (let attempt = 0; attempt < 12; attempt += 1) {
          toast = await page.evaluate(toastProbe())
          if ((toast.texts ?? []).some((text) => /自动审查完成|auto[- ]?review/i.test(text))) break
          await delay(800)
        }
        v21.toast = toast
        const toastSeen = Boolean(toast && (toast.texts ?? []).some((text) => /自动审查完成|auto[- ]?review/i.test(text)))
        if (newEntries > 0) {
          v21Check('v2.1 自动审查完成 toast 出现', toastSeen, JSON.stringify(toast?.texts))
        } else {
          v21Pending('v2.1 自动审查完成 toast 出现', '本轮 force cycle 无新增结果（open PR 均已在 seen），toast 无数据源；recent 持久化由 REPORT §13.4 单独验证')
        }
        if (toast && (toast.texts ?? []).length > 0) {
          await page.screenshot(options.v21Paths.toast)
          v21.screenshots.toast = options.v21Paths.toast
        }
        const badge = await page.evaluate(prBadgeProbe())
        v21.badge = badge
        if (newEntries > 0 || badge.count >= 1) {
          v21Check('v2.1 PR 行显示「已自动审查」徽章', badge.count >= 1, JSON.stringify(badge).slice(0, 300))
        } else {
          v21Pending('v2.1 PR 行显示「已自动审查」徽章', '本轮无新增审查结果（recent 为空），徽章无数据来源；待 0.5.0 recent 持久化后复跑')
        }
        if (badge.count >= 1) {
          await page.screenshot(options.v21Paths.badge)
          v21.screenshots.badge = options.v21Paths.badge
        }

        // --- turn auto-review off again and verify --------------------------
        await apiClient.post('codex-review/auto-review-config', { patch: { enabled: false } }, { timeoutMs: 15_000 })
        await delay(600)
        const offStatus = await getStatus()
        v21.statusAfterDisable = offStatus
        v21Check('v2.1 关闭自动审查后 status.config.enabled=false', offStatus?.config?.enabled === false, JSON.stringify(offStatus?.config))
        await page.screenshot(options.v21Paths.disabled)
        v21.screenshots.disabled = options.v21Paths.disabled

        const errors = page.consoleMessages.filter((message) => message.type === 'error')
        const pageErrors = page.pageErrors
        report.consoleMessages = page.consoleMessages
        report.consoleErrors = errors
        report.pageErrors = pageErrors
        v21Check('v2.1 页面流程期间无 console.error', errors.length === 0, `${errors.length} 条`)
        v21Check('v2.1 页面流程期间无 pageerror', pageErrors.length === 0, `${pageErrors.length} 条`)
      }
    }
    }
  } catch (error) {
    v21Check('v2.1 页面流程执行', false, error instanceof Error ? error.message : String(error))
    v21.error = error instanceof Error ? { message: error.message, stack: error.stack } : { message: String(error) }
  } finally {
    // Safety: never leave periodic auto-review enabled after the probe.
    if (hostReady) {
      try {
        await apiClient.post('codex-review/auto-review-config', { patch: { enabled: false } }, { timeoutMs: 15_000 })
      } catch {
        /* best effort: restore is asserted by the API probe */
      }
    }
  }
  v21.pendingCount = v21Checks.filter((entry) => entry.pending === true).length
  v21.failedCount = v21Checks.filter((entry) => entry.pending !== true && entry.pass === false).length
}

// ---------------------------------------------------------------------------
// v2.2 page checks (CONTRACT §7.3/§7.4): the publish confirmation dialog
// (inspect + CANCEL only, never confirm) and the auto-publish switch (second
// confirmation + CANCEL only).
//
// SAFETY: this section never sends /codex-review/review-publish and never
// enables `publish.enabled`; both are asserted from the Network log.
// ---------------------------------------------------------------------------
const v22Checks = []
function v22Check(name, pass, detail = '') {
  v22Checks.push({ name, pass: Boolean(pass), detail })
}
function v22Pending(name, detail) {
  v22Checks.push({ name, pass: null, pending: true, detail })
}

/**
 * Find an open PR whose current head has a `done` review with findings — only
 * those expose the review-card 「发布到 GitHub」 button (CONTRACT §7.3).
 * @param {GuiClient} apiClient
 * @returns {Promise<{pick: any | null, scan: Array<Record<string, unknown>>}>}
 */
async function findPublishablePr(apiClient) {
  const scan = []
  const listResponse = await apiClient.post('codex-review/prs', { query: 'is:open author:@me', limit: 30 }, { timeoutMs: 20_000 })
  const items = Array.isArray(listResponse.json?.value?.items) ? listResponse.json.value.items : []
  for (const item of items.slice(0, 10)) {
    const detail = await apiClient.post('codex-review/pr', { repo: item.repo, number: item.number }, { timeoutMs: 30_000 })
    const value = detail.json?.value
    const review = value?.review
    const findings = Array.isArray(review?.findings) ? review.findings.length : null
    scan.push({ repo: item.repo, number: item.number, state: review?.state ?? null, findings })
    if (review?.state === 'done' && findings > 0) {
      return {
        pick: {
          repo: item.repo,
          number: item.number,
          title: String(item.title ?? ''),
          headSha: typeof review.headSha === 'string' ? review.headSha : null,
          findings,
        },
        scan,
      }
    }
  }
  return { pick: null, scan }
}

async function runV22Checks() {
  const v22 = { enabled: true, checks: v22Checks, screenshots: {}, network: {}, api: {}, publishDialog: null, autoPublish: null }
  report.v22 = v22
  const apiClient = new GuiClient(options.url, { token: options.token })
  try {
    // --- Host-side publish config: what the page state must mirror ----------
    try {
      const status = await apiClient.post('codex-review/auto-review-status', {}, { timeoutMs: 20_000 })
      const value = status.json?.value
      v22.api.statusHttp = status.status
      v22.api.publish = value?.publish ?? null
      // v2.2 client reads `status.publish`; a Host that only ships
      // `config.publish` leaves publishConfig null and degrades the whole UI.
      v22.api.configPublish = value?.config?.publish ?? null
    } catch (error) {
      v22.api.error = error.message
    }

    // --- 1) pick a publishable PR and select it in the list ----------------
    const { pick, scan } = await findPublishablePr(apiClient)
    v22.scan = scan
    v22.publishable = pick
    if (!pick) {
      v22Pending('v2.2 发布弹层字段（repo#number/已审查 head/预计评论数/mode/minSeverity/风险提示）', `当前 open PR 中找不到「done 审查 + findings>0」的目标（扫描 ${scan.length} 个：${scan.map((entry) => `#${entry.number}:${entry.state}/${entry.findings}`).join('，') || '无 open PR'}）`)
      v22Pending('v2.2 切换 mode=summary / minSeverity=P0（本地状态）', '没有可发布的 PR，发布按钮不会出现')
      v22Pending('v2.2 取消后弹层关闭 + 0 个 review-publish 请求', '没有可发布的 PR，发布按钮不会出现')
    } else {
      const row = await page.evaluate(findPrRow(String(pick.title).slice(0, 12)))
      v22.row = row
      if (row.found) {
        await clickRect(page, row.rect)
        await page.waitForNetworkIdle({ timeoutMs: 15_000, idleMs: 600 }).catch(() => false)
        await delay(800)
      }
      await page.waitFor(
        `(() => { const root = document.querySelector('[data-cr-root]'); return Boolean(root) && root.getAttribute('data-cr-review-state') === 'done'; })()`,
        { timeoutMs: 20_000, label: `PR #${pick.number} 的 done 审查` },
      ).catch(() => {})
      await page.waitFor(
        `(() => { const root = document.querySelector('[data-cr-root]'); const button = document.querySelector('[data-action="review-publish"]'); return Boolean(root) && root.getAttribute('data-cr-publish-supported') === 'true' && Boolean(button); })()`,
        { timeoutMs: 20_000, label: '「发布到 GitHub」按钮' },
      ).catch(() => {})
      await delay(600)
      const surface = await page.evaluate(v22Surface())
      v22.surface = surface
      v22Check(
        'v2.2 审查卡出现「发布到 GitHub」按钮（done + findings>0 + supported）',
        Boolean(surface.publishButton && !surface.publishButton.disabled),
        JSON.stringify({ rowFound: row.found, supported: surface.supported, reviewState: surface.reviewState, button: surface.publishButton ?? null, publishTopLevel: Boolean(v22.api.publish), publishInConfig: Boolean(v22.api.configPublish) }).slice(0, 400),
      )

      if (!surface.publishButton) {
        const detail = `发布按钮未出现（supported=${String(surface.supported)}；/auto-review-status 顶层 publish=${Boolean(v22.api.publish)}，config.publish=${Boolean(v22.api.configPublish)}）`
        v22Pending('v2.2 发布弹层字段（repo#number/已审查 head/预计评论数/mode/minSeverity/风险提示）', detail)
        v22Pending('v2.2 切换 mode=summary / minSeverity=P0（本地状态）', detail)
        v22Pending('v2.2 取消后弹层关闭 + 0 个 review-publish 请求', detail)
      } else {
        // --- 2) open the dialog and inspect every field -------------------
        const trigger = await page.evaluate(publishTriggerTarget())
        v22.trigger = trigger
        const netBefore = page.networkRequests.length
        await clickRect(page, trigger.found ? trigger.rect : surface.publishButton.rect)
        await page.waitFor('document.querySelector("[data-cr-publish-dialog=\\"ready\\"]") !== null', { timeoutMs: 8000, label: '发布弹层' }).catch(() => {})
        await delay(700)
        const dialog = await page.evaluate(publishDialogProbe())
        v22.publishDialog = dialog
        v22Check(
          'v2.2 点击「发布到 GitHub」打开发布弹层',
          dialog.open,
          JSON.stringify({ open: dialog.open, rootState: dialog.rootState, phase: dialog.phase, mode: dialog.mode, error: dialog.error }).slice(0, 400),
        )
        if (!dialog.open) {
          v22Pending('v2.2 发布弹层字段（repo#number/已审查 head/预计评论数/mode/minSeverity/风险提示）', '发布弹层未打开')
          v22Pending('v2.2 切换 mode=summary / minSeverity=P0（本地状态）', '发布弹层未打开')
          v22Pending('v2.2 取消后弹层关闭 + 0 个 review-publish 请求', '发布弹层未打开')
        } else {
          v22Check(
            'v2.2 弹层展示 repo#number',
            dialog.repo.includes(pick.repo) && dialog.repo.includes(`#${pick.number}`),
            `repo=${JSON.stringify(dialog.repo)}，期望含 ${pick.repo} 与 #${pick.number}`,
          )
          const expectedHead = String(pick.headSha ?? '').toLowerCase()
          const shownHead = String(dialog.headSha ?? '').toLowerCase()
          v22Check(
            'v2.2 弹层展示「已审查的提交」(review.headSha 前 7 位)',
            shownHead !== '' && (expectedHead === '' || expectedHead.startsWith(shownHead)),
            `dialog=${shownHead || '-'}，review.headSha=${expectedHead ? `${expectedHead.slice(0, 12)}…` : '-'}`,
          )
          v22Check(
            'v2.2 弹层展示预计评论数（data-publish-expected，整数 ≥0）',
            Number.isInteger(dialog.expected) && dialog.expected >= 0 && dialog.hasExpectedLabel,
            `expected=${String(dialog.expected)}，text=${JSON.stringify(dialog.expectedText)}`,
          )
          v22Check(
            'v2.2 发布方式三选（inline/summary/both）',
            ['inline', 'summary', 'both'].every((value) => dialog.modeValues.includes(value)),
            JSON.stringify(dialog.modeValues),
          )
          v22Check(
            'v2.2 最低严重度三选（P0/P1/P2）',
            ['P0', 'P1', 'P2'].every((value) => dialog.minValues.includes(value)),
            JSON.stringify(dialog.minValues),
          )
          v22Check('v2.2 弹层含写操作风险提示', dialog.hasRiskWarning, String(dialog.dialogText ?? '').slice(0, 220))
          v22Check(
            'v2.2 弹层含取消与确认按钮且处于 idle（只点取消）',
            Boolean(dialog.cancel) && Boolean(dialog.confirm) && dialog.phase === 'idle',
            JSON.stringify({ cancel: Boolean(dialog.cancel), confirm: Boolean(dialog.confirm), phase: dialog.phase }),
          )
          await page.screenshot(options.v22Paths.dialog)
          v22.screenshots.dialog = options.v22Paths.dialog

          // --- 3) switch mode/minSeverity locally (no network) -----------
          const modeTarget = await page.evaluate(publishModeTarget('summary'))
          if (modeTarget.found) {
            await clickRect(page, modeTarget.rect)
            await delay(450)
          }
          const minTarget = await page.evaluate(publishMinTarget('P0'))
          if (minTarget.found) {
            await clickRect(page, minTarget.rect)
            await delay(450)
          }
          const changed = await page.evaluate(publishDialogProbe())
          v22.publishDialogChanged = changed
          const summaryChecked = (changed.modes ?? []).some((entry) => entry.value === 'summary' && entry.checked === true)
          const p0Checked = (changed.mins ?? []).some((entry) => entry.value === 'P0' && entry.checked === true)
          v22Check(
            'v2.2 切换发布方式为 summary（本地状态生效）',
            changed.mode === 'summary' && summaryChecked,
            JSON.stringify({ mode: changed.mode, summaryChecked, targetFound: modeTarget.found }).slice(0, 300),
          )
          v22Check(
            'v2.2 切换最低严重度为 P0（本地状态生效）',
            p0Checked,
            JSON.stringify({ min: changed.minValues, p0Checked, targetFound: minTarget.found }).slice(0, 300),
          )

          // --- 4) cancel: closes and never posts review-publish ----------
          const cancelTarget = await page.evaluate(publishCancelTarget())
          const cancelButton = cancelTarget.found ? cancelTarget : (changed.cancel ?? dialog.cancel)
          if (cancelButton) {
            await clickRect(page, cancelButton.rect)
            await delay(900)
          }
          const closed = await page.evaluate(publishDialogProbe())
          const rootState = await page.evaluate(`(() => { const root = document.querySelector('[data-cr-root]'); return root ? root.getAttribute('data-cr-publish-dialog') : null; })()`)
          v22Check(
            'v2.2 点击取消后弹层关闭（data-cr-publish-dialog=closed）',
            !closed.open && rootState === 'closed',
            JSON.stringify({ open: closed.open, rootState }),
          )
          const publishRequests = page.networkRequests.slice(netBefore).filter((request) => request.url.includes('/codex-review/review-publish'))
          v22.network.publishRequestsAfterCancel = publishRequests.length
          v22.network.publishRequests = publishRequests.map((request) => ({ url: request.url, method: request.method, postData: request.postData ?? null }))
          v22Check(
            'v2.2 发布弹层全程 0 个 review-publish 网络请求（无写操作）',
            publishRequests.length === 0,
            JSON.stringify(publishRequests.map((request) => request.url)),
          )
          await page.screenshot(options.v22Paths.cancel)
          v22.screenshots.cancel = options.v22Paths.cancel
        }
      }
    }

    // --- 5) auto-publish switch: open the second confirmation, then cancel --
    const settingsSurface = await page.evaluate(v11Surface())
    const gear = settingsSurface.settingsButtons?.[0]
    if (!gear) {
      v22Pending('v2.2 自动发布开关的二次确认', '未找到审查设置按钮')
      v22Pending('v2.2 自动发布开关流程不发 publish.enabled=true 请求', '未找到审查设置按钮')
    } else {
      await clickRect(page, gear.rect)
      await page.waitFor('document.querySelector("[role=\\"dialog\\"][aria-modal=\\"true\\"]") !== null', { timeoutMs: 8000, label: '设置弹层' }).catch(() => {})
      await delay(900)
      const section = await page.evaluate(autoPublishProbe())
      v22.autoPublish = section
      v22Check(
        'v2.2 设置弹层含「发布审查到 GitHub」自动发布区',
        Boolean(section.open && section.toggle),
        JSON.stringify({ open: section.open, dialogOpen: section.dialogOpen, toggle: section.toggle, text: String(section.text ?? '').slice(0, 200) }).slice(0, 420),
      )
      if (!section.open || !section.toggle) {
        v22Pending('v2.2 打开自动发布开关出现二次确认（data-auto-publish-confirm=ready）', '自动发布设置区/开关不存在')
        v22Pending('v2.2 二次确认取消后不发 publish.enabled=true 请求', '自动发布设置区/开关不存在')
      } else if (section.toggle.checked) {
        v22Pending('v2.2 打开自动发布开关出现二次确认（data-auto-publish-confirm=ready）', '自动发布当前已开启（操作者配置），按安全红线不改动写配置')
        v22Pending('v2.2 二次确认取消后不发 publish.enabled=true 请求', '自动发布当前已开启，未触发开关')
      } else {
        const statusBefore = await page.evaluate(autoPublishStatusProbe())
        v22.autoPublishStatusBefore = statusBefore
        const netBeforeToggle = page.networkRequests.length
        const toggleTarget = await page.evaluate(autoPublishToggleTarget())
        if (toggleTarget.found) {
          await clickRect(page, toggleTarget.rect)
          await delay(650)
        }
        const confirming = await page.evaluate(autoPublishProbe())
        v22.autoPublishConfirming = confirming
        v22Check(
          'v2.2 打开自动发布开关出现二次确认（data-auto-publish-confirm=ready）',
          Boolean(confirming.confirmOpen),
          JSON.stringify({ toggleFound: toggleTarget.found, toggleChecked: confirming.toggle?.checked ?? null, confirmOpen: confirming.confirmOpen }).slice(0, 300),
        )
        v22Check(
          'v2.2 二次确认含写操作警告文案',
          /写操作|write operation/i.test(String(confirming.confirm?.text ?? '')),
          String(confirming.confirm?.text ?? '').slice(0, 200),
        )
        await page.screenshot(options.v22Paths.autoPublish)
        v22.screenshots.autoPublish = options.v22Paths.autoPublish
        const confirmCancel = confirming.confirm?.cancelButton
        if (confirmCancel) {
          await clickRect(page, confirmCancel.rect)
          await delay(700)
        }
        const afterCancel = await page.evaluate(autoPublishProbe())
        v22.autoPublishAfterCancel = afterCancel
        v22Check(
          'v2.2 取消二次确认后确认块消失且开关未开启',
          !afterCancel.confirmOpen && afterCancel.toggle?.checked === false,
          JSON.stringify({ confirmOpen: afterCancel.confirmOpen, checked: afterCancel.toggle?.checked ?? null }),
        )
        const configRequests = page.networkRequests.slice(netBeforeToggle).filter((request) => request.url.includes('/codex-review/auto-review-config'))
        const enabling = configRequests.filter((request) => {
          try {
            return JSON.parse(request.postData ?? '{}')?.patch?.publish?.enabled === true
          } catch {
            return false
          }
        })
        v22.network.autoPublishConfigRequests = configRequests.map((request) => request.postData ?? '')
        v22.network.autoPublishEnableRequests = enabling.length
        v22Check(
          'v2.2 自动发布开关流程未发出 publish.enabled=true 的 auto-review-config 请求',
          enabling.length === 0,
          JSON.stringify(enabling.map((request) => request.postData ?? '')),
        )
        const statusAfter = await page.evaluate(autoPublishStatusProbe())
        v22.autoPublishStatusAfter = statusAfter
        if (!statusBefore.present || !statusAfter.present) {
          v22Pending('v2.2 自动发布状态未改变（data-auto-publish-status）', '页面未渲染自动发布状态（自动审查卡不可见）')
        } else if (v22.api.publish) {
          v22Check(
            'v2.2 自动审查卡发布状态与 Host 配置一致且未被本次流程改变',
            statusBefore.enabled === Boolean(v22.api.publish.enabled) && statusAfter.enabled === statusBefore.enabled,
            `before=${statusBefore.value}，after=${statusAfter.value}，Host=${String(v22.api.publish.enabled)}`,
          )
        } else {
          v22Check('v2.2 自动发布状态未被本次流程改变', statusAfter.enabled === statusBefore.enabled, `before=${statusBefore.value}，after=${statusAfter.value}`)
        }
      }
      // Close the settings dialog so the page is left in the pre-probe state.
      await page.evaluate(`(() => { const dialog = document.querySelector('[role="dialog"][aria-modal="true"]'); if (dialog) dialog.focus(); return true; })()`)
      await page.pressKey('Escape', { code: 'Escape', windowsVirtualKeyCode: 27 })
      await delay(700)
    }

    const errors = page.consoleMessages.filter((message) => message.type === 'error')
    const pageErrors = page.pageErrors
    report.consoleMessages = page.consoleMessages
    report.consoleErrors = errors
    report.pageErrors = pageErrors
    v22Check('v2.2 页面流程期间无 console.error', errors.length === 0, `${errors.length} 条`)
    v22Check('v2.2 页面流程期间无 pageerror', pageErrors.length === 0, `${pageErrors.length} 条`)
  } catch (error) {
    v22Check('v2.2 页面流程执行', false, error instanceof Error ? error.message : String(error))
    v22.error = error instanceof Error ? { message: error.message, stack: error.stack } : { message: String(error) }
  }
  v22.pendingCount = v22Checks.filter((entry) => entry.pending === true).length
  v22.failedCount = v22Checks.filter((entry) => entry.pending !== true && entry.pass === false).length
}

const options = parseCli()
const startedAt = Date.now()
const report = {
  harness: 'verify/click-panel.mjs',
  generatedAt: isoTimestamp(),
  url: options.url,
  viewport: { width: options.width, height: options.height },
  expected: options.expect,
  targetTexts: options.targets,
}
let browser
let page

try {
  const cookie = await cookieForUrl(options.url, { token: options.token, noAuth: options.noAuth })
  report.auth = cookie ? cookie.source : 'none'
  browser = await launchBrowser({
    width: options.width,
    height: options.height,
    headless: !options.headful,
    userDataDir: scratchDir(`click-panel-${timestampForFile()}-${process.pid}`),
  })
  page = await PageSession.open(browser.connection, { width: options.width, height: options.height })
  if (cookie) await page.setCookie(cookie, new URL(options.url).origin)

  const navigation = await page.goto(options.url, { timeoutMs: options.timeoutMs, settleMs: 0 })
  await page.waitFor('document.readyState === "complete"', { timeoutMs: 10_000, label: 'document.readyState=complete' }).catch(() => {})
  const bootWarnings = []
  try {
    await page.waitFor(
      `(() => { const text = document.body ? (document.body.innerText || '') : ''; return text.includes('插件') && (text.includes('工作区') || text.includes('Workspace')); })()`,
      { timeoutMs: 20_000, label: '侧栏渲染（插件/工作区）' },
    )
  } catch (error) {
    bootWarnings.push(error.message)
  }
  await page.waitForNetworkIdle({ timeoutMs: 10_000, idleMs: 600 }).catch(() => false)

  const modal = await dismissModals(page)
  await page.waitForNetworkIdle({ timeoutMs: 5000, idleMs: 500 }).catch(() => false)
  await page.screenshot(options.beforePath)

  const beforeState = await page.evaluate(pageState())
  const beforeLayout = await page.evaluate(layoutProbe())

  // Locate the sidebar entry by visible text; fall back to a left-column scan.
  const sidebarLookup = await page.evaluate(findSidebarTargets(options.targets))
  let target = sidebarLookup.targets?.[0] ?? null
  let targetSource = 'sidebar-text'
  let fallbackMatches = []
  if (!target) {
    fallbackMatches = await page.evaluate(findClickableInSidebar(options.targets))
    target = fallbackMatches[0] ?? null
    targetSource = 'left-region-scan'
  }
  const sidebarCandidates = await page.evaluate(interactiveSnapshot({ maxX: 420, limit: 120 }))
  report.modal = modal
  report.bootWarnings = bootWarnings
  report.navigation = { networkIdle: navigation.networkIdle, waitedMs: Date.now() - startedAt }
  report.before = {
    screenshot: options.beforePath,
    screenshotBytes: statSync(options.beforePath).size,
    title: beforeState.title,
    bodyTextLength: beforeState.bodyTextLength,
    hasDialog: beforeState.hasDialog,
    columnBands: beforeLayout.columnBands,
    panels: beforeLayout.columns,
  }
  report.lookup = {
    targetSource,
    found: Boolean(target),
    sidebarCandidates,
    fallbackMatches,
    matched: target
      ? { tag: target.tag, role: target.role, ariaLabel: target.ariaLabel, title: target.title, text: target.text, label: target.label, rect: target.rect }
      : null,
  }

  let clickDispatched = false
  let clickPoint = null
  if (target) {
    const viewport = await page.evaluate('({ width: window.innerWidth, height: window.innerHeight })')
    clickPoint = clickPointFor(target, viewport)
    await page.bringToFront()
    await page.click(clickPoint.x, clickPoint.y)
    clickDispatched = true
    await delay(500)
    await page.waitForNetworkIdle({ timeoutMs: 15_000, idleMs: 600 }).catch(() => false)
    await delay(options.waitMs)
  }
  await page.screenshot(options.afterPath)

  const afterState = await page.evaluate(pageState())
  const afterLayout = await page.evaluate(layoutProbe())
  const workbench = await page.evaluate(workbenchProbe())
  const sidebarAfter = await page.evaluate(interactiveSnapshot({ maxX: 420, limit: 120 }))
  const consoleErrors = page.consoleMessages.filter((message) => message.type === 'error')
  const consoleWarnings = page.consoleMessages.filter((message) => message.type === 'warning')
  const pageErrors = page.pageErrors
  const logProblems = page.logEntries.filter((entry) => entry.level === 'error' || entry.level === 'warning')
  const slotCrashed = Boolean(workbench.slotCrashed) || [...consoleErrors, ...pageErrors].some((entry) => /slot entry crashed|slot.*crashed/i.test(String(entry.text ?? entry.message ?? '')))
  const threeColumns = afterLayout.columnBands.length >= 3
  const workbenchDetected = threeColumns || Boolean(workbench.signals?.aiReview) || Boolean(workbench.signals?.tabs)
  const pageChanged = Boolean(target) && (
    afterState.url !== beforeState.url
    || afterState.bodyTextLength !== beforeState.bodyTextLength
    || afterLayout.columnBands.length !== beforeLayout.columnBands.length
    || JSON.stringify(afterLayout.columns.map((column) => [column.x, column.width])) !== JSON.stringify(beforeLayout.columns.map((column) => [column.x, column.width]))
  )

  report.click = { dispatched: clickDispatched, point: clickPoint, expect: options.expect }
  report.after = {
    screenshot: options.afterPath,
    screenshotBytes: statSync(options.afterPath).size,
    title: afterState.title,
    url: afterState.url,
    hasDialog: afterState.hasDialog,
    bodyTextLength: afterState.bodyTextLength,
    headings: afterState.headings,
    bodyTextSample: afterState.bodyTextSample,
    columnBands: afterLayout.columnBands,
    panels: afterLayout.columns,
    qualifyingCount: afterLayout.qualifyingCount,
    mainTextLength: workbench.mainTextLength,
    mainTextSample: workbench.mainTextSample,
    signals: workbench.signals,
    sidebarStillPresent: sidebarAfter.some((entry) => options.targets.some((keyword) => String(entry.label ?? '').includes(keyword))),
  }
  report.consoleMessages = page.consoleMessages
  report.consoleErrors = consoleErrors
  report.consoleWarnings = consoleWarnings
  report.pageErrors = pageErrors
  report.logProblems = logProblems
  report.failedRequests = page.failedRequests
  report.network = { requestCount: page.networkRequests.length, failedCount: page.failedRequests.length }

  // v1.1 page checks (opt-in): run against the already-rendered workbench.
  if (options.v11) await runV11Checks()
  // v2 page checks (opt-in): merge dialog (cancel only) + PR chat panel.
  if (options.v2) await runV2Checks()
  // v2.1 page checks (opt-in): auto-review settings/toggle/immediate check/badge/toast.
  if (options.v21) await runV21Checks()
  // v2.2 page checks (opt-in): publish dialog (cancel only) + auto-publish confirmation.
  if (options.v22) await runV22Checks()
  const finalConsoleErrors = page.consoleMessages.filter((message) => message.type === 'error')
  const finalConsoleWarnings = page.consoleMessages.filter((message) => message.type === 'warning')
  const finalPageErrors = page.pageErrors
  const finalLogProblems = page.logEntries.filter((entry) => entry.level === 'error' || entry.level === 'warning')
  report.consoleMessages = page.consoleMessages
  report.consoleErrors = finalConsoleErrors
  report.consoleWarnings = finalConsoleWarnings
  report.pageErrors = finalPageErrors
  report.logProblems = finalLogProblems
  report.failedRequests = page.failedRequests
  report.network = { requestCount: page.networkRequests.length, failedCount: page.failedRequests.length }

  const checks = [
    { name: '模态框已清除', pass: modal.dismissed, detail: modal.by },
    { name: '找到左栏「代码审查」入口', pass: Boolean(target), detail: target ? `${target.text || target.ariaLabel || target.title} @ ${target.rect.x},${target.rect.y}` : '未找到；见 report.lookup' },
    { name: '点击已派发', pass: clickDispatched, detail: clickPoint ? `${clickPoint.x},${clickPoint.y}` : '无目标' },
    { name: '点击后页面发生变化', pass: pageChanged, detail: `bodyText ${beforeState.bodyTextLength}→${afterState.bodyTextLength}；列带 ${beforeLayout.columnBands.join(',')}→${afterLayout.columnBands.join(',')}` },
    ...(options.expect === 'workbench'
      ? [{
          name: '三栏工作台已渲染',
          pass: workbenchDetected,
          detail: `threeColumns=${threeColumns} aiReview=${workbench.signals?.aiReview} tabs=${workbench.signals?.tabs} bands=${afterLayout.columnBands.join(',')}`,
        }]
      : []),
    { name: '无 pageerror', pass: finalPageErrors.length === 0, detail: `${finalPageErrors.length} 条` },
    { name: '无 console.error', pass: finalConsoleErrors.length === 0, detail: `${finalConsoleErrors.length} 条` },
    { name: '无 slot entry crashed', pass: !slotCrashed, detail: String(slotCrashed) },
    ...v11Checks,
    ...v2Checks,
    ...v21Checks,
    ...v22Checks,
  ]
  const decisive = checks.filter((check) => check.pending !== true)
  const ok = decisive.every((check) => check.pass)
  report.checks = checks
  report.verdict = {
    ok,
    failed: decisive.filter((check) => !check.pass).map((check) => check.name),
    passed: decisive.filter((check) => check.pass).length,
    pending: checks.filter((check) => check.pending === true).map((check) => check.name),
  }
  writeJson(options.reportPath, report)
  await page.close()

  const summary = {
    ok,
    url: options.url,
    target: options.targets[0],
    screenshotBefore: options.beforePath,
    screenshotAfter: options.afterPath,
    report: options.reportPath,
    modal: modal.by,
    targetSource,
    clickPoint,
    threeColumns,
    workbenchDetected,
    consoleErrors: finalConsoleErrors.length,
    pageErrors: finalPageErrors.length,
    slotCrashed,
    failedChecks: report.verdict.failed,
    pendingChecks: report.verdict.pending,
    v11: options.v11
      ? {
          enabled: true,
          failedCount: report.v11?.failedCount ?? 0,
          pendingCount: report.v11?.pendingCount ?? 0,
          screenshots: report.v11?.screenshots ?? {},
        }
      : null,
    v2: options.v2
      ? {
          enabled: true,
          failedCount: report.v2?.failedCount ?? 0,
          pendingCount: report.v2?.pendingCount ?? 0,
          screenshots: report.v2?.screenshots ?? {},
          mergeRequestsAfterCancel: report.v2?.network?.mergeRequestsAfterCancel ?? null,
          chatAssistantLength: String(report.v2?.chat?.assistantText ?? '').trim().length,
        }
      : null,
    v21: options.v21
      ? {
          enabled: true,
          failedCount: report.v21?.failedCount ?? 0,
          pendingCount: report.v21?.pendingCount ?? 0,
          screenshots: report.v21?.screenshots ?? {},
          configEnabledAfter: report.v21?.statusAfterDisable?.config?.enabled ?? null,
          recentCount: Array.isArray(report.v21?.statusAfterRun?.recent) ? report.v21.statusAfterRun.recent.length : null,
        }
      : null,
    v22: options.v22
      ? {
          enabled: true,
          failedCount: report.v22?.failedCount ?? 0,
          pendingCount: report.v22?.pendingCount ?? 0,
          screenshots: report.v22?.screenshots ?? {},
          publishable: report.v22?.publishable ? `${report.v22.publishable.repo}#${report.v22.publishable.number}` : null,
          publishRequestsAfterCancel: report.v22?.network?.publishRequestsAfterCancel ?? null,
          autoPublishEnableRequests: report.v22?.network?.autoPublishEnableRequests ?? null,
        }
      : null,
  }
  if (options.jsonOnly) console.log(JSON.stringify(summary))
  else {
    console.log(`${ok ? '✓' : '✗'} 面板点击检查完成（目标：${options.targets[0]}）`)
    console.log(JSON.stringify(summary, null, 2))
    if (!ok) {
      console.log('\n失败项：')
      for (const check of decisive.filter((entry) => !entry.pass)) console.log(`  - ${check.name}：${check.detail}`)
      if (report.verdict.pending.length > 0) {
        console.log('\nPending（v1.1 未生效/条件不满足）：')
        for (const check of checks.filter((entry) => entry.pending === true)) console.log(`  ○ ${check.name}：${check.detail}`)
      }
      if (!target) {
        console.log('\n左栏候选按钮（文本 / aria-label / title / 位置）：')
        for (const entry of sidebarCandidates.slice(0, 40)) {
          console.log(`  - text=${JSON.stringify(entry.text)} aria=${JSON.stringify(entry.ariaLabel)} title=${JSON.stringify(entry.title)} rect=${entry.rect.x},${entry.rect.y} ${entry.rect.width}x${entry.rect.height}`)
        }
        if (fallbackMatches.length > 0) {
          console.log('\n左栏文本匹配（非可点击祖先）：')
          for (const entry of fallbackMatches.slice(0, 20)) console.log(`  - ${JSON.stringify(entry.label)} tag=${entry.tag}`)
        }
      }
    }
  }
  process.exitCode = ok || options.allowConsoleErrors ? EXIT.OK : EXIT.FAIL
} catch (error) {
  console.error(`✗ 面板点击检查失败：${error instanceof Error ? error.message : String(error)}`)
  report.error = error instanceof Error ? { message: error.message, stack: error.stack } : { message: String(error) }
  report.verdict = { ok: false, harnessError: true }
  writeJson(options.reportPath, report)
  process.exitCode = EXIT.ENV
} finally {
  if (page) await page.close().catch(() => {})
  if (browser) await browser.close().catch(() => {})
}
