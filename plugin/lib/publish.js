/**
 * Publish a completed review as a GitHub PR Review (CONTRACT §7).
 *
 * The publisher is the only module in this plugin that writes review content to
 * GitHub. It is reachable from exactly two places: the `review-publish` route
 * (which requires `confirm: true`) and the automatic reviewer (only when the
 * persisted `publish.enabled` flag is true). It never edits code, never pushes
 * commits and never merges.
 *
 * Pure helpers (config clamping, finding → comment mapping, marker generation,
 * summary rendering, marker parsing) are exported for `node --test`; the
 * {@link ReviewPublisher} class owns the read-before-write flow:
 * `getPull → existing review → publish record → existing comments → createPullReview → persist`.
 * @module dsh-codex-review/lib/publish
 */

import { AppError, badRequest } from './errors.js'
import { REPO_RE } from './github.js'
import { SEVERITIES, compareFindings, findingId } from './review.js'

/** Publish defaults (CONTRACT §7.1). */
export const PUBLISH_DEFAULTS = Object.freeze({
  enabled: false,
  mode: 'inline',
  minSeverity: 'P2',
  maxComments: 20,
})

/** Allowed publish modes (CONTRACT §7.1). */
export const PUBLISH_MODES = Object.freeze(['inline', 'summary', 'both'])

/** Allowed minimum severities; a finding is published when it is at least this severe. */
export const PUBLISH_SEVERITIES = SEVERITIES

/** Allowed `maxComments` range (CONTRACT §7.1). */
export const PUBLISH_MAX_COMMENTS_LIMITS = Object.freeze([1, 50])

/** Hard cap for one inline comment body (CONTRACT §7.2). */
export const PUBLISH_COMMENT_MAX_CHARS = 2_000

/** Hard cap for the summary body (CONTRACT §7.2). */
export const PUBLISH_SUMMARY_MAX_CHARS = 4_000

/** Marker prefix embedded in every inline comment posted by this plugin. */
export const PUBLISH_MARKER_PREFIX = 'dsh-codex-review'

/** Matches one published-comment marker and captures the finding hash. */
const PUBLISH_MARKER_RE = /<!--\s*dsh-codex-review:([0-9a-f]{6,40})\s*-->/g

/** Marker appended to a truncated inline comment body. */
const INLINE_TRUNCATION = '…'

/** Caps for the individual parts of an inline comment. */
const INLINE_TITLE_MAX_CHARS = 120
const INLINE_WHY_MAX_CHARS = 700
const INLINE_FIX_MAX_CHARS = 700

/**
 * Truncate a string to a character budget (never longer than the cap).
 * @param {unknown} value - candidate text.
 * @param {number} maxChars - hard cap.
 * @returns {string} bounded text.
 */
function truncate(value, maxChars) {
  const text = typeof value === 'string' ? value : ''
  if (!Number.isFinite(maxChars) || maxChars <= 0) return ''
  if (text.length <= maxChars) return text
  return text.slice(0, Math.max(0, maxChars - INLINE_TRUNCATION.length)) + INLINE_TRUNCATION
}

/**
 * Clamp one numeric publish field.
 * @param {unknown} value - raw value.
 * @param {number} fallback - value used for a non-numeric input.
 * @returns {number} a bounded integer.
 */
function clampMaxComments(value, fallback) {
  const numeric = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN
  if (!Number.isFinite(numeric)) return fallback
  return Math.min(PUBLISH_MAX_COMMENTS_LIMITS[1], Math.max(PUBLISH_MAX_COMMENTS_LIMITS[0], Math.round(numeric)))
}

/**
 * Normalize a publish config (or a patch merged over one). Known fields only;
 * invalid values inherit `base`.
 * @param {unknown} raw - candidate config/patch.
 * @param {typeof PUBLISH_DEFAULTS} [base] - fallback config.
 * @returns {{ enabled: boolean, mode: 'inline' | 'summary' | 'both', minSeverity: 'P0' | 'P1' | 'P2', maxComments: number }} sanitized config.
 */
export function sanitizePublishConfig(raw, base = PUBLISH_DEFAULTS) {
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? /** @type {Record<string, unknown>} */ (raw) : {}
  return {
    enabled: typeof source.enabled === 'boolean' ? source.enabled : base.enabled,
    mode: PUBLISH_MODES.includes(source.mode) ? /** @type {'inline' | 'summary' | 'both'} */ (source.mode) : base.mode,
    minSeverity: PUBLISH_SEVERITIES.includes(source.minSeverity) ? /** @type {'P0' | 'P1' | 'P2'} */ (source.minSeverity) : base.minSeverity,
    maxComments: clampMaxComments(source.maxComments, base.maxComments),
  }
}

/**
 * Stable identity used both by the review engine and by the GitHub marker.
 * @param {{ file?: unknown, line?: unknown, title?: unknown, id?: unknown }} finding - finding.
 * @returns {string} 12 hex characters.
 */
export function publishFindingHash(finding) {
  if (typeof finding?.id === 'string' && /^[0-9a-f]{6,40}$/.test(finding.id)) return finding.id
  const file = typeof finding?.file === 'string' ? finding.file : ''
  const line = Number(finding?.line)
  const title = typeof finding?.title === 'string' ? finding.title : ''
  if (file === '' || !Number.isInteger(line) || title === '') return ''
  return findingId({ file, line, title })
}

/**
 * Render the hidden marker that lets a later publish recognise this finding.
 * @param {string} hash - finding hash.
 * @returns {string} HTML comment marker.
 */
export function publishMarker(hash) {
  return `<!-- ${PUBLISH_MARKER_PREFIX}:${hash} -->`
}

/**
 * Collect every finding hash already present in GitHub review comments.
 * @param {Array<{ body?: string }>} comments - existing review comments.
 * @returns {Set<string>} published finding hashes.
 */
export function parsePublishMarkers(comments) {
  /** @type {Set<string>} */
  const markers = new Set()
  for (const comment of Array.isArray(comments) ? comments : []) {
    const body = typeof comment?.body === 'string' ? comment.body : ''
    if (body === '' || !body.includes(PUBLISH_MARKER_PREFIX)) continue
    for (const match of body.matchAll(PUBLISH_MARKER_RE)) markers.add(match[1])
  }
  return markers
}

/**
 * Keep only publishable findings and sort them P0→P2 then file/line.
 * @param {Array<any>} findings - review findings.
 * @param {{ minSeverity?: 'P0' | 'P1' | 'P2', maxComments?: number }} [options] - filters.
 * @returns {{ selected: Array<any>, overLimit: number }} findings to publish (after the cap) and how many were dropped by it.
 */
export function filterPublishableFindings(findings, options = {}) {
  const minSeverity = PUBLISH_SEVERITIES.includes(options.minSeverity) ? options.minSeverity : PUBLISH_DEFAULTS.minSeverity
  const maxComments = clampMaxComments(options.maxComments, PUBLISH_DEFAULTS.maxComments)
  const cutoff = PUBLISH_SEVERITIES.indexOf(minSeverity)
  const eligible = (Array.isArray(findings) ? findings : []).filter((finding) => {
    if (finding === null || typeof finding !== 'object') return false
    const rank = PUBLISH_SEVERITIES.indexOf(finding.severity)
    if (rank === -1 || rank > cutoff) return false
    if (typeof finding.file !== 'string' || finding.file === '') return false
    return Number.isInteger(finding.line) && finding.line > 0
  })
  const sorted = eligible.slice().sort(compareFindings)
  return { selected: sorted.slice(0, maxComments), overLimit: Math.max(0, sorted.length - maxComments) }
}

/**
 * Render one inline review comment: severity+title, why, fix, marker. The whole
 * body never exceeds {@link PUBLISH_COMMENT_MAX_CHARS}.
 * @param {any} finding - normalized finding.
 * @returns {string} markdown comment body.
 */
export function buildInlineCommentBody(finding) {
  const severity = PUBLISH_SEVERITIES.includes(finding?.severity) ? finding.severity : 'P2'
  const title = truncate(typeof finding?.title === 'string' ? finding.title.trim() : '', INLINE_TITLE_MAX_CHARS) || '（未命名问题）'
  const sections = [`**[${severity}] ${title}**`]
  const why = typeof finding?.why === 'string' ? finding.why.trim() : ''
  if (why !== '') sections.push(`为什么：${truncate(why, INLINE_WHY_MAX_CHARS)}`)
  const fix = typeof finding?.fix === 'string' ? finding.fix.trim() : ''
  if (fix !== '') sections.push(`建议：${truncate(fix, INLINE_FIX_MAX_CHARS)}`)
  const marker = publishMarker(publishFindingHash(finding))
  const markerBlock = `\n\n${marker}`
  const budget = PUBLISH_COMMENT_MAX_CHARS - markerBlock.length
  if (budget <= 0) return marker
  const prefix = sections.join('\n\n')
  return `${truncate(prefix, budget)}${markerBlock}`
}

/**
 * Render the review summary body. A caller-provided body wins (truncated to the
 * cap); otherwise the deterministic header + overview + finding list is used.
 * @param {{ overview?: unknown, findings?: Array<any>, customBody?: unknown, maxChars?: number }} [input] - summary data.
 * @returns {string} markdown body, never longer than the cap.
 */
export function buildSummaryBody(input = {}) {
  const maxChars = Number.isFinite(input.maxChars) && input.maxChars > 0 ? input.maxChars : PUBLISH_SUMMARY_MAX_CHARS
  if (typeof input.customBody === 'string' && input.customBody.trim() !== '') return truncate(input.customBody.trim(), maxChars)
  const findings = Array.isArray(input.findings) ? input.findings : []
  const overview = typeof input.overview === 'string' && input.overview.trim() !== ''
    ? input.overview.trim()
    : findings.length === 0 ? 'AI 未发现明显问题' : `共 ${findings.length} 个问题`
  const lines = ['**代码审查（dsh-codex-review）**', '', overview]
  if (findings.length > 0) {
    lines.push('')
    for (const finding of findings) {
      const severity = PUBLISH_SEVERITIES.includes(finding?.severity) ? finding.severity : 'P2'
      lines.push(`- [${severity}] ${finding?.file ?? '?'}:${finding?.line ?? '?'} ${finding?.title ?? ''}`.trimEnd())
    }
  }
  return truncate(lines.join('\n'), maxChars)
}

/**
 * Assemble everything one publish needs: filtered/sorted findings, the inline
 * comments actually to create (marker-deduplicated) and an optional summary.
 * @param {{ findings?: Array<any>, mode?: string, minSeverity?: string, maxComments?: number, existingMarkers?: Set<string>, overview?: string, body?: string }} input - publish data.
 * @returns {{ mode: string, minSeverity: string, maxComments: number, inlineComments: Array<{ path: string, line: number, side: 'RIGHT', body: string }>, summaryBody: string | undefined, selected: Array<any>, skipped: number, overLimit: number, deduped: number }} prepared publish.
 */
export function preparePublish(input = {}) {
  const mode = PUBLISH_MODES.includes(input.mode) ? input.mode : PUBLISH_DEFAULTS.mode
  const minSeverity = PUBLISH_SEVERITIES.includes(input.minSeverity) ? input.minSeverity : PUBLISH_DEFAULTS.minSeverity
  const maxComments = clampMaxComments(input.maxComments, PUBLISH_DEFAULTS.maxComments)
  const markers = input.existingMarkers instanceof Set ? input.existingMarkers : new Set()
  const { selected, overLimit } = filterPublishableFindings(input.findings, { minSeverity, maxComments })
  const dedupedFindings = []
  const toSend = []
  for (const finding of selected) {
    const hash = publishFindingHash(finding)
    if (hash !== '' && markers.has(hash)) dedupedFindings.push(finding)
    else toSend.push(finding)
  }
  const includeInline = mode === 'inline' || mode === 'both'
  const inlineComments = includeInline
    ? toSend.map((finding) => ({
      path: finding.file,
      line: finding.line,
      side: /** @type {'RIGHT'} */ ('RIGHT'),
      body: buildInlineCommentBody(finding),
    }))
    : []
  // Contract §7.2 #5: summary mode — or inline mode with nothing to anchor.
  const needsSummary = mode === 'summary' || mode === 'both' || inlineComments.length === 0
  const summaryBody = needsSummary
    ? buildSummaryBody({ overview: input.overview, findings: toSend, customBody: input.body })
    : undefined
  return {
    mode,
    minSeverity,
    maxComments,
    inlineComments,
    summaryBody,
    selected,
    skipped: overLimit + dedupedFindings.length,
    overLimit,
    deduped: dedupedFindings.length,
  }
}

/**
 * The publish flow: read the PR/review, deduplicate against persisted records
 * and existing GitHub markers, then create exactly one PR review and remember it.
 */
export class ReviewPublisher {
  /**
   * @param {{ github: any, engine: any, store?: { get: (key: string) => any, set: (key: string, record: any) => void }, logger?: any, now?: () => number }} [options] - wiring.
   */
  constructor(options = {}) {
    this.github = options.github
    this.engine = options.engine
    this.store = options.store ?? { get: () => undefined, set: () => {} }
    this.logger = options.logger
    this.now = options.now ?? Date.now
    /** One publish per repo#number@headSha; concurrent callers share this promise. @type {Map<string, Promise<any>>} */
    this.inflight = new Map()
  }

  /**
   * Publish one completed review (CONTRACT §7.2). The caller must have obtained
   * an explicit user confirmation (`confirm: true`).
   * @param {{ repo: string, number: number, mode?: string, minSeverity?: string, maxComments?: number, body?: string, confirm?: boolean }} input - publish request.
   * @returns {Promise<{ published: true, reviewId: number, url: string, comments: number, skipped: number, headSha: string }>} publish result.
   * @throws {AppError} BAD_REQUEST / REVIEW_NOT_READY / GH_* / INTERNAL.
   */
  async publish(input = {}) {
    if (input?.confirm !== true) throw badRequest('发布审查需要 confirm: true')
    const repo = typeof input.repo === 'string' ? input.repo.trim() : ''
    if (!REPO_RE.test(repo)) throw badRequest('repo 必须是 owner/name 形式')
    const number = typeof input.number === 'number' ? input.number : Number(input.number)
    if (!Number.isInteger(number) || number <= 0) throw badRequest('number 必须是正整数')
    const mode = input.mode === undefined ? PUBLISH_DEFAULTS.mode : input.mode
    if (!PUBLISH_MODES.includes(mode)) throw badRequest('mode 必须是 inline|summary|both')
    const minSeverity = input.minSeverity === undefined ? PUBLISH_DEFAULTS.minSeverity : input.minSeverity
    if (!PUBLISH_SEVERITIES.includes(minSeverity)) throw badRequest('minSeverity 必须是 P0|P1|P2')
    const maxComments = clampMaxComments(input.maxComments, PUBLISH_DEFAULTS.maxComments)
    /** @type {string | undefined} */
    let customBody
    if (input.body !== undefined && input.body !== null) {
      if (typeof input.body !== 'string') throw badRequest('body 必须是字符串')
      const trimmed = input.body.trim()
      if (trimmed.length > PUBLISH_SUMMARY_MAX_CHARS) throw badRequest(`body 超过 ${PUBLISH_SUMMARY_MAX_CHARS} 字`)
      if (trimmed !== '') customBody = trimmed
    }
    if (this.github === undefined || this.engine === undefined) throw new AppError('INTERNAL', '发布器未初始化')

    // The review must be finished for the current head.
    const detail = await this.github.getPull(repo, number)
    const headSha = typeof detail?.headSha === 'string' ? detail.headSha.trim() : ''
    if (headSha === '') throw new AppError('GH_NOT_FOUND', '无法确定该 PR 的 head commit')
    const review = typeof this.engine.existing === 'function' ? this.engine.existing(repo, number, headSha) : undefined
    if (review === undefined || review === null || review.state !== 'done') throw new AppError('REVIEW_NOT_READY')

    // One publish per head: a double click (or a second tab) must never create
    // two GitHub reviews, so concurrent calls share the in-flight promise
    // instead of racing the store record (CONTRACT §7.2 #6).
    const key = `${repo}#${number}@${headSha}`
    const pending = this.inflight.get(key)
    if (pending !== undefined) return pending
    const running = this.publishForHead({ repo, number, headSha, review, mode, minSeverity, maxComments, customBody })
    this.inflight.set(key, running)
    try {
      return await running
    } finally {
      this.inflight.delete(key)
    }
  }

  /**
   * The write half of {@link publish}: replay the stored record when this head
   * was already published, deduplicate against the markers already present on
   * the PR, create exactly one GitHub review and remember it. Callers go
   * through {@link publish}, which serializes concurrent calls for one head.
   * @param {{ repo: string, number: number, headSha: string, review: any, mode: string, minSeverity: string, maxComments: number, customBody?: string }} input - resolved publish request.
   * @returns {Promise<{ published: true, reviewId: number, url: string, comments: number, skipped: number, headSha: string }>} publish result.
   * @throws {AppError} GH_* / INTERNAL while talking to GitHub.
   */
  async publishForHead(input) {
    const { repo, number, headSha, review, mode, minSeverity, maxComments, customBody } = input
    const key = `${repo}#${number}@${headSha}`
    const recorded = this.store.get(key)
    if (recorded !== undefined && recorded !== null) {
      // One publish per head: a repeat is answered with the stored result and
      // performs no GitHub write (CONTRACT §7.2 #6).
      const replay = filterPublishableFindings(review.findings, { minSeverity, maxComments })
      return {
        published: true,
        reviewId: Number(recorded.reviewId) || 0,
        url: typeof recorded.url === 'string' ? recorded.url : '',
        comments: 0,
        skipped: replay.selected.length + replay.overLimit,
        headSha,
      }
    }

    /** @type {Set<string>} */
    let existingMarkers = new Set()
    if (typeof this.github.listPullReviewComments === 'function') {
      const comments = await this.github.listPullReviewComments(repo, number)
      existingMarkers = parsePublishMarkers(comments)
    }
    const prepared = preparePublish({
      findings: review.findings,
      mode,
      minSeverity,
      maxComments,
      existingMarkers,
      overview: review.overview,
      body: customBody,
    })
    /** @type {{ body?: string, comments?: Array<any> }} */
    const payload = {}
    if (prepared.summaryBody !== undefined) payload.body = prepared.summaryBody
    if (prepared.inlineComments.length > 0) payload.comments = prepared.inlineComments
    if (payload.body === undefined && payload.comments === undefined) {
      // No publishable finding at all: still record a summary-only review so the
      // user sees that the review ran (and repeated calls stay idempotent).
      payload.body = buildSummaryBody({ overview: review.overview, findings: [] })
    }
    const created = await this.github.createPullReview({ repo, number, headSha, body: payload.body, comments: payload.comments })
    const reviewId = Number(created?.reviewId) > 0 ? Number(created.reviewId) : 0
    const url = typeof created?.url === 'string' && created.url !== ''
      ? created.url
      : reviewId > 0 ? `https://github.com/${repo}/pull/${number}#pullrequestreview-${reviewId}` : ''
    const record = { publishedAt: this.now(), reviewId, url }
    try {
      this.store.set(key, record)
    } catch (error) {
      this.logger?.warn?.(`dsh-codex-review: cannot persist publish record: ${error?.message ?? error}`)
    }
    return {
      published: true,
      reviewId,
      url,
      comments: Array.isArray(payload.comments) ? payload.comments.length : 0,
      skipped: prepared.skipped,
      headSha,
    }
  }
}
