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
import { GITLAB_REPO_RE, GitLabClient, isValidGitlabRepo } from './lib/gitlab.js'
import {
  accountTokenInput,
  accountTokenPath,
  accountsFilePath,
  legacyAccounts,
  loadAccountStore,
  makeAccountId,
  normalizeAccountInput,
  readAccountToken,
  removeAccountToken,
  saveAccountStore,
  writeAccountToken,
} from './lib/accounts.js'
import { ReviewEngine, resolveReviewOptions } from './lib/review.js'
import { AutoReviewer, resolveAutoReviewStatePath } from './lib/auto-review.js'
import { dirname, join } from 'node:path'
import {
  PUBLISH_DEFAULTS,
  PUBLISH_MODES,
  PUBLISH_SEVERITIES,
  PUBLISH_SUMMARY_MAX_CHARS,
  PUBLISH_TIMEOUT_MS,
  ReviewPublisher,
  publishRecordKeys,
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
export const VERSION = '0.13.0'

/**
 * Capabilities of one data source. This release keeps write operations on
 * GitHub only; GitLab is read-only.
 * @param {'github' | 'gitlab'} dataSource - active data source.
 * @returns {{ browse: boolean, review: boolean, chat: boolean, autoReview: boolean, publish: boolean, comment: boolean, reply: boolean, resolve: boolean, merge: boolean }} capability flags.
 */
export function providerCapabilities(dataSource) {
  const gitlab = dataSource === 'gitlab'
  return {
    browse: true,
    review: true,
    chat: true,
    autoReview: !gitlab,
    publish: !gitlab,
    comment: !gitlab,
    reply: !gitlab,
    resolve: !gitlab,
    merge: !gitlab,
  }
}

/** Provider-specific UI labels; the client renders these instead of hard-coded GitHub wording. */
export const PROVIDER_LABELS = Object.freeze({
  github: Object.freeze({ item: 'PR', itemFull: 'Pull Request', reviewers: 'Reviewers', checks: 'Checks' }),
  gitlab: Object.freeze({ item: 'MR', itemFull: 'Merge Request', reviewers: 'Approvals', checks: 'Pipelines' }),
})

/**
 * Resolve the accounts the profile should expose: the saved store when it has
 * entries, otherwise the legacy single GitHub + optional GitLab pair.
 * @param {any} config - resolved config.
 * @param {{ accounts?: Array<any> }} [store] - loaded account store.
 * @returns {Array<any>} account descriptors.
 */
export function resolveAccounts(config, store) {
  const saved = Array.isArray(store?.accounts) ? store.accounts : []
  // An existing store (even with zero accounts) replaces the legacy fallback.
  if (store?.present === true) return saved
  return saved.length > 0 ? saved : legacyAccounts(config)
}

/**
 * A client whose account has no usable credential. Every operation fails with a
 * stable code instead of silently falling back to another account's identity.
 * @param {string} reason - user-facing explanation.
 * @returns {any} unavailable client proxy.
 */
function unavailableClient(reason) {
  return new Proxy({}, {
    get(_target, property) {
      if (property === 'unavailable') return true
      if (property === 'reason') return reason
      if (property === 'status') return async () => ({ ok: false, viewer: '', error: 'ACCOUNT_UNAVAILABLE' })
      if (property === 'ghStatus') return async () => 'missing'
      if (property === 'dispose') return () => {}
      return () => {
        throw new AppError('ACCOUNT_UNAVAILABLE', reason)
      }
    },
  })
}

/**
 * Build one client per configured account. GitHub accounts honour an explicit
 * token from secrets; GitLab accounts get the store's base URL plus their token.
 * Only the legacy default `github` account may fall back to the host `gh`/env
 * identity; every other account without a token is marked unavailable instead
 * of borrowing another account's credentials.
 * @param {any} config - resolved config.
 * @param {any} logger - host logger.
 * @param {any} [githubOverride] - injected GitHub client (tests, single GitHub account).
 * @param {Array<any>} [accounts] - account descriptors; falls back to legacy config.
 * @returns {Record<string, any>} clients keyed by account id.
 */
export function buildClients(config, logger, githubOverride, accounts, tokenReader = readAccountToken) {
  const list = Array.isArray(accounts) ? accounts : legacyAccounts(config)
  /** @type {Record<string, any>} */
  const clients = {}
  let githubOverrideUsed = false
  const readToken = (id) => {
    try {
      return { token: tokenReader(id), error: '' }
    } catch (error) {
      return { token: '', error: error?.message || '读取 Token 失败' }
    }
  }
  for (const account of list) {
    if (account.type === 'gitlab') {
      const stored = readToken(account.id)
      const token = stored.token || (account.id === 'gitlab' ? config.gitlabToken : '')
      const baseUrl = account.id === 'gitlab' ? (account.baseUrl || config.gitlabBaseUrl || '') : account.baseUrl
      clients[account.id] = stored.error !== ''
        ? unavailableClient(stored.error)
        : (token === ''
            ? unavailableClient(`${account.label || account.id} 缺少 Token`)
            : (baseUrl === ''
                ? unavailableClient(`${account.label || account.id} 缺少地址`)
                : new GitLabClient({ config: { ...config, gitlabBaseUrl: baseUrl, gitlabToken: token }, logger })))
      continue
    }
    const stored = readToken(account.id)
    if (githubOverride !== undefined && account.id === 'github') {
      githubOverrideUsed = true
      clients[account.id] = githubOverride
      continue
    }
    clients[account.id] = stored.error !== ''
      ? unavailableClient(stored.error)
      : (stored.token === '' && account.id !== 'github'
          ? unavailableClient(`${account.label || account.id} 缺少 Token`)
          : new GitHubClient({
              config,
              logger,
              ...(stored.token === '' ? {} : { token: stored.token }),
            }))
  }
  return clients
}

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
  accounts: `${ROUTE_PREFIX}/accounts`,
  accountsAdd: `${ROUTE_PREFIX}/accounts-add`,
  accountsRemove: `${ROUTE_PREFIX}/accounts-remove`,
  accountsTest: `${ROUTE_PREFIX}/accounts-test`,
  accountsDefault: `${ROUTE_PREFIX}/accounts-default`,
})

/**
 * Plugin entry point (Cordis named `apply` shape).
 * @param {any} ctx - plugin context carrying `webServer`.
 * @param {any} config - validated Config values (defaults applied by the schema).
 */
export function apply(ctx, config) {
  applyWithDeps(ctx, config, {
    reviewStatePath: join(dirname(resolveAutoReviewStatePath()), 'review-results.json'),
  })
}

/**
 * Apply with explicit dependencies. Production {@link apply} passes the real
 * `ctx.llm` / `ctx.agentDefaultModel`; tests inject a fake GitHub client and
 * review engine so nothing touches the network.
 * @param {any} ctx - plugin context.
 * @param {any} rawConfig - validated or raw Config values.
 * @param {{ github?: any, engine?: any, reviewStatePath?: string }} [deps] - test doubles.
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

  // Tests inject clients; never let them read the real profile's account store.
  const store = deps.store ?? ((deps.github !== undefined || deps.clients !== undefined || deps.store !== undefined)
    ? { accounts: [], defaultAccount: '' }
    : loadAccountStore())
  const accountList = resolveAccounts(config, store)
  const clients = deps.clients ?? buildClients(config, logger, deps.github, accountList)
  const defaultAccount = (() => {
    const saved = accountList.find((account) => account.id === store.defaultAccount)
    if (saved !== undefined) return saved.id
    const bySource = config.dataSource === 'gitlab'
      ? accountList.find((account) => account.type === 'gitlab')
      : accountList.find((account) => account.type === 'github')
    return (bySource ?? accountList[0])?.id ?? ''
  })()
  /**
   * Mutable account runtime shared with the routes: add/remove rebuilds the
   * client map in place so every route keeps seeing the current accounts.
   */
  const accountRuntime = {
    store,
    accounts: accountList,
    clients,
    githubOverride: deps.github,
    defaultAccount,
    rebuild() {
      const next = buildClients(config, logger, accountRuntime.githubOverride, accountRuntime.accounts)
      for (const key of Object.keys(accountRuntime.clients)) delete accountRuntime.clients[key]
      Object.assign(accountRuntime.clients, next)
      const current = accountRuntime.accounts.find((account) => account.id === accountRuntime.defaultAccount)
      const saved = accountRuntime.accounts.find((account) => account.id === accountRuntime.store?.defaultAccount)
      const first = accountRuntime.accounts.find(
        (account) => accountRuntime.clients[account.id] !== undefined && accountRuntime.clients[account.id]?.unavailable !== true,
      )
      accountRuntime.defaultAccount = (current ?? saved ?? first)?.id ?? ''
      accountRuntime.onRebuild?.()
    },
    onRebuild: undefined,
  }
  const primaryGithubAccount = accountList.find(
    (account) => account.type === 'github' && clients[account.id]?.unavailable !== true,
  )
  const github = primaryGithubAccount === undefined ? undefined : clients[primaryGithubAccount.id]
  const engine = deps.engine ?? new ReviewEngine({
    streamLlm, resolveSelection, config, logger,
    statePath: deps.reviewStatePath,
    legacyAccount: primaryGithubAccount?.id ?? defaultAccount,
  })
  /** Concurrent chat streams allowed by CONTRACT §5.2. */
  const chatLimiter = deps.chatLimiter ?? createChatLimiter(CHAT_CONCURRENCY)
  // Auto-review and publishing are GitHub-only and bound to one account; with
  // no usable GitHub account they stay undefined until one is added.
  let reviewer = deps.reviewer ?? (primaryGithubAccount === undefined ? undefined : new AutoReviewer({
    github, engine, logger, account: primaryGithubAccount.id,
  }))
  /**
   * Publish flow shared by the manual route and the automatic reviewer
   * (CONTRACT §7.2). Per-head and rolling-summary publish records live inside
   * the auto-review state file, so a restarted Host remembers which heads were
   * already published and which review to update in place.
   */
  const makePublisher = (client, accountId) => new ReviewPublisher({
    github: client,
    engine,
    logger,
    legacyAccount: accountId ?? '',
    store: {
      get: (key) => (typeof reviewer?.getPublished === 'function' ? reviewer.getPublished(key) : undefined),
      set: (key, record) => {
        if (typeof reviewer?.setPublished === 'function') reviewer.setPublished(key, record)
      },
      setMany: (entries) => {
        if (typeof reviewer?.setPublishedMany === 'function') reviewer.setPublishedMany(entries)
      },
    },
  })
  let publisher = deps.publisher ?? (primaryGithubAccount === undefined ? undefined : makePublisher(github, primaryGithubAccount.id))
  if (typeof reviewer?.setPublisher === 'function') reviewer.setPublisher(publisher)
  // Rebuilt account clients must also replace the GitHub-bound scheduler/publisher
  // clients; a profile that starts without GitHub can create them lazily.
  accountRuntime.onRebuild = () => {
    const primary = accountRuntime.accounts.find(
      (account) => account.type === 'github' && accountRuntime.clients[account.id]?.unavailable !== true,
    )
    if (primary === undefined) {
      try {
        reviewer?.updateConfig?.({ enabled: false })
      } catch {
        // If the scheduler cannot be paused, dispose it so it cannot run empty.
        reviewer?.dispose?.()
      }
      if (reviewer !== null && typeof reviewer === 'object') {
        reviewer.github = undefined
        reviewer.account = ''
      }
      if (publisher !== null && typeof publisher === 'object') publisher.github = undefined
      return
    }
    const client = accountRuntime.clients[primary.id]
    if (reviewer === undefined) {
      reviewer = new AutoReviewer({ github: client, engine, logger, account: primary.id })
    } else {
      reviewer.github = client
      reviewer.account = primary.id
    }
    if (publisher === undefined) publisher = makePublisher(client, primary.id)
    else publisher.github = client
    if (publisher !== null && typeof publisher === 'object') publisher.legacyAccount = primary.id
    if (engine !== null && typeof engine === 'object') engine.legacyAccount = primary.id
    if (typeof reviewer?.setPublisher === 'function') reviewer.setPublisher(publisher)
  }
  const routes = createRoutes({
    config,
    clients,
    accountRuntime,
    defaultAccount,
    github,
    engine,
    saveStore: saveAccountStore,
    getReviewer: () => reviewer,
    getPublisher: () => publisher,
    logger,
    llmAvailable: () => llmFace !== undefined,
    llmInfo,
    version: VERSION,
  })
  const handler = createJsonRouteHandler({
    routes,
    deadlineMs: config.requestTimeoutMs,
    deadlines: { [PATHS.reviewPublish]: PUBLISH_TIMEOUT_MS + 5_000 },
    logger,
  })
  const chatHandler = createChatRouteHandler({
    handle: createChatStreamHandler({
      github,
      clients,
      accountRuntime,
      defaultAccount: () => accountRuntime.defaultAccount,
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
  ctx.effect(() => () => reviewer?.dispose?.(), 'dsh-codex-review: auto-review scheduler')
  // Drop pending publish locks so a reload never leaves callers chained forever.
  ctx.effect(() => () => {
    publisher?.dispose?.()
  }, 'dsh-codex-review: review publisher')
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
  const { github, clients, accountRuntime, defaultAccount, engine, streamLlm, llmAvailable, config, limiter } = wiring
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

      const requestedAccount = typeof request.account === 'string' ? request.account.trim() : ''
      const fallbackAccount = typeof defaultAccount === 'function' ? defaultAccount() : defaultAccount
      const accountId = requestedAccount !== '' ? requestedAccount : fallbackAccount
      const runtimeClients = accountRuntime?.clients
      const client = runtimeClients !== undefined ? runtimeClients[accountId] : (clients !== undefined ? clients[accountId] : github)
      if (client === undefined) throw badRequest(`未知账号：${accountId}`)
      if (client.unavailable === true) throw new AppError('ACCOUNT_UNAVAILABLE', client.reason)
      const meta = accountRuntime?.accounts?.find((entry) => entry.id === accountId)
      const accountType = meta?.type === 'gitlab' ? 'gitlab' : 'github'
      const repoValid = accountType === 'gitlab' ? isValidGitlabRepo(request.repo) : REPO_RE.test(request.repo)
      if (!repoValid) {
        throw badRequest(accountType === 'gitlab' ? 'repo 必须是 GitLab 项目路径（group/project）' : 'repo 必须是 owner/name 形式')
      }
      const detail = await client.getPull(request.repo, request.number)
      const headSha = typeof detail?.headSha === 'string' ? detail.headSha : ''
      const review = engine.existing(request.repo, request.number, headSha, accountId)
      const context = await client.chatContext({
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
  const { config, clients, accountRuntime, defaultAccount, github, engine, llmAvailable, llmInfo, version = VERSION } = wiring
  // The scheduler/publisher can be created lazily after an account is added, so
  // routes must read them through accessors instead of a construction snapshot.
  const getReviewer = typeof wiring.getReviewer === 'function' ? wiring.getReviewer : () => wiring.reviewer
  const getPublisher = typeof wiring.getPublisher === 'function' ? wiring.getPublisher : () => wiring.publisher
  /** A missing writer keeps tests and fallback runtimes away from the real profile. */
  const saveStore = typeof wiring.saveStore === 'function' ? wiring.saveStore : null
  const tokenWriter = typeof wiring.tokenWriter === 'function' ? wiring.tokenWriter : writeAccountToken
  const tokenRemover = typeof wiring.tokenRemover === 'function' ? wiring.tokenRemover : removeAccountToken
  const runtime = accountRuntime ?? (() => {
    const fallbackAccounts = clients !== undefined
      ? Object.entries(clients).map(([id]) => ({ id, type: id, label: id, baseUrl: '', username: '' }))
      : (github !== undefined
          ? [{ id: 'github', type: 'github', label: 'GitHub', baseUrl: '', username: '' }]
          : [])
    const fallbackClients = clients ?? (github !== undefined ? { github } : {})
    return {
      accounts: fallbackAccounts,
      clients: fallbackClients,
      defaultAccount: defaultAccount ?? fallbackAccounts[0]?.id ?? '',
      store: { accounts: [], defaultAccount: defaultAccount ?? '', present: false },
      rebuild() {},
    }
  })()

  /** jobId → PR ref, so `/review-status` can attach the persisted publish record. @type {Map<string, { repo: string, number: number, account: string }>} */
  const jobRefs = new Map()
  /** The GitHub account the bound auto-review/publish pair may write through. */
  const currentPrimaryGithub = () => runtime.accounts.find(
    (account) => account.type === 'github' && runtime.clients[account.id]?.unavailable !== true,
  )

  /**
   * Resolve the account a route acts on. An explicit `account` wins; otherwise
   * the profile default is used, so single-account callers keep working.
   * @param {Record<string, unknown>} payload - parsed request body.
   * @returns {{ id: string, type: 'github' | 'gitlab', label: string, client: any, capabilities: ReturnType<typeof providerCapabilities>, labels: any }} resolved account.
   * @throws {AppError} BAD_REQUEST for an unknown account id.
   */
  const resolveAccount = (payload) => {
    const requested = payload !== null && typeof payload === 'object' && typeof payload.account === 'string'
      ? payload.account.trim()
      : ''
    const id = requested !== '' ? requested : runtime.defaultAccount
    if (runtime.accounts.length === 0) throw new AppError('ACCOUNT_UNAVAILABLE', '还没有配置任何账号')
    const client = runtime.clients[id]
    if (client === undefined) throw badRequest(`未知账号：${id}`)
    if (client.unavailable === true) throw new AppError('ACCOUNT_UNAVAILABLE', client.reason)
    const meta = runtime.accounts.find((entry) => entry.id === id) ?? { id, type: id, label: id }
    const type = meta.type === 'gitlab' ? 'gitlab' : 'github'
    return { id, type, label: meta.label, client, capabilities: providerCapabilities(type), labels: PROVIDER_LABELS[type] }
  }

  /** Return the public account list (never includes tokens). */
  const accountListValue = () => ({
    accounts: runtime.accounts.map((account) => {
      const type = account.type === 'gitlab' ? 'gitlab' : 'github'
      const primary = currentPrimaryGithub()
      const capabilities = type === 'github'
        ? { ...providerCapabilities('github'), publish: primary?.id === account.id, autoReview: primary?.id === account.id }
        : providerCapabilities('gitlab')
      return {
        id: account.id,
        type: account.type,
        label: account.label,
        baseUrl: account.baseUrl,
        username: account.username,
        capabilities,
        labels: PROVIDER_LABELS[type],
      }
    }),
    defaultAccount: runtime.defaultAccount,
  })

  /** Persist the current runtime accounts and default. */
  const persistAccounts = (previous) => {
    if (saveStore === null) {
      runtime.store = { accounts: runtime.accounts, defaultAccount: runtime.defaultAccount, present: true }
      return
    }
    try {
      saveStore({ accounts: runtime.accounts, defaultAccount: runtime.defaultAccount })
      runtime.store = { accounts: runtime.accounts, defaultAccount: runtime.defaultAccount, present: true }
    } catch (error) {
      // A failed write must roll the in-memory account list back to disk.
      /** @type {any} */
      let reloaded
      try {
        reloaded = loadAccountStore()
      } catch {
        reloaded = undefined
      }
      const restored = reloaded ?? previous
      if (restored !== undefined) {
        runtime.accounts = restored.accounts.slice()
        runtime.defaultAccount = restored.defaultAccount
        runtime.store = { ...restored, present: true }
        runtime.rebuild()
      }
      throw error
    }
  }

  /** Auto-review config is GitHub-backed; an explicitly non-GitHub account is rejected. */
  const assertAutoReviewAccount = (payload) => {
    const requested = payload !== null && typeof payload === 'object' && typeof payload.account === 'string'
      ? payload.account.trim()
      : ''
    if (requested === '') return
    const meta = runtime.accounts.find((account) => account.id === requested)
    if (meta === undefined) throw badRequest(`未知账号：${requested}`)
    if (meta.type !== 'github' || meta.id !== currentPrimaryGithub()?.id) {
      throw new AppError('PROVIDER_UNSUPPORTED')
    }
  }

  /**
   * Reject a write operation the account cannot perform.
   * @param {ReturnType<typeof providerCapabilities>} capabilities - account flags.
   * @param {keyof ReturnType<typeof providerCapabilities>} capability - capability flag.
   * @returns {void}
   * @throws {AppError} PROVIDER_UNSUPPORTED when the flag is off.
   */
  const requireWrite = (capabilities, capability) => {
    if (!capabilities[capability]) throw new AppError('PROVIDER_UNSUPPORTED')
  }

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
  const autoPublishAfterReview = (jobId, repo, number, accountId) => {
    const account = runtime.accounts.find((entry) => entry.id === accountId)
    if (account?.type !== 'github') return
    const primary = currentPrimaryGithub()
    if (primary === undefined || accountId !== primary.id) return
    const publisherNow = getPublisher()
    if (typeof engine.waitForCompletion !== 'function' || typeof publisherNow?.publish !== 'function') return
    const isEnabled = () => {
      try {
        return getReviewer()?.status?.()?.publish?.enabled === true
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
        // A partially completed review must never be published as complete.
        if (finished.partial === true) {
          logger?.warn?.(`dsh-codex-review: auto publish skipped ${repo}#${number}: review is partial`)
          return
        }
        const publishConfig = getReviewer()?.status?.()?.publish
        if (publishConfig?.enabled !== true) return
        await publisherNow.publish({
          account: accountId,
          repo,
          number,
          confirm: true,
          headSha: finished.headSha,
          jobId,
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
    const account = resolveAccount(payload)
    const repo = requireString(payload, 'repo', 'repo')
    const validRepo = account.type === 'gitlab' ? isValidGitlabRepo(repo) : REPO_RE.test(repo)
    if (!validRepo) throw badRequest(account.type === 'gitlab' ? 'repo 必须是 GitLab 项目路径（group/project）' : 'repo 必须是 owner/name 形式')
    const rawNumber = payload.number
    const number = typeof rawNumber === 'number' ? rawNumber : typeof rawNumber === 'string' ? Number(rawNumber) : Number.NaN
    if (!Number.isInteger(number) || number <= 0) throw badRequest('number 必须是正整数')
    return { id: account.id, type: account.type, repo, number }
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
  const withReview = (repo, number, detail, account = '') => {
    const headSha = typeof detail?.headSha === 'string' ? detail.headSha : ''
    const review = engine.existing(repo, number, headSha, account)
    const reviewerNow = getReviewer()
    if (headSha === '' || typeof reviewerNow?.getPublished !== 'function') return { ...detail, review }
    const record = reviewerNow.getPublished(publishRecordKeys(account, repo, number, headSha).headKey)
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
      /** @type {Array<any>} */
      const accounts = []
      for (const meta of runtime.accounts) {
        const id = meta.id
        const type = meta.type === 'gitlab' ? 'gitlab' : 'github'
        const client = runtime.clients[id]
        if (client === undefined) continue
        const accountCapabilities = providerCapabilities(type)
        const accountLabels = PROVIDER_LABELS[type]
        const primary = currentPrimaryGithub()
        const capabilities = type === 'github'
          ? {
              ...accountCapabilities,
              // Publishing/auto-review are bound to the primary GitHub client.
              publish: primary?.id === id,
              autoReview: primary?.id === id,
            }
          : accountCapabilities
        /** @type {Record<string, unknown>} */
        const entry = {
          id,
          type,
          provider: type,
          label: meta.label,
          username: meta.username,
          baseUrl: meta.baseUrl,
          ok: false,
          viewer: '',
          capabilities,
          labels: accountLabels,
        }
        if (client.unavailable === true) {
          entry.error = client.reason || 'ACCOUNT_UNAVAILABLE'
          accounts.push(entry)
          continue
        }
        if (type === 'github') {
          let gh = 'missing'
          try {
            gh = await client.ghStatus()
          } catch {
            gh = 'not-logged-in'
          }
          entry.ok = gh === 'ok'
          entry.gh = gh
          if (entry.ok) {
            try {
              entry.viewer = await client.getAuthenticatedUser()
            } catch {
              entry.viewer = ''
            }
          }
        } else {
          try {
            const accountStatus = await client.status()
            entry.ok = accountStatus.ok === true
            entry.viewer = accountStatus.viewer || meta.username || ''
            if (typeof accountStatus.error === 'string') entry.error = accountStatus.error
          } catch {
            entry.error = 'GL_NETWORK'
          }
        }
        accounts.push(entry)
      }
      const primary = accounts.find((entry) => entry.id === runtime.defaultAccount) ?? accounts[0]
      return {
        provider: primary.provider,
        ok: primary.ok,
        viewer: primary.viewer,
        llm: llmAvailable() ? 'ok' : 'unavailable',
        version,
        capabilities: primary.capabilities,
        labels: primary.labels,
        accounts,
        defaultAccount: runtime.defaultAccount,
        ...(primary.gh !== undefined ? { gh: primary.gh } : {}),
        ...(primary.error !== undefined ? { error: primary.error } : {}),
      }
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
      const account = resolveAccount(payload)
      const query = typeof payload.query === 'string' && payload.query.trim() !== '' ? payload.query.trim() : config.defaultQuery
      const rawLimit = payload.limit
      const limit = typeof rawLimit === 'number' && Number.isFinite(rawLimit)
        ? Math.min(100, Math.max(1, Math.floor(rawLimit)))
        : config.limit
      return account.client.listPullRequests({ query, limit })
    },

    [PATHS.pr]: async (payload) => {
      const account = resolveAccount(payload)
      const { id: accountId, repo, number } = requirePullRef(payload)
      const detail = await account.client.getPull(repo, number)
      return withReview(repo, number, detail, accountId)
    },

    [PATHS.reviewStart]: async (payload, context) => {
      const account = resolveAccount(payload)
      const { id: accountId, repo, number } = requirePullRef(payload)
      if (!engine.available()) throw new AppError('LLM_UNAVAILABLE')
      // Resolve the v1.1 options here as well so the guideline fetch happens
      // only when requested; the engine resolves the same values internally.
      const shared = getReviewer()?.status?.()?.config ?? {}
      const options = resolveReviewOptions({ ...shared, ...(payload.options ?? {}) }, config)
      const detail = await account.client.getPull(repo, number)
      const headSha = typeof detail?.headSha === 'string' ? detail.headSha : ''
      if (headSha === '') throw new AppError('GH_NOT_FOUND', '无法确定该 PR 的 head commit')
      let guidelines
      if (options.includeGuidelines && typeof account.client.getGuidelines === 'function') {
        try {
          guidelines = await account.client.getGuidelines(repo, { signal: context?.signal })
        } catch {
          // Guidelines are an enhancement: never let them block the review.
          guidelines = undefined
        }
      }
      const started = engine.start({
        repo,
        number,
        account: accountId,
        headSha,
        title: detail?.summary?.title,
        body: detail?.body,
        baseRefName: detail?.summary?.baseRefName,
        headRefName: detail?.summary?.headRefName,
        files: Array.isArray(detail?.files) ? detail.files : [],
        options,
        guidelines,
      })
      jobRefs.set(started.jobId, { repo, number, account: accountId })
      if (jobRefs.size > 200) {
        const oldest = jobRefs.keys().next()
        if (oldest.done !== true) jobRefs.delete(oldest.value)
      }
      autoPublishAfterReview(started.jobId, repo, number, accountId)
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
      const reviewerNow = getReviewer()
      if (ref === undefined || typeof reviewerNow?.getPublished !== 'function') return status
      const headSha = typeof status?.headSha === 'string' ? status.headSha : ''
      if (headSha === '') return status
      const record = reviewerNow.getPublished(publishRecordKeys(ref.account, ref.repo, ref.number, headSha).headKey)
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
      const account = resolveAccount(payload)
      const { id: accountId, repo, number } = requirePullRef(payload)
      requireWrite(account.capabilities, 'merge')
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
      const result = await account.client.mergePull({
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
      if (typeof engine.invalidate === 'function') engine.invalidate(repo, number, accountId)
      return result
    },

    [PATHS.autoReviewStatus]: async (payload) => {
      assertAutoReviewAccount(payload)
      const reviewerNow = getReviewer()
      if (reviewerNow === undefined || currentPrimaryGithub() === undefined) throw new AppError('PROVIDER_UNSUPPORTED')
      return reviewerNow.status()
    },

    [PATHS.autoReviewConfig]: async (payload) => {
      assertAutoReviewAccount(payload)
      const reviewerNow = getReviewer()
      if (reviewerNow === undefined || currentPrimaryGithub() === undefined) throw new AppError('PROVIDER_UNSUPPORTED')
      if (payload.patch === undefined) return reviewerNow.status()
      if (payload.patch === null || typeof payload.patch !== 'object' || Array.isArray(payload.patch)) {
        throw badRequest('patch 必须是对象')
      }
      return reviewerNow.updateConfig(payload.patch)
    },

    [PATHS.autoReviewRun]: async (payload) => {
      assertAutoReviewAccount(payload)
      const reviewerNow = getReviewer()
      if (reviewerNow === undefined || currentPrimaryGithub() === undefined) throw new AppError('PROVIDER_UNSUPPORTED')
      return reviewerNow.runOnce({ force: payload.force === true })
    },

    [PATHS.reviewPublish]: async (payload, context) => {
      const account = resolveAccount(payload)
      const { id: accountId, repo, number } = requirePullRef(payload)
      requireWrite(account.capabilities, 'publish')
      const primary = currentPrimaryGithub()
      if (primary === undefined || accountId !== primary.id) {
        throw new AppError('PROVIDER_UNSUPPORTED')
      }
      // Writing a GitHub review always needs the explicit confirmation flag.
      if (payload.confirm !== true) throw badRequest('发布审查到 GitHub 需要 confirm: true')
      // Defaults come from the persisted publish config; explicit values win.
      const publishConfig = getReviewer()?.status?.()?.config?.publish ?? PUBLISH_DEFAULTS
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
      const publisherNow = getPublisher()
      if (publisherNow === undefined) throw new AppError('INTERNAL', '发布器未初始化')
      const jobId = typeof payload.jobId === 'string' ? payload.jobId.trim() : ''
      const headSha = typeof payload.headSha === 'string' ? payload.headSha.trim() : ''
      return publisherNow.publish({
        account: accountId,
        repo,
        number,
        confirm: true,
        ...(jobId === '' ? {} : { jobId }),
        ...(headSha === '' ? {} : { headSha }),
        mode,
        minSeverity,
        maxComments: publishConfig.maxComments ?? PUBLISH_DEFAULTS.maxComments,
        body: customBody,
        signal: context?.signal,
      })
    },

    [PATHS.comment]: async (payload) => {
      const account = resolveAccount(payload)
      const { repo, number } = requirePullRef(payload)
      requireWrite(account.capabilities, 'comment')
      // Every comment write needs the explicit confirmation flag.
      if (payload.confirm !== true) throw badRequest('发表评论需要 confirm: true')
      return account.client.createIssueComment({ repo, number, body: payload.body })
    },

    [PATHS.reply]: async (payload) => {
      const account = resolveAccount(payload)
      const { repo, number } = requirePullRef(payload)
      requireWrite(account.capabilities, 'reply')
      if (payload.confirm !== true) throw badRequest('回复评论需要 confirm: true')
      const commentId = Number(payload.commentId)
      if (!Number.isInteger(commentId) || commentId <= 0) throw badRequest('commentId 必须是正整数')
      return account.client.replyToReviewComment({ repo, number, commentId, body: payload.body })
    },

    [PATHS.resolve]: async (payload) => {
      const account = resolveAccount(payload)
      const { repo, number } = requirePullRef(payload)
      requireWrite(account.capabilities, 'resolve')
      if (payload.confirm !== true) throw badRequest('解决讨论需要 confirm: true')
      const threadId = typeof payload.threadId === 'string' ? payload.threadId.trim() : ''
      if (threadId === '' || threadId.length > 200) throw badRequest('threadId 不合法')
      return account.client.resolveReviewThread({ repo, number, threadId })
    },

    [PATHS.accounts]: async () => accountListValue(),

    [PATHS.accountsAdd]: async (payload) => {
      if (payload.confirm !== true) throw badRequest('添加账号需要 confirm: true')
      const input = normalizeAccountInput(payload)
      const token = accountTokenInput(payload)
      if (input.type === 'github' && token === '') {
        throw badRequest('新增 GitHub 账号需要 Token')
      }
      const id = makeAccountId(input.type, input.label, runtime.accounts)
      if (input.type === 'github' && token === '') {
        throw badRequest('新增 GitHub 账号需要 Token')
      }
      const previous = { accounts: runtime.accounts.slice(), defaultAccount: runtime.defaultAccount }
      if (token !== '') tokenWriter(id, token)
      runtime.accounts.push({
        id,
        type: input.type,
        label: input.label,
        baseUrl: input.baseUrl,
        username: input.username,
      })
      if (runtime.accounts.length === 1) runtime.defaultAccount = id
      persistAccounts(previous)
      runtime.rebuild()
      return accountListValue()
    },

    [PATHS.accountsRemove]: async (payload) => {
      if (payload.confirm !== true) throw badRequest('删除账号需要 confirm: true')
      const id = requireString(payload, 'id', 'account id')
      const target = runtime.accounts.find((account) => account.id === id)
      if (target === undefined) throw badRequest('账号不存在')
      const remaining = runtime.accounts.filter((account) => account.id !== id)
      if (remaining.length === 0) throw badRequest('至少保留一个账号')
      const previous = { accounts: runtime.accounts.slice(), defaultAccount: runtime.defaultAccount }
      tokenRemover(id)
      runtime.accounts = remaining
      if (runtime.defaultAccount === id) runtime.defaultAccount = remaining[0].id
      persistAccounts(previous)
      runtime.rebuild()
      // Removing the last GitHub account must stop the GitHub-bound scheduler.
      if (currentPrimaryGithub() === undefined) {
        try {
          getReviewer()?.dispose?.()
          getPublisher()?.dispose?.()
        } catch {
          /* disposal is best effort */
        }
      }
      return accountListValue()
    },

    [PATHS.accountsTest]: async (payload) => {
      if (payload.confirm !== true) throw badRequest('测试账号需要 confirm: true')
      const input = normalizeAccountInput(payload)
      const token = accountTokenInput(payload)
      if (input.type === 'gitlab') {
        const client = new GitLabClient({
          config: {
            ...config,
            gitlabBaseUrl: input.baseUrl || config.gitlabBaseUrl || '',
            gitlabToken: token,
          },
          logger,
        })
        const status = await client.status()
        return {
          ok: status.ok === true,
          type: input.type,
          viewer: status.viewer || input.username,
          ...(typeof status.error === 'string' ? { error: status.error } : {}),
        }
      }
      const client = new GitHubClient({ config, logger, token })
      try {
        const viewer = await client.getAuthenticatedUser()
        return { ok: true, type: input.type, viewer }
      } catch (error) {
        return { ok: false, type: input.type, viewer: '', error: error instanceof AppError ? error.code : 'GH_NOT_LOGGED_IN' }
      }
    },

    [PATHS.accountsDefault]: async (payload) => {
      if (payload.confirm !== true) throw badRequest('设置默认账号需要 confirm: true')
      const id = requireString(payload, 'id', 'account id')
      if (!runtime.accounts.some((account) => account.id === id)) throw badRequest('账号不存在')
      const previous = { accounts: runtime.accounts.slice(), defaultAccount: runtime.defaultAccount }
      runtime.defaultAccount = id
      persistAccounts(previous)
      return accountListValue()
    },
  }
}
