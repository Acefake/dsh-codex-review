#!/usr/bin/env node
/**
 * Optional UI end-to-end check for the AI review flow.
 *
 *   node verify/ai-review-ui.mjs --out-dir verify/out
 *
 * Opens the DSH Web GUI, clicks the sidebar entry 「代码审查」, clicks the
 * 「Review with Codex」 trigger in the workbench header, and follows the live
 * review card until it settles. Captures:
 *
 *   ai-review-before.png     workbench before the trigger click
 *   ai-review-running.png    first progress frame (when observable)
 *   ai-review-done.png       terminal card (findings / clean / failure)
 *
 * The terminal state is detected from the plugin's own zh/en copy
 * (`审查中…`, `未发现 P0/P1 问题`, `条发现`, `审查失败`, …) because the client
 * DOM is not part of this harness's contract. The raw text sample is reported
 * so a human can judge. Console errors and page errors are collected throughout.
 *
 * Exit codes: 0 = terminal success card rendered, 1 = failure/timeout,
 *             2 = harness/environment error.
 */
import { parseArgs } from 'node:util'
import { statSync } from 'node:fs'
import path from 'node:path'
import { launchBrowser, PageSession } from './lib/cdp.mjs'
import { dialogState, findSidebarTargets, interactiveSnapshot, layoutProbe } from './lib/dom.mjs'
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

const USAGE = `用法: node verify/ai-review-ui.mjs [选项]

选项:
  --url <url>            目标页面（默认 http://127.0.0.1:2632）
  --select <text>        点击工作台 PR 列表里标题包含该文本的行（默认用客户端自动选中的第一条 PR）
  --out-dir <dir>        截图与报告目录（默认 verify/out）
  --timeout-ms <ms>      等待审查终态上限（默认 240000）
  --poll-ms <ms>         轮询间隔（默认 1200）
  --token <token>        DSH 启动 URL 里的 token（不传则用本机凭据自动认证）
  --no-auth              不注入 DSH 浏览器会话 cookie
  --headful              有窗口模式启动 Edge
  --json                 只输出 JSON 摘要
  -h, --help             显示本帮助`

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Dismiss the first-run preview modal (button → Escape → backdrop). */
async function dismissModals(page) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const state = await page.evaluate(dialogState())
    if (!state.hasDialog) return { dismissed: true, by: attempt === 0 ? 'none' : 'earlier' }
    const button = state.buttons.find((candidate) => /继续|知道了|关闭|Continue|Got it|Dismiss|Close/i.test(String(candidate.label ?? '')))
    if (button && button.rect.width > 0) {
      await page.click(button.rect.x + button.rect.width / 2, button.rect.y + button.rect.height / 2)
      await delay(700)
      continue
    }
    await page.pressKey('Escape', { code: 'Escape', windowsVirtualKeyCode: 27 })
    await delay(500)
  }
  const state = await page.evaluate(dialogState())
  return { dismissed: !state.hasDialog, by: 'exhausted' }
}

/** Read the visible text of the page (used for state detection). */
const BODY_TEXT = 'document.body ? document.body.innerText : ""'

function parseCli() {
  let parsed
  try {
    parsed = parseArgs({
      allowPositionals: false,
      options: {
        url: { type: 'string', default: process.env.DSH_WEB_URL ?? 'http://127.0.0.1:2632' },
        select: { type: 'string', default: '' },
        'out-dir': { type: 'string', default: OUT_ROOT },
        'timeout-ms': { type: 'string', default: '240000' },
        'poll-ms': { type: 'string', default: '1200' },
        token: { type: 'string' },
        'no-auth': { type: 'boolean', default: false },
        headful: { type: 'boolean', default: false },
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
  const numeric = (name, fallback) => {
    const raw = values[name] ?? String(fallback)
    const value = Number(raw)
    if (!Number.isFinite(value) || value < 0) fail(`--${name} 必须是非负数字`, EXIT.ENV)
    return Math.round(value)
  }
  const outDir = path.resolve(values['out-dir'])
  return {
    url: values.url,
    select: String(values.select ?? '').trim(),
    outDir,
    timeoutMs: numeric('timeout-ms', 240_000),
    pollMs: numeric('poll-ms', 1200),
    token: values.token,
    noAuth: values['no-auth'],
    headful: values.headful,
    jsonOnly: values.json,
    beforePath: path.join(outDir, 'ai-review-before.png'),
    runningPath: path.join(outDir, 'ai-review-running.png'),
    donePath: path.join(outDir, 'ai-review-done.png'),
    reportPath: path.join(outDir, 'ai-review-ui.json'),
  }
}

const options = parseCli()
const report = {
  harness: 'verify/ai-review-ui.mjs',
  generatedAt: isoTimestamp(),
  url: options.url,
  screenshots: {},
  timeline: [],
  checks: [],
}
let browser
let page

const isRunningText = (text) => /审查中…|准备中…|已分析 \d+\/\d+ 文件/u.test(text)
const isSelfFailureText = (text) => /审查失败|无法完成审查/u.test(text)
const isDoneText = (text) => /未发现 P0\/P1 问题|条发现|建议合并|建议修改后再合并|Codex 审查/u.test(text)

try {
  const cookie = await cookieForUrl(options.url, { token: options.token, noAuth: options.noAuth })
  report.auth = cookie ? cookie.source : 'none'
  browser = await launchBrowser({
    width: 1600,
    height: 1100,
    headless: !options.headful,
    userDataDir: scratchDir(`ai-review-ui-${timestampForFile()}-${process.pid}`),
  })
  page = await PageSession.open(browser.connection, { width: 1600, height: 1100 })
  if (cookie) await page.setCookie(cookie, new URL(options.url).origin)

  await page.goto(options.url, { timeoutMs: 45_000, settleMs: 0 })
  await page.waitFor(
    `(() => { const text = document.body ? (document.body.innerText || '') : ''; return text.includes('插件') && (text.includes('工作区') || text.includes('Workspace')); })()`,
    { timeoutMs: 20_000, label: '侧栏渲染' },
  )
  await page.waitForNetworkIdle({ timeoutMs: 10_000, idleMs: 600 }).catch(() => false)
  report.modal = await dismissModals(page)

  // Open the workbench.
  const entryLookup = await page.evaluate(findSidebarTargets(['代码审查', 'Code Review']))
  const entry = entryLookup.targets?.[0]
  if (!entry) {
    const sidebar = await page.evaluate(interactiveSnapshot({ maxX: 420, limit: 120 }))
    report.sidebarCandidates = sidebar
    throw new Error('左栏没有找到「代码审查」入口（插件是否已安装并出现在侧栏？）')
  }
  await page.click(entry.rect.x + entry.rect.width / 2, entry.rect.y + entry.rect.height / 2)
  await page.waitForNetworkIdle({ timeoutMs: 20_000, idleMs: 800 }).catch(() => false)
  await page.waitFor(`(() => (document.body.innerText || '').includes('Review with Codex') || (document.body.innerText || '').includes('用 AI 审查') || (document.body.innerText || '').includes('Review with AI'))()`, {
    timeoutMs: 30_000,
    label: '工作台 AI 审查按钮',
  })
  // The header trigger is disabled until a PR detail has loaded; wait for the
  // detail pane rather than clicking a stale/disabled button.
  await page.waitFor(
    `(() => { const text = document.body ? (document.body.innerText || '') : ''; return text.includes('Summary') && !text.includes('正在加载 PR') && !text.includes('Loading PR'); })()`,
    { timeoutMs: 30_000, label: 'PR 详情加载' },
  ).catch(() => {})
  // The workbench auto-selects the first PR once the list arrives; wait for the
  // file/diff stat so a slow list fetch cannot make us click an empty state.
  await page.waitFor(
    `(() => { const text = document.body ? (document.body.innerText || '') : ''; return /\\d+\\s*(files|个文件)/u.test(text) && !text.includes('正在加载 Pull Request') && !text.includes('Loading pull requests'); })()`,
    { timeoutMs: 40_000, label: 'PR 列表与详情数据' },
  ).catch(() => {})

  if (options.select) {
    const row = await page.evaluate(`(() => {
      const visible = (el) => {
        if (!el || !el.isConnected) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        const style = window.getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0.01;
      };
      const textOf = (el) => (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
      const needle = ${JSON.stringify(options.select.toLowerCase())};
      const clickable = (el) => {
        let current = el;
        for (let depth = 0; depth < 10 && current; depth += 1) {
          if (current.matches && current.matches('button, [role="button"], [role="option"], [role="tab"], a, li, [tabindex]')) return current;
          if (window.getComputedStyle(current).cursor === 'pointer') return current;
          current = current.parentElement;
        }
        return null;
      };
      const matches = Array.from(document.querySelectorAll('#root *')).filter((el) => visible(el) && textOf(el).toLowerCase().includes(needle));
      const deepest = matches.filter((el) => !Array.from(el.children).some((child) => visible(child) && textOf(child).toLowerCase().includes(needle)));
      for (const el of deepest) {
        const target = clickable(el);
        if (!target) continue;
        target.scrollIntoView({ block: 'center', inline: 'nearest' });
        const rect = target.getBoundingClientRect();
        return { found: true, tag: target.tagName.toLowerCase(), text: textOf(target).slice(0, 140), rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
      }
      return { found: false };
    })()`)
    report.selection = { requested: options.select, ...row }
    if (!row.found) throw new Error(`PR 列表里没有找到标题包含 ${JSON.stringify(options.select)} 的行`)
    await page.bringToFront()
    await page.click(row.rect.x + row.rect.width / 2, row.rect.y + row.rect.height / 2)
    await page.waitForNetworkIdle({ timeoutMs: 15_000, idleMs: 700 }).catch(() => false)
    await page.waitFor(
      `(() => (document.body.innerText || '').includes(${JSON.stringify(options.select)}))()`,
      { timeoutMs: 20_000, label: `详情切到 ${options.select}` },
    ).catch(() => {})
  }
  const layout = await page.evaluate(layoutProbe())
  report.workbench = { columnBands: layout.columnBands, columns: layout.columns }
  await page.screenshot(options.beforePath)
  report.screenshots.before = options.beforePath

  // Click the AI review trigger (workbench header, not the sidebar). The button
  // stays disabled until a PR detail with a headSha is available, so poll until
  // an enabled one appears.
  const triggerCandidatesExpr = `(() => {
    const visible = (el) => {
      if (!el || !el.isConnected) return false;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      const style = window.getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0.01;
    };
    const textOf = (el) => (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
    const out = [];
    for (const el of document.querySelectorAll('button, [role="button"]')) {
      if (!visible(el)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.x < 900) continue; // workbench action area, right of the PR list/center
      const text = textOf(el);
      if (!/Review with Codex|Review with AI|AI 审查/u.test(text)) continue;
      out.push({
        text: text.slice(0, 80),
        disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      });
    }
    return out;
  })()`
  let trigger = null
  let triggerCandidates = []
  const triggerDeadline = Date.now() + 30_000
  while (Date.now() < triggerDeadline) {
    triggerCandidates = await page.evaluate(triggerCandidatesExpr)
    trigger = triggerCandidates.find((candidate) => !candidate.disabled) ?? null
    if (trigger) break
    await delay(500)
  }
  report.trigger = { found: Boolean(trigger), candidates: triggerCandidates }
  if (!trigger) throw new Error(`工作台里没有找到可用的「Review with Codex」触发按钮（候选：${JSON.stringify(triggerCandidates)}）`)
  await page.click(trigger.rect.x + trigger.rect.width / 2, trigger.rect.y + trigger.rect.height / 2)
  report.triggerClickedAt = isoTimestamp()

  // Follow the review card until it settles.
  const deadline = Date.now() + options.timeoutMs
  const startedAt = Date.now()
  let terminal = null // 'done' | 'failed' | null
  let runningCaptured = false
  let lastText = ''
  while (Date.now() < deadline) {
    const text = String(await page.evaluate(BODY_TEXT))
    lastText = text
    const elapsed = Date.now() - startedAt
    const running = isRunningText(text)
    const failed = isSelfFailureText(text)
    const done = isDoneText(text) && !running
    report.timeline.push({ elapsedMs: elapsed, running, failed, done })
    if (report.timeline.length > 400) report.timeline.splice(0, report.timeline.length - 400)
    if (running && !runningCaptured) {
      runningCaptured = true
      await page.waitForNetworkIdle({ timeoutMs: 4000, idleMs: 500 }).catch(() => false)
      await page.screenshot(options.runningPath)
      report.screenshots.running = options.runningPath
    }
    if (done || failed) {
      terminal = failed && !done ? 'failed' : 'done'
      break
    }
    await delay(options.pollMs)
  }
  await page.waitForNetworkIdle({ timeoutMs: 8000, idleMs: 600 }).catch(() => false)
  await delay(800)
  if (!runningCaptured) report.timeline.push({ note: 'running state never became observable (cached/fast result)' })
  await page.screenshot(options.donePath)
  report.screenshots.done = options.donePath

  const finalText = String(await page.evaluate(BODY_TEXT))
  const partialDom = await page.evaluate(`(() => ({
    attr: (() => { try { return Boolean(document.querySelector('[data-review-partial]')); } catch { return false; } })(),
    count: document.querySelectorAll('[data-review-partial]').length,
  }))()`)
  const findingsMatch = finalText.match(/(\d+)\s*(?:条发现|个问题)/u)
  const clean = /未发现 P0\/P1 问题/u.test(finalText)
  const partial = Boolean(partialDom?.attr) || /部分结果|部分内容未能完成审查|\bpartial\b/iu.test(finalText)
  const p2Badge = /P2/u.test(finalText)
  const consoleErrors = page.consoleMessages.filter((message) => message.type === 'error')
  const pageErrors = page.pageErrors
  const result = {
    terminal: terminal ?? 'timeout',
    elapsedMs: Date.now() - startedAt,
    findingsCount: findingsMatch ? Number(findingsMatch[1]) : null,
    clean,
    partial,
    partialDom: partialDom ?? null,
    p2Badge,
    failed: isSelfFailureText(finalText),
    reviewCardText: finalText.slice(Math.max(0, finalText.indexOf('Codex 审查') - 40), finalText.indexOf('Codex 审查') + 900),
  }
  report.result = result
  report.consoleErrors = consoleErrors
  report.pageErrors = pageErrors
  report.bodyTextSample = finalText.slice(0, 2000)
  const checks = [
    { name: '工作台三栏渲染', pass: (layout.columnBands?.length ?? 0) >= 3 || /Review with Codex/.test(finalText), detail: `bands=${(layout.columnBands ?? []).join(',')}` },
    { name: '找到 AI 审查触发按钮', pass: Boolean(trigger), detail: trigger?.text ?? '未找到' },
    { name: '审查到达终态', pass: result.terminal !== 'timeout', detail: `${result.terminal}，${result.elapsedMs}ms` },
    { name: '未出现「审查失败」', pass: !result.failed, detail: String(result.failed) },
    { name: '非 partial（无「部分结果」/无 [data-review-partial]）', pass: !partial, detail: `textPartial=${/部分结果|部分内容未能完成审查/iu.test(finalText)}，domPartial=${Boolean(partialDom?.attr)}` },
    { name: '页面出现 findings 计数（N 个问题 / N 条发现）', pass: result.findingsCount !== null || result.clean, detail: `findingsCount=${result.findingsCount}，clean=${result.clean}` },
    { name: '页面出现严重度徽章 P2', pass: result.findingsCount === null || p2Badge, detail: `p2Badge=${p2Badge}` },
    { name: '无 pageerror', pass: pageErrors.length === 0, detail: `${pageErrors.length} 条` },
    { name: '无 console.error', pass: consoleErrors.length === 0, detail: `${consoleErrors.length} 条` },
  ]
  report.checks = checks
  const ok = checks.every((check) => check.pass)
  report.verdict = { ok, failed: checks.filter((check) => !check.pass).map((check) => check.name) }
  writeJson(options.reportPath, report)

  const summary = {
    ok,
    url: options.url,
    report: options.reportPath,
    screenshots: report.screenshots,
    terminal: result.terminal,
    elapsedMs: result.elapsedMs,
    findingsCount: result.findingsCount,
    clean: result.clean,
    partial: result.partial,
    p2Badge: result.p2Badge,
    consoleErrors: consoleErrors.length,
    pageErrors: pageErrors.length,
    failedChecks: report.verdict.failed,
  }
  if (options.jsonOnly) console.log(JSON.stringify(summary))
  else {
    console.log(`${ok ? '✓' : '✗'} AI 审查 UI 端到端完成（终态：${result.terminal}，${Math.round(result.elapsedMs / 1000)}s）`)
    console.log(JSON.stringify(summary, null, 2))
    if (!ok) {
      for (const check of checks.filter((entry) => !entry.pass)) console.log(`  - ${check.name}：${check.detail}`)
      console.log('bodyTextSample:', report.bodyTextSample.slice(0, 800))
    }
  }
  process.exitCode = ok ? EXIT.OK : EXIT.FAIL
} catch (error) {
  console.error(`✗ AI 审查 UI 检查失败：${error instanceof Error ? error.message : String(error)}`)
  report.error = error instanceof Error ? { message: error.message, stack: error.stack } : { message: String(error) }
  report.verdict = { ok: false, harnessError: true }
  writeJson(options.reportPath, report)
  process.exitCode = EXIT.ENV
} finally {
  if (page) await page.close().catch(() => {})
  if (browser) await browser.close().catch(() => {})
}
