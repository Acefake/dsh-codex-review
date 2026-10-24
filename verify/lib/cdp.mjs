/**
 * Minimal Chrome DevTools Protocol driver for headless Microsoft Edge.
 *
 * The verification harness must run with zero npm dependencies, so this module
 * implements the small slice of CDP it needs on top of Node's built-in
 * `fetch` (discovery) and global `WebSocket` (transport):
 *
 *   launch edge --headless=new --remote-debugging-port=<free>
 *   GET /json/version            → browser WebSocket URL
 *   Target.createTarget          → an isolated page
 *   Target.attachToTarget        → flattened per-target session
 *   Page / Runtime / Network / Log domains → navigation, console, screenshots
 *
 * Every public method fails loudly (throws) on protocol errors, command
 * timeouts, or a closed socket; CLI wrappers turn those into non-zero exits.
 */
import { spawn, execFile } from 'node:child_process'
import { accessSync, constants, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import net from 'node:net'

/** Known Edge install locations on Windows, in preference order. */
const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
]

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Resolve the Edge executable, honouring `EDGE_PATH` / an explicit override.
 * @param {string} [explicit]
 * @returns {string}
 */
export function resolveEdgePath(explicit) {
  const candidates = [explicit, process.env.EDGE_PATH, ...EDGE_CANDIDATES].filter(Boolean)
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // try the next candidate
    }
  }
  throw new Error(`找不到 Edge 可执行文件（试过：${candidates.join('、')}）；可用 EDGE_PATH 指定`)
}

/**
 * Pick a currently free loopback TCP port.
 * @returns {Promise<number>}
 */
export function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

async function waitForDevtoolsEndpoint(port, timeoutMs, proc) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`Edge 提前退出（exit ${proc.exitCode}）`)
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) })
      if (response.ok) {
        const version = await response.json()
        if (version.webSocketDebuggerUrl) return version
      }
      lastError = new Error(`/json/version 返回 HTTP ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await delay(200)
  }
  throw new Error(`等待 Edge DevTools 端点超时（端口 ${port}）：${lastError?.message ?? 'unknown'}`)
}

async function waitForExit(proc, timeoutMs) {
  if (proc.exitCode !== null) return true
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) return true
    await delay(100)
  }
  return proc.exitCode !== null
}

function forceKillTree(pid) {
  try {
    execFile('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true }, () => {})
  } catch {
    // best effort only
  }
}

/**
 * Launch a headless Edge with an isolated profile and a DevTools endpoint.
 * The caller owns `close()`; it terminates the browser tree and removes the
 * temporary profile directory.
 * @param {{width?: number, height?: number, edgePath?: string, userDataDir?: string, extraArgs?: string[], startupTimeoutMs?: number, headless?: boolean}} [options]
 */
export async function launchBrowser({
  width = 1600,
  height = 1100,
  edgePath,
  userDataDir,
  extraArgs = [],
  startupTimeoutMs = 30_000,
  headless = true,
} = {}) {
  const executable = resolveEdgePath(edgePath)
  const port = await findFreePort()
  const profileDir = userDataDir ?? mkdtempSync(path.join(tmpdir(), 'dsh-verify-edge-'))
  const args = [
    ...(headless ? ['--headless=new'] : []),
    '--disable-gpu',
    '--hide-scrollbars',
    '--mute-audio',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--disable-extensions',
    '--disable-breakpad',
    '--disable-features=Translate,MediaRouter,OptimizationHints',
    `--window-size=${width},${height}`,
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${port}`,
    ...extraArgs,
    'about:blank',
  ]
  const proc = spawn(executable, args, { stdio: 'ignore', windowsHide: true })
  const version = await waitForDevtoolsEndpoint(port, startupTimeoutMs, proc)
  const connection = await CdpConnection.connect(version.webSocketDebuggerUrl)

  let closed = false
  return {
    proc,
    port,
    userDataDir: profileDir,
    wsUrl: version.webSocketDebuggerUrl,
    connection,
    async close() {
      if (closed) return
      closed = true
      try {
        await connection.send('Browser.close', {}, undefined, { timeoutMs: 3000 })
      } catch {
        // Browser.close is expected to drop the socket.
      }
      connection.closeSilently()
      const exited = await waitForExit(proc, 5000)
      if (!exited && proc.pid) forceKillTree(proc.pid)
      await delay(150)
      try {
        rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      } catch {
        // A locked temp profile is harmless; leave it for the OS to clean up.
      }
    },
  }
}

/** One multiplexed CDP connection (browser-level and flattened target sessions). */
export class CdpConnection {
  #socket
  #pending = new Map()
  #listeners = new Map()
  #closed = false
  #nextId = 1

  constructor(socket) {
    this.#socket = socket
    socket.addEventListener('message', (event) => this.#dispatch(event))
    socket.addEventListener('close', () => this.#failAll(new Error('CDP 连接已关闭')))
    socket.addEventListener('error', () => this.#failAll(new Error('CDP 连接出错')))
  }

  /**
   * Connect to a browser WebSocket endpoint.
   * @param {string} url `ws://127.0.0.1:<port>/devtools/browser/<id>`
   * @param {{timeoutMs?: number}} [options]
   * @returns {Promise<CdpConnection>}
   */
  static connect(url, { timeoutMs = 20_000 } = {}) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url)
      const timer = setTimeout(() => {
        try {
          socket.close()
        } catch {
          // ignore
        }
        reject(new Error(`连接 CDP WebSocket 超时：${url}`))
      }, timeoutMs)
      socket.addEventListener('open', () => {
        clearTimeout(timer)
        resolve(new CdpConnection(socket))
      }, { once: true })
      socket.addEventListener('error', (event) => {
        clearTimeout(timer)
        reject(new Error(`连接 CDP WebSocket 失败：${url}（${event?.message ?? 'socket error'}）`))
      }, { once: true })
    })
  }

  #dispatch(event) {
    let message
    try {
      message = JSON.parse(typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString('utf8'))
    } catch {
      return
    }
    if (typeof message.id === 'number') {
      const pending = this.#pending.get(message.id)
      if (!pending) return
      this.#pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.error) pending.reject(new Error(`${pending.method} 失败：${message.error.message}（code ${message.error.code}）`))
      else pending.resolve(message.result)
      return
    }
    for (const listener of this.#listeners.get(message.method) ?? []) {
      try {
        listener(message.params ?? {}, message.sessionId)
      } catch {
        // A listener must never break the protocol pump.
      }
    }
  }

  #failAll(error) {
    this.#closed = true
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.#pending.clear()
  }

  /**
   * Send a CDP command.
   * @param {string} method
   * @param {Record<string, unknown>} [params]
   * @param {string} [sessionId] flattened target session; omit for browser-level commands
   * @param {{timeoutMs?: number}} [options]
   * @returns {Promise<Record<string, unknown>>}
   */
  send(method, params = {}, sessionId, { timeoutMs = 30_000 } = {}) {
    if (this.#closed) return Promise.reject(new Error(`CDP 已关闭，无法发送 ${method}`))
    const id = this.#nextId++
    const envelope = { id, method, params }
    if (sessionId !== undefined) envelope.sessionId = sessionId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error(`${method} 超时（${timeoutMs}ms）`))
      }, timeoutMs)
      this.#pending.set(id, { method, resolve, reject, timer })
      try {
        this.#socket.send(JSON.stringify(envelope))
      } catch (error) {
        clearTimeout(timer)
        this.#pending.delete(id)
        reject(new Error(`发送 ${method} 失败：${error.message}`))
      }
    })
  }

  /**
   * Subscribe to one CDP event.
   * @param {string} method
   * @param {(params: Record<string, unknown>, sessionId?: string) => void} listener
   * @returns {() => void} unsubscribe
   */
  on(method, listener) {
    const listeners = this.#listeners.get(method) ?? new Set()
    listeners.add(listener)
    this.#listeners.set(method, listeners)
    return () => listeners.delete(listener)
  }

  /**
   * Resolve once a matching CDP event arrives.
   * @param {string} method
   * @param {{sessionId?: string, predicate?: (params: Record<string, unknown>) => boolean, timeoutMs?: number}} [options]
   * @returns {Promise<Record<string, unknown>>}
   */
  waitForEvent(method, { sessionId, predicate, timeoutMs = 30_000 } = {}) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe()
        reject(new Error(`等待事件 ${method} 超时（${timeoutMs}ms）`))
      }, timeoutMs)
      const unsubscribe = this.on(method, (params, eventSessionId) => {
        if (sessionId !== undefined && eventSessionId !== sessionId) return
        if (predicate && !predicate(params)) return
        clearTimeout(timer)
        unsubscribe()
        resolve(params)
      })
    })
  }

  closeSilently() {
    this.#failAll(new Error('CDP 连接已关闭'))
    try {
      this.#socket.close()
    } catch {
      // ignore
    }
  }
}

function formatRemoteObject(object) {
  if (!object || typeof object !== 'object') return String(object)
  if (object.type === 'undefined') return 'undefined'
  if ('value' in object) return typeof object.value === 'string' ? object.value : JSON.stringify(object.value)
  if (object.unserializableValue) return String(object.unserializableValue)
  if (object.preview) {
    const properties = (object.preview.properties ?? [])
      .slice(0, 8)
      .map((property) => `${property.name}: ${String(property.value ?? property.type ?? '').slice(0, 120)}`)
    return `${object.preview.description ?? object.type ?? 'Object'} { ${properties.join(', ')} }`
  }
  return object.description ?? `<${object.type ?? 'unknown'}>`
}

function formatExceptionDetails(details) {
  const description = details?.exception?.description
  if (typeof description === 'string' && description.trim()) return description.trim()
  const text = details?.text ?? 'Unknown page error'
  const location = details?.url ? ` (${details.url}:${(details.lineNumber ?? 0) + 1})` : ''
  return text + location
}

/** One attached page target with console/network/page-error collection. */
export class PageSession {
  #connection
  #sessionId
  #targetId
  #inflight = new Set()
  #requestUrls = new Map()
  #lastNetworkActivity = Date.now()
  #mainFrameId

  /** @type {Array<{type: string, text: string, args: string[], url?: string, line?: number, column?: number, timestamp: number}>} */
  consoleMessages = []
  /** @type {Array<{message: string, url?: string, line?: number, column?: number, stack?: string, timestamp: number}>} */
  pageErrors = []
  /** @type {Array<{level: string, text: string, source?: string, url?: string, timestamp: number}>} */
  logEntries = []
  /** @type {Array<{url: string, method?: string, errorText: string, type?: string, timestamp: number}>} */
  failedRequests = []
  /** @type {Array<{url: string, method: string, resourceType: string, status?: number, timestamp: number}>} */
  networkRequests = []
  /** Count of target crashes observed while attached. */
  crashCount = 0

  constructor(connection, targetId, sessionId) {
    this.#connection = connection
    this.#targetId = targetId
    this.#sessionId = sessionId
    this.#registerListeners()
  }

  /** @returns {string} */
  get sessionId() {
    return this.#sessionId
  }

  /** @returns {string} */
  get targetId() {
    return this.#targetId
  }

  /**
   * Create an isolated page target and attach to it with a flattened session.
   * @param {CdpConnection} connection
   * @param {{width?: number, height?: number}} [viewport]
   * @returns {Promise<PageSession>}
   */
  static async open(connection, { width = 1600, height = 1100 } = {}) {
    const target = await connection.send('Target.createTarget', { url: 'about:blank' })
    const attached = await connection.send('Target.attachToTarget', { targetId: target.targetId, flatten: true })
    const page = new PageSession(connection, target.targetId, attached.sessionId)
    await page.#initialize({ width, height })
    return page
  }

  #registerListeners() {
    const session = this.#sessionId
    const connection = this.#connection
    const belongs = (eventSessionId) => eventSessionId === session

    connection.on('Runtime.consoleAPICalled', (params, eventSessionId) => {
      if (!belongs(eventSessionId)) return
      this.consoleMessages.push({
        type: String(params.type ?? 'log'),
        text: (params.args ?? []).map(formatRemoteObject).join(' '),
        args: (params.args ?? []).map(formatRemoteObject),
        url: params.stackTrace?.callFrames?.[0]?.url,
        line: params.stackTrace?.callFrames?.[0]?.lineNumber,
        column: params.stackTrace?.callFrames?.[0]?.columnNumber,
        timestamp: Number(params.timestamp ?? Date.now()),
      })
    })

    connection.on('Runtime.exceptionThrown', (params, eventSessionId) => {
      if (!belongs(eventSessionId)) return
      const details = params.exceptionDetails ?? {}
      const frame = details.stackTrace?.callFrames?.[0]
      this.pageErrors.push({
        message: formatExceptionDetails(details),
        url: details.url,
        line: details.lineNumber,
        column: details.columnNumber,
        stack: details.stackTrace?.callFrames?.slice(0, 6)
          .map((callFrame) => `at ${callFrame.functionName || '(anonymous)'} (${callFrame.url ?? '?'}:${(callFrame.lineNumber ?? 0) + 1}:${(callFrame.columnNumber ?? 0) + 1})`)
          .join('\n') || undefined,
        frameUrl: frame?.url,
        timestamp: Date.now(),
      })
    })

    connection.on('Log.entryAdded', (params, eventSessionId) => {
      if (!belongs(eventSessionId)) return
      const entry = params.entry ?? {}
      this.logEntries.push({
        level: String(entry.level ?? 'info'),
        text: String(entry.text ?? ''),
        source: entry.source,
        url: entry.url,
        timestamp: Date.now(),
      })
    })

    connection.on('Network.requestWillBeSent', (params, eventSessionId) => {
      if (!belongs(eventSessionId)) return
      const type = String(params.type ?? 'Other')
      this.#lastNetworkActivity = Date.now()
      this.networkRequests.push({
        url: String(params.request?.url ?? ''),
        method: String(params.request?.method ?? 'GET'),
        resourceType: type,
        timestamp: Date.now(),
      })
      // WebSocket/EventSource handshakes never report loadingFinished.
      if (type === 'WebSocket' || type === 'EventSource') return
      this.#inflight.add(params.requestId)
      this.#requestUrls.set(params.requestId, String(params.request?.url ?? ''))
    })

    connection.on('Network.responseReceived', (params, eventSessionId) => {
      if (!belongs(eventSessionId)) return
      const entry = this.networkRequests.find((request) => request.url === params.response?.url)
      if (!entry) return
      entry.status = Number(params.response?.status ?? 0)
    })

    const finish = (params, eventSessionId) => {
      if (!belongs(eventSessionId)) return
      this.#lastNetworkActivity = Date.now()
      this.#inflight.delete(params.requestId)
      this.#requestUrls.delete(params.requestId)
    }
    connection.on('Network.loadingFinished', finish)
    connection.on('Network.loadingFailed', (params, eventSessionId) => {
      if (!belongs(eventSessionId)) return
      const url = this.#requestUrls.get(params.requestId) ?? ''
      this.failedRequests.push({
        url,
        errorText: String(params.errorText ?? 'unknown'),
        type: String(params.type ?? ''),
        timestamp: Date.now(),
      })
      finish(params, eventSessionId)
    })

    connection.on('Inspector.targetCrashed', (params, eventSessionId) => {
      if (!belongs(eventSessionId)) return
      this.crashCount += 1
    })
  }

  #send(method, params, options) {
    return this.#connection.send(method, params, this.#sessionId, options)
  }

  async #initialize({ width, height }) {
    await this.#send('Page.enable')
    await this.#send('Runtime.enable')
    await this.#send('Log.enable')
    await this.#send('Network.enable')
    await this.#send('Page.setLifecycleEventsEnabled', { enabled: true })
    await this.#send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    })
    const frameTree = await this.#send('Page.getFrameTree')
    this.#mainFrameId = frameTree.frameTree?.frame?.id
  }

  /**
   * Install a browser-session cookie before navigation.
   * @param {{name: string, value: string}} cookie
   * @param {string} origin e.g. `http://127.0.0.1:2632`
   */
  async setCookie({ name, value }, origin) {
    await this.#send('Network.setCookie', {
      name,
      value,
      url: origin,
      path: '/',
      httpOnly: true,
      secure: origin.startsWith('https:'),
      sameSite: 'Strict',
    })
  }

  /**
   * Evaluate a script in the page.
   * @param {string} expression
   * @param {{awaitPromise?: boolean, timeoutMs?: number}} [options]
   * @returns {Promise<unknown>} the JSON value when serializable
   */
  async evaluate(expression, { awaitPromise = true, timeoutMs = 20_000 } = {}) {
    const result = await this.#send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
      userGesture: true,
    }, { timeoutMs })
    if (result.exceptionDetails) {
      throw new Error(`页面脚本执行失败：${formatExceptionDetails(result.exceptionDetails)}`)
    }
    return result.result?.value
  }

  /**
   * Wait for a main-frame lifecycle milestone (`load`, `networkIdle`, ...).
   * @param {string} name
   * @param {number} timeoutMs
   * @returns {Promise<boolean>} false on timeout (never rejects)
   */
  async waitForLifecycle(name, timeoutMs) {
    try {
      await this.#connection.waitForEvent('Page.lifecycleEvent', {
        sessionId: this.#sessionId,
        timeoutMs,
        predicate: (params) => params.name === name && (!this.#mainFrameId || params.frameId === this.#mainFrameId),
      })
      return true
    } catch {
      return false
    }
  }

  /**
   * Wait until the network has been quiet for `idleMs`.
   * @param {{timeoutMs?: number, idleMs?: number}} [options]
   * @returns {Promise<boolean>} false on timeout
   */
  async waitForNetworkIdle({ timeoutMs = 20_000, idleMs = 700 } = {}) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (this.#inflight.size === 0 && Date.now() - this.#lastNetworkActivity >= idleMs) return true
      await delay(100)
    }
    return false
  }

  /**
   * Navigate to `url` and wait for load, network quiet, and a settle delay.
   * @param {string} url
   * @param {{timeoutMs?: number, idleMs?: number, settleMs?: number}} [options]
   * @returns {Promise<{networkIdle: boolean}>}
   */
  async goto(url, { timeoutMs = 45_000, idleMs = 700, settleMs = 900 } = {}) {
    const loaded = this.waitForLifecycle('load', timeoutMs)
    const navigation = await this.#send('Page.navigate', { url }, { timeoutMs })
    if (navigation.errorText) throw new Error(`导航到 ${url} 失败：${navigation.errorText}`)
    const loadReached = await loaded
    if (!loadReached) throw new Error(`导航到 ${url} 后等待 load 事件超时（${timeoutMs}ms）`)
    const networkIdle = await this.waitForNetworkIdle({ timeoutMs: Math.min(20_000, timeoutMs), idleMs })
    if (settleMs > 0) await delay(settleMs)
    return { networkIdle }
  }

  /**
   * Poll an expression until it returns truthy.
   * @param {string} expression JavaScript expression evaluated in the page
   * @param {{timeoutMs?: number, intervalMs?: number, label?: string}} [options]
   * @returns {Promise<unknown>} the final truthy value
   */
  async waitFor(expression, { timeoutMs = 15_000, intervalMs = 150, label = '页面条件' } = {}) {
    const deadline = Date.now() + timeoutMs
    let lastError
    while (Date.now() < deadline) {
      try {
        const value = await this.evaluate(expression, { timeoutMs: Math.min(5000, timeoutMs) })
        if (value) return value
      } catch (error) {
        lastError = error
      }
      await delay(intervalMs)
    }
    throw new Error(`等待${label}超时（${timeoutMs}ms）${lastError ? `；最后错误：${lastError.message}` : ''}`)
  }

  /** @returns {Promise<string>} document.title */
  async title() {
    return String(await this.evaluate('document.title') ?? '')
  }

  /**
   * Capture a PNG screenshot.
   * @param {string} filePath
   * @param {{fullPage?: boolean}} [options]
   * @returns {Promise<string>} the written path
   */
  async screenshot(filePath, { fullPage = false } = {}) {
    mkdirSync(path.dirname(filePath), { recursive: true })
    const params = { format: 'png', fromSurface: true }
    if (fullPage) {
      const metrics = await this.#send('Page.getLayoutMetrics')
      const size = metrics.cssContentSize ?? metrics.contentSize ?? { width: 1600, height: 1100 }
      params.captureBeyondViewport = true
      params.clip = { x: 0, y: 0, width: Math.ceil(size.width), height: Math.ceil(size.height), scale: 1 }
    }
    const shot = await this.#send('Page.captureScreenshot', params, { timeoutMs: 30_000 })
    writeFileSync(filePath, Buffer.from(shot.data, 'base64'))
    return filePath
  }

  /**
   * Dispatch a real left-button click at viewport coordinates.
   * @param {number} x
   * @param {number} y
   * @returns {Promise<void>}
   */
  async click(x, y) {
    const point = { x: Math.round(x), y: Math.round(y) }
    await this.#send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point, button: 'none', buttons: 0 })
    await delay(90)
    await this.#send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1 })
    await delay(50)
    await this.#send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', buttons: 0, clickCount: 1 })
  }

  /**
   * Press and release a key (used to dismiss modals with Escape).
   * @param {string} key DOM `key` value, e.g. `Escape`
   * @param {{code?: string, windowsVirtualKeyCode?: number}} [options]
   * @returns {Promise<void>}
   */
  async pressKey(key, { code, windowsVirtualKeyCode } = {}) {
    const base = { key, code: code ?? key, windowsVirtualKeyCode: windowsVirtualKeyCode ?? 0, nativeVirtualKeyCode: windowsVirtualKeyCode ?? 0 }
    await this.#send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base })
    await this.#send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
  }

  /** Bring the target to the foreground (headless pages are active by default). */
  async bringToFront() {
    await this.#send('Page.bringToFront')
  }

  /** Close the target (best effort) and stop accepting events. */
  async close() {
    try {
      await this.#connection.send('Target.closeTarget', { targetId: this.#targetId }, undefined, { timeoutMs: 5000 })
    } catch {
      // The browser may already be gone.
    }
  }
}
