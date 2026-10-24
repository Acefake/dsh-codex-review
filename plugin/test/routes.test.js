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
 * Build the fake GitHub client + fake review engine pair.
 * @returns {{ github: any, engine: any, started: any[], guidelineCalls: string[], mergeCalls: any[], invalidated: any[] }} doubles.
 */
function createDoubles() {
  const started = []
  const guidelineCalls = []
  const mergeCalls = []
  const invalidated = []
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
  return { github, engine, started, guidelineCalls, mergeCalls, invalidated }
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
  applyWithDeps(ctx, { requestTimeoutMs: 5000 }, { github: doubles.github, engine: doubles.engine })
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
  assert.equal(disposers.length, 4)
})

test('health reports gh, llm and version', async () => {
  const { handler } = mount()
  const answer = await call(handler, '/codex-review/health')
  assert.equal(answer.status, 200)
  assert.deepEqual(answer.body, { ok: true, value: { gh: 'ok', llm: 'unavailable', version: VERSION } })
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

test('review-start forwards the PR snapshot to the engine and answers the job reference', async () => {
  const { handler, doubles } = mount({ llmAvailable: true })
  const answer = await call(handler, '/codex-review/review-start', { repo: 'Acefake/yingbox', number: 129 })
  assert.deepEqual(answer.body, {
    ok: true,
    value: {
      jobId: 'job-1',
      headSha: 'abc123',
      cached: false,
      options: { depth: 'standard', severityThreshold: 'P2', includeGuidelines: true, chunkChars: 9000, maxChunks: 9, concurrency: 3 },
    },
  })
  assert.equal(doubles.started.length, 1)
  assert.equal(doubles.started[0].repo, 'Acefake/yingbox')
  assert.equal(doubles.started[0].number, 129)
  assert.equal(doubles.started[0].headSha, 'abc123')
  assert.equal(doubles.started[0].files.length, 1)
  assert.deepEqual(doubles.started[0].options, { depth: 'standard', severityThreshold: 'P2', includeGuidelines: true, chunkChars: 9000, maxChunks: 9, concurrency: 3 })
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
  applyWithDeps(ctx, { requestTimeoutMs: 5000 }, { github: doubles.github, engine: doubles.engine })
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
  applyWithDeps(ctx, {}, { github })
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
  applyWithDeps(ctx, { requestTimeoutMs: 5000, reviewChunkChars: 1000 }, { github })
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
  assert.deepEqual(health.body.value, { gh: 'ok', llm: 'ok', version: VERSION })
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
  applyWithDeps(ctx, { requestTimeoutMs: 5000, reviewChunkChars: 1000 }, { github })
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
  applyWithDeps(ctx, { requestTimeoutMs: 5000 }, { github: doubles.github, engine: doubles.engine })
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
  const deps = { github: doubles.github, engine: doubles.engine }
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

test('the prefix route does not answer the chat path', async () => {
  const { prefixHandler, disposers } = mountChat()
  const request = makeRequest('/codex-review/chat', { repo: 'a/b', number: 1, messages: [{ role: 'user', content: 'q' }] })
  const response = makeResponse()
  await prefixHandler(request, response)
  assert.equal(response.statusCode, 404)
  for (const dispose of disposers) dispose()
})
