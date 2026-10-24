/**
 * Tiny HTTP client for the plugin's same-origin JSON routes.
 *
 * Mirrors what the browser client does (`plugin/CONTRACT.md` §2):
 * POST, `content-type: application/json`, path without a leading slash, the
 * DSH browser-session cookie, and a same-authority `Origin` header so the
 * Host fence accepts the request. Every call is bounded by an abort timeout.
 */
import { resolveAuth } from './auth.mjs'

export class GuiHttpError extends Error {
  /**
   * @param {string} message
   * @param {{status?: number, elapsedMs?: number, body?: string}} [details]
   */
  constructor(message, { status, elapsedMs, body } = {}) {
    super(message)
    this.name = 'GuiHttpError'
    this.status = status
    this.elapsedMs = elapsedMs
    this.body = body
  }
}

export class GuiClient {
  #baseUrl
  #origin
  #token
  #authPromise = null

  /**
   * @param {string} baseUrl GUI base URL, e.g. `http://127.0.0.1:2632/`
   * @param {{token?: string}} [options]
   */
  constructor(baseUrl, { token } = {}) {
    this.#baseUrl = new URL(baseUrl)
    this.#origin = this.#baseUrl.origin
    this.#token = token
  }

  /** @returns {string} */
  get origin() {
    return this.#origin
  }

  /** @returns {Promise<{source: string, cookie: string}>} */
  async authenticate() {
    if (!this.#authPromise) {
      this.#authPromise = resolveAuth(this.#baseUrl.href, { token: this.#token })
    }
    return this.#authPromise
  }

  /**
   * POST one JSON route and return the raw HTTP result with a parsed body.
   * The HTTP layer never throws for 4xx/5xx; callers inspect `status`/`json`.
   * @param {string} routePath path relative to the GUI root, e.g. `codex-review/health`
   * @param {Record<string, unknown>} [body]
   * @param {{timeoutMs?: number, headers?: Record<string, string>}} [options] `headers` override the defaults (trust-fence probes)
   * @returns {Promise<{status: number, elapsedMs: number, contentType: string, cacheControl: string, json: unknown, text: string, parseError?: string}>}
   */
  async post(routePath, body = {}, { timeoutMs = 20_000, headers = {} } = {}) {
    const auth = await this.authenticate()
    const url = new URL(routePath, this.#baseUrl)
    const startedAt = Date.now()
    let response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          cookie: auth.cookie,
          origin: this.#origin,
          ...headers,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      const elapsedMs = Date.now() - startedAt
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        throw new GuiHttpError(`POST ${routePath} 超时（${timeoutMs}ms）`, { elapsedMs })
      }
      throw new GuiHttpError(`POST ${routePath} 网络错误：${error.message}`, { elapsedMs })
    }
    const text = await response.text()
    const elapsedMs = Date.now() - startedAt
    let json
    let parseError
    try {
      json = text === '' ? undefined : JSON.parse(text)
      if (json === undefined) parseError = '空响应体'
    } catch (error) {
      parseError = `JSON 解析失败：${error.message}`
    }
    return {
      status: response.status,
      elapsedMs,
      contentType: response.headers.get('content-type') ?? '',
      cacheControl: response.headers.get('cache-control') ?? '',
      json,
      text,
      parseError,
    }
  }

  /**
   * POST one Server-Sent-Events route (v2 `codex-review/chat`) and collect every
   * `data: {...}` frame. Non-SSE responses (guard rejections) are returned as
   * `json`/`text` with `contentType` so callers can assert the error envelope.
   * @param {string} routePath
   * @param {Record<string, unknown>} [body]
   * @param {{timeoutMs?: number, maxBytes?: number}} [options]
   * @returns {Promise<{status: number, contentType: string, elapsedMs: number, events: Array<Record<string, unknown>>, raw: string, parseErrors: string[], json?: unknown, text: string}>}
   */
  async postSse(routePath, body = {}, { timeoutMs = 300_000, maxBytes = 4_000_000 } = {}) {
    const auth = await this.authenticate()
    const url = new URL(routePath, this.#baseUrl)
    const startedAt = Date.now()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          cookie: auth.cookie,
          origin: this.#origin,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (error) {
      clearTimeout(timer)
      const elapsedMs = Date.now() - startedAt
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') throw new GuiHttpError(`POST ${routePath} 流式超时（${timeoutMs}ms）`, { elapsedMs })
      throw new GuiHttpError(`POST ${routePath} 流式网络错误：${error.message}`, { elapsedMs })
    }
    const contentType = response.headers.get('content-type') ?? ''
    const events = []
    const parseErrors = []
    let raw = ''
    const isSse = /text\/event-stream/i.test(contentType)
    try {
      if (isSse && response.body) {
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        let bytes = 0
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          bytes += value?.byteLength ?? 0
          if (bytes > maxBytes) {
            await reader.cancel().catch(() => {})
            parseErrors.push(`SSE 超过 ${maxBytes} 字节上限`)
            break
          }
          const chunk = decoder.decode(value, { stream: true })
          raw += chunk
          buffer += chunk
          for (;;) {
            const at = buffer.indexOf('\n\n')
            if (at === -1) break
            const frame = buffer.slice(0, at)
            buffer = buffer.slice(at + 2)
            for (const line of frame.split('\n')) {
              if (!line.startsWith('data:')) continue
              const payload = line.slice(5).trim()
              if (payload === '') continue
              try {
                events.push(JSON.parse(payload))
              } catch (error) {
                parseErrors.push(`SSE data 帧不是 JSON：${payload.slice(0, 120)}`)
              }
            }
          }
        }
      } else {
        raw = await response.text()
      }
    } finally {
      clearTimeout(timer)
    }
    const elapsedMs = Date.now() - startedAt
    let json
    if (!isSse) {
      try {
        json = raw === '' ? undefined : JSON.parse(raw)
      } catch {
        json = undefined
      }
    }
    return { status: response.status, contentType, elapsedMs, events, raw, parseErrors, json, text: isSse ? raw : raw }
  }
}
