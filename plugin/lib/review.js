/**
 * AI review engine of dsh-codex-review.
 *
 * Pure pieces (file selection, chunking, prompt building, output parsing,
 * finding validation/merge, overview text) are exported for `node --test`;
 * {@link ReviewEngine} owns the in-memory job table and drives
 * `ctx.llm.stream` through an injected `streamLlm` function so the engine is
 * testable without a host context or a real model.
 *
 * The request/response contract is the one the reconnaissance confirmed:
 * `stream({ provider, model, system, messages:[{role:'user',content:[{type:'text',text}]}], maxTokens, signal })`
 * yields `{ type:'text-delta', index, text }` chunks and ends with one
 * `{ type:'finish', reason:{ kind:'stop'|'max-tokens'|'error'|'aborted', failure? } }`.
 * @module dsh-codex-review/lib/review
 */

import { createHash } from 'node:crypto'
import { AppError, USER_MESSAGES } from './errors.js'
import { truncateText } from './github.js'

/** Fixed system prompt (CONTRACT §1.5). */
export const REVIEW_SYSTEM_PROMPT = [
  '你是资深代码审查者。只报告本次 diff 引入的真实缺陷：正确性、安全、数据一致性、并发、边界条件、API 契约破坏、性能回归、测试缺失导致的回归风险。',
  '不要报告纯风格/格式/命名偏好，不要报告 diff 之外的问题，不要复述代码。',
  '输出严格 JSON，不要 markdown 代码围栏。',
].join('')

/** Allowed finding severities, worst first. */
export const SEVERITIES = Object.freeze(['P0', 'P1', 'P2'])

/** Allowed finding categories. */
export const CATEGORIES = Object.freeze(['correctness', 'security', 'data', 'concurrency', 'performance', 'api', 'test'])

/** Character budget for the PR body inside one prompt (CONTRACT §1.5). */
const PROMPT_BODY_CHARS = 4_000

/** Title cap for one finding. */
const FINDING_TITLE_CHARS = 80

/** Per-call model deadline (three minutes, CONTRACT §1.5). */
const CALL_TIMEOUT_MS = 180_000

/** Pause between two chunk calls so the host event loop can breathe. */
const CHUNK_GAP_MS = 200

/** Paths that never deserve model attention. */
const SKIP_PATH_PATTERNS = Object.freeze([
  /(?:^|\/)package-lock\.json$/i,
  /(?:^|\/)pnpm-lock\.yaml$/i,
  /(?:^|\/)yarn\.lock$/i,
  /\.lock$/i,
  /\.min\.js$/i,
  /\.snap$/i,
  /(?:^|\/)node_modules\//i,
])

/** Retry suffix appended when the first answer did not parse as JSON. */
const RETRY_SUFFIX = '\n\n上一次输出不是合法 JSON，只输出 JSON。'

/**
 * Whether one changed file should be sent to the model.
 * Empty patches (binary/missing diff) and generated artifacts are skipped.
 * @param {{ path?: string, patch?: string }} file - normalized file patch.
 * @returns {boolean} true when the file is reviewable.
 */
export function isReviewableFile(file) {
  const path = typeof file?.path === 'string' ? file.path : ''
  if (path === '') return false
  if (typeof file?.patch !== 'string' || file.patch === '') return false
  return !SKIP_PATH_PATTERNS.some((pattern) => pattern.test(path))
}

/**
 * Filter a PR's files down to the reviewable set.
 * @param {Array<{ path?: string, patch?: string }>} files - normalized files.
 * @returns {Array<any>} reviewable files in payload order.
 */
export function selectReviewableFiles(files) {
  return Array.isArray(files) ? files.filter(isReviewableFile) : []
}

/**
 * Greedily pack files into prompt chunks, stopping after `maxChunks`.
 * A single file larger than the budget stays alone in its chunk (its patch is
 * already capped by `maxPatchChars`); files that do not fit are reported as
 * skipped.
 * @param {Array<{ path: string, patch: string }>} files - reviewable files.
 * @param {{ chunkChars?: number, maxChunks?: number }} [options] - budgets.
 * @returns {{ chunks: Array<{ files: any[], chars: number }>, skippedFiles: string[], skippedChars: number, totalChars: number }} chunk plan.
 */
export function chunkFiles(files, options = {}) {
  const chunkChars = options.chunkChars ?? 18_000
  const maxChunks = options.maxChunks ?? 6
  /** @type {Array<{ files: any[], chars: number }>} */
  const chunks = []
  /** @type {Array<{ path: string, patch: string }>} */
  const skipped = []
  let current = emptyChunk()
  let totalChars = 0
  let skippedChars = 0
  for (const file of files) {
    const cost = file.patch.length
    totalChars += cost
    if (current.files.length > 0 && current.chars + cost > chunkChars) {
      chunks.push(current)
      current = emptyChunk()
    }
    if (chunks.length >= maxChunks && current.files.length === 0) {
      skipped.push(file)
      skippedChars += cost
      continue
    }
    current.files.push(file)
    current.chars += cost
  }
  if (current.files.length > 0) {
    if (chunks.length < maxChunks) chunks.push(current)
    else {
      for (const file of current.files) {
        skipped.push(file)
        skippedChars += file.patch.length
      }
    }
  }
  return { chunks, skippedFiles: skipped.map((file) => file.path), skippedChars, totalChars }
}

/** @returns {{ files: any[], chars: number }} an empty chunk record. */
function emptyChunk() {
  return { files: [], chars: 0 }
}

/**
 * Render the per-chunk user prompt. Patches keep their `@@` headers so the
 * model can cite exact new-file line numbers.
 * @param {{ pr: { repo?: string, number?: number, title?: string, body?: string, baseRefName?: string, headRefName?: string }, chunk: { files: any[] }, chunkIndex: number, chunkCount: number }} input - prompt data.
 * @returns {string} the prompt text.
 */
export function buildUserPrompt(input) {
  const pr = input.pr ?? {}
  const chunk = input.chunk ?? { files: [] }
  const body = truncateText(pr.body, PROMPT_BODY_CHARS)
  const lines = []
  lines.push(`# Pull Request ${pr.repo ?? ''}#${pr.number ?? '?'}`)
  lines.push(`标题：${pr.title ?? ''}`)
  if (typeof pr.baseRefName === 'string' || typeof pr.headRefName === 'string') {
    lines.push(`分支：${pr.headRefName ?? '?'} → ${pr.baseRefName ?? '?'}`)
  }
  if (body.text !== '') {
    lines.push('')
    lines.push(`## PR 正文${body.truncated ? '（已截断）' : ''}`)
    lines.push(body.text)
  }
  lines.push('')
  lines.push(`## 本块改动文件（第 ${input.chunkIndex + 1}/${input.chunkCount} 块，共 ${chunk.files.length} 个文件）`)
  for (const file of chunk.files) {
    lines.push('')
    lines.push(`### ${file.path} [${file.status ?? 'modified'} +${file.additions ?? 0} −${file.deletions ?? 0}]${file.patchTruncated === true ? '（patch 已截断）' : ''}`)
    lines.push(file.patch)
  }
  lines.push('')
  lines.push('## 输出要求')
  lines.push('只输出一个 JSON 对象，不要 markdown 代码围栏，不要思考过程，不要额外解释。结构：')
  lines.push('{"findings":[{"severity":"P0"|"P1"|"P2","file":"路径","line":新文件行号,"lineEnd":可选,"title":"≤80字","why":"触发条件→后果","fix":"具体动作","category":"correctness|security|data|concurrency|performance|api|test"}]}')
  lines.push('无问题返回 {"findings":[]}；即使本块没有问题也必须输出这个 JSON，不要用文字说明。')
  lines.push('最多 6 条发现，每条 why 与 fix 各不超过 60 字；不确定的不要报。')
  lines.push('file 必须来自上面列出的文件清单；line 必须是该文件 patch 中新增（+）或上下文行在新文件里的行号，不要用旧文件行号。')
  return lines.join('\n')
}

/**
 * Strip markdown fences and slice the first balanced `{...}` object out of a
 * model answer (string-aware, so braces inside strings do not confuse it).
 * @param {unknown} text - raw model output.
 * @returns {string | null} the JSON text, or null when no balanced object exists.
 */
export function extractJsonObject(text) {
  if (typeof text !== 'string' || text === '') return null
  const cleaned = text.replace(/```[A-Za-z0-9_-]*\n?/g, '').replace(/```/g, '')
  const objectStart = cleaned.indexOf('{')
  const arrayStart = cleaned.indexOf('[')
  let start = -1
  let open = '{'
  let close = '}'
  if (objectStart !== -1 && (arrayStart === -1 || objectStart < arrayStart)) {
    start = objectStart
  } else if (arrayStart !== -1) {
    start = arrayStart
    open = '['
    close = ']'
  }
  if (start === -1) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < cleaned.length; index += 1) {
    const character = cleaned[index]
    if (inString) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') {
      inString = true
      continue
    }
    if (character === open) depth += 1
    else if (character === close) {
      depth -= 1
      if (depth === 0) return cleaned.slice(start, index + 1)
    }
  }
  return null
}

/**
 * Parse one model answer into validated findings.
 * @param {unknown} text - raw model output.
 * @param {{ allowedFiles: Set<string> | string[] }} input - file whitelist.
 * @returns {{ ok: true, findings: any[] } | { ok: false, reason: string }} parse result; invalid findings are dropped individually.
 */
export function parseFindingsText(text, input) {
  const jsonText = extractJsonObject(text)
  if (jsonText === null) return { ok: false, reason: 'no-json-object' }
  /** @type {any} */
  let parsed
  try {
    parsed = JSON.parse(jsonText)
  } catch {
    return { ok: false, reason: 'invalid-json' }
  }
  if (parsed === null || typeof parsed !== 'object') return { ok: false, reason: 'missing-findings-array' }
  // Accept both the requested `{ findings: [...] }` object and a bare array,
  // which models emit when they treat the schema as "a list of findings".
  const rawFindings = Array.isArray(parsed) ? parsed : parsed.findings
  if (!Array.isArray(rawFindings)) return { ok: false, reason: 'missing-findings-array' }
  const allowed = input.allowedFiles instanceof Set ? input.allowedFiles : new Set(input.allowedFiles ?? [])
  const findings = []
  for (const candidate of rawFindings) {
    const finding = normalizeFinding(candidate, allowed)
    if (finding !== null) findings.push(finding)
  }
  return { ok: true, findings }
}

/** Prose answers that mean "this chunk has no problems". */
const NO_FINDINGS_PROSE = /(未发现|没有发现|无问题|未发现问题|没有明显问题|no issues|no problems|nothing to report)/i

/**
 * Whether a model answer is prose stating that no problem was found. Models
 * occasionally ignore the JSON-only instruction for clean chunks; treating
 * such an answer as `{ findings: [] }` keeps the rest of the review from
 * being reported as partially failed.
 * @param {unknown} text - raw model output.
 * @returns {boolean} true when the answer reads as a clean-chunk sentence.
 */
export function looksLikeNoFindings(text) {
  if (typeof text !== 'string') return false
  const trimmed = text.trim()
  if (trimmed === '' || trimmed.length > 600) return false
  return NO_FINDINGS_PROSE.test(trimmed)
}

/**
 * Validate and normalize one raw finding; null means drop it.
 * @param {any} candidate - raw element from the model answer.
 * @param {Set<string>} allowedFiles - files present in this chunk.
 * @returns {{ severity: string, file: string, line: number, lineEnd?: number, title: string, why: string, fix: string, category?: string } | null} finding or null.
 */
export function normalizeFinding(candidate, allowedFiles) {
  if (candidate === null || typeof candidate !== 'object') return null
  const severity = typeof candidate.severity === 'string' ? candidate.severity.toUpperCase() : ''
  if (!SEVERITIES.includes(severity)) return null
  const file = normalizeFilePath(candidate.file)
  if (file === '' || !allowedFiles.has(file)) return null
  const line = toPositiveInteger(candidate.line)
  if (line === null) return null
  const title = typeof candidate.title === 'string' ? candidate.title.trim() : ''
  if (title === '') return null
  /** @type {{ severity: string, file: string, line: number, lineEnd?: number, title: string, why: string, fix: string, category?: string }} */
  const finding = {
    severity,
    file,
    line,
    title: title.length > FINDING_TITLE_CHARS ? title.slice(0, FINDING_TITLE_CHARS) : title,
    why: typeof candidate.why === 'string' ? candidate.why.trim() : '',
    fix: typeof candidate.fix === 'string' ? candidate.fix.trim() : '',
  }
  const lineEnd = toPositiveInteger(candidate.lineEnd)
  if (lineEnd !== null && lineEnd >= line) finding.lineEnd = lineEnd
  if (typeof candidate.category === 'string' && CATEGORIES.includes(candidate.category)) finding.category = candidate.category
  return finding
}

/**
 * Normalize a model-supplied path: trim, strip a leading `./`.
 * @param {unknown} value - candidate path.
 * @returns {string} normalized path (empty when unusable).
 */
function normalizeFilePath(value) {
  if (typeof value !== 'string') return ''
  return value.trim().replace(/^\.\//, '')
}

/**
 * @param {unknown} value - candidate number.
 * @returns {number | null} a positive integer, or null.
 */
function toPositiveInteger(value) {
  const numeric = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  if (!Number.isFinite(numeric) || numeric <= 0 || Math.floor(numeric) !== numeric) return null
  return numeric
}

/**
 * Stable finding identity: file + start line + normalized title.
 * @param {{ file: string, line: number, title: string }} finding - normalized finding.
 * @returns {string} 12 hex characters.
 */
export function findingId(finding) {
  const title = finding.title.toLowerCase().replace(/\s+/g, ' ').trim()
  return createHash('sha1').update(`${finding.file}:${finding.line}:${title}`).digest('hex').slice(0, 12)
}

/**
 * Merge chunk results: stamp ids, de-duplicate, sort P0→P2 then file/line.
 * @param {Array<Array<any>>} groups - findings per chunk.
 * @returns {{ findings: any[], overview: string }} merged findings plus the deterministic summary line.
 */
export function mergeFindings(groups) {
  /** @type {Map<string, any>} */
  const byId = new Map()
  for (const group of groups) {
    for (const finding of group) {
      const id = findingId(finding)
      if (byId.has(id)) continue
      byId.set(id, { ...finding, id, rank: SEVERITIES.indexOf(finding.severity) })
    }
  }
  const findings = [...byId.values()].sort(compareFindings).map(({ rank, ...finding }) => finding)
  return { findings, overview: buildOverview(findings) }
}

/**
 * Sort P0 before P1 before P2, then by file and start line.
 * @param {{ severity: string, file: string, line: number }} left - finding.
 * @param {{ severity: string, file: string, line: number }} right - finding.
 * @returns {number} comparator result.
 */
export function compareFindings(left, right) {
  const rankDelta = SEVERITIES.indexOf(left.severity) - SEVERITIES.indexOf(right.severity)
  if (rankDelta !== 0) return rankDelta
  const fileDelta = left.file.localeCompare(right.file)
  if (fileDelta !== 0) return fileDelta
  return left.line - right.line
}

/**
 * Deterministic Chinese overview line.
 * @param {Array<{ severity: string }>} findings - merged findings.
 * @returns {string} e.g. `共 3 个问题：P0 ×1 · P1 ×2`.
 */
export function buildOverview(findings) {
  if (!Array.isArray(findings) || findings.length === 0) return 'AI 未发现明显问题'
  const counts = new Map(SEVERITIES.map((severity) => [severity, 0]))
  for (const finding of findings) counts.set(finding.severity, (counts.get(finding.severity) ?? 0) + 1)
  const parts = SEVERITIES.filter((severity) => (counts.get(severity) ?? 0) > 0).map((severity) => `${severity} ×${counts.get(severity)}`)
  return `共 ${findings.length} 个问题：${parts.join(' · ')}`
}

/** Role carried by the single request-only user message of every chunk call. */
const REVIEW_REQUEST_ROLE = 'user'

/**
 * Default inter-chunk pause; injectable so tests never sleep.
 * @returns {Promise<void>} resolves after the gap.
 */
function defaultSleep() {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, CHUNK_GAP_MS)
    if (typeof timer.unref === 'function') timer.unref()
  })
}

/**
 * In-memory review job table and chunk runner.
 *
 * `streamLlm` receives the exact request object the host forwarded
 * (`{ provider, model, system, messages, maxTokens, signal }`) and must
 * return an async iterable of stream chunks; the production wiring is
 * `(request) => ctx.llm.stream(request)`.
 */
export class ReviewEngine {
  /**
   * @param {{ streamLlm?: (request: any) => AsyncIterable<any>, resolveSelection?: () => { provider?: string, model?: string }, config?: any, logger?: any, now?: () => number, sleep?: () => Promise<void>, callTimeoutMs?: number }} [options] - engine wiring.
   */
  constructor(options = {}) {
    /** @type {((request: any) => AsyncIterable<any>) | undefined} */
    this.streamLlm = options.streamLlm
    /** @type {(() => { provider?: string, model?: string }) | undefined} */
    this.resolveSelection = options.resolveSelection
    /** Resolved plugin config (chunk budgets, output tokens, model overrides). */
    this.config = options.config ?? {}
    /** Optional logger. */
    this.logger = options.logger
    /** Clock override. */
    this.now = options.now ?? Date.now
    /** Inter-chunk sleep override. */
    this.sleep = options.sleep ?? defaultSleep
    /** Per-call deadline override. */
    this.callTimeoutMs = options.callTimeoutMs ?? CALL_TIMEOUT_MS
    this.maxJobs = this.config.maxJobs ?? 20
    /** @type {Map<string, any>} */
    this.jobs = new Map()
    this.sequence = 0
  }

  /**
   * Whether a model call is possible at all (the llm seam was injected).
   * @returns {boolean} true when `streamLlm` exists.
   */
  available() {
    return typeof this.streamLlm === 'function'
  }

  /**
   * Resolve the provider/model pair for this job.
   * @returns {{ provider: string, model: string }} selection.
   * @throws {AppError} LLM_UNAVAILABLE when no selection can be resolved.
   */
  resolveModel() {
    let selection
    try {
      selection = typeof this.resolveSelection === 'function' ? this.resolveSelection() : undefined
    } catch {
      throw new AppError('LLM_UNAVAILABLE')
    }
    const provider = typeof this.config.provider === 'string' && this.config.provider !== '' ? this.config.provider : selection?.provider
    const model = typeof this.config.model === 'string' && this.config.model !== '' ? this.config.model : selection?.model
    if (typeof provider !== 'string' || provider === '' || typeof model !== 'string' || model === '') {
      throw new AppError('LLM_UNAVAILABLE')
    }
    return { provider, model }
  }

  /**
   * Start (or reuse) a review job.
   * @param {{ repo: string, number: number, headSha: string, title?: string, body?: string, baseRefName?: string, headRefName?: string, files: any[] }} input - PR snapshot.
   * @returns {{ jobId: string, headSha: string, cached: boolean }} job reference.
   * @throws {AppError} LLM_UNAVAILABLE when the model seam is missing.
   */
  start(input) {
    if (!this.available()) throw new AppError('LLM_UNAVAILABLE')
    const model = this.resolveModel()
    const key = jobKey(input.repo, input.number, input.headSha)
    const existing = this.findByKey(key)
    if (existing !== undefined) {
      if (existing.state === 'done') return { jobId: existing.id, headSha: existing.headSha, cached: true }
      if (existing.state === 'running' || existing.state === 'queued') {
        return { jobId: existing.id, headSha: existing.headSha, cached: false }
      }
    }
    const job = {
      id: `rv-${this.now().toString(36)}-${this.sequence += 1}`,
      key,
      repo: input.repo,
      number: input.number,
      headSha: input.headSha,
      state: 'queued',
      phase: 'preparing',
      filesDone: 0,
      filesTotal: 0,
      startedAt: this.now(),
      endedAt: undefined,
      model,
      findings: [],
      overview: undefined,
      skippedFiles: [],
      partial: false,
      partialReasons: [],
      maxTokenCalls: 0,
      error: undefined,
      controller: new AbortController(),
      cancelled: false,
    }
    this.jobs.set(job.id, job)
    this.evictSettled()
    // The promise is retained for tests and for a future graceful-shutdown
    // await; the route never blocks on it.
    job.done = this.run(job, input)
    return { jobId: job.id, headSha: job.headSha, cached: false }
  }

  /**
   * Read one job's status in the contract shape.
   * @param {string} jobId - job id returned by {@link start}.
   * @returns {any} ReviewStatus.
   * @throws {AppError} BAD_REQUEST for an unknown id.
   */
  status(jobId) {
    const job = this.jobs.get(jobId)
    if (job === undefined) throw new AppError('BAD_REQUEST', '未知的审查任务 id')
    const elapsedMs = (job.endedAt ?? this.now()) - job.startedAt
    /** @type {any} */
    const status = {
      jobId: job.id,
      state: job.state,
      progress: {
        phase: job.phase,
        filesDone: job.filesDone,
        filesTotal: job.filesTotal,
        startedAt: job.startedAt,
        elapsedMs: Math.max(0, elapsedMs),
      },
      headSha: job.headSha,
      findings: job.findings,
      partial: job.partial,
      model: job.model,
    }
    if (job.overview !== undefined) status.overview = job.overview
    if (job.error !== undefined) status.error = job.error
    if (job.skippedFiles.length > 0) status.skippedFiles = job.skippedFiles
    if (job.partialReasons.length > 0) status.partialReasons = job.partialReasons
    if (job.maxTokenCalls > 0) status.truncatedCalls = job.maxTokenCalls
    return status
  }

  /**
   * Cancel a queued/running job.
   * @param {string} jobId - job id.
   * @returns {boolean} whether a job was cancelled.
   */
  cancel(jobId) {
    const job = this.jobs.get(jobId)
    if (job === undefined) return false
    if (job.state !== 'queued' && job.state !== 'running') return false
    job.cancelled = true
    job.controller.abort(new AppError('INTERNAL', '审查任务被取消'))
    return true
  }

  /**
   * Snapshot of the existing review for one PR head, for the `PrDetail.review` field.
   * @param {string} repo - `owner/name`.
   * @param {number} number - PR number.
   * @param {string} headSha - PR head SHA.
   * @returns {{ state: string, jobId?: string, headSha: string, findings: any[], overview?: string, error?: { code: string, message: string } }} review snapshot.
   */
  existing(repo, number, headSha) {
    const job = this.findByKey(jobKey(repo, number, headSha))
    if (job === undefined) return { state: 'none', headSha, findings: [] }
    // PrDetail.review.state has no 'cancelled' member: a cancelled run is
    // reported as none so the UI offers a fresh review for the same head.
    const state = job.state === 'queued' || job.state === 'running'
      ? 'running'
      : job.state === 'done' ? 'done' : job.state === 'error' ? 'error' : 'none'
    /** @type {any} */
    const snapshot = { state, jobId: job.id, headSha, findings: job.findings }
    if (job.overview !== undefined) snapshot.overview = job.overview
    if (job.error !== undefined) snapshot.error = job.error
    return snapshot
  }

  /** Abort every running job (plugin dispose). */
  dispose() {
    for (const job of this.jobs.values()) {
      if (job.state === 'queued' || job.state === 'running') this.cancel(job.id)
    }
  }

  /**
   * Find a job by its stable PR-head key.
   * @param {string} key - job key.
   * @returns {any | undefined} the job record.
   */
  findByKey(key) {
    for (const job of this.jobs.values()) if (job.key === key) return job
    return undefined
  }

  /** Evict the oldest settled job while the table exceeds `maxJobs`. */
  /** Evict jobs until the table is back under `maxJobs`: settled jobs first,
   * then (only when every job is live) the oldest running job is cancelled so
   * the table stays bounded. */
  evictSettled() {
    while (this.jobs.size > this.maxJobs) {
      /** @type {string | undefined} */
      let victimId
      for (const [id, job] of this.jobs) {
        if (job.state === 'done' || job.state === 'error' || job.state === 'cancelled') {
          victimId = id
          break
        }
      }
      if (victimId === undefined) {
        const oldest = this.jobs.keys().next()
        if (oldest.done === true) return
        victimId = oldest.value
      }
      const victim = this.jobs.get(victimId)
      if (victim !== undefined && (victim.state === 'queued' || victim.state === 'running')) {
        victim.cancelled = true
        victim.controller.abort(new AppError('INTERNAL', '审查任务被取消'))
      }
      this.jobs.delete(victimId)
    }
  }

  /**
   * Drive one job to a terminal state. Never rejects: failures settle the job.
   * @param {any} job - job record.
   * @param {{ files: any[], title?: string, body?: string, baseRefName?: string, headRefName?: string, repo: string, number: number }} input - PR snapshot.
   * @returns {Promise<void>} resolves when the job settles.
   */
  async run(job, input) {
    job.state = 'running'
    try {
      const reviewable = selectReviewableFiles(input.files)
      const plan = chunkFiles(reviewable, {
        chunkChars: this.config.reviewChunkChars ?? 9_000,
        maxChunks: this.config.maxChunks ?? 9,
      })
      job.skippedFiles = plan.skippedFiles
      job.filesTotal = plan.chunks.reduce((sum, chunk) => sum + chunk.files.length, 0)
      job.phase = job.filesTotal === 0 ? 'merging' : 'reviewing'
      /** @type {Array<{ ok: boolean, findings?: any[], reason?: string } | undefined>} */
      const results = new Array(plan.chunks.length)
      const concurrency = Math.max(1, Math.min(plan.chunks.length, this.config.reviewConcurrency ?? 3))
      let nextIndex = 0
      /**
       * Pull the next unclaimed chunk until the plan is exhausted. Chunks run
       * concurrently because each auxiliary call is dominated by model
       * reasoning latency, not by host work.
       * @returns {Promise<void>} resolves when no chunk is left.
       */
      const worker = async () => {
        for (;;) {
          if (job.cancelled === true) throw new AppError('INTERNAL', '审查任务被取消')
          const index = nextIndex
          nextIndex += 1
          if (index >= plan.chunks.length) return
          const chunk = plan.chunks[index]
          const prompt = buildUserPrompt({
            pr: {
              repo: input.repo,
              number: input.number,
              title: input.title,
              body: input.body,
              baseRefName: input.baseRefName,
              headRefName: input.headRefName,
            },
            chunk,
            chunkIndex: index,
            chunkCount: plan.chunks.length,
          })
          const allowedFiles = new Set(chunk.files.map((file) => file.path))
          try {
            results[index] = await this.reviewChunk(job, prompt, allowedFiles, index)
          } catch (error) {
            // A single chunk failing (timeout, provider hiccup) must not discard
            // the chunks that did finish: record it as a partial reason.
            if (job.cancelled === true) throw error
            results[index] = { ok: false, hard: true, reason: publicReviewError(error).message }
          }
          job.filesDone += chunk.files.length
        }
      }
      await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => worker()))
      if (job.cancelled === true) throw new AppError('INTERNAL', '审查任务被取消')
      /** @type {Array<Array<any>>} */
      const groups = []
      for (let index = 0; index < results.length; index += 1) {
        const result = results[index]
        if (result === undefined) continue
        if (result.ok === true) groups.push(result.findings ?? [])
        else {
          job.partial = true
          job.partialReasons.push(`${plan.chunks[index].files.length} 个文件未完成：${result.reason ?? 'unknown'}`)
        }
      }
      if (groups.length === 0 && plan.chunks.length > 0) {
        const allHard = results.every((result) => result !== undefined && result.ok !== true && result.hard === true)
        // Every chunk failed at the transport level (auth, provider, timeout):
        // an error is more honest than a "partial" success with no data. Pure
        // parse failures keep `done + partial` so the user sees the diagnostic.
        if (allHard) throw new AppError('LLM_ERROR', `${USER_MESSAGES.LLM_ERROR}：${job.partialReasons[0] ?? '全部分块失败'}`)
      }
      job.phase = 'merging'
      const merged = mergeFindings(groups)
      job.findings = merged.findings
      job.overview = job.partial && merged.findings.length === 0
        ? `部分内容未能完成审查（${job.partialReasons.length} 个文件块失败）`
        : merged.overview
      job.state = 'done'
      job.phase = 'done'
      job.endedAt = this.now()
    } catch (error) {
      if (job.cancelled === true) {
        job.state = 'cancelled'
      } else {
        job.state = 'error'
        job.error = publicReviewError(error)
      }
      job.phase = 'done'
      job.endedAt = this.now()
    }
  }

  /**
   * One chunk: stream a completion, parse findings, retry once on malformed
   * JSON. Throws only for transport/auth/timeout failures; a second malformed
   * answer resolves `{ ok: false }` so the rest of the chunks still run.
   * @param {any} job - owning job.
   * @param {string} prompt - user prompt.
   * @param {Set<string>} allowedFiles - file whitelist for validation.
   * @param {number} chunkIndex - chunk position (diagnostics only).
   * @returns {Promise<{ ok: true, findings: any[] } | { ok: false, reason: string }>} chunk result.
   */
  async reviewChunk(job, prompt, allowedFiles, chunkIndex) {
    const first = await this.complete(job, prompt)
    const parsed = parseFindingsText(first.text, { allowedFiles })
    if (parsed.ok) return parsed
    this.logger?.warn?.(`dsh-codex-review: chunk ${chunkIndex + 1} returned unparsable JSON, retrying once`)
    const second = await this.complete(job, prompt + RETRY_SUFFIX)
    const retried = parseFindingsText(second.text, { allowedFiles })
    if (retried.ok) return retried
    // A clean chunk sometimes comes back as one prose sentence instead of the
    // requested JSON; score it as reviewed-and-clean instead of partial.
    if (looksLikeNoFindings(first.text) || looksLikeNoFindings(second.text)) return { ok: true, findings: [] }
    // Diagnose the common truncation case: the model spent the output budget
    // on hidden reasoning without emitting JSON, which a bare
    // "no-json-object" hides from the user.
    const last = second.finish
    const diagnostics = last.kind !== 'stop' || last.textChars === 0
      ? `（模型返回 ${last.kind}，可见输出 ${last.textChars} 字，推理 ${last.reasoningChars} 字${last.usage === undefined ? '' : `，tokens ${JSON.stringify(last.usage)}`}）`
      : ''
    return { ok: false, reason: `${retried.reason}${diagnostics}` }
  }

  /**
   * Perform one model call and join its text deltas.
   * @param {any} job - owning job.
   * @param {string} prompt - user prompt.
   * @returns {Promise<{ text: string, finish: { kind: string, textChars: number, reasoningChars: number, usage?: any } }>} accumulated answer text plus finish diagnostics.
   */
  async complete(job, prompt) {
    if (!this.available()) throw new AppError('LLM_UNAVAILABLE')
    const model = job.model
    const controller = new AbortController()
    const abortFromJob = () => controller.abort(job.controller.signal.reason)
    job.controller.signal.addEventListener('abort', abortFromJob, { once: true })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort(new Error('review call deadline exceeded'))
    }, this.callTimeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
    try {
      /** @type {AsyncIterable<any>} */
      let stream
      try {
        stream = await this.streamLlm({
          provider: model.provider,
          model: model.model,
          system: REVIEW_SYSTEM_PROMPT,
          messages: [{ role: REVIEW_REQUEST_ROLE, content: [{ type: 'text', text: prompt }] }],
          maxTokens: this.config.maxOutputTokens > 0 ? this.config.maxOutputTokens : undefined,
          // The active provider routes an auxiliary request by session: the
          // `opencode-go` route rejects a request without `x-opencode-session`
          // (Missing SessionID). One stable synthetic id per review job keeps
          // the auxiliary calls routable and prompt-cache coherent without
          // borrowing the user's live conversation session.
          sessionId: job.id,
          signal: controller.signal,
        })
      } catch (error) {
        if (job.cancelled === true) throw new AppError('INTERNAL', '审查任务被取消')
        if (timedOut === true) throw new AppError('REVIEW_TIMEOUT')
        throw mapLlmFailure(error)
      }
      let text = ''
      let reasoningChars = 0
      /** @type {any} */
      let usage
      /** @type {any} */
      let reason
      try {
        for await (const chunk of stream) {
          if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
          else if (chunk?.type === 'reasoning-delta' && typeof chunk.text === 'string') reasoningChars += chunk.text.length
          else if (chunk?.type === 'usage') usage = chunk.usage ?? chunk
          else if (chunk?.type === 'finish') reason = chunk.reason
        }
      } catch (error) {
        if (job.cancelled === true) throw new AppError('INTERNAL', '审查任务被取消')
        if (timedOut === true) throw new AppError('REVIEW_TIMEOUT')
        throw mapLlmFailure(error)
      }
      if (timedOut === true) throw new AppError('REVIEW_TIMEOUT')
      const finish = { kind: reason?.kind ?? 'stop', textChars: text.length, reasoningChars, usage }
      job.lastFinish = finish
      if (reason?.kind === 'error') throw mapLlmFailure(reason.failure)
      if (reason?.kind === 'max-tokens') job.maxTokenCalls += 1
      if (reason?.kind === 'aborted') {
        if (job.cancelled === true) throw new AppError('INTERNAL', '审查任务被取消')
        throw new AppError('LLM_ERROR', `${USER_MESSAGES.LLM_ERROR}：模型请求被中止`)
      }
      return { text, finish }
    } finally {
      clearTimeout(timer)
      job.controller.signal.removeEventListener('abort', abortFromJob)
    }
  }
}

/**
 * Last-resort shape for a failed job.
 * @param {unknown} error - thrown value.
 * @returns {{ code: string, message: string }} public error.
 */
function publicReviewError(error) {
  if (error instanceof AppError) return { code: error.code, message: error.message }
  return { code: 'INTERNAL', message: USER_MESSAGES.INTERNAL }
}

/**
 * Map a model failure (thrown or carried by a finish chunk) onto `LLM_ERROR`,
 * keeping the provider's own code/message as a short diagnostic suffix.
 * @param {any} failure - error-like value with optional `code`/`message`.
 * @returns {AppError} LLM_ERROR with the original summary appended.
 */
function mapLlmFailure(failure) {
  if (failure instanceof AppError) return failure
  const detail = [failure?.code, failure?.message]
    .filter((part) => typeof part === 'string' && part !== '')
    .join(': ')
  const suffix = detail === '' ? '' : `（${detail.slice(0, 300)}）`
  return new AppError('LLM_ERROR', `${USER_MESSAGES.LLM_ERROR}${suffix}`)
}

/**
 * Build the stable job key for one PR head.
 * @param {string} repo - `owner/name`.
 * @param {number} number - PR number.
 * @param {string} headSha - head commit.
 * @returns {string} job key.
 */
function jobKey(repo, number, headSha) {
  return `${repo}#${number}@${headSha}`
}
