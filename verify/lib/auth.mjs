/**
 * Authentication for the DSH Web GUI (`http://127.0.0.1:2632`).
 *
 * Every DSH web route — including plugin routes registered through
 * `ctx.webServer.register()` — is behind the browser-session cookie the
 * Connection carrier mints on the launch-token exchange. The launch token is
 * per-process and deliberately never exposed to the agent (`DSH_WEB_URL` is
 * credential-free), so this harness supports two ways in:
 *
 *  1. Launch token (preferred when available): pass `--token <token>` or set
 *     `DSH_WEB_TOKEN`. We call `GET /?token=<token>`, exactly like the browser
 *     handoff does, and capture the signed cookie from the 303 response.
 *  2. Local credentials (fallback, read-only): the durable cookie-signing
 *     secret lives in `$DSH_HOME/.credentials.yaml` under the
 *     `client-connection/browser-session` record. We mint a short-lived v1
 *     cookie from it with the same algorithm the server uses
 *     (`lib/types/browser-auth.js`): name `dsh-auth-<b64url(sha256(authority))>`,
 *     value `v1.<b64url(payload json)>.<b64url(hmac-sha256(secret, body))>`.
 *     The credentials file is only ever read; nothing is written back.
 *
 * See `README.md` § 认证 for the security notes.
 */
import { readFileSync } from 'node:fs'
import { createHash, createHmac } from 'node:crypto'
import path from 'node:path'

/** The authority the running DSH Web GUI is bound to. */
export const DEFAULT_BASE_URL = 'http://127.0.0.1:2632'

const COOKIE_PREFIX = 'dsh-auth-'
const COOKIE_VERSION = 1
const TOKEN_QUERY = 'token'
const DEFAULT_TTL_MS = 60 * 60 * 1000

/**
 * Locate the DSH home directory.
 * @returns {string} absolute path, from `DSH_HOME` when set, else `~/.dsh`.
 */
export function dshHome() {
  if (process.env.DSH_HOME) return path.resolve(process.env.DSH_HOME)
  const profile = process.env.USERPROFILE ?? process.env.HOME
  if (!profile) throw new Error('无法定位 DSH_HOME：DSH_HOME 与 USERPROFILE 都未设置')
  return path.join(profile, '.dsh')
}

/**
 * Read the durable browser-session signing secret from the DSH credentials file.
 * The YAML file is small and stable; a targeted parse avoids a YAML dependency
 * (this harness must not install npm packages).
 * @param {{home?: string}} [options]
 * @returns {Buffer} 32-byte HMAC secret.
 */
export function readBrowserSessionSecret({ home = dshHome() } = {}) {
  const file = path.join(home, '.credentials.yaml')
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    throw new Error(`读取 DSH 凭据失败（${file}）：${error.message}；请改用 --token <启动 URL 中的 token>`)
  }
  const recordAt = text.indexOf('client-connection/browser-session:')
  if (recordAt === -1) {
    throw new Error(`${file} 中没有 client-connection/browser-session 记录；请改用 --token <启动 URL 中的 token>`)
  }
  const secretMatch = text.slice(recordAt, recordAt + 4096).match(/secret:\s*([A-Za-z0-9_-]{40,})/u)
  if (!secretMatch) {
    throw new Error(`${file} 中的浏览器会话密钥格式不可识别；请改用 --token <启动 URL 中的 token>`)
  }
  const secret = Buffer.from(secretMatch[1], 'base64url')
  if (secret.byteLength !== 32) {
    throw new Error(`浏览器会话密钥长度异常（${secret.byteLength} 字节，期望 32）；请改用 --token`)
  }
  return secret
}

/**
 * Compute the cookie audience exactly like `requestAudience()` in browser-auth:
 * plain HTTP keeps the authority-only spelling (`host:port`), TLS keeps the
 * full origin.
 * @param {URL} url
 * @returns {string}
 */
export function cookieAudience(url) {
  return url.protocol === 'https:' ? url.origin : url.host
}

/**
 * Compute the authority-bound cookie name.
 * @param {string} authority
 * @returns {string} `dsh-auth-<base64url(sha256(authority))>`
 */
export function cookieName(authority) {
  return COOKIE_PREFIX + createHash('sha256').update(authority).digest('base64url')
}

/**
 * Mint a browser-session cookie from the signing secret.
 * @param {string} baseUrl GUI base URL (query and hash are ignored).
 * @param {{secret: Buffer, ttlMs?: number, now?: number}} options
 * @returns {{name: string, value: string, header: string, expiresAt: number}}
 */
export function mintAuthCookie(baseUrl, { secret, ttlMs = DEFAULT_TTL_MS, now = Date.now() } = {}) {
  const url = new URL(baseUrl)
  const authority = cookieAudience(url)
  const issuedAt = now
  const expiresAt = now + ttlMs
  const body = Buffer.from(JSON.stringify({ version: COOKIE_VERSION, authority, issuedAt, expiresAt }), 'utf8').toString('base64url')
  const signature = createHmac('sha256', secret).update(body).digest('base64url')
  const name = cookieName(authority)
  const value = `v${COOKIE_VERSION}.${body}.${signature}`
  return { name, value, header: `${name}=${value}`, expiresAt }
}

/**
 * Exchange a launch token for a signed cookie, mirroring the browser handoff.
 * @param {string} baseUrl
 * @param {string} token value of the `?token=` parameter printed by `dsh web`.
 * @returns {Promise<{name: string, value: string, header: string, source: 'launch-token'}>}
 */
export async function exchangeLaunchToken(baseUrl, token) {
  const url = new URL(baseUrl)
  url.pathname = '/'
  url.search = ''
  url.searchParams.set(TOKEN_QUERY, token)
  const response = await fetch(url, { redirect: 'manual', headers: { accept: 'text/html' } })
  const setCookies = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie') ?? '']
  const pair = setCookies.map((raw) => raw.split(';')[0]).find((raw) => raw.startsWith(COOKIE_PREFIX))
  if (!pair) {
    const body = (await response.text()).slice(0, 200)
    throw new Error(`token 交换失败：HTTP ${response.status}，响应中无 ${COOKIE_PREFIX}* cookie${body ? `（${body}）` : ''}`)
  }
  const at = pair.indexOf('=')
  return { name: pair.slice(0, at), value: pair.slice(at + 1), header: pair, source: 'launch-token' }
}

/**
 * Resolve the cookie to use for a GUI request.
 * Priority: explicit token → `DSH_WEB_TOKEN` → local credentials.
 * @param {string} [baseUrl]
 * @param {{token?: string, home?: string}} [options]
 * @returns {Promise<{cookie: string, source: string, authority: string}>}
 */
export async function resolveAuth(baseUrl = DEFAULT_BASE_URL, { token, home } = {}) {
  const url = new URL(baseUrl)
  const launchToken = token ?? process.env.DSH_WEB_TOKEN ?? ''
  if (launchToken.trim()) {
    const exchanged = await exchangeLaunchToken(baseUrl, launchToken.trim())
    return { cookie: exchanged.header, source: 'launch-token', authority: cookieAudience(url) }
  }
  const secret = readBrowserSessionSecret({ home })
  const minted = mintAuthCookie(baseUrl, { secret })
  return { cookie: minted.header, source: 'local-credentials', authority: cookieAudience(url) }
}

/**
 * Send one request to the GUI with the resolved browser-session cookie.
 * @param {string} baseUrl
 * @param {string} routePath pathname, e.g. `/codex-review/health`.
 * @param {RequestInit & {timeoutMs?: number}} [init]
 * @returns {Promise<Response>}
 */
export async function fetchAuthenticated(baseUrl, routePath, init = {}) {
  const { cookie } = await resolveAuth(baseUrl, { token: init.token })
  const headers = new Headers(init.headers)
  headers.set('cookie', cookie)
  headers.set('origin', new URL(baseUrl).origin)
  const timeoutMs = init.timeoutMs ?? 20_000
  return fetch(new URL(routePath, baseUrl), { ...init, headers, signal: AbortSignal.timeout(timeoutMs) })
}
