#!/usr/bin/env node
/**
 * Page check: open the DSH Web GUI over CDP, collect console messages and page
 * errors from the very first byte, wait for the SPA to become stable, capture a
 * screenshot, and write a JSON report.
 *
 *   node verify/page-check.mjs --out-dir verify/baseline \
 *     --shot baseline-gui.png --report baseline-page-check.json
 *
 * Exit codes: 0 report written and clean (or console errors explicitly allowed),
 *             1 console/page errors detected, 2 harness/environment failure.
 */
import { parseArgs } from 'node:util'
import { statSync } from 'node:fs'
import path from 'node:path'
import { launchBrowser, PageSession } from './lib/cdp.mjs'
import { findSidebarTargets, interactiveSnapshot, pageState } from './lib/dom.mjs'
import { v11Surface } from './lib/v11-dom.mjs'
import { v2Surface } from './lib/v2-dom.mjs'
import { v21Surface, autoCardProbe, autoSettingsProbe } from './lib/v21-dom.mjs'
import { autoPublishProbe, v22Surface } from './lib/v22-dom.mjs'
import {
  cookieForUrl,
  EXIT,
  fail,
  isoTimestamp,
  isGuiUrl,
  OUT_ROOT,
  scratchDir,
  timestampForFile,
  writeJson,
} from './lib/util.mjs'

const USAGE = `用法: node verify/page-check.mjs [选项]

选项:
  --url <url>             目标页面（默认 http://127.0.0.1:2632）
  --out-dir <dir>         截图与报告的默认目录（默认 verify/out）
  --shot <png>            截图路径（相对 --out-dir；默认 page-check-<时间>.png）
  --report <json>         报告路径（相对 --out-dir；默认 page-check-<时间>.json）
  --width <px>            视口宽度（默认 1600）
  --height <px>           视口高度（默认 1100）
  --wait-ms <ms>          网络空闲后的稳定等待（默认 1600）
  --timeout-ms <ms>       导航与加载超时（默认 45000）
  --token <token>         DSH 启动 URL 里的 token（不传则用本机凭据自动认证）
  --no-auth               不注入 DSH 浏览器会话 cookie
  --headful               有窗口模式启动 Edge
  --allow-console-errors  存在 console/page error 时仍以 0 退出（报告中仍记录）
  --v11                   启用 v1.1 页面断言：左栏「代码审查」入口、工作台「用 AI 审查」/设置按钮、截图 v11-page-check.png
  --v2                    启用 v2 页面断言：合并按钮可点、对话输入框 placeholder、截图 v2-page-check.png
  --v21                   启用 v2.1 页面断言：自动审查卡/设置区存在、截图 v21-page-check.png
  --v22                   启用 v2.2 页面断言：发布能力属性/自动发布设置区存在、截图 v22-page-check.png
  --json                  只输出 JSON 摘要
  -h, --help              显示本帮助`

function parseCli() {
  let parsed
  try {
    parsed = parseArgs({
      allowPositionals: false,
      options: {
        url: { type: 'string', default: process.env.DSH_WEB_URL ?? 'http://127.0.0.1:2632' },
        'out-dir': { type: 'string', default: OUT_ROOT },
        shot: { type: 'string' },
        report: { type: 'string' },
        width: { type: 'string', default: '1600' },
        height: { type: 'string', default: '1100' },
        'wait-ms': { type: 'string', default: '1600' },
        'timeout-ms': { type: 'string', default: '45000' },
        token: { type: 'string' },
        'no-auth': { type: 'boolean', default: false },
        headful: { type: 'boolean', default: false },
        'allow-console-errors': { type: 'boolean', default: false },
        v11: { type: 'boolean', default: false },
        v2: { type: 'boolean', default: false },
        v21: { type: 'boolean', default: false },
        v22: { type: 'boolean', default: false },
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
  const outDir = path.resolve(values['out-dir'])
  const stamp = timestampForFile()
  const numeric = (name, fallback) => {
    const raw = values[name] ?? String(fallback)
    const value = Number(raw)
    if (!Number.isFinite(value) || value < 0) fail(`--${name} 必须是非负数字，收到 ${JSON.stringify(raw)}`, EXIT.ENV)
    return Math.round(value)
  }
  return {
    url: values.url,
    outDir,
    shotPath: path.resolve(outDir, values.shot ?? `page-check-${stamp}.png`),
    reportPath: path.resolve(outDir, values.report ?? `page-check-${stamp}.json`),
    width: numeric('width', 1600),
    height: numeric('height', 1100),
    waitMs: numeric('wait-ms', 1600),
    timeoutMs: numeric('timeout-ms', 45_000),
    token: values.token,
    noAuth: values['no-auth'],
    headful: values.headful,
    allowConsoleErrors: values['allow-console-errors'],
    v11: values.v11,
    v11ShotPath: path.resolve(outDir, 'v11-page-check.png'),
    v2: values.v2,
    v2ShotPath: path.resolve(outDir, 'v2-page-check.png'),
    v21: values.v21,
    v21ShotPath: path.resolve(outDir, 'v21-page-check.png'),
    v22: values.v22,
    v22ShotPath: path.resolve(outDir, 'v22-page-check.png'),
    jsonOnly: values.json,
  }
}

const options = parseCli()
const startedAt = Date.now()
let browser
let page
const report = {
  harness: 'verify/page-check.mjs',
  generatedAt: isoTimestamp(),
  url: options.url,
  viewport: { width: options.width, height: options.height },
}

try {
  const cookie = await cookieForUrl(options.url, { token: options.token, noAuth: options.noAuth })
  report.auth = cookie ? cookie.source : 'none'
  report.isGui = isGuiUrl(options.url)
  browser = await launchBrowser({
    width: options.width,
    height: options.height,
    headless: !options.headful,
    userDataDir: scratchDir(`page-check-${timestampForFile()}-${process.pid}`),
  })
  page = await PageSession.open(browser.connection, { width: options.width, height: options.height })
  if (cookie) await page.setCookie(cookie, new URL(options.url).origin)

  const navigation = await page.goto(options.url, { timeoutMs: options.timeoutMs, settleMs: 0 })
  await page.waitFor('document.readyState === "complete"', { timeoutMs: 10_000, label: 'document.readyState=complete' }).catch(() => {})
  await page.waitFor('!document.querySelector("#root") || document.querySelector("#root").children.length > 0', {
    timeoutMs: 20_000,
    label: '#root 渲染',
  }).catch(() => {})
  await new Promise((resolve) => setTimeout(resolve, options.waitMs))

  const title = await page.title()
  const state = await page.evaluate(pageState())
  const sidebar = await page.evaluate(interactiveSnapshot({ maxX: 420, limit: 120 }))
  await page.screenshot(options.shotPath)

  const consoleErrors = page.consoleMessages.filter((message) => message.type === 'error')
  const consoleWarnings = page.consoleMessages.filter((message) => message.type === 'warning')
  const logProblems = page.logEntries.filter((entry) => entry.level === 'error' || entry.level === 'warning')
  let ok = consoleErrors.length === 0 && page.pageErrors.length === 0

  Object.assign(report, {
    title,
    screenshot: options.shotPath,
    screenshotBytes: null,
    navigation: {
      networkIdle: navigation.networkIdle,
      waitedMs: Date.now() - startedAt,
      settleMs: options.waitMs,
    },
    dom: {
      readyState: state.readyState,
      rootChildren: state.rootChildren,
      hasDialog: state.hasDialog,
      dialogButtons: state.dialogButtons,
      bodyTextLength: state.bodyTextLength,
      headings: state.headings,
      bodyTextSample: state.bodyTextSample,
      sidebar,
    },
    consoleMessages: page.consoleMessages,
    consoleErrors,
    consoleWarnings,
    pageErrors: page.pageErrors,
    logProblems,
    failedRequests: page.failedRequests,
    network: {
      requestCount: page.networkRequests.length,
      failedCount: page.failedRequests.length,
      topHosts: [...new Set(page.networkRequests.map((request) => {
        try {
          return new URL(request.url).host
        } catch {
          return 'invalid-url'
        }
      }))].slice(0, 10),
    },
    verdict: {
      ok,
      consoleErrorCount: consoleErrors.length,
      consoleWarningCount: consoleWarnings.length,
      pageErrorCount: page.pageErrors.length,
      failedRequestCount: page.failedRequests.length,
      crashCount: page.crashCount,
    },
  })
  // -------------------------------------------------------------------------
  // v1.1 page assertions (CONTRACT §4.6 item 6): sidebar label + workbench
  // entry points. Opt-in; never fails the v1 regression run.
  // -------------------------------------------------------------------------
  if (options.v11) {
    const v11Checks = []
    const v11 = { enabled: true, checks: v11Checks, screenshots: {} }
    report.v11 = v11
    const v11Check = (name, pass, detail = '') => v11Checks.push({ name, pass: Boolean(pass), detail })
    try {
      const entryLookup = await page.evaluate(findSidebarTargets(['代码审查', 'Code Review']))
      const entry = entryLookup.targets?.[0]
      v11Check(
        'v1.1 左栏「代码审查」入口文案存在',
        Boolean(entry),
        entry ? `${entry.text || entry.ariaLabel} @ ${entry.rect.x},${entry.rect.y}` : 'not found',
      )
      if (entry) {
        await page.click(entry.rect.x + entry.rect.width / 2, entry.rect.y + entry.rect.height / 2)
        await page.waitForNetworkIdle({ timeoutMs: 20_000, idleMs: 700 }).catch(() => false)
        await new Promise((resolve) => setTimeout(resolve, 1200))
        const surface = await page.evaluate(v11Surface())
        v11.surface = surface
        v11Check('v1.1 工作台根节点就绪（data-cr-root）', surface.rootReady, JSON.stringify({ rootReady: surface.rootReady, rootTab: surface.rootTab, reviewState: surface.rootReviewState }))
        v11Check(
          'v1.1 工作台「用 AI 审查」按钮存在',
          surface.reviewTriggers.length > 0,
          JSON.stringify(surface.reviewTriggers.map((trigger) => trigger.text || trigger.aria)),
        )
        v11Check(
          'v1.1 工作台审查设置按钮存在',
          surface.settingsButtons.length > 0,
          JSON.stringify(surface.settingsButtons.map((button) => button.text || button.aria)),
        )
        await page.screenshot(options.v11ShotPath)
        v11.screenshots.page = options.v11ShotPath
        const finalErrors = page.consoleMessages.filter((message) => message.type === 'error')
        const finalPageErrors = page.pageErrors
        report.consoleMessages = page.consoleMessages
        report.consoleErrors = finalErrors
        report.pageErrors = finalPageErrors
        v11Check('v1.1 页面流程期间无 console.error', finalErrors.length === 0, `${finalErrors.length} 条`)
        v11Check('v1.1 页面流程期间无 pageerror', finalPageErrors.length === 0, `${finalPageErrors.length} 条`)
      }
    } catch (error) {
      v11Check('v1.1 页面流程执行', false, error instanceof Error ? error.message : String(error))
    }
    v11.pendingCount = v11Checks.filter((check) => check.pending === true).length
    v11.failedCount = v11Checks.filter((check) => check.pending !== true && check.pass === false).length
    ok = ok && v11.failedCount === 0
    report.verdict.ok = ok
    report.verdict.v11Failed = v11.failedCount
    report.verdict.v11Pending = v11.pendingCount
  }

  // -------------------------------------------------------------------------
  // v2 page assertions (CONTRACT §5.3/§5.4): merge button clickable + chat input.
  // -------------------------------------------------------------------------
  if (options.v2) {
    const v2Checks = []
    const v2 = { enabled: true, checks: v2Checks, screenshots: {} }
    report.v2 = v2
    const v2Check = (name, pass, detail = '') => v2Checks.push({ name, pass: Boolean(pass), detail })
    try {
      const rootReady = await page.evaluate(`Boolean(document.querySelector('[data-cr-root]'))`)
      if (!rootReady) {
        const entryLookup = await page.evaluate(findSidebarTargets(['代码审查', 'Code Review']))
        const entry = entryLookup.targets?.[0]
        if (entry) {
          await page.click(entry.rect.x + entry.rect.width / 2, entry.rect.y + entry.rect.height / 2)
          await page.waitForNetworkIdle({ timeoutMs: 20_000, idleMs: 700 }).catch(() => false)
          await new Promise((resolve) => setTimeout(resolve, 1500))
        }
      }
      const surface = await page.evaluate(v2Surface())
      v2.surface = surface
      v2Check(
        'v2 合并按钮存在且可点（非 disabled）',
        Boolean(surface.mergeButton && !surface.mergeButton.disabled),
        JSON.stringify(surface.mergeButton ?? null),
      )
      v2Check(
        'v2 底部输入框 placeholder=就此 Pull Request 提问',
        Boolean(surface.chatInput),
        JSON.stringify(surface.chatInput ?? null),
      )
      await page.screenshot(options.v2ShotPath)
      v2.screenshots.page = options.v2ShotPath
      const finalErrors = page.consoleMessages.filter((message) => message.type === 'error')
      const finalPageErrors = page.pageErrors
      report.consoleMessages = page.consoleMessages
      report.consoleErrors = finalErrors
      report.pageErrors = finalPageErrors
      v2Check('v2 页面流程期间无 console.error', finalErrors.length === 0, `${finalErrors.length} 条`)
      v2Check('v2 页面流程期间无 pageerror', finalPageErrors.length === 0, `${finalPageErrors.length} 条`)
    } catch (error) {
      v2Check('v2 页面流程执行', false, error instanceof Error ? error.message : String(error))
    }
    v2.pendingCount = v2Checks.filter((check) => check.pending === true).length
    v2.failedCount = v2Checks.filter((check) => check.pending !== true && check.pass === false).length
    ok = ok && v2.failedCount === 0
    report.verdict.ok = ok
    report.verdict.v2Failed = v2.failedCount
    report.verdict.v2Pending = v2.pendingCount
  }

  // -------------------------------------------------------------------------
  // v2.1 page assertions (CONTRACT §6.4/§6.5): auto-review card / settings section.
  // -------------------------------------------------------------------------
  if (options.v21) {
    const v21Checks = []
    const v21 = { enabled: true, checks: v21Checks, screenshots: {} }
    report.v21 = v21
    const v21Check = (name, pass, detail = '') => v21Checks.push({ name, pass: Boolean(pass), detail })
    try {
      const rootReady = await page.evaluate(`Boolean(document.querySelector('[data-cr-root]'))`)
      if (!rootReady) {
        const entryLookup = await page.evaluate(findSidebarTargets(['代码审查', 'Code Review']))
        const entry = entryLookup.targets?.[0]
        if (entry) {
          await page.click(entry.rect.x + entry.rect.width / 2, entry.rect.y + entry.rect.height / 2)
          await page.waitForNetworkIdle({ timeoutMs: 20_000, idleMs: 700 }).catch(() => false)
          await new Promise((resolve) => setTimeout(resolve, 1500))
        }
      }
      // The auto-review card lives in the right panel, which only renders once a
      // PR detail has loaded; wait for it before probing.
      await page.waitFor('document.querySelector("[data-cr-detail=\\"ready\\"]") !== null', { timeoutMs: 25_000, label: 'PR 详情加载' }).catch(() => {})
      await new Promise((resolve) => setTimeout(resolve, 1200))
      const surface = await page.evaluate(v21Surface())
      v21.surface = surface
      const card = await page.evaluate(autoCardProbe())
      v21.card = card
      v21Check(
        'v2.1 右栏自动审查卡存在',
        Boolean(card.open) || Boolean(surface.card),
        JSON.stringify({ card: Boolean(card.open), surfaceCard: Boolean(surface.card), root: surface.root }).slice(0, 400),
      )
      // The settings section lives inside the review-settings dialog.
      const settingsSurface = await page.evaluate(v11Surface())
      const gear = settingsSurface.settingsButtons?.[0]
      if (gear) {
        await page.click(gear.rect.x + gear.rect.width / 2, gear.rect.y + gear.rect.height / 2)
        await page.waitFor('document.querySelector("[role=\\"dialog\\"][aria-modal=\\"true\\"]") !== null', { timeoutMs: 8000, label: '设置弹层' }).catch(() => {})
        await new Promise((resolve) => setTimeout(resolve, 800))
      }
      const autoSettings = await page.evaluate(autoSettingsProbe())
      v21.autoSettings = autoSettings
      v21Check('v2.1 自动审查设置区存在', Boolean(autoSettings.open), JSON.stringify({ open: autoSettings.open, state: autoSettings.state, toggle: Boolean(autoSettings.toggle) }).slice(0, 300))
      await page.screenshot(options.v21ShotPath)
      v21.screenshots.page = options.v21ShotPath
      const finalErrors = page.consoleMessages.filter((message) => message.type === 'error')
      const finalPageErrors = page.pageErrors
      report.consoleMessages = page.consoleMessages
      report.consoleErrors = finalErrors
      report.pageErrors = finalPageErrors
      v21Check('v2.1 页面流程期间无 console.error', finalErrors.length === 0, `${finalErrors.length} 条`)
      v21Check('v2.1 页面流程期间无 pageerror', finalPageErrors.length === 0, `${finalPageErrors.length} 条`)
    } catch (error) {
      v21Check('v2.1 页面流程执行', false, error instanceof Error ? error.message : String(error))
    }
    v21.pendingCount = v21Checks.filter((check) => check.pending === true).length
    v21.failedCount = v21Checks.filter((check) => check.pending !== true && check.pass === false).length
    ok = ok && v21.failedCount === 0
    report.verdict.ok = ok
    report.verdict.v21Failed = v21.failedCount
    report.verdict.v21Pending = v21.pendingCount
  }

  // -------------------------------------------------------------------------
  // v2.2 page assertions (CONTRACT §7.3/§7.4): publish capability flag on the
  // workbench root + the auto-publish section inside the review-settings dialog.
  // -------------------------------------------------------------------------
  if (options.v22) {
    const v22Checks = []
    const v22 = { enabled: true, checks: v22Checks, screenshots: {} }
    report.v22 = v22
    const v22Check = (name, pass, detail = '') => v22Checks.push({ name, pass: Boolean(pass), detail })
    try {
      const rootReady = await page.evaluate(`Boolean(document.querySelector('[data-cr-root]'))`)
      if (!rootReady) {
        const entryLookup = await page.evaluate(findSidebarTargets(['代码审查', 'Code Review']))
        const entry = entryLookup.targets?.[0]
        if (entry) {
          await page.click(entry.rect.x + entry.rect.width / 2, entry.rect.y + entry.rect.height / 2)
          await page.waitForNetworkIdle({ timeoutMs: 20_000, idleMs: 700 }).catch(() => false)
          await new Promise((resolve) => setTimeout(resolve, 1500))
        }
      }
      // The flag only turns true once /auto-review-status delivered the publish
      // config (the same status feeds the settings section); wait for it, but a
      // false value is still recorded rather than treated as a harness failure.
      await page.waitFor('document.querySelector("[data-cr-detail=\\"ready\\"]") !== null', { timeoutMs: 25_000, label: 'PR 详情加载' }).catch(() => {})
      await page.waitFor(
        '(() => { const root = document.querySelector("[data-cr-root]"); return Boolean(root) && root.getAttribute("data-cr-publish-supported") === "true"; })()',
        { timeoutMs: 25_000, label: '发布能力就绪' },
      ).catch(() => {})
      await new Promise((resolve) => setTimeout(resolve, 1200))
      const surface = await page.evaluate(v22Surface())
      v22.surface = surface
      v22Check(
        'v2.2 工作台暴露 [data-cr-publish-supported]（true/false 均记录）',
        surface.rootReady && (surface.supported === 'true' || surface.supported === 'false'),
        JSON.stringify({ rootReady: surface.rootReady, supported: surface.supported, dialog: surface.dialog, publishButton: Boolean(surface.publishButton), published: surface.publishedFlag }).slice(0, 300),
      )
      // The auto-publish section lives inside the review-settings dialog.
      const settingsSurface = await page.evaluate(v11Surface())
      const gear = settingsSurface.settingsButtons?.[0]
      if (!gear) {
        v22Check('v2.2 设置弹层含自动发布区（data-auto-publish-section=ready）', false, '未找到审查设置按钮')
      } else {
        await page.click(gear.rect.x + gear.rect.width / 2, gear.rect.y + gear.rect.height / 2)
        await page.waitFor('document.querySelector("[role=\\"dialog\\"][aria-modal=\\"true\\"]") !== null', { timeoutMs: 8000, label: '设置弹层' }).catch(() => {})
        await new Promise((resolve) => setTimeout(resolve, 900))
        const autoPublish = await page.evaluate(autoPublishProbe())
        v22.autoPublish = autoPublish
        v22Check(
          'v2.2 设置弹层含自动发布区（data-auto-publish-section=ready）',
          Boolean(autoPublish.open),
          `${JSON.stringify({ open: autoPublish.open, dialogOpen: autoPublish.dialogOpen, toggle: Boolean(autoPublish.toggle), supported: surface.supported, text: String(autoPublish.text || '').slice(0, 160) })}${autoPublish.open ? '' : '；提示：客户端要求 /auto-review-status 的顶层 publish，Host 只返回 config.publish 时该区不会渲染'}`,
        )
      }
      await page.screenshot(options.v22ShotPath)
      v22.screenshots.page = options.v22ShotPath
      const finalErrors = page.consoleMessages.filter((message) => message.type === 'error')
      const finalPageErrors = page.pageErrors
      report.consoleMessages = page.consoleMessages
      report.consoleErrors = finalErrors
      report.pageErrors = finalPageErrors
      v22Check('v2.2 页面流程期间无 console.error', finalErrors.length === 0, `${finalErrors.length} 条`)
      v22Check('v2.2 页面流程期间无 pageerror', finalPageErrors.length === 0, `${finalPageErrors.length} 条`)
    } catch (error) {
      v22Check('v2.2 页面流程执行', false, error instanceof Error ? error.message : String(error))
    }
    v22.pendingCount = v22Checks.filter((check) => check.pending === true).length
    v22.failedCount = v22Checks.filter((check) => check.pending !== true && check.pass === false).length
    ok = ok && v22.failedCount === 0
    report.verdict.ok = ok
    report.verdict.v22Failed = v22.failedCount
    report.verdict.v22Pending = v22.pendingCount
  }

  report.screenshotBytes = statSync(options.shotPath).size
  writeJson(options.reportPath, report)
  await page.close()

  const summary = {
    ok,
    url: options.url,
    title,
    screenshot: options.shotPath,
    report: options.reportPath,
    consoleErrors: report.consoleErrors.length,
    consoleWarnings: consoleWarnings.length,
    pageErrors: report.pageErrors.length,
    failedRequests: page.failedRequests.length,
    hasDialog: state.hasDialog,
    sidebarInteractiveCount: sidebar.length,
    auth: report.auth,
    v11: options.v11
      ? {
          failedCount: report.v11?.failedCount ?? 0,
          pendingCount: report.v11?.pendingCount ?? 0,
          screenshot: report.v11?.screenshots?.page ?? null,
        }
      : null,
    v2: options.v2
      ? {
          failedCount: report.v2?.failedCount ?? 0,
          pendingCount: report.v2?.pendingCount ?? 0,
          screenshot: report.v2?.screenshots?.page ?? null,
          checks: (report.v2?.checks ?? []).map((check) => ({ name: check.name, pass: check.pass })),
        }
      : null,
    v21: options.v21
      ? {
          failedCount: report.v21?.failedCount ?? 0,
          pendingCount: report.v21?.pendingCount ?? 0,
          screenshot: report.v21?.screenshots?.page ?? null,
          checks: (report.v21?.checks ?? []).map((check) => ({ name: check.name, pass: check.pass })),
        }
      : null,
    v22: options.v22
      ? {
          failedCount: report.v22?.failedCount ?? 0,
          pendingCount: report.v22?.pendingCount ?? 0,
          screenshot: report.v22?.screenshots?.page ?? null,
          publishSupported: report.v22?.surface?.supported ?? null,
          autoPublishSection: Boolean(report.v22?.autoPublish?.open),
          checks: (report.v22?.checks ?? []).map((check) => ({ name: check.name, pass: check.pass })),
        }
      : null,
  }
  if (options.jsonOnly) console.log(JSON.stringify(summary))
  else {
    console.log(`${ok ? '✓' : '✗'} 页面检查完成：${title || '(无标题)'}`)
    console.log(JSON.stringify(summary, null, 2))
  }
  process.exitCode = ok || options.allowConsoleErrors ? EXIT.OK : EXIT.FAIL
} catch (error) {
  console.error(`✗ 页面检查失败：${error instanceof Error ? error.message : String(error)}`)
  report.error = error instanceof Error ? { message: error.message, stack: error.stack } : { message: String(error) }
  report.verdict = { ok: false, harnessError: true }
  writeJson(options.reportPath, report)
  process.exitCode = EXIT.ENV
} finally {
  if (page) await page.close().catch(() => {})
  if (browser) await browser.close().catch(() => {})
}
