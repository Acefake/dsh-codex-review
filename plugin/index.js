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
import { GitHubClient, REPO_RE } from './lib/github.js'
import { ReviewEngine } from './lib/review.js'
import { ROUTE_PREFIX, createJsonRouteHandler } from './lib/http.js'

/** Plugin id; equals the package name and the Client bundle id. */
export const name = 'dsh-codex-review'

/** Required services: the route registry. Model services are optional injects. */
export const inject = ['webServer']

/** Plugin version reported by `/codex-review/health`. */
export const VERSION = '0.1.0'

/** Loader-facing configuration schema (Schemastery, Standard-Schema compatible). */
export { Config }

/** Route paths owned by this plugin. */
const PATHS = Object.freeze({
  health: `${ROUTE_PREFIX}/health`,
  llmInfo: `${ROUTE_PREFIX}/llm-info`,
  prs: `${ROUTE_PREFIX}/prs`,
  pr: `${ROUTE_PREFIX}/pr`,
  reviewStart: `${ROUTE_PREFIX}/review-start`,
  reviewStatus: `${ROUTE_PREFIX}/review-status`,
  reviewCancel: `${ROUTE_PREFIX}/review-cancel`,
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
  const routes = createRoutes({
    config,
    github,
    engine,
    llmAvailable: () => llmFace !== undefined,
    llmInfo,
    version: VERSION,
  })
  const handler = createJsonRouteHandler({
    routes,
    deadlineMs: config.requestTimeoutMs,
    logger,
  })

  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler }),
    'dsh-codex-review: host routes',
  )
  ctx.effect(() => () => engine.dispose(), 'dsh-codex-review: review engine')
}

/**
 * Build the pathname → handler map. Handlers receive the parsed JSON body and
 * the request context `{ signal }`; they either resolve the route value or
 * throw an {@link AppError} that the transport turns into the error envelope.
 * @param {{ config: any, github: any, engine: any, llmAvailable: () => boolean, version?: string }} wiring - route dependencies.
 * @returns {Record<string, (payload: Record<string, unknown>, context: { signal: AbortSignal }) => Promise<unknown>>} dispatch table.
 */
export function createRoutes(wiring) {
  const { config, github, engine, llmAvailable, llmInfo, version = VERSION } = wiring

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
   * Attach the engine's review snapshot to a PrDetail.
   * @param {string} repo - `owner/name`.
   * @param {number} number - PR number.
   * @param {any} detail - fetched detail.
   * @returns {any} detail plus `review`.
   */
  const withReview = (repo, number, detail) => {
    const headSha = typeof detail?.headSha === 'string' ? detail.headSha : ''
    return { ...detail, review: engine.existing(repo, number, headSha) }
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

    [PATHS.reviewStart]: async (payload) => {
      const { repo, number } = requirePullRef(payload)
      if (!engine.available()) throw new AppError('LLM_UNAVAILABLE')
      const detail = await github.getPull(repo, number)
      const headSha = typeof detail?.headSha === 'string' ? detail.headSha : ''
      if (headSha === '') throw new AppError('GH_NOT_FOUND', '无法确定该 PR 的 head commit')
      return engine.start({
        repo,
        number,
        headSha,
        title: detail?.summary?.title,
        body: detail?.body,
        baseRefName: detail?.summary?.baseRefName,
        headRefName: detail?.summary?.headRefName,
        files: Array.isArray(detail?.files) ? detail.files : [],
      })
    },

    [PATHS.reviewStatus]: async (payload) => {
      const jobId = requireString(payload, 'jobId', 'jobId')
      return engine.status(jobId)
    },

    [PATHS.reviewCancel]: async (payload) => {
      const jobId = requireString(payload, 'jobId', 'jobId')
      return { cancelled: engine.cancel(jobId) }
    },
  }
}
