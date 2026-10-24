#!/usr/bin/env node
/**
 * Headless Edge screenshot CLI.
 *
 *   node verify/shot.mjs --url http://127.0.0.1:2632 --out verify/out/gui.png
 *
 * Waits for the load event, network quiet, the SPA root to render, and an extra
 * `--wait-ms` settle window before capturing a 1600×1100 PNG (configurable).
 * When the target is the DSH Web GUI the browser-session cookie is resolved
 * automatically (launch token or local credentials; see `lib/auth.mjs`).
 *
 * Exits 0 on success, 2 on any argument/environment/capture failure.
 */
import { parseArgs } from 'node:util'
import path from 'node:path'
import { launchBrowser, PageSession } from './lib/cdp.mjs'
import { cookieForUrl, ensureParent, EXIT, fail, isGuiUrl, scratchDir, timestampForFile } from './lib/util.mjs'

const USAGE = `用法: node verify/shot.mjs --url <url> --out <png> [选项]

选项:
  --url <url>          要截图的页面（默认 http://127.0.0.1:2632）
  --out <png>          截图输出路径（必填）
  --width <px>         视口宽度（默认 1600）
  --height <px>        视口高度（默认 1100）
  --wait-ms <ms>       网络空闲后再等待的稳定时间（默认 1200）
  --timeout-ms <ms>    导航与加载超时（默认 45000）
  --full-page          截取整页而不是视口
  --token <token>      DSH 启动 URL 里的 token（不传则用本机凭据自动认证）
  --no-auth            不注入 DSH 浏览器会话 cookie
  --headful            用有窗口模式启动 Edge（排查渲染差异时用）
  --json               只输出 JSON 摘要
  -h, --help           显示本帮助`

function parseCli() {
  let parsed
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        url: { type: 'string', default: process.env.DSH_WEB_URL ?? 'http://127.0.0.1:2632' },
        out: { type: 'string' },
        width: { type: 'string', default: '1600' },
        height: { type: 'string', default: '1100' },
        'wait-ms': { type: 'string', default: '1200' },
        'timeout-ms': { type: 'string', default: '45000' },
        'full-page': { type: 'boolean', default: false },
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
  const { values, positionals } = parsed
  if (values.help) {
    console.log(USAGE)
    process.exit(EXIT.OK)
  }
  const url = positionals[0] ?? values.url
  const out = values.out ?? positionals[1]
  if (!out) fail(`缺少 --out <png>\n\n${USAGE}`, EXIT.ENV)
  const width = Number(values.width)
  const height = Number(values.height)
  const waitMs = Number(values['wait-ms'])
  const timeoutMs = Number(values['timeout-ms'])
  for (const [label, value] of [['width', width], ['height', height], ['wait-ms', waitMs], ['timeout-ms', timeoutMs]]) {
    if (!Number.isFinite(value) || value < 0) fail(`--${label} 必须是非负数字，收到 ${JSON.stringify(values[label])}`, EXIT.ENV)
  }
  return {
    url,
    out: path.resolve(out),
    width: Math.round(width),
    height: Math.round(height),
    waitMs: Math.round(waitMs),
    timeoutMs: Math.round(timeoutMs),
    fullPage: values['full-page'],
    token: values.token,
    noAuth: values['no-auth'],
    headful: values.headful,
    jsonOnly: values.json,
  }
}

const options = parseCli()
let browser
try {
  const cookie = await cookieForUrl(options.url, { token: options.token, noAuth: options.noAuth })
  browser = await launchBrowser({
    width: options.width,
    height: options.height,
    headless: !options.headful,
    userDataDir: scratchDir(`shot-${timestampForFile()}-${process.pid}`),
  })
  const page = await PageSession.open(browser.connection, { width: options.width, height: options.height })
  if (cookie) {
    await page.setCookie(cookie, new URL(options.url).origin)
    if (!options.jsonOnly) console.error(`· 使用浏览器会话 cookie（来源：${cookie.source}）`)
  }
  const navigation = await page.goto(options.url, { timeoutMs: options.timeoutMs, settleMs: 0 })
  // The DSH GUI boots into `#root`; wait briefly for a first paint before the
  // caller-requested settle window. Non-GUI targets may not have a root node.
  await page.waitFor('document.readyState === "complete"', { timeoutMs: 10_000, label: 'document.readyState=complete' }).catch(() => {})
  await page.waitFor('!document.querySelector("#root") || document.querySelector("#root").children.length > 0', {
    timeoutMs: 15_000,
    label: '#root 渲染',
  }).catch(() => {})
  await new Promise((resolve) => setTimeout(resolve, options.waitMs))

  const title = await page.title()
  ensureParent(options.out)
  await page.screenshot(options.out, { fullPage: options.fullPage })
  const consoleErrors = page.consoleMessages.filter((message) => message.type === 'error')
  const summary = {
    ok: true,
    url: options.url,
    title,
    out: options.out,
    width: options.width,
    height: options.height,
    waitMs: options.waitMs,
    networkIdle: navigation.networkIdle,
    guiAuth: cookie ? cookie.source : 'none',
    isGui: isGuiUrl(options.url),
    consoleErrors: consoleErrors.length,
    pageErrors: page.pageErrors.length,
    consoleWarnings: page.consoleMessages.filter((message) => message.type === 'warning').length,
  }
  await page.close()
  if (options.jsonOnly) console.log(JSON.stringify(summary))
  else {
    console.log(`✓ 截图完成：${summary.out}`)
    console.log(JSON.stringify(summary, null, 2))
  }
  process.exitCode = EXIT.OK
} catch (error) {
  console.error(`✗ 截图失败：${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = EXIT.ENV
} finally {
  if (browser) await browser.close().catch(() => {})
}
