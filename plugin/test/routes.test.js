/**
 * Route-level tests: mount the plugin against a fake Cordis context (no host
 * process) and call the registered prefix handler with mock req/res objects.
 * This is the "works outside DSH" acceptance smoke from CONTRACT §1.6.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { applyWithDeps } from '../index.js'

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
 * @returns {{ github: any, engine: any, started: any[], guidelineCalls: string[] }} doubles.
 */
function createDoubles() {
  const started = []
  const guidelineCalls = []
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
    dispose() {
      disposed = true
    },
    isDisposed() {
      return disposed
    },
  }
  return { github, engine, started, guidelineCalls }
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

test('mount registers the prefix route and the engine disposer', () => {
  const { routes, disposers } = mount()
  assert.deepEqual([...routes.keys()], ['/codex-review'])
  assert.equal(disposers.length, 2)
})

test('health reports gh, llm and version', async () => {
  const { handler } = mount()
  const answer = await call(handler, '/codex-review/health')
  assert.equal(answer.status, 200)
  assert.deepEqual(answer.body, { ok: true, value: { gh: 'ok', llm: 'unavailable', version: '0.1.0' } })
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
  assert.deepEqual(health.body.value, { gh: 'ok', llm: 'ok', version: '0.1.0' })
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
