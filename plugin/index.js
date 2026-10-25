/**
 * Host half of dsh-codex-review: GitHub PR data plus the AI review engine,
 * exposed as same-origin JSON routes under `/codex-review` on the shared
 * webserver (CONTRACT.md §1).
 *
 * The plugin mounts with `webServer` only; the model services (`llm`,
 * `agentDefaultModel`) are optional injects, so browsing keeps working in a
 * profile without them and `review-start` answers `LLM_UNAVAILABLE`.
 * @module dsh-codex-review
 */

import { AppError, badRequest } from './lib/errors.js'
import { Config, resolveConfig } from './lib/config.js'
import {
  GitHubClient,
  MERGE_COMMIT_MESSAGE_MAX_CHARS,
  MERGE_COMMIT_TITLE_MAX_CHARS,
  MERGE_METHODS,
  REPO_RE,
} from './lib/github.js'
import { ReviewEngine, resolveReviewOptions } from './lib/review.js'
import { AutoReviewer } from './lib/auto-review.js'
import {
  PUBLISH_DEFAULTS,
  PUBLISH_MODES,
  PUBLISH_SEVERITIES,
  PUBLISH_SUMMARY_MAX_CHARS,
  ReviewPublisher,
} from './lib/publish.js'
import { ROUTE_PREFIX, createChatRouteHandler, createJsonRouteHandler } from './lib/http.js'
import {
  CHAT_CALL_TIMEOUT_MS,
  CHAT_CONCURRENCY,
  CHAT_REQUEST_DEADLINE_MS,
  createChatLimiter,
  encodeSseDelta,
  encodeSseDone,
  mapChatFailure,
  toModelMessages,
  validateChatRequest,
} from './lib/chat.js'

/** Plugin id; equals the package name and the Client bundle id. */
export const name = 'dsh-codex-review'

/** Required services: the route registry. Model services are optional injects. */
export const inject = ['webServer']

/** Plugin version reported by `/codex-review/health`. */
export const VERSION = '0.6.0'

/** Loader-facing configuration schema (Schemastery, Standard-Schema compatible). */
export { Config }

/** Streaming chat path; registered as its own `kind: 'exact'` route so the prefix handler cannot swallow it. */
export const CHAT_PATH = `${ROUTE_PREFIX}/chat`

/** Route paths owned by this plugin. */
const PATHS = Object.freeze({
  health: `${ROUTE_PREFIX}/health`,
  llmInfo: `${ROUTE_PREFIX}/llm-info`,
  prs: `${ROUTE_PREFIX}/prs`,
  pr: `${ROUTE_PREFIX}/pr`,
  reviewStart: `${ROUTE_PREFIX}/review-start`,
  reviewStatus: `${ROUTE_PREFIX}/review-status`,
  reviewCancel: `${ROUTE_PREFIX}/review-cancel`,
  merge: `${ROUTE_PREFIX}/merge`,
  autoReviewStatus: `${ROUTE_PREFIX}/auto-review-status`,
  autoReviewConfig: `${ROUTE_PREFIX}/auto-review-config`,
  autoReviewRun: `${ROUTE_PREFIX}/auto-review-run`,
  reviewPublish: `${ROUTE_PREFIX}/review-publish`,
  comment: `${ROUTE_PREFIX}/comment`,
  reply: `${ROUTE_PREFIX}/reply`,
  resolve: `${ROUTE_PREFIX}/resolve`,
})

/**
 * Plugin entry point (Cordis named `apply` shape).
 * @param {any} ctx - plugin context carrying `webServer`.
 * @param {any} config - validated Config values (defaults applied by the schema).
 */
export function apply(ctx, config) {
  applyWithDeps(ctx, config)
}

/**
 * Apply with explicit dependencies. Production {@link apply} passes the real
 * `ctx.llm` / `ctx.agentDefaultModel`; tests inject a fake GitHub client and
 * review engine so nothing touches the network.
 * @param {any} ctx - plugin context.
 * @param {any} rawConfig - validated or raw Config values.
 * @param {{ github?: any, engine?: any }} [deps] - test doubles.
 */
export function applyWithDeps(ctx, rawConfig, deps = {}) {
  const config = resolveConfig(rawConfig)
  const logger = ctx.logger
  /** Diagnostic snapshot of the last prepared auxiliary call (model info + chosen controls). */
  let llmDiagnostics
  /** @type {{ stream: (request: any) => Promise<AsyncIterable<any>>, selection: () => any, info: () => Promise<any> } | undefined} */
  let llmFace

  // Optional services: the callback runs only while both are registered, and
  // the scope disposal clears the face so a later review-start reports
  // LLM_UNAVAILABLE instead of calling a stale service.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['llm', 'agentDefaultModel'], (scope) => {
      /**
       * Pick the least-expensive reasoning effort the model advertises.
       * `LlmModelReasoningInfo.efforts` order is not contractual, so rank by
       * id instead of trusting the array index.
       * @param {any} info - resolved model info from the prepare callback.
       * @returns {string | undefined} an effort id the model accepts.
       */
      const pickEffort = (info) => {
        const efforts = Array.isArray(info?.reasoning?.efforts) ? info.reasoning.efforts : []
        const ids = efforts.map((entry) => (typeof entry?.id === 'string' ? entry.id : '')).filter((id) => id !== '')
        if (ids.length === 0) return undefined
        const ranked = ['none', 'off', 'disabled', 'minimal', 'low', 'medium', 'high', 'max', 'xhigh']
        for (const candidate of ranked) if (ids.includes(candidate)) return candidate
        return ids[ids.length - 1]
      }
      const canPrepare = typeof scope.llm.prepareCall === 'function'
      /**
       * Prepare one auxiliary call, capturing the model metadata used to pick
       * controls. The output cap is passed only when the caller set one; an
       * absent cap lets the adapter materialize the model's own default, which
       * is what a reasoning model needs to finish thinking AND answer.
       * @param {any} request - stream request.
       * @param {boolean} withCap - whether the caller's output cap is passed.
       * @returns {Promise<any>} prepared call.
       */
      const prepare = async (request, withCap) => {
        const { provider, model, maxTokens, signal } = request
        /** @type {any} */
        let captured
        const call = await scope.llm.prepareCall(
          withCap ? { provider, model, maxTokens } : { provider, model },
          signal,
          (controls, info) => {
            captured = info
            const effort = pickEffort(info)
            return effort === undefined ? controls : { ...controls, reasoningEffort: effort }
          },
        )
        llmDiagnostics = {
          selection: { provider, model },
          maxTokens: call.config?.maxTokens,
          reasoningEffort: call.config?.reasoningEffort,
          efforts: Array.isArray(captured?.reasoning?.efforts)
            ? captured.reasoning.efforts.map((entry) => entry?.id)
            : [],
          contextWindow: captured?.contextWindow,
          defaultMaxTokens: captured?.defaultMaxTokens ?? captured?.maxOutputTokens,
        }
        return call
      }
      llmFace = {
        /**
         * Stream one auxiliary review call through the prepared-call seam so
         * adapter defaults apply and the model's least supported reasoning
         * effort is requested. Without that a reasoning model spends the whole
         * output budget on hidden reasoning and never reaches the JSON answer.
         * @param {any} request - `{ provider, model, system, messages, maxTokens, sessionId, signal }`.
         * @returns {Promise<AsyncIterable<any>>} the stream.
         */
        stream: async (request) => {
          const { system, messages, sessionId, signal } = request
          if (!canPrepare) return scope.llm.stream(request)
          let call
          try {
            call = await prepare(request, request.maxTokens !== undefined)
          } catch (capError) {
            if (request.maxTokens === undefined) throw capError
            call = await prepare(request, false)
          }
          return call.stream({ ...call.config, system, messages, sessionId, signal })
        },
        selection: () => scope.agentDefaultModel.currentSelection(),
        info: async () => {
          const selection = scope.agentDefaultModel.currentSelection()
          if (!canPrepare) return { ...selection, transport: 'raw' }
          await prepare({ provider: selection.provider, model: selection.model }, false)
          let models
          try {
            models = typeof scope.llm.listModels === 'function'
              ? (await scope.llm.listModels(selection.provider)).map((entry) => ({
                id: entry?.id,
                name: entry?.name,
                reasoning: entry?.reasoning?.efforts?.map((effort) => effort?.id) ?? [],
              }))
              : undefined
          } catch {
            models = undefined
          }
          return { ...llmDiagnostics, transport: 'prepared', ...(models === undefined ? {} : { models }) }
        },
      }
      scope.effect(() => () => {
        llmFace = undefined
      }, 'dsh-codex-review: llm seam')
    })
  }

  const streamLlm = (request) => {
    if (llmFace === undefined) throw new AppError('LLM_UNAVAILABLE')
    return llmFace.stream(request)
  }
  const resolveSelection = () => {
    if (llmFace === undefined) throw new AppError('LLM_UNAVAILABLE')
    return llmFace.selection()
  }
  const llmInfo = async () => {
    if (llmFace === undefined) throw new AppError('LLM_UNAVAILABLE')
    return llmFace.info()
  }

  const github = deps.github ?? new GitHubClient({ config, logger })
  const engine = deps.engine ?? new ReviewEngine({ streamLlm, resolveSelection, config, logger })
  /** Concurrent chat streams allowed by CONTRACT §5.2. */
  const chatLimiter = deps.chatLimiter ?? createChatLimiter(CHAT_CONCURRENCY)
  /** Background automatic reviewer (CONTRACT §6); disabled by default. */
  const reviewer = deps.reviewer ?? new AutoReviewer({ github, engine, logger })
  /**
   * Publish flow shared by the manual route and the automatic reviewer
   * (CONTRACT §7.2). The publish records live inside the auto-review state file,
   * so a restarted Host remembers which head was already published.
   */
  const publisher = deps.publisher ?? new ReviewPublisher({
    github,
    engine,
    logger,
    store: {
      get: (key) => (typeof reviewer.getPublished === 'function' ? reviewer.getPublished(key) : undefined),
      set: (key, record) => {
        if (typeof reviewer.setPublished === 'function') reviewer.setPublished(key, record)
      },
    },
  })
  if (typeof reviewer.setPublisher === 'function') reviewer.setPublisher(publisher)
  const routes = createRoutes({
    config,
    github,
    engine,
    reviewer,
    publisher,
    logger,
    llmAvailable: () => llmFace !== undefined,
    llmInfo,
    version: VERSION,
  })
  const handler = createJsonRouteHandler({
    routes,
    deadlineMs: config.requestTimeoutMs,
    logger,
  })
  const chatHandler = createChatRouteHandler({
    handle: createChatStreamHandler({
      github,
      engine,
      streamLlm,
      llmAvailable: () => llmFace !== undefined,
      config,
      logger,
      limiter: chatLimiter,
    }),
    deadlineMs: CHAT_REQUEST_DEADLINE_MS,
    logger,
  })

  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler }),
    'dsh-codex-review: host routes',
  )
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: CHAT_PATH, handler: chatHandler }),
    'dsh-codex-review: chat route',
  )
  ctx.effect(() => () => engine.dispose(), 'dsh-codex-review: review engine')
  // A plugin dispose must stop every live chat stream, not just its listeners.
  ctx.effect(() => () => chatLimiter.abortAll(new AppError('INTERNAL', '插件已卸载')), 'dsh-codex-review: chat streams')
  ctx.effect(() => () => reviewer.dispose(), 'dsh-codex-review: auto-review scheduler')
}

/**
 * Build the chat business flow used by the SSE transport (CONTRACT §5.2):
 * validate → acquire a concurrency slot → load the PR/review context → stream
 * the model answer as `data: {"delta"}` frames → terminal done/error frame.
 * Every model call goes through the same prepared-call seam as the review
 * engine and carries `sessionId = chat-<repo>#<number>` so the provider can
 * route/reuse the auxiliary conversation.
 * @param {{ github: any, engine: any, streamLlm: (request: any) => Promise<AsyncIterable<any>>, llmAvailable: () => boolean, config: any, logger?: any, limiter: ReturnType<typeof createChatLimiter>, callTimeoutMs?: number }} wiring - dependencies.
 * @returns {(payload: Record<string, unknown>, stream: { signal: AbortSignal, send: (frame: string) => void, end: () => void, clientGone: () => boolean }) => Promise<void>} the chat flow.
 */
export function createChatStreamHandler(wiring) {
  const { github, engine, streamLlm, llmAvailable, config, limiter } = wiring
  const callTimeoutMs = Number.isFinite(wiring.callTimeoutMs) && wiring.callTimeoutMs > 0 ? wiring.callTimeoutMs : CHAT_CALL_TIMEOUT_MS

  /**
   * Map any thrown value onto the chat error codes (`LLM_ERROR` for provider
   * failures, the AppError code otherwise).
   * @param {unknown} error - thrown value.
   * @param {boolean} timedOut - whether the per-call deadline fired.
   * @returns {AppError} a chat-safe failure.
   */
  const toChatError = (error, timedOut) => {
    if (timedOut) return new AppError('LLM_ERROR', 'AI 回答超时，请重试')
    const mapped = mapChatFailure(error)
    return new AppError(mapped.code, mapped.message)
  }

  return async function handleChat(payload, stream) {
    const request = validateChatRequest(payload)
    if (!llmAvailable()) throw new AppError('LLM_UNAVAILABLE')
    const controller = new AbortController()
    if (!limiter.tryAcquire(controller)) throw new AppError('BUSY')
    /** @type {NodeJS.Timeout | undefined} */
    let callTimer
    /** @type {(() => void) | undefined} */
    let unlinkAbort
    let timedOut = false
    try {
      // A client disconnect must abort the upstream model stream.
      const linkAbort = () => {
        try {
          controller.abort(stream.signal.reason)
        } catch {
          // an already-aborted signal is fine
        }
      }
      if (stream.signal.aborted) linkAbort()
      else stream.signal.addEventListener('abort', linkAbort, { once: true })
      unlinkAbort = () => stream.signal.removeEventListener('abort', linkAbort)

      const detail = await github.getPull(request.repo, request.number)
      const headSha = typeof detail?.headSha === 'string' ? detail.headSha : ''
      const review = engine.existing(request.repo, request.number, headSha)
      const context = await github.chatContext({
        repo: request.repo,
        number: request.number,
        focusFile: request.focusFile,
        detail,
        review,
        messages: request.messages,
      })
      if (stream.clientGone()) return
      const model = engine.resolveModel()

      callTimer = setTimeout(() => {
        timedOut = true
        try {
          controller.abort(new AppError('LLM_ERROR', 'AI 回答超时，请重试'))
        } catch {
          // an already-aborted signal is fine
        }
      }, callTimeoutMs)
      if (typeof callTimer.unref === 'function') callTimer.unref()

      /** @type {AsyncIterable<any>} */
      let upstream
      try {
        upstream = await streamLlm({
          provider: model.provider,
          model: model.model,
          system: context.system,
          messages: toModelMessages(context.messages),
          maxTokens: config.maxOutputTokens > 0 ? config.maxOutputTokens : undefined,
          sessionId: `chat-${request.repo}#${request.number}`,
          signal: controller.signal,
        })
      } catch (error) {
        if (stream.clientGone()) return
        throw toChatError(error, timedOut)
      }
      /** @type {any} */
      let usage
      /** @type {any} */
      let reason
      try {
        for await (const chunk of upstream) {
          if (stream.clientGone()) return
          if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') stream.send(encodeSseDelta(chunk.text))
          else if (chunk?.type === 'usage') usage = chunk.usage ?? chunk
          else if (chunk?.type === 'finish') reason = chunk.reason
        }
      } catch (error) {
        if (stream.clientGone()) return
        throw toChatError(error, timedOut)
      }
      if (stream.clientGone()) return
      if (timedOut) throw new AppError('LLM_ERROR', 'AI 回答超时，请重试')
      if (reason?.kind === 'error') throw toChatError(reason.failure, false)
      if (reason?.kind === 'aborted') throw new AppError('LLM_ERROR', 'AI 回答被中止，请重试')
      stream.send(encodeSseDone({ model, usage }))
    } finally {
      if (callTimer !== undefined) clearTimeout(callTimer)
      unlinkAbort?.()
      limiter.release(controller)
    }
  }
}

/**
 * Build the pathname → handler map. Handlers receive the parsed JSON body and
 * the request context `{ signal }`; they either resolve the route value or
 * throw an {@link AppError} that the transport turns into the error envelope.
 * @param {{ config: any, github: any, engine: any, reviewer?: any, publisher?: any, llmAvailable: () => boolean, llmInfo?: () => Promise<any>, version?: string }} wiring - route dependencies.
 * @returns {Record<string, (payload: Record<string, unknown>, context: { signal: AbortSignal }) => Promise<unknown>>} dispatch table.
 */
export function createRoutes(wiring) {
  const { config, github, engine, reviewer, publisher, logger, llmAvailable, llmInfo, version = VERSION } = wiring

  /** jobId → PR ref, so `/review-status` can attach the persisted publish record. @type {Map<string, { repo: string, number: number }>} */
  const jobRefs = new Map()

  /**
   * Publish a manually started review once it finishes, when the user enabled
   * automatic publishing. Fire-and-forget: the review route must not block on a
   * GitHub write, and a publish failure only logs (the review result itself is
   * kept). The enabled flag is re-read after completion so switching it off
   * while a review runs also stops the publish.
   * @param {string} jobId - finished or running review job.
   * @param {string} repo - `owner/name`.
   * @param {number} number - PR number.
   * @returns {void}
   */
  const autoPublishAfterReview = (jobId, repo, number) => {
    if (typeof engine.waitForCompletion !== 'function' || typeof publisher?.publish !== 'function') return
    const isEnabled = () => {
      try {
        return reviewer?.status?.()?.publish?.enabled === true
      } catch {
        return false
      }
    }
    if (!isEnabled()) return
    void (async () => {
      try {
        await engine.waitForCompletion(jobId)
        const finished = engine.status(jobId)
        if (finished?.state !== 'done') return
        const publishConfig = reviewer?.status?.()?.publish
        if (publishConfig?.enabled !== true) return
        await publisher.publish({
          repo,
          number,
          confirm: true,
          mode: publishConfig.mode,
          minSeverity: publishConfig.minSeverity,
          maxComments: publishConfig.maxComments,
        })
      } catch (error) {
        logger?.warn?.(`dsh-codex-review: auto publish after review ${repo}#${number} failed: ${error?.message ?? error}`)
      }
    })()
  }

  /**
   * Read one required non-empty string field.
   * @param {Record<string, unknown>} payload - parsed body.
   * @param {string} key - field name.
   * @param {string} label - user-facing field label.
   * @returns {string} the value.
   * @throws {AppError} BAD_REQUEST when missing or blank.
   */
  const requireString = (payload, key, label) => {
    const value = payload[key]
    if (typeof value !== 'string' || value.trim() === '') throw badRequest(`缺少 ${label}`)
    return value.trim()
  }

  /**
   * Read the `{ repo, number }` pair shared by the PR routes.
   * @param {Record<string, unknown>} payload - parsed body.
   * @returns {{ repo: string, number: number }} validated pair.
   * @throws {AppError} BAD_REQUEST for a malformed repo or number.
   */
  const requirePullRef = (payload) => {
    const repo = requireString(payload, 'repo', 'repo')
    if (!REPO_RE.test(repo)) throw badRequest('repo 必须是 owner/name 形式')
    const rawNumber = payload.number
    const number = typeof rawNumber === 'number' ? rawNumber : typeof rawNumber === 'string' ? Number(rawNumber) : Number.NaN
    if (!Number.isInteger(number) || number <= 0) throw badRequest('number 必须是正整数')
    return { repo, number }
  }

  /**
   * Attach the engine's review snapshot to a PrDetail. When this head was
   * already published to GitHub, the persisted publish identity rides along as
   * `review.published` so the workbench can render the "already published"
   * badge after a page reload (CONTRACT §7.3) instead of depending on
   * per-tab client state.
   * @param {string} repo - `owner/name`.
   * @param {number} number - PR number.
   * @param {any} detail - fetched detail.
   * @returns {any} detail plus `review` (and `review.published` when recorded).
   */
  const withReview = (repo, number, detail) => {
    const headSha = typeof detail?.headSha === 'string' ? detail.headSha : ''
    const review = engine.existing(repo, number, headSha)
    if (headSha === '' || typeof reviewer?.getPublished !== 'function') return { ...detail, review }
    const record = reviewer.getPublished(`${repo}#${number}@${headSha}`)
    if (record === undefined || record === null) return { ...detail, review }
    return { ...detail, review: { ...review, published: { ...record, headSha } } }
  }

  /**
   * Validate one optional merge commit field (`commitTitle` / `commitMessage`).
   * @param {unknown} value - raw field.
   * @param {number} maxChars - contract cap.
   * @param {string} label - field label used in the error message.
   * @returns {string | undefined} trimmed value or undefined.
   * @throws {AppError} BAD_REQUEST for a non-string or over-long value.
   */
  const optionalCommitField = (value, maxChars, label) => {
    if (value === undefined || value === null) return undefined
    if (typeof value !== 'string') throw badRequest(`${label} 必须是字符串`)
    const trimmed = value.trim()
    if (trimmed === '') return undefined
    if (trimmed.length > maxChars) throw badRequest(`${label} 超过 ${maxChars} 字`)
    return trimmed
  }

  return {
    [PATHS.health]: async () => {
      /** @type {'ok' | 'not-logged-in' | 'missing'} */
      let gh
      try {
        gh = await github.ghStatus()
      } catch {
        gh = 'not-logged-in'
      }
      return { gh, llm: llmAvailable() ? 'ok' : 'unavailable', version }
    },

    [PATHS.llmInfo]: async () => {
      if (typeof llmInfo !== 'function') throw new AppError('LLM_UNAVAILABLE')
      const info = await llmInfo()
      return {
        ...info,
        pluginConfig: {
          provider: config.provider,
          model: config.model,
          maxOutputTokens: config.maxOutputTokens,
          reviewChunkChars: config.reviewChunkChars,
          maxChunks: config.maxChunks,
        },
      }
    },

    [PATHS.prs]: async (payload) => {
      const query = typeof payload.query === 'string' && payload.query.trim() !== '' ? payload.query.trim() : config.defaultQuery
      const rawLimit = payload.limit
      const limit = typeof rawLimit === 'number' && Number.isFinite(rawLimit)
        ? Math.min(100, Math.max(1, Math.floor(rawLimit)))
        : config.limit
      return github.listPullRequests({ query, limit })
    },

    [PATHS.pr]: async (payload) => {
      const { repo, number } = requirePullRef(payload)
      const detail = await github.getPull(repo, number)
      return withReview(repo, number, detail)
    },

    [PATHS.reviewStart]: async (payload, context) => {
      const { repo, number } = requirePullRef(payload)
      if (!engine.available()) throw new AppError('LLM_UNAVAILABLE')
      // Resolve the v1.1 options here as well so the guideline fetch happens
      // only when requested; the engine resolves the same values internally.
      const options = resolveReviewOptions(payload.options, config)
      const detail = await github.getPull(repo, number)
      const headSha = typeof detail?.headSha === 'string' ? detail.headSha : ''
      if (headSha === '') throw new AppError('GH_NOT_FOUND', '无法确定该 PR 的 head commit')
      let guidelines
      if (options.includeGuidelines && typeof github.getGuidelines === 'function') {
        try {
          guidelines = await github.getGuidelines(repo, { signal: context?.signal })
        } catch {
          // Guidelines are an enhancement: never let them block the review.
          guidelines = undefined
        }
      }
      const started = engine.start({
        repo,
        number,
        headSha,
        title: detail?.summary?.title,
        body: detail?.body,
        baseRefName: detail?.summary?.baseRefName,
        headRefName: detail?.summary?.headRefName,
        files: Array.isArray(detail?.files) ? detail.files : [],
        options,
        guidelines,
      })
      jobRefs.set(started.jobId, { repo, number })
      if (jobRefs.size > 200) {
        const oldest = jobRefs.keys().next()
        if (oldest.done !== true) jobRefs.delete(oldest.value)
      }
      autoPublishAfterReview(started.jobId, repo, number)
      return {
        jobId: started.jobId,
        headSha: started.headSha,
        cached: started.cached,
        options: started.options ?? options,
      }
    },

    [PATHS.reviewStatus]: async (payload) => {
      const jobId = requireString(payload, 'jobId', 'jobId')
      const status = engine.status(jobId)
      const ref = jobRefs.get(jobId)
      if (ref === undefined || typeof reviewer?.getPublished !== 'function') return status
      const headSha = typeof status?.headSha === 'string' ? status.headSha : ''
      if (headSha === '') return status
      const record = reviewer.getPublished(`${ref.repo}#${ref.number}@${headSha}`)
      if (record === undefined || record === null) return status
      // Lets the workbench show the "already published" badge as soon as the
      // auto-publish (or a manual publish) completed, without reloading the PR.
      return { ...status, published: { ...record, headSha } }
    },

    [PATHS.reviewCancel]: async (payload) => {
      const jobId = requireString(payload, 'jobId', 'jobId')
      return { cancelled: engine.cancel(jobId) }
    },

    [PATHS.merge]: async (payload) => {
      const { repo, number } = requirePullRef(payload)
      // Guard 1: a write operation always needs an explicit confirmation.
      if (payload.confirm !== true) throw badRequest('合并操作需要 confirm: true')
      const method = typeof payload.method === 'string' ? payload.method.trim().toLowerCase() : ''
      if (!MERGE_METHODS.includes(method)) throw badRequest('method 必须是 merge|squash|rebase')
      const expectedHeadSha = requireString(payload, 'expectedHeadSha', 'expectedHeadSha')
      if (expectedHeadSha.length > 100) throw badRequest('expectedHeadSha 不合法')
      const commitTitle = optionalCommitField(payload.commitTitle, MERGE_COMMIT_TITLE_MAX_CHARS, 'commitTitle')
      const commitMessage = optionalCommitField(payload.commitMessage, MERGE_COMMIT_MESSAGE_MAX_CHARS, 'commitMessage')
      let deleteBranch = false
      if (payload.deleteBranch !== undefined && payload.deleteBranch !== null) {
        if (typeof payload.deleteBranch !== 'boolean') throw badRequest('deleteBranch 必须是布尔值')
        deleteBranch = payload.deleteBranch
      }
      const result = await github.mergePull({
        repo,
        number,
        method,
        expectedHeadSha,
        commitTitle,
        commitMessage,
        deleteBranch,
        confirm: true,
      })
      // Guard 7: the merged head is no longer reachable, so drop its review jobs.
      if (typeof engine.invalidate === 'function') engine.invalidate(repo, number)
      return result
    },

    [PATHS.autoReviewStatus]: async () => {
      if (reviewer === undefined) throw new AppError('INTERNAL', '自动审查未初始化')
      return reviewer.status()
    },

    [PATHS.autoReviewConfig]: async (payload) => {
      if (reviewer === undefined) throw new AppError('INTERNAL', '自动审查未初始化')
      if (payload.patch === undefined) return reviewer.status()
      if (payload.patch === null || typeof payload.patch !== 'object' || Array.isArray(payload.patch)) {
        throw badRequest('patch 必须是对象')
      }
      return reviewer.updateConfig(payload.patch)
    },

    [PATHS.autoReviewRun]: async (payload) => {
      if (reviewer === undefined) throw new AppError('INTERNAL', '自动审查未初始化')
      return reviewer.runOnce({ force: payload.force === true })
    },

    [PATHS.reviewPublish]: async (payload) => {
      const { repo, number } = requirePullRef(payload)
      // Writing a GitHub review always needs the explicit confirmation flag.
      if (payload.confirm !== true) throw badRequest('发布审查到 GitHub 需要 confirm: true')
      // Defaults come from the persisted publish config; explicit values win.
      const publishConfig = reviewer?.status?.()?.config?.publish ?? PUBLISH_DEFAULTS
      const mode = payload.mode === undefined ? publishConfig.mode : payload.mode
      if (!PUBLISH_MODES.includes(mode)) throw badRequest('mode 必须是 inline|summary|both')
      const minSeverity = payload.minSeverity === undefined ? publishConfig.minSeverity : payload.minSeverity
      if (!PUBLISH_SEVERITIES.includes(minSeverity)) throw badRequest('minSeverity 必须是 P0|P1|P2')
      let customBody
      if (payload.body !== undefined && payload.body !== null) {
        if (typeof payload.body !== 'string') throw badRequest('body 必须是字符串')
        const trimmed = payload.body.trim()
        if (trimmed.length > PUBLISH_SUMMARY_MAX_CHARS) throw badRequest(`body 超过 ${PUBLISH_SUMMARY_MAX_CHARS} 字`)
        if (trimmed !== '') customBody = trimmed
      }
      if (publisher === undefined) throw new AppError('INTERNAL', '发布器未初始化')
      return publisher.publish({
        repo,
        number,
        confirm: true,
        mode,
        minSeverity,
        maxComments: publishConfig.maxComments ?? PUBLISH_DEFAULTS.maxComments,
        body: customBody,
      })
    },

    [PATHS.comment]: async (payload) => {
      const { repo, number } = requirePullRef(payload)
      // Every comment write needs the explicit confirmation flag.
      if (payload.confirm !== true) throw badRequest('发表评论需要 confirm: true')
      return github.createIssueComment({ repo, number, body: payload.body })
    },

    [PATHS.reply]: async (payload) => {
      const { repo, number } = requirePullRef(payload)
      if (payload.confirm !== true) throw badRequest('回复评论需要 confirm: true')
      const commentId = Number(payload.commentId)
      if (!Number.isInteger(commentId) || commentId <= 0) throw badRequest('commentId 必须是正整数')
      return github.replyToReviewComment({ repo, number, commentId, body: payload.body })
    },

    [PATHS.resolve]: async (payload) => {
      const { repo, number } = requirePullRef(payload)
      if (payload.confirm !== true) throw badRequest('解决讨论需要 confirm: true')
      const threadId = typeof payload.threadId === 'string' ? payload.threadId.trim() : ''
      if (threadId === '' || threadId.length > 200) throw badRequest('threadId 不合法')
      return github.resolveReviewThread({ repo, number, threadId })
    },
  }
}
