/**
 * Unit tests for the PR-chat feature (CONTRACT §5.2): request validation,
 * bounded context assembly, SSE frame encoding, concurrency limiting, the
 * streaming model flow and the exact SSE HTTP handler.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import {
  CHAT_CONTEXT_BUDGET_CHARS,
  CHAT_FOCUS_PATCH_MAX_CHARS,
  CHAT_HISTORY_MAX_MESSAGES,
  CHAT_PR_BODY_MAX_CHARS,
  CHAT_SYSTEM_PROMPT,
  buildChatContext,
  createChatLimiter,
  encodeSseDelta,
  encodeSseDone,
  encodeSseError,
  encodeSseFrame,
  formatFocusFile,
  formatPullBody,
  formatPullMeta,
  formatReviewSummary,
  mapChatFailure,
  selectChatHistory,
  toModelMessages,
  truncateChars,
  validateChatRequest,
} from '../lib/chat.js'
import { createChatRouteHandler } from '../lib/http.js'
import { createChatStreamHandler } from '../index.js'

/** Normalized PR detail fixture. */
const DETAIL = {
  headSha: 'abc123',
  summary: {
    repo: 'Acefake/yingbox',
    number: 129,
    title: 'feat(player): 自动检测片头片尾',
    author: 'Acefake',
    state: 'open',
    isDraft: false,
    headRefName: 'feat/intro-detect',
    baseRefName: 'feat/skip-intro',
    additions: 2117,
    deletions: 25,
    changedFiles: 2,
  },
  body: '这个 PR 增加了片头片尾自动检测。',
  files: [
    { path: 'src/a.ts', patch: '@@ -1,2 +1,3 @@\n context\n+added', status: 'added', additions: 1, deletions: 0 },
    { path: 'src/b.ts', patch: '', status: 'modified', additions: 0, deletions: 0 },
  ],
}

/** Completed review snapshot fixture. */
const REVIEW = {
  state: 'done',
  overview: '共 2 个问题：P1 ×1 · P2 ×1',
  findings: [
    { severity: 'P1', file: 'src/a.ts', line: 2, title: '空指针' },
    { severity: 'P2', file: 'src/a.ts', line: 5, title: '边界值' },
  ],
}

/**
 * One valid chat message.
 * @param {'user' | 'assistant'} role - message role.
 * @param {string} content - message text.
 * @returns {{ role: string, content: string }} message.
 */
function message(role, content) {
  return { role, content }
}

test('truncateChars and the context block renderers stay inside their budgets', () => {
  assert.equal(truncateChars('abcdef', 10), 'abcdef')
  // The result never exceeds the cap, even when the marker alone would.
  assert.equal(truncateChars('abcdef', 5).length, 5)
  assert.ok(truncateChars('x'.repeat(100), 20).includes('已截断'))
  assert.equal(truncateChars(undefined, 5), '')
  assert.equal(truncateChars('abcdef', 0), '')

  const meta = formatPullMeta(DETAIL)
  assert.ok(meta.includes('Acefake/yingbox'))
  assert.ok(meta.includes('#129'))
  assert.ok(meta.includes('feat/intro-detect → feat/skip-intro'))
  assert.ok(meta.includes('`src/a.ts` [added] +1 −0'))

  assert.equal(formatPullBody(''), '')
  assert.equal(formatPullBody(undefined), '')
  const longBody = formatPullBody('x'.repeat(CHAT_PR_BODY_MAX_CHARS + 500))
  assert.ok(longBody.length <= CHAT_PR_BODY_MAX_CHARS + 20)
  assert.ok(longBody.includes('已截断'))

  const review = formatReviewSummary(REVIEW)
  assert.ok(review.includes('共 2 个问题'))
  assert.ok(review.includes('P1 src/a.ts:2 空指针'))
  assert.equal(formatReviewSummary({ state: 'running', findings: [] }), '')

  const focus = formatFocusFile(DETAIL, 'src/a.ts')
  assert.ok(focus.includes('## 当前展开文件：src/a.ts'))
  assert.ok(focus.includes('+added'))
  assert.ok(formatFocusFile(DETAIL, 'src/missing.ts').includes('没有这个文件'))
  assert.ok(formatFocusFile(DETAIL, 'src/b.ts').includes('没有可用的 diff'))
  assert.equal(formatFocusFile(DETAIL, undefined), '')
})

test('selectChatHistory keeps the newest messages and honours both caps', () => {
  const many = Array.from({ length: 15 }, (_, index) => message(index % 2 === 0 ? 'user' : 'assistant', `消息 ${index}`))
  const history = selectChatHistory(many, { maxChars: 10_000 })
  assert.equal(history.length, CHAT_HISTORY_MAX_MESSAGES)
  assert.equal(history[history.length - 1].content, '消息 14')

  const huge = [
    message('user', 'a'.repeat(4000)),
    message('assistant', 'b'.repeat(4000)),
    message('user', 'c'.repeat(4000)),
  ]
  const trimmed = selectChatHistory(huge, { maxChars: 5000 })
  assert.ok(trimmed.length >= 1)
  const total = trimmed.reduce((sum, item) => sum + item.content.length, 0)
  assert.ok(total <= 5000)
  assert.equal(trimmed[trimmed.length - 1].content.startsWith('c'), true)

  const perMessage = selectChatHistory([message('user', 'x'.repeat(9000))], { maxChars: 10_000, messageMaxChars: 4000 })
  assert.equal(perMessage[0].content.length, 4000)
})

test('buildChatContext injects PR meta, body, review summary and focus patch within 24000 chars', () => {
  const context = buildChatContext({
    detail: DETAIL,
    review: REVIEW,
    focusFile: 'src/a.ts',
    messages: [message('user', '这个 PR 改了什么？')],
  })
  assert.ok(context.system.startsWith(CHAT_SYSTEM_PROMPT))
  assert.ok(context.system.includes('Acefake/yingbox#129') || context.system.includes('#129'))
  assert.ok(context.system.includes('这个 PR 增加了片头片尾自动检测'))
  assert.ok(context.system.includes('## 最近一次 AI 审查'))
  assert.ok(context.system.includes('空指针'))
  assert.ok(context.system.includes('## 当前展开文件：src/a.ts'))
  assert.deepEqual(context.messages, [message('user', '这个 PR 改了什么？')])
  assert.equal(context.stats.systemChars, context.system.length)
  assert.equal(context.stats.totalChars, context.system.length + context.stats.historyChars)
  assert.ok(context.stats.totalChars <= CHAT_CONTEXT_BUDGET_CHARS)

  // No completed review → no review section.
  const noReview = buildChatContext({ detail: DETAIL, review: { state: 'running', findings: [] }, messages: [message('user', 'q')] })
  assert.equal(noReview.system.includes('## 最近一次 AI 审查'), false)

  // A pathological request still respects the hard budget.
  const longMessages = Array.from({ length: 20 }, (_, index) => message(index % 2 === 0 ? 'assistant' : 'user', 'm'.repeat(4000)))
  const bounded = buildChatContext({ detail: DETAIL, review: REVIEW, messages: longMessages })
  assert.ok(bounded.stats.totalChars <= CHAT_CONTEXT_BUDGET_CHARS)
  assert.ok(bounded.system.length <= CHAT_CONTEXT_BUDGET_CHARS)
  assert.ok(bounded.messages.length >= 1)
  assert.equal(bounded.messages[bounded.messages.length - 1].role, 'user')
})

test('formatFocusFile truncates a huge patch to its own budget', () => {
  const huge = { ...DETAIL, files: [{ path: 'big.ts', patch: 'p'.repeat(CHAT_FOCUS_PATCH_MAX_CHARS + 2000), status: 'modified', additions: 1, deletions: 1 }] }
  const block = formatFocusFile(huge, 'big.ts')
  assert.ok(block.length <= CHAT_FOCUS_PATCH_MAX_CHARS + 40)
  assert.ok(block.includes('已截断'))
})

test('validateChatRequest accepts a valid request and rejects every contract violation', () => {
  const valid = validateChatRequest({
    repo: 'Acefake/yingbox',
    number: 129,
    messages: [message('user', '这个 PR 改了什么？')],
    focusFile: '  src/a.ts  ',
  })
  assert.deepEqual(valid, {
    repo: 'Acefake/yingbox',
    number: 129,
    messages: [message('user', '这个 PR 改了什么？')],
    focusFile: 'src/a.ts',
  })
  assert.equal(validateChatRequest({ repo: 'a/b', number: '12', messages: [message('user', 'q')] }).number, 12)
  assert.equal(
    validateChatRequest({ account: 'gitlab', repo: 'a/b', number: 1, messages: [message('user', 'q')] }).account,
    'gitlab',
  )

  /** @type {Array<[string, Record<string, unknown>]>} */
  const invalid = [
    ['bad repo', { repo: 'bad path/repo', number: 1, messages: [message('user', 'q')] }],
    ['repo dot segment', { repo: 'a/../b', number: 1, messages: [message('user', 'q')] }],
    ['repo bare dot', { repo: 'a/.', number: 1, messages: [message('user', 'q')] }],
    ['repo bare dotdot', { repo: 'a/..', number: 1, messages: [message('user', 'q')] }],
    ['repo bare dash', { repo: 'a/-', number: 1, messages: [message('user', 'q')] }],
    ['repo dash segment', { repo: 'a/-b', number: 1, messages: [message('user', 'q')] }],
    ['repo too many segments', { repo: Array.from({ length: 21 }, () => 'a').join('/'), number: 1, messages: [message('user', 'q')] }],
    ['bad number', { repo: 'a/b', number: 0, messages: [message('user', 'q')] }],
    ['messages missing', { repo: 'a/b', number: 1 }],
    ['messages empty', { repo: 'a/b', number: 1, messages: [] }],
    ['messages too many', { repo: 'a/b', number: 1, messages: Array.from({ length: 21 }, () => message('user', 'q')) }],
    ['message not object', { repo: 'a/b', number: 1, messages: ['hi'] }],
    ['bad role', { repo: 'a/b', number: 1, messages: [message('system', 'q')] }],
    ['empty content', { repo: 'a/b', number: 1, messages: [message('user', '   ')] }],
    ['content too long', { repo: 'a/b', number: 1, messages: [message('user', 'x'.repeat(4001))] }],
    ['last message assistant', { repo: 'a/b', number: 1, messages: [message('user', 'q'), message('assistant', 'a')] }],
    ['focusFile not string', { repo: 'a/b', number: 1, messages: [message('user', 'q')], focusFile: 3 }],
    ['focusFile too long', { repo: 'a/b', number: 1, messages: [message('user', 'q')], focusFile: 'x'.repeat(513) }],
  ]
  for (const [label, payload] of invalid) {
    assert.throws(() => validateChatRequest(payload), (error) => {
      assert.equal(error.code, 'BAD_REQUEST', `${label} should be BAD_REQUEST`)
      return true
    }, label)
  }
  const twenty = Array.from({ length: 20 }, () => 'a').join('/')
  assert.equal(validateChatRequest({ repo: twenty, number: 1, messages: [message('user', 'q')] }).repo, twenty)
  assert.equal(validateChatRequest({ repo: 'a/b-c', number: 1, messages: [message('user', 'q')] }).repo, 'a/b-c')
})

test('SSE encoders emit the exact frame shapes of CONTRACT §5.2', () => {
  assert.equal(encodeSseFrame({ a: 1 }), 'data: {"a":1}\n\n')
  assert.equal(encodeSseDelta('你好'), 'data: {"delta":"你好"}\n\n')
  const done = encodeSseDone({ model: { provider: 'p', model: 'm' }, usage: { inputTokens: 3 } })
  assert.ok(done.startsWith('data: {"done":true'))
  assert.deepEqual(JSON.parse(done.slice('data: '.length, -2)), { done: true, model: { provider: 'p', model: 'm' }, usage: { inputTokens: 3 } })
  assert.deepEqual(JSON.parse(encodeSseDone().slice(6, -2)), { done: true })
  const error = encodeSseError({ code: 'BUSY', message: '忙' })
  assert.deepEqual(JSON.parse(error.slice(6, -2)), { error: { code: 'BUSY', message: '忙' } })
  assert.deepEqual(JSON.parse(encodeSseError({}).slice(6, -2)).error.code, 'INTERNAL')
  assert.deepEqual(mapChatFailure(new Error('boom')), { code: 'LLM_ERROR', message: 'AI 审查调用失败，请稍后重试（boom）' })
  assert.deepEqual(mapChatFailure(new Error('x'), { timedOut: true }), { code: 'LLM_ERROR', message: 'AI 回答超时，请重试' })
})

test('createChatLimiter caps concurrency and aborts every live stream on dispose', () => {
  const limiter = createChatLimiter(2)
  const first = new AbortController()
  const second = new AbortController()
  const third = new AbortController()
  assert.equal(limiter.tryAcquire(first), true)
  assert.equal(limiter.tryAcquire(second), true)
  assert.equal(limiter.tryAcquire(third), false)
  assert.equal(limiter.active, 2)
  limiter.release(first)
  assert.equal(limiter.tryAcquire(third), true)
  let aborted = 0
  second.signal.addEventListener('abort', () => { aborted += 1 })
  third.signal.addEventListener('abort', () => { aborted += 1 })
  assert.equal(limiter.abortAll(new Error('dispose')), 2)
  assert.equal(aborted, 2)
  assert.equal(limiter.active, 0)
})

// ---------------------------------------------------------------------------
// Streaming model flow (createChatStreamHandler)
// ---------------------------------------------------------------------------

/**
 * Build the chat wiring with fake PR data and a fake model stream.
 * @param {{ llm?: (request: any) => AsyncIterable<any>, available?: boolean, limiter?: any, config?: any, engine?: any }} [options] - wiring overrides.
 * @returns {{ handle: any, requests: any[], limiter: any, github: any }} chat flow plus captured model requests.
 */
function makeChatFlow(options = {}) {
  const requests = []
  const limiter = options.limiter ?? createChatLimiter(2)
  const llm = options.llm ?? (async function* generate() {
    yield { type: 'text-delta', index: 0, text: '第一段' }
    yield { type: 'text-delta', index: 0, text: '第二段' }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })
  const github = {
    async getPull() {
      return DETAIL
    },
    async chatContext(input) {
      return buildChatContext(input)
    },
  }
  const engine = options.engine ?? {
    existing() {
      return REVIEW
    },
    resolveModel() {
      return { provider: 'opencode-go', model: 'deepseek-v4.1-flash' }
    },
  }
  const handle = createChatStreamHandler({
    github,
    clients: options.clients ?? options.accountRuntime?.clients,
    accountRuntime: options.accountRuntime,
    engine,
    streamLlm: async (request) => {
      requests.push(request)
      return llm(request)
    },
    llmAvailable: () => options.available !== false,
    config: options.config ?? { maxOutputTokens: 0 },
    limiter,
    callTimeoutMs: options.callTimeoutMs ?? 180_000,
  })
  return { handle, requests, limiter, github }
}

/**
 * Build the stream interface the HTTP handler passes to the chat flow.
 * @returns {{ stream: any, frames: string[], controller: AbortController, clientGone: () => boolean }} stream stub.
 */
function makeStream() {
  const frames = []
  const controller = new AbortController()
  const clientGone = () => controller.signal.aborted
  return {
    frames,
    controller,
    clientGone,
    stream: {
      signal: controller.signal,
      clientGone,
      send(frame) {
        frames.push(frame)
      },
      end() {},
    },
  }
}

test('the chat flow validates the repo against the resolved account provider', async () => {
  const gitlab = {
    async getPull() {
      return DETAIL
    },
    async chatContext(input) {
      return buildChatContext(input)
    },
  }
  const accountRuntime = {
    accounts: [{ id: 'github', type: 'github' }, { id: 'gitlab', type: 'gitlab' }],
    clients: { github: { async getPull() { return DETAIL }, async chatContext(input) { return buildChatContext(input) } }, gitlab },
    defaultAccount: 'github',
  }
  const { handle } = makeChatFlow({ accountRuntime })
  const { stream } = makeStream()
  await assert.rejects(
    () => handle({ account: 'github', repo: 'a/b/c', number: 1, messages: [{ role: 'user', content: 'q' }] }, stream),
    (error) => error.code === 'BAD_REQUEST',
  )
  // GitLab nested project paths stay valid on the GitLab account.
  await handle({ account: 'gitlab', repo: 'a/b/c', number: 1, messages: [{ role: 'user', content: 'q' }] }, makeStream().stream)
})

test('the chat flow streams deltas, carries the sessionId and ends with a done frame', async () => {
  const { handle, requests, limiter } = makeChatFlow()
  const { stream, frames } = makeStream()
  await handle({ repo: 'Acefake/yingbox', number: 129, messages: [message('user', '这个 PR 改了什么？')], focusFile: 'src/a.ts' }, stream)
  assert.deepEqual(frames.slice(0, 2), ['data: {"delta":"第一段"}\n\n', 'data: {"delta":"第二段"}\n\n'])
  const done = JSON.parse(frames[2].slice(6, -2))
  assert.deepEqual(done.done, true)
  assert.deepEqual(done.model, { provider: 'opencode-go', model: 'deepseek-v4.1-flash' })
  assert.deepEqual(done.usage, { inputTokens: 10, outputTokens: 5 })
  assert.equal(requests.length, 1)
  const request = requests[0]
  assert.equal(request.sessionId, 'chat-Acefake/yingbox#129')
  assert.equal(request.provider, 'opencode-go')
  assert.equal(request.model, 'deepseek-v4.1-flash')
  assert.ok(request.system.startsWith(CHAT_SYSTEM_PROMPT))
  assert.ok(request.system.includes('#129'))
  assert.deepEqual(request.messages, toModelMessages([message('user', '这个 PR 改了什么？')]))
  assert.equal(request.maxTokens, undefined)
  assert.equal(limiter.active, 0)
})

test('the chat flow reports LLM_UNAVAILABLE, BUSY and provider failures', async () => {
  const unavailable = makeChatFlow({ available: false })
  await assert.rejects(unavailable.handle({ repo: 'a/b', number: 1, messages: [message('user', 'q')] }, makeStream().stream), (error) => error.code === 'LLM_UNAVAILABLE')

  const limiter = createChatLimiter(1)
  const busyController = new AbortController()
  limiter.tryAcquire(busyController)
  const busy = makeChatFlow({ limiter })
  await assert.rejects(busy.handle({ repo: 'a/b', number: 1, messages: [message('user', 'q')] }, makeStream().stream), (error) => error.code === 'BUSY')
  limiter.release(busyController)
  assert.equal(limiter.active, 0)

  const failing = makeChatFlow({
    llm: async function* generate() {
      throw Object.assign(new Error('no adapter'), { code: 'NO_ADAPTER' })
    },
  })
  await assert.rejects(failing.handle({ repo: 'a/b', number: 1, messages: [message('user', 'q')] }, makeStream().stream), (error) => {
    assert.equal(error.code, 'LLM_ERROR')
    assert.ok(error.message.includes('NO_ADAPTER'))
    return true
  })
  assert.equal(failing.limiter.active, 0)

  const finishError = makeChatFlow({
    llm: async function* generate() {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH', message: 'bad key' } } }
    },
  })
  await assert.rejects(finishError.handle({ repo: 'a/b', number: 1, messages: [message('user', 'q')] }, makeStream().stream), (error) => {
    assert.equal(error.code, 'LLM_ERROR')
    assert.ok(error.message.includes('AUTH'))
    return true
  })
})

test('the chat flow aborts the upstream stream when the client disconnects', async () => {
  let upstreamAborted = false
  const flow = makeChatFlow({
    llm: (request) => (async function* generate() {
      yield { type: 'text-delta', index: 0, text: '部分' }
      await new Promise((resolve) => {
        if (request.signal.aborted) return resolve(undefined)
        request.signal.addEventListener('abort', resolve, { once: true })
      })
      upstreamAborted = true
      throw Object.assign(new Error('aborted'), { name: 'AbortError' })
    })(),
  })
  const { stream, frames, controller } = makeStream()
  const running = flow.handle({ repo: 'a/b', number: 1, messages: [message('user', 'q')] }, stream)
  // Wait until the first delta was forwarded, then simulate the client going away.
  for (let attempt = 0; attempt < 100 && frames.length === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(frames.length, 1)
  controller.abort(new Error('client gone'))
  await running
  assert.equal(upstreamAborted, true)
  assert.equal(flow.limiter.active, 0)
  assert.equal(frames.some((frame) => frame.includes('"done":true')), false)
})

test('the chat flow maps the 180s-class per-call timeout to LLM_ERROR', async () => {
  const flow = makeChatFlow({
    callTimeoutMs: 20,
    llm: (request) => (async function* generate() {
      await new Promise((resolve) => {
        if (request.signal.aborted) return resolve(undefined)
        request.signal.addEventListener('abort', resolve, { once: true })
      })
      throw Object.assign(new Error('aborted'), { name: 'AbortError' })
    })(),
  })
  await assert.rejects(flow.handle({ repo: 'a/b', number: 1, messages: [message('user', 'q')] }, makeStream().stream), (error) => {
    assert.equal(error.code, 'LLM_ERROR')
    assert.ok(error.message.includes('超时'))
    return true
  })
  assert.equal(flow.limiter.active, 0)
})

// ---------------------------------------------------------------------------
// Exact SSE HTTP handler (createChatRouteHandler)
// ---------------------------------------------------------------------------

/**
 * Build a POST request stub accepted by the SSE handler.
 * @param {unknown} body - JSON body.
 * @param {Record<string, unknown>} [headers] - header overrides.
 * @returns {any} request stub.
 */
function makeSseRequest(body, headers = {}) {
  const request = Readable.from([Buffer.from(JSON.stringify(body))])
  request.url = '/codex-review/chat'
  request.method = 'POST'
  request.headers = { host: '127.0.0.1:2632', 'content-type': 'application/json', ...headers }
  request.socket = { remoteAddress: '127.0.0.1' }
  return request
}

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
 * Call the chat HTTP handler with a stub request/response pair.
 * @param {any} handler - node handler.
 * @param {unknown} body - request body.
 * @param {Record<string, unknown>} [headers] - header overrides.
 * @returns {Promise<{ response: any, request: any }>} the completed pair.
 */
async function callChat(handler, body, headers = {}) {
  const request = makeSseRequest(body, headers)
  const response = makeSseResponse()
  await handler(request, response)
  return { response, request }
}

/**
 * Decode the SSE body into parsed frames.
 * @param {string} body - raw SSE text.
 * @returns {any[]} parsed JSON frames.
 */
function parseFrames(body) {
  return body.split('\n\n').filter((part) => part.startsWith('data: ')).map((part) => JSON.parse(part.slice('data: '.length)))
}

test('the SSE handler enforces the trust fence, method and content type', async () => {
  const handler = createChatRouteHandler({ handle: async () => {} })
  const denied = await callChat(handler, { repo: 'a/b', number: 1, messages: [message('user', 'q')] }, { 'x-forwarded-for': '203.0.113.9' })
  assert.equal(denied.response.statusCode, 403)
  const wrongMethod = makeSseRequest({})
  wrongMethod.method = 'GET'
  const methodResponse = makeSseResponse()
  await handler(wrongMethod, methodResponse)
  assert.equal(methodResponse.statusCode, 405)
  const wrongType = await callChat(handler, {}, { 'content-type': 'text/plain' })
  assert.equal(wrongType.response.statusCode, 415)
})

test('the SSE handler streams frames, ends the stream and reports handler errors', async () => {
  const handler = createChatRouteHandler({
    handle: async (payload, stream) => {
      assert.equal(payload.repo, 'a/b')
      stream.send(encodeSseDelta('hi'))
      stream.send(encodeSseDone({ model: { provider: 'p', model: 'm' } }))
      stream.end()
    },
  })
  const ok = await callChat(handler, { repo: 'a/b', number: 1, messages: [message('user', 'q')] })
  assert.equal(ok.response.statusCode, 200)
  assert.equal(ok.response.headers['content-type'], 'text/event-stream; charset=utf-8')
  assert.equal(ok.response.ended, true)
  const frames = parseFrames(ok.response.body)
  assert.deepEqual(frames[0], { delta: 'hi' })
  assert.equal(frames[1].done, true)

  const failing = createChatRouteHandler({
    handle: async () => {
      throw Object.assign(new Error('bad'), { code: 'BAD_REQUEST' })
    },
  })
  const failed = await callChat(failing, { repo: 'a/b', number: 1, messages: [message('user', 'q')] })
  const failedFrames = parseFrames(failed.response.body)
  assert.equal(failedFrames[0].error.code, 'INTERNAL')

  const badBody = createChatRouteHandler({ handle: async () => {} })
  const invalidJson = makeSseRequest({})
  invalidJson.url = '/codex-review/chat'
  const chunks = Readable.from([Buffer.from('{not json')])
  chunks.url = '/codex-review/chat'
  chunks.method = 'POST'
  chunks.headers = { host: '127.0.0.1:2632', 'content-type': 'application/json' }
  chunks.socket = { remoteAddress: '127.0.0.1' }
  const response = makeSseResponse()
  await badBody(chunks, response)
  assert.equal(parseFrames(response.body)[0].error.code, 'BAD_REQUEST')
})

test('the SSE handler aborts the flow and stays silent when the client disconnects', async () => {
  let aborted = false
  const handler = createChatRouteHandler({
    handle: async (payload, stream) => {
      stream.send(encodeSseDelta('first'))
      await new Promise((resolve) => {
        stream.signal.addEventListener('abort', resolve, { once: true })
      })
      aborted = true
    },
  })
  const request = makeSseRequest({ repo: 'a/b', number: 1, messages: [message('user', 'q')] })
  const response = makeSseResponse()
  const running = handler(request, response)
  for (let attempt = 0; attempt < 100 && response.body === ''; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5))
  response.emit('close')
  await running
  assert.equal(aborted, true)
  assert.equal(response.ended, true)
  assert.equal(response.body.includes('"error"'), false)
})

test('the SSE handler maps the request deadline to an LLM_ERROR frame', async () => {
  const handler = createChatRouteHandler({
    deadlineMs: 20,
    handle: async (payload, stream) => {
      await new Promise((resolve) => {
        stream.signal.addEventListener('abort', resolve, { once: true })
      })
      throw Object.assign(new Error('deadline'), { code: 'INTERNAL' })
    },
  })
  const { response } = await callChat(handler, { repo: 'a/b', number: 1, messages: [message('user', 'q')] })
  const frames = parseFrames(response.body)
  assert.equal(frames[0].error.code, 'LLM_ERROR')
  assert.ok(frames[0].error.message.includes('超时'))
})
