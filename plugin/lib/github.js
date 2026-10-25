/**
 * GitHub data channel of dsh-codex-review.
 *
 * Two transports behind one normalized surface:
 *
 * - **primary** — `gh auth token` once (cached in memory only), then Node
 *   `fetch` against `https://api.github.com`. Every request asks for
 *   `accept-encoding: identity` because the DSH host installs an undici proxy
 *   whose automatic decompression does not survive the global dispatcher swap;
 *   without the header the caller receives compressed bytes.
 * - **fallback** — `gh api ...` through an async `execFile` (never
 *   `spawnSync`), used when no token can be obtained.
 *
 * Everything the browser sees is normalized to `CONTRACT.md` §1.2 shapes:
 * caches are process-memory LRU entries with per-entry TTL, patch text is
 * truncated per file and per payload, secondary requests degrade through
 * `Promise.allSettled` (a failed checks call must not fail the page), and the
 * stack chain is inferred from `baseRefName` plus the PR body's `base:` note.
 * @module dsh-codex-review/lib/github
 */

import { execFile } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { AppError, USER_MESSAGES, isAbortError } from './errors.js'
import { buildChatContext } from './chat.js'

const execFileAsync = promisify(execFile)

/** REST base; kept overridable for GitHub Enterprise deployments. */
export const API_BASE_URL = 'https://api.github.com'

/** User agent GitHub asks clients to identify themselves with. */
export const USER_AGENT = 'dsh-codex-review'

/** API version pin from the reconnaissance run. */
export const GITHUB_API_VERSION = '2022-11-28'

/** `owner/name` repository shape accepted from the browser. */
export const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

/** Async child-process buffer cap (PR lists legitimately reach megabytes). */
const MAX_GH_BUFFER = 64 * 1024 * 1024

/** Cache TTLs from CONTRACT §1.4. */
const LIST_TTL_MS = 60_000
const DETAIL_TTL_MS = 60_000
const PATCH_TTL_MS = 30 * 60_000
const CHECKS_TTL_MS = 30_000
const HEALTH_TTL_MS = 30_000
/** Repository-review guidelines (AGENTS.md) are repo-level and change rarely (CONTRACT §4.4). */
const GUIDELINE_TTL_MS = 10 * 60_000

/** Files read for repository review guidance, in injection order (CONTRACT §4.4). */
export const GUIDELINE_PATHS = Object.freeze(['AGENTS.md', '.github/AGENTS.md'])

/** Per-file character budget for injected guidelines (CONTRACT §4.4). */
export const GUIDELINE_MAX_CHARS = 4_000

/** File-list page budget: GitHub caps pull-request files at 3000; three pages of 100. */
const FILES_PAGE_SIZE = 100
const MAX_FILE_PAGES = 3
const MAX_FILES = 300

/** Total patch-text budget for one PrDetail payload (CONTRACT §1.4). */
export const MAX_TOTAL_PATCH_CHARS = 1_200_000

/** Comment list caps from CONTRACT §1.2. */
const MAX_ISSUE_COMMENTS = 20
const MAX_REVIEWS = 20
const MAX_INLINE_COMMENTS = 50
const MAX_COMMENT_BODY_CHARS = 4_000

/** Review-comment pages read when deduplicating a publish (CONTRACT §7.2). */
const REVIEW_COMMENT_PAGE_SIZE = 100
const MAX_REVIEW_COMMENT_PAGES = 10
/** Review pages read when recovering the rolling summary after state loss. */
const REVIEW_PAGE_SIZE = 100
const MAX_REVIEW_PAGES = 20

/** Character cap for one user-written comment (issue comment or reply). */
export const WRITE_COMMENT_MAX_CHARS = 4_000

/**
 * Trim and validate one user-written comment body.
 * @param {unknown} value - raw body from a route.
 * @returns {string} normalized body.
 * @throws {AppError} BAD_REQUEST for a non-string, blank or over-long body.
 */
function normalizeCommentBody(value) {
  if (typeof value !== 'string') throw new AppError('BAD_REQUEST', '评论内容必须是字符串')
  const trimmed = value.trim()
  if (trimmed === '') throw new AppError('BAD_REQUEST', '评论内容不能为空')
  if (trimmed.length > WRITE_COMMENT_MAX_CHARS) throw new AppError('BAD_REQUEST', `评论内容超过 ${WRITE_COMMENT_MAX_CHARS} 字`)
  return trimmed
}

/**
 * Validate one positive integer id from a write request.
 * @param {unknown} value - raw id.
 * @param {string} label - field label used in the error message.
 * @returns {number} the id.
 * @throws {AppError} BAD_REQUEST for a non-positive or non-integer id.
 */
function requirePositiveNumber(value, label) {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(numeric) || numeric <= 0) throw new AppError('BAD_REQUEST', `${label} 必须是正整数`)
  return numeric
}

/**
 * Normalize one freshly created GitHub comment.
 * @param {any} data - REST response body.
 * @returns {{ id: number, url: string, createdAt: string }} created comment.
 */
function normalizeCreatedComment(data) {
  return {
    id: Number.isInteger(data?.id) ? data.id : 0,
    url: typeof data?.html_url === 'string' ? data.html_url : '',
    createdAt: typeof data?.created_at === 'string' ? data.created_at : '',
  }
}

/**
 * Map a GitHub GraphQL `errors` array onto a stable error code.
 * @param {Array<{ message?: string, type?: string }>} errors - GraphQL errors.
 * @returns {AppError} mapped failure.
 */
function graphqlError(errors) {
  const first = Array.isArray(errors) ? errors[0] : undefined
  const message = typeof first?.message === 'string' ? first.message : 'GitHub GraphQL 请求失败'
  const type = typeof first?.type === 'string' ? first.type : ''
  const code = type === 'NOT_FOUND' ? 'GH_NOT_FOUND' : 'GH_FORBIDDEN'
  return new AppError(code, `${USER_MESSAGES[code]}（GitHub: ${message.slice(0, 200)}）`)
}

/** Merge methods accepted by the merge route (CONTRACT §5.1). */
export const MERGE_METHODS = Object.freeze(['merge', 'squash', 'rebase'])

/** Commit title/message caps of the merge request (CONTRACT §5.1). */
export const MERGE_COMMIT_TITLE_MAX_CHARS = 256
export const MERGE_COMMIT_MESSAGE_MAX_CHARS = 2_000

/** How often the merge guard re-reads a PR whose `mergeable` GitHub is still computing. */
const MERGE_RETRY_MAX = 2
const MERGE_RETRY_DELAY_MS = 800

/** `mergeable_state` values that still allow the merge attempt (CONTRACT §5.1). */
const MERGE_ALLOWED_STATES = Object.freeze(['CLEAN', 'HAS_HOOKS', 'UNSTABLE'])

/** How many parent PRs one stack walk follows before it stops. */
const MAX_STACK_DEPTH = 5

/** HTTP statuses mapped to a stable error code. */
const STATUS_LOGGED_OUT = 401
const STATUS_FORBIDDEN = 403
const STATUS_NOT_FOUND = 404
const STATUS_RATE_LIMITED = 429

/**
 * Small insertion-ordered LRU with a per-entry expiry. Re-reading an entry
 * moves it to the most-recent end; overflow evicts the oldest end.
 */
export class LruCache {
  /**
   * @param {number} max - maximum live entries.
   */
  constructor(max = 200) {
    /** @type {number} */
    this.max = max
    /** @type {Map<string, { value: unknown, expiresAt: number }>} */
    this.entries = new Map()
  }

  /**
   * @param {string} key - cache key.
   * @param {number} [now] - clock override for tests.
   * @returns {unknown | undefined} the live value, or undefined.
   */
  get(key, now = Date.now()) {
    const entry = this.entries.get(key)
    if (entry === undefined) return undefined
    if (entry.expiresAt <= now) {
      this.entries.delete(key)
      return undefined
    }
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.value
  }

  /**
   * @param {string} key - cache key.
   * @param {unknown} value - value to retain.
   * @param {number} ttlMs - lifetime in milliseconds.
   * @param {number} [now] - clock override for tests.
   */
  set(key, value, ttlMs, now = Date.now()) {
    if (this.entries.has(key)) this.entries.delete(key)
    this.entries.set(key, { value, expiresAt: now + ttlMs })
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next()
      if (oldest.done === true) break
      this.entries.delete(oldest.value)
    }
  }

  /**
   * @param {string} key - cache key.
   * @returns {boolean} whether an entry was removed.
   */
  delete(key) {
    return this.entries.delete(key)
  }

  /** Drop every entry (plugin dispose and tests). */
  clear() {
    this.entries.clear()
  }
}

/**
 * Truncate a string to a character budget, reporting whether it happened.
 * @param {unknown} value - candidate text.
 * @param {number} maxChars - character cap.
 * @returns {{ text: string, truncated: boolean }} bounded text plus the flag.
 */
export function truncateText(value, maxChars) {
  const text = typeof value === 'string' ? value : ''
  if (text.length <= maxChars) return { text, truncated: false }
  return { text: text.slice(0, maxChars), truncated: true }
}

/**
 * Decode one `repos/{o}/{r}/contents/{path}` payload into its text. The REST
 * endpoint returns `{ encoding: 'base64', content }` for files (line-wrapped);
 * directories and submodules carry no decodable content and yield ''.
 * @param {any} payload - contents API body.
 * @returns {string} decoded text, or '' when unusable.
 */
export function decodeContentsPayload(payload) {
  if (payload === null || typeof payload !== 'object') return ''
  if (typeof payload.type === 'string' && payload.type !== 'file') return ''
  const content = typeof payload.content === 'string' ? payload.content : ''
  if (content === '') return ''
  const encoding = typeof payload.encoding === 'string' ? payload.encoding.toLowerCase() : ''
  if (encoding === 'base64') {
    try {
      return Buffer.from(content.replace(/\s+/g, ''), 'base64').toString('utf8')
    } catch {
      return ''
    }
  }
  // A plain-text payload (raw media type over a different transport) is already
  // the file content.
  return content
}

/**
 * Normalize a REST files entry into a {@link FilePatch}, truncating its patch.
 * @param {any} file - raw `pulls/{n}/files` element.
 * @param {{ maxPatchChars?: number }} [options] - per-file patch cap.
 * @returns {{ path: string, previousPath?: string, status: string, additions: number, deletions: number, patch: string, patchTruncated: boolean }} normalized file.
 */
export function normalizeFilePatch(file, options = {}) {
  const maxPatchChars = options.maxPatchChars ?? 24000
  const rawPatch = typeof file?.patch === 'string' ? file.patch : ''
  const patch = truncateText(rawPatch, maxPatchChars)
  /** @type {{ path: string, previousPath?: string, status: string, additions: number, deletions: number, patch: string, patchTruncated: boolean }} */
  const normalized = {
    path: typeof file?.filename === 'string' ? file.filename : '',
    status: normalizeFileStatus(file?.status),
    additions: toCount(file?.additions),
    deletions: toCount(file?.deletions),
    patch: patch.text,
    patchTruncated: patch.truncated,
  }
  if (typeof file?.previous_filename === 'string' && file.previous_filename !== '') {
    normalized.previousPath = file.previous_filename
  }
  return normalized
}

/**
 * Lowercase one REST file status, keeping the contract's whitelist.
 * @param {unknown} status - REST `status` value.
 * @returns {'added' | 'modified' | 'removed' | 'renamed' | 'copied' | 'changed' | 'unchanged'} normalized status.
 */
export function normalizeFileStatus(status) {
  switch (String(status ?? '').toLowerCase()) {
    case 'added': return 'added'
    case 'removed': return 'removed'
    case 'renamed': return 'renamed'
    case 'copied': return 'copied'
    case 'changed': return 'changed'
    case 'unchanged': return 'unchanged'
    default: return 'modified'
  }
}

/**
 * Apply the total patch budget across files in order. Files past the budget
 * keep their metadata but lose their patch text and report `patchTruncated`.
 * @param {Array<ReturnType<typeof normalizeFilePatch>>} files - normalized files.
 * @param {number} [maxTotalChars] - payload patch budget.
 * @returns {{ files: Array<ReturnType<typeof normalizeFilePatch>>, filesTruncated: boolean }} bounded list.
 */
export function applyPatchBudget(files, maxTotalChars = MAX_TOTAL_PATCH_CHARS) {
  let used = 0
  let truncated = false
  const bounded = files.map((file) => {
    if (file.patch === '') return file
    const remaining = maxTotalChars - used
    if (remaining <= 0) {
      truncated = true
      return { ...file, patch: '', patchTruncated: true }
    }
    if (file.patch.length > remaining) {
      truncated = true
      used += remaining
      return { ...file, patch: file.patch.slice(0, remaining), patchTruncated: true }
    }
    used += file.patch.length
    return file
  })
  return { files: bounded, filesTruncated: truncated }
}

/**
 * Normalize one `search/issues` element into a {@link PrSummary}.
 * @param {any} item - raw search result.
 * @returns {{ repo: string, number: number, title: string, author: string, isDraft: boolean, state: string, createdAt: string, updatedAt: string, headRefName: string, baseRefName: string, url: string, reviewDecision?: string } | null} summary, or null when unusable.
 */
export function normalizeSearchItem(item) {
  if (item === null || typeof item !== 'object') return null
  const number = toCount(item.number)
  if (number <= 0) return null
  const repositoryUrl = typeof item.repository_url === 'string' ? item.repository_url : ''
  const repository = /\/repos\/([^/]+)\/([^/]+)$/.exec(repositoryUrl)
  const pullRequest = item.pull_request !== null && typeof item.pull_request === 'object' ? item.pull_request : {}
  return {
    repo: repository === null ? '' : `${repository[1]}/${repository[2]}`,
    number,
    title: typeof item.title === 'string' ? item.title : '',
    author: typeof item.user?.login === 'string' ? item.user.login : 'ghost',
    isDraft: item.draft === true,
    state: item.state === 'closed' ? 'closed' : 'open',
    createdAt: typeof item.created_at === 'string' ? item.created_at : '',
    updatedAt: typeof item.updated_at === 'string' ? item.updated_at : '',
    headRefName: typeof pullRequest.head?.ref === 'string' ? pullRequest.head.ref : '',
    baseRefName: typeof pullRequest.base?.ref === 'string' ? pullRequest.base.ref : '',
    url: typeof item.html_url === 'string' ? item.html_url : '',
  }
}

/**
 * Normalize the PR object itself into a {@link PrSummary} with totals.
 * @param {any} pull - raw `repos/{o}/{r}/pulls/{n}` body.
 * @param {string} repo - `owner/name`.
 * @param {number} number - PR number.
 * @returns {any} summary with additions/deletions/changedFiles.
 */
export function normalizePullSummary(pull, repo, number) {
  const merged = pull?.merged_at !== null && pull?.merged_at !== undefined
  return {
    repo,
    number,
    title: typeof pull?.title === 'string' ? pull.title : '',
    author: typeof pull?.user?.login === 'string' ? pull.user.login : 'ghost',
    isDraft: pull?.draft === true,
    state: merged === true || pull?.state === 'closed' ? 'closed' : 'open',
    createdAt: typeof pull?.created_at === 'string' ? pull.created_at : '',
    updatedAt: typeof pull?.updated_at === 'string' ? pull.updated_at : '',
    headRefName: typeof pull?.head?.ref === 'string' ? pull.head.ref : '',
    baseRefName: typeof pull?.base?.ref === 'string' ? pull.base.ref : '',
    reviewDecision: typeof pull?.review_decision === 'string' ? pull.review_decision : '',
    additions: toCount(pull?.additions),
    deletions: toCount(pull?.deletions),
    changedFiles: toCount(pull?.changed_files),
    url: typeof pull?.html_url === 'string' ? pull.html_url : '',
  }
}

/**
 * Merge check-runs and commit statuses into the contract's checks shape.
 * An empty set is `none` — never `pending` (a CI-less repo reports
 * `{state:'pending', total_count:0}` from the combined-status endpoint).
 * @param {any} checkRuns - `commits/{sha}/check-runs` body.
 * @param {any} combinedStatus - `commits/{sha}/status` body.
 * @returns {{ state: 'none' | 'pending' | 'success' | 'failure' | 'neutral' | 'unknown', items: Array<{ name: string, state: string, url?: string }> }} checks view.
 */
export function normalizeChecks(checkRuns, combinedStatus) {
  const runs = Array.isArray(checkRuns?.check_runs) ? checkRuns.check_runs : []
  const statuses = Array.isArray(combinedStatus?.statuses) ? combinedStatus.statuses : []
  /** @type {Array<{ name: string, state: string, url?: string }>} */
  const items = []
  for (const run of runs) {
    /** @type {{ name: string, state: string, url?: string }} */
    const item = {
      name: typeof run?.name === 'string' ? run.name : 'check',
      state: normalizeCheckRunState(run),
    }
    if (typeof run?.html_url === 'string' && run.html_url !== '') item.url = run.html_url
    items.push(item)
  }
  for (const status of statuses) {
    /** @type {{ name: string, state: string, url?: string }} */
    const item = {
      name: typeof status?.context === 'string' ? status.context : 'status',
      state: normalizeCommitStatusState(status?.state),
    }
    if (typeof status?.target_url === 'string' && status.target_url !== '') item.url = status.target_url
    items.push(item)
  }
  if (items.length === 0) return { state: 'none', items }
  if (items.some((item) => item.state === 'failure')) return { state: 'failure', items }
  if (items.some((item) => item.state === 'pending')) return { state: 'pending', items }
  if (items.every((item) => item.state === 'neutral')) return { state: 'neutral', items }
  if (items.every((item) => item.state === 'success')) return { state: 'success', items }
  return { state: 'unknown', items }
}

/**
 * @param {any} run - check-run object.
 * @returns {string} contract-ish state token.
 */
function normalizeCheckRunState(run) {
  const conclusion = String(run?.conclusion ?? '').toLowerCase()
  if (conclusion === 'success') return 'success'
  if (conclusion === 'neutral' || conclusion === 'skipped') return 'neutral'
  if (['failure', 'timed_out', 'cancelled', 'action_required', 'stale'].includes(conclusion)) return 'failure'
  const status = String(run?.status ?? '').toLowerCase()
  if (status === 'completed') return 'unknown'
  return 'pending'
}

/**
 * @param {unknown} status - combined status state.
 * @returns {string} contract-ish state token.
 */
function normalizeCommitStatusState(status) {
  switch (String(status ?? '').toLowerCase()) {
    case 'success': return 'success'
    case 'pending': return 'pending'
    case 'failure':
    case 'error': return 'failure'
    default: return 'unknown'
  }
}

/**
 * Read the PR body's declared stacked base (`base: \`branch\`` or the Chinese
 * equivalents), as the reconnaissance report observed on #129.
 * @param {unknown} body - PR body markdown.
 * @returns {string | undefined} declared base branch name, when present.
 */
export function parseDeclaredBase(body) {
  if (typeof body !== 'string' || body === '') return undefined
  const match = /base\s*(?:为|是|[:：])\s*`([^`\n]+)`/i.exec(body)
  if (match !== null && match[1].trim() !== '') return match[1].trim()
  const plain = /(?:^|\n)\s*base\s*[:：]\s*([A-Za-z0-9_./-]+)/i.exec(body)
  if (plain !== null && plain[1].trim() !== '') return plain[1].trim()
  return undefined
}

/**
 * Pick the parent PR that heads `baseRefName` from a `pulls?head=` listing.
 * @param {any} listing - REST pull array.
 * @param {string} headRef - branch that should be the parent's head.
 * @returns {{ number: number, title: string, state: string, baseRefName: string, merged: boolean } | undefined} normalized parent.
 */
export function findParentPull(listing, headRef) {
  if (!Array.isArray(listing)) return undefined
  const candidate = listing.find((pull) => pull?.head?.ref === headRef)
  if (candidate === undefined) return undefined
  return {
    number: toCount(candidate.number),
    title: typeof candidate.title === 'string' ? candidate.title : '',
    state: candidate.state === 'closed' ? 'closed' : 'open',
    baseRefName: typeof candidate.base?.ref === 'string' ? candidate.base.ref : '',
    merged: candidate.merged_at !== null && candidate.merged_at !== undefined,
  }
}

/**
 * Assemble the contract's stack view from an ordered parent chain.
 * @param {{ baseRefName: string, declaredBase?: string, parents: Array<{ number: number, title: string, state: string, merged: boolean }> }} input - chain data.
 * @returns {{ baseRefName: string, declaredBase?: string, basePr?: { number: number, title: string, state: string }, chain: Array<{ number: number, title: string, state: string }>, allBaseMerged: boolean }} stack view.
 */
export function buildStack(input) {
  const chain = input.parents.map((parent) => ({ number: parent.number, title: parent.title, state: parent.state }))
  /** @type {{ baseRefName: string, declaredBase?: string, basePr?: { number: number, title: string, state: string }, chain: Array<{ number: number, title: string, state: string }>, allBaseMerged: boolean }} */
  const stack = {
    baseRefName: input.baseRefName,
    chain,
    allBaseMerged: input.parents.every((parent) => parent.merged === true),
  }
  if (input.declaredBase !== undefined) stack.declaredBase = input.declaredBase
  if (chain.length > 0) stack.basePr = chain[0]
  return stack
}

/**
 * Map one HTTP status to the stable error code.
 * @param {number} status - HTTP status.
 * @param {string | undefined} remaining - `x-ratelimit-remaining` header value.
 * @param {string | undefined} message - GitHub's message field.
 * @returns {string} stable error code.
 */
export function httpStatusToCode(status, remaining, message) {
  if (status === STATUS_LOGGED_OUT) return 'GH_NOT_LOGGED_IN'
  if (status === STATUS_FORBIDDEN) {
    return remaining === '0' || /rate limit/i.test(message ?? '') ? 'GH_RATE_LIMIT' : 'GH_FORBIDDEN'
  }
  if (status === STATUS_NOT_FOUND) return 'GH_NOT_FOUND'
  if (status === STATUS_RATE_LIMITED) return 'GH_RATE_LIMIT'
  if (status >= 500) return 'GH_NETWORK'
  return 'INTERNAL'
}

/**
 * Map `gh` subprocess stderr/exit metadata to the stable error code.
 * @param {string} stderr - subprocess stderr.
 * @param {{ exitCode?: number, missing?: boolean }} [options] - exit metadata.
 * @returns {string} stable error code.
 */
export function ghFailureCode(stderr, options = {}) {
  const text = String(stderr ?? '')
  if (options.missing === true) return 'GH_MISSING'
  if (/not logged into any GitHub hosts|gh auth login|authentication required|To get started with GitHub CLI/i.test(text)) return 'GH_NOT_LOGGED_IN'
  if (/HTTP 401|Bad credentials|Requires authentication/i.test(text)) return 'GH_NOT_LOGGED_IN'
  if (/HTTP 404|Not Found|Could not resolve to a PullRequest/i.test(text)) return 'GH_NOT_FOUND'
  if (/HTTP 429/.test(text)) return 'GH_RATE_LIMIT'
  if (/HTTP 403/.test(text)) return /rate limit|abuse|secondary rate/i.test(text) ? 'GH_RATE_LIMIT' : 'GH_FORBIDDEN'
  if (/HTTP 5\d\d|timed out|timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|network/i.test(text)) return 'GH_NETWORK'
  if (options.exitCode === 4) return 'GH_NOT_LOGGED_IN'
  if (options.exitCode === 1) return 'GH_NETWORK'
  return 'GH_NETWORK'
}

/**
 * Turn a failed `gh` subprocess into an AppError with a user-facing sentence.
 * @param {any} error - execFile rejection.
 * @returns {AppError} mapped failure.
 */
export function appErrorFromGh(error) {
  if (error?.code === 'ENOENT') return new AppError('GH_MISSING')
  if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR' || error?.killed === true || error?.signal === 'SIGTERM' || error?.code === 'ETIMEDOUT') {
    return new AppError('GH_TIMEOUT')
  }
  const stderr = typeof error?.stderr === 'string'
    ? error.stderr
    : Buffer.isBuffer(error?.stderr) ? error.stderr.toString('utf8') : ''
  const code = ghFailureCode(stderr, { exitCode: typeof error?.code === 'number' ? error.code : undefined })
  const firstLine = stderr.split(/\r?\n/).map((line) => line.trim()).find((line) => line !== '') ?? ''
  const message = firstLine === '' ? USER_MESSAGES[code] : `${USER_MESSAGES[code]}（${firstLine.slice(0, 300)}）`
  return new AppError(code, message, { cause: error })
}

/**
 * Turn a failed fetch into a user-facing AppError; aborts map to GH_TIMEOUT.
 * @param {any} error - fetch rejection.
 * @param {AbortSignal} [signal] - request signal.
 * @returns {AppError} mapped failure.
 */
export function appErrorFromNetwork(error, signal) {
  if (isAbortError(error, signal)) return new AppError('GH_TIMEOUT', undefined, { cause: error })
  const cause = error?.cause?.code ?? error?.code ?? error?.name
  const suffix = typeof cause === 'string' && cause !== '' ? `（${cause}）` : ''
  return new AppError('GH_NETWORK', `${USER_MESSAGES.GH_NETWORK}${suffix}`, { cause: error })
}

/**
 * Read one header from a `Headers` instance or a plain object.
 * @param {any} headers - response headers.
 * @param {string} name - header name.
 * @returns {string | undefined} the value.
 */
function headerValue(headers, name) {
  if (headers === undefined || headers === null) return undefined
  if (typeof headers.get === 'function') {
    const value = headers.get(name)
    return typeof value === 'string' ? value : undefined
  }
  const lowered = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== lowered) continue
    return Array.isArray(value) ? String(value[0]) : String(value)
  }
  return undefined
}

/**
 * Coerce an arbitrary count-ish value to a non-negative integer.
 * @param {unknown} value - candidate.
 * @returns {number} the count.
 */
function toCount(value) {
  const numeric = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : 0
}

/**
 * Split and validate `owner/name`.
 * @param {string} repo - repository spec.
 * @returns {[string, string]} owner and name.
 */
function splitRepo(repo) {
  if (typeof repo !== 'string' || !REPO_RE.test(repo)) {
    throw new AppError('BAD_REQUEST', 'repo 必须是 owner/name 形式')
  }
  const [owner, name] = repo.split('/')
  return [owner, name]
}

/**
 * Default pause between merge-guard retries; injectable so tests never sleep.
 * @param {number} ms - delay in milliseconds.
 * @returns {Promise<void>} resolves after the delay.
 */
function defaultSleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    if (typeof timer.unref === 'function') timer.unref()
  })
}

/**
 * GitHub data client. All terminals are injectable so tests exercise the
 * cache, transport and normalization without a network or a real `gh`.
 */
export class GitHubClient {
  /**
   * @param {{ config?: any, ghPath?: string, fetchImpl?: typeof fetch, execFileImpl?: Function, logger?: any, now?: () => number, sleep?: (ms: number) => Promise<void> }} [options] - wiring.
   */
  constructor(options = {}) {
    const config = options.config ?? {}
    /** Resolved plugin config (patch/body/timeout budgets). */
    this.config = config
    /** `gh` executable: config override, then GH_BIN, then PATH lookup. */
    this.ghPath = options.ghPath ?? config.ghPath ?? process.env.GH_BIN ?? 'gh'
    /** Injectable fetch (tests pass a stub). */
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
    /** Injectable async execFile (tests pass a stub). */
    this.execFileImpl = options.execFileImpl ?? execFileAsync
    /** Optional logger; never receives a token. */
    this.logger = options.logger
    /** Clock override for deterministic cache tests. */
    this.now = options.now ?? Date.now
    /** Merge-guard retry pause override (tests never sleep). */
    this.sleep = options.sleep ?? defaultSleep
    this.requestTimeoutMs = config.requestTimeoutMs ?? 15_000
    this.maxPatchChars = config.maxPatchChars ?? 24_000
    this.maxBodyChars = config.maxBodyChars ?? 50_000
    /** @type {LruCache} */
    this.cache = new LruCache(options.cacheMax ?? 200)
    /** @type {Map<string, Promise<unknown>>} */
    this.inflight = new Map()
    /** @type {Promise<{ token: string, source: string }> | undefined} */
    this.tokenPromise = undefined
    /** Signed-in login, cached for the life of the token. @type {Promise<string> | undefined} */
    this.viewerPromise = undefined
    /** @type {Promise<{ kind: 'fetch', token: string } | { kind: 'cli' }> | undefined} */
    this.transportPromise = undefined
    /** @type {{ value: string, expiresAt: number } | undefined} */
    this.healthCache = undefined
  }

  /**
   * Run one `gh` invocation asynchronously.
   * @param {string[]} args - argv (never shell-interpolated).
   * @param {{ signal?: AbortSignal }} [options] - abort signal.
   * @returns {Promise<{ stdout: string, stderr: string }>} captured output.
   */
  async runGh(args, options = {}) {
    try {
      const result = await this.execFileImpl(this.ghPath, args, {
        windowsHide: true,
        maxBuffer: MAX_GH_BUFFER,
        timeout: this.requestTimeoutMs,
        signal: options.signal,
        encoding: 'utf8',
      })
      return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
    } catch (error) {
      throw appErrorFromGh(error)
    }
  }

  /**
   * Resolve the access token once (env first, then `gh auth token`).
   * @returns {Promise<{ token: string, source: string }>} token in memory only.
   */
  async accessToken() {
    if (this.tokenPromise === undefined) {
      this.tokenPromise = this.loadToken().catch((error) => {
        this.tokenPromise = undefined
        throw error
      })
    }
    return this.tokenPromise
  }

  /**
   * @returns {Promise<{ token: string, source: string }>} a token from env or gh.
   */
  async loadToken() {
    for (const name of ['GH_TOKEN', 'GITHUB_TOKEN']) {
      const value = process.env[name]?.trim()
      if (value !== undefined && value !== '') return { token: value, source: 'env' }
    }
    const { stdout } = await this.runGh(['auth', 'token'])
    const token = String(stdout).trim()
    if (token === '') throw new AppError('GH_NOT_LOGGED_IN')
    return { token, source: 'gh' }
  }

  /** Drop the cached token so the next call re-reads it (401 recovery). */
  invalidateToken() {
    this.tokenPromise = undefined
    this.transportPromise = undefined
    this.viewerPromise = undefined
  }

  /**
   * Read the signed-in GitHub login once. Publish marker trust uses it so a
   * third party cannot redirect the rolling review by posting a marker.
   * @returns {Promise<string>} login, or '' when it cannot be resolved.
   */
  async getAuthenticatedUser() {
    if (this.viewerPromise === undefined) {
      this.viewerPromise = this.viewer().catch(() => '')
    }
    return this.viewerPromise
  }

  /**
   * @returns {Promise<string>} login of the token owner.
   */
  async viewer() {
    const transport = await this.transport()
    if (transport.kind === 'fetch') {
      const { data } = await this.fetchJson(transport.token, '/user')
      const login = typeof data?.login === 'string' ? data.login : ''
      if (login === '') throw new AppError('GH_NOT_LOGGED_IN')
      return login
    }
    const { data } = await this.cliJson('/user')
    const login = typeof data?.login === 'string' ? data.login : ''
    if (login === '') throw new AppError('GH_NOT_LOGGED_IN')
    return login
  }

  /**
   * Health probe: whether GitHub CLI credentials are usable.
   * @returns {Promise<'ok' | 'not-logged-in' | 'missing'>} gh channel state.
   */
  async ghStatus() {
    const now = this.now()
    if (this.healthCache !== undefined && this.healthCache.expiresAt > now) return this.healthCache.value
    /** @type {'ok' | 'not-logged-in' | 'missing'} */
    let value
    try {
      const info = await this.accessToken()
      value = info.token === '' ? 'not-logged-in' : 'ok'
    } catch (error) {
      value = error instanceof AppError && error.code === 'GH_MISSING' ? 'missing' : 'not-logged-in'
    }
    this.healthCache = { value, expiresAt: now + HEALTH_TTL_MS }
    return value
  }

  /**
   * Choose the request transport once per process.
   * @returns {Promise<{ kind: 'fetch', token: string } | { kind: 'cli' }>} transport.
   */
  async transport() {
    if (this.transportPromise === undefined) {
      this.transportPromise = (async () => {
        try {
          const info = await this.accessToken()
          return { kind: 'fetch', token: info.token }
        } catch (error) {
          if (error instanceof AppError && error.code === 'GH_MISSING') throw error
          return { kind: 'cli' }
        }
      })().catch((error) => {
        this.transportPromise = undefined
        throw error
      })
    }
    return this.transportPromise
  }

  /**
   * Call one REST endpoint and parse JSON, retrying a 401 once after a token
   * refresh and falling back to the gh CLI when no token is available.
   * Writes (`method !== 'GET'`) travel the same transports and are never cached.
   * @param {string} path - REST path beginning with `/`.
   * @param {{ accept?: string, signal?: AbortSignal, method?: string, body?: Record<string, unknown> }} [options] - request knobs.
   * @returns {Promise<{ data: any, headers: any }>} parsed body and headers.
   */
  async requestJson(path, options = {}) {
    const transport = await this.transport()
    if (transport.kind === 'fetch') {
      try {
        return await this.fetchJson(transport.token, path, options)
      } catch (error) {
        if (error instanceof AppError && error.code === 'GH_NOT_LOGGED_IN') {
          this.invalidateToken()
          const retried = await this.transport()
          if (retried.kind === 'fetch') return this.fetchJson(retried.token, path, options)
          return this.cliJson(path, options)
        }
        throw error
      }
    }
    return this.cliJson(path, options)
  }

  /**
   * Primary transport: authenticated Node fetch. GET reads and JSON writes
   * share one implementation; non-2xx answers carry the HTTP status in
   * `AppError#details` so feature layers can map it (e.g. merge 405/409).
   * @param {string} token - access token.
   * @param {string} path - REST path.
   * @param {{ accept?: string, signal?: AbortSignal, method?: string, body?: Record<string, unknown> }} [options] - request knobs.
   * @returns {Promise<{ data: any, headers: any }>} parsed body and headers.
   */
  async fetchJson(token, path, options = {}) {
    const url = path.startsWith('http') ? path : API_BASE_URL + path
    const method = typeof options.method === 'string' && options.method !== '' ? options.method.toUpperCase() : 'GET'
    const hasBody = options.body !== undefined && options.body !== null
    /** @type {Record<string, string>} */
    const headers = {
      accept: options.accept ?? 'application/vnd.github+json',
      'accept-encoding': 'identity',
      'user-agent': USER_AGENT,
      'x-github-api-version': GITHUB_API_VERSION,
      authorization: `Bearer ${token}`,
    }
    if (hasBody) headers['content-type'] = 'application/json'
    /** @type {any} */
    let response
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        redirect: 'follow',
        signal: options.signal,
        ...(hasBody ? { body: JSON.stringify(options.body) } : {}),
      })
    } catch (error) {
      throw appErrorFromNetwork(error, options.signal)
    }
    if (response.ok !== true) {
      let text = ''
      try {
        text = await response.text()
      } catch {
        // body already gone; the status still maps the failure
      }
      let message = ''
      /** @type {unknown} */
      let errors
      try {
        const parsed = JSON.parse(text)
        if (typeof parsed?.message === 'string') message = parsed.message
        if (Array.isArray(parsed?.errors)) errors = parsed.errors
      } catch {
        // non-JSON error body
      }
      const code = httpStatusToCode(response.status, headerValue(response.headers, 'x-ratelimit-remaining'), message)
      const suffix = message === '' ? '' : `（GitHub: ${message.slice(0, 200)}）`
      throw new AppError(code, `${USER_MESSAGES[code]}${suffix}`, { details: { status: response.status, errors } })
    }
    let text
    try {
      text = await response.text()
    } catch (error) {
      throw appErrorFromNetwork(error, options.signal)
    }
    if (text.trim() === '') return { data: null, headers: response.headers }
    try {
      return { data: JSON.parse(text), headers: response.headers }
    } catch {
      throw new AppError('GH_NETWORK', 'GitHub 返回了无法解析的响应内容')
    }
  }

  /**
   * Fallback transport: `gh api` through the async subprocess seam. Plain
   * scalar writes pass `--method` plus `-f key=value` fields; writes whose body
   * contains arrays/objects (e.g. review comments) are serialized to a temp JSON
   * file and passed via `--input`, because `-f` cannot express nested values.
   * @param {string} path - REST path.
   * @param {{ accept?: string, signal?: AbortSignal, method?: string, body?: Record<string, unknown> }} [options] - request knobs.
   * @returns {Promise<{ data: any, headers: undefined }>} parsed body.
   */
  async cliJson(path, options = {}) {
    const endpoint = path.replace(/^\//, '')
    const args = ['api', endpoint]
    const method = typeof options.method === 'string' && options.method !== '' ? options.method.toUpperCase() : 'GET'
    if (method !== 'GET') args.push('--method', method)
    if (options.accept !== undefined) args.push('-H', `Accept: ${options.accept}`)
    /** @type {string | undefined} */
    let inputPath
    try {
      if (options.body !== undefined && options.body !== null && typeof options.body === 'object') {
        const entries = Object.entries(options.body).filter(([, value]) => value !== undefined && value !== null)
        const structured = entries.some(([, value]) => typeof value === 'object')
        if (structured) {
          inputPath = join(tmpdir(), `dsh-codex-review-gh-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
          writeFileSync(inputPath, JSON.stringify(options.body), 'utf8')
          args.push('--input', inputPath)
        } else {
          for (const [key, value] of entries) args.push('-f', `${key}=${String(value)}`)
        }
      }
      const { stdout } = await this.runGh(args, { signal: options.signal })
      const text = stdout.trim()
      if (text === '') return { data: null, headers: undefined }
      try {
        return { data: JSON.parse(text), headers: undefined }
      } catch {
        throw new AppError('GH_NETWORK', 'gh 返回了无法解析的 JSON 输出')
      }
    } finally {
      if (inputPath !== undefined) {
        try {
          rmSync(inputPath, { force: true })
        } catch {
          // a leftover temp file is harmless; the OS cleans it up
        }
      }
    }
  }

  /**
   * De-duplicate concurrent work for one cache key.
   * @param {string} key - in-flight key.
   * @param {() => Promise<any>} factory - work to run once.
   * @returns {Promise<any>} shared result.
   */
  async once(key, factory) {
    const running = this.inflight.get(key)
    if (running !== undefined) return running
    const promise = Promise.resolve().then(factory).finally(() => {
      this.inflight.delete(key)
    })
    this.inflight.set(key, promise)
    return promise
  }

  /**
   * Search open PRs (`search/issues`) normalized to {@link PrSummary}.
   * @param {{ query?: string, limit?: number }} [input] - search parameters.
   * @returns {Promise<{ query: string, totalCount: number, items: any[] }>} search page.
   */
  async listPullRequests(input = {}) {
    const query = typeof input.query === 'string' && input.query.trim() !== '' ? input.query.trim() : 'is:open author:@me'
    const limit = Number.isFinite(input.limit) ? Math.min(100, Math.max(1, Math.floor(Number(input.limit)))) : 30
    const key = `list:${query}|${limit}`
    const cached = this.cache.get(key, this.now())
    if (cached !== undefined) return cached
    return this.once(key, async () => {
      const qualified = /\bis:pr\b/i.test(query) ? query : `${query} is:pr`
      const { data } = await this.requestJson(`/search/issues?q=${encodeURIComponent(qualified)}&per_page=${limit}&sort=updated&order=desc`)
      const items = Array.isArray(data?.items) ? data.items.map(normalizeSearchItem).filter((item) => item !== null) : []
      const value = {
        query,
        totalCount: Number.isFinite(data?.total_count) ? data.total_count : items.length,
        items,
      }
      this.cache.set(key, value, LIST_TTL_MS, this.now())
      return value
    })
  }

  /**
   * Load one PR detail (contract shape minus the review overlay).
   * @param {string} repo - `owner/name`.
   * @param {number} number - PR number.
   * @returns {Promise<any>} normalized detail with `headSha`.
   */
  async getPull(repo, number) {
    const key = `pr:${repo}#${number}`
    const cached = this.cache.get(key, this.now())
    if (cached !== undefined) return cached
    return this.once(key, async () => {
      const detail = await this.loadPull(repo, number)
      this.cache.set(key, detail, DETAIL_TTL_MS, this.now())
      return detail
    })
  }

  /**
   * Read the PR's current head commit **without** the detail cache: a publish
   * must target the head that is on GitHub right now, not a 60 s old snapshot.
   * @param {string} repo - `owner/name`.
   * @param {number} number - PR number.
   * @param {{ signal?: AbortSignal }} [options] - request signal.
   * @returns {Promise<string>} current head SHA, or '' when unavailable.
   * @throws {AppError} GH_* when the request fails.
   */
  async getPullHead(repo, number, options = {}) {
    const [owner, name] = splitRepo(repo)
    const { data } = await this.requestJson(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${number}`, { signal: options.signal })
    return typeof data?.head?.sha === 'string' ? data.head.sha : ''
  }

  /**
   * Read the repository's review guidelines (CONTRACT §4.4): `AGENTS.md` and
   * `.github/AGENTS.md`, preferring the former and capping the injected text at
   * {@link GUIDELINE_MAX_CHARS} characters in total (each file is read at that
   * same cap, and the second file only fills the remaining budget). Cached per
   * repository for ten minutes. Any failure (missing file, permissions,
   * network) degrades to "no guidelines" and never blocks a review.
   * @param {string} repo - `owner/name`.
   * @param {{ signal?: AbortSignal }} [options] - request signal (route deadline).
   * @returns {Promise<{ loaded: boolean, files: string[], chars: number, text: string }>} guidelines plus the text to inject.
   */
  async getGuidelines(repo, options = {}) {
    const [owner, name] = splitRepo(repo)
    const key = `guidelines:${repo}`
    const cached = this.cache.get(key, this.now())
    if (cached !== undefined) return cached
    return this.once(key, async () => {
      /** @type {string[]} */
      const files = []
      /** @type {string[]} */
      const parts = []
      let remaining = GUIDELINE_MAX_CHARS
      for (const path of GUIDELINE_PATHS) {
        if (remaining <= 0) break
        const endpoint = path.split('/').map((segment) => encodeURIComponent(segment)).join('/')
        /** @type {string} */
        let text
        try {
          const { data } = await this.requestJson(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/contents/${endpoint}`, { signal: options.signal })
          text = decodeContentsPayload(data)
        } catch (error) {
          // A repository without AGENTS.md answers 404: the normal case. Other
          // failures are logged but equally non-blocking.
          if (!(error instanceof AppError && error.code === 'GH_NOT_FOUND')) {
            this.logger?.warn?.(`dsh-codex-review: could not read ${repo}/${path}: ${error?.message ?? error}`)
          }
          continue
        }
        const bounded = truncateText(text.trim(), Math.min(GUIDELINE_MAX_CHARS, remaining))
        if (bounded.text === '') continue
        files.push(path)
        parts.push(bounded.text)
        remaining -= bounded.text.length
      }
      const value = {
        loaded: files.length > 0,
        files,
        chars: parts.reduce((sum, part) => sum + part.length, 0),
        text: parts.join('\n\n'),
      }
      // A deadline-aborted lookup is not evidence that the repository has no
      // guidelines: answer empty now but let the next call retry.
      if (options.signal?.aborted !== true) this.cache.set(key, value, GUIDELINE_TTL_MS, this.now())
      return value
    })
  }

  /**
   * Read one PR from the REST API **without** the detail cache: the merge
   * guards must see the current state, head SHA and GitHub-computed
   * `mergeable`/`mergeable_state`, so a cached snapshot is worthless here.
   * @param {string} repo - `owner/name`.
   * @param {number} number - PR number.
   * @returns {Promise<any>} raw REST pull body.
   * @throws {AppError} GH_NOT_FOUND when GitHub answers with no object.
   */
  async loadPullForMerge(repo, number) {
    const [owner, name] = splitRepo(repo)
    const { data } = await this.requestJson(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${number}`)
    if (data === null || typeof data !== 'object') throw new AppError('GH_NOT_FOUND')
    return data
  }

  /**
   * Merge one PR under the seven CONTRACT §5.1 guards:
   * confirm → open/non-draft → head SHA unchanged → mergeable (retrying
   * twice while GitHub computes it) → `PUT .../merge` → optional branch delete
   * (a failure there never invalidates the merge) → cache invalidation.
   * The caller (route) performs the user-confirmation check as well.
   * @param {{ repo: string, number: number, method: 'merge' | 'squash' | 'rebase', expectedHeadSha: string, commitTitle?: string, commitMessage?: string, deleteBranch?: boolean, confirm?: boolean }} input - merge request.
   * @returns {Promise<{ merged: true, sha: string, message: string, branchDeleted?: boolean, branchWarning?: string }>} merge result.
   * @throws {AppError} BAD_REQUEST / MERGE_NOT_ALLOWED / MERGE_HEAD_MOVED / MERGE_CONFLICT / GH_*.
   */
  async mergePull(input = {}) {
    if (input?.confirm !== true) throw new AppError('BAD_REQUEST', '合并操作需要 confirm: true')
    const repo = typeof input.repo === 'string' ? input.repo.trim() : ''
    const [owner, name] = splitRepo(repo)
    const number = typeof input.number === 'number' ? input.number : Number(input.number)
    if (!Number.isInteger(number) || number <= 0) throw new AppError('BAD_REQUEST', 'number 必须是正整数')
    const method = typeof input.method === 'string' ? input.method.trim().toLowerCase() : ''
    if (!MERGE_METHODS.includes(method)) throw new AppError('BAD_REQUEST', 'method 必须是 merge|squash|rebase')
    const expectedHeadSha = typeof input.expectedHeadSha === 'string' ? input.expectedHeadSha.trim() : ''
    if (expectedHeadSha === '') throw new AppError('BAD_REQUEST', '缺少 expectedHeadSha')
    const commitTitle = normalizeOptionalCommitField(input.commitTitle, MERGE_COMMIT_TITLE_MAX_CHARS, 'commitTitle')
    const commitMessage = normalizeOptionalCommitField(input.commitMessage, MERGE_COMMIT_MESSAGE_MAX_CHARS, 'commitMessage')
    const deleteBranch = input.deleteBranch === true

    /**
     * Guards 2 and 3 for one freshly read PR.
     * @param {any} pull - raw REST pull body.
     * @returns {void}
     */
    const assertMergeableSnapshot = (pull) => {
      const merged = pull.merged === true || (pull.merged_at !== null && pull.merged_at !== undefined)
      if (pull.state !== 'open' || merged) {
        throw new AppError('MERGE_NOT_ALLOWED', merged ? '该 PR 已合并，无法再次合并' : '该 PR 已关闭，无法合并')
      }
      if (pull.draft === true) throw new AppError('MERGE_NOT_ALLOWED', '草稿 PR 不能合并，请先标记为可合并')
      const currentHead = typeof pull.head?.sha === 'string' ? pull.head.sha : ''
      if (currentHead === '' || currentHead !== expectedHeadSha) {
        throw new AppError('MERGE_HEAD_MOVED', `PR 已有新提交（当前 head ${currentHead.slice(0, 12) || 'unknown'}），请刷新后重试`)
      }
    }

    let pull = await this.loadPullForMerge(repo, number)
    assertMergeableSnapshot(pull)
    let mergeable = pull.mergeable
    for (let attempt = 0; mergeable === null && attempt < MERGE_RETRY_MAX; attempt += 1) {
      await this.sleep(MERGE_RETRY_DELAY_MS)
      pull = await this.loadPullForMerge(repo, number)
      assertMergeableSnapshot(pull)
      mergeable = pull.mergeable
    }
    if (mergeable === false) throw new AppError('MERGE_CONFLICT')
    if (mergeable !== true) {
      // GitHub still had not computed `mergeable`: fall back to `mergeable_state`.
      const mergeState = String(pull.mergeable_state ?? pull.merge_state_status ?? pull.mergeStateStatus ?? '').toUpperCase()
      if (mergeState === 'DIRTY') throw new AppError('MERGE_CONFLICT')
      if (!MERGE_ALLOWED_STATES.includes(mergeState)) {
        throw new AppError('MERGE_NOT_ALLOWED', `${USER_MESSAGES.MERGE_NOT_ALLOWED}（mergeable_state=${mergeState || 'unknown'}）`)
      }
    }

    /** @type {{ merge_method: string, sha: string, commit_title?: string, commit_message?: string }} */
    const mergeBody = { merge_method: method, sha: expectedHeadSha }
    if (commitTitle !== undefined) mergeBody.commit_title = commitTitle
    if (commitMessage !== undefined) mergeBody.commit_message = commitMessage
    /** @type {any} */
    let data
    try {
      const response = await this.requestJson(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${number}/merge`, {
        method: 'PUT',
        body: mergeBody,
      })
      data = response.data ?? {}
    } catch (error) {
      throw mapMergeWriteError(error)
    }
    if (data.merged !== true) {
      throw new AppError('MERGE_NOT_ALLOWED', typeof data.message === 'string' && data.message !== '' ? data.message : USER_MESSAGES.MERGE_NOT_ALLOWED)
    }
    const sha = typeof data.sha === 'string' ? data.sha : ''
    const message = typeof data.message === 'string' && data.message !== '' ? data.message : '合并成功'
    /** @type {{ merged: true, sha: string, message: string, branchDeleted?: boolean, branchWarning?: string }} */
    const result = { merged: true, sha, message }

    if (deleteBranch) {
      const headRef = typeof pull.head?.ref === 'string' ? pull.head.ref : ''
      const headRepo = typeof pull.head?.repo?.full_name === 'string' ? pull.head.repo.full_name : ''
      const sameRepo = headRepo !== '' && headRepo.toLowerCase() === repo.toLowerCase()
      if (headRef !== '' && sameRepo) {
        const refPath = headRef.split('/').map((segment) => encodeURIComponent(segment)).join('/')
        try {
          await this.requestJson(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/git/refs/heads/${refPath}`, { method: 'DELETE' })
          result.branchDeleted = true
        } catch (error) {
          // A protected/already-deleted branch must not turn a successful merge
          // into a failure: report the degradation instead.
          result.branchDeleted = false
          result.branchWarning = `源分支删除失败：${error instanceof AppError ? error.message : USER_MESSAGES.INTERNAL}`
        }
      } else {
        result.branchDeleted = false
        result.branchWarning = '源分支不在本仓库（fork）或未知，未删除'
      }
    }

    this.invalidatePullCache(repo, number)
    return result
  }

  /**
   * Drop every cached view that a successful merge invalidates: the PR detail
   * and its file/check entries (the head commit is no longer the branch head).
   * Review jobs are invalidated by the route through the engine.
   * @param {string} repo - `owner/name`.
   * @param {number} number - PR number.
   * @returns {number} number of cache entries removed.
   */
  invalidatePullCache(repo, number) {
    const [owner, name] = splitRepo(repo)
    let removed = this.cache.delete(`pr:${repo}#${number}`) ? 1 : 0
    const filePrefix = `files:${owner}/${name}#${number}@`
    const checksPrefix = `checks:${owner}/${name}@`
    for (const key of [...this.cache.entries.keys()]) {
      // The PR list also changes when a PR leaves the open set.
      if (key.startsWith(filePrefix) || key.startsWith(checksPrefix) || key.startsWith('list:')) {
        this.cache.delete(key)
        removed += 1
      }
    }
    return removed
  }

  /**
   * Build the bounded PR-chat context (CONTRACT §5.2) from an already-loaded
   * detail snapshot plus the latest review snapshot. Used by the chat route; the
   * pure rendering/budgeting lives in `lib/chat.js`.
   * @param {{ repo?: string, number?: number, detail?: any, review?: any, focusFile?: string, messages?: Array<{ role: 'user' | 'assistant', content: string }> }} input - chat context input.
   * @returns {Promise<{ system: string, messages: Array<{ role: 'user' | 'assistant', content: string }>, stats: { systemChars: number, historyChars: number, totalChars: number } }>} model-ready context.
   */
  async chatContext(input = {}) {
    const detail = input.detail ?? await this.getPull(input.repo, input.number)
    return buildChatContext({
      detail,
      review: input.review,
      focusFile: input.focusFile,
      messages: input.messages,
    })
  }

  /**
   * Publish one GitHub PR review with `event: 'COMMENT'` (CONTRACT §7.2):
   * an optional summary body plus inline comments anchored on the RIGHT side.
   * Never cached — a write must reach GitHub. A 422 (e.g. a line outside the
   * diff) is reported as BAD_REQUEST with GitHub's reason.
   * @param {{ repo: string, number: number, headSha?: string, body?: string, comments?: Array<{ path: string, line: number, side?: string, body: string }>, signal?: AbortSignal }} input - review to publish.
   * @returns {Promise<{ reviewId: number, url: string, data: any }>} created review identity.
   * @throws {AppError} GH_FORBIDDEN / GH_NOT_FOUND / GH_RATE_LIMIT / GH_NETWORK / BAD_REQUEST / INTERNAL.
   */
  async createPullReview(input = {}) {
    const [owner, name] = splitRepo(input.repo)
    const number = typeof input.number === 'number' ? input.number : Number(input.number)
    if (!Number.isInteger(number) || number <= 0) throw new AppError('BAD_REQUEST', 'number 必须是正整数')
    /** @type {Array<{ path: string, line: number, side: string, body: string }>} */
    const comments = []
    for (const comment of Array.isArray(input.comments) ? input.comments : []) {
      if (comment === null || typeof comment !== 'object') continue
      const path = typeof comment.path === 'string' ? comment.path : ''
      const line = typeof comment.line === 'number' ? comment.line : Number(comment.line)
      const body = typeof comment.body === 'string' ? comment.body : ''
      if (path === '' || !Number.isInteger(line) || line <= 0 || body === '') continue
      comments.push({ path, line, side: typeof comment.side === 'string' && comment.side !== '' ? comment.side : 'RIGHT', body })
    }
    /** @type {Record<string, unknown>} */
    const payload = { event: 'COMMENT' }
    if (typeof input.body === 'string' && input.body !== '') payload.body = input.body
    if (comments.length > 0) payload.comments = comments
    if (typeof input.headSha === 'string' && input.headSha !== '') payload.commit_id = input.headSha
    if (payload.body === undefined && payload.comments === undefined) {
      throw new AppError('BAD_REQUEST', '没有可发布的审查内容')
    }
    /** @type {any} */
    let data
    try {
      const response = await this.requestJson(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${number}/reviews`, {
        method: 'POST',
        body: payload,
        signal: input.signal,
      })
      data = response.data !== null && typeof response.data === 'object' ? response.data : {}
    } catch (error) {
      throw mapReviewWriteError(error)
    }
    // A published review adds inline comments: drop the cached detail so the
    // next /pr read shows them immediately instead of after the 60 s TTL.
    this.invalidatePullCache(input.repo, number)
    const reviewId = Number(data.id)
    return {
      reviewId: Number.isFinite(reviewId) && reviewId > 0 ? reviewId : 0,
      url: typeof data.html_url === 'string' ? data.html_url : '',
      data,
    }
  }

  /**
   * Update the body of a submitted review created by this token (CONTRACT §7.2).
   * GitHub keeps the review id, so the PR timeline does not gain a new review
   * per commit; only the summary body is replaced. Inline comments are immutable
   * after submission and therefore never touched here.
   * @param {{ repo: string, number: number, reviewId: number, body: string, signal?: AbortSignal }} input - review identity and new body.
   * @returns {Promise<{ reviewId: number, url: string }>} updated review identity.
   * @throws {AppError} BAD_REQUEST / GH_FORBIDDEN / GH_NOT_FOUND / GH_RATE_LIMIT / GH_NETWORK / INTERNAL.
   */
  async updatePullReview(input = {}) {
    const [owner, name] = splitRepo(input.repo)
    const number = typeof input.number === 'number' ? input.number : Number(input.number)
    if (!Number.isInteger(number) || number <= 0) throw new AppError('BAD_REQUEST', 'number 必须是正整数')
    const reviewId = typeof input.reviewId === 'number' ? input.reviewId : Number(input.reviewId)
    if (!Number.isInteger(reviewId) || reviewId <= 0) throw new AppError('BAD_REQUEST', 'reviewId 必须是正整数')
    const body = typeof input.body === 'string' ? input.body : ''
    if (body.trim() === '') throw new AppError('BAD_REQUEST', '没有可更新的审查内容')
    /** @type {any} */
    let data
    try {
      const response = await this.requestJson(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${number}/reviews/${reviewId}`, {
        method: 'PUT',
        body: { body },
        signal: input.signal,
      })
      data = response.data !== null && typeof response.data === 'object' ? response.data : {}
    } catch (error) {
      throw mapReviewWriteError(error)
    }
    this.invalidatePullCache(input.repo, number)
    return {
      reviewId,
      url: typeof data.html_url === 'string' ? data.html_url : '',
    }
  }

  /**
   * List the PR's submitted reviews (uncached, paginated). Used after a Host
   * restart lost the persisted publish identity: the rolling summary review is
   * found by its hidden marker instead of creating a duplicate (CONTRACT §7.2).
   * @param {string} repo - `owner/name`.
   * @param {number} number - PR number.
   * @param {{ signal?: AbortSignal }} [options] - request signal.
   * @returns {Promise<Array<{ id: number | null, body: string, url: string, author: string, state: string, submittedAt: string }>>} normalized reviews.
   */
  async listPullReviews(repo, number, options = {}) {
    const [owner, name] = splitRepo(repo)
    const numeric = typeof number === 'number' ? number : Number(number)
    if (!Number.isInteger(numeric) || numeric <= 0) throw new AppError('BAD_REQUEST', 'number 必须是正整数')
    /** @type {Array<{ id: number | null, body: string, url: string, author: string, state: string, submittedAt: string }>} */
    const reviews = []
    for (let page = 1; page <= MAX_REVIEW_PAGES; page += 1) {
      const { data } = await this.requestJson(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${numeric}/reviews?per_page=${REVIEW_PAGE_SIZE}&page=${page}`, { signal: options.signal })
      const batch = Array.isArray(data) ? data : []
      for (const review of batch) {
        reviews.push({
          id: Number.isInteger(review?.id) ? review.id : null,
          body: typeof review?.body === 'string' ? review.body : '',
          url: typeof review?.html_url === 'string' ? review.html_url : '',
          author: review?.user?.login ?? 'ghost',
          state: typeof review?.state === 'string' ? review.state : 'COMMENTED',
          submittedAt: typeof review?.submitted_at === 'string' ? review.submitted_at : '',
        })
      }
      if (batch.length < REVIEW_PAGE_SIZE) break
    }
    return reviews
  }

  /**
   * List the PR's existing inline review comments (all authors, paginated) so a
   * publish can skip findings whose marker already exists. This read is
   * deliberately uncached: it runs right after a write.
   * @param {string} repo - `owner/name`.
   * @param {number} number - PR number.
   * @param {{ signal?: AbortSignal }} [options] - request signal.
   * @returns {Promise<Array<{ path: string, line: number | null, body: string, author: string, createdAt: string }>>} normalized comments.
   */
  async listPullReviewComments(repo, number, options = {}) {
    const [owner, name] = splitRepo(repo)
    const numeric = typeof number === 'number' ? number : Number(number)
    if (!Number.isInteger(numeric) || numeric <= 0) throw new AppError('BAD_REQUEST', 'number 必须是正整数')
    /** @type {Array<{ path: string, line: number | null, body: string, author: string, createdAt: string }>} */
    const comments = []
    for (let page = 1; page <= MAX_REVIEW_COMMENT_PAGES; page += 1) {
      const { data } = await this.requestJson(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${numeric}/comments?per_page=${REVIEW_COMMENT_PAGE_SIZE}&page=${page}`, { signal: options.signal })
      const batch = Array.isArray(data) ? data : []
      for (const comment of batch) {
        comments.push({
          path: typeof comment?.path === 'string' ? comment.path : '',
          line: Number.isInteger(comment?.line) ? comment.line : Number.isInteger(comment?.original_line) ? comment.original_line : null,
          body: typeof comment?.body === 'string' ? comment.body : '',
          author: typeof comment?.user?.login === 'string' ? comment.user.login : 'ghost',
          createdAt: typeof comment?.created_at === 'string' ? comment.created_at : '',
        })
      }
      if (batch.length < REVIEW_COMMENT_PAGE_SIZE) break
    }
    return comments
  }

  /**
   * Run one GraphQL document through the same token transport (falls back to
   * `gh api graphql`). GitHub GraphQL answers HTTP 200 even for a rejected
   * operation, so an `errors` array is mapped to a stable code.
   * @param {string} query - GraphQL document.
   * @param {Record<string, unknown>} [variables] - operation variables.
   * @returns {Promise<any>} the `data` payload.
   * @throws {AppError} GH_FORBIDDEN / GH_NOT_FOUND / GH_NETWORK.
   */
  async graphql(query, variables = {}) {
    const transport = await this.transport()
    if (transport.kind === 'fetch') {
      const { data } = await this.fetchJson(transport.token, '/graphql', { method: 'POST', body: { query, variables } })
      if (Array.isArray(data?.errors) && data.errors.length > 0) throw graphqlError(data.errors)
      return data?.data
    }
    const { stdout } = await this.runGh(['api', 'graphql', '-f', `query=${query}`, '-f', `variables=${JSON.stringify(variables)}`])
    /** @type {any} */
    let parsed
    try {
      parsed = JSON.parse(stdout)
    } catch {
      throw new AppError('GH_NETWORK', 'GitHub 返回了无法解析的响应内容')
    }
    if (Array.isArray(parsed?.errors) && parsed.errors.length > 0) throw graphqlError(parsed.errors)
    return parsed?.data
  }

  /**
   * Read the PR's review threads so every inline comment knows its thread id
   * and resolved state (resolving a discussion is GraphQL-only; a failed
   * lookup simply leaves the resolve action out of the UI).
   * @param {string} owner - repository owner.
   * @param {string} name - repository name.
   * @param {number} number - PR number.
   * @returns {Promise<Record<number, { threadId: string, isResolved: boolean }>>} comment database id → thread.
   */
  async loadReviewThreads(owner, name, number) {
    const data = await this.graphql(
      `query ReviewThreads($owner: String!, $name: String!, $number: Int!) {
        repository(owner: $owner, name: $name) {
          pullRequest(number: $number) {
            reviewThreads(first: 100) {
              nodes { id isResolved comments(first: 100) { nodes { databaseId } } }
            }
          }
        }
      }`,
      { owner, name, number },
    )
    /** @type {Record<number, { threadId: string, isResolved: boolean }>} */
    const map = {}
    const threads = data?.repository?.pullRequest?.reviewThreads?.nodes
    for (const thread of Array.isArray(threads) ? threads : []) {
      const threadId = typeof thread?.id === 'string' ? thread.id : ''
      if (threadId === '') continue
      const nodes = thread?.comments?.nodes
      for (const node of Array.isArray(nodes) ? nodes : []) {
        const databaseId = Number(node?.databaseId)
        if (!Number.isInteger(databaseId) || databaseId <= 0) continue
        map[databaseId] = { threadId, isResolved: thread?.isResolved === true }
      }
    }
    return map
  }

  /**
   * Post one PR conversation comment (issue comment, CONTRACT §8).
   * @param {{ repo: string, number: number, body: string }} input - write request.
   * @returns {Promise<{ id: number, url: string, createdAt: string }>} created comment.
   * @throws {AppError} GH_* / BAD_REQUEST.
   */
  async createIssueComment(input = {}) {
    const [owner, name] = splitRepo(input.repo)
    const number = requirePositiveNumber(input.number, 'number')
    const body = normalizeCommentBody(input.body)
    const { data } = await this.requestJson(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${number}/comments`, {
      method: 'POST',
      body: { body },
    })
    this.invalidatePullCache(input.repo, number)
    return normalizeCreatedComment(data)
  }

  /**
   * Reply to one existing inline review comment (CONTRACT §8).
   * @param {{ repo: string, number: number, commentId: number, body: string }} input - write request.
   * @returns {Promise<{ id: number, url: string, createdAt: string }>} created comment.
   * @throws {AppError} GH_* / BAD_REQUEST.
   */
  async replyToReviewComment(input = {}) {
    const [owner, name] = splitRepo(input.repo)
    const number = requirePositiveNumber(input.number, 'number')
    const commentId = requirePositiveNumber(input.commentId, 'commentId')
    const body = normalizeCommentBody(input.body)
    const { data } = await this.requestJson(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${number}/comments/${commentId}/replies`, {
      method: 'POST',
      body: { body },
    })
    this.invalidatePullCache(input.repo, number)
    return normalizeCreatedComment(data)
  }

  /**
   * Resolve one review thread (GraphQL `resolveReviewThread`, CONTRACT §8).
   * @param {{ repo: string, number: number, threadId: string }} input - write request.
   * @returns {Promise<{ resolved: boolean }>} whether the thread is resolved.
   * @throws {AppError} GH_* / BAD_REQUEST.
   */
  async resolveReviewThread(input = {}) {
    splitRepo(input.repo)
    const number = requirePositiveNumber(input.number, 'number')
    const threadId = typeof input.threadId === 'string' ? input.threadId.trim() : ''
    if (threadId === '' || threadId.length > 200) throw new AppError('BAD_REQUEST', 'threadId 不合法')
    const data = await this.graphql(
      `mutation ResolveThread($threadId: ID!) {
        resolveReviewThread(input: { threadId: $threadId }) { thread { id isResolved } }
      }`,
      { threadId },
    )
    this.invalidatePullCache(input.repo, number)
    return { resolved: data?.resolveReviewThread?.thread?.isResolved === true }
  }

  /**
   * Fetch and normalize every part of one PR.
   * @param {string} repo - `owner/name`.
   * @param {number} number - PR number.
   * @returns {Promise<any>} contract detail object.
   */
  async loadPull(repo, number) {
    const [owner, name] = splitRepo(repo)
    const { data: pull } = await this.requestJson(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${number}`)
    if (pull === null || typeof pull !== 'object') throw new AppError('GH_NOT_FOUND')
    const headSha = typeof pull?.head?.sha === 'string' ? pull.head.sha : ''
    const baseRefName = typeof pull?.base?.ref === 'string' ? pull.base.ref : ''
    const results = await Promise.allSettled([
      this.loadFiles(owner, name, number, headSha),
      this.loadIssueComments(owner, name, number),
      this.loadReviews(owner, name, number),
      this.loadInlineComments(owner, name, number),
      this.loadChecks(owner, name, headSha),
      this.loadStack(owner, name, baseRefName, pull?.body),
      this.loadReviewThreads(owner, name, number),
    ])
    const files = settled(results[0], { files: [], filesTruncated: false })
    const issueComments = settled(results[1], [])
    const reviews = settled(results[2], [])
    const inline = settled(results[3], [])
    const checks = settled(results[4], { state: 'unknown', items: [] })
    const stack = settled(results[5], buildStack({ baseRefName, parents: [] }))
    // Thread ids come from GraphQL only; resolving a discussion is impossible
    // over REST. A failed lookup degrades to comments without resolve buttons.
    const threads = settled(results[6], {})
    const inlineWithThreads = inline.map((comment) => {
      const thread = comment.id === null || comment.id === undefined ? undefined : threads[comment.id]
      if (thread === undefined) return comment
      return { ...comment, threadId: thread.threadId, isResolved: thread.isResolved }
    })
    const body = truncateText(pull?.body, this.maxBodyChars)
    const summary = normalizePullSummary(pull, repo, number)
    const totalComments = (toCount(pull?.comments) + toCount(pull?.review_comments))
    return {
      headSha,
      summary,
      body: body.text,
      bodyTruncated: body.truncated,
      files: files.files,
      filesTruncated: files.filesTruncated,
      comments: { total: totalComments, issue: issueComments, reviews, inline: inlineWithThreads },
      checks,
      stack,
    }
  }

  /**
   * Pull-request files with per-file patch, cached by head SHA for 30 minutes.
   * @param {string} owner - repository owner.
   * @param {string} name - repository name.
   * @param {number} number - PR number.
   * @param {string} headSha - head commit (cache key).
   * @returns {Promise<{ files: any[], filesTruncated: boolean }>} bounded file list.
   */
  async loadFiles(owner, name, number, headSha) {
    const key = `files:${owner}/${name}#${number}@${headSha}`
    const cached = this.cache.get(key, this.now())
    if (cached !== undefined) return cached
    return this.once(key, async () => {
      /** @type {Array<ReturnType<typeof normalizeFilePatch>>} */
      const files = []
      let pageWasFull = false
      for (let page = 1; page <= MAX_FILE_PAGES; page += 1) {
        const { data } = await this.requestJson(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${number}/files?per_page=${FILES_PAGE_SIZE}&page=${page}`)
        const batch = Array.isArray(data) ? data : []
        pageWasFull = batch.length === FILES_PAGE_SIZE
        for (const item of batch) files.push(normalizeFilePatch(item, { maxPatchChars: this.maxPatchChars }))
        if (!pageWasFull) break
      }
      const bounded = applyPatchBudget(files.slice(0, MAX_FILES))
      const filesTruncated = bounded.filesTruncated || (pageWasFull && files.length >= MAX_FILES)
      const value = { files: bounded.files, filesTruncated }
      this.cache.set(key, value, PATCH_TTL_MS, this.now())
      return value
    })
  }

  /**
   * Conversation comments (`issues/{n}/comments`).
   * @returns {Promise<Array<{ author: string, body: string, createdAt: string }>>} capped comments.
   */
  async loadIssueComments(owner, name, number) {
    const { data } = await this.requestJson(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${number}/comments?per_page=${MAX_ISSUE_COMMENTS}`)
    const list = Array.isArray(data) ? data.slice(0, MAX_ISSUE_COMMENTS) : []
    return list.map((comment) => ({
      author: comment?.user?.login ?? 'ghost',
      body: truncateText(comment?.body, MAX_COMMENT_BODY_CHARS).text,
      createdAt: typeof comment?.created_at === 'string' ? comment.created_at : '',
    }))
  }

  /**
   * Submitted reviews (`pulls/{n}/reviews`).
   * @returns {Promise<Array<{ author: string, state: string, body: string }>>} capped reviews.
   */
  async loadReviews(owner, name, number) {
    const { data } = await this.requestJson(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${number}/reviews?per_page=${MAX_REVIEWS}`)
    const list = Array.isArray(data) ? data.slice(0, MAX_REVIEWS) : []
    return list.map((review) => ({
      author: review?.user?.login ?? 'ghost',
      state: typeof review?.state === 'string' ? review.state : 'COMMENTED',
      body: truncateText(review?.body, MAX_COMMENT_BODY_CHARS).text,
    }))
  }

  /**
   * Inline review comments (`pulls/{n}/comments`).
   * @returns {Promise<Array<{ path: string, line: number | null, body: string, author: string, createdAt: string }>>} capped inline comments.
   */
  async loadInlineComments(owner, name, number) {
    const { data } = await this.requestJson(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${number}/comments?per_page=${MAX_INLINE_COMMENTS}`)
    const list = Array.isArray(data) ? data.slice(0, MAX_INLINE_COMMENTS) : []
    return list.map((comment) => ({
      id: Number.isInteger(comment?.id) ? comment.id : null,
      inReplyToId: Number.isInteger(comment?.in_reply_to_id) ? comment.in_reply_to_id : null,
      reviewId: Number.isInteger(comment?.pull_request_review_id) ? comment.pull_request_review_id : null,
      path: typeof comment?.path === 'string' ? comment.path : '',
      line: Number.isInteger(comment?.line) ? comment.line : null,
      body: truncateText(comment?.body, MAX_COMMENT_BODY_CHARS).text,
      author: comment?.user?.login ?? 'ghost',
      createdAt: typeof comment?.created_at === 'string' ? comment.created_at : '',
    }))
  }

  /**
   * Combine check-runs and legacy statuses for one head commit (30 s cache).
   * @param {string} owner - repository owner.
   * @param {string} name - repository name.
   * @param {string} headSha - head commit SHA.
   * @returns {Promise<{ state: string, items: any[] }>} checks view.
   */
  async loadChecks(owner, name, headSha) {
    if (headSha === '') return { state: 'none', items: [] }
    const key = `checks:${owner}/${name}@${headSha}`
    const cached = this.cache.get(key, this.now())
    if (cached !== undefined) return cached
    return this.once(key, async () => {
      const results = await Promise.allSettled([
        this.requestJson(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/commits/${encodeURIComponent(headSha)}/check-runs`),
        this.requestJson(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/commits/${encodeURIComponent(headSha)}/status`),
      ])
      if (results[0].status === 'rejected' && results[1].status === 'rejected') {
        return { state: 'unknown', items: [] }
      }
      const checkRuns = results[0].status === 'fulfilled' ? results[0].value.data : undefined
      const combinedStatus = results[1].status === 'fulfilled' ? results[1].value.data : undefined
      const value = normalizeChecks(checkRuns, combinedStatus)
      this.cache.set(key, value, CHECKS_TTL_MS, this.now())
      return value
    })
  }

  /**
   * Walk parent PRs via `pulls?head=owner:branch` so a stacked PR shows the
   * chain it depends on. Degrades to an empty chain on any failure.
   * @param {string} owner - repository owner.
   * @param {string} name - repository name.
   * @param {string} baseRefName - the PR's base branch.
   * @param {unknown} body - PR body (declared base note).
   * @returns {Promise<ReturnType<typeof buildStack>>} stack view.
   */
  async loadStack(owner, name, baseRefName, body) {
    const declaredBase = parseDeclaredBase(body)
    /** @type {Array<{ number: number, title: string, state: string, baseRefName: string, merged: boolean }>} */
    const parents = []
    /** @type {Set<string>} */
    const seen = new Set()
    let cursor = baseRefName
    for (let depth = 0; depth < MAX_STACK_DEPTH && cursor !== '' && !seen.has(cursor); depth += 1) {
      seen.add(cursor)
      const head = encodeURIComponent(`${owner}:${cursor}`)
      const { data } = await this.requestJson(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls?head=${head}&state=all&per_page=100`)
      const parent = findParentPull(data, cursor)
      if (parent === undefined) break
      parents.push(parent)
      cursor = parent.baseRefName
    }
    return buildStack({ baseRefName, declaredBase, parents })
  }
}

/**
 * Read a settled `Promise.allSettled` result, falling back to a default.
 * @template T
 * @param {PromiseSettledResult<T>} result - settled entry.
 * @param {T} fallback - value used on rejection.
 * @returns {T} the fulfilled value or the fallback.
 */
function settled(result, fallback) {
  return result.status === 'fulfilled' ? result.value : fallback
}

/**
 * Normalize one optional merge commit field: absent/blank means "not provided",
 * a non-string or an over-long value is a BAD_REQUEST.
 * @param {unknown} value - raw `commitTitle` / `commitMessage`.
 * @param {number} maxChars - contract cap.
 * @param {string} label - field label used in the error message.
 * @returns {string | undefined} trimmed value or undefined.
 * @throws {AppError} BAD_REQUEST for an invalid value.
 */
function normalizeOptionalCommitField(value, maxChars, label) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new AppError('BAD_REQUEST', `${label} 必须是字符串`)
  const text = value.trim()
  if (text === '') return undefined
  if (text.length > maxChars) throw new AppError('BAD_REQUEST', `${label} 超过 ${maxChars} 字`)
  return text
}

/**
 * Map a failed merge write onto the contract codes: GitHub answers 405/409 for
 * a PR that cannot be merged, 403/404 map to the existing GH codes. The gh CLI
 * fallback only exposes the status in its message, so both carriers are read.
 * @param {unknown} error - thrown value from the merge request.
 * @returns {unknown} a mapped AppError (or the original value).
 */
function mapMergeWriteError(error) {
  if (!(error instanceof AppError)) return error
  const status = error.details?.status
  const message = typeof error.message === 'string' ? error.message : ''
  if (status === 405 || status === 409 || /HTTP 405|HTTP 409|not mergeable|merge conflict|cannot be merged/i.test(message)) {
    return new AppError('MERGE_CONFLICT', `${USER_MESSAGES.MERGE_CONFLICT}${message === '' ? '' : `（${message.slice(0, 200)}）`}`)
  }
  if (status === 403 || /HTTP 403/.test(message)) return new AppError('GH_FORBIDDEN', message || USER_MESSAGES.GH_FORBIDDEN)
  if (status === 404 || /HTTP 404/.test(message)) return new AppError('GH_NOT_FOUND', message || USER_MESSAGES.GH_NOT_FOUND)
  return error
}

/**
 * Map a failed review write onto the contract codes (CONTRACT §7.2). GitHub
 * answers 422 when a review is unacceptable (e.g. a comment line outside the
 * diff), 403/404/429 land on the existing GH codes; the gh CLI fallback only
 * exposes the status inside its message, so both carriers are inspected.
 * @param {unknown} error - thrown value from the review request.
 * @returns {unknown} a mapped AppError (or the original value).
 */
function mapReviewWriteError(error) {
  if (!(error instanceof AppError)) return error
  const status = error.details?.status
  const message = typeof error.message === 'string' ? error.message : ''
  const suffix = message === '' ? '' : `（${message.slice(0, 200)}）`
  if (status === 422 || /HTTP 422/.test(message)) {
    // GitHub's 422 body names the offending field (usually a comment anchor), so
    // surface it: "the publish failed" alone cannot be acted on.
    const detail = describeReviewRejection(error.details?.errors)
    return new AppError('BAD_REQUEST', `${USER_MESSAGES.BAD_REQUEST}：GitHub 拒绝了本次发布${detail}${suffix}`)
  }
  if (status === 429 || /HTTP 429/.test(message)) return new AppError('GH_RATE_LIMIT', message || USER_MESSAGES.GH_RATE_LIMIT)
  if (status === 403 || /HTTP 403/.test(message)) {
    return /rate limit|secondary rate/i.test(message)
      ? new AppError('GH_RATE_LIMIT', message || USER_MESSAGES.GH_RATE_LIMIT)
      : new AppError('GH_FORBIDDEN', message || USER_MESSAGES.GH_FORBIDDEN)
  }
  if (status === 404 || /HTTP 404/.test(message)) return new AppError('GH_NOT_FOUND', message || USER_MESSAGES.GH_NOT_FOUND)
  // A 5xx on a write is not "no network": GitHub may have committed the review
  // before failing. Report it as an unknown outcome so nobody blindly retries
  // into a duplicate, and never as GH_NETWORK (which reads as "nothing happened").
  if (typeof status === 'number' && status >= 500) {
    return new AppError('PUBLISH_UNKNOWN', undefined, { cause: error })
  }
  if (/HTTP 5\d\d/.test(message)) return new AppError('PUBLISH_UNKNOWN', undefined, { cause: error })
  return error
}

/**
 * Summarize GitHub's `errors[]` for a rejected review write.
 * @param {unknown} errors - `errors` array from the API response.
 * @returns {string} a short `（首个原因）` suffix, or '' when nothing useful.
 */
function describeReviewRejection(errors) {
  if (!Array.isArray(errors) || errors.length === 0) return ''
  for (const entry of errors) {
    if (entry === null || typeof entry !== 'object') continue
    const code = typeof entry.code === 'string' ? entry.code : ''
    const field = typeof entry.field === 'string' ? entry.field : ''
    const text = typeof entry.message === 'string' ? entry.message : ''
    const parts = [field, code, text].filter((part) => part !== '')
    if (parts.length > 0) return `（首个原因：${parts.join(' · ').slice(0, 160)}）`
  }
  return ''
}
