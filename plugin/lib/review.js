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
import { LruCache, truncateText } from './github.js'

/** Fixed system prompt (CONTRACT §1.5). */
export const REVIEW_SYSTEM_PROMPT = [
  '你是资深代码审查者。只报告本次 diff 引入的真实缺陷：正确性、安全、数据一致性、并发、边界条件、API 契约破坏、性能回归、测试缺失导致的回归风险。',
  '不要报告纯风格/格式/命名偏好，不要报告 diff 之外的问题，不要复述代码。',
  '严重度定义：P0 = 会崩溃/损坏数据/安全问题/结果明显错误，必须修复；P1 = 常见场景下会出错或明显劣化功能、性能，应当修复；P2 = 边界条件、健壮性、可维护性问题，建议修复。',
  '输出严格 JSON，不要 markdown 代码围栏。',
].join('')

/** Fixed system prompt of the deep-depth verification round (CONTRACT §4.1). */
export const VERIFY_SYSTEM_PROMPT = [
  '你是资深代码审查者，负责复核审查结论的证据强度。',
  '每条待复核结论都声称本次 diff 引入了缺陷，并附有它声称支持的 patch 行。',
  '只根据给出的 patch 行原文判断该结论是否确有 diff 证据支持（能定位到具体改动行）；不要凭常识补充证据，不要因为「可能有问题」而保留。',
  '证据不足、定位不到对应改动行、或 patch 行与结论无关的，一律丢弃。',
  '输出严格 JSON，不要 markdown 代码围栏。',
].join('')

/** Allowed finding severities, worst first. */
export const SEVERITIES = Object.freeze(['P0', 'P1', 'P2'])

/** Allowed finding categories. */
export const CATEGORIES = Object.freeze(['correctness', 'security', 'data', 'concurrency', 'performance', 'api', 'test'])

/** Allowed review depths, cheapest first (CONTRACT §4.1). */
export const DEPTHS = Object.freeze(['fast', 'standard', 'deep'])

/** Allowed severity thresholds; a finding is kept when its rank is at or above the threshold. */
export const SEVERITY_THRESHOLDS = SEVERITIES

/** Self-rated confidence levels a finding may carry (CONTRACT §4.2). */
export const CONFIDENCE_LEVELS = Object.freeze(['high', 'medium', 'low'])

/** Character cap for the quoted diff evidence of one finding (CONTRACT §4.2). */
export const EVIDENCE_MAX_CHARS = 200

/** Per-depth budgets (CONTRACT §4.1). */
export const DEPTH_PRESETS = Object.freeze({
  fast: Object.freeze({ chunkChars: 16_000, maxChunks: 6, concurrency: 4 }),
  standard: Object.freeze({ chunkChars: 9_000, maxChunks: 9, concurrency: 3 }),
  deep: Object.freeze({ chunkChars: 6_000, maxChunks: 20, concurrency: 2 }),
})

/** Default review options (CONTRACT §4.1). */
export const DEFAULT_REVIEW_OPTIONS = Object.freeze({
  depth: 'standard',
  severityThreshold: 'P2',
  includeGuidelines: true,
})

/** File-level incremental cache bound (CONTRACT §4.3). */
export const FILE_CACHE_MAX = 400

/** Character budget for the PR body inside one prompt (CONTRACT §1.5). */
const PROMPT_BODY_CHARS = 4_000

/** Title cap for one finding. */
const FINDING_TITLE_CHARS = 80

/** Context lines included around a finding when quoting its patch for the verification round. */
const VERIFICATION_CONTEXT_LINES = 3

/**
 * Resolve the caller's raw review options into the concrete budgets the engine
 * uses (CONTRACT §4.1). Unknown values fall back to the defaults rather than
 * failing the request, and the standard depth honours the plugin's configured
 * chunk budgets (whose defaults equal the contract's standard preset).
 * @param {{ depth?: unknown, severityThreshold?: unknown, includeGuidelines?: unknown } | undefined | null} options - raw options from `review-start`.
 * @param {{ reviewChunkChars?: number, maxChunks?: number, reviewConcurrency?: number }} [config] - resolved plugin config.
 * @returns {{ depth: 'fast' | 'standard' | 'deep', severityThreshold: 'P0' | 'P1' | 'P2', includeGuidelines: boolean, chunkChars: number, maxChunks: number, concurrency: number }} resolved options.
 */
export function resolveReviewOptions(options, config = {}) {
  const source = options !== null && typeof options === 'object' ? options : {}
  const depth = DEPTHS.includes(source.depth) ? /** @type {'fast' | 'standard' | 'deep'} */ (source.depth) : DEFAULT_REVIEW_OPTIONS.depth
  const severityThreshold = SEVERITY_THRESHOLDS.includes(source.severityThreshold)
    ? /** @type {'P0' | 'P1' | 'P2'} */ (source.severityThreshold)
    : DEFAULT_REVIEW_OPTIONS.severityThreshold
  const includeGuidelines = source.includeGuidelines !== false
  const preset = DEPTH_PRESETS[depth]
  const standard = depth === 'standard'
  return {
    depth,
    severityThreshold,
    includeGuidelines,
    chunkChars: standard && Number.isFinite(config.reviewChunkChars) ? Math.round(config.reviewChunkChars) : preset.chunkChars,
    maxChunks: standard && Number.isFinite(config.maxChunks) ? Math.round(config.maxChunks) : preset.maxChunks,
    concurrency: standard && Number.isFinite(config.reviewConcurrency) ? Math.round(config.reviewConcurrency) : preset.concurrency,
  }
}

/**
 * Stable job key for one PR head and one resolved option set (CONTRACT §4.1).
 * A different depth/threshold/guideline choice starts a different job, while
 * the same choice on the same head reuses the finished one.
 * @param {string} repo - `owner/name`.
 * @param {number} number - PR number.
 * @param {string} headSha - head commit.
 * @param {ReturnType<typeof resolveReviewOptions>} options - resolved options.
 * @returns {string} job key.
 */
export function buildReviewJobKey(repo, number, headSha, options) {
  return `${repo}#${number}@${headSha}|${options.depth}|${options.severityThreshold}|${options.includeGuidelines === false ? '0' : '1'}`
}

/**
 * Keep only the findings at or above the severity threshold.
 * @param {Array<{ severity: string }>} findings - merged findings.
 * @param {'P0' | 'P1' | 'P2'} threshold - worst severity that is still reported.
 * @returns {Array<any>} filtered copy.
 */
export function filterFindingsByThreshold(findings, threshold) {
  const list = Array.isArray(findings) ? findings : []
  const cutoff = SEVERITY_THRESHOLDS.indexOf(threshold)
  if (cutoff === -1 || cutoff === SEVERITY_THRESHOLDS.length - 1) return list.slice()
  return list.filter((finding) => {
    const rank = SEVERITY_THRESHOLDS.indexOf(finding?.severity)
    return rank !== -1 && rank <= cutoff
  })
}

/**
 * Derive the merge verdict from the (already threshold-filtered) findings.
 * @param {Array<{ severity: string }>} findings - findings the user will see.
 * @returns {'block' | 'changes' | 'approve'} verdict.
 */
export function deriveVerdict(findings) {
  const list = Array.isArray(findings) ? findings : []
  if (list.some((finding) => finding?.severity === 'P0')) return 'block'
  if (list.some((finding) => finding?.severity === 'P1')) return 'changes'
  return 'approve'
}

/**
 * File-level cache key (CONTRACT §4.3): one entry per file path and patch text.
 * The patch hash makes a changed file miss while an unchanged file keeps hitting,
 * independently of the review depth.
 * @param {string} repo - `owner/name`.
 * @param {number} number - PR number.
 * @param {string} path - file path.
 * @param {string} patch - unified diff hunks.
 * @returns {string} cache key.
 */
export function fileCacheKey(repo, number, path, patch) {
  const hash = createHash('sha1').update(typeof patch === 'string' ? patch : '').digest('hex')
  return `${repo}#${number}|${path}|${hash}`
}

/**
 * Normalize the guideline payload into the public `ReviewStatus.guidelines` shape.
 * @param {{ loaded?: boolean, files?: unknown, chars?: unknown, text?: unknown } | undefined | null} guidelines - loader output.
 * @returns {{ loaded: boolean, files: string[], chars: number }} status shape (never throws).
 */
export function summarizeGuidelines(guidelines) {
  const files = Array.isArray(guidelines?.files) ? guidelines.files.filter((file) => typeof file === 'string' && file !== '') : []
  const chars = Number.isFinite(guidelines?.chars) ? Math.max(0, Math.floor(/** @type {number} */ (guidelines.chars))) : 0
  return { loaded: guidelines?.loaded === true && files.length > 0, files, chars }
}

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
 * model can cite exact new-file line numbers. When the repository ships review
 * guidelines (AGENTS.md), they are injected as their own section of the user
 * prompt — never into the fixed system prompt — so they can only refine
 * preferences and cannot override the "only real diff defects" rule.
 * @param {{ pr: { repo?: string, number?: number, title?: string, body?: string, baseRefName?: string, headRefName?: string }, chunk: { files: any[] }, chunkIndex: number, chunkCount: number, guidelines?: string }} input - prompt data.
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
  const guidelines = typeof input.guidelines === 'string' ? input.guidelines.trim() : ''
  if (guidelines !== '') {
    lines.push('')
    lines.push('## 仓库审查指引')
    lines.push(guidelines)
    lines.push('以上指引仅作为该仓库特有的审查偏好；不得覆盖「只报告本次 diff 引入的真实缺陷」这一约束，也不要据此报告纯风格/格式/命名问题。')
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
  lines.push('{"findings":[{"severity":"P0"|"P1"|"P2","file":"路径","line":新文件行号,"lineEnd":可选,"title":"≤80字","why":"触发条件→后果","fix":"具体动作","category":"correctness|security|data|concurrency|performance|api|test","evidence":"支持结论的 diff 行原文（≤200字，可含 + / - 前缀）","confidence":"high"|"medium"|"low"}]}')
  lines.push('无问题返回 {"findings":[]}；即使本块没有问题也必须输出这个 JSON，不要用文字说明。')
  lines.push('最多 6 条发现，每条 why 与 fix 各不超过 60 字；不确定的不要报。')
  lines.push('file 必须来自上面列出的文件清单；line 必须是该文件 patch 中新增（+）或上下文行在新文件里的行号，不要用旧文件行号。')
  lines.push('evidence 必须逐字引用支持该结论的 diff 行原文（新增行保留 + 前缀，上下文行原样）；找不到可引用的行时省略该字段。')
  lines.push('confidence 是模型自评：high=确定有证据，medium=较可能，low=推测；不确定时省略该字段。')
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
 * @returns {{ severity: string, file: string, line: number, lineEnd?: number, title: string, why: string, fix: string, category?: string, evidence?: string, confidence?: string } | null} finding or null.
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
  /** @type {{ severity: string, file: string, line: number, lineEnd?: number, title: string, why: string, fix: string, category?: string, evidence?: string, confidence?: string }} */
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
  const evidence = typeof candidate.evidence === 'string' ? candidate.evidence.trim() : ''
  if (evidence !== '') finding.evidence = evidence.length > EVIDENCE_MAX_CHARS ? evidence.slice(0, EVIDENCE_MAX_CHARS) : evidence
  const confidence = typeof candidate.confidence === 'string' ? candidate.confidence.trim().toLowerCase() : ''
  if (CONFIDENCE_LEVELS.includes(confidence)) finding.confidence = confidence
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
 * Deterministic Chinese overview line. The count is always present (including
 * `0`) so callers can trust the string as a machine-checkable summary of the
 * findings set the user actually sees.
 * @param {Array<{ severity: string }>} findings - merged findings.
 * @returns {string} e.g. `共 3 个问题：P0 ×1 · P1 ×2`.
 */
export function buildOverview(findings) {
  if (!Array.isArray(findings) || findings.length === 0) return '共 0 个问题：AI 未发现明显问题'
  const counts = new Map(SEVERITIES.map((severity) => [severity, 0]))
  for (const finding of findings) counts.set(finding.severity, (counts.get(finding.severity) ?? 0) + 1)
  const parts = SEVERITIES.filter((severity) => (counts.get(severity) ?? 0) > 0).map((severity) => `${severity} ×${counts.get(severity)}`)
  return `共 ${findings.length} 个问题：${parts.join(' · ')}`
}

/**
 * Extract the patch lines around one finding, labelled with their new-file line
 * numbers, so the verification round can judge whether the finding is anchored
 * in the diff. Returns an empty string when the patch has no such line.
 * @param {string} patch - unified diff hunks of one file.
 * @param {number} line - finding start line on the new side.
 * @param {{ lineEnd?: number, context?: number }} [options] - range end and context width.
 * @returns {string} quoted patch lines (`<newLine>\t<diff line>`), or ''.
 */
export function extractPatchExcerpt(patch, line, options = {}) {
  if (typeof patch !== 'string' || patch === '') return ''
  const start = Number.isInteger(line) && line > 0 ? line : 0
  if (start === 0) return ''
  const end = Number.isInteger(options.lineEnd) && options.lineEnd >= start ? options.lineEnd : start
  const context = Number.isInteger(options.context) && options.context >= 0 ? options.context : VERIFICATION_CONTEXT_LINES
  /** @type {Array<{ newLine: number, text: string }>} */
  const entries = []
  let newLine = 0
  for (const raw of patch.split(/\r?\n/)) {
    if (raw === '') continue
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw)
    if (hunk !== null) {
      newLine = Number(hunk[1])
      continue
    }
    if (raw.startsWith('\\')) continue
    if (raw.startsWith('@@')) continue
    if (raw.startsWith('-')) continue
    if (raw.startsWith('+')) {
      entries.push({ newLine, text: raw })
      newLine += 1
      continue
    }
    entries.push({ newLine, text: raw })
    newLine += 1
  }
  let first = -1
  let last = -1
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    if (entry.newLine >= start && entry.newLine <= end) {
      if (first === -1) first = index
      last = index
    }
  }
  if (first === -1) return ''
  const from = Math.max(0, first - context)
  const to = Math.min(entries.length - 1, last + context)
  const lines = []
  for (let index = from; index <= to; index += 1) {
    const entry = entries[index]
    lines.push(`${String(entry.newLine).padStart(5, ' ')}\t${entry.text}`)
  }
  return lines.join('\n')
}

/**
 * Render the deep-depth verification prompt: every finding plus the patch lines
 * it claims to be about, and the `{ keep: [n...] }` answer schema.
 * @param {{ findings: Array<any>, files: Array<{ path: string, patch: string }> }} input - merged findings and the PR files.
 * @returns {string} verification prompt.
 */
export function buildVerificationPrompt(input) {
  const findings = Array.isArray(input?.findings) ? input.findings : []
  const files = Array.isArray(input?.files) ? input.files : []
  const byPath = new Map(files.filter((file) => typeof file?.path === 'string').map((file) => [file.path, file]))
  const lines = []
  lines.push('# 复核审查结论（只判断 diff 证据）')
  lines.push(`下面是本次审查得到的 ${findings.length} 条结论。请逐条判断：给出的 patch 行是否支持该结论。`)
  findings.forEach((finding, index) => {
    const file = byPath.get(finding.file)
    const excerpt = file === undefined ? '' : extractPatchExcerpt(file.patch, finding.line, { lineEnd: finding.lineEnd })
    lines.push('')
    lines.push(`[${index + 1}] ${finding.severity} · ${finding.file}:${finding.line}${finding.lineEnd === undefined ? '' : `-${finding.lineEnd}`} · ${finding.title}`)
    if (typeof finding.why === 'string' && finding.why !== '') lines.push(`为什么：${finding.why}`)
    if (typeof finding.fix === 'string' && finding.fix !== '') lines.push(`怎么改：${finding.fix}`)
    if (typeof finding.evidence === 'string' && finding.evidence !== '') lines.push(`声称的证据：${finding.evidence}`)
    lines.push('对应 patch 行（行号\t原文）：')
    lines.push(excerpt === '' ? '（未找到对应 patch 行）' : excerpt)
  })
  lines.push('')
  lines.push('## 输出要求')
  lines.push('只输出一个 JSON 对象，不要 markdown 代码围栏：{"keep":[有 diff 证据支持的结论编号]}。')
  lines.push('编号就是上面的 [N]。只保留你确认 patch 行确实支持其结论的编号；证据不足、patch 行与结论无关或定位不到的一律不列入。')
  lines.push('一条都不支持时输出 {"keep":[]}。不要输出任何解释。')
  return lines.join('\n')
}

/**
 * Parse a verification answer into the set of kept finding numbers (1-based).
 * @param {unknown} text - raw model output.
 * @returns {Set<number> | null} kept numbers, or null when the answer is unusable (caller keeps the original findings).
 */
export function parseVerificationKeep(text) {
  const jsonText = extractJsonObject(text)
  if (jsonText === null) return null
  /** @type {any} */
  let parsed
  try {
    parsed = JSON.parse(jsonText)
  } catch {
    return null
  }
  const raw = Array.isArray(parsed) ? parsed : parsed?.keep
  if (!Array.isArray(raw)) return null
  /** @type {Set<number>} */
  const keep = new Set()
  for (const value of raw) {
    const numeric = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN
    if (Number.isInteger(numeric) && numeric > 0) keep.add(numeric)
  }
  return keep
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
   * @param {{ streamLlm?: (request: any) => AsyncIterable<any>, resolveSelection?: () => { provider?: string, model?: string }, config?: any, logger?: any, now?: () => number, sleep?: () => Promise<void>, callTimeoutMs?: number, fileCacheMax?: number }} [options] - engine wiring.
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
    /**
     * File-level incremental cache (CONTRACT §4.3): key `repo#number|path|sha1(patch)`,
     * value = the validated findings attributed to that file. No TTL: a new
     * head changes the patches that changed, and the LRU bound caps memory.
     * @type {LruCache}
     */
    this.fileCacheMax = Number.isInteger(options.fileCacheMax) && options.fileCacheMax > 0 ? options.fileCacheMax : FILE_CACHE_MAX
    this.fileCache = new LruCache(this.fileCacheMax)
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
   * @param {{ repo: string, number: number, headSha: string, title?: string, body?: string, baseRefName?: string, headRefName?: string, files: any[], options?: any, guidelines?: any }} input - PR snapshot, raw review options and the preloaded repository guidelines.
   * @returns {{ jobId: string, headSha: string, cached: boolean, options: ReturnType<typeof resolveReviewOptions> }} job reference.
   * @throws {AppError} LLM_UNAVAILABLE when the model seam is missing.
   */
  start(input) {
    if (!this.available()) throw new AppError('LLM_UNAVAILABLE')
    const model = this.resolveModel()
    const options = resolveReviewOptions(input.options, this.config)
    const key = buildReviewJobKey(input.repo, input.number, input.headSha, options)
    const existing = this.findByKey(key)
    if (existing !== undefined) {
      if (existing.state === 'done') return { jobId: existing.id, headSha: existing.headSha, cached: true, options: existing.options }
      if (existing.state === 'running' || existing.state === 'queued') {
        return { jobId: existing.id, headSha: existing.headSha, cached: false, options: existing.options }
      }
    }
    const guidelinesDisabled = options.includeGuidelines === false
    const guidelines = guidelinesDisabled ? summarizeGuidelines(undefined) : summarizeGuidelines(input.guidelines)
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
      options,
      guidelines,
      guidelineText: guidelinesDisabled || typeof input.guidelines?.text !== 'string' ? '' : input.guidelines.text,
      reusedFiles: 0,
      verdict: undefined,
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
    return { jobId: job.id, headSha: job.headSha, cached: false, options: job.options }
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
      options: job.options,
      guidelines: job.guidelines,
      reusedFiles: job.reusedFiles,
    }
    if (job.verdict !== undefined) status.verdict = job.verdict
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
   * Several option variants may exist for the same head; the most recent one
   * wins because that is what the user last asked for.
   * @param {string} repo - `owner/name`.
   * @param {number} number - PR number.
   * @param {string} headSha - PR head SHA.
   * @returns {{ state: string, jobId?: string, headSha: string, findings: any[], overview?: string, error?: { code: string, message: string }, options?: any, guidelines?: any, reusedFiles?: number, verdict?: string, partial?: boolean, partialReasons?: string[] }} review snapshot.
   */
  existing(repo, number, headSha) {
    const job = this.findLatestForPull(repo, number, headSha)
    if (job === undefined) return { state: 'none', headSha, findings: [] }
    // PrDetail.review.state has no 'cancelled' member: a cancelled run is
    // reported as none so the UI offers a fresh review for the same head.
    const state = job.state === 'queued' || job.state === 'running'
      ? 'running'
      : job.state === 'done' ? 'done' : job.state === 'error' ? 'error' : 'none'
    /** @type {any} */
    const snapshot = {
      state,
      jobId: job.id,
      headSha,
      findings: job.findings,
      options: job.options,
      guidelines: job.guidelines,
      reusedFiles: job.reusedFiles,
      partial: job.partial === true,
    }
    if (job.verdict !== undefined) snapshot.verdict = job.verdict
    if (job.overview !== undefined) snapshot.overview = job.overview
    if (job.error !== undefined) snapshot.error = job.error
    if (Array.isArray(job.partialReasons) && job.partialReasons.length > 0) snapshot.partialReasons = job.partialReasons.slice()
    return snapshot
  }

  /** Abort every running job (plugin dispose). */
  dispose() {
    for (const job of this.jobs.values()) {
      if (job.state === 'queued' || job.state === 'running') this.cancel(job.id)
    }
    this.fileCache.clear()
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

  /**
   * Find the most recent job for one PR head regardless of its options.
   * @param {string} repo - `owner/name`.
   * @param {number} number - PR number.
   * @param {string} headSha - PR head SHA.
   * @returns {any | undefined} the job record.
   */
  findLatestForPull(repo, number, headSha) {
    /** @type {any} */
    let found
    for (const job of this.jobs.values()) {
      if (job.repo === repo && job.number === number && job.headSha === headSha) found = job
    }
    return found
  }

  /**
   * Whether one PR has a queued/running review job. The automatic reviewer
   * skips such PRs so it never starts a second job for the same PR.
   * @param {string} repo - `owner/name`.
   * @param {number} number - PR number.
   * @returns {boolean} true when a live job exists for the PR.
   */
  hasActiveJob(repo, number) {
    for (const job of this.jobs.values()) {
      if (job.repo === repo && job.number === number && (job.state === 'queued' || job.state === 'running')) return true
    }
    return false
  }

  /**
   * Resolve when one job reaches a terminal state (never rejects). Unknown ids
   * resolve immediately so a late call cannot keep the scheduler waiting.
   * @param {string} jobId - job id returned by {@link start}.
   * @returns {Promise<void>} resolves once the job settles.
   */
  waitForCompletion(jobId) {
    const job = this.jobs.get(jobId)
    if (job === undefined) return Promise.resolve()
    return Promise.resolve(job.done).then(() => undefined, () => undefined)
  }

  /**
   * Drop every review job (and file-cache entry) for one PR after a merge: the
   * reviewed head is no longer reachable through the PR, so its cached results
   * must never be shown again. Running jobs are cancelled first.
   * @param {string} repo - `owner/name`.
   * @param {number} number - PR number.
   * @returns {number} number of jobs removed.
   */
  invalidate(repo, number) {
    let removed = 0
    for (const [id, job] of [...this.jobs.entries()]) {
      if (job.repo !== repo || job.number !== number) continue
      if (job.state === 'queued' || job.state === 'running') this.cancel(id)
      this.jobs.delete(id)
      removed += 1
    }
    const prefix = `${repo}#${number}|`
    for (const key of [...this.fileCache.entries.keys()]) {
      if (key.startsWith(prefix)) this.fileCache.delete(key)
    }
    return removed
  }

  /**
   * Read the cached findings for one file, or undefined on a miss.
   * @param {string} repo - `owner/name`.
   * @param {number} number - PR number.
   * @param {{ path: string, patch: string }} file - reviewable file.
   * @returns {any[] | undefined} cached findings.
   */
  readFileCache(repo, number, file) {
    if (typeof file?.path !== 'string' || typeof file?.patch !== 'string') return undefined
    const cached = this.fileCache.get(fileCacheKey(repo, number, file.path, file.patch), this.now())
    return Array.isArray(cached) ? cached : undefined
  }

  /**
   * Store the findings of one successfully reviewed chunk, per file. A file
   * with no findings is cached with an empty list so a later review can reuse
   * the "reviewed and clean" verdict too.
   * @param {string} repo - `owner/name`.
   * @param {number} number - PR number.
   * @param {Array<{ path: string, patch: string }>} files - files of the chunk.
   * @param {any[]} findings - validated findings of the chunk.
   */
  storeFileCache(repo, number, files, findings) {
    for (const file of files) {
      if (typeof file?.path !== 'string' || typeof file?.patch !== 'string') continue
      const own = findings.filter((finding) => finding.file === file.path)
      this.fileCache.set(fileCacheKey(repo, number, file.path, file.patch), own, Number.POSITIVE_INFINITY, this.now())
    }
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
   *
   * Flow (CONTRACT §4.3): split the reviewable files into file-cache hits and
   * misses, send only the misses to the model (packed under the depth budget),
   * merge hit findings back in, filter by the severity threshold, optionally
   * run the deep verification round, then derive overview/verdict. Zero misses
   * means zero model calls and an immediate `done`.
   * @param {any} job - job record.
   * @param {{ files: any[], title?: string, body?: string, baseRefName?: string, headRefName?: string, repo: string, number: number }} input - PR snapshot.
   * @returns {Promise<void>} resolves when the job settles.
   */
  async run(job, input) {
    job.state = 'running'
    try {
      const options = job.options
      const reviewable = selectReviewableFiles(input.files)
      /** @type {Array<Array<any>>} */
      const reusedGroups = []
      /** @type {Array<any>} */
      const misses = []
      for (const file of reviewable) {
        const cached = this.readFileCache(job.repo, job.number, file)
        if (cached === undefined) misses.push(file)
        else reusedGroups.push(cached)
      }
      job.reusedFiles = reusedGroups.length
      const plan = chunkFiles(misses, { chunkChars: options.chunkChars, maxChunks: options.maxChunks })
      job.skippedFiles = plan.skippedFiles
      job.filesTotal = reusedGroups.length + plan.chunks.reduce((sum, chunk) => sum + chunk.files.length, 0)
      job.filesDone = reusedGroups.length
      if (plan.chunks.length === 0) {
        // Every reviewable file was served from the file-level cache (or there
        // was nothing to review): no model call is needed at all, so the deep
        // verification round is skipped as well (CONTRACT §4.3).
        job.phase = 'merging'
        await this.finalize(job, reusedGroups, [], { verify: false })
        return
      }
      job.phase = 'reviewing'
      /** @type {Array<{ ok: boolean, findings?: any[], reason?: string, hard?: boolean } | undefined>} */
      const results = new Array(plan.chunks.length)
      const concurrency = Math.max(1, Math.min(plan.chunks.length, options.concurrency))
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
            guidelines: job.guidelineText,
          })
          const allowedFiles = new Set(chunk.files.map((file) => file.path))
          try {
            results[index] = await this.reviewChunk(job, prompt, allowedFiles, index)
            if (results[index].ok === true) this.storeFileCache(job.repo, job.number, chunk.files, results[index].findings ?? [])
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
      const freshGroups = []
      for (let index = 0; index < results.length; index += 1) {
        const result = results[index]
        if (result === undefined) continue
        if (result.ok === true) freshGroups.push(result.findings ?? [])
        else {
          job.partial = true
          job.partialReasons.push(`${plan.chunks[index].files.length} 个文件未完成：${result.reason ?? 'unknown'}`)
        }
      }
      if (freshGroups.length === 0 && reusedGroups.length === 0 && plan.chunks.length > 0) {
        const allHard = results.every((result) => result !== undefined && result.ok !== true && result.hard === true)
        // Every chunk failed at the transport level (auth, provider, timeout):
        // an error is more honest than a "partial" success with no data. Pure
        // parse failures keep `done + partial` so the user sees the diagnostic.
        if (allHard) throw new AppError('LLM_ERROR', `${USER_MESSAGES.LLM_ERROR}：${job.partialReasons[0] ?? '全部分块失败'}`)
      }
      job.phase = 'merging'
      await this.finalize(job, [...reusedGroups, ...freshGroups], input.files)
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
   * Merge, threshold-filter, verify (deep only) and settle a job as `done`.
   * @param {any} job - job record.
   * @param {Array<Array<any>>} groups - findings per chunk / cache entry.
   * @param {any[]} [files] - PR files, used to quote patch lines for the verification round.
   * @param {{ verify?: boolean }} [options] - `verify:false` skips the deep verification round.
   * @returns {Promise<void>} resolves once the job is settled.
   */
  async finalize(job, groups, files = [], options = {}) {
    const merged = mergeFindings(groups)
    let findings = filterFindingsByThreshold(merged.findings, job.options.severityThreshold)
    if (options.verify !== false && job.options.depth === 'deep' && findings.length > 0) {
      findings = await this.verifyFindings(job, findings, files)
    }
    job.findings = findings
    job.overview = job.partial && findings.length === 0
      ? `部分内容未能完成审查（${job.partialReasons.length} 个文件块失败）`
      : buildOverview(findings)
    job.verdict = deriveVerdict(findings)
    job.state = 'done'
    job.phase = 'done'
    job.endedAt = this.now()
  }

  /**
   * Deep-depth verification round (CONTRACT §4.1): send each finding plus the
   * patch lines it points at back to the model and keep only the findings it
   * judges to be backed by the diff. A failed round never loses results: the
   * original findings are kept and the job is marked `partial`.
   * @param {any} job - job record.
   * @param {any[]} findings - threshold-filtered findings.
   * @param {any[]} files - PR files.
   * @returns {Promise<any[]>} kept findings.
   */
  async verifyFindings(job, findings, files) {
    try {
      const prompt = buildVerificationPrompt({ findings, files })
      const answer = await this.complete(job, prompt, VERIFY_SYSTEM_PROMPT)
      const keep = parseVerificationKeep(answer.text)
      if (keep === null) {
        job.partial = true
        job.partialReasons.push('复核轮输出无法解析，已保留原始结论')
        return findings
      }
      return findings.filter((finding, index) => keep.has(index + 1))
    } catch (error) {
      if (job.cancelled === true) throw error
      job.partial = true
      job.partialReasons.push(`复核轮失败：${publicReviewError(error).message}`)
      return findings
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
   * @param {string} [systemPrompt] - system prompt; the review prompt unless the verification round passes its own.
   * @returns {Promise<{ text: string, finish: { kind: string, textChars: number, reasoningChars: number, usage?: any } }>} accumulated answer text plus finish diagnostics.
   */
  async complete(job, prompt, systemPrompt = REVIEW_SYSTEM_PROMPT) {
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
          system: systemPrompt,
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
