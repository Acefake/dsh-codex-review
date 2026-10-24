/**
 * Shared CLI plumbing for the verification harness: argument parsing helpers,
 * GUI-origin detection, browser-session cookie resolution, JSON/PNG output
 * helpers, and a uniform exit-code convention.
 *
 * Exit codes (all CLIs):
 *   0 断言全部通过 / 操作成功
 *   1 验证失败（装置可用，但被验证对象不符合契约）
 *   2 装置或环境错误（参数、认证、浏览器启动、超时等）
 *   3 插件路由未就绪（仅 api-probe：/codex-review/* 尚未注册）
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_BASE_URL, resolveAuth } from './auth.mjs'

/** Absolute path of the `verify/` directory (this module lives in `verify/lib/`). */
export const VERIFY_ROOT = fileURLToPath(new URL('..', import.meta.url))

/** Absolute path of the `verify/out/` directory (machine-generated artifacts). */
export const OUT_ROOT = path.join(VERIFY_ROOT, 'out')

/**
 * Create (if needed) and return a throwaway directory under `verify/out/.tmp/`.
 * All harness scratch data — Edge profiles included — stays inside the allowed
 * `verify/**` write scope.
 * @param {string} name
 * @returns {string}
 */
export function scratchDir(name) {
  const dir = path.join(OUT_ROOT, '.tmp', name)
  mkdirSync(dir, { recursive: true })
  return dir
}

export const EXIT = Object.freeze({
  OK: 0,
  FAIL: 1,
  ENV: 2,
  ROUTES_NOT_READY: 3,
})

/** @returns {string} ISO-like local timestamp safe for filenames: `20261024-144500` */
export function timestampForFile(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

/** @returns {string} ISO timestamp for reports */
export function isoTimestamp(date = new Date()) {
  return date.toISOString()
}

/**
 * The DSH Web GUI origin the harness is pointed at.
 * @param {string} [url]
 * @returns {string}
 */
export function guiOrigin(url = process.env.DSH_WEB_URL ?? DEFAULT_BASE_URL) {
  return new URL(url).origin
}

/**
 * Whether a URL belongs to the DSH Web GUI origin (and therefore needs the
 * browser-session cookie).
 * @param {string} url
 * @param {string} [base]
 * @returns {boolean}
 */
export function isGuiUrl(url, base = process.env.DSH_WEB_URL ?? DEFAULT_BASE_URL) {
  try {
    return new URL(url).origin === guiOrigin(base)
  } catch {
    return false
  }
}

/**
 * Resolve the browser-session cookie for a URL, if the URL is the GUI.
 * @param {string} url
 * @param {{token?: string, noAuth?: boolean, base?: string}} [options]
 * @returns {Promise<{name: string, value: string, source: string} | null>}
 */
export async function cookieForUrl(url, { token, noAuth = false, base } = {}) {
  if (noAuth) return null
  if (!token && !isGuiUrl(url, base)) return null
  const auth = await resolveAuth(url, { token })
  const at = auth.cookie.indexOf('=')
  return { name: auth.cookie.slice(0, at), value: auth.cookie.slice(at + 1), source: auth.source }
}

/**
 * Write a JSON report, creating parent directories.
 * @param {string} filePath
 * @param {unknown} value
 * @returns {string} the written path
 */
export function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true })
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  return filePath
}

/**
 * Print a human-readable failure and exit with the given code.
 * @param {string} message
 * @param {number} [code]
 * @returns {never}
 */
export function fail(message, code = EXIT.ENV) {
  console.error(`✗ ${message}`)
  process.exit(code)
}

/**
 * Mark every requested path that does not exist yet.
 * @param {string} filePath
 * @returns {string}
 */
export function ensureParent(filePath) {
  mkdirSync(path.dirname(filePath), { recursive: true })
  return filePath
}
