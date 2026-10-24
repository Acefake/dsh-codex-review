/**
 * HTTP layer of the /codex-review route family.
 *
 * One prefix route (`/codex-review/**`) is registered on the shared webserver;
 * this module owns the transport concerns every request crosses before it
 * reaches a feature handler:
 *
 * - a loopback trust fence (socket address + Host header + browser
 *   same-origin markers, with forwarding headers refused outright),
 * - POST + `application/json` enforcement (CSRF hardening),
 * - a bounded async body reader (64 KiB),
 * - a per-request deadline (AbortController + timer),
 * - the `{ ok, value } | { ok:false, error }` JSON envelope.
 *
 * The fence mirrors `@linxin666/dsh-client-ui-git-graph`'s production
 * `loopback.ts` / `pair-access.ts` logic so both plugins answer unknown
 * callers identically.
 * @module dsh-codex-review/lib/http
 */

import { AppError, USER_MESSAGES, isAbortError, toPublicError } from './errors.js'

/** Prefix owned by this plugin; no other plugin may register under it. */
export const ROUTE_PREFIX = '/codex-review'

/** Body cap for every route (CONTRACT §1.1). */
export const BODY_LIMIT_BYTES = 64 * 1024

/** Default per-request deadline (CONTRACT §1.1). */
export const DEFAULT_DEADLINE_MS = 15_000

/** Response headers shared by every JSON answer. */
const JSON_HEADERS = Object.freeze({
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
})

/**
 * IPv4 127/8 predicate (four decimal octets, first == 127).
 * @param {string} value - candidate dotted quad.
 * @returns {boolean} true for 127.0.0.0/8.
 */
export function isIPv4Loopback(value) {
  const parts = value.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/**
 * Whether a socket remote address names the loopback range (127/8, ::1, IPv4-mapped).
 * @param {string | undefined} address - `socket.remoteAddress`.
 * @returns {boolean} true for a loopback peer.
 */
export function isLoopbackAddress(address) {
  if (typeof address !== 'string' || address === '') return false
  const normalized = address.toLowerCase()
  if (normalized === '::1') return true
  if (normalized.startsWith('::ffff:')) return isIPv4Loopback(normalized.slice('::ffff:'.length))
  return isIPv4Loopback(normalized)
}

/**
 * Whether a parsed URL hostname names the loopback authority (localhost, [::1], 127/8).
 * @param {string} hostname - `URL#hostname`.
 * @returns {boolean} true for a loopback host.
 */
export function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  return isIPv4Loopback(hostname)
}

/**
 * Whether a reverse proxy stood between the client and this host: the request
 * carries CF-Connecting-IP or X-Forwarded-For (issue #1906 in git-graph).
 * @param {{ headers?: Record<string, unknown> }} request - node request.
 * @returns {boolean} true when a forwarding header is present.
 */
export function isProxiedRequest(request) {
  const headers = request.headers ?? {}
  return headers['cf-connecting-ip'] !== undefined || headers['x-forwarded-for'] !== undefined
}

/**
 * Request-level trust fence: loopback socket AND loopback Host header, plus
 * browser same-origin markers. Forwarding headers are refused outright.
 * @param {any} request - node incoming message (fake objects in tests).
 * @returns {boolean} true when the request may enter the route family.
 */
export function isLoopbackRequest(request) {
  if (!isLoopbackAddress(request?.socket?.remoteAddress)) return false
  if (isProxiedRequest(request)) return false
  const host = request.headers?.host
  if (typeof host !== 'string' || host === '') return false
  let hostUrl
  try {
    hostUrl = new URL('http://' + host)
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/**
 * Write one JSON response. Headers are fixed: no-store + no-referrer.
 * @param {any} response - node server response.
 * @param {number} status - HTTP status.
 * @param {unknown} body - JSON-serializable body.
 */
export function writeJson(response, status, body) {
  const payload = JSON.stringify(body)
  response.writeHead(status, JSON_HEADERS)
  response.end(payload)
}

/**
 * Parse the pathname of a request target without trusting the host.
 * @param {string | undefined} target - `req.url`.
 * @returns {string} the pathname (empty string for an unparsable target).
 */
export function parsePathname(target) {
  if (typeof target !== 'string' || target === '') return ''
  try {
    return new URL(target, 'http://localhost').pathname
  } catch {
    return ''
  }
}

/**
 * Bounded JSON-object body reader. Oversized bodies destroy the request;
 * malformed payloads report a reason instead of throwing.
 * @param {AsyncIterable<Buffer | string>} request - node incoming message.
 * @param {{ maxBytes?: number }} [options] - cap override.
 * @returns {Promise<{ ok: true, value: Record<string, unknown> } | { ok: false, reason: 'invalid-json' | 'not-object' | 'too-large' }>} parse result.
 */
export async function readJsonBody(request, options = {}) {
  const maxBytes = options.maxBytes ?? BODY_LIMIT_BYTES
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    size += buffer.length
    if (size > maxBytes) {
      try {
        request.destroy?.()
      } catch {
        // the socket is already gone; nothing to clean up
      }
      return { ok: false, reason: 'too-large' }
    }
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return { ok: true, value: {} }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, reason: 'invalid-json' }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, reason: 'not-object' }
  return { ok: true, value: parsed }
}

/**
 * Run one request operation under a wall-clock deadline. The timer aborts the
 * signal handed to the operation and rejects with the stable INTERNAL/Timeout
 * envelope value.
 * @template T
 * @param {(signal: AbortSignal) => Promise<T>} operation - work bound to the signal.
 * @param {{ deadlineMs?: number }} [options] - deadline override.
 * @returns {Promise<T>} the operation's result.
 */
export async function withDeadline(operation, options = {}) {
  const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS
  const controller = new AbortController()
  /** @type {NodeJS.Timeout | undefined} */
  let timer
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort(new Error('request deadline exceeded'))
      reject(new AppError('INTERNAL', `${USER_MESSAGES.INTERNAL}：请求超时（${Math.round(deadlineMs / 1000)} 秒）`))
    }, deadlineMs)
    if (typeof timer.unref === 'function') timer.unref()
  })
  try {
    return await Promise.race([operation(controller.signal), timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Map a thrown value at the route boundary: an AppError keeps its code, an
 * abort caused by the deadline becomes the timeout sentence, anything else
 * INTERNAL. The message never carries a stack or a token.
 * @param {unknown} error - thrown value.
 * @param {AbortSignal} [signal] - the request signal.
 * @returns {{ code: string, message: string }} public error.
 */
function mapRouteError(error, signal) {
  if (error instanceof AppError) return { code: error.code, message: error.message }
  if (isAbortError(error, signal)) return { code: 'INTERNAL', message: `${USER_MESSAGES.INTERNAL}：请求已取消或超时` }
  return toPublicError(error)
}

/**
 * Build the one handler registered under {@link ROUTE_PREFIX}. `routes` maps an
 * exact pathname (`/codex-review/prs`) to `(payload, context) => Promise<value>`;
 * a thrown AppError travels as the error envelope at HTTP 200, unknown paths
 * answer 404, and fence/content-type failures answer 403/415 without a body
 * shape the client could mistake for a route answer.
 * @param {{ routes: Record<string, (payload: Record<string, unknown>, context: { signal: AbortSignal }) => Promise<unknown>>, deadlineMs?: number, maxBodyBytes?: number, logger?: { warn?: (message: string) => void } }} options - handler wiring.
 * @returns {(request: any, response: any) => Promise<void>} the node request handler.
 */
export function createJsonRouteHandler(options) {
  const routes = options?.routes
  if (routes === null || typeof routes !== 'object') throw new TypeError('createJsonRouteHandler requires a routes object')
  const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS
  const maxBodyBytes = options.maxBodyBytes ?? BODY_LIMIT_BYTES
  const logger = options.logger
  return async function handler(request, response) {
    /** @type {AbortSignal | undefined} */
    let signal
    try {
      if (!isLoopbackRequest(request)) {
        writeJson(response, 403, { error: 'forbidden: loopback-only' })
        return
      }
      if (request.method !== 'POST') {
        writeJson(response, 405, { error: 'method not allowed' })
        return
      }
      const contentType = String(request.headers?.['content-type'] ?? '').toLowerCase()
      if (!contentType.startsWith('application/json')) {
        writeJson(response, 415, { error: 'content-type must be application/json' })
        return
      }
      const pathname = parsePathname(request.url)
      const route = Object.hasOwn(routes, pathname) ? routes[pathname] : undefined
      if (typeof route !== 'function') {
        writeJson(response, 404, { error: 'not found' })
        return
      }
      const body = await readJsonBody(request, { maxBytes: maxBodyBytes })
      if (!body.ok) {
        const message = body.reason === 'too-large'
          ? `请求体超过 ${Math.round(maxBodyBytes / 1024)} KiB 上限`
          : '请求体必须是合法的 JSON 对象'
        writeJson(response, 200, { ok: false, error: { code: 'BAD_REQUEST', message } })
        return
      }
      const value = await withDeadline((deadlineSignal) => {
        signal = deadlineSignal
        return route(body.value, { signal: deadlineSignal })
      }, { deadlineMs })
      writeJson(response, 200, { ok: true, value })
    } catch (error) {
      const publicError = mapRouteError(error, signal)
      try {
        logger?.warn?.(`dsh-codex-review: ${publicError.code} ${publicError.message}`)
      } catch {
        // logging must never change the answer
      }
      try {
        writeJson(response, 200, { ok: false, error: publicError })
      } catch {
        try {
          response.destroy?.()
        } catch {
          // the socket is already gone
        }
      }
    }
  }
}
