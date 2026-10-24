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
import { interactiveSnapshot, pageState } from './lib/dom.mjs'
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
  const ok = consoleErrors.length === 0 && page.pageErrors.length === 0

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
  report.screenshotBytes = statSync(options.shotPath).size
  writeJson(options.reportPath, report)
  await page.close()

  const summary = {
    ok,
    url: options.url,
    title,
    screenshot: options.shotPath,
    report: options.reportPath,
    consoleErrors: consoleErrors.length,
    consoleWarnings: consoleWarnings.length,
    pageErrors: page.pageErrors.length,
    failedRequests: page.failedRequests.length,
    hasDialog: state.hasDialog,
    sidebarInteractiveCount: sidebar.length,
    auth: report.auth,
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
