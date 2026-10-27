/**
 * Publish a completed review as a GitHub PR Review (CONTRACT §7).
 *
 * The publisher is the only module in this plugin that writes review content to
 * GitHub. It is reachable from exactly two places: the `review-publish` route
 * (which requires `confirm: true`) and the automatic reviewer (only when the
 * persisted `publish.enabled` flag is true). It never edits code, never pushes
 * commits and never merges.
 *
 * One rolling summary review per pull request: the first publish creates it and
 * every later publish replaces its body in place (`PUT .../reviews/{id}`), so a
 * PR timeline does not grow a new review on every commit. Inline comments are
 * immutable after submission, so only findings that were never published are
 * sent, each carrying the `<!-- dsh-codex-review:<hash> -->` marker that lets a
 * later publish skip them. A hidden `<!-- dsh-codex-review:summary -->` marker
 * identifies the rolling review even after the local state file was lost.
 *
 * Correctness rules that keep the rolling identity sane:
 * - a publish is bound to the exact head and job it was requested for (the
 *   caller passes `headSha`/`jobId`; the current PR head is re-read uncached);
 * - a partially completed review never publishes (`REVIEW_PARTIAL`);
 * - a head record replays only when the same request parameters asked for it
 *   (a changed mode/severity/body publishes again instead of replaying);
 * - only a summary review may own the `repo#number` rolling record (a bodyless
 *   inline review never takes it over);
 * - markers are trusted only from reviews/comments authored by the signed-in
 *   user, and legacy summary reviews without a marker are adopted by their
 *   fixed header plus author;
 * - a rejected inline anchor (HTTP 422) is retried once without inline
 *   comments so the summary is not lost;
 * - every GitHub call inside one publish shares a bounded abort signal.
 *
 * Pure helpers (config clamping, finding → comment mapping, marker generation,
 * summary rendering, marker parsing, content fingerprints) are exported for
 * `node --test`; the {@link ReviewPublisher} class owns the read-before-write
 * flow.
 * @module dsh-codex-review/lib/publish
 */

import { createHash } from 'node:crypto'
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

/** Fixed header a generated summary review body starts with (legacy adoption). */
export const PUBLISH_SUMMARY_HEADER = '**代码审查（dsh-codex-review）**'

/**
 * Hidden marker at the end of the rolling summary review body. It is not a
 * finding hash, so {@link parsePublishMarkers} ignores it; it lets a publish
 * recognise the previous summary review after the local state file was lost.
 */
export const PUBLISH_SUMMARY_MARKER = '<!-- dsh-codex-review:summary -->'

/** Upper bound for one publish request, including every GitHub call it makes. */
export const PUBLISH_TIMEOUT_MS = 30_000

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
 * Neutralize model-derived text before it becomes a GitHub body: HTML comments
 * must not smuggle a publish marker, and `@name` must not notify real users.
 * @param {unknown} value - model text.
 * @returns {string} safe text.
 */
export function sanitizeModelText(value) {
  const text = typeof value === 'string' ? value : ''
  return text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/@(?=[A-Za-z0-9_-])/g, '@\u200b')
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
 * Collect finding hashes already present in GitHub review comments authored by
 * the signed-in user. Comments from other users are ignored so a third party
 * cannot suppress a finding by writing a marker.
 * @param {Array<{ body?: string, author?: string }>} comments - existing review comments.
 * @param {string} [allowedAuthor] - login that may carry markers; empty means any author.
 * @returns {Set<string>} published finding hashes.
 */
export function parsePublishMarkers(comments, allowedAuthor = '') {
  /** @type {Set<string>} */
  const markers = new Set()
  for (const comment of Array.isArray(comments) ? comments : []) {
    const body = typeof comment?.body === 'string' ? comment.body : ''
    if (body === '' || !body.includes(PUBLISH_MARKER_PREFIX)) continue
    if (allowedAuthor !== '' && comment?.author !== allowedAuthor) continue
    for (const match of body.matchAll(PUBLISH_MARKER_RE)) markers.add(match[1])
  }
  return markers
}

/**
 * All publishable findings, sorted P0→P2 then file/line, without the comment cap.
 * The summary lists this full set; `maxComments` only limits inline comments.
 * @param {Array<any>} findings - review findings.
 * @param {{ minSeverity?: 'P0' | 'P1' | 'P2' }} [options] - severity filter.
 * @returns {Array<any>} sorted findings.
 */
export function filterEligibleFindings(findings, options = {}) {
  const minSeverity = PUBLISH_SEVERITIES.includes(options.minSeverity) ? options.minSeverity : PUBLISH_DEFAULTS.minSeverity
  const cutoff = PUBLISH_SEVERITIES.indexOf(minSeverity)
  return (Array.isArray(findings) ? findings : []).filter((finding) => {
    if (finding === null || typeof finding !== 'object') return false
    const rank = PUBLISH_SEVERITIES.indexOf(finding.severity)
    if (rank === -1 || rank > cutoff) return false
    if (typeof finding.file !== 'string' || finding.file === '') return false
    return Number.isInteger(finding.line) && finding.line > 0
  }).sort(compareFindings)
}

/**
 * Keep only publishable findings and sort them P0→P2 then file/line.
 * @param {Array<any>} findings - review findings.
 * @param {{ minSeverity?: 'P0' | 'P1' | 'P2', maxComments?: number }} [options] - filters.
 * @returns {{ selected: Array<any>, overLimit: number }} findings to publish (after the cap) and how many were dropped by it.
 */
export function filterPublishableFindings(findings, options = {}) {
  const maxComments = clampMaxComments(options.maxComments, PUBLISH_DEFAULTS.maxComments)
  const sorted = filterEligibleFindings(findings, options)
  return { selected: sorted.slice(0, maxComments), overLimit: Math.max(0, sorted.length - maxComments) }
}

/**
 * Render one inline review comment: severity+title, why, fix, marker. The whole
 * body never exceeds {@link PUBLISH_COMMENT_MAX_CHARS}. Model text is sanitized
 * so it cannot notify users or smuggle a marker.
 * @param {any} finding - normalized finding.
 * @returns {string} markdown comment body.
 */
export function buildInlineCommentBody(finding) {
  const severity = PUBLISH_SEVERITIES.includes(finding?.severity) ? finding.severity : 'P2'
  const title = truncate(sanitizeModelText(typeof finding?.title === 'string' ? finding.title.trim() : ''), INLINE_TITLE_MAX_CHARS) || '（未命名问题）'
  const sections = [`**[${severity}] ${title}**`]
  const why = sanitizeModelText(typeof finding?.why === 'string' ? finding.why.trim() : '')
  if (why !== '') sections.push(`为什么：${truncate(why, INLINE_WHY_MAX_CHARS)}`)
  const fix = sanitizeModelText(typeof finding?.fix === 'string' ? finding.fix.trim() : '')
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
 * The hidden {@link PUBLISH_SUMMARY_MARKER} always closes the body so a later
 * publish can find this rolling review again (CONTRACT §7.2 #6).
 * @param {{ overview?: unknown, findings?: Array<any>, customBody?: unknown, maxChars?: number }} [input] - summary data.
 * @returns {string} markdown body, never longer than the cap.
 */
export function buildSummaryBody(input = {}) {
  const maxChars = Number.isFinite(input.maxChars) && input.maxChars > 0 ? input.maxChars : PUBLISH_SUMMARY_MAX_CHARS
  const markerBlock = `\n\n${PUBLISH_SUMMARY_MARKER}`
  const budget = Math.max(0, maxChars - markerBlock.length)
  /** @type {string} */
  let content
  if (typeof input.customBody === 'string' && input.customBody.trim() !== '') {
    content = truncate(input.customBody.trim(), budget)
  } else {
    const findings = Array.isArray(input.findings) ? input.findings : []
    const overview = typeof input.overview === 'string' && input.overview.trim() !== ''
      ? input.overview.trim()
      : findings.length === 0 ? 'AI 未发现明显问题' : `共 ${findings.length} 个问题`
    const lines = [PUBLISH_SUMMARY_HEADER, '', sanitizeModelText(overview)]
    if (findings.length > 0) {
      lines.push('')
      for (const finding of findings) {
        const severity = PUBLISH_SEVERITIES.includes(finding?.severity) ? finding.severity : 'P2'
        lines.push(`- [${severity}] ${finding?.file ?? '?'}:${finding?.line ?? '?'} ${sanitizeModelText(finding?.title ?? '')}`.trimEnd())
      }
    }
    content = truncate(lines.join('\n'), budget)
  }
  return `${content}${markerBlock}`
}

/**
 * Hash everything one publish would write (summary body + inline comment
 * bodies). It serves as the replay guard: the same fingerprint on a repeat
 * publish means GitHub already shows exactly this content.
 * @param {{ summaryBody?: string, inlineComments?: Array<{ path?: string, line?: number, body?: string }> }} input - prepared publish content.
 * @returns {string} 12 hex characters.
 */
export function publishFingerprint(input = {}) {
  const summary = typeof input.summaryBody === 'string' ? input.summaryBody : ''
  const inline = (Array.isArray(input.inlineComments) ? input.inlineComments : []).map((comment) => [
    typeof comment?.path === 'string' ? comment.path : '',
    Number.isInteger(comment?.line) ? comment.line : 0,
    typeof comment?.body === 'string' ? comment.body : '',
  ])
  return createHash('sha1').update(JSON.stringify({ summary, inline })).digest('hex').slice(0, 12)
}

/**
 * Find the newest submitted review carrying {@link PUBLISH_SUMMARY_MARKER} or,
 * for reviews written before v2.4, the fixed summary header. Only reviews by the
 * signed-in author are eligible: a third party cannot redirect the rolling
 * identity by posting a marker.
 * @param {Array<{ id?: unknown, body?: unknown, url?: unknown, author?: unknown, submittedAt?: unknown }>} reviews - reviews from `listPullReviews`.
 * @param {string} [allowedAuthor] - login that may own the rolling review; empty means any author.
 * @returns {{ id: number, url: string } | undefined} the rolling summary review, when found.
 */
export function findPublishedSummaryReview(reviews, allowedAuthor = '') {
  /** @type {{ id: number, url: string, submittedAt: string } | undefined} */
  let best
  for (const review of Array.isArray(reviews) ? reviews : []) {
    if (review === null || typeof review !== 'object') continue
    const body = typeof review.body === 'string' ? review.body : ''
    const isSummary = body.includes(PUBLISH_SUMMARY_MARKER)
      || body.trimStart().startsWith(PUBLISH_SUMMARY_HEADER)
    if (!isSummary) continue
    if (allowedAuthor !== '' && review.author !== allowedAuthor) continue
    const id = Number(review.id)
    if (!Number.isFinite(id) || id <= 0) continue
    const submittedAt = typeof review.submittedAt === 'string' ? review.submittedAt : ''
    if (best === undefined || submittedAt >= best.submittedAt) {
      best = { id: Math.floor(id), url: typeof review.url === 'string' ? review.url : '', submittedAt }
    }
  }
  return best === undefined ? undefined : { id: best.id, url: best.url }
}

/**
 * Assemble everything one publish needs: filtered/sorted findings, the inline
 * comments actually to create (marker-deduplicated) and an optional summary.
 * The summary always lists every eligible finding (not only the ones not yet
 * posted inline, and not capped by `maxComments`), so the rolling review body
 * stays a complete picture.
 * @param {{ findings?: Array<any>, mode?: string, minSeverity?: string, maxComments?: number, existingMarkers?: Set<string>, overview?: string, body?: string }} input - publish data.
 * @returns {{ mode: string, minSeverity: string, maxComments: number, inlineComments: Array<{ path: string, line: number, side: 'RIGHT', body: string }>, summaryBody: string | undefined, selected: Array<any>, eligible: Array<any>, skipped: number, overLimit: number, deduped: number }} prepared publish.
 */
export function preparePublish(input = {}) {
  const mode = PUBLISH_MODES.includes(input.mode) ? input.mode : PUBLISH_DEFAULTS.mode
  const minSeverity = PUBLISH_SEVERITIES.includes(input.minSeverity) ? input.minSeverity : PUBLISH_DEFAULTS.minSeverity
  const maxComments = clampMaxComments(input.maxComments, PUBLISH_DEFAULTS.maxComments)
  const markers = input.existingMarkers instanceof Set ? input.existingMarkers : new Set()
  const eligible = filterEligibleFindings(input.findings, { minSeverity })
  const selected = eligible.slice(0, maxComments)
  const overLimit = Math.max(0, eligible.length - selected.length)
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
    ? buildSummaryBody({ overview: input.overview, findings: eligible, customBody: input.body })
    : undefined
  return {
    mode,
    minSeverity,
    maxComments,
    inlineComments,
    summaryBody,
    selected,
    eligible,
    skipped: overLimit + dedupedFindings.length,
    overLimit,
    deduped: dedupedFindings.length,
  }
}

/**
 * Build the response of a publish that needed no GitHub write. The caller still
 * learns which review already holds the content.
 * @param {{ reviewId?: unknown, url?: unknown } | null | undefined} record - stored publish identity.
 * @param {number} skipped - findings not sent.
 * @param {string} headSha - reviewed head.
 * @param {'created' | 'updated' | 'unchanged'} action - what the publish did.
 * @returns {{ published: true, reviewId: number, url: string, comments: 0, skipped: number, headSha: string, action: 'created' | 'updated' | 'unchanged' }} publish result.
 */
function replayResult(record, skipped, headSha, action) {
  return {
    published: true,
    reviewId: Number(record?.reviewId) || 0,
    url: typeof record?.url === 'string' ? record.url : '',
    comments: 0,
    skipped,
    headSha,
    action,
  }
}

/**
 * Fallback URL for a review created without a usable `html_url`.
 * @param {{ url?: unknown } | null | undefined} created - create response.
 * @param {string} repo - `owner/name`.
 * @param {number} number - PR number.
 * @param {number} reviewId - review id.
 * @returns {string} review URL or an empty string.
 */
function reviewUrl(created, repo, number, reviewId) {
  if (typeof created?.url === 'string' && created.url !== '') return created.url
  return reviewId > 0 ? `https://github.com/${repo}/pull/${number}#pullrequestreview-${reviewId}` : ''
}

/**
 * Store keys for one publish, scoped to the account when one is known.
 * @param {string} account - account id ('' for legacy single-account data).
 * @param {string} repo - `owner/name`.
 * @param {number} number - PR number.
 * @param {string} headSha - head commit.
 * @returns {{ prKey: string, headKey: string }} rolling and per-head keys.
 */
export function publishRecordKeys(account, repo, number, headSha) {
  const id = typeof account === 'string' ? account.trim() : ''
  const prefix = id !== '' ? `${id}|` : ''
  return { prKey: `${prefix}${repo}#${number}`, headKey: `${prefix}${repo}#${number}@${headSha}` }
}

/**
 * Hash of everything one publish was asked to write (mode, severity, cap and
 * custom body). The head record stores it so a repeat request replays even when
 * the recomputed content differs only because GitHub now has more markers.
 * @param {{ mode?: string, minSeverity?: string, maxComments?: number, body?: string }} input - request parameters.
 * @returns {string} 12 hex characters.
 */
export function publishRequestKey(input = {}) {
  return createHash('sha1').update(JSON.stringify({
    mode: input.mode,
    minSeverity: input.minSeverity,
    maxComments: input.maxComments,
    body: typeof input.body === 'string' ? input.body : '',
  })).digest('hex').slice(0, 12)
}

/**
 * Whether one stored record can answer the current request: it must carry a
 * usable review identity and the same content fingerprint.
 * @param {any} record - stored record.
 * @param {string} fingerprint - current content fingerprint.
 * @returns {boolean} true when the record is replayable.
 */
function isReplayable(record, fingerprint) {
  if (record === null || record === undefined) return false
  if (!(Number(record.reviewId) > 0)) return false
  if (typeof record.url !== 'string' || record.url === '') return false
  return record.fingerprint === fingerprint
}

/**
 * Whether one stored head record answers this exact request.
 * @param {any} record - stored head record.
 * @param {string} requestKey - current request identity.
 * @returns {boolean} true when the same request already published this head.
 */
function isReplayableHead(record, requestKey) {
  if (record === null || record === undefined) return false
  if (!(Number(record.reviewId) > 0)) return false
  if (typeof record.url !== 'string' || record.url === '') return false
  return record.request === requestKey
}

/**
 * The publish flow: read the PR/review, replay a matching record, update the one
 * rolling summary review when the content changed, and create a review only for
 * content that has no review yet (the first summary, or newly discovered inline
 * findings).
 */
export class ReviewPublisher {
  /**
   * @param {{ github: any, engine: any, store?: { get: (key: string) => any, set: (key: string, record: any) => void }, logger?: any, now?: () => number }} [options] - wiring.
   */
  constructor(options = {}) {
    this.github = options.github
    this.engine = options.engine
    /** Account that may read pre-account publish records. */
    this.legacyAccount = typeof options.legacyAccount === 'string' ? options.legacyAccount : 'github'
    this.store = options.store ?? { get: () => undefined, set: () => {} }
    this.logger = options.logger
    this.now = options.now ?? Date.now
    /** One publish per repo#number@headSha; concurrent callers share this promise. @type {Map<string, Promise<any>>} */
    this.inflight = new Map()
    /** One publish per repo#number at a time, so rolling-review writes never race. @type {Map<string, Promise<any>>} */
    this.prLocks = new Map()
    /** Set by {@link dispose}; new publishes are refused afterwards. */
    this.disposed = false
  }

  /** Stop accepting publishes and drop every pending lock (plugin dispose). */
  dispose() {
    this.disposed = true
    this.inflight.clear()
    this.prLocks.clear()
  }

  /**
   * Publish one completed review (CONTRACT §7.2). The caller must have obtained
   * an explicit user confirmation (`confirm: true`). When `jobId`/`headSha` are
   * given, the request is bound to that exact review job instead of whatever
   * happens to be the newest job for the current head.
   * @param {{ repo: string, number: number, mode?: string, minSeverity?: string, maxComments?: number, body?: string, confirm?: boolean, headSha?: string, jobId?: string, signal?: AbortSignal }} input - publish request.
   * @returns {Promise<{ published: true, reviewId: number, url: string, comments: number, skipped: number, headSha: string, action: 'created' | 'updated' | 'unchanged' }>} publish result.
   * @throws {AppError} BAD_REQUEST / REVIEW_NOT_READY / REVIEW_PARTIAL / REVIEW_HEAD_MOVED / GH_* / INTERNAL.
   */
  async publish(input = {}) {
    if (input?.confirm !== true) throw badRequest('发布审查需要 confirm: true')
    if (this.disposed) throw new AppError('INTERNAL', '插件已卸载')
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

    const jobId = typeof input.jobId === 'string' ? input.jobId.trim() : ''
    let headSha = typeof input.headSha === 'string' ? input.headSha.trim() : ''
    /** @type {any} */
    let review
    if (jobId !== '') {
      try {
        review = this.engine.status(jobId)
      } catch {
        throw new AppError('REVIEW_NOT_READY')
      }
      if (headSha === '' && typeof review?.headSha === 'string') headSha = review.headSha
    } else {
      if (headSha === '') {
        const detail = await this.github.getPull(repo, number)
        headSha = typeof detail?.headSha === 'string' ? detail.headSha.trim() : ''
      }
      review = typeof this.engine.existing === 'function' ? this.engine.existing(repo, number, headSha) : undefined
    }
    if (headSha === '') throw new AppError('GH_NOT_FOUND', '无法确定该 PR 的 head commit')
    if (review === undefined || review === null || review.state !== 'done') throw new AppError('REVIEW_NOT_READY')
    if (typeof review.headSha === 'string' && review.headSha !== '' && review.headSha !== headSha) throw new AppError('REVIEW_NOT_READY')
    if (review.partial === true) throw new AppError('REVIEW_PARTIAL')

    // The publish must target the PR's current head, not a stale snapshot from
    // the 60 s detail cache. The route signal keeps this read bounded too.
    if (typeof this.github.getPullHead === 'function') {
      const current = await this.github.getPullHead(repo, number, { signal: input.signal })
      if (current !== '' && current !== headSha) throw new AppError('REVIEW_HEAD_MOVED')
    }

    // One publish per head: a double click (or a second tab) must never create
    // two GitHub reviews, so concurrent calls share the in-flight promise
    // instead of racing the store record (CONTRACT §7.2 #6). Different heads of
    // the same PR are serialized too, because both may update the same rolling
    // summary review.
    const account = typeof input.account === 'string' ? input.account.trim() : ''
    const key = publishRecordKeys(account, repo, number, headSha).headKey
    const pending = this.inflight.get(key)
    if (pending !== undefined) return pending
    const prKey = publishRecordKeys(account, repo, number, headSha).prKey
    const previous = this.prLocks.get(prKey) ?? Promise.resolve()

    const controller = new AbortController()
    const outer = input.signal
    /** @type {() => void} */
    const forwardAbort = () => {
      try {
        controller.abort(outer?.reason)
      } catch {
        // an already-aborted signal is fine
      }
    }
    if (outer !== undefined) {
      if (outer.aborted === true) forwardAbort()
      else if (typeof outer.addEventListener === 'function') outer.addEventListener('abort', forwardAbort, { once: true })
    }
    /** @type {NodeJS.Timeout | undefined} */
    let timer
    const running = previous.catch(() => undefined).then(() => {
      // The budget starts when this publish actually begins, not while it waits
      // behind another publish of the same PR.
      timer = setTimeout(() => {
        try {
          controller.abort(new Error('publish timeout'))
        } catch {
          // the controller is already aborted
        }
      }, PUBLISH_TIMEOUT_MS)
      if (typeof timer.unref === 'function') timer.unref()
      return this.publishForPull({
        account,
        repo,
        number,
        headSha,
        review,
        mode,
        minSeverity,
        maxComments,
        customBody,
        signal: controller.signal,
      })
    })
    this.inflight.set(key, running)
    this.prLocks.set(prKey, running)
    try {
      return await running
    } catch (error) {
      // A write that our own budget cancelled may still have landed on GitHub:
      // say so instead of reporting a plain network failure.
      if (controller.signal.aborted === true && (!(error instanceof AppError) || error.code === 'GH_TIMEOUT')) {
        throw new AppError('PUBLISH_UNKNOWN', undefined, { cause: error })
      }
      throw error
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      if (outer !== undefined && typeof outer.removeEventListener === 'function') outer.removeEventListener('abort', forwardAbort)
      this.inflight.delete(key)
      if (this.prLocks.get(prKey) === running) this.prLocks.delete(prKey)
    }
  }

  /**
   * The write half of {@link publish}: replay a matching (head, content) record,
   * skip a publish whose content GitHub already shows, update the rolling summary
   * review in place, and create a review only for content that has no review yet.
   * Callers go through {@link publish}, which serializes concurrent calls.
   * @param {{ repo: string, number: number, headSha: string, review: any, mode: string, minSeverity: string, maxComments: number, customBody?: string, signal?: AbortSignal }} input - resolved publish request.
   * @returns {Promise<{ published: true, reviewId: number, url: string, comments: number, skipped: number, headSha: string, action: 'created' | 'updated' | 'unchanged' }>} publish result.
   * @throws {AppError} GH_* / INTERNAL while talking to GitHub.
   */
  async publishForPull(input) {
    const { repo, number, headSha, review, mode, minSeverity, maxComments, customBody, signal } = input
    const account = typeof input.account === 'string' ? input.account.trim() : ''
    const { prKey, headKey } = publishRecordKeys(account, repo, number, headSha)
    const requestKey = publishRequestKey({ mode, minSeverity, maxComments, body: customBody })

    // A repeat of the same request for the same head answers from the record and
    // performs no GitHub read at all (CONTRACT §7.2 #6). The check runs before
    // the marker read on purpose: a double click must not pay for a round trip.
    // Read the account-scoped key first, then a pre-account upgrade record.
    const recorded = this.store.get(headKey) ??
      (account !== '' && account === this.legacyAccount ? this.store.get(`${repo}#${number}@${headSha}`) : undefined)
    if (isReplayableHead(recorded, requestKey)) {
      const replay = filterPublishableFindings(review.findings, { minSeverity, maxComments })
      return replayResult(recorded, replay.selected.length + replay.overLimit, headSha, 'unchanged')
    }

    const author = typeof this.github.getAuthenticatedUser === 'function'
      ? await this.github.getAuthenticatedUser().catch(() => '')
      : ''

    // Inline comments need the marker set; a summary-only publish does not.
    /** @type {Set<string>} */
    let existingMarkers = new Set()
    if ((mode === 'inline' || mode === 'both') && typeof this.github.listPullReviewComments === 'function') {
      existingMarkers = parsePublishMarkers(await this.github.listPullReviewComments(repo, number, { signal }), author)
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
    const fingerprint = publishFingerprint({ summaryBody: prepared.summaryBody, inlineComments: prepared.inlineComments })

    // The new head produced exactly the content already on GitHub: keep the
    // head↔review pointer fresh but do not touch GitHub (CONTRACT §7.2 #6).
    const rolling = this.store.get(prKey) ??
      (account !== '' && account === this.legacyAccount ? this.store.get(`${repo}#${number}`) : undefined)
    if (isReplayable(rolling, fingerprint)) {
      this.persistRecords([{ key: headKey, record: { publishedAt: this.now(), reviewId: rolling.reviewId, url: rolling.url, fingerprint, request: requestKey } }])
      return replayResult(rolling, prepared.selected.length + prepared.overLimit, headSha, 'unchanged')
    }

    // Resolve the one rolling summary review this PR keeps (persisted identity
    // first, marker/header recovery second) — but only summary mode can update a
    // body.
    const canUpdate = typeof this.github.updatePullReview === 'function'
    let rollingReviewId = canUpdate ? Number(rolling?.reviewId) || 0 : 0
    let rollingUrl = canUpdate && typeof rolling?.url === 'string' ? rolling.url : ''
    if (rollingReviewId <= 0 && prepared.summaryBody !== undefined && typeof this.github.listPullReviews === 'function') {
      const found = findPublishedSummaryReview(await this.github.listPullReviews(repo, number, { signal }), author)
      if (found !== undefined) {
        rollingReviewId = found.id
        rollingUrl = found.url
      }
    }

    let reviewId = rollingReviewId
    let url = rollingUrl
    let comments = 0
    /** @type {'created' | 'updated' | 'unchanged'} */
    let action = 'updated'
    if (prepared.summaryBody !== undefined) {
      if (rollingReviewId > 0) {
        // Update in place: the timeline keeps one summary review per PR.
        try {
          const updated = await this.github.updatePullReview({ repo, number, reviewId: rollingReviewId, body: prepared.summaryBody, signal })
          if (typeof updated?.url === 'string' && updated.url !== '') url = updated.url
        } catch (error) {
          // A review recorded locally but deleted/dismissed on GitHub: recreate.
          if (!(error instanceof AppError) || error.code !== 'GH_NOT_FOUND') throw error
          rollingReviewId = 0
          url = ''
        }
      }
      if (rollingReviewId <= 0) {
        // First publish (or recovery failed): create the one rolling review and
        // carry today's new inline findings with it.
        const created = await this.createWithFallback({
          repo,
          number,
          headSha,
          body: prepared.summaryBody,
          comments: prepared.inlineComments.length > 0 ? prepared.inlineComments : undefined,
          signal,
        })
        reviewId = created.reviewId
        url = reviewUrl(created, repo, number, reviewId)
        comments = created.inline ? prepared.inlineComments.length : 0
        action = 'created'
      } else if (prepared.inlineComments.length > 0) {
        // A submitted review cannot gain inline comments: send only the new
        // findings in a bodyless review, leaving the summary identity intact.
        const created = await this.github.createPullReview({ repo, number, headSha, comments: prepared.inlineComments, signal })
        if (url === '' && created?.url !== undefined) url = reviewUrl(created, repo, number, Number(created?.reviewId) || 0)
        comments = prepared.inlineComments.length
      }
    } else if (prepared.inlineComments.length > 0) {
      // Inline-only mode: new findings always need a new review (GitHub API).
      // It must NOT take over the rolling summary identity.
      const created = await this.createWithFallback({
        repo,
        number,
        headSha,
        comments: prepared.inlineComments,
        fallbackBody: buildSummaryBody({ overview: review.overview, findings: prepared.eligible }),
        signal,
      })
      comments = created.inline ? prepared.inlineComments.length : 0
      reviewId = created.reviewId
      url = reviewUrl(created, repo, number, reviewId)
      action = 'created'
    } else {
      action = 'unchanged'
    }

    const now = this.now()
    if (reviewId > 0 && url !== '') {
      /** @type {Array<{ key: string, record: any }>} */
      const records = [{ key: headKey, record: { publishedAt: now, reviewId, url, fingerprint, request: requestKey } }]
      // Only a review that actually carries the summary body owns the rolling
      // identity (CONTRACT §7.2 #9).
      if (prepared.summaryBody !== undefined) records.push({ key: prKey, record: { publishedAt: now, reviewId, url, fingerprint } })
      this.persistRecords(records)
    }
    return {
      published: true,
      reviewId,
      url,
      comments,
      skipped: prepared.skipped,
      headSha,
      action,
    }
  }

  /**
   * Create one review; when GitHub rejects an inline anchor (422) retry once
   * without inline comments so at least the summary is published. The result
   * reports whether the inline comments actually landed, so the caller can
   * report a truthful comment count instead of the number it tried to send.
   * @param {{ repo: string, number: number, headSha: string, body?: string, comments?: Array<any>, fallbackBody?: string, signal?: AbortSignal }} payload - create request.
   * @returns {Promise<{ reviewId: number, url: string, inline: boolean }>} created review identity.
   * @throws {AppError} mapped GitHub failure.
   */
  async createWithFallback(payload) {
    try {
      const created = await this.github.createPullReview(payload)
      const inline = Array.isArray(payload.comments) && payload.comments.length > 0
      return {
        reviewId: Number(created?.reviewId) > 0 ? Number(created.reviewId) : 0,
        url: typeof created?.url === 'string' ? created.url : '',
        inline,
      }
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== 'BAD_REQUEST') throw error
      if (!Array.isArray(payload.comments) || payload.comments.length === 0) throw error
      const body = typeof payload.body === 'string' && payload.body !== '' ? payload.body : payload.fallbackBody
      if (typeof body !== 'string' || body === '') throw error
      this.logger?.warn?.('dsh-codex-review: inline anchors were rejected, retrying the publish without comments')
      const created = await this.github.createPullReview({ ...payload, comments: undefined, fallbackBody: undefined, body })
      return {
        reviewId: Number(created?.reviewId) > 0 ? Number(created.reviewId) : 0,
        url: typeof created?.url === 'string' ? created.url : '',
        inline: false,
      }
    }
  }

  /**
   * Persist publish records; a broken store must never turn a successful GitHub
   * write into a failed publish. When the store supports `setMany`, the per-head
   * pointer and the rolling identity are written in one atomic state-file
   * replace, so a crash between them cannot leave half a publish recorded.
   * @param {Array<{ key: string, record: any }>} entries - records to persist.
   * @returns {void}
   */
  persistRecords(entries) {
    if (!Array.isArray(entries) || entries.length === 0) return
    try {
      if (typeof this.store.setMany === 'function') {
        this.store.setMany(entries)
        return
      }
      for (const entry of entries) this.store.set(entry.key, entry.record)
    } catch (error) {
      this.logger?.warn?.(`dsh-codex-review: cannot persist publish record: ${error?.message ?? error}`)
    }
  }
}
