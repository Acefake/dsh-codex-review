/**
 * Automatic review scheduler of dsh-codex-review (CONTRACT §6).
 *
 * Every `intervalSeconds` the reviewer lists the configured PR query, finds
 * open PRs whose head commit has not been reviewed yet, and runs the existing
 * {@link import('./review.js').ReviewEngine} on them one at a time. Results land
 * in the engine's normal review cache (so `/pr` serves them) and in a small
 * in-memory `recent` list exposed by `/auto-review-status`.
 *
 * Safety rules baked into this module:
 * - disabled by default; a cycle only runs while `enabled === true` unless the
 *   caller explicitly passes `{ force: true }` (one single run);
 * - the reviewer is **read-only** on GitHub: it calls `listPullRequests`,
 *   `getPull` and `getGuidelines` and nothing else — there is deliberately no
 *   code path that writes to GitHub (no comments, no merges);
 * - at most one cycle runs at a time and reviews inside a cycle are serial;
 * - a failing PR (or a failing list call) never aborts the rest of the cycle.
 *
 * Configuration and the per-PR `seen` cursor live in
 * `<DSH_PROFILE_DIR>/.codex-review/auto-review.json` (fallback
 * `~/.dsh/codex-review/auto-review.json`), written atomically via tmp + rename.
 * @module dsh-codex-review/lib/auto-review
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { USER_MESSAGES, AppError, badRequest, toPublicError } from './errors.js'
import { PUBLISH_DEFAULTS, sanitizePublishConfig } from './publish.js'

/** State-file schema version (CONTRACT §6.1). */
export const AUTO_REVIEW_VERSION = 1

/** Hard cap of the `recent` result list, in memory and persisted (CONTRACT §6.1/§6.3). */
export const AUTO_REVIEW_RECENT_LIMIT = 20

/** How long a failed review waits before the same head may be retried (CONTRACT §6.2). */
export const AUTO_REVIEW_RETRY_AFTER_MS = 30 * 60_000

/**
 * Watchdog for one cycle. A hung GitHub or model call must never leave
 * `running` true forever: that silently stops every later automatic review
 * until the plugin is reloaded. On timeout the cycle is abandoned, `lastError`
 * records why, and the next cycle may start.
 */
export const AUTO_REVIEW_CYCLE_TIMEOUT_MS = 10 * 60_000

/** Allowed interval range in seconds (CONTRACT §6.1). */
export const AUTO_REVIEW_INTERVAL_LIMITS = Object.freeze([60, 3_600])

/** Allowed `maxPerCycle` range (CONTRACT §6.1). */
export const AUTO_REVIEW_MAX_PER_CYCLE_LIMITS = Object.freeze([1, 5])

/** Allowed review depths (CONTRACT §4.1). */
export const AUTO_REVIEW_DEPTHS = Object.freeze(['fast', 'standard', 'deep'])

/** Allowed severity thresholds (CONTRACT §4.1). */
export const AUTO_REVIEW_THRESHOLDS = Object.freeze(['P0', 'P1', 'P2'])

/** Allowed recent-entry states (CONTRACT §6.3). */
export const AUTO_REVIEW_RECENT_STATES = Object.freeze(['done', 'error', 'cancelled'])

/** Longest accepted `query` string; anything longer is truncated. */
const QUERY_MAX_CHARS = 500

/** Default configuration (CONTRACT §6.1; publish section from §7.1). */
export const AUTO_REVIEW_DEFAULTS = Object.freeze({
  enabled: false,
  intervalSeconds: 180,
  query: 'is:open author:@me',
  depth: 'fast',
  severityThreshold: 'P2',
  includeGuidelines: true,
  includeDrafts: false,
  maxPerCycle: 2,
  publish: PUBLISH_DEFAULTS,
})

/**
 * Resolve the state-file path: the Host profile directory when the runtime
 * exposes one, the documented `~/.dsh/codex-review/` fallback otherwise. The
 * profile directory is read from `DSH_PROFILE_DIR`, or derived from
 * `DSH_HOME`/`DSH_PROFILE` the same way the plugin config resolver does.
 * @param {Record<string, string | undefined>} [env] - environment (defaults to `process.env`).
 * @param {string} [home] - home directory override for tests.
 * @returns {string} absolute state-file path.
 */
export function resolveAutoReviewStatePath(env = process.env, home = homedir()) {
  const configured = typeof env?.DSH_PROFILE_DIR === 'string' ? env.DSH_PROFILE_DIR.trim() : ''
  let profileDir = configured
  if (profileDir === '') {
    const dshHome = typeof env?.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
    const profile = typeof env?.DSH_PROFILE === 'string' ? env.DSH_PROFILE.trim() : ''
    if (dshHome !== '' && profile !== '') profileDir = join(dshHome, 'profiles', profile)
  }
  if (profileDir !== '') return join(profileDir, '.codex-review', 'auto-review.json')
  return join(home, '.dsh', 'codex-review', 'auto-review.json')
}

/**
 * Clamp one numeric config field, falling back to `fallback` when the value is
 * not a finite number.
 * @param {unknown} value - raw value.
 * @param {[number, number]} limits - inclusive range.
 * @param {number} fallback - value used for a non-numeric input.
 * @returns {number} a bounded integer.
 */
function clampInteger(value, limits, fallback) {
  const numeric = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN
  if (!Number.isFinite(numeric)) return fallback
  return Math.min(limits[1], Math.max(limits[0], Math.round(numeric)))
}

/**
 * Normalize a configuration object (or a patch merged over a base config):
 * known fields only, enum/number validation, missing or invalid values inherit
 * `base` (defaults when loading the file, the live config when patching).
 * @param {unknown} raw - candidate config/patch.
 * @param {typeof AUTO_REVIEW_DEFAULTS} [base] - fallback config.
 * @returns {{ enabled: boolean, intervalSeconds: number, query: string, depth: 'fast' | 'standard' | 'deep', severityThreshold: 'P0' | 'P1' | 'P2', includeGuidelines: boolean, includeDrafts: boolean, maxPerCycle: number, publish: typeof PUBLISH_DEFAULTS }} sanitized config.
 */
export function sanitizeAutoReviewConfig(raw, base = AUTO_REVIEW_DEFAULTS) {
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? /** @type {Record<string, unknown>} */ (raw) : {}
  const query = typeof source.query === 'string' && source.query.trim() !== ''
    ? source.query.trim().slice(0, QUERY_MAX_CHARS)
    : base.query
  return {
    enabled: typeof source.enabled === 'boolean' ? source.enabled : base.enabled,
    intervalSeconds: clampInteger(source.intervalSeconds, AUTO_REVIEW_INTERVAL_LIMITS, base.intervalSeconds),
    query,
    depth: AUTO_REVIEW_DEPTHS.includes(source.depth) ? /** @type {'fast' | 'standard' | 'deep'} */ (source.depth) : base.depth,
    severityThreshold: AUTO_REVIEW_THRESHOLDS.includes(source.severityThreshold)
      ? /** @type {'P0' | 'P1' | 'P2'} */ (source.severityThreshold)
      : base.severityThreshold,
    includeGuidelines: typeof source.includeGuidelines === 'boolean' ? source.includeGuidelines : (base.includeGuidelines ?? true),
    includeDrafts: typeof source.includeDrafts === 'boolean' ? source.includeDrafts : base.includeDrafts,
    maxPerCycle: clampInteger(source.maxPerCycle, AUTO_REVIEW_MAX_PER_CYCLE_LIMITS, base.maxPerCycle),
    // A patch may carry a partial `publish` object; it is merged over the live one.
    publish: sanitizePublishConfig(source.publish, base.publish ?? PUBLISH_DEFAULTS),
  }
}

/**
 * Normalize the persisted `recent` list (newest first, cap enforced). Entries
 * missing the identity/state/timestamp fields are dropped; a corrupt value
 * resets the history as required by the Host-state contract.
 * @param {unknown} raw - persisted recent value.
 * @param {number} [limit] - maximum entries kept.
 * @returns {Array<any>} sanitized recent entries.
 */
export function sanitizeRecentList(raw, limit = AUTO_REVIEW_RECENT_LIMIT) {
  const max = Number.isInteger(limit) && limit > 0 ? limit : AUTO_REVIEW_RECENT_LIMIT
  /** @type {Array<any>} */
  const recent = []
  if (!Array.isArray(raw)) return recent
  for (const candidate of raw) {
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) continue
    const entry = /** @type {Record<string, unknown>} */ (candidate)
    const repo = typeof entry.repo === 'string' ? entry.repo : ''
    const number = Number(entry.number)
    const state = typeof entry.state === 'string' && AUTO_REVIEW_RECENT_STATES.includes(entry.state) ? entry.state : ''
    const finishedAt = Number(entry.finishedAt)
    if (repo === '' || !Number.isInteger(number) || number <= 0 || state === '' || !Number.isFinite(finishedAt)) continue
    /** @type {any} */
    const clean = {
      repo,
      number,
      headSha: typeof entry.headSha === 'string' ? entry.headSha : '',
      state,
      findings: Number.isFinite(Number(entry.findings)) ? Math.max(0, Math.floor(Number(entry.findings))) : 0,
      finishedAt: Math.floor(finishedAt),
    }
    if (typeof entry.verdict === 'string' && ['block', 'changes', 'approve'].includes(entry.verdict)) clean.verdict = entry.verdict
    if (typeof entry.overview === 'string') clean.overview = entry.overview
    if (entry.partial === true) clean.partial = true
    if (entry.error !== null && typeof entry.error === 'object' && !Array.isArray(entry.error)) {
      const error = /** @type {Record<string, unknown>} */ (entry.error)
      if (typeof error.code === 'string' && error.code !== '') {
        clean.error = { code: error.code, message: typeof error.message === 'string' ? error.message : '' }
      }
    }
    if (entry.published !== null && typeof entry.published === 'object' && !Array.isArray(entry.published)) {
      const published = /** @type {Record<string, unknown>} */ (entry.published)
      const reviewId = Number(published.reviewId)
      if (Number.isFinite(reviewId)) {
        clean.published = { reviewId: Math.max(0, Math.floor(reviewId)), url: typeof published.url === 'string' ? published.url : '' }
      }
    }
    recent.push(clean)
    if (recent.length >= max) break
  }
  return recent
}

/**
 * Normalize the persisted publish records. Two shapes live in this map:
 * `repo#number@headSha` → per-head identity, and `repo#number` → the rolling
 * summary review plus the content fingerprint that lets a restart skip an
 * unchanged re-publish (CONTRACT §7.2 #6).
 * @param {unknown} raw - persisted published map.
 * @returns {Record<string, { publishedAt: number, reviewId: number, url: string, fingerprint?: string }>} sanitized records.
 */
export function sanitizePublishedMap(raw) {
  /** @type {Record<string, { publishedAt: number, reviewId: number, url: string, fingerprint?: string, request?: string }>} */
  const published = {}
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return published
  for (const [key, value] of Object.entries(/** @type {Record<string, unknown>} */ (raw))) {
    if (key === '' || value === null || typeof value !== 'object' || Array.isArray(value)) continue
    const entry = /** @type {Record<string, unknown>} */ (value)
    const publishedAt = Number(entry.publishedAt)
    const reviewId = Number(entry.reviewId)
    if (!Number.isFinite(publishedAt) || publishedAt < 0 || !Number.isFinite(reviewId) || reviewId <= 0) continue
    const url = typeof entry.url === 'string' ? entry.url : ''
    if (url === '') continue
    /** @type {{ publishedAt: number, reviewId: number, url: string, fingerprint?: string, request?: string }} */
    const record = {
      publishedAt: Math.floor(publishedAt),
      reviewId: Math.floor(reviewId),
      url,
    }
    if (typeof entry.fingerprint === 'string' && /^[0-9a-f]{6,40}$/.test(entry.fingerprint)) record.fingerprint = entry.fingerprint
    if (typeof entry.request === 'string' && /^[0-9a-f]{6,40}$/.test(entry.request)) record.request = entry.request
    published[key] = record
  }
  return published
}

/** Keep at most this many per-head publish records; the rolling record is separate. */
export const PUBLISHED_HEAD_LIMIT = 200

/**
 * Bound the persisted publish map so the state file cannot grow without limit.
 * The rolling record (`repo#number`) always survives; per-head records are kept
 * newest-first up to {@link PUBLISHED_HEAD_LIMIT}.
 * @param {Record<string, { publishedAt: number }>} published - record map.
 * @param {number} [limit] - maximum head records.
 * @returns {Record<string, any>} bounded copy.
 */
export function prunePublishedMap(published, limit = PUBLISHED_HEAD_LIMIT) {
  const max = Number.isInteger(limit) && limit > 0 ? limit : PUBLISHED_HEAD_LIMIT
  const rolling = {}
  /** @type {Array<[string, any]>} */
  const heads = []
  for (const [key, record] of Object.entries(published ?? {})) {
    if (key.includes('@')) heads.push([key, record])
    else rolling[key] = record
  }
  heads.sort((left, right) => Number(right[1]?.publishedAt) - Number(left[1]?.publishedAt))
  /** @type {Record<string, any>} */
  const bounded = { ...rolling }
  for (const [key, record] of heads.slice(0, max)) bounded[key] = record
  return bounded
}

/**
 * Normalize the persisted `seen` map: entries need a non-empty `headSha` and a
 * usable timestamp; anything else is dropped. `failedAt` (v2.5) carries the last
 * failed attempt so retries survive both a restart and `recent` eviction.
 * @param {unknown} raw - persisted seen value.
 * @returns {Record<string, { headSha: string, at: number, failedAt?: number }>} sanitized cursor map.
 */
export function sanitizeSeenMap(raw) {
  /** @type {Record<string, { headSha: string, at: number, failedAt?: number }>} */
  const seen = {}
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return seen
  for (const [key, value] of Object.entries(/** @type {Record<string, unknown>} */ (raw))) {
    if (key === '' || value === null || typeof value !== 'object' || Array.isArray(value)) continue
    const entry = /** @type {Record<string, unknown>} */ (value)
    if (typeof entry.headSha !== 'string' || entry.headSha === '') continue
    const at = Number(entry.at)
    if (!Number.isFinite(at) || at < 0) continue
    /** @type {{ headSha: string, at: number, failedAt?: number }} */
    const cursor = { headSha: entry.headSha, at: Math.floor(at) }
    const failedAt = Number(entry.failedAt)
    if (Number.isFinite(failedAt) && failedAt >= 0) cursor.failedAt = Math.floor(failedAt)
    seen[key] = cursor
  }
  return seen
}

/**
 * Automatic review scheduler. One instance per plugin mount.
 *
 * @example
 * const reviewer = new AutoReviewer({ github, engine, logger })
 * reviewer.status() // { config, running, seenCount, recent, ... }
 */
export class AutoReviewer {
  /**
   * @param {{ github: any, engine: any, logger?: any, now?: () => number, setInterval?: (callback: () => void, ms: number) => any, clearInterval?: (timer: any) => void, statePath?: string, env?: Record<string, string | undefined>, home?: string, autoStart?: boolean, retryAfterMs?: number, recentLimit?: number, listLimit?: number, cycleTimeoutMs?: number }} [options] - scheduler wiring.
   */
  constructor(options = {}) {
    /** GitHub data client (read-only methods only). */
    this.github = options.github
    /** Account id this scheduler operates on; keeps review jobs account-scoped. */
    this.account = typeof options.account === 'string' ? options.account : ''
    /** Review engine shared with the manual review routes. */
    this.engine = options.engine
    /** Optional logger. */
    this.logger = options.logger
    /** Clock override for deterministic tests. */
    this.now = options.now ?? Date.now
    /** Scheduler terminals, injectable so tests never wait on real timers. */
    this.setIntervalImpl = options.setInterval ?? setInterval
    this.clearIntervalImpl = options.clearInterval ?? clearInterval
    /** A failed head is retried only after this pause. */
    this.retryAfterMs = Number.isFinite(options.retryAfterMs) && options.retryAfterMs >= 0 ? options.retryAfterMs : AUTO_REVIEW_RETRY_AFTER_MS
    /** In-memory recent-result cap. */
    this.recentLimit = Number.isInteger(options.recentLimit) && options.recentLimit > 0 ? options.recentLimit : AUTO_REVIEW_RECENT_LIMIT
    /** PR-list page size per cycle. */
    this.listLimit = Number.isInteger(options.listLimit) && options.listLimit > 0 ? options.listLimit : 30
    /** How long one cycle may run before the watchdog abandons it. */
    this.cycleTimeoutMs = Number.isFinite(options.cycleTimeoutMs) && options.cycleTimeoutMs > 0 ? Math.floor(options.cycleTimeoutMs) : AUTO_REVIEW_CYCLE_TIMEOUT_MS
    /** Incremented per cycle: a superseded (timed-out) cycle stops at its next boundary. */
    this.cycleToken = 0
    /** Persisted state location. */
    this.statePath = options.statePath ?? resolveAutoReviewStatePath(options.env ?? process.env, options.home ?? homedir())
    /** Scheduler state. */
    this.disposed = false
    this.running = false
    /** @type {Promise<void> | undefined} */
    this.cyclePromise = undefined
    /** @type {number | undefined} */
    this.lastCycleAt = undefined
    /** @type {{ code: string, message: string } | undefined} */
    this.lastError = undefined
    /** @type {number | undefined} */
    this.nextCycleAt = undefined
    /** @type {any} */
    this.timer = undefined
    /** @type {Array<any>} */
    this.recent = []
    /** @type {any} */
    this.config = { ...AUTO_REVIEW_DEFAULTS }
    /** @type {Record<string, { headSha: string, at: number }>} */
    this.seen = {}
    /** @type {Record<string, { publishedAt: number, reviewId: number, url: string }>} */
    this.published = {}
    /** @type {any} */
    this.publisher = options.publisher

    const loaded = this.loadState()
    this.config = loaded.config
    this.seen = loaded.seen
    this.published = loaded.published
    this.recent = loaded.recent
    this.lastCycleAt = loaded.lastCycleAt
    if (loaded.recovered) this.persistState()
    if (options.autoStart !== false) this.scheduleTimer()
  }

  /**
   * Attach the publisher used by the automatic-publish path (CONTRACT §7.2 #8).
   * Index wiring does this after both objects exist; a missing publisher simply
   * disables the automatic publish (manual route still works).
   * @param {any} publisher - publisher instance.
   * @returns {void}
   */
  setPublisher(publisher) {
    this.publisher = publisher
  }

  /**
   * Read one persisted publish record.
   * @param {string} key - `repo#number@headSha` (per head) or `repo#number` (rolling summary).
   * @returns {{ publishedAt: number, reviewId: number, url: string, fingerprint?: string, request?: string } | undefined} the record.
   */
  getPublished(key) {
    return this.published[key]
  }

  /**
   * Persist one publish record (CONTRACT §7.2 #6/#8: one publish per head plus
   * the rolling summary identity, kept across reloads so a restarted Host never
   * re-publishes the same head and never duplicates the summary review). The
   * fingerprint records what was written and `request` records which parameters
   * asked for it, so a repeat replays only when both still match. The whole
   * write is one atomic file replace: a crash cannot leave a half-record.
   * @param {string} key - `repo#number@headSha` (per head) or `repo#number` (rolling summary).
   * @param {{ publishedAt?: number, reviewId?: number, url?: string, fingerprint?: string, request?: string }} record - publish identity.
   * @returns {void}
   */
  setPublished(key, record) {
    if (typeof key !== 'string' || key === '' || record === null || typeof record !== 'object') return
    const reviewId = Number(record.reviewId)
    const publishedAt = Number(record.publishedAt)
    /** @type {{ publishedAt: number, reviewId: number, url: string, fingerprint?: string, request?: string }} */
    const identity = {
      publishedAt: Number.isFinite(publishedAt) && publishedAt >= 0 ? Math.floor(publishedAt) : this.now(),
      reviewId: Number.isFinite(reviewId) && reviewId > 0 ? Math.floor(reviewId) : 0,
      url: typeof record.url === 'string' ? record.url : '',
    }
    if (typeof record.fingerprint === 'string' && /^[0-9a-f]{6,40}$/.test(record.fingerprint)) identity.fingerprint = record.fingerprint
    if (typeof record.request === 'string' && /^[0-9a-f]{6,40}$/.test(record.request)) identity.request = record.request
    this.published[key] = identity
    this.persistState()
  }

  /**
   * Persist several publish records in one atomic write. A publish writes the
   * per-head pointer and the rolling identity together: either both land or
   * neither does, and the state file is rewritten once instead of twice.
   * @param {Array<{ key: string, record: any }>} entries - records to persist.
   * @returns {void}
   */
  setPublishedMany(entries) {
    if (!Array.isArray(entries) || entries.length === 0) return
    let changed = false
    for (const entry of entries) {
      const key = typeof entry?.key === 'string' ? entry.key : ''
      const record = entry?.record
      if (key === '' || record === null || typeof record !== 'object') continue
      const reviewId = Number(record.reviewId)
      if (!(reviewId > 0)) continue
      const url = typeof record.url === 'string' ? record.url : ''
      if (url === '') continue
      const publishedAt = Number(record.publishedAt)
      /** @type {{ publishedAt: number, reviewId: number, url: string, fingerprint?: string, request?: string }} */
      const identity = {
        publishedAt: Number.isFinite(publishedAt) && publishedAt >= 0 ? Math.floor(publishedAt) : this.now(),
        reviewId: Math.floor(reviewId),
        url,
      }
      if (typeof record.fingerprint === 'string' && /^[0-9a-f]{6,40}$/.test(record.fingerprint)) identity.fingerprint = record.fingerprint
      if (typeof record.request === 'string' && /^[0-9a-f]{6,40}$/.test(record.request)) identity.request = record.request
      this.published[key] = identity
      changed = true
    }
    if (changed) this.persistState()
  }

  /**
   * Read the persisted state (config + seen cursor + recent history + publish
   * records). A missing file is normal and yields the defaults; a corrupt file
   * is backed up and rebuilt, and independently-corrupt sections are reset.
   * @returns {{ config: typeof AUTO_REVIEW_DEFAULTS, seen: Record<string, { headSha: string, at: number }>, published: Record<string, any>, recent: Array<any>, lastCycleAt: number | undefined, recovered: boolean }} loaded state.
   */
  loadState() {
    const fresh = {
      config: { ...AUTO_REVIEW_DEFAULTS },
      seen: /** @type {Record<string, { headSha: string, at: number }>} */ ({}),
      published: /** @type {Record<string, any>} */ ({}),
      recent: /** @type {Array<any>} */ ([]),
      lastCycleAt: /** @type {number | undefined} */ (undefined),
      recovered: false,
    }
    if (!existsSync(this.statePath)) return fresh
    /** @type {string} */
    let text
    try {
      text = readFileSync(this.statePath, 'utf8')
    } catch (error) {
      this.logger?.warn?.(`dsh-codex-review: cannot read auto-review state: ${error?.message ?? error}`)
      return fresh
    }
    /** @type {any} */
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = undefined
    }
    const valid = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.version === AUTO_REVIEW_VERSION
    if (!valid) {
      this.backupCorruptState()
      return { ...fresh, recovered: true }
    }
    const rawLast = Number(parsed.lastCycleAt)
    return {
      config: sanitizeAutoReviewConfig(parsed.config, AUTO_REVIEW_DEFAULTS),
      seen: sanitizeSeenMap(parsed.seen),
      published: sanitizePublishedMap(parsed.published),
      // Independently-corrupt history is reset instead of failing the whole file.
      recent: sanitizeRecentList(parsed.recent, this.recentLimit),
      lastCycleAt: Number.isFinite(rawLast) && rawLast > 0 ? Math.floor(rawLast) : undefined,
      recovered: false,
    }
  }

  /** Preserve one corrupt state file next to the rebuilt one (`<path>.backup`). */
  backupCorruptState() {
    try {
      copyFileSync(this.statePath, `${this.statePath}.backup`)
    } catch (error) {
      this.logger?.warn?.(`dsh-codex-review: cannot back up corrupt auto-review state: ${error?.message ?? error}`)
    }
  }

  /** Persist config + seen cursor + recent history + publish records atomically. */
  persistState() {
    try {
      mkdirSync(dirname(this.statePath), { recursive: true })
      /** @type {Record<string, unknown>} */
      const payload = {
        version: AUTO_REVIEW_VERSION,
        config: this.config,
        seen: this.seen,
        published: prunePublishedMap(this.published),
        recent: this.recent.slice(0, this.recentLimit),
      }
      if (this.lastCycleAt !== undefined) payload.lastCycleAt = this.lastCycleAt
      const tmpPath = `${this.statePath}.tmp-${process.pid}-${Math.floor(this.now())}`
      writeFileSync(tmpPath, JSON.stringify(payload), 'utf8')
      renameSync(tmpPath, this.statePath)
      return true
    } catch (error) {
      this.logger?.warn?.(`dsh-codex-review: cannot persist auto-review state: ${error?.message ?? error}`)
      return false
    }
  }

  /** (Re)arm the interval timer from the current config. */
  scheduleTimer() {
    this.clearTimer()
    const intervalMs = this.config.intervalSeconds * 1_000
    this.nextCycleAt = this.now() + intervalMs
    this.timer = this.setIntervalImpl(() => this.onTimerTick(intervalMs), intervalMs)
    if (this.timer !== null && typeof this.timer === 'object' && typeof this.timer.unref === 'function') this.timer.unref()
  }

  /** Stop the interval timer, if any. */
  clearTimer() {
    if (this.timer === undefined) return
    this.clearIntervalImpl(this.timer)
    this.timer = undefined
  }

  /**
   * One timer tick: record the next fire time and start a cycle when allowed.
   * A tick while a cycle is still running is dropped (at most one cycle).
   * @param {number} intervalMs - current interval in milliseconds.
   * @returns {void}
   */
  onTimerTick(intervalMs) {
    this.nextCycleAt = this.now() + intervalMs
    if (this.disposed || this.running) return
    if (this.config.enabled !== true) {
      // Contract §6.2 step 1: disabled cycles are recorded as skipped.
      this.lastCycleAt = this.now()
      return
    }
    this.startCycle({ force: false })
  }

  /**
   * Start one cycle without waiting for it.
   * @param {{ force?: boolean }} [options] - `force:true` runs one cycle even while disabled.
   * @returns {{ started: boolean, reason?: string, promise?: Promise<void> }} start result; `promise` is internal (use {@link runCycle} to await).
   */
  startCycle(options = {}) {
    const force = options.force === true
    if (this.disposed) return { started: false, reason: '插件已卸载' }
    if (this.running) return { started: false, reason: '已有自动审查 cycle 正在运行' }
    if (!force && this.config.enabled !== true) return { started: false, reason: '自动审查已关闭（可带 force:true 单次运行）' }
    this.running = true
    this.lastCycleAt = this.now()
    this.lastError = undefined
    const token = ++this.cycleToken
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let watchdog
    const cycle = Promise.resolve().then(() => this.executeCycle(token))
    const timeout = new Promise((_, reject) => {
      watchdog = setTimeout(
        () => reject(new AppError('INTERNAL', `自动审查 cycle 超过 ${Math.round(this.cycleTimeoutMs / 1000)} 秒未结束，已放弃本轮`)),
        this.cycleTimeoutMs,
      )
      if (typeof watchdog?.unref === 'function') watchdog.unref()
    })
    const promise = Promise.race([cycle, timeout])
      .catch((error) => {
        this.lastError = toPublicError(error)
        this.logger?.warn?.(`dsh-codex-review: auto-review cycle failed: ${this.lastError.message}`)
      })
      .finally(() => {
        if (watchdog !== undefined) clearTimeout(watchdog)
        this.running = false
        this.cyclePromise = undefined
        this.persistState()
      })
    this.cyclePromise = promise
    return { started: true, promise }
  }

  /**
   * Await one cycle (tests and internal tools). Resolves with the start result
   * once the cycle settled.
   * @param {{ force?: boolean }} [options] - start options.
   * @returns {Promise<{ started: boolean, reason?: string }>} start result.
   */
  async runCycle(options = {}) {
    const result = this.startCycle(options)
    if (result.promise !== undefined) await result.promise
    return { started: result.started, ...(result.reason === undefined ? {} : { reason: result.reason }) }
  }

  /**
   * Public manual trigger used by `auto-review-run`: starts the cycle and
   * answers immediately; progress is visible through {@link status}.
   * @param {{ force?: boolean }} [options] - `force:true` allows a run while disabled.
   * @returns {{ started: boolean, reason?: string }} start result.
   */
  runOnce(options = {}) {
    const result = this.startCycle(options)
    return { started: result.started, ...(result.reason === undefined ? {} : { reason: result.reason }) }
  }

  /**
   * One full scan. Any cycle-level failure (list request, unexpected throw) is
   * recorded in `lastError` and never escapes: the scheduler keeps ticking.
   * A superseded cycle (the watchdog abandoned it, or the plugin was disposed)
   * stops at its next await boundary instead of starting more reviews.
   * @param {number} [token] - cycle generation from {@link startCycle}.
   * @returns {Promise<void>} resolves when the cycle finished.
   */
  async executeCycle(token) {
    const current = () => token === undefined || token === this.cycleToken
    if (!current()) return
    const list = await this.github.listPullRequests({ query: this.config.query, limit: this.listLimit })
    if (!current()) return
    const items = Array.isArray(list?.items) ? list.items : []
    let startedCount = 0
    for (const item of items) {
      if (!current()) return
      if (startedCount >= this.config.maxPerCycle) break
      const repo = typeof item?.repo === 'string' ? item.repo : ''
      const number = Number(item?.number)
      if (repo === '' || !Number.isInteger(number) || number <= 0) continue
      if (item?.state !== 'open') continue
      if (item?.isDraft === true && this.config.includeDrafts !== true) continue
      if (typeof this.engine.hasActiveJob === 'function' && this.engine.hasActiveJob(repo, number, this.account) === true) continue
      /** @type {any} */
      let detail
      try {
        detail = await this.github.getPull(repo, number)
      } catch (error) {
        // A single unreadable PR must not break the cycle.
        this.logger?.warn?.(`dsh-codex-review: auto review skipped ${repo}#${number}: ${error?.message ?? error}`)
        continue
      }
      const headSha = typeof detail?.headSha === 'string' ? detail.headSha : ''
      if (headSha === '') continue
      const key = `${repo}#${number}`
      const seen = this.seen[key]
      if (seen !== undefined && seen.headSha === headSha && this.shouldRetryFailedReview(repo, number, headSha) !== true) continue
      await this.reviewOne({ repo, number, detail, headSha })
      if (!current()) return
      startedCount += 1
    }
  }

  /**
   * Whether the last attempt for this exact head failed and its retry pause has
   * elapsed. The failure timestamp is persisted in `seen` itself, so the answer
   * survives a restart and does not depend on the capped `recent` list. A
   * finished (done/cancelled) head is never retried.
   * @param {string} repo - `owner/name`.
   * @param {number} number - PR number.
   * @param {string} headSha - head commit.
   * @returns {boolean} true when a retry is allowed.
   */
  shouldRetryFailedReview(repo, number, headSha) {
    const seen = this.seen[`${repo}#${number}`]
    if (seen === undefined || seen.headSha !== headSha) return false
    const failedAt = Number(seen.failedAt)
    if (!Number.isFinite(failedAt) || failedAt < 0) return false
    return this.now() - failedAt >= this.retryAfterMs
  }

  /**
   * Run one auto review serially and record its outcome. Never throws: a
   * failure is recorded as an `error` recent entry so the cycle continues.
   * @param {{ repo: string, number: number, detail: any, headSha: string }} candidate - PR to review.
   * @returns {Promise<any>} the recorded recent entry.
   */
  async reviewOne(candidate) {
    const { repo, number, detail, headSha } = candidate
    const key = `${repo}#${number}`
    try {
      /** @type {any} */
      let guidelines
      try {
        if (this.config.includeGuidelines && typeof this.github.getGuidelines === 'function') guidelines = await this.github.getGuidelines(repo, {})
      } catch {
        // Guidelines are an enhancement; the review proceeds without them.
        guidelines = undefined
      }
      const started = this.engine.start({
        repo,
        number,
        account: this.account,
        headSha,
        title: detail?.summary?.title,
        body: detail?.body,
        baseRefName: detail?.summary?.baseRefName,
        headRefName: detail?.summary?.headRefName,
        files: Array.isArray(detail?.files) ? detail.files : [],
        options: {
          depth: this.config.depth,
          severityThreshold: this.config.severityThreshold,
          includeGuidelines: this.config.includeGuidelines,
        },
        guidelines,
      })
      if (typeof this.engine.waitForCompletion === 'function') await this.engine.waitForCompletion(started.jobId)
      const status = typeof this.engine.status === 'function' ? this.engine.status(started.jobId) : {}
      const state = status?.state === 'done' ? 'done' : status?.state === 'cancelled' ? 'cancelled' : 'error'
      /** @type {any} */
      const entry = {
        repo,
        number,
        headSha,
        state,
        findings: Array.isArray(status?.findings) ? status.findings.length : 0,
        finishedAt: this.now(),
      }
      if (status?.partial === true) entry.partial = true
      if (status?.verdict !== undefined) entry.verdict = status.verdict
      if (status?.overview !== undefined) entry.overview = status.overview
      if (state === 'error') {
        entry.error = status?.error ?? { code: 'LLM_ERROR', message: USER_MESSAGES.LLM_ERROR }
        this.logger?.warn?.(`dsh-codex-review: auto review ${key} failed: ${entry.error.message}`)
      }
      if (state === 'done' && entry.partial !== true && this.config.publish?.enabled === true && this.publisher !== undefined) {
        // Automatic publishing targets exactly the head and job this cycle just
        // reviewed — never a historical head, never a backfill (CONTRACT §7.2 #8).
        try {
          const published = await this.publisher.publish({
            repo,
            number,
            confirm: true,
            headSha,
            jobId: started.jobId,
            mode: this.config.publish.mode,
            minSeverity: this.config.publish.minSeverity,
            maxComments: this.config.publish.maxComments,
          })
          if (published !== undefined && published !== null && published.published === true) {
            entry.published = { reviewId: Number(published.reviewId) || 0, url: typeof published.url === 'string' ? published.url : '' }
          }
        } catch (error) {
          // A failed publish only records lastError: no retry storm, the review
          // result itself is still kept.
          this.lastError = toPublicError(error)
          this.logger?.warn?.(`dsh-codex-review: auto publish ${key} failed: ${this.lastError.message}`)
        }
      } else if (state === 'done' && entry.partial === true && this.config.publish?.enabled === true) {
        this.logger?.warn?.(`dsh-codex-review: auto publish ${key} skipped: review is partial`)
      }
      this.recordResult(entry)
      return entry
    } catch (error) {
      /** @type {any} */
      const entry = { repo, number, headSha, state: 'error', findings: 0, finishedAt: this.now(), error: toPublicError(error) }
      this.recordResult(entry)
      this.logger?.warn?.(`dsh-codex-review: auto review ${key} failed: ${entry.error.message}`)
      return entry
    }
  }

  /**
   * Update the `seen` cursor and the in-memory recent list, then persist.
   * @param {any} entry - terminal result for one PR.
   * @returns {void}
   */
  recordResult(entry) {
    if (typeof entry?.headSha === 'string' && entry.headSha !== '') {
      /** @type {{ headSha: string, at: number, failedAt?: number }} */
      const cursor = { headSha: entry.headSha, at: entry.finishedAt }
      // Persist the failure time on the cursor itself: the retry decision must
      // not depend on the capped `recent` history (CONTRACT §6.2).
      if (entry.state === 'error') cursor.failedAt = entry.finishedAt
      this.seen[`${entry.repo}#${entry.number}`] = cursor
    }
    this.recent.unshift(entry)
    if (this.recent.length > this.recentLimit) this.recent.length = this.recentLimit
    this.persistState()
  }

  /**
   * Merge one validated patch into the live config, persist it and apply the
   * new interval from the next tick on (enabled takes effect immediately).
   * @param {unknown} patch - raw `Partial<AutoReviewConfig>` from the route.
   * @returns {ReturnType<AutoReviewer['status']>} the new status.
   * @throws {AppError} BAD_REQUEST when the patch is not an object.
   */
  updateConfig(patch) {
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) throw badRequest('patch 必须是对象')
    const previous = this.config
    const previousInterval = previous.intervalSeconds
    this.config = sanitizeAutoReviewConfig(patch, previous)
    if (!this.persistState()) {
      this.config = previous
      throw new AppError('INTERNAL', '设置写入失败，未保存更改；请检查配置目录权限或磁盘空间后重试。')
    }
    if (this.config.intervalSeconds !== previousInterval) this.scheduleTimer()
    return this.status()
  }

  /**
   * The `/auto-review-status` value (CONTRACT §6.3).
   *
   * `publish` is exposed both inside `config` (the persisted state-file shape)
   * and at the top level: the client's v2.2 publish UI reads it from the top
   * level, while older payload consumers keyed on `config.publish` keep working.
   * @returns {{ config: typeof AUTO_REVIEW_DEFAULTS, publish: typeof AUTO_REVIEW_DEFAULTS.publish, running: boolean, seenCount: number, recent: Array<any>, lastCycleAt?: number, nextCycleAt?: number, lastError?: { code: string, message: string } }} status.
   */
  status() {
    /** @type {any} */
    const status = {
      config: { ...this.config, publish: { ...this.config.publish } },
      publish: { ...this.config.publish },
      running: this.running,
      seenCount: Object.keys(this.seen).length,
      recent: this.recent.map((entry) => ({
        ...entry,
        ...(entry.error === undefined ? {} : { error: { ...entry.error } }),
        ...(entry.published === undefined ? {} : { published: { ...entry.published } }),
      })),
    }
    if (this.lastCycleAt !== undefined) status.lastCycleAt = this.lastCycleAt
    if (this.running !== true && this.nextCycleAt !== undefined) status.nextCycleAt = this.nextCycleAt
    if (this.lastError !== undefined) status.lastError = { ...this.lastError }
    return status
  }

  /** Stop the scheduler and persist the last cursor (plugin dispose). */
  dispose() {
    this.disposed = true
    // Abandon a cycle that is still awaiting: it stops at its next boundary.
    this.cycleToken += 1
    this.clearTimer()
    this.persistState()
  }
}
