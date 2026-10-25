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
const SCENES =
  process.argv.slice(2).length > 0
    ? process.argv.slice(2)
    : [
        'default',
        'changes',
        'review',
        'partial',
        'v11-inline-findings',
        'v11-settings',
        'v11-existing-comments',
        'v2-merge-dialog',
        'v2-chat',
        'v2.1-auto-review',
        'v2.1-auto-review-missing',
      ]

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

/** POST a dev-only mock route and return its `value` (null on any failure). */
async function postDev(pathname) {
  try {
    const response = await fetch(`${BASE}${pathname}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    const envelope = await response.json()
    return envelope && envelope.ok === true ? envelope.value : null
  } catch {
    return null
  }
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
    verdict: (() => {
      const node = document.querySelector('[data-review-verdict]')
      return node ? node.getAttribute('data-review-verdict') : ''
    })(),
    chips: document.querySelectorAll('[data-filter]').length,
    findingItems: document.querySelectorAll('[data-finding-id]').length,
    reviewOptions: Boolean(document.querySelector('[data-review-options]')),
    reviewReused: Boolean(document.querySelector('[data-review-reused]')),
    reviewGuidelines: (() => {
      const node = document.querySelector('[data-review-guidelines]')
      return node ? node.getAttribute('data-review-guidelines') : ''
    })(),
    inlineMarkers: document.querySelectorAll('[data-inline-marker]').length,
    inlineCards: document.querySelectorAll('.cr-inline-card').length,
    inlineOpen: document.querySelectorAll('[data-inline-open]').length,
    inlineComments: document.querySelectorAll('[data-inline-comment]').length,
    settingsOpen: Boolean(document.querySelector('[role="dialog"][data-cr-settings]')),
    settingsDepth: document.querySelectorAll('button[data-depth]').length,
    settingsThreshold: document.querySelectorAll('button[data-threshold]').length,
    settingsGuidelines: Boolean(document.querySelector('button[data-guidelines]')),
    settingsAriaModal: (() => {
      const node = document.querySelector('[role="dialog"][data-cr-settings]')
      return node ? node.getAttribute('aria-modal') : ''
    })(),
    settingsFocusInside: (() => {
      const node = document.querySelector('[role="dialog"][data-cr-settings]')
      return Boolean(node && node.contains(document.activeElement))
    })(),
    selectedNumber: (() => {
      const node = document.querySelector('[data-pr-number][aria-current="true"]')
      return node ? node.getAttribute('data-pr-number') : ''
    })(),
    fileLinks: document.querySelectorAll('[data-action="goto-file"]').length,
    mergeOpen: Boolean(document.querySelector('[data-cr-merge-dialog]')),
    mergePhase: (() => {
      const node = document.querySelector('[data-merge-phase]')
      return node ? node.getAttribute('data-merge-phase') : ''
    })(),
    mergeMethods: document.querySelectorAll('input[data-merge-method-value]').length,
    mergeDelete: Boolean(document.querySelector('input[data-merge-delete]')),
    mergeConfirm: Boolean(document.querySelector('[data-action="merge-confirm"]')),
    mergeCancel: Boolean(document.querySelector('[data-action="merge-cancel"]')),
    mergeSha: (() => {
      const node = document.querySelector('[data-merge-sha]')
      return node ? node.getAttribute('data-merge-sha') : ''
    })(),
    mergeRepoText: (() => {
      const node = document.querySelector('[data-merge-repo]')
      return node ? node.textContent || '' : ''
    })(),
    chatOpen: Boolean(document.querySelector('[data-cr-chat]')),
    chatMessages: document.querySelectorAll('[data-chat-role]').length,
    chatAssistantChars: (() => {
      const nodes = document.querySelectorAll('[data-chat-role="assistant"] .cr-chat-bubble')
      let total = 0
      nodes.forEach((node) => {
        total += (node.textContent || '').length
      })
      return total
    })(),
    chatStreaming: (() => {
      const node = document.querySelector('[data-cr-chat]')
      return node ? node.getAttribute('data-chat-streaming') === 'true' : false
    })(),
    chatError: Boolean(document.querySelector('[data-chat-error]')),
    chatBubbles: document.querySelectorAll('.cr-chat-bubble').length,
    composerValue: (() => {
      const node = document.querySelector('[data-chat-input]')
      return node ? node.value : ''
    })(),
    autoCard: Boolean(document.querySelector('[data-cr-autoreview]')),
    autoSupported: (() => {
      const node = document.querySelector('[data-cr-autoreview]')
      return node ? node.getAttribute('data-auto-supported') : ''
    })(),
    autoEnabled: (() => {
      const node = document.querySelector('[data-cr-autoreview]')
      return node ? node.getAttribute('data-auto-enabled') : ''
    })(),
    autoRunning: (() => {
      const node = document.querySelector('[data-cr-autoreview]')
      return node ? node.getAttribute('data-auto-running') : ''
    })(),
    autoRecent: (() => {
      const node = document.querySelector('[data-cr-autoreview]')
      return node ? Number(node.getAttribute('data-auto-recent')) : 0
    })(),
    autoBadges: document.querySelectorAll('[data-auto-badge]').length,
    autoBadgeCount: document.querySelectorAll('[data-auto-badge="count"]').length,
    autoRunButton: Boolean(document.querySelector('[data-action="auto-review-run"]')),
    autoUnsupportedText: (() => {
      const node = document.querySelector('.cr-autoreview-degraded')
      return node ? node.textContent || '' : ''
    })(),
    autoToast: document.body.dataset.previewAutoToast || '',
    autoMissingCalls:
      typeof window.__CR_AUTO_MISSING_CALLS__ === 'number' ? window.__CR_AUTO_MISSING_CALLS__ : -1,
    autoSettingsToggle: Boolean(document.querySelector('button[data-auto-enabled]')),
    autoSettingsEnabled: document.querySelector('button[data-auto-enabled]')?.getAttribute('aria-checked') === 'true',
    autoSettingsPresets: document.querySelectorAll('[data-auto-interval-preset]').length,
    autoSettingsDepth: document.querySelectorAll('button[data-depth]').length,
    autoSettingsQuery: Boolean(document.querySelector('[data-auto-query]')),
    autoSettingsMax: Boolean(document.querySelector('input[data-auto-max]')),
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
  // Every scene starts from a clean mock state (jobs, merge/chat/auto counters).
  await postDev('/codex-review/dev-reset')
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
  const interactions = await probeInteractions(send, scene)
  await send('Target.closeTarget', { targetId: target.targetId })
  return { scene, layout: finalLayout, errors, interactions }
}

/**
 * Keyboard acceptance checks (CONTRACT §4.5.5): j switches PR, / focuses the
 * search box and Esc closes the settings popover.
 */
async function probeInteractions(send, scene) {
  const result = {
    selectedBefore: '',
    selectedAfter: '',
    searchFocused: false,
    reviewRequested: '',
    jumpedToFile: '',
    scrollRestored: null,
    settingsClosedByEsc: null,
    settingsStored: '',
    reviewOptionsText: '',
    mergeFlow: '',
    mergeClosedByCancel: null,
    mergeSha: '',
    chatCharsMid: -1,
    chatCharsDone: -1,
    chatStored: '',
    chatStopped: null,
    chatIsolation: '',
    autoState: '',
    autoPolling: '',
    autoDisabled: '',
    autoPollStopped: '',
    autoMissingCalls: -1,
    invalid: '',
  }
  const evaluate = async (expression) => {
    const value = await send('Runtime.evaluate', { expression, returnByValue: true })
    return value && value.result ? value.result.value : undefined
  }
  const press = (key) =>
    evaluate(
      `document.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true }))`,
    )
  const selected = () =>
    evaluate(
      `(() => { const node = document.querySelector('[data-pr-number][aria-current="true"]'); return node ? node.getAttribute('data-pr-number') : '' })()`,
    )
  try {
    if (scene === 'default') {
      result.selectedBefore = await selected()
      await press('j')
      await sleep(900)
      result.selectedAfter = await selected()
      if (!result.selectedAfter || result.selectedAfter === result.selectedBefore) {
        result.invalid = 'j did not move the PR selection'
      }
      await press('k')
      await sleep(900)
      const selectedBack = await selected()
      if (selectedBack !== result.selectedBefore) {
        result.invalid = `k did not move back (${result.selectedBefore} -> ${selectedBack})`
      }
      await press('/')
      await sleep(200)
      result.searchFocused = await evaluate(
        `(() => { const input = document.querySelector('.cr-search input'); return Boolean(input && document.activeElement === input) })()`,
      )
      if (!result.searchFocused) result.invalid = 'slash did not focus the search box'
      await press('Escape')
      // "r" starts a review with the current settings (only when not typing).
      await evaluate(`document.activeElement && document.activeElement.blur && document.activeElement.blur()`)
      await press('r')
      await sleep(600)
      result.reviewRequested = await evaluate(
        `(() => { const root = document.querySelector('[data-cr-root]'); return root ? root.getAttribute('data-cr-review-state') : '' })()`,
      )
      if (result.reviewRequested !== 'preparing' && result.reviewRequested !== 'running') {
        result.invalid = 'r did not start a review'
      }
    }
    if (scene === 'changes') {
      // Summary <-> Changes must keep each tab's scroll offset (CONTRACT §4.5.5).
      await evaluate(`document.querySelector('.cr-doc').scrollTop = 420`)
      await sleep(120)
      await evaluate(`document.querySelector('[data-tab="summary"]').click()`)
      await sleep(250)
      await evaluate(`document.querySelector('[data-tab="changes"]').click()`)
      await sleep(450)
      result.scrollRestored = await evaluate(`Math.round(document.querySelector('.cr-doc').scrollTop)`)
      if (!(typeof result.scrollRestored === 'number' && result.scrollRestored >= 360)) {
        result.invalid = `tab switch lost the scroll offset (${result.scrollRestored})`
      }
    }
    if (scene === 'default') {
      // Right-column file link: switch to Changes, expand and scroll to that file.
      await evaluate(
        `(() => { const links = document.querySelectorAll('[data-action="goto-file"]'); if (links[1]) links[1].click(); return links.length })()`,
      )
      await sleep(800)
      result.jumpedToFile = await evaluate(
        `(() => { const root = document.querySelector('[data-cr-root]'); const open = document.querySelectorAll('.cr-file--open').length; const doc = document.querySelector('.cr-doc'); return (root ? root.getAttribute('data-cr-tab') : '') + ':' + open + ':' + (doc ? Math.round(doc.scrollTop) : -1) })()`,
      )
      if (!String(result.jumpedToFile).startsWith('changes:')) {
        result.invalid = 'right-column file link did not switch to Changes'
      }
    }
    if (scene === 'v11-settings') {
      // Change depth to "deep": the popover persists to localStorage immediately.
      await evaluate(
        `(() => { const input = document.querySelector('button[data-depth="deep"]'); if (input) input.click(); return Boolean(input) })()`,
      )
      await sleep(250)
      result.settingsStored = await evaluate(
        `(() => { try { return localStorage.getItem('codex-review:settings') || '' } catch (error) { return 'error' } })()`,
      )
      if (!String(result.settingsStored).includes('"depth":"deep"')) {
        result.invalid = 'settings were not persisted to localStorage'
      }
      await press('Escape')
      await sleep(300)
      result.settingsClosedByEsc = await evaluate(
        `!document.querySelector('[role="dialog"][data-cr-settings]')`,
      )
      if (result.settingsClosedByEsc !== true) result.invalid = 'Esc did not close the settings popover'
      // The next review must carry the new options; the card echoes them.
      await evaluate(`document.querySelector('[data-action="review"]').click()`)
      let state = ''
      for (let attempt = 0; attempt < 32; attempt += 1) {
        await sleep(200)
        state = await evaluate(
          `(() => { const root = document.querySelector('[data-cr-root]'); return root ? root.getAttribute('data-cr-review-state') : '' })()`,
        )
        if (state === 'done' || state === 'error') break
      }
      result.reviewOptionsText = await evaluate(
        `(() => { const node = document.querySelector('[data-review-options]'); return node ? node.textContent : '' })()`,
      )
      if (state !== 'done') result.invalid = `review after settings change ended "${state}"`
      else if (!String(result.reviewOptionsText).includes('深')) {
        result.invalid = 'review did not echo the new depth option'
      }
    }
    if (scene === 'default') {
      // Merge dialog (CONTRACT §5.3): cancel must not write; confirm sends the guarded body.
      const beforeMerge = await postDev('/codex-review/dev-state')
      await evaluate(`document.querySelector('[data-action="merge"]').click()`)
      await sleep(500)
      const dialogOpened = await evaluate(
        `Boolean(document.querySelector('[data-cr-merge-dialog]'))`,
      )
      const dialogSha = await evaluate(
        `(() => { const node = document.querySelector('[data-merge-sha]'); return node ? node.getAttribute('data-merge-sha') : '' })()`,
      )
      const methods = await evaluate(`document.querySelectorAll('input[data-merge-method-value]').length`)
      result.mergeSha = dialogSha
      await evaluate(`document.querySelector('[data-action="merge-cancel"]').click()`)
      await sleep(350)
      const dialogClosed = await evaluate(`!document.querySelector('[data-cr-merge-dialog]')`)
      const afterCancel = await postDev('/codex-review/dev-state')
      if (!dialogOpened || dialogClosed !== true) {
        result.invalid = 'merge dialog did not open/cancel correctly'
      } else if (!dialogSha || dialogSha.length !== 7) {
        result.invalid = `merge dialog head sha "${dialogSha}"`
      } else if (methods !== 3) {
        result.invalid = `merge methods ${methods}`
      } else if (!afterCancel || !beforeMerge || afterCancel.mergeCount !== beforeMerge.mergeCount) {
        result.invalid = 'cancelling the merge dialog wrote to the merge route'
      }
      await evaluate(`document.querySelector('[data-action="merge"]').click()`)
      await sleep(400)
      await evaluate(`document.querySelector('[data-action="merge-confirm"]').click()`)
      await sleep(1000)
      const afterConfirm = await postDev('/codex-review/dev-state')
      const lastMerge = afterConfirm ? afterConfirm.lastMerge : null
      if (!lastMerge) {
        result.invalid = 'merge confirm did not reach the host route'
      } else if (lastMerge.confirm !== true || !lastMerge.expectedHeadSha) {
        result.invalid = 'merge request fields: ' + JSON.stringify(lastMerge)
      } else if (lastMerge.method !== 'squash' || lastMerge.deleteBranch !== false) {
        result.invalid = 'merge defaults are not squash/keep-branch: ' + JSON.stringify(lastMerge)
      } else if (!(afterConfirm.mergeCount > 0)) {
        result.invalid = 'merge count did not grow'
      }
      result.mergeFlow = JSON.stringify({
        opened: dialogOpened,
        sha: dialogSha,
        methods,
        mergeCount: afterConfirm ? afterConfirm.mergeCount : null,
        method: lastMerge ? lastMerge.method : '',
        deleteBranch: lastMerge ? lastMerge.deleteBranch : null,
      })
    }
    if (scene === 'v2-merge-dialog') {
      const before = await postDev('/codex-review/dev-state')
      result.mergeSha = await evaluate(
        `(() => { const node = document.querySelector('[data-merge-sha]'); return node ? node.getAttribute('data-merge-sha') : '' })()`,
      )
      await evaluate(`document.querySelector('[data-action="merge-cancel"]').click()`)
      await sleep(350)
      result.mergeClosedByCancel = await evaluate(
        `!document.querySelector('[data-cr-merge-dialog]')`,
      )
      const after = await postDev('/codex-review/dev-state')
      if (result.mergeClosedByCancel !== true) result.invalid = 'cancel did not close the merge dialog'
      if (after && before && after.mergeCount !== before.mergeCount) {
        result.invalid = 'cancelling the merge dialog wrote to the merge route'
      }
      // Esc must close the dialog without writing either.
      await evaluate(`document.querySelector('[data-action="merge"]').click()`)
      await sleep(400)
      await press('Escape')
      await sleep(350)
      result.mergeClosedByEsc = await evaluate(`!document.querySelector('[data-cr-merge-dialog]')`)
      const afterEsc = await postDev('/codex-review/dev-state')
      if (result.mergeClosedByEsc !== true) result.invalid = 'Esc did not close the merge dialog'
      if (afterEsc && before && afterEsc.mergeCount !== before.mergeCount) {
        result.invalid = 'Esc on the merge dialog wrote to the merge route'
      }
    }
    if (scene === 'v2-chat') {
      const readChat = () =>
        evaluate(`(() => {
          const nodes = document.querySelectorAll('[data-chat-role="assistant"] .cr-chat-bubble')
          let total = 0
          nodes.forEach((node) => { total += (node.textContent || '').length })
          const chat = document.querySelector('[data-cr-chat]')
          return {
            chars: total,
            messages: document.querySelectorAll('[data-chat-role]').length,
            streaming: chat ? chat.getAttribute('data-chat-streaming') === 'true' : false,
          }
        })()`)
      /** Type into the real composer and press send (the panel has no input of its own). */
      const sendViaComposer = async (text) => {
        await evaluate(`(() => {
          const input = document.querySelector('[data-chat-input]')
          if (!input) return false
          const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
          setter.call(input, ${JSON.stringify(text)})
          input.dispatchEvent(new Event('input', { bubbles: true }))
          return true
        })()`)
        await sleep(150)
        await evaluate(`document.querySelector('[data-action="chat-send"]').click()`)
      }
      // 1) second answer (the preview scripts it as a slow stream): sample growth.
      await sendViaComposer('请继续说明风险点')
      await sleep(900)
      const mid = await readChat()
      let done = null
      for (let attempt = 0; attempt < 80; attempt += 1) {
        await sleep(150)
        done = await readChat()
        if (done && done.streaming === false && done.messages >= 4) break
      }
      result.chatCharsMid = mid ? mid.chars : -1
      result.chatCharsDone = done ? done.chars : -1
      if (!(mid && mid.chars > 0)) result.invalid = 'chat stream produced no incremental text'
      else if (!(done && done.chars > mid.chars)) result.invalid = 'chat answer did not grow while streaming'
      else if (!done || done.messages < 4) result.invalid = 'chat messages missing after done'
      result.chatStored = await evaluate(
        `(() => { try { return Object.keys(localStorage).filter((key) => key.indexOf('codex-review:chat:') === 0).join(',') } catch (error) { return 'error' } })()`,
      )
      if (!String(result.chatStored).includes('#129')) {
        result.invalid = `chat history key missing: ${result.chatStored}`
      }
      // 2) stop a slow stream (third request).
      await sendViaComposer('再详细一点')
      await sleep(900)
      const beforeStop = await readChat()
      await evaluate(`document.querySelector('[data-action="chat-stop"]').click()`)
      await sleep(800)
      const afterStop = await readChat()
      result.chatStopped = afterStop ? afterStop.streaming === false : false
      if (!(beforeStop && beforeStop.streaming === true)) {
        result.invalid = 'third chat request did not start streaming'
      } else if (!result.chatStopped) {
        result.invalid = 'stop did not end the stream'
      }
      // 3) history isolation: another PR starts empty, going back restores messages.
      await evaluate(`(() => {
        const rows = document.querySelectorAll('[data-pr-number]')
        for (const row of rows) {
          if (row.getAttribute('data-pr-number') !== '129') { row.click(); return true }
        }
        return false
      })()`)
      await sleep(1400)
      const other = await evaluate(`(() => {
        const root = document.querySelector('[data-cr-root]')
        const selected = document.querySelector('[data-pr-number][aria-current="true"]')
        return {
          messages: root ? root.getAttribute('data-cr-chat-messages') : '',
          selected: selected ? selected.getAttribute('data-pr-number') : '',
        }
      })()`)
      await evaluate(`(() => {
        const rows = document.querySelectorAll('[data-pr-number]')
        for (const row of rows) {
          if (row.getAttribute('data-pr-number') === '129') { row.click(); return true }
        }
        return false
      })()`)
      await sleep(1400)
      const back = await evaluate(`(() => {
        const root = document.querySelector('[data-cr-root]')
        return { messages: root ? root.getAttribute('data-cr-chat-messages') : '' }
      })()`)
      await evaluate(`document.querySelector('[data-action="chat-open"]').click()`)
      await sleep(400)
      const reopened = await readChat()
      await press('Escape')
      await sleep(350)
      result.chatClosedByEsc = await evaluate(`!document.querySelector('[data-cr-chat]')`)
      result.chatIsolation = JSON.stringify({
        otherMessages: other ? other.messages : '',
        otherSelected: other ? other.selected : '',
        backMessages: back ? back.messages : '',
        reopenedMessages: reopened ? reopened.messages : -1,
        closedByEsc: result.chatClosedByEsc,
      })
      if (!other || other.selected === '129') result.invalid = 'could not switch to another PR'
      else if (other.messages !== '0') result.invalid = 'chat history leaked across PRs'
      else if (!back || Number(back.messages) < 6) result.invalid = 'chat history was not restored'
      else if (!reopened || reopened.messages < 6) result.invalid = 'restored chat did not reopen'
      else if (result.chatClosedByEsc !== true) result.invalid = 'Esc did not close the chat panel'
    }
    if (scene === 'v2.1-auto-review') {
      const state = await postDev('/codex-review/dev-state')
      const auto = state && state.autoReview ? state.autoReview : null
      result.autoState = auto ? JSON.stringify(auto) : ''
      if (!auto) {
        result.invalid = 'dev-state has no auto review bookkeeping'
      } else if (!auto.lastConfigPatch || auto.lastConfigPatch.enabled !== true) {
        result.invalid = `auto review config patch was not enabled=true: ${JSON.stringify(auto.lastConfigPatch)}`
      } else if (!auto.lastRun || auto.lastRun.force !== true || auto.runCalls < 1) {
        result.invalid = `auto-review-run did not receive force=true: ${JSON.stringify(auto.lastRun)}`
      }
      // Polling while enabled: statusCount grows at the shortened preview cadence.
      const firstState = await postDev('/codex-review/dev-state')
      const firstCount =
        firstState && firstState.autoReview ? firstState.autoReview.statusCount : -1
      await sleep(2800)
      const secondState = await postDev('/codex-review/dev-state')
      const secondCount =
        secondState && secondState.autoReview ? secondState.autoReview.statusCount : -1
      result.autoPolling = `${firstCount}->${secondCount}`
      if (!(secondCount > firstCount)) {
        result.invalid = `auto review polling did not run (${result.autoPolling})`
      }
      // Disable through the settings popover; polling must stop.
      await evaluate(`document.querySelector('[data-action="review-settings"]').click()`)
      await sleep(500)
      await evaluate(
        `(() => { const input = document.querySelector('button[data-auto-enabled]'); if (input) input.click(); return Boolean(input) })()`,
      )
      await sleep(800)
      result.autoDisabled = await evaluate(
        `(() => { const root = document.querySelector('[data-cr-root]'); return root ? root.getAttribute('data-cr-auto-enabled') : '' })()`,
      )
      if (result.autoDisabled !== 'false') {
        result.invalid = `auto review did not disable through settings (${result.autoDisabled})`
      }
      await press('Escape')
      await sleep(300)
      const beforeStop = await postDev('/codex-review/dev-state')
      const stopCount =
        beforeStop && beforeStop.autoReview ? beforeStop.autoReview.statusCount : -1
      await sleep(2800)
      const afterStop = await postDev('/codex-review/dev-state')
      const stopCountAfter =
        afterStop && afterStop.autoReview ? afterStop.autoReview.statusCount : -1
      result.autoPollStopped = `${stopCount}->${stopCountAfter}`
      if (stopCountAfter !== stopCount) {
        result.invalid = `auto review polling kept running after disable (${result.autoPollStopped})`
      }
    }
    if (scene === 'v2.1-auto-review-missing') {
      result.autoMissingCalls = await evaluate(
        `typeof window.__CR_AUTO_MISSING_CALLS__ === 'number' ? window.__CR_AUTO_MISSING_CALLS__ : -1`,
      )
      await sleep(2600)
      const after = await evaluate(
        `typeof window.__CR_AUTO_MISSING_CALLS__ === 'number' ? window.__CR_AUTO_MISSING_CALLS__ : -1`,
      )
      result.autoPollStopped = `${result.autoMissingCalls}->${after}`
      if (result.autoMissingCalls !== 1) {
        result.invalid = `old-host auto review probe count ${result.autoMissingCalls}`
      } else if (after !== result.autoMissingCalls) {
        result.invalid = `old-host auto review kept probing (${result.autoPollStopped})`
      }
    }
  } catch (error) {
    result.invalid = String((error && error.message) || error)
  }
  return result
}

function assertScene(scene, layout, errors, interactions) {
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
  if (layout.fileLinks < 1) problems.push('right-column file links missing')
  if (scene === 'changes') {
    if (layout.diffRows < 10) problems.push(`diff rows ${layout.diffRows}`)
    if (layout.files < 10) problems.push(`file cards ${layout.files}`)
  }
  if ((scene === 'review' || scene === 'partial') && layout.reviewState !== 'done') problems.push(`review state ${layout.reviewState}`)
  if (scene === 'partial' && !layout.partial) problems.push('partial banner missing')
  if (scene === 'review' || scene === 'partial') {
    if (layout.findingItems < 1) problems.push('no finding cards')
    if (layout.chips < 4) problems.push(`filter chips ${layout.chips}`)
    if (!layout.reviewOptions) problems.push('resolved options row missing')
    if (!layout.reviewReused) problems.push('reused-files row missing')
    if (!layout.reviewGuidelines) problems.push('guidelines row missing')
  }
  if (scene === 'review') {
    if (layout.verdict !== 'changes') problems.push(`verdict "${layout.verdict}"`)
  }
  if (scene === 'v11-inline-findings') {
    if (layout.inlineMarkers < 1) problems.push('no inline finding markers')
    if (layout.inlineCards < 1) problems.push('inline finding card did not expand')
    if (layout.inlineOpen < 1) problems.push('inline panel without data-inline-open')
  }
  if (scene === 'v11-settings') {
    if (!layout.settingsOpen) problems.push('settings popover did not open')
    if (layout.settingsAriaModal !== 'true') problems.push('settings popover without aria-modal')
    if (layout.settingsDepth !== 3) problems.push(`depth radios ${layout.settingsDepth}`)
    if (layout.settingsThreshold !== 3) problems.push(`threshold radios ${layout.settingsThreshold}`)
    if (!layout.settingsGuidelines) problems.push('guidelines toggle missing')
    if (!layout.settingsFocusInside) problems.push('focus did not move into the popover')
    if (!layout.autoSettingsToggle) problems.push('auto review toggle missing from settings')
    if (layout.autoSettingsEnabled && layout.autoSettingsPresets !== 3) {
      problems.push(`auto review interval presets ${layout.autoSettingsPresets}`)
    }
    if (layout.autoSettingsDepth !== 3) {
      problems.push(`auto review depth radios ${layout.autoSettingsDepth}`)
    }
    if (layout.autoSettingsEnabled && (!layout.autoSettingsQuery || !layout.autoSettingsMax)) {
      problems.push('auto review query/max fields missing from settings')
    }
  }
  if (scene === 'v11-existing-comments') {
    if (layout.inlineComments < 2) problems.push(`inline comment cards ${layout.inlineComments}`)
  }
  if (scene === 'v2-merge-dialog') {
    if (!layout.mergeOpen) problems.push('merge dialog did not open')
    if (layout.mergeMethods !== 3) problems.push(`merge methods ${layout.mergeMethods}`)
    if (!layout.mergeDelete) problems.push('delete-branch toggle missing')
    if (!layout.mergeConfirm) problems.push('confirm button missing')
    if (!layout.mergeCancel) problems.push('cancel button missing')
    if (layout.mergeSha.length !== 7) problems.push(`merge sha "${layout.mergeSha}"`)
    if (!String(layout.mergeRepoText).includes('#129')) {
      problems.push(`merge repo "${layout.mergeRepoText}"`)
    }
  }
  if (scene === 'v2-chat') {
    if (!layout.chatOpen) problems.push('chat panel did not open')
    if (layout.chatMessages < 2) problems.push(`chat messages ${layout.chatMessages}`)
    if (layout.chatAssistantChars < 40) {
      problems.push(`chat answer too short (${layout.chatAssistantChars})`)
    }
    if (layout.chatStreaming) problems.push('chat still streaming after ready')
    if (layout.chatError) problems.push('chat rendered an error bubble')
  }
  if (scene === 'v2.1-auto-review') {
    if (!layout.autoCard) problems.push('auto review card missing')
    if (layout.autoSupported !== 'true') problems.push('auto review card reports unsupported')
    if (layout.autoEnabled !== 'true') problems.push('auto review card not enabled')
    if (!layout.autoRunButton) problems.push('auto review run button missing')
    if (!(layout.autoRecent >= 1)) problems.push(`auto review recent ${layout.autoRecent}`)
    if (!(layout.autoBadges >= 1)) problems.push('auto review badge missing on the PR list')
    if (!(layout.autoBadgeCount >= 1)) problems.push('auto review findings badge missing')
    if (layout.autoToast !== '1') problems.push('auto review completion toast missing')
  }
  if (scene === 'v2.1-auto-review-missing') {
    if (layout.autoSupported !== 'false') {
      problems.push('degraded auto review card did not report unsupported')
    }
    if (!String(layout.autoUnsupportedText).includes('宿主未启用自动审查')) {
      problems.push('degraded auto review copy missing')
    }
    if (layout.autoBadges !== 0) problems.push('degraded host rendered auto review badges')
  }
  if (interactions) {
    if (interactions.invalid) problems.push(interactions.invalid)
    if (scene === 'v2-merge-dialog') {
      if (interactions.mergeClosedByCancel !== true) {
        problems.push('cancel did not close the merge dialog')
      }
      if (interactions.mergeClosedByEsc !== true) {
        problems.push('Esc did not close the merge dialog')
      }
      if (interactions.mergeSha.length !== 7) problems.push('merge dialog head sha missing')
    }
    if (scene === 'v2-chat') {
      if (!(interactions.chatCharsDone > interactions.chatCharsMid)) {
        problems.push(`chat incremental rendering ${interactions.chatCharsMid} -> ${interactions.chatCharsDone}`)
      }
      if (interactions.chatStopped !== true) problems.push('stop did not end the chat stream')
      if (interactions.chatClosedByEsc !== true) problems.push('Esc did not close the chat panel')
      if (!String(interactions.chatStored).includes('#129')) {
        problems.push('chat history was not persisted')
      }
      if (!String(interactions.chatIsolation).includes('"otherMessages":"0"')) {
        problems.push(`chat history isolation ${interactions.chatIsolation}`)
      }
    }
    if (scene === 'v2.1-auto-review') {
      const polling = String(interactions.autoPolling || '')
      const parts = polling.split('->').map(Number)
      if (!(parts.length === 2 && parts[1] > parts[0])) {
        problems.push(`auto review polling ${polling || 'missing'}`)
      }
      if (interactions.autoDisabled !== 'false') {
        problems.push('auto review could not be disabled through settings')
      }
      const stop = String(interactions.autoPollStopped || '').split('->').map(Number)
      if (!(stop.length === 2 && stop[1] === stop[0])) {
        problems.push(`auto review polling did not stop (${interactions.autoPollStopped || 'missing'})`)
      }
    }
    if (scene === 'v2.1-auto-review-missing') {
      if (interactions.autoMissingCalls !== 1) {
        problems.push(`old-host auto review probe count ${interactions.autoMissingCalls}`)
      }
    }
    if (scene === 'default') {
      if (
        interactions.reviewRequested !== 'preparing' &&
        interactions.reviewRequested !== 'running'
      ) {
        problems.push(`r shortcut state "${interactions.reviewRequested}"`)
      }
      if (!String(interactions.jumpedToFile).startsWith('changes:')) {
        problems.push('right-column file link did not switch to Changes')
      } else if (Number(String(interactions.jumpedToFile).split(':')[2]) < 30) {
        problems.push(`file link did not scroll (${interactions.jumpedToFile})`)
      }
    }
    if (scene === 'changes' && !(interactions.scrollRestored >= 360)) {
      problems.push(`scroll restore ${interactions.scrollRestored}`)
    }
    if (scene === 'v11-settings' && interactions.settingsClosedByEsc !== true) {
      problems.push('Esc did not close the settings popover')
    }
  }
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
        const problems = assertScene(scene, result.layout, result.errors, result.interactions)
        const status = problems.length === 0 ? 'PASS' : 'FAIL'
        if (problems.length > 0) failed = true
        const layout = result.layout || {}
        console.log(
          `${status} ${scene.padEnd(20)} side=${layout.sidebar ? layout.sidebar.width : '?'} main=${layout.main ? layout.main.width : '?'} ` +
            `doc=${layout.doc ? layout.doc.width : '?'} details=${layout.details ? layout.details.width : '?'} ` +
            `rows=${layout.rows} files=${layout.files} diffRows=${layout.diffRows} review=${layout.reviewState} ` +
            `verdict=${layout.verdict || '-'} inline=${layout.inlineCards} comments=${layout.inlineComments} ` +
            `merge=${layout.mergeOpen ? layout.mergeSha || 'open' : '-'} chat=${layout.chatMessages}/${layout.chatAssistantChars} ` +
            `auto=${layout.autoSupported === 'false' ? 'degraded' : layout.autoEnabled === 'true' ? 'on' : 'off'}/${layout.autoRecent}/badges=${layout.autoBadges}`,
        )
        for (const problem of problems) console.log(`     - ${problem}`)
        if (problems.length > 0) {
          console.log(`     interactions: ${JSON.stringify(result.interactions)}`)
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
