/**
 * Stable error vocabulary shared by the /codex-review host routes.
 *
 * Every route failure travels to the browser as
 * `{ ok: false, error: { code, message } }`; `code` is the machine-readable
 * contract (`CONTRACT.md` §1.1) and `message` is the Chinese sentence the UI
 * shows, including a recovery hint where one exists.
 * @module dsh-codex-review/lib/errors
 */

/** User-facing message for every stable code. */
export const USER_MESSAGES = {
  BAD_REQUEST: '请求参数不合法',
  GH_MISSING: '未找到 GitHub CLI（gh），请安装 GitHub CLI 或在插件配置里设置 ghPath',
  GH_NOT_LOGGED_IN: '尚未登录 GitHub，请运行 gh auth login 后重试',
  GH_FORBIDDEN: '当前账号无权访问该仓库（私有仓库需要 repo 权限）',
  GH_NOT_FOUND: '仓库或 Pull Request 不存在，或当前账号无权访问',
  GH_RATE_LIMIT: 'GitHub API 触发限流，请稍后重试',
  GH_TIMEOUT: '访问 GitHub 超时，请稍后重试',
  GH_NETWORK: '无法连接 GitHub，请检查网络后重试',
  LLM_UNAVAILABLE: '当前 profile 没有可用的模型服务，暂时无法运行 AI 审查',
  LLM_ERROR: 'AI 审查调用失败，请稍后重试',
  REVIEW_TIMEOUT: 'AI 审查超时，请重试或缩小审查范围',
  MERGE_CONFLICT: 'PR 存在冲突，无法合并，请先在本地解决冲突',
  MERGE_NOT_ALLOWED: 'PR 当前状态不允许合并',
  MERGE_HEAD_MOVED: 'PR 已有新提交，请刷新后重试',
  REVIEW_NOT_READY: '该 PR 当前提交还没有完成的 AI 审查结果，请先运行 AI 审查',
  REVIEW_PARTIAL: '这次审查没有完成全部文件，结果不完整，不能发布；请重新审查后再试',
  REVIEW_HEAD_MOVED: 'PR 已有新提交，请刷新并重新审查后再发布',
  PUBLISH_UNKNOWN: '发布结果未知：GitHub 可能已经写入，请刷新 PR 确认后再决定是否重试',
  BUSY: '当前请求过多，请稍后再试',
  INTERNAL: '插件内部错误',
}

/** Error codes accepted by the HTTP envelope. */
export const ERROR_CODES = Object.freeze(Object.keys(USER_MESSAGES))

/**
 * One failure with a stable code. Route handlers throw it and the shared
 * handler serializes it into the JSON envelope; nothing else is exposed.
 */
export class AppError extends Error {
  /**
   * @param {string} code - stable code from {@link USER_MESSAGES}.
   * @param {string} [message] - user-facing sentence; defaults to the code's message.
   * @param {{ cause?: unknown, details?: unknown }} [options] - diagnostics kept off the wire.
   */
  constructor(code, message, options = {}) {
    super(message ?? USER_MESSAGES[code] ?? String(code))
    this.name = 'AppError'
    /** Stable machine-readable code. */
    this.code = code
    if (options.cause !== undefined) this.cause = options.cause
    if (options.details !== undefined) this.details = options.details
  }
}

/**
 * Family every thrown value crosses before it reaches the browser: an AppError
 * keeps its code, anything else degrades to INTERNAL without leaking a stack.
 * @param {unknown} error - thrown value.
 * @returns {{ code: string, message: string }} the public shape.
 */
export function toPublicError(error) {
  if (error instanceof AppError) return { code: error.code, message: error.message }
  return { code: 'INTERNAL', message: USER_MESSAGES.INTERNAL }
}

/**
 * Error for a malformed request payload (missing repo, bad PR number, ...).
 * @param {string} [message] - detail appended to the generic sentence.
 * @returns {AppError} a BAD_REQUEST failure.
 */
export function badRequest(message) {
  return new AppError('BAD_REQUEST', message === undefined ? USER_MESSAGES.BAD_REQUEST : `${USER_MESSAGES.BAD_REQUEST}：${message}`)
}

/**
 * Whether a thrown value is an abort caused by the caller's signal.
 * @param {unknown} error - thrown value.
 * @param {AbortSignal} [signal] - signal that may have aborted.
 * @returns {boolean} true for abort-shaped failures.
 */
export function isAbortError(error, signal) {
  if (signal?.aborted === true) return true
  if (error === undefined || error === null) return false
  const name = /** @type {{ name?: unknown }} */ (error).name
  return name === 'AbortError' || name === 'CanceledError'
}
