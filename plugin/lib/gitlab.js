/**
 * GitLab data channel of dsh-codex-review (read-only).
 *
 * Talks to the GitLab REST API v4 with a personal access token, normalizes
 * merge requests into the same `CONTRACT.md` §1.2 shapes the GitHub channel
 * produces, and never performs a write. GitLab 12.9 is the compatibility
 * floor: merge-request changes come from `/changes` (not `/diffs`) and drafts
 * are reported as `work_in_progress`.
 * @module dsh-codex-review/lib/gitlab
 */

import { AppError } from './errors.js'
import { GUIDELINE_MAX_CHARS, GUIDELINE_PATHS, LruCache, applyPatchBudget, buildStack, truncateText } from './github.js'
import { buildChatContext } from './chat.js'

/** Default request timeout when the config does not override it. */
const DEFAULT_TIMEOUT_MS = 15_000

/** Cache TTLs mirroring the GitHub channel. */
const LIST_TTL_MS = 60_000
const DETAIL_TTL_MS = 60_000
const PATCH_TTL_MS = 30 * 60_000
const CHECKS_TTL_MS = 30_000
const HEAD_TTL_MS = 30_000
const GUIDELINE_TTL_MS = 10 * 60_000

/** File/discussion page budgets (CONTRACT §1.4). */
const FILES_PAGE_SIZE = 100
const MAX_FILE_PAGES = 3
const MAX_FILES = 300
const MAX_TOTAL_PATCH_CHARS = 1_200_000
const DISCUSSION_PAGE_SIZE = 100
const MAX_DISCUSSION_PAGES = 10
const MAX_COMMENT_BODY_CHARS = 4_000

/** GitLab project paths may nest groups: `mdesign/beijing/graphics-library-v2`. */
export const GITLAB_REPO_RE = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+){0,19}$/

/**
 * Validate a GitLab project path: nested groups are allowed, but no segment
 * may be `.`/`..` or start with `-`, so a crafted path cannot walk out of the
 * project scope.
 * @param {unknown} repo - project path.
 * @returns {boolean} whether the path is safe to use as a project id.
 */
export function isValidGitlabRepo(repo) {
  if (typeof repo !== 'string' || !GITLAB_REPO_RE.test(repo)) return false
  return repo.split('/').every((segment) => segment !== '.' && segment !== '..' && !segment.startsWith('-'))
}

/** Whether a query string looks like GitHub search syntax rather than plain text. */
const GITHUB_QUERY_RE = /\b(?:is|author|repo|label|review|assignee|user):/i

/** Coerce a count-ish value to a non-negative integer. */
function toCount(value) {
  const numeric = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : 0
}

/** Normalize a GitLab project path into the URL-encoded project id. */
export function encodeProjectId(repo) {
  return encodeURIComponent(String(repo ?? '').trim())
}

/**
 * Count added/removed lines in a unified diff body.
 * @param {unknown} diff - GitLab `diff` text.
 * @returns {{ additions: number, deletions: number }} line counts.
 */
export function countDiffLines(diff) {
  const text = typeof diff === 'string' ? diff : ''
  let additions = 0
  let deletions = 0
  for (const line of text.split('\n')) {
    if (line.startsWith('+++ ') || line.startsWith('--- ')) continue
    if (line.startsWith('+')) additions += 1
    else if (line.startsWith('-')) deletions += 1
  }
  return { additions, deletions }
}

/**
 * Normalize one merge-request listing item into a `PrSummary`.
 * @param {any} mr - GitLab merge request.
 * @param {string} [repo] - project path fallback when `references.full` is absent.
 * @returns {{ repo: string, number: number, title: string, author: string, authorAvatarUrl: string, isDraft: boolean, state: 'open' | 'closed', createdAt: string, updatedAt: string, headRefName: string, baseRefName: string, url: string, reviewDecision?: string, additions?: number, deletions?: number, changedFiles?: number } | null} summary, or null when unusable.
 */
export function normalizeGitLabSummary(mr, repo = '') {
  if (mr === null || typeof mr !== 'object') return null
  const number = toCount(mr.iid)
  if (number <= 0) return null
  const reference = typeof mr.references?.full === 'string' ? mr.references.full : ''
  const referenceRepo = reference.includes('!') ? reference.slice(0, reference.indexOf('!')) : ''
  const projectPath = referenceRepo !== '' ? referenceRepo : repo
  return {
    repo: projectPath,
    number,
    title: typeof mr.title === 'string' ? mr.title : '',
    author: typeof mr.author?.username === 'string' ? mr.author.username : 'ghost',
    authorAvatarUrl: typeof mr.author?.avatar_url === 'string' ? mr.author.avatar_url : '',
    isDraft: mr.work_in_progress === true || mr.draft === true,
    state: mr.state === 'opened' ? 'open' : 'closed',
    createdAt: typeof mr.created_at === 'string' ? mr.created_at : '',
    updatedAt: typeof mr.updated_at === 'string' ? mr.updated_at : '',
    headRefName: typeof mr.source_branch === 'string' ? mr.source_branch : '',
    baseRefName: typeof mr.target_branch === 'string' ? mr.target_branch : '',
    url: typeof mr.web_url === 'string' ? mr.web_url : '',
  }
}

/**
 * Normalize one GitLab change entry into a `FilePatch`.
 * @param {any} change - GitLab `changes[]` element.
 * @param {{ maxPatchChars?: number }} [options] - per-file patch cap.
 * @returns {{ path: string, previousPath?: string, status: string, additions: number, deletions: number, patch: string, patchTruncated: boolean }} normalized file.
 */
export function normalizeGitLabFile(change, options = {}) {
  const maxPatchChars = options.maxPatchChars ?? 24000
  const diff = typeof change?.diff === 'string' ? change.diff : ''
  const patch = truncateText(diff, maxPatchChars)
  const counts = countDiffLines(diff)
  const status = change?.new_file === true
    ? 'added'
    : change?.deleted_file === true
      ? 'removed'
      : change?.renamed_file === true
        ? 'renamed'
        : 'modified'
  /** @type {{ path: string, previousPath?: string, status: string, additions: number, deletions: number, patch: string, patchTruncated: boolean }} */
  const file = {
    path: typeof change?.new_path === 'string' ? change.new_path : typeof change?.old_path === 'string' ? change.old_path : '',
    status,
    additions: counts.additions,
    deletions: counts.deletions,
    patch: patch.text,
    patchTruncated: patch.truncated,
  }
  if (status === 'renamed' && typeof change?.old_path === 'string' && change.old_path !== '') {
    file.previousPath = change.old_path
  }
  return file
}

/**
 * Map one GitLab pipeline status onto the contract's check states.
 * @param {unknown} status - pipeline status.
 * @returns {string} check state token.
 */
export function mapPipelineState(status) {
  switch (String(status ?? '').toLowerCase()) {
    case 'success': return 'success'
    case 'failed':
    case 'canceled':
    case 'cancelled': return 'failure'
    case 'running':
    case 'pending':
    case 'created':
    case 'preparing':
    case 'waiting_for_resource': return 'pending'
    case 'skipped':
    case 'manual': return 'neutral'
    default: return 'unknown'
  }
}

/**
 * Normalize the MR's pipeline list into the contract's checks shape.
 * @param {any} pipelines - `merge_requests/:iid/pipelines` body.
 * @returns {{ state: 'none' | 'pending' | 'success' | 'failure' | 'neutral' | 'unknown', items: Array<{ name: string, state: string, url?: string }> }} checks view.
 */
export function normalizeGitLabChecks(pipelines) {
  const list = Array.isArray(pipelines) ? pipelines : []
  /** @type {Array<{ name: string, state: string, url?: string }>} */
  const items = list.slice(0, 10).map((pipeline) => {
    /** @type {{ name: string, state: string, url?: string }} */
    const item = {
      name: `Pipeline #${toCount(pipeline?.id)}`,
      state: mapPipelineState(pipeline?.status),
    }
    if (typeof pipeline?.web_url === 'string' && pipeline.web_url !== '') item.url = pipeline.web_url
    return item
  })
  if (items.length === 0) return { state: 'none', items }
  if (items.some((item) => item.state === 'failure')) return { state: 'failure', items }
  if (items.some((item) => item.state === 'pending')) return { state: 'pending', items }
  if (items.every((item) => item.state === 'neutral')) return { state: 'neutral', items }
  if (items.every((item) => item.state === 'success')) return { state: 'success', items }
  return { state: 'unknown', items }
}

/**
 * Split GitLab discussions into issue comments and inline (positioned) notes.
 * @param {any} discussions - `merge_requests/:iid/discussions` array.
 * @returns {{ issue: Array<any>, inline: Array<any>, total: number }} normalized comments.
 */
export function normalizeGitLabDiscussions(discussions) {
  /** @type {Array<any>} */
  const issue = []
  /** @type {Array<any>} */
  const inline = []
  for (const discussion of Array.isArray(discussions) ? discussions : []) {
    const threadId = typeof discussion?.id === 'string' ? discussion.id : ''
    for (const note of Array.isArray(discussion?.notes) ? discussion.notes : []) {
      if (note?.system === true) continue
      const body = truncateText(note?.body, MAX_COMMENT_BODY_CHARS).text
      if (body === '') continue
      const author = typeof note?.author?.username === 'string' ? note.author.username : 'ghost'
      const avatarUrl = typeof note?.author?.avatar_url === 'string' ? note.author.avatar_url : ''
      const createdAt = typeof note?.created_at === 'string' ? note.created_at : ''
      const position = note?.position !== null && typeof note?.position === 'object' ? note.position : null
      if (position === null) {
        issue.push({ author, avatarUrl, body, createdAt })
        continue
      }
      const line = Number.isInteger(position.new_line)
        ? position.new_line
        : Number.isInteger(position.old_line)
          ? position.old_line
          : null
      inline.push({
        id: Number.isInteger(note?.id) ? note.id : null,
        threadId,
        isResolved: note?.resolved === true,
        path: typeof position.new_path === 'string' ? position.new_path : typeof position.old_path === 'string' ? position.old_path : '',
        line,
        body,
        author,
        avatarUrl,
        createdAt,
      })
    }
  }
  return { issue, inline, total: issue.length + inline.length }
}

/**
 * GitLab read-only client. All terminals are injectable so tests run without
 * a network or a real GitLab instance.
 */
export class GitLabClient {
  /**
   * @param {{ config?: any, logger?: any, fetchImpl?: typeof fetch, now?: () => number }} [options] - wiring.
   */
  constructor(options = {}) {
    this.config = options.config ?? {}
    this.logger = options.logger
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
    this.now = options.now ?? Date.now
    this.cache = new LruCache(200)
    this.inflight = new Map()
    this.baseUrl = String(this.config.gitlabBaseUrl ?? '').trim().replace(/\/+$/, '')
    this.token = String(this.config.gitlabToken ?? process.env.GITLAB_TOKEN ?? '').trim()
    this.timeoutMs = Number.isFinite(this.config.requestTimeoutMs) ? this.config.requestTimeoutMs : DEFAULT_TIMEOUT_MS
    this.maxPatchChars = Number.isFinite(this.config.maxPatchChars) ? this.config.maxPatchChars : 24000
    this.maxBodyChars = Number.isFinite(this.config.maxBodyChars) ? this.config.maxBodyChars : 50000
  }

  /**
   * Resolve one API URL, refusing to run without a base URL.
   * @param {string} path - `/api/v4`-relative path.
   * @returns {string} absolute URL.
   * @throws {AppError} GL_MISSING_CONFIG when `gitlabBaseUrl` is empty.
   */
  url(path) {
    if (this.baseUrl === '') throw new AppError('GL_MISSING_CONFIG')
    return `${this.baseUrl}/api/v4${path}`
  }

  /**
   * One authenticated request with a timeout, mapping GitLab failures to the
   * stable GL_* vocabulary.
   * @param {string} path - `/api/v4`-relative path.
   * @param {{ signal?: AbortSignal, method?: string, body?: unknown, accept?: string }} [options] - request knobs.
   * @returns {Promise<{ data: any, headers: any }>} parsed JSON body and headers.
   */
  async requestJson(path, options = {}) {
    const { text, headers } = await this.requestText(path, options)
    if (text === '') return { data: null, headers }
    try {
      return { data: JSON.parse(text), headers }
    } catch {
      throw new AppError('GL_NETWORK', 'GitLab 返回了无法解析的响应')
    }
  }

  /**
   * One authenticated request returning raw text (used for repository files).
   * @param {string} path - `/api/v4`-relative path.
   * @param {{ signal?: AbortSignal, method?: string, body?: unknown, accept?: string }} [options] - request knobs.
   * @returns {Promise<{ text: string, headers: any }>} response body and headers.
   */
  async requestText(path, options = {}) {
    if (this.token === '') throw new AppError('GL_MISSING_CONFIG')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    if (timer.unref) timer.unref()
    const onAbort = () => controller.abort()
    if (options.signal) {
      if (options.signal.aborted) controller.abort()
      else options.signal.addEventListener('abort', onAbort, { once: true })
    }
    try {
      const response = await this.fetchImpl(this.url(path), {
        method: typeof options.method === 'string' && options.method !== '' ? options.method : 'GET',
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: options.accept ?? 'application/json',
          'user-agent': 'dsh-codex-review',
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      })
      const text = await response.text()
      if (!response.ok) {
        let message = ''
        try {
          const parsed = JSON.parse(text)
          message = typeof parsed?.message === 'string' ? parsed.message : typeof parsed?.error === 'string' ? parsed.error : ''
        } catch {
          message = ''
        }
        throw new AppError(httpStatusToGlCode(response.status, message))
      }
      return { text, headers: response.headers }
    } catch (error) {
      if (error instanceof AppError) throw error
      if (options.signal?.aborted === true) throw new AppError('GL_ABORTED')
      if (controller.signal.aborted) throw new AppError('GL_TIMEOUT')
      throw new AppError('GL_NETWORK', undefined, { cause: error })
    } finally {
      clearTimeout(timer)
      if (options.signal) options.signal.removeEventListener('abort', onAbort)
    }
  }

  /**
   * Read every page of a list endpoint, bounded by `maxPages`.
   * @param {string} path - `/api/v4`-relative path (may already contain a query).
   * @param {{ signal?: AbortSignal, maxPages?: number, perPage?: number }} [options] - pagination knobs.
   * @returns {Promise<any[]>} concatenated items.
   */
  async paginate(path, options = {}) {
    const maxPages = Number.isFinite(options.maxPages) && options.maxPages > 0 ? options.maxPages : MAX_DISCUSSION_PAGES
    const perPage = Number.isFinite(options.perPage) && options.perPage > 0 ? options.perPage : DISCUSSION_PAGE_SIZE
    /** @type {any[]} */
    const items = []
    let page = 1
    while (page <= maxPages) {
      const separator = path.includes('?') ? '&' : '?'
      const { data, headers } = await this.requestJson(`${path}${separator}per_page=${perPage}&page=${page}`, { signal: options.signal })
      const batch = Array.isArray(data) ? data : []
      items.push(...batch)
      const next = headers?.get?.('x-next-page')
      if (next === null || next === undefined || next === '') break
      const nextPage = Number(next)
      if (!Number.isFinite(nextPage) || nextPage <= page) break
      page = nextPage
    }
    return items
  }

  /**
   * List merge requests. GitHub-style query text is ignored; plain text is
   * passed through GitLab's `search` parameter.
   * @param {{ query?: string, limit?: number, signal?: AbortSignal }} [input] - list knobs.
   * @returns {Promise<{ query: string, totalCount: number, items: any[] }>} normalized list page.
   */
  async listPullRequests(input = {}) {
    const limit = Number.isFinite(input.limit) ? Math.min(100, Math.max(1, Math.floor(input.limit))) : 30
    const query = typeof input.query === 'string' ? input.query.trim() : ''
    const key = `list:${query}|${limit}`
    const cached = this.cache.get(key, this.now())
    if (cached !== undefined) return cached
    return this.once(key, async () => {
      let path = `/merge_requests?scope=created_by_me&state=opened&order_by=updated_at&sort=desc&per_page=${limit}`
      if (query !== '' && !GITHUB_QUERY_RE.test(query)) path += `&search=${encodeURIComponent(query)}`
      const { data, headers } = await this.requestJson(path, { signal: input.signal })
      const list = Array.isArray(data) ? data : []
      const items = list.map((mr) => normalizeGitLabSummary(mr)).filter((item) => item !== null)
      const totalHeader = Number(headers?.get?.('x-total'))
      const value = {
        query,
        totalCount: Number.isFinite(totalHeader) && totalHeader > 0 ? totalHeader : items.length,
        items,
      }
      this.cache.set(key, value, LIST_TTL_MS, this.now())
      return value
    })
  }

  /**
   * Read one MR detail (cached for 60s).
   * @param {string} repo - project path.
   * @param {number} number - MR iid.
   * @returns {Promise<any>} normalized detail.
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
   * Load MR detail without the outer cache.
   * @param {string} repo - project path.
   * @param {number} number - MR iid.
   * @returns {Promise<any>} normalized detail with `headSha`.
   */
  async loadPull(repo, number) {
    const project = encodeProjectId(repo)
    const base = `/projects/${project}/merge_requests/${number}`
    const [mrResult, changesResult, discussionsResult, approvalsResult, pipelinesResult] = await Promise.allSettled([
      this.requestJson(base),
      this.requestJson(`${base}/changes`),
      this.paginate(`${base}/discussions`, { maxPages: MAX_DISCUSSION_PAGES }),
      this.requestJson(`${base}/approvals`),
      this.requestJson(`${base}/pipelines`),
    ])
    if (mrResult.status === 'rejected') throw mrResult.reason
    if (changesResult.status === 'rejected') throw changesResult.reason
    const mr = mrResult.value.data
    if (mr === null || typeof mr !== 'object') throw new AppError('GL_NOT_FOUND')
    const changesBody = changesResult.status === 'fulfilled' ? changesResult.value.data : null
    const changes = Array.isArray(changesBody?.changes) ? changesBody.changes : []
    const files = applyPatchBudget(changes.slice(0, MAX_FILES).map((change) => normalizeGitLabFile(change, { maxPatchChars: this.maxPatchChars })), MAX_TOTAL_PATCH_CHARS)
    const discussions = discussionsResult.status === 'fulfilled' ? discussionsResult.value : []
    const comments = normalizeGitLabDiscussions(discussions)
    const approvals = approvalsResult.status === 'fulfilled' ? approvalsResult.value.data : null
    const pipelines = pipelinesResult.status === 'fulfilled' ? pipelinesResult.value.data : null
    const headSha = typeof mr.sha === 'string' && mr.sha !== '' ? mr.sha : typeof mr.diff_refs?.head_sha === 'string' ? mr.diff_refs.head_sha : ''
    const baseRefName = typeof mr.target_branch === 'string' ? mr.target_branch : ''
    const body = truncateText(mr.description, this.maxBodyChars)
    const summary = normalizeGitLabSummary(mr, repo)
    if (summary === null) throw new AppError('GL_NOT_FOUND')
    summary.additions = files.files.reduce((sum, file) => sum + file.additions, 0)
    summary.deletions = files.files.reduce((sum, file) => sum + file.deletions, 0)
    summary.changedFiles = files.files.length
    summary.reviewDecision = approvals?.approved === true ? 'APPROVED' : ''
    return {
      headSha,
      summary,
      body: body.text,
      bodyTruncated: body.truncated,
      files: files.files,
      filesTruncated: files.filesTruncated || changes.length > MAX_FILES || changesBody?.overflow === true,
      comments: { total: comments.total, issue: comments.issue, reviews: [], inline: comments.inline },
      checks: normalizeGitLabChecks(pipelines),
      stack: buildStack({ baseRefName, parents: [] }),
    }
  }

  /**
   * Read the MR's current head SHA without the detail cache.
   * @param {string} repo - project path.
   * @param {number} number - MR iid.
   * @param {{ signal?: AbortSignal }} [options] - request signal.
   * @returns {Promise<string>} head SHA or ''.
   */
  async getPullHead(repo, number, options = {}) {
    const key = `head:${repo}#${number}`
    const cached = this.cache.get(key, this.now())
    if (cached !== undefined) return cached
    return this.once(key, async () => {
      const { data } = await this.requestJson(`/projects/${encodeProjectId(repo)}/merge_requests/${number}`, { signal: options.signal })
      const headSha = typeof data?.sha === 'string' && data.sha !== ''
        ? data.sha
        : typeof data?.diff_refs?.head_sha === 'string' ? data.diff_refs.head_sha : ''
      this.cache.set(key, headSha, HEAD_TTL_MS, this.now())
      return headSha
    })
  }

  /**
   * Read `AGENTS.md` / `.github/AGENTS.md` from the project's default branch.
   * Missing files or permissions degrade to "no guidelines".
   * @param {string} repo - project path.
   * @param {{ signal?: AbortSignal }} [options] - request signal.
   * @returns {Promise<{ loaded: boolean, files: string[], chars: number, text: string }>} guidelines.
   */
  async getGuidelines(repo, options = {}) {
    const key = `guidelines:${repo}`
    const cached = this.cache.get(key, this.now())
    if (cached !== undefined) return cached
    return this.once(key, async () => {
      let ref = ''
      try {
        const { data } = await this.requestJson(`/projects/${encodeProjectId(repo)}`, { signal: options.signal })
        ref = typeof data?.default_branch === 'string' ? data.default_branch : ''
      } catch {
        ref = ''
      }
      /** @type {string[]} */
      const files = []
      /** @type {string[]} */
      const parts = []
      let remaining = GUIDELINE_MAX_CHARS
      for (const path of GUIDELINE_PATHS) {
        if (remaining <= 0) break
        const encodedPath = path.split('/').map((segment) => encodeURIComponent(segment)).join('%2F')
        try {
          const { text } = await this.requestText(`/projects/${encodeProjectId(repo)}/repository/files/${encodedPath}/raw?ref=${encodeURIComponent(ref || 'HEAD')}`, { signal: options.signal })
          const bounded = truncateText(text.trim(), Math.min(GUIDELINE_MAX_CHARS, remaining))
          if (bounded.text === '') continue
          files.push(path)
          parts.push(bounded.text)
          remaining -= bounded.text.length
        } catch (error) {
          if (!(error instanceof AppError && error.code === 'GL_NOT_FOUND')) {
            this.logger?.warn?.(`dsh-codex-review: could not read ${repo}/${path}: ${error?.message ?? error}`)
          }
        }
      }
      const value = { loaded: files.length > 0, files, chars: parts.reduce((sum, part) => sum + part.length, 0), text: parts.join('\n\n') }
      if (options.signal?.aborted !== true) this.cache.set(key, value, GUIDELINE_TTL_MS, this.now())
      return value
    })
  }

  /**
   * Build the bounded MR-chat context from a loaded detail snapshot.
   * @param {{ repo?: string, number?: number, detail?: any, review?: any, focusFile?: string, messages?: Array<{ role: 'user' | 'assistant', content: string }> }} input - chat input.
   * @returns {Promise<{ system: string, messages: Array<any>, stats: any }>} model-ready context.
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
   * The configured viewer login (no API call; read-only channel never needs
   * the token owner for publishing).
   * @returns {Promise<string>} login or ''.
   */
  async getAuthenticatedUser() {
    return typeof this.config.viewerLogin === 'string' ? this.config.viewerLogin.trim() : ''
  }

  /**
   * Health probe used by `/codex-review/health`.
   * @returns {Promise<{ ok: boolean, provider: 'gitlab', viewer: string, error?: string }>} status.
   */
  async status() {
    try {
      const { data } = await this.requestJson('/user')
      const viewer = typeof data?.username === 'string' ? data.username : ''
      return { ok: true, provider: 'gitlab', viewer }
    } catch (error) {
      const code = error instanceof AppError ? error.code : 'GL_NETWORK'
      return { ok: false, provider: 'gitlab', viewer: '', error: code }
    }
  }

  /**
   * Drop cached detail/list entries for one MR.
   * @param {string} repo - project path.
   * @param {number} number - MR iid.
   * @returns {void}
   */
  invalidatePullCache(repo, number) {
    this.cache.delete(`pr:${repo}#${number}`)
    for (const key of this.cache.keys?.() ?? []) {
      if (key.startsWith('list:')) this.cache.delete(key)
    }
  }

  /**
   * Memoize one in-flight promise by key so concurrent reads share a request.
   * @param {string} key - cache key.
   * @param {() => Promise<any>} run - loader.
   * @returns {Promise<any>} loader result.
   */
  once(key, run) {
    const pending = this.inflight.get(key)
    if (pending !== undefined) return pending
    const promise = run().finally(() => this.inflight.delete(key))
    this.inflight.set(key, promise)
    return promise
  }
}

/**
 * Map one HTTP status to the stable GL_* code.
 * @param {number} status - HTTP status.
 * @param {string} [message] - GitLab message field.
 * @returns {string} stable error code.
 */
export function httpStatusToGlCode(status, message = '') {
  if (status === 401 || status === 403) return 'GL_UNAUTHORIZED'
  if (status === 404) return 'GL_NOT_FOUND'
  if (status === 429) return 'GL_RATE_LIMIT'
  if (status >= 500) return 'GL_SERVER'
  if (/rate limit/i.test(message)) return 'GL_RATE_LIMIT'
  return 'INTERNAL'
}
