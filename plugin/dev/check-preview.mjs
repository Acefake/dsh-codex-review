#!/usr/bin/env node
/**
 * Dev-only headless check: drives the preview scenes in Microsoft Edge through
 * the Chrome DevTools Protocol and fails on any console error / uncaught
 * exception, while asserting the three-column layout and the key DOM hooks.
 *
 * Usage:
 *   node plugin/dev/serve.mjs --port 4317          # in another shell
 *   node plugin/dev/check-preview.mjs              # all scenes
 *   node plugin/dev/check-preview.mjs changes      # one scene
 *
 * Zero dependencies: Node 22+ ships a global WebSocket.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const BASE = process.env.PREVIEW_BASE || 'http://127.0.0.1:4317'
const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/microsoft-edge',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
]
const DEBUG_PORT = 9333
const SCENES = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ['default', 'changes', 'review', 'partial']

function findEdge() {
  for (const candidate of EDGE_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate
  }
  throw new Error('Microsoft Edge not found; set chromePath in this script')
}

class Cdp {
  constructor(url) {
    this.socket = new WebSocket(url)
    this.nextId = 1
    this.pending = new Map()
    this.listeners = []
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data))
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id)
        this.pending.delete(message.id)
        if (message.error) reject(new Error(message.error.message))
        else resolve(message.result)
        return
      }
      for (const listener of this.listeners) listener(message)
    })
  }

  open() {
    return new Promise((resolve, reject) => {
      this.socket.addEventListener('open', () => resolve())
      this.socket.addEventListener('error', () => reject(new Error('CDP socket error')))
    })
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      const message = { id, method, params }
      if (sessionId) message.sessionId = sessionId
      this.socket.send(JSON.stringify(message))
    })
  }

  on(listener) {
    this.listeners.push(listener)
  }

  close() {
    try {
      this.socket.close()
    } catch {
      /* ignore */
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForHttp(url, attempts = 40) {
  for (let index = 0; index < attempts; index += 1) {
    try {
      const response = await fetch(url)
      if (response.ok) return await response.json()
    } catch {
      /* not up yet */
    }
    await sleep(150)
  }
  throw new Error(`timed out waiting for ${url}`)
}

const LAYOUT_EXPRESSION = `(() => {
  const root = document.querySelector('[data-cr-root]')
  if (!root) return { ok: false, reason: 'no workbench root' }
  const rect = (selector) => {
    const node = document.querySelector(selector)
    if (!node) return null
    const box = node.getBoundingClientRect()
    return { width: Math.round(box.width), height: Math.round(box.height), x: Math.round(box.x) }
  }
  const text = (selector) => (document.querySelector(selector) || {}).textContent || ''
  return {
    ok: true,
    previewReady: document.body.dataset.previewReady || '',
    previewError: document.body.dataset.previewError || '',
    scene: document.body.dataset.previewScene || '',
    sidebar: rect('.cr-side'),
    main: rect('.cr-main'),
    doc: rect('.cr-doc'),
    details: rect('.cr-details'),
    tabs: text('.cr-tabs').replace(/\\s+/g, ' ').trim(),
    rows: document.querySelectorAll('[data-pr-number]').length,
    diffRows: document.querySelectorAll('.cr-diff-row').length,
    files: document.querySelectorAll('[data-file-path]').length,
    partial: Boolean(document.querySelector('[data-review-partial]')),
    reviewLabel: ((document.querySelector('[data-action="review"]') || {}).textContent || '').trim(),
    reviewAria: (document.querySelector('[data-action="review"]') || {}).getAttribute
      ? document.querySelector('[data-action="review"]').getAttribute('aria-label')
      : '',
    gearAria: (() => {
      const node = document.querySelector('[data-action="review-settings"]')
      return node ? node.getAttribute('aria-label') : ''
    })(),
    iconArias: [...document.querySelectorAll('.cr-iconbtn')].map((node) => node.getAttribute('aria-label')),
    reviewState: (document.querySelector('[data-cr-root]') || {}).getAttribute
      ? document.querySelector('[data-cr-root]').getAttribute('data-cr-review-state')
      : '',
    overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  }
})()`

async function checkScene(cdp, scene) {
  const errors = []
  const onEvent = (message) => {
    if (message.method === 'Runtime.exceptionThrown') {
      const details = message.params.exceptionDetails
      errors.push(`uncaught: ${details.text} ${details.exception ? details.exception.description : ''}`)
    }
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      errors.push(`console.error: ${message.params.args.map((arg) => arg.value ?? arg.description ?? '').join(' ')}`)
    }
    if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
      errors.push(`log: ${message.params.entry.text} ${message.params.entry.url || ''}`)
    }
  }
  cdp.on(onEvent)

  const target = await cdp.send('Target.createTarget', { url: 'about:blank' })
  const attached = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true })
  const sessionId = attached.sessionId
  const send = (method, params = {}) => cdp.send(method, params, sessionId)

  await send('Runtime.enable')
  await send('Log.enable')
  await send('Page.enable')
  await send('Page.navigate', { url: `${BASE}/?scene=${scene}` })

  let layout = null
  for (let index = 0; index < 80; index += 1) {
    await sleep(150)
    const result = await send('Runtime.evaluate', { expression: LAYOUT_EXPRESSION, returnByValue: true })
    layout = result.result && result.result.value
    if (layout && layout.ok && layout.previewReady === '1') break
  }
  await sleep(250)
  const finalResult = await send('Runtime.evaluate', { expression: LAYOUT_EXPRESSION, returnByValue: true })
  const finalLayout = finalResult.result.value
  await send('Target.closeTarget', { targetId: target.targetId })
  return { scene, layout: finalLayout, errors }
}

function assertScene(scene, layout, errors) {
  const problems = []
  if (!layout) return ['no layout snapshot']
  if (!layout.ok) return [layout.reason]
  if (layout.previewError) problems.push(`preview error: ${layout.previewError}`)
  if (layout.previewReady !== '1') problems.push('scene never reached ready state')
  if (errors.length > 0) problems.push(...errors)
  if (!(layout.sidebar && layout.sidebar.width >= 200)) problems.push(`sidebar width ${layout.sidebar && layout.sidebar.width}`)
  if (!(layout.main && layout.main.width > 600)) problems.push(`main width ${layout.main && layout.main.width}`)
  if (!(layout.doc && layout.doc.width >= 500)) problems.push(`doc width ${layout.doc && layout.doc.width}`)
  if (!layout.tabs.includes('Summary') || !layout.tabs.includes('Changes')) problems.push('tab labels missing')
  if (layout.rows < 5) problems.push(`list rows ${layout.rows}`)
  if (!layout.reviewLabel.includes('用 AI 审查')) problems.push(`review button label "${layout.reviewLabel}"`)
  if (layout.reviewAria !== '用 AI 审查') problems.push(`review button aria-label "${layout.reviewAria}"`)
  if (!layout.gearAria) problems.push('gear button without aria-label')
  for (const aria of layout.iconArias) {
    if (!aria || !aria.trim()) problems.push('icon button without aria-label')
  }
  if (layout.overflowX) problems.push('page has horizontal overflow')
  if (scene === 'changes') {
    if (layout.diffRows < 10) problems.push(`diff rows ${layout.diffRows}`)
    if (layout.files < 10) problems.push(`file cards ${layout.files}`)
  }
  if ((scene === 'review' || scene === 'partial') && layout.reviewState !== 'done') problems.push(`review state ${layout.reviewState}`)
  if (scene === 'partial' && !layout.partial) problems.push('partial banner missing')
  return problems
}

async function main() {
  const edgePath = findEdge()
  const profile = path.join(os.tmpdir(), 'dsh-codex-review-cdp-profile')
  fs.mkdirSync(profile, { recursive: true })
  const edge = spawn(
    edgePath,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${profile}`,
      '--window-size=1600,1100',
      'about:blank',
    ],
    { stdio: 'ignore' },
  )
  let failed = false
  try {
    await waitForHttp(`http://127.0.0.1:${DEBUG_PORT}/json/version`)
    const version = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).json()
    const cdp = new Cdp(version.webSocketDebuggerUrl)
    await cdp.open()
    try {
      for (const scene of SCENES) {
        const result = await checkScene(cdp, scene)
        const problems = assertScene(scene, result.layout, result.errors)
        const status = problems.length === 0 ? 'PASS' : 'FAIL'
        if (problems.length > 0) failed = true
        const layout = result.layout || {}
        console.log(
          `${status} ${scene.padEnd(8)} side=${layout.sidebar ? layout.sidebar.width : '?'} main=${layout.main ? layout.main.width : '?'} ` +
            `doc=${layout.doc ? layout.doc.width : '?'} details=${layout.details ? layout.details.width : '?'} ` +
            `rows=${layout.rows} files=${layout.files} diffRows=${layout.diffRows} review=${layout.reviewState}`,
        )
        for (const problem of problems) console.log(`     - ${problem}`)
      }
    } finally {
      cdp.close()
    }
  } finally {
    edge.kill()
  }
  process.exit(failed ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
