/**
 * Unit tests for the HTTP transport: trust fence and the shared JSON handler.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import {
  createJsonRouteHandler,
  isIPv4Loopback,
  isLoopbackAddress,
  isLoopbackHostname,
  isLoopbackRequest,
  isProxiedRequest,
  parsePathname,
  readJsonBody,
} from '../lib/http.js'
import { AppError } from '../lib/errors.js'

/**
 * Build a readable request stub.
 * @param {{ url?: string, method?: string, headers?: Record<string, unknown>, body?: unknown, rawBody?: string, remoteAddress?: string }} [options] - request data.
 * @returns {any} request stub with a Readable body.
 */
function makeRequest(options = {}) {
  const payload = options.rawBody !== undefined
    ? options.rawBody
    : typeof options.body === 'string' ? options.body : JSON.stringify(options.body ?? {})
  const request = Readable.from([Buffer.from(payload)])
  request.url = options.url ?? '/codex-review/health'
  request.method = options.method ?? 'POST'
  request.headers = {
    host: '127.0.0.1:2632',
    'content-type': 'application/json',
    'sec-fetch-site': 'same-origin',
    ...options.headers,
  }
  request.socket = { remoteAddress: options.remoteAddress ?? '127.0.0.1' }
  return request
}

/** @returns {any} response stub recording status, headers and body. */
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
 * Invoke one handler and decode the answer.
 * @param {Function} handler - route handler.
 * @param {any} [options] - request options.
 * @returns {Promise<{ status: number, headers: any, body: any }>} decoded answer.
 */
async function call(handler, options = {}) {
  const request = makeRequest(options)
  const response = makeResponse()
  await handler(request, response)
  return { status: response.statusCode, headers: response.headers, body: response.body === '' ? undefined : JSON.parse(response.body) }
}

test('loopback predicates cover 127/8, ::1 and IPv4-mapped peers', () => {
  assert.equal(isIPv4Loopback('127.0.0.1'), true)
  assert.equal(isIPv4Loopback('127.255.255.255'), true)
  assert.equal(isIPv4Loopback('128.0.0.1'), false)
  assert.equal(isIPv4Loopback('127.0.0'), false)
  assert.equal(isLoopbackAddress('127.0.0.1'), true)
  assert.equal(isLoopbackAddress('::1'), true)
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true)
  assert.equal(isLoopbackAddress('::ffff:10.0.0.1'), false)
  assert.equal(isLoopbackAddress(undefined), false)
  assert.equal(isLoopbackHostname('localhost'), true)
  assert.equal(isLoopbackHostname('[::1]'), true)
  assert.equal(isLoopbackHostname('127.0.0.1'), true)
  assert.equal(isLoopbackHostname('example.com'), false)
})

test('trust fence allows a loopback browser request and rejects proxy shapes', () => {
  assert.equal(isLoopbackRequest(makeRequest()), true)
  assert.equal(isLoopbackRequest(makeRequest({ headers: { origin: 'http://127.0.0.1:2632' } })), true)
  assert.equal(isLoopbackRequest(makeRequest({ remoteAddress: '::1', headers: { host: '[::1]:2632' } })), true)
  assert.equal(isProxiedRequest(makeRequest({ headers: { 'x-forwarded-for': '1.2.3.4' } })), true)

  assert.equal(isLoopbackRequest(makeRequest({ remoteAddress: '192.168.1.7' })), false)
  assert.equal(isLoopbackRequest(makeRequest({ headers: { host: 'example.com' } })), false)
  assert.equal(isLoopbackRequest(makeRequest({ headers: { 'x-forwarded-for': '1.2.3.4' } })), false)
  assert.equal(isLoopbackRequest(makeRequest({ headers: { 'cf-connecting-ip': '1.2.3.4' } })), false)
  assert.equal(isLoopbackRequest(makeRequest({ headers: { 'sec-fetch-site': 'cross-site' } })), false)
  assert.equal(isLoopbackRequest(makeRequest({ headers: { origin: 'http://evil.example' } })), false)
  assert.equal(isLoopbackRequest(makeRequest({ headers: { origin: 'not a url' } })), false)
  assert.equal(isLoopbackRequest(makeRequest({ headers: { host: undefined } })), false)
})

test('readJsonBody bounds the body and rejects malformed payloads', async () => {
  assert.deepEqual(await readJsonBody(makeRequest({ body: { a: 1 } }), {}), { ok: true, value: { a: 1 } })
  assert.deepEqual(await readJsonBody(makeRequest({ rawBody: '' }), {}), { ok: true, value: {} })
  assert.deepEqual(await readJsonBody(makeRequest({ rawBody: '{bad' }), {}), { ok: false, reason: 'invalid-json' })
  assert.deepEqual(await readJsonBody(makeRequest({ rawBody: '[1,2]' }), {}), { ok: false, reason: 'not-object' })
  assert.deepEqual(await readJsonBody(makeRequest({ rawBody: '{"a":1}' }), { maxBytes: 3 }), { ok: false, reason: 'too-large' })
})

test('parsePathname ignores the query string and malformed targets', () => {
  assert.equal(parsePathname('/codex-review/prs?x=1'), '/codex-review/prs')
  assert.equal(parsePathname('codex-review/health'), '/codex-review/health')
  assert.equal(parsePathname(undefined), '')
})

test('shared handler answers the success and error envelopes', async () => {
  const handler = createJsonRouteHandler({
    routes: {
      '/codex-review/health': async (payload, { signal }) => {
        assert.ok(signal instanceof AbortSignal)
        return { gh: 'ok', echoed: payload }
      },
      '/codex-review/bad': async () => {
        throw new AppError('GH_NOT_FOUND', '没有这个 PR')
      },
    },
  })
  const success = await call(handler, { url: '/codex-review/health', body: { probe: true } })
  assert.equal(success.status, 200)
  assert.deepEqual(success.body, { ok: true, value: { gh: 'ok', echoed: { probe: true } } })
  assert.equal(success.headers['content-type'], 'application/json; charset=utf-8')
  assert.equal(success.headers['cache-control'], 'no-store')
  assert.equal(success.headers['referrer-policy'], 'no-referrer')

  const failure = await call(handler, { url: '/codex-review/bad' })
  assert.equal(failure.status, 200)
  assert.deepEqual(failure.body, { ok: false, error: { code: 'GH_NOT_FOUND', message: '没有这个 PR' } })
})

test('shared handler enforces fence, method, content-type and route existence', async () => {
  const handler = createJsonRouteHandler({ routes: { '/codex-review/health': async () => ({}) } })
  assert.equal((await call(handler, { headers: { 'x-forwarded-for': '1.2.3.4' } })).status, 403)
  assert.equal((await call(handler, { remoteAddress: '10.0.0.2' })).status, 403)
  assert.equal((await call(handler, { method: 'GET' })).status, 405)
  assert.equal((await call(handler, { headers: { 'content-type': 'text/plain' } })).status, 415)
  assert.equal((await call(handler, { url: '/codex-review/nope' })).status, 404)
  const broken = await call(handler, { rawBody: '{bad' })
  assert.equal(broken.status, 200)
  assert.equal(broken.body.ok, false)
  assert.equal(broken.body.error.code, 'BAD_REQUEST')
  const oversized = await call(handler, { rawBody: `{"a":"${'x'.repeat(70 * 1024)}"}` })
  assert.equal(oversized.status, 200)
  assert.equal(oversized.body.ok, false)
  assert.equal(oversized.body.error.code, 'BAD_REQUEST')
  assert.ok(oversized.body.error.message.includes('64 KiB'))
})

test('shared handler turns a hung route into the deadline envelope', async () => {
  const handler = createJsonRouteHandler({
    routes: { '/codex-review/health': () => new Promise(() => {}) },
    deadlineMs: 20,
  })
  const answer = await call(handler)
  assert.equal(answer.status, 200)
  assert.equal(answer.body.ok, false)
  assert.equal(answer.body.error.code, 'INTERNAL')
  assert.ok(answer.body.error.message.includes('超时'))
})

test('shared handler maps an unexpected throw to INTERNAL without leaking details', async () => {
  const handler = createJsonRouteHandler({
    routes: {
      '/codex-review/health': async () => {
        throw new Error('secret token gho_123456 should not leak')
      },
    },
  })
  const answer = await call(handler)
  assert.deepEqual(answer.body, { ok: false, error: { code: 'INTERNAL', message: '插件内部错误' } })
})
