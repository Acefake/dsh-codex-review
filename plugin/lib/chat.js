/**
 * PR chat feature of dsh-codex-review (CONTRACT §5.2).
 *
 * This module is pure: request validation, the bounded PR-context renderer, the
 * SSE frame encoders and the per-plugin concurrency limiter. The HTTP transport
 * lives in `lib/http.js` and the model call lives in `index.js`, so every rule
 * here is unit-testable without a host, a network or a model.
 * @module dsh-codex-review/lib/chat
 */

import { AppError, USER_MESSAGES, badRequest } from './errors.js'

/** Fixed chat system prompt (CONTRACT §5.2). */
export const CHAT_SYSTEM_PROMPT = '你是该 Pull Request 的代码审查助手。只依据给出的 PR 信息回答；不确定就直说，不要编造文件或行号。回答用中文、简洁，可用列表/代码片段。'

/** Hard character budget for one chat request (system + context + history). */
export const CHAT_CONTEXT_BUDGET_CHARS = 24_000

/** Character budget reserved for the conversation history even in a worst-case context. */
const CHAT_HISTORY_RESERVE_CHARS = 1_500

/** PR body budget inside the context (CONTRACT §5.2). */
export const CHAT_PR_BODY_MAX_CHARS = 3_000

/** `focusFile` patch budget inside the context (CONTRACT §5.2). */
export const CHAT_FOCUS_PATCH_MAX_CHARS = 4_000

/** Findings shown from the latest AI review (CONTRACT §5.2). */
export const CHAT_REVIEW_FINDINGS_MAX = 30

/** Conversation-history limits (CONTRACT §5.2). */
export const CHAT_HISTORY_MAX_MESSAGES = 10
export const CHAT_HISTORY_MESSAGE_MAX_CHARS = 4_000

/** Request-body limits for the chat route (CONTRACT §5.2). */
export const CHAT_REQUEST_MESSAGES_MAX = 20
export const CHAT_REQUEST_MESSAGE_MAX_CHARS = 4_000
export const CHAT_FOCUS_FILE_MAX_CHARS = 512

/** Concurrent chat streams allowed per process (CONTRACT §5.2). */
export const CHAT_CONCURRENCY = 2

/** One chat answer deadline (CONTRACT §5.2). */
export const CHAT_CALL_TIMEOUT_MS = 180_000

/** Whole chat request deadline (CONTRACT §5.2). */
export const CHAT_REQUEST_DEADLINE_MS = 300_000

/** Changed files listed in the context before summarising the rest. */
const CONTEXT_FILE_LIST_MAX = 40

/** `owner/name` shape accepted from the browser; mirrors github.js `REPO_RE` (kept local to avoid an import cycle). */
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

/** Marker appended to any truncated context block. */
const TRUNCATION_MARKER = '…（已截断）'

/**
 * Truncate one string to a character budget, appending a marker when it does
 * not fit. The return value never exceeds `maxChars`.
 * @param {unknown} value - candidate text.
 * @param {number} maxChars - hard cap (characters).
 * @param {string} [marker] - truncation marker.
 * @returns {string} bounded text.
 */
export function truncateChars(value, maxChars, marker = TRUNCATION_MARKER) {
  const text = typeof value === 'string' ? value : ''
  if (!Number.isFinite(maxChars) || maxChars <= 0) return ''
  if (text.length <= maxChars) return text
  if (marker.length >= maxChars) return text.slice(0, maxChars)
  return text.slice(0, maxChars - marker.length) + marker
}

/**
 * Validate `POST /codex-review/chat` into the shape the context builder and the
 * model call need. Unknown fields are ignored; every violated contract rule is
 * a `BAD_REQUEST`.
 * @param {Record<string, unknown>} payload - parsed request body.
 * @returns {{ repo: string, number: number, messages: Array<{ role: 'user' | 'assistant', content: string }>, focusFile?: string }} normalized request.
 * @throws {AppError} BAD_REQUEST for a malformed request.
 */
export function validateChatRequest(payload) {
  const body = payload !== null && typeof payload === 'object' ? payload : {}
  const repo = typeof body.repo === 'string' ? body.repo.trim() : ''
  if (!REPO_PATTERN.test(repo)) throw badRequest('repo 必须是 owner/name 形式')
  const rawNumber = body.number
  const number = typeof rawNumber === 'number' ? rawNumber : typeof rawNumber === 'string' ? Number(rawNumber) : Number.NaN
  if (!Number.isInteger(number) || number <= 0) throw badRequest('number 必须是正整数')
  const messages = body.messages
  if (!Array.isArray(messages) || messages.length === 0) throw badRequest('messages 必须是非空数组')
  if (messages.length > CHAT_REQUEST_MESSAGES_MAX) throw badRequest(`messages 最多 ${CHAT_REQUEST_MESSAGES_MAX} 条`)
  /** @type {Array<{ role: 'user' | 'assistant', content: string }>} */
  const normalized = []
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    if (message === null || typeof message !== 'object') throw badRequest(`messages[${index}] 必须是对象`)
    const role = message.role
    if (role !== 'user' && role !== 'assistant') throw badRequest(`messages[${index}].role 必须是 user 或 assistant`)
    const content = typeof message.content === 'string' ? message.content.trim() : ''
    if (content === '') throw badRequest(`messages[${index}].content 不能为空`)
    if (content.length > CHAT_REQUEST_MESSAGE_MAX_CHARS) throw badRequest(`messages[${index}].content 超过 ${CHAT_REQUEST_MESSAGE_MAX_CHARS} 字`)
    normalized.push({ role, content })
  }
  if (normalized[normalized.length - 1].role !== 'user') throw badRequest('最后一条消息必须是 user')
  /** @type {string | undefined} */
  let focusFile
  const rawFocus = body.focusFile
  if (rawFocus !== undefined && rawFocus !== null) {
    if (typeof rawFocus !== 'string') throw badRequest('focusFile 必须是字符串')
    const trimmed = rawFocus.trim()
    if (trimmed !== '') {
      if (trimmed.length > CHAT_FOCUS_FILE_MAX_CHARS) throw badRequest(`focusFile 超过 ${CHAT_FOCUS_FILE_MAX_CHARS} 字`)
      focusFile = trimmed
    }
  }
  return { repo, number, messages: normalized, focusFile }
}

/**
 * Render the PR meta block: identity, branch, totals and the changed-file list.
 * @param {any} detail - normalized `PrDetail` (plus `summary`).
 * @returns {string} context block ('' when there is nothing to say).
 */
export function formatPullMeta(detail) {
  const summary = detail?.summary ?? {}
  const files = Array.isArray(detail?.files) ? detail.files : []
  if (summary.repo === undefined && summary.title === undefined && files.length === 0) return ''
  const lines = ['# Pull Request 上下文']
  lines.push(`- 仓库：${summary.repo ?? ''}`)
  lines.push(`- 编号：#${summary.number ?? '?'}`)
  lines.push(`- 标题：${summary.title ?? ''}`)
  lines.push(`- 作者：${summary.author ?? 'ghost'}`)
  lines.push(`- 状态：${summary.state === 'closed' ? '已关闭' : '打开'}${summary.isDraft === true ? '（草稿）' : ''}`)
  lines.push(`- 分支：${summary.headRefName ?? '?'} → ${summary.baseRefName ?? '?'}`)
  lines.push(`- 变更：+${summary.additions ?? 0} −${summary.deletions ?? 0}，${summary.changedFiles ?? files.length} 个文件`)
  if (files.length > 0) {
    lines.push('')
    lines.push('## 变更文件')
    for (const file of files.slice(0, CONTEXT_FILE_LIST_MAX)) {
      lines.push(`- \`${file?.path ?? '?'}\` [${file?.status ?? 'modified'}] +${file?.additions ?? 0} −${file?.deletions ?? 0}`)
    }
    if (files.length > CONTEXT_FILE_LIST_MAX) lines.push(`- …还有 ${files.length - CONTEXT_FILE_LIST_MAX} 个文件`)
  }
  return lines.join('\n')
}

/**
 * Render the PR body block, capped by {@link CHAT_PR_BODY_MAX_CHARS}.
 * @param {unknown} body - PR body markdown.
 * @returns {string} context block ('' when empty).
 */
export function formatPullBody(body) {
  const text = typeof body === 'string' ? body.trim() : ''
  if (text === '') return ''
  return `## PR 正文\n${truncateChars(text, CHAT_PR_BODY_MAX_CHARS)}`
}

/**
 * Render the latest AI review summary block (overview + up to 30 findings).
 * Only a completed review (`state: 'done'`) is included.
 * @param {any} review - `PrDetail.review` snapshot.
 * @returns {string} context block ('' when no completed review exists).
 */
export function formatReviewSummary(review) {
  if (review === null || typeof review !== 'object' || review.state !== 'done') return ''
  const findings = Array.isArray(review.findings) ? review.findings : []
  const lines = ['## 最近一次 AI 审查']
  if (typeof review.overview === 'string' && review.overview !== '') lines.push(review.overview)
  for (const finding of findings.slice(0, CHAT_REVIEW_FINDINGS_MAX)) {
    const location = finding?.line === undefined ? String(finding?.file ?? '?') : `${finding.file ?? '?'}:${finding.line}`
    lines.push(`- ${finding?.severity ?? 'P2'} ${location} ${finding?.title ?? ''}`.trim())
  }
  if (findings.length > CHAT_REVIEW_FINDINGS_MAX) lines.push(`- …还有 ${findings.length - CHAT_REVIEW_FINDINGS_MAX} 条`)
  return lines.join('\n')
}

/**
 * Render the `focusFile` block: that file's patch capped at
 * {@link CHAT_FOCUS_PATCH_MAX_CHARS}, or an honest note when it is not in the
 * PR's diff.
 * @param {any} detail - normalized `PrDetail`.
 * @param {string | undefined} focusFile - file path picked by the UI.
 * @returns {string} context block ('' when no file was focused).
 */
export function formatFocusFile(detail, focusFile) {
  if (typeof focusFile !== 'string' || focusFile === '') return ''
  const files = Array.isArray(detail?.files) ? detail.files : []
  const file = files.find((candidate) => candidate?.path === focusFile)
  const lines = [`## 当前展开文件：${focusFile}`]
  if (file === undefined) {
    lines.push('（本次 PR 的 diff 中没有这个文件，请勿编造它的内容。）')
  } else if (typeof file.patch !== 'string' || file.patch === '') {
    lines.push('（该文件没有可用的 diff 文本，可能是二进制文件或缺失 patch。）')
  } else {
    lines.push('```diff')
    lines.push(truncateChars(file.patch, CHAT_FOCUS_PATCH_MAX_CHARS))
    lines.push('```')
  }
  return lines.join('\n')
}

/**
 * Pick the conversation history the model receives: the last
 * {@link CHAT_HISTORY_MAX_MESSAGES} messages, each capped at
 * {@link CHAT_HISTORY_MESSAGE_MAX_CHARS}, then drop the oldest entries until the
 * whole history fits `maxChars`. The newest message is always kept (truncated
 * as a last resort).
 * @param {Array<{ role: 'user' | 'assistant', content: string }>} messages - validated request messages.
 * @param {{ maxChars?: number, maxMessages?: number, messageMaxChars?: number }} [options] - budget overrides.
 * @returns {Array<{ role: 'user' | 'assistant', content: string }>} bounded history.
 */
export function selectChatHistory(messages, options = {}) {
  const maxChars = Number.isFinite(options.maxChars) ? Math.max(0, Math.floor(options.maxChars)) : CHAT_CONTEXT_BUDGET_CHARS
  const maxMessages = Number.isInteger(options.maxMessages) && options.maxMessages > 0 ? options.maxMessages : CHAT_HISTORY_MAX_MESSAGES
  const messageMaxChars = Number.isInteger(options.messageMaxChars) && options.messageMaxChars > 0 ? options.messageMaxChars : CHAT_HISTORY_MESSAGE_MAX_CHARS
  const list = Array.isArray(messages) ? messages.filter((message) => message !== null && typeof message === 'object') : []
  /** @type {Array<{ role: 'user' | 'assistant', content: string }>} */
  const selected = list.slice(-maxMessages).map((message) => ({
    role: message.role === 'assistant' ? 'assistant' : 'user',
    content: truncateChars(message.content, messageMaxChars),
  }))
  let total = selected.reduce((sum, message) => sum + message.content.length, 0)
  while (total > maxChars && selected.length > 1) {
    const removed = /** @type {{ content: string }} */ (selected.shift())
    total -= removed.content.length
  }
  if (selected.length === 1 && total > maxChars) {
    selected[0] = { role: selected[0].role, content: truncateChars(selected[0].content, maxChars) }
  }
  return selected
}

/**
 * Build the complete chat context under the hard budget: fixed system prompt +
 * PR meta/body/review/focus blocks in the system message, bounded conversation
 * history as chat messages. `stats.totalChars` is guaranteed ≤
 * {@link CHAT_CONTEXT_BUDGET_CHARS}.
 * @param {{ detail?: any, review?: any, focusFile?: string, messages?: Array<{ role: 'user' | 'assistant', content: string }> }} input - PR snapshot, review snapshot, focus path and history.
 * @returns {{ system: string, messages: Array<{ role: 'user' | 'assistant', content: string }>, stats: { systemChars: number, historyChars: number, totalChars: number } }} model-ready context.
 */
export function buildChatContext(input = {}) {
  const blocks = [
    formatPullMeta(input.detail),
    formatPullBody(input.detail?.body),
    formatReviewSummary(input.review),
    formatFocusFile(input.detail, input.focusFile),
  ].filter((block) => block !== '')
  const contextBudget = CHAT_CONTEXT_BUDGET_CHARS - CHAT_SYSTEM_PROMPT.length - CHAT_HISTORY_RESERVE_CHARS
  let contextText = blocks.join('\n\n')
  if (contextText.length > contextBudget) contextText = truncateChars(contextText, contextBudget)
  const system = contextText === '' ? CHAT_SYSTEM_PROMPT : `${CHAT_SYSTEM_PROMPT}\n\n${contextText}`
  const historyBudget = Math.max(0, CHAT_CONTEXT_BUDGET_CHARS - system.length)
  const messages = selectChatHistory(input.messages, { maxChars: historyBudget })
  const historyChars = messages.reduce((sum, message) => sum + message.content.length, 0)
  return {
    system,
    messages,
    stats: { systemChars: system.length, historyChars, totalChars: system.length + historyChars },
  }
}

/**
 * Convert chat history into the provider message shape used by every other
 * auxiliary call in this plugin.
 * @param {Array<{ role: 'user' | 'assistant', content: string }>} messages - bounded history.
 * @returns {Array<{ role: string, content: Array<{ type: 'text', text: string }> }>} provider messages.
 */
export function toModelMessages(messages) {
  return (Array.isArray(messages) ? messages : []).map((message) => ({
    role: message.role,
    content: [{ type: 'text', text: message.content }],
  }))
}

/**
 * Encode one SSE frame (`data: <json>\n\n`, CONTRACT §5.2).
 * @param {Record<string, unknown>} frame - JSON-serializable frame.
 * @returns {string} one SSE event.
 */
export function encodeSseFrame(frame) {
  return `data: ${JSON.stringify(frame)}\n\n`
}

/**
 * Encode one text delta frame.
 * @param {unknown} delta - text piece.
 * @returns {string} SSE event.
 */
export function encodeSseDelta(delta) {
  return encodeSseFrame({ delta: typeof delta === 'string' ? delta : String(delta ?? '') })
}

/**
 * Encode the terminal done frame.
 * @param {{ model?: { provider?: string, model?: string }, usage?: unknown }} [input] - model identity and usage.
 * @returns {string} SSE event.
 */
export function encodeSseDone(input = {}) {
  /** @type {Record<string, unknown>} */
  const frame = { done: true }
  if (input.model !== undefined && input.model !== null) {
    frame.model = { provider: String(input.model.provider ?? ''), model: String(input.model.model ?? '') }
  }
  if (input.usage !== undefined && input.usage !== null) frame.usage = input.usage
  return encodeSseFrame(frame)
}

/**
 * Encode an error frame and close the stream.
 * @param {{ code?: unknown, message?: unknown }} error - public error shape.
 * @returns {string} SSE event.
 */
export function encodeSseError(error) {
  const code = typeof error?.code === 'string' && error.code !== '' ? error.code : 'INTERNAL'
  const fallback = USER_MESSAGES[code] ?? USER_MESSAGES.INTERNAL
  const message = typeof error?.message === 'string' && error.message !== '' ? error.message : fallback
  return encodeSseFrame({ error: { code, message } })
}

/**
 * Map a thrown model/transport failure onto the chat error shape
 * (`LLM_ERROR` for provider failures, the AppError code otherwise).
 * @param {unknown} error - thrown value.
 * @param {{ timedOut?: boolean }} [options] - deadline flag.
 * @returns {{ code: string, message: string }} public error.
 */
export function mapChatFailure(error, options = {}) {
  if (options.timedOut === true) return { code: 'LLM_ERROR', message: 'AI 回答超时，请重试' }
  if (error instanceof AppError) return { code: error.code, message: error.message }
  const detail = [error?.code, error?.message]
    .filter((part) => typeof part === 'string' && part !== '')
    .join(': ')
  const suffix = detail === '' ? '' : `（${detail.slice(0, 300)}）`
  return { code: 'LLM_ERROR', message: `${USER_MESSAGES.LLM_ERROR}${suffix}` }
}

/**
 * Bounded concurrency limiter for chat streams. Each acquired stream owns one
 * `AbortController`, so a plugin dispose can abort every live upstream call.
 * @param {number} [limit] - concurrent stream cap.
 * @returns {{ active: number, limit: number, tryAcquire: (controller: AbortController) => boolean, release: (controller: AbortController) => void, abortAll: (reason?: unknown) => number }} limiter.
 */
export function createChatLimiter(limit = CHAT_CONCURRENCY) {
  const max = Number.isInteger(limit) && limit > 0 ? limit : CHAT_CONCURRENCY
  /** @type {Set<AbortController>} */
  const controllers = new Set()
  return {
    get active() {
      return controllers.size
    },
    get limit() {
      return max
    },
    tryAcquire(controller) {
      if (controllers.size >= max) return false
      controllers.add(controller)
      return true
    },
    release(controller) {
      controllers.delete(controller)
    },
    abortAll(reason) {
      const active = [...controllers]
      controllers.clear()
      for (const controller of active) {
        try {
          controller.abort(reason)
        } catch {
          // an already-aborted controller is fine
        }
      }
      return active.length
    },
  }
}
