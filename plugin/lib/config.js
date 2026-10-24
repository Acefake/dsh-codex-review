/**
 * Host configuration surface of dsh-codex-review.
 *
 * `Config` is validated by the Cordis Loader through the Standard Schema
 * protocol (`Config['~standard'].validate`), so the primary form is a
 * Schemastery schema (the same shape the shipped plugins use; the profile
 * already carries `@deepseek-ai/schemastery`). A link-installed plugin does
 * not live under the profile's `node_modules`, so the dependency is resolved
 * in three steps: normal ESM resolution, a `createRequire` anchored at the
 * running profile (`DSH_PROFILE_DIR`), and — if neither is reachable — a tiny
 * self-contained Standard Schema with the same fields. `resolveConfig` then
 * applies the same defaults/clamps at code level, so `apply()` never depends
 * on which schema form was loaded.
 * @module dsh-codex-review/lib/config
 */

import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Default values; also the code-level fallback when no config is supplied. */
export const DEFAULT_CONFIG = Object.freeze({
  defaultQuery: 'is:open author:@me',
  limit: 30,
  maxPatchChars: 24000,
  maxBodyChars: 50000,
  reviewChunkChars: 9000,
  maxChunks: 9,
  reviewConcurrency: 3,
  maxOutputTokens: 0,
  provider: '',
  model: '',
  maxJobs: 20,
  requestTimeoutMs: 15000,
  ghPath: 'gh',
})

/** Integer bounds for the numeric fields, used by both resolve paths. */
const NUMERIC_BOUNDS = Object.freeze({
  limit: [1, 100],
  maxPatchChars: [1000, 1_000_000],
  maxBodyChars: [1000, 1_000_000],
  reviewChunkChars: [1000, 500_000],
  maxChunks: [1, 50],
  reviewConcurrency: [1, 6],
  maxOutputTokens: [0, 200_000],
  maxJobs: [1, 200],
  requestTimeoutMs: [1000, 600_000],
})

/** Fields the schema declares, in declaration order. */
export const CONFIG_FIELDS = Object.freeze(Object.keys(DEFAULT_CONFIG))

/** @param {string} key @returns {[number, number]} */
function boundsOf(key) {
  return NUMERIC_BOUNDS[key] ?? [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]
}

/**
 * Clamp a numeric config value; non-finite values fall back to the default.
 * @param {unknown} value - raw value.
 * @param {string} key - config field name.
 * @returns {number} a bounded integer.
 */
export function clampInt(value, key) {
  const fallback = /** @type {number} */ (DEFAULT_CONFIG[key])
  const [min, max] = boundsOf(key)
  const numeric = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN
  if (!Number.isFinite(numeric)) return fallback
  return Math.min(max, Math.max(min, Math.round(numeric)))
}

/**
 * Clamp or default one string field.
 * @param {unknown} value - raw value.
 * @param {string} key - config field name.
 * @returns {string} trimmed string, or the default.
 */
export function clampString(value, key) {
  if (typeof value !== 'string') return /** @type {string} */ (DEFAULT_CONFIG[key])
  const trimmed = value.trim()
  return trimmed === '' ? /** @type {string} */ (DEFAULT_CONFIG[key]) : trimmed
}

/**
 * Code-level config resolution: defaults for absent fields, clamps for
 * numeric ones, trimmed strings. Unknown keys are ignored.
 * @param {Record<string, unknown> | undefined | null} raw - validated or raw config.
 * @returns {{ defaultQuery: string, limit: number, maxPatchChars: number, maxBodyChars: number, reviewChunkChars: number, maxChunks: number, maxOutputTokens: number, provider: string, model: string, maxJobs: number, requestTimeoutMs: number, ghPath: string }} resolved config.
 */
export function resolveConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  return {
    defaultQuery: clampString(source.defaultQuery, 'defaultQuery'),
    limit: clampInt(source.limit, 'limit'),
    maxPatchChars: clampInt(source.maxPatchChars, 'maxPatchChars'),
    maxBodyChars: clampInt(source.maxBodyChars, 'maxBodyChars'),
    reviewChunkChars: clampInt(source.reviewChunkChars, 'reviewChunkChars'),
    maxChunks: clampInt(source.maxChunks, 'maxChunks'),
    reviewConcurrency: clampInt(source.reviewConcurrency, 'reviewConcurrency'),
    maxOutputTokens: clampInt(source.maxOutputTokens, 'maxOutputTokens'),
    provider: typeof source.provider === 'string' ? source.provider.trim() : '',
    model: typeof source.model === 'string' ? source.model.trim() : '',
    maxJobs: clampInt(source.maxJobs, 'maxJobs'),
    requestTimeoutMs: clampInt(source.requestTimeoutMs, 'requestTimeoutMs'),
    ghPath: clampString(source.ghPath, 'ghPath'),
  }
}

/**
 * Self-contained Standard Schema for the config fields. Used only when
 * Schemastery cannot be loaded: it is intentionally permissive (unknown keys
 * dropped, bad values replaced by defaults) so a typo can never keep the
 * plugin from mounting, which would also take browsing down.
 * @returns {{ '~standard': { version: number, vendor: string, validate: (value: unknown) => { value: Record<string, unknown> } } }} schema object.
 */
function createFallbackSchema() {
  return {
    '~standard': {
      version: 1,
      vendor: 'dsh-codex-review',
      validate(value) {
        const source = value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
        const resolved = /** @type {Record<string, unknown>} */ ({})
        for (const key of CONFIG_FIELDS) {
          const raw = /** @type {Record<string, unknown>} */ (source)[key]
          if (raw === undefined) continue
          const numeric = Object.hasOwn(NUMERIC_BOUNDS, key)
          if (numeric) {
            if (typeof raw === 'number' && Number.isFinite(raw)) resolved[key] = clampInt(raw, key)
            else if (typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(Number(raw))) resolved[key] = clampInt(Number(raw), key)
            else resolved[key] = /** @type {number} */ (DEFAULT_CONFIG[key])
          } else if (typeof raw === 'string') {
            resolved[key] = raw.trim() === '' && key !== 'provider' && key !== 'model' ? /** @type {string} */ (DEFAULT_CONFIG[key]) : raw.trim()
          }
        }
        return { value: resolved }
      },
    },
  }
}

/** @returns {string} the profile directory the running Host was mounted for, if any. */
function profileDirectories() {
  const directories = []
  const configured = process.env.DSH_PROFILE_DIR
  if (typeof configured === 'string' && configured !== '') directories.push(configured)
  const home = process.env.DSH_HOME
  const profile = process.env.DSH_PROFILE
  if (typeof home === 'string' && home !== '' && typeof profile === 'string' && profile !== '') {
    directories.push(join(home, 'profiles', profile))
  }
  if (typeof home === 'string' && home !== '') directories.push(join(home, 'profiles', 'desktop'))
  directories.push(join(homedir(), '.dsh', 'profiles', 'desktop'))
  return [...new Set(directories)]
}

/** @param {string} directory @returns {boolean} */
function hasProfileSchemastery(directory) {
  return existsSync(join(directory, 'node_modules', '@deepseek-ai', 'schemastery', 'package.json'))
}

/**
 * Load Schemastery through the three supported routes. The result is the
 * library's `z` callable, or `undefined` when no route works.
 * @returns {any} Schemastery's default export, or undefined.
 */
function loadSchemastery() {
  try {
    const required = createRequire(import.meta.url)
    const loaded = required('@deepseek-ai/schemastery')
    const candidate = loaded?.default ?? loaded
    if (typeof candidate?.object === 'function') return candidate
  } catch {
    // fall through: a link-installed plugin resolves outside the profile tree
  }
  for (const directory of profileDirectories()) {
    if (!hasProfileSchemastery(directory)) continue
    try {
      const required = createRequire(join(directory, 'package.json'))
      const loaded = required('@deepseek-ai/schemastery')
      const candidate = loaded?.default ?? loaded
      if (typeof candidate?.object === 'function') return candidate
    } catch {
      // try the next profile directory
    }
  }
  return undefined
}

/** @type {any} */
const z = loadSchemastery()

/** Which schema form is active: `schemastery` in the running Host when resolvable, else `standard`. */
export const configSchemaKind = z === undefined ? 'standard' : 'schemastery'

/**
 * Build the Schemastery schema for the fields (defaults included).
 * @param {any} library - Schemastery `z` callable.
 * @returns {any} the schema.
 */
function buildSchemastery(library) {
  return library.object({
    defaultQuery: library.string().default(DEFAULT_CONFIG.defaultQuery),
    limit: library.number().step(1).min(1).max(100).default(DEFAULT_CONFIG.limit),
    maxPatchChars: library.number().step(1).min(1000).default(DEFAULT_CONFIG.maxPatchChars),
    maxBodyChars: library.number().step(1).min(1000).default(DEFAULT_CONFIG.maxBodyChars),
    reviewChunkChars: library.number().step(1).min(1000).default(DEFAULT_CONFIG.reviewChunkChars),
    maxChunks: library.number().step(1).min(1).max(50).default(DEFAULT_CONFIG.maxChunks),
    reviewConcurrency: library.number().step(1).min(1).max(6).default(DEFAULT_CONFIG.reviewConcurrency),
    // 0 = let the adapter materialize the model's own output cap.
    maxOutputTokens: library.number().step(1).min(0).default(DEFAULT_CONFIG.maxOutputTokens),
    provider: library.string().default(DEFAULT_CONFIG.provider),
    model: library.string().default(DEFAULT_CONFIG.model),
    maxJobs: library.number().step(1).min(1).max(200).default(DEFAULT_CONFIG.maxJobs),
    requestTimeoutMs: library.number().step(1).min(1000).max(600_000).default(DEFAULT_CONFIG.requestTimeoutMs),
    ghPath: library.string().default(DEFAULT_CONFIG.ghPath),
  })
}

/** The plugin's Config export, consumed by the Cordis Loader before `apply`. */
export const Config = z === undefined ? createFallbackSchema() : buildSchemastery(z)
