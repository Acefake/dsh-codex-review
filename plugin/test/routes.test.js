/**
 * Route-level tests: mount the plugin against a fake Cordis context (no host
 * process) and call the registered prefix handler with mock req/res objects.
 * This is the "works outside DSH" acceptance smoke from CONTRACT §1.6.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { applyWithDeps, VERSION } from '../index.js'
import { AppError } from '../lib/errors.js'
import { buildChatContext, createChatLimiter } from '../lib/chat.js'
import { PUBLISH_DEFAULTS } from '../lib/publish.js'

/**
 * Fake Cordis context: captures webServer registrations and effects.
 * @returns {{ ctx: any, routes: Map<string, any>, disposers: Function[] }} harness.
 */
function createFakeContext() {
  const routes = new Map()
  const disposers = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    webServer: {
      register(route) {
        routes.set(route.path, route)
        return () => {
          routes.delete(route.path)
        }
      },
    },
    effect(callback) {
      disposers.push(callback())
    },
    inject() {
      return { dispose() {} }
    },
  }
  return { ctx, routes, disposers }
}

/**
 * Build a readable request stub.
 * @param {string} url - request target.
 * @param {unknown} [body] - JSON body.
 * @param {Record<string, unknown>} [headers] - header overrides.
 * @returns {any} request stub.
 */
function makeRequest(url, body = {}, headers = {}) {
  const request = Readable.from([Buffer.from(JSON.stringify(body))])
  request.url = url
  request.method = 'POST'
  request.headers = { host: '127.0.0.1:2632', 'content-type': 'application/json', ...headers }
  request.socket = { remoteAddress: '127.0.0.1' }
  return request
}

/** @returns {any} response stub. */
function makeResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.statusCode = status
      this.headers = headers
      return this
    },
    end(chunk) {
      if (chunk !== undefined) this.body += String(chunk)
    },
    destroy() {},
  }
}

/**
 * Call the mounted prefix handler.
 * @param {any} handler - node handler.
 * @param {string} pathname - route path.
 * @param {unknown} [body] - JSON body.
 * @param {Record<string, unknown>} [headers] - header overrides.
 * @returns {Promise<{ status: number, body: any }>} status + decoded envelope.
 */
async function call(handler, pathname, body = {}, headers = {}) {
  const request = makeRequest(pathname, body, headers)
  const response = makeResponse()
  await handler(request, response)
  return { status: response.statusCode, body: response.body === '' ? undefined : JSON.parse(response.body) }
}

/** PR detail the fake GitHub client returns. */
const DETAIL = {
  headSha: 'abc123',
  summary: {
    repo: 'Acefake/yingbox',
    number: 129,
    title: 'feat(player): 自动检测片头片尾',
    state: 'open',
    baseRefName: 'feat/skip-intro',
    headRefName: 'feat/intro-detect',
  },
  body: '正文',
  bodyTruncated: false,
  files: [{ path: 'src/a.ts', patch: '@@ -1 +1 @@\n-a\n+b', status: 'modified', additions: 1, deletions: 1, patchTruncated: false }],
  filesTruncated: false,
  comments: { total: 0, issue: [], reviews: [], inline: [] },
  checks: { state: 'none', items: [] },
  stack: { baseRefName: 'feat/skip-intro', chain: [], allBaseMerged: true },
}

/**
 * Build a fake automatic reviewer that never touches the filesystem or timers.
 * @returns {{ status: any, updateConfig: any, runOnce: any, dispose: any, statusCalls: number, configPatches: any[], runOptions: any[] }} fake reviewer.
 */
function createFakeReviewer() {
  return {
    statusCalls: 0,
    configPatches: [],
    runOptions: [],
    status() {
      this.statusCalls += 1
      return {
        config: {
          enabled: false,
          intervalSeconds: 180,
          query: 'is:open author:@me',
          depth: 'fast',
          severityThreshold: 'P2',
          includeDrafts: false,
          maxPerCycle: 2,
          publish: { ...PUBLISH_DEFAULTS },
        },
        running: false,
        seenCount: 0,
        recent: [],
        publish: { ...PUBLISH_DEFAULTS },
      }
    },
    updateConfig(patch) {
      this.configPatches.push(patch)
      const status = this.status()
      return { ...status, config: { ...status.config, ...patch } }
    },
    runOnce(options) {
      this.runOptions.push(options)
      return options.force === true ? { started: true } : { started: false, reason: '自动审查已关闭（可带 force:true 单次运行）' }
    },
    dispose() {},
  }
}

/**
 * Build a fake publisher that records every publish request.
 * @returns {{ calls: any[], publish: any }} publisher spy.
 */
function createFakePublisher() {
  return {
    calls: [],
    async publish(input) {
      this.calls.push(input)
      return {
        published: true,
        reviewId: 77,
        url: 'https://github.com/Acefake/yingbox/pull/129#pullrequestreview-77',
        comments: 2,
        skipped: 0,
        headSha: 'abc123',
      }
    },
  }
}

/**
 * Build the fake GitHub client + fake review engine pair.
 * @returns {{ github: any, engine: any, reviewer: any, publisher: any, started: any[], guidelineCalls: string[], mergeCalls: any[], invalidated: any[] }} doubles.
 */
function createDoubles() {
  const started = []
  const guidelineCalls = []
  const mergeCalls = []
  const invalidated = []
  const commentWrites = []
  const reviewer = createFakeReviewer()
  const publisher = createFakePublisher()
  let disposed = false
  const github = {
    async ghStatus() {
      return 'ok'
    },
    async listPullRequests({ query, limit }) {
      return {
        query,
        totalCount: 1,
        items: [{ repo: 'Acefake/yingbox', number: 129, title: 't', author: 'Acefake', state: 'open', isDraft: false }],
        limit,
      }
    },
    async getPull() {
      return DETAIL
    },
    async getGuidelines(repo) {
      guidelineCalls.push(repo)
      return { loaded: true, files: ['AGENTS.md'], chars: 12, text: '仓库专属约定' }
    },
    async mergePull(input) {
      mergeCalls.push(input)
      return { merged: true, sha: 'merge-sha-001', message: 'Pull Request successfully merged' }
    },
    async createIssueComment(input) {
      commentWrites.push({ kind: 'comment', input })
      return { id: 5, url: 'https://github.com/Acefake/yingbox/issues/129#issuecomment-5', createdAt: '2026-10-25T00:00:00Z' }
    },
    async replyToReviewComment(input) {
      commentWrites.push({ kind: 'reply', input })
      return { id: 6, url: 'https://github.com/Acefake/yingbox/pull/129#discussion_r6', createdAt: '2026-10-25T00:00:00Z' }
    },
    async resolveReviewThread(input) {
      commentWrites.push({ kind: 'resolve', input })
      return { resolved: true }
    },
    async chatContext(input) {
      return buildChatContext(input)
    },
  }
  const engine = {
    available() {
      return false
    },
    existing(repo, number, headSha) {
      return { state: 'none', headSha, findings: [] }
    },
    start(input) {
      started.push(input)
      return { jobId: 'job-1', headSha: input.headSha, cached: false }
    },
    status(jobId) {
      return {
        jobId,
        state: 'done',
        progress: { phase: 'done', filesDone: 1, filesTotal: 1, startedAt: 0, elapsedMs: 1 },
        headSha: 'abc123',
        findings: [],
      }
    },
    cancel() {
      return true
    },
    async waitForCompletion() {
      // The fake review is already finished; the auto-publish path just needs
      // the seam to exist and resolve.
    },
    resolveModel() {
      return { provider: 'opencode-go', model: 'deepseek-v4.1-flash' }
    },
    invalidate(repo, number) {
      invalidated.push({ repo, number })
      return 1
    },
    dispose() {
      disposed = true
    },
    isDisposed() {
      return disposed
    },
  }
  return { github, engine, reviewer, publisher, started, guidelineCalls, mergeCalls, invalidated, commentWrites }
}

/**
 * Mount the plugin and return its handler plus harness.
 * @param {{ llmAvailable?: boolean }} [options] - extra wiring.
 * @returns {{ handler: any, routes: Map<string, any>, disposers: Function[], doubles: ReturnType<typeof createDoubles> }} mounted plugin.
 */
function mount(options = {}) {
  const { ctx, routes, disposers } = createFakeContext()
  const doubles = createDoubles()
  if (options.llmAvailable === true) doubles.engine.available = () => true
  applyWithDeps(ctx, { requestTimeoutMs: 5000 }, { github: doubles.github, engine: doubles.engine, reviewer: doubles.reviewer, publisher: doubles.publisher })
  const route = routes.get('/codex-review')
  assert.ok(route !== undefined, 'the prefix route must be registered')
  assert.equal(route.kind, 'prefix')
  return { handler: route.handler, routes, disposers, doubles }
}

test('mount registers the prefix route, the exact chat route and the engine disposer', () => {
  const { routes, disposers } = mount()
  assert.deepEqual([...routes.keys()].sort(), ['/codex-review', '/codex-review/chat'])
  assert.equal(routes.get('/codex-review').kind, 'prefix')
  assert.equal(routes.get('/codex-review/chat').kind, 'exact')
  assert.equal(disposers.length, 6)
})

test('health reports gh, llm and version', async () => {
  const { handler } = mount()
  const answer = await call(handler, '/codex-review/health')
  assert.equal(answer.status, 200)
  const health = answer.body.value
  assert.equal(health.provider, 'github')
  assert.equal(health.gh, 'ok')
  assert.equal(health.llm, 'unavailable')
  assert.equal(health.version, VERSION)
  assert.equal(health.capabilities.merge, true)
  assert.deepEqual(health.labels, { item: 'PR', itemFull: 'Pull Request', reviewers: 'Reviewers', checks: 'Checks' })
})

test('prs applies the configured default query and clamps the limit', async () => {
  const { handler } = mount()
  const defaults = await call(handler, '/codex-review/prs')
  assert.equal(defaults.body.value.query, 'is:open author:@me')
  assert.equal(defaults.body.value.totalCount, 1)
  assert.equal(defaults.body.value.items.length, 1)
  const explicit = await call(handler, '/codex-review/prs', { query: 'is:open label:bug', limit: 500 })
  assert.equal(explicit.body.value.query, 'is:open label:bug')
  assert.equal(explicit.body.value.limit, 100)
})

test('pr returns the detail with a review snapshot', async () => {
  const { handler } = mount()
  const answer = await call(handler, '/codex-review/pr', { repo: 'Acefake/yingbox', number: 129 })
  assert.equal(answer.body.ok, true)
  assert.equal(answer.body.value.summary.number, 129)
  assert.deepEqual(answer.body.value.review, { state: 'none', headSha: 'abc123', findings: [] })
  const bad = await call(handler, '/codex-review/pr', { repo: 'not-a-repo', number: 129 })
  assert.equal(bad.body.ok, false)
  assert.equal(bad.body.error.code, 'BAD_REQUEST')
  const badNumber = await call(handler, '/codex-review/pr', { repo: 'a/b', number: -1 })
  assert.equal(badNumber.body.error.code, 'BAD_REQUEST')
})

test('pr attaches the persisted publish record to the review snapshot', async () => {
  const { handler, doubles } = mount()
  doubles.engine.existing = () => ({ state: 'done', headSha: 'abc123', findings: [], verdict: 'changes' })
  doubles.reviewer.getPublished = (key) => (
    key === 'Acefake/yingbox#129@abc123'
      ? { publishedAt: 1234, reviewId: 77, url: 'https://github.com/Acefake/yingbox/pull/129#pullrequestreview-77' }
      : undefined
  )
  const answer = await call(handler, '/codex-review/pr', { repo: 'Acefake/yingbox', number: 129 })
  assert.equal(answer.body.ok, true)
  assert.equal(answer.body.value.review.state, 'done')
  assert.deepEqual(answer.body.value.review.published, {
    publishedAt: 1234,
    reviewId: 77,
    url: 'https://github.com/Acefake/yingbox/pull/129#pullrequestreview-77',
    headSha: 'abc123',
  })
  // A head with no publish record keeps the plain review snapshot.
  doubles.reviewer.getPublished = () => undefined
  const plain = await call(handler, '/codex-review/pr', { repo: 'Acefake/yingbox', number: 129 })
  assert.equal(plain.body.value.review.published, undefined)
})

test('review-start auto-publishes a finished review only when publish.enabled is on', async () => {
  const wait = () => new Promise((resolve) => setTimeout(resolve, 25))

  const disabled = mount({ llmAvailable: true })
  await call(disabled.handler, '/codex-review/review-start', { repo: 'Acefake/yingbox', number: 129 })
  await wait()
  assert.equal(disabled.doubles.publisher.calls.length, 0, 'publishing stays off by default')

  const enabled = mount({ llmAvailable: true })
  enabled.doubles.reviewer.status = () => ({
    config: { enabled: false },
    publish: { ...PUBLISH_DEFAULTS, enabled: true, mode: 'summary', minSeverity: 'P1', maxComments: 5 },
    running: false,
    seenCount: 0,
    recent: [],
  })
  await call(enabled.handler, '/codex-review/review-start', { repo: 'Acefake/yingbox', number: 129 })
  await wait()
  assert.equal(enabled.doubles.publisher.calls.length, 1, 'a finished manual review is published once')
  const publishCall = enabled.doubles.publisher.calls[0]
  assert.equal(publishCall.confirm, true)
  assert.equal(publishCall.mode, 'summary')
  assert.equal(publishCall.minSeverity, 'P1')
  assert.equal(publishCall.maxComments, 5)
})

test('review-status carries the publish record once the head is published', async () => {  const { handler, doubles } = mount({ llmAvailable: true })
  await call(handler, '/codex-review/review-start', { repo: 'Acefake/yingbox', number: 129 })
  doubles.reviewer.getPublished = (key) => (
    key === 'Acefake/yingbox#129@abc123'
      ? { publishedAt: 1234, reviewId: 77, url: 'https://github.com/Acefake/yingbox/pull/129#pullrequestreview-77' }
      : undefined
  )
  const answer = await call(handler, '/codex-review/review-status', { jobId: 'job-1' })
  assert.equal(answer.body.value.state, 'done')
  assert.deepEqual(answer.body.value.published, {
    publishedAt: 1234,
    reviewId: 77,
    url: 'https://github.com/Acefake/yingbox/pull/129#pullrequestreview-77',
    headSha: 'abc123',
  })
})

test('review-start forwards the PR snapshot to the engine and answers the job reference', async () => {
  const { handler, doubles } = mount({ llmAvailable: true })
  const answer = await call(handler, '/codex-review/review-start', { repo: 'Acefake/yingbox', number: 129 })
  assert.deepEqual(answer.body, {
    ok: true,
    value: {
      jobId: 'job-1',
      headSha: 'abc123',
      cached: false,
      options: { depth: 'fast', severityThreshold: 'P2', includeGuidelines: true, chunkChars: 16000, maxChunks: 6, concurrency: 4 },
    },
  })
  assert.equal(doubles.started.length, 1)
  assert.equal(doubles.started[0].repo, 'Acefake/yingbox')
  assert.equal(doubles.started[0].number, 129)
  assert.equal(doubles.started[0].headSha, 'abc123')
  assert.equal(doubles.started[0].files.length, 1)
  assert.deepEqual(doubles.started[0].options, { depth: 'fast', severityThreshold: 'P2', includeGuidelines: true, chunkChars: 16000, maxChunks: 6, concurrency: 4 })
  assert.deepEqual(doubles.guidelineCalls, ['Acefake/yingbox'])
  assert.equal(doubles.started[0].guidelines.loaded, true)
})

test('review-start resolves the depth presets into concrete budgets', async () => {
  const { handler, doubles } = mount({ llmAvailable: true })
  const answer = await call(handler, '/codex-review/review-start', {
    repo: 'Acefake/yingbox',
    number: 129,
    options: { depth: 'fast', severityThreshold: 'P0', includeGuidelines: false },
  })
  assert.deepEqual(answer.body.value.options, {
    depth: 'fast',
    severityThreshold: 'P0',
    includeGuidelines: false,
    chunkChars: 16000,
    maxChunks: 6,
    concurrency: 4,
  })
  // includeGuidelines=false must not touch the guidelines endpoint at all.
  assert.deepEqual(doubles.guidelineCalls, [])
  assert.equal(doubles.started[0].guidelines, undefined)
})

test('review-start normalizes unknown options instead of rejecting them', async () => {
  const { handler, doubles } = mount({ llmAvailable: true })
  const answer = await call(handler, '/codex-review/review-start', {
    repo: 'Acefake/yingbox',
    number: 129,
    options: { depth: 'turbo', severityThreshold: 'P9', includeGuidelines: true },
  })
  assert.equal(answer.body.ok, true)
  assert.equal(answer.body.value.options.depth, 'standard')
  assert.equal(answer.body.value.options.severityThreshold, 'P2')
})

test('review-start still runs when the guideline lookup fails', async () => {
  const { ctx, routes } = createFakeContext()
  const doubles = createDoubles()
  doubles.engine.available = () => true
  doubles.github.getGuidelines = async () => {
    throw new Error('guideline failure')
  }
  applyWithDeps(ctx, { requestTimeoutMs: 5000 }, { github: doubles.github, engine: doubles.engine, reviewer: doubles.reviewer })
  const handler = routes.get('/codex-review').handler
  const answer = await call(handler, '/codex-review/review-start', { repo: 'Acefake/yingbox', number: 129 })
  assert.equal(answer.body.ok, true)
  assert.equal(doubles.started.length, 1)
  assert.equal(doubles.started[0].guidelines, undefined)
})

test('review-start reports LLM_UNAVAILABLE when the model seam is missing', async () => {
  const { handler } = mount({ llmAvailable: false })
  const answer = await call(handler, '/codex-review/review-start', { repo: 'Acefake/yingbox', number: 129 })
  assert.equal(answer.body.ok, false)
  assert.equal(answer.body.error.code, 'LLM_UNAVAILABLE')
})

test('the real engine reports LLM_UNAVAILABLE when no llm services were ever injected', async () => {
  const { ctx, routes } = createFakeContext()
  const github = {
    async ghStatus() {
      return 'ok'
    },
    async getPull() {
      return DETAIL
    },
    async listPullRequests() {
      return { query: 'q', totalCount: 0, items: [] }
    },
  }
  applyWithDeps(ctx, {}, { github, reviewer: createFakeReviewer() })
  const handler = routes.get('/codex-review').handler
  const answer = await call(handler, '/codex-review/review-start', { repo: 'Acefake/yingbox', number: 129 })
  assert.equal(answer.body.ok, false)
  assert.equal(answer.body.error.code, 'LLM_UNAVAILABLE')
  const health = await call(handler, '/codex-review/health')
  assert.equal(health.body.value.llm, 'unavailable')
})

test('review-status and review-cancel validate jobId and answer engine state', async () => {
  const { handler } = mount()
  const status = await call(handler, '/codex-review/review-status', { jobId: 'job-1' })
  assert.equal(status.body.value.state, 'done')
  const cancelled = await call(handler, '/codex-review/review-cancel', { jobId: 'job-1' })
  assert.deepEqual(cancelled.body, { ok: true, value: { cancelled: true } })
  const missing = await call(handler, '/codex-review/review-status', {})
  assert.equal(missing.body.error.code, 'BAD_REQUEST')
})

test('fence and unknown routes behave like the production transport', async () => {
  const { handler } = mount()
  const denied = await call(handler, '/codex-review/health', {}, { 'x-forwarded-for': '203.0.113.9' })
  assert.equal(denied.status, 403)
  const unknown = await call(handler, '/codex-review/unknown')
  assert.equal(unknown.status, 404)
})

test('disposing the plugin removes the route and disposes the engine', () => {
  const { routes, disposers, doubles } = mount()
  for (const dispose of disposers) dispose()
  assert.equal(routes.size, 0)
  assert.equal(doubles.engine.isDisposed(), true)
})

test('optional llm injection wires ctx.llm.stream into the real review engine', async () => {
  const { ctx, routes, disposers } = createFakeContext()
  const requests = []
  let selectionCalls = 0
  ctx.inject = (deps, callback) => {
    assert.deepEqual([...deps].sort(), ['agentDefaultModel', 'llm'])
    const scope = {
      llm: {
        stream(request) {
          requests.push(request)
          return (async function* generate() {
            yield { type: 'text-delta', index: 0, text: JSON.stringify({ findings: [] }) }
            yield { type: 'finish', reason: { kind: 'stop' } }
          })()
        },
      },
      agentDefaultModel: {
        currentSelection() {
          selectionCalls += 1
          return { provider: 'opencode-go', model: 'deepseek-v4.1-flash' }
        },
      },
      effect(callback) {
        callback()
      },
    }
    callback(scope)
    return { dispose() {} }
  }
  const github = {
    async ghStatus() {
      return 'ok'
    },
    async getPull() {
      return DETAIL
    },
    async listPullRequests() {
      return { query: 'q', totalCount: 0, items: [] }
    },
  }
  applyWithDeps(ctx, { requestTimeoutMs: 5000, reviewChunkChars: 1000 }, { github, reviewer: createFakeReviewer() })
  const handler = routes.get('/codex-review').handler

  const started = await call(handler, '/codex-review/review-start', { repo: 'Acefake/yingbox', number: 129 })
  assert.equal(started.body.ok, true)
  assert.equal(started.body.value.headSha, 'abc123')
  const jobId = started.body.value.jobId

  /** @type {any} */
  let status
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const answer = await call(handler, '/codex-review/review-status', { jobId })
    status = answer.body.value
    if (status.state !== 'queued' && status.state !== 'running') break
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.equal(status.state, 'done')
  assert.equal(status.findings.length, 0)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].provider, 'opencode-go')
  assert.equal(requests[0].model, 'deepseek-v4.1-flash')
  assert.equal(requests[0].messages[0].role, 'user')
  assert.ok(requests[0].messages[0].content[0].text.includes('src/a.ts'))
  assert.equal(selectionCalls, 1)

  const health = await call(handler, '/codex-review/health')
  assert.equal(health.body.value.provider, 'github')
  assert.equal(health.body.value.gh, 'ok')
  assert.equal(health.body.value.llm, 'ok')
  assert.equal(health.body.value.version, VERSION)
  for (const dispose of disposers) dispose()
})

test('review-start through the route layer returns v1.1 status fields and option-aware caching', async () => {
  const { ctx, routes, disposers } = createFakeContext()
  const requests = []
  ctx.inject = (deps, callback) => {
    callback({
      llm: {
        stream(request) {
          requests.push(request)
          return (async function* generate() {
            yield {
              type: 'text-delta',
              index: 0,
              text: JSON.stringify({
                findings: [{
                  severity: 'P1',
                  file: 'src/a.ts',
                  line: 1,
                  title: '空指针',
                  why: '为 null 时崩溃',
                  fix: '判空',
                  evidence: '+b',
                  confidence: 'high',
                }],
              }),
            }
            yield { type: 'finish', reason: { kind: 'stop' } }
          })()
        },
      },
      agentDefaultModel: {
        currentSelection() {
          return { provider: 'opencode-go', model: 'deepseek-v4.1-flash' }
        },
      },
      effect(callback) {
        callback()
      },
    })
    return { dispose() {} }
  }
  const github = {
    async ghStatus() {
      return 'ok'
    },
    async getPull() {
      return DETAIL
    },
    async getGuidelines(repo) {
      return { loaded: true, files: ['AGENTS.md'], chars: 18, text: '所有审查结论用简体中文' }
    },
    async listPullRequests() {
      return { query: 'q', totalCount: 0, items: [] }
    },
  }
  applyWithDeps(ctx, { requestTimeoutMs: 5000, reviewChunkChars: 1000 }, { github, reviewer: createFakeReviewer() })
  const handler = routes.get('/codex-review').handler

  /**
   * Poll one job to a terminal state.
   * @param {string} jobId - job id.
   * @returns {Promise<any>} final ReviewStatus.
   */
  const waitFor = async (jobId) => {
    /** @type {any} */
    let status
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const answer = await call(handler, '/codex-review/review-status', { jobId })
      status = answer.body.value
      if (status.state !== 'queued' && status.state !== 'running') return status
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    return status
  }

  const started = await call(handler, '/codex-review/review-start', {
    repo: 'Acefake/yingbox',
    number: 129,
    options: { depth: 'fast', severityThreshold: 'P1', includeGuidelines: true },
  })
  assert.equal(started.body.ok, true)
  assert.deepEqual(started.body.value.options, {
    depth: 'fast',
    severityThreshold: 'P1',
    includeGuidelines: true,
    chunkChars: 16000,
    maxChunks: 6,
    concurrency: 4,
  })
  const jobId = started.body.value.jobId
  const status = await waitFor(jobId)
  assert.equal(status.state, 'done')
  assert.equal(status.partial, false)
  assert.deepEqual(status.options, started.body.value.options)
  assert.deepEqual(status.guidelines, { loaded: true, files: ['AGENTS.md'], chars: 18 })
  assert.equal(status.reusedFiles, 0)
  assert.equal(status.verdict, 'changes')
  assert.equal(status.findings.length, 1)
  assert.equal(status.findings[0].evidence, '+b')
  assert.equal(status.findings[0].confidence, 'high')
  assert.ok(requests[0].messages[0].content[0].text.includes('## 仓库审查指引'))

  // Same head + same options reuses the finished job; another depth does not.
  const cached = await call(handler, '/codex-review/review-start', {
    repo: 'Acefake/yingbox',
    number: 129,
    options: { depth: 'fast', severityThreshold: 'P1', includeGuidelines: true },
  })
  assert.equal(cached.body.value.cached, true)
  assert.equal(cached.body.value.jobId, jobId)
  const other = await call(handler, '/codex-review/review-start', {
    repo: 'Acefake/yingbox',
    number: 129,
    options: { depth: 'standard' },
  })
  assert.equal(other.body.value.cached, false)
  assert.notEqual(other.body.value.jobId, jobId)
  const otherStatus = await waitFor(other.body.value.jobId)
  assert.equal(otherStatus.state, 'done')
  // Every file is reused from the file-level cache: no extra model call.
  assert.equal(requests.length, 1)
  assert.equal(otherStatus.reusedFiles, 1)
  assert.equal(otherStatus.verdict, 'changes')

  // PrDetail.review exposes the new snapshot fields for the latest variant.
  const detail = await call(handler, '/codex-review/pr', { repo: 'Acefake/yingbox', number: 129 })
  assert.equal(detail.body.value.review.state, 'done')
  assert.deepEqual(detail.body.value.review.options, other.body.value.options)
  assert.equal(detail.body.value.review.reusedFiles, 1)
  assert.equal(detail.body.value.review.verdict, 'changes')
  for (const dispose of disposers) dispose()
})

// ---------------------------------------------------------------------------
// v2 merge route (CONTRACT §5.1)
// ---------------------------------------------------------------------------

/** A complete valid merge request body. */
const MERGE_BODY = {
  repo: 'Acefake/yingbox',
  number: 129,
  method: 'squash',
  expectedHeadSha: 'f31cec5c712d88c5f26bb0e6fcbf2e09e3954585',
  confirm: true,
}

test('merge route forwards the validated request and answers the merge result', async () => {
  const { handler, doubles } = mount()
  const answer = await call(handler, '/codex-review/merge', {
    ...MERGE_BODY,
    commitTitle: '  自定义标题  ',
    commitMessage: '说明',
    deleteBranch: true,
  })
  assert.deepEqual(answer.body, {
    ok: true,
    value: { merged: true, sha: 'merge-sha-001', message: 'Pull Request successfully merged' },
  })
  assert.equal(doubles.mergeCalls.length, 1)
  assert.deepEqual(doubles.mergeCalls[0], {
    repo: 'Acefake/yingbox',
    number: 129,
    method: 'squash',
    expectedHeadSha: 'f31cec5c712d88c5f26bb0e6fcbf2e09e3954585',
    commitTitle: '自定义标题',
    commitMessage: '说明',
    deleteBranch: true,
    confirm: true,
  })
  // A merged head must drop its review jobs too (guard 7).
  assert.deepEqual(doubles.invalidated, [{ repo: 'Acefake/yingbox', number: 129 }])
})

test('merge route validates confirmation, method, head SHA and field limits', async () => {
  const { handler, doubles } = mount()
  /** @type {Array<[string, Record<string, unknown>]>} */
  const invalid = [
    ['confirm missing', { ...MERGE_BODY, confirm: undefined }],
    ['confirm false', { ...MERGE_BODY, confirm: false }],
    ['method missing', { ...MERGE_BODY, method: undefined }],
    ['method unknown', { ...MERGE_BODY, method: 'fast' }],
    ['head sha missing', { ...MERGE_BODY, expectedHeadSha: '' }],
    ['commitTitle too long', { ...MERGE_BODY, commitTitle: 'x'.repeat(257) }],
    ['commitMessage too long', { ...MERGE_BODY, commitMessage: 'x'.repeat(2001) }],
    ['deleteBranch not boolean', { ...MERGE_BODY, deleteBranch: 'yes' }],
    ['bad repo', { ...MERGE_BODY, repo: 'nope' }],
    ['bad number', { ...MERGE_BODY, number: 0 }],
  ]
  for (const [label, payload] of invalid) {
    const answer = await call(handler, '/codex-review/merge', payload)
    assert.equal(answer.body.ok, false, label)
    assert.equal(answer.body.error.code, 'BAD_REQUEST', label)
  }
  assert.equal(doubles.mergeCalls.length, 0)
})

test('merge route passes the guard error codes through unchanged', async () => {
  const { ctx, routes } = createFakeContext()
  const doubles = createDoubles()
  doubles.github.mergePull = async () => {
    throw new AppError('MERGE_HEAD_MOVED', 'PR 已有新提交（当前 head f31cec5c712d），请刷新后重试')
  }
  applyWithDeps(ctx, { requestTimeoutMs: 5000 }, { github: doubles.github, engine: doubles.engine, reviewer: doubles.reviewer })
  const handler = routes.get('/codex-review').handler
  const answer = await call(handler, '/codex-review/merge', MERGE_BODY)
  assert.equal(answer.body.ok, false)
  assert.equal(answer.body.error.code, 'MERGE_HEAD_MOVED')
  assert.ok(answer.body.error.message.includes('f31cec5c712d'))
  assert.equal(doubles.invalidated.length, 0)
})

// ---------------------------------------------------------------------------
// v2 chat exact route (CONTRACT §5.2)
// ---------------------------------------------------------------------------

/**
 * Build an event-capable SSE response stub.
 * @returns {any} response stub.
 */
function makeSseResponse() {
  /** @type {Map<string, Function[]>} */
  const listeners = new Map()
  return {
    statusCode: 0,
    headers: {},
    body: '',
    headersSent: false,
    ended: false,
    writeHead(status, headers) {
      this.statusCode = status
      this.headers = headers
      this.headersSent = true
    },
    write(chunk) {
      this.body += String(chunk)
      return true
    },
    end(chunk) {
      if (chunk !== undefined) this.body += String(chunk)
      this.ended = true
    },
    on(event, handler) {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
    },
    removeListener(event, handler) {
      listeners.set(event, (listeners.get(event) ?? []).filter((entry) => entry !== handler))
    },
    emit(event, ...args) {
      for (const handler of [...(listeners.get(event) ?? [])]) handler(...args)
    },
    destroy() {},
  }
}

/**
 * Mount the plugin with a fake LLM seam so the chat route can stream.
 * @param {{ limiter?: any, answer?: { deltas?: string[], finish?: Record<string, unknown> } }} [options] - wiring overrides.
 * @returns {{ chatHandler: any, prefixHandler: any, requests: any[], doubles: ReturnType<typeof createDoubles>, disposers: Function[] }} harness.
 */
function mountChat(options = {}) {
  const { ctx, routes, disposers } = createFakeContext()
  const requests = []
  const deltas = options.answer?.deltas ?? ['这个 PR ', '增加了片头检测。']
  const finish = options.answer?.finish ?? { kind: 'stop' }
  ctx.inject = (deps, callback) => {
    callback({
      llm: {
        stream(request) {
          requests.push(request)
          return (async function* generate() {
            for (const delta of deltas) yield { type: 'text-delta', index: 0, text: delta }
            yield { type: 'finish', reason: finish }
          })()
        },
      },
      agentDefaultModel: {
        currentSelection() {
          return { provider: 'opencode-go', model: 'deepseek-v4.1-flash' }
        },
      },
      effect(callback) {
        callback()
      },
    })
    return { dispose() {} }
  }
  const doubles = createDoubles()
  const deps = { github: doubles.github, engine: doubles.engine, reviewer: doubles.reviewer }
  if (options.limiter !== undefined) deps.chatLimiter = options.limiter
  applyWithDeps(ctx, { requestTimeoutMs: 5000 }, deps)
  return {
    chatHandler: routes.get('/codex-review/chat').handler,
    prefixHandler: routes.get('/codex-review').handler,
    requests,
    doubles,
    disposers,
  }
}

/**
 * POST one JSON body to the SSE chat handler.
 * @param {any} handler - exact route handler.
 * @param {unknown} body - JSON body.
 * @returns {Promise<any>} response stub.
 */
async function callChat(handler, body) {
  const request = Readable.from([Buffer.from(JSON.stringify(body))])
  request.url = '/codex-review/chat'
  request.method = 'POST'
  request.headers = { host: '127.0.0.1:2632', 'content-type': 'application/json' }
  request.socket = { remoteAddress: '127.0.0.1' }
  const response = makeSseResponse()
  await handler(request, response)
  return response
}

/**
 * Decode an SSE body into parsed frames.
 * @param {string} body - raw SSE text.
 * @returns {any[]} frames.
 */
function parseSseFrames(body) {
  return body.split('\n\n').filter((part) => part.startsWith('data: ')).map((part) => JSON.parse(part.slice('data: '.length)))
}

test('chat route streams SSE frames through the prepared-call seam', async () => {
  const { chatHandler, requests, disposers } = mountChat()
  const response = await callChat(chatHandler, {
    repo: 'Acefake/yingbox',
    number: 129,
    messages: [{ role: 'user', content: '这个 PR 改了什么？' }],
    focusFile: 'src/a.ts',
  })
  assert.equal(response.statusCode, 200)
  assert.equal(response.headers['content-type'], 'text/event-stream; charset=utf-8')
  assert.equal(response.headers['cache-control'], 'no-store')
  assert.equal(response.ended, true)
  const frames = parseSseFrames(response.body)
  assert.deepEqual(frames.slice(0, 2), [{ delta: '这个 PR ' }, { delta: '增加了片头检测。' }])
  assert.equal(frames[2].done, true)
  assert.deepEqual(frames[2].model, { provider: 'opencode-go', model: 'deepseek-v4.1-flash' })
  assert.equal(requests.length, 1)
  const request = requests[0]
  assert.equal(request.sessionId, 'chat-Acefake/yingbox#129')
  assert.equal(request.provider, 'opencode-go')
  assert.equal(request.model, 'deepseek-v4.1-flash')
  assert.ok(request.messages[request.messages.length - 1].content[0].text.includes('这个 PR 改了什么'))
  for (const dispose of disposers) dispose()
})

test('chat route answers validation errors and BUSY as SSE error frames', async () => {
  const { chatHandler, requests, disposers } = mountChat()
  const invalid = await callChat(chatHandler, { repo: 'Acefake/yingbox', number: 129, messages: [] })
  assert.equal(parseSseFrames(invalid.body)[0].error.code, 'BAD_REQUEST')
  assert.equal(requests.length, 0)

  const limiter = createChatLimiter(1)
  const busyController = new AbortController()
  limiter.tryAcquire(busyController)
  const busyMount = mountChat({ limiter })
  const busy = await callChat(busyMount.chatHandler, {
    repo: 'Acefake/yingbox',
    number: 129,
    messages: [{ role: 'user', content: 'q' }],
  })
  assert.equal(parseSseFrames(busy.body)[0].error.code, 'BUSY')
  assert.equal(busyMount.requests.length, 0)
  limiter.release(busyController)
  for (const dispose of [...disposers, ...busyMount.disposers]) dispose()
})

// ---------------------------------------------------------------------------
// v2.1 auto-review routes (CONTRACT §6.3)
// ---------------------------------------------------------------------------

test('auto-review-status returns the reviewer status', async () => {
  const { handler, doubles } = mount()
  const answer = await call(handler, '/codex-review/auto-review-status')
  assert.equal(answer.body.ok, true)
  assert.equal(doubles.reviewer.statusCalls, 1)
  assert.equal(answer.body.value.config.enabled, false)
  assert.equal(answer.body.value.running, false)
  assert.deepEqual(answer.body.value.recent, [])
})

test('auto-review-config persists a patch and validates its shape', async () => {
  const { handler, doubles } = mount()
  const answer = await call(handler, '/codex-review/auto-review-config', {
    patch: { enabled: true, intervalSeconds: 600, unknownKey: 1 },
  })
  assert.equal(answer.body.ok, true)
  assert.equal(answer.body.value.config.enabled, true)
  assert.equal(answer.body.value.config.intervalSeconds, 600)
  assert.deepEqual(doubles.reviewer.configPatches, [{ enabled: true, intervalSeconds: 600, unknownKey: 1 }])

  const invalid = await call(handler, '/codex-review/auto-review-config', { patch: [] })
  assert.equal(invalid.body.ok, false)
  assert.equal(invalid.body.error.code, 'BAD_REQUEST')
  // Missing patch returns the current status without touching the config.
  const current = await call(handler, '/codex-review/auto-review-config', {})
  assert.equal(current.body.ok, true)
  assert.equal(doubles.reviewer.configPatches.length, 1)
})

test('auto-review-run forwards the force flag and answers the start result', async () => {
  const { handler, doubles } = mount()
  const forced = await call(handler, '/codex-review/auto-review-run', { force: true })
  assert.deepEqual(forced.body, { ok: true, value: { started: true } })
  const refused = await call(handler, '/codex-review/auto-review-run', { force: false })
  assert.equal(refused.body.value.started, false)
  assert.equal(typeof refused.body.value.reason, 'string')
  const nonBoolean = await call(handler, '/codex-review/auto-review-run', { force: 'yes' })
  assert.equal(nonBoolean.body.value.started, false)
  assert.deepEqual(doubles.reviewer.runOptions, [{ force: true }, { force: false }, { force: false }])
})

// ---------------------------------------------------------------------------
// v2.2 review-publish route (CONTRACT §7.2)
// ---------------------------------------------------------------------------

test('review-publish requires confirm and forwards the normalized options', async () => {
  const { handler, doubles } = mount()
  const refused = await call(handler, '/codex-review/review-publish', { repo: 'Acefake/yingbox', number: 129, mode: 'inline' })
  assert.equal(refused.body.ok, false)
  assert.equal(refused.body.error.code, 'BAD_REQUEST')
  assert.equal(doubles.publisher.calls.length, 0)

  const answer = await call(handler, '/codex-review/review-publish', {
    repo: 'Acefake/yingbox',
    number: 129,
    confirm: true,
    mode: 'summary',
    minSeverity: 'P1',
    body: '  自定义摘要  ',
  })
  assert.equal(answer.body.ok, true)
  assert.equal(answer.body.value.published, true)
  assert.equal(answer.body.value.reviewId, 77)
  const forwarded = doubles.publisher.calls[0]
  assert.ok(forwarded.signal !== undefined, 'the publish carries the route abort signal')
  const { signal, ...options } = forwarded
  assert.deepEqual(options, {
    repo: 'Acefake/yingbox',
    number: 129,
    confirm: true,
    mode: 'summary',
    minSeverity: 'P1',
    maxComments: PUBLISH_DEFAULTS.maxComments,
    body: '自定义摘要',
  })
})

test('review-publish forwards the review job and head the client published from', async () => {
  const { handler, doubles } = mount()
  const before = doubles.publisher.calls.length
  await call(handler, '/codex-review/review-publish', {
    repo: 'Acefake/yingbox',
    number: 129,
    confirm: true,
    jobId: ' job-7 ',
    headSha: ' abc123 ',
  })
  const request = doubles.publisher.calls[before]
  assert.equal(request.jobId, 'job-7')
  assert.equal(request.headSha, 'abc123')
})

test('review-publish falls back to the persisted publish config for omitted options', async () => {
  const { handler, doubles } = mount()
  const before = doubles.publisher.calls.length
  const answer = await call(handler, '/codex-review/review-publish', { repo: 'Acefake/yingbox', number: 129, confirm: true })
  assert.equal(answer.body.ok, true)
  const request = doubles.publisher.calls[before]
  assert.equal(request.mode, PUBLISH_DEFAULTS.mode)
  assert.equal(request.minSeverity, PUBLISH_DEFAULTS.minSeverity)
  assert.equal(request.maxComments, PUBLISH_DEFAULTS.maxComments)
  assert.equal(request.body, undefined)
})

test('review-publish validates mode, minSeverity and the body cap', async () => {
  const { handler, doubles } = mount()
  const base = { repo: 'Acefake/yingbox', number: 129, confirm: true }
  const invalidMode = await call(handler, '/codex-review/review-publish', { ...base, mode: 'nope' })
  assert.equal(invalidMode.body.error.code, 'BAD_REQUEST')
  const invalidSeverity = await call(handler, '/codex-review/review-publish', { ...base, minSeverity: 'P9' })
  assert.equal(invalidSeverity.body.error.code, 'BAD_REQUEST')
  const longBody = await call(handler, '/codex-review/review-publish', { ...base, body: 'x'.repeat(4001) })
  assert.equal(longBody.body.error.code, 'BAD_REQUEST')
  const badRepo = await call(handler, '/codex-review/review-publish', { ...base, repo: 'nope' })
  assert.equal(badRepo.body.error.code, 'BAD_REQUEST')
  assert.equal(doubles.publisher.calls.length, 0)
})

test('review-publish passes REVIEW_NOT_READY through the envelope', async () => {
  const { ctx, routes } = createFakeContext()
  const doubles = createDoubles()
  doubles.publisher.publish = async () => {
    throw new AppError('REVIEW_NOT_READY')
  }
  applyWithDeps(ctx, { requestTimeoutMs: 5000 }, {
    github: doubles.github,
    engine: doubles.engine,
    reviewer: doubles.reviewer,
    publisher: doubles.publisher,
  })
  const handler = routes.get('/codex-review').handler
  const answer = await call(handler, '/codex-review/review-publish', { repo: 'Acefake/yingbox', number: 129, confirm: true })
  assert.equal(answer.body.ok, false)
  assert.equal(answer.body.error.code, 'REVIEW_NOT_READY')
})

test('the prefix route does not answer the chat path', async () => {
  const { prefixHandler, disposers } = mountChat()
  const request = makeRequest('/codex-review/chat', { repo: 'a/b', number: 1, messages: [{ role: 'user', content: 'q' }] })
  const response = makeResponse()
  await prefixHandler(request, response)
  assert.equal(response.statusCode, 404)
  for (const dispose of disposers) dispose()
})

test('comment routes require confirm and forward the write only with valid ids', async () => {
  const { handler, doubles } = mount()
  const base = { repo: 'Acefake/yingbox', number: 129 }

  // `confirm` is the write gate: missing or false never reaches the data layer.
  for (const payload of [base, { ...base, confirm: false }]) {
    const refused = await call(handler, '/codex-review/comment', { ...payload, body: 'hello' })
    assert.equal(refused.body.ok, false)
    assert.equal(refused.body.error.code, 'BAD_REQUEST')
  }
  assert.equal(doubles.commentWrites.length, 0)

  const created = await call(handler, '/codex-review/comment', { ...base, body: 'hello', confirm: true })
  assert.equal(created.body.ok, true)
  assert.equal(created.body.value.id, 5)
  assert.deepEqual(doubles.commentWrites[0], { kind: 'comment', input: { repo: 'Acefake/yingbox', number: 129, body: 'hello' } })

  const missingConfirm = await call(handler, '/codex-review/reply', { ...base, commentId: 9, body: 'thanks' })
  assert.equal(missingConfirm.body.error.code, 'BAD_REQUEST')
  const badCommentId = await call(handler, '/codex-review/reply', { ...base, commentId: 0, body: 'x', confirm: true })
  assert.equal(badCommentId.body.error.code, 'BAD_REQUEST')
  assert.equal(doubles.commentWrites.length, 1)

  const replied = await call(handler, '/codex-review/reply', { ...base, commentId: 9, body: 'thanks', confirm: true })
  assert.equal(replied.body.ok, true)
  assert.deepEqual(doubles.commentWrites[1], { kind: 'reply', input: { repo: 'Acefake/yingbox', number: 129, commentId: 9, body: 'thanks' } })

  const badThread = await call(handler, '/codex-review/resolve', { ...base, threadId: '', confirm: true })
  assert.equal(badThread.body.error.code, 'BAD_REQUEST')
  const resolved = await call(handler, '/codex-review/resolve', { ...base, threadId: 'THREAD_1', confirm: true })
  assert.equal(resolved.body.ok, true)
  assert.deepEqual(resolved.body.value, { resolved: true })
  assert.deepEqual(doubles.commentWrites[2], { kind: 'resolve', input: { repo: 'Acefake/yingbox', number: 129, threadId: 'THREAD_1' } })
})

test('manual reviews use the shared host settings when the UI supplies no options', async () => {
  const { handler, doubles } = mount({ llmAvailable: true })
  const saved = await call(handler, '/codex-review/auto-review-config', {
    patch: { depth: 'deep', severityThreshold: 'P0', includeGuidelines: false },
  })
  assert.equal(saved.body.ok, true)
  doubles.reviewer.status = () => saved.body.value
  await call(handler, '/codex-review/review-start', { repo: 'Acefake/yingbox', number: 129 })
  assert.equal(doubles.started[0].options.depth, 'deep')
  assert.equal(doubles.started[0].options.severityThreshold, 'P0')
  assert.equal(doubles.started[0].options.includeGuidelines, false)
  assert.deepEqual(doubles.guidelineCalls, [])
})
