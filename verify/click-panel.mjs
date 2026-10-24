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
    { name: '无 pageerror', pass: pageErrors.length === 0, detail: `${pageErrors.length} 条` },
    { name: '无 console.error', pass: consoleErrors.length === 0, detail: `${consoleErrors.length} 条` },
    { name: '无 slot entry crashed', pass: !slotCrashed, detail: String(slotCrashed) },
  ]
  const ok = checks.every((check) => check.pass)
  report.checks = checks
  report.verdict = { ok, failed: checks.filter((check) => !check.pass).map((check) => check.name) }
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
    consoleErrors: consoleErrors.length,
    pageErrors: pageErrors.length,
    slotCrashed,
    failedChecks: report.verdict.failed,
  }
  if (options.jsonOnly) console.log(JSON.stringify(summary))
  else {
    console.log(`${ok ? '✓' : '✗'} 面板点击检查完成（目标：${options.targets[0]}）`)
    console.log(JSON.stringify(summary, null, 2))
    if (!ok) {
      console.log('\n失败项：')
      for (const check of checks.filter((entry) => !entry.pass)) console.log(`  - ${check.name}：${check.detail}`)
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
