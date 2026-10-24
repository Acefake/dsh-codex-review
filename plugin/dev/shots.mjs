#!/usr/bin/env node
/**
 * Dev-only screenshot generator for the Code Review workbench.
 *
 * Drives every preview scene in Microsoft Edge through the Chrome DevTools
 * Protocol (same zero-dependency Cdp shim as check-preview.mjs) and writes
 * 1600×1100 PNGs into `plugin/dev/shots/`.
 *
 * Usage:
 *   node plugin/dev/serve.mjs --port 4317            # in another shell
 *   node plugin/dev/shots.mjs                        # all shots
 *   node plugin/dev/shots.mjs default changes        # selected scenes only
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
const OUT_DIR = path.join(here, 'shots')
const VIEWPORT = { width: 1600, height: 1100 }
const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/microsoft-edge',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
]
const DEBUG_PORT = Number(process.env.PREVIEW_CDP_PORT || 9345)

/** Screenshot manifest: the eight v1 scenes first, then the three v1.1 ones. */
const SHOTS = [
  { file: '01-default.png', scene: 'default', theme: 'dark' },
  { file: '02-changes.png', scene: 'changes', theme: 'dark' },
  { file: '03-review.png', scene: 'review', theme: 'dark' },
  { file: '04-running.png', scene: 'running', theme: 'dark' },
  { file: '05-error.png', scene: 'error', theme: 'dark' },
  { file: '06-empty.png', scene: 'empty', theme: 'dark' },
  { file: '07-light.png', scene: 'default', theme: 'light' },
  { file: '08-partial.png', scene: 'partial', theme: 'dark' },
  { file: '09-v11-inline-findings.png', scene: 'v11-inline-findings', theme: 'dark' },
  { file: '10-v11-settings.png', scene: 'v11-settings', theme: 'dark' },
  { file: '11-v11-existing-comments.png', scene: 'v11-existing-comments', theme: 'dark' },
]

function findEdge() {
  for (const candidate of EDGE_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate
  }
  throw new Error('Microsoft Edge not found; set the path in EDGE_CANDIDATES')
}

class Cdp {
  constructor(url) {
    this.socket = new WebSocket(url)
    this.nextId = 1
    this.pending = new Map()
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data))
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id)
        this.pending.delete(message.id)
        if (message.error) reject(new Error(message.error.message))
        else resolve(message.result)
      }
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

async function captureScene(cdp, shot) {
  // Clear the mock job cache so the shot never shows a "cached" toast from a
  // previous scene (dev-only route, see serve.mjs).
  try {
    await fetch(`${BASE}/codex-review/dev-reset`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
  } catch {
    /* the reset is a nicety; the shot still works without it */
  }
  const target = await cdp.send('Target.createTarget', { url: 'about:blank' })
  const attached = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true })
  const sessionId = attached.sessionId
  const send = (method, params = {}) => cdp.send(method, params, sessionId)
  try {
    await send('Page.enable')
    await send('Runtime.enable')
    await send('Emulation.setDeviceMetricsOverride', {
      width: VIEWPORT.width,
      height: VIEWPORT.height,
      deviceScaleFactor: 1,
      mobile: false,
    })
    await send('Page.navigate', { url: `${BASE}/?scene=${shot.scene}&theme=${shot.theme}` })
    let ready = false
    for (let index = 0; index < 100; index += 1) {
      await sleep(150)
      const result = await send('Runtime.evaluate', {
        expression: `document.body.dataset.previewReady === '1' && !document.body.dataset.previewError`,
        returnByValue: true,
      })
      if (result && result.result && result.result.value === true) {
        ready = true
        break
      }
    }
    if (!ready) {
      const failed = await send('Runtime.evaluate', {
        expression: `document.body.dataset.previewError || 'scene never became ready'`,
        returnByValue: true,
      })
      throw new Error(`${shot.scene}: ${failed && failed.result ? failed.result.value : 'not ready'}`)
    }
    // Let the last paint/settle (polling stops, scroll effects run) land.
    await sleep(600)
    const screenshot = await send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: false,
    })
    fs.mkdirSync(OUT_DIR, { recursive: true })
    const outPath = path.join(OUT_DIR, shot.file)
    fs.writeFileSync(outPath, Buffer.from(screenshot.data, 'base64'))
    return outPath
  } finally {
    await send('Target.closeTarget', { targetId: target.targetId }).catch(() => {})
  }
}

async function main() {
  const only = new Set(process.argv.slice(2))
  const shots = only.size > 0 ? SHOTS.filter((shot) => only.has(shot.scene) || only.has(shot.file)) : SHOTS
  if (shots.length === 0) throw new Error('no screenshots matched the given scene names')
  const edgePath = findEdge()
  const profile = path.join(os.tmpdir(), 'dsh-codex-review-cdp-profile-shots')
  fs.mkdirSync(profile, { recursive: true })
  const edge = spawn(
    edgePath,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
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
      for (const shot of shots) {
        try {
          const outPath = await captureScene(cdp, shot)
          console.log(`PASS ${shot.file.padEnd(30)} ${path.relative(process.cwd(), outPath)}`)
        } catch (error) {
          failed = true
          console.log(`FAIL ${shot.file.padEnd(30)} ${error.message}`)
        }
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
