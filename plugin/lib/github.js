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
import { promisify } from 'node:util'
import { AppError, USER_MESSAGES, isAbortError } from './errors.js'

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
 * GitHub data client. All terminals are injectable so tests exercise the
 * cache, transport and normalization without a network or a real `gh`.
 */
export class GitHubClient {
  /**
   * @param {{ config?: any, ghPath?: string, fetchImpl?: typeof fetch, execFileImpl?: Function, logger?: any, now?: () => number }} [options] - wiring.
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
    this.requestTimeoutMs = config.requestTimeoutMs ?? 15_000
    this.maxPatchChars = config.maxPatchChars ?? 24_000
    this.maxBodyChars = config.maxBodyChars ?? 50_000
    /** @type {LruCache} */
    this.cache = new LruCache(options.cacheMax ?? 200)
    /** @type {Map<string, Promise<unknown>>} */
    this.inflight = new Map()
    /** @type {Promise<{ token: string, source: string }> | undefined} */
    this.tokenPromise = undefined
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
   * GET one REST endpoint and parse JSON, retrying a 401 once after a token
   * refresh and falling back to the gh CLI when no token is available.
   * @param {string} path - REST path beginning with `/`.
   * @param {{ accept?: string, signal?: AbortSignal }} [options] - request knobs.
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
   * Primary transport: authenticated Node fetch.
   * @param {string} token - access token.
   * @param {string} path - REST path.
   * @param {{ accept?: string, signal?: AbortSignal }} [options] - request knobs.
   * @returns {Promise<{ data: any, headers: any }>} parsed body and headers.
   */
  async fetchJson(token, path, options = {}) {
    const url = path.startsWith('http') ? path : API_BASE_URL + path
    /** @type {Record<string, string>} */
    const headers = {
      accept: options.accept ?? 'application/vnd.github+json',
      'accept-encoding': 'identity',
      'user-agent': USER_AGENT,
      'x-github-api-version': GITHUB_API_VERSION,
      authorization: `Bearer ${token}`,
    }
    /** @type {any} */
    let response
    try {
      response = await this.fetchImpl(url, { method: 'GET', headers, redirect: 'follow', signal: options.signal })
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
      try {
        const parsed = JSON.parse(text)
        if (typeof parsed?.message === 'string') message = parsed.message
      } catch {
        // non-JSON error body
      }
      const code = httpStatusToCode(response.status, headerValue(response.headers, 'x-ratelimit-remaining'), message)
      const suffix = message === '' ? '' : `（GitHub: ${message.slice(0, 200)}）`
      throw new AppError(code, `${USER_MESSAGES[code]}${suffix}`)
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
   * Fallback transport: `gh api` through the async subprocess seam.
   * @param {string} path - REST path.
   * @param {{ accept?: string, signal?: AbortSignal }} [options] - request knobs.
   * @returns {Promise<{ data: any, headers: undefined }>} parsed body.
   */
  async cliJson(path, options = {}) {
    const endpoint = path.replace(/^\//, '')
    const args = ['api', endpoint]
    if (options.accept !== undefined) args.push('-H', `Accept: ${options.accept}`)
    const { stdout } = await this.runGh(args, { signal: options.signal })
    const text = stdout.trim()
    if (text === '') return { data: null, headers: undefined }
    try {
      return { data: JSON.parse(text), headers: undefined }
    } catch {
      throw new AppError('GH_NETWORK', 'gh 返回了无法解析的 JSON 输出')
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
    ])
    const files = settled(results[0], { files: [], filesTruncated: false })
    const issueComments = settled(results[1], [])
    const reviews = settled(results[2], [])
    const inline = settled(results[3], [])
    const checks = settled(results[4], { state: 'unknown', items: [] })
    const stack = settled(results[5], buildStack({ baseRefName, parents: [] }))
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
      comments: { total: totalComments, issue: issueComments, reviews, inline },
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
