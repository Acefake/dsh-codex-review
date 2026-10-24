/**
 * Unit tests for the pure review primitives and the injectable job engine.
 * `node --test` only: no host context, no network, no real model.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ReviewEngine,
  buildOverview,
  buildUserPrompt,
  chunkFiles,
  compareFindings,
  extractJsonObject,
  findingId,
  mergeFindings,
  parseFindingsText,
  selectReviewableFiles,
} from '../lib/review.js'

/**
 * Build one normalized file patch.
 * @param {string} path - file path.
 * @param {string} patch - patch text.
 * @param {Record<string, unknown>} [extra] - field overrides.
 * @returns {any} normalized file.
 */
function makeFile(path, patch, extra = {}) {
  return { path, patch, status: 'modified', additions: 1, deletions: 0, patchTruncated: false, ...extra }
}

test('selectReviewableFiles skips empty patches and generated artifacts', () => {
  const files = [
    makeFile('src/a.ts', '@@ -1,2 +1,3 @@\n+x'),
    makeFile('src/binary.bin', ''),
    makeFile('package-lock.json', '@@ -1 +1 @@'),
    makeFile('pnpm-lock.yaml', '@@ -1 +1 @@'),
    makeFile('yarn.lock', '@@ -1 +1 @@'),
    makeFile('assets/app.min.js', '@@ -1 +1 @@'),
    makeFile('tests/__snapshots__/a.snap', '@@ -1 +1 @@'),
    makeFile('node_modules/dep/index.js', '@@ -1 +1 @@'),
  ]
  assert.deepEqual(selectReviewableFiles(files).map((file) => file.path), ['src/a.ts'])
})

test('chunkFiles respects the character budget, maxChunks and reports skipped files', () => {
  const files = Array.from({ length: 5 }, (_, index) => makeFile(`f${index}.ts`, 'x'.repeat(10)))
  const plan = chunkFiles(files, { chunkChars: 25, maxChunks: 2 })
  assert.equal(plan.chunks.length, 2)
  assert.deepEqual(plan.chunks.map((chunk) => chunk.files.map((file) => file.path)), [
    ['f0.ts', 'f1.ts'],
    ['f2.ts', 'f3.ts'],
  ])
  assert.deepEqual(plan.skippedFiles, ['f4.ts'])
  assert.equal(plan.totalChars, 50)
  assert.equal(plan.skippedChars, 10)
})

test('chunkFiles keeps one oversized file alone and every file when budgets allow', () => {
  const oversized = chunkFiles(
    [makeFile('huge.ts', 'y'.repeat(100)), makeFile('small.ts', 'z'.repeat(5))],
    { chunkChars: 25, maxChunks: 6 },
  )
  assert.equal(oversized.chunks.length, 2)
  assert.deepEqual(oversized.chunks[0].files.map((file) => file.path), ['huge.ts'])
  assert.deepEqual(oversized.chunks[1].files.map((file) => file.path), ['small.ts'])
  assert.deepEqual(chunkFiles([makeFile('a.ts', 'a'.repeat(5))], { chunkChars: 100, maxChunks: 6 }).skippedFiles, [])
})

test('buildUserPrompt carries the PR header, file list, @@ headers and the output schema', () => {
  const prompt = buildUserPrompt({
    pr: { repo: 'Acme/repo', number: 7, title: '修复登录', body: '正文内容', baseRefName: 'main', headRefName: 'feat/login' },
    chunk: { files: [makeFile('src/login.ts', '@@ -3,2 +3,4 @@\n context\n+added')] },
    chunkIndex: 0,
    chunkCount: 2,
  })
  assert.ok(prompt.includes('# Pull Request Acme/repo#7'))
  assert.ok(prompt.includes('标题：修复登录'))
  assert.ok(prompt.includes('feat/login → main'))
  assert.ok(prompt.includes('正文内容'))
  assert.ok(prompt.includes('### src/login.ts [modified +1 −0]'))
  assert.ok(prompt.includes('@@ -3,2 +3,4 @@'))
  assert.ok(prompt.includes('第 1/2 块'))
  assert.ok(prompt.includes('"findings"'))
  assert.ok(prompt.includes('P0"|"P1"|"P2'))
})

test('extractJsonObject strips fences and finds the first balanced object', () => {
  assert.equal(extractJsonObject('```json\n{"a":1}\n```'), '{"a":1}')
  assert.equal(extractJsonObject('前言 {"a":{"b":2}} 后记'), '{"a":{"b":2}}')
  assert.equal(extractJsonObject('{"text":"}{"}'), '{"text":"}{"}')
  assert.equal(extractJsonObject('no json here'), null)
})

test('parseFindingsText accepts plain, fenced and surrounded JSON and filters invalid findings', () => {
  const allowedFiles = new Set(['src/a.ts'])
  const fenced = '```json\n{"findings":[{"severity":"P1","file":"src/a.ts","line":12,"title":"空指针","why":"条件→崩溃","fix":"判空","category":"correctness"}]}\n```'
  const parsed = parseFindingsText(fenced, { allowedFiles })
  assert.equal(parsed.ok, true)
  assert.equal(parsed.findings.length, 1)
  assert.equal(parsed.findings[0].id, undefined)
  assert.equal(parsed.findings[0].line, 12)
  assert.equal(parsed.findings[0].category, 'correctness')

  const surrounded = parseFindingsText('好的，结果如下：{"findings":[]} 完毕', { allowedFiles })
  assert.deepEqual(surrounded, { ok: true, findings: [] })

  assert.deepEqual(parseFindingsText('not json at all', { allowedFiles }), { ok: false, reason: 'no-json-object' })
  assert.deepEqual(parseFindingsText('{"findings": [}', { allowedFiles }), { ok: false, reason: 'invalid-json' })
  assert.deepEqual(parseFindingsText('{"findings": 3}', { allowedFiles }), { ok: false, reason: 'missing-findings-array' })

  const mixed = JSON.stringify({
    findings: [
      { severity: 'P9', file: 'src/a.ts', line: 1, title: 'bad severity' },
      { severity: 'P0', file: 'src/other.ts', line: 1, title: 'file not in chunk' },
      { severity: 'P0', file: 'src/a.ts', line: 0, title: 'bad line' },
      { severity: 'P0', file: 'src/a.ts', line: 1, title: '' },
      { severity: 'P0', file: 'src/a.ts', line: 4, title: 'valid', lineEnd: 6 },
    ],
  })
  const filtered = parseFindingsText(mixed, { allowedFiles })
  assert.equal(filtered.ok, true)
  assert.equal(filtered.findings.length, 1)
  assert.equal(filtered.findings[0].title, 'valid')
  assert.equal(filtered.findings[0].lineEnd, 6)
  assert.equal(filtered.findings[0].why, '')
  assert.equal(filtered.findings[0].fix, '')
})

test('mergeFindings de-duplicates, sorts P0→P2 then file/line and builds the overview', () => {
  const groups = [
    [
      { severity: 'P1', file: 'b.ts', line: 3, title: 'Minor  issue', why: '', fix: '' },
      { severity: 'P0', file: 'z.ts', line: 9, title: 'Crash', why: '', fix: '' },
    ],
    [
      { severity: 'P1', file: 'b.ts', line: 3, title: 'minor issue', why: '', fix: '' },
      { severity: 'P1', file: 'a.ts', line: 2, title: 'Other', why: '', fix: '' },
    ],
  ]
  const merged = mergeFindings(groups)
  assert.deepEqual(merged.findings.map((finding) => `${finding.severity}:${finding.file}:${finding.line}`), [
    'P0:z.ts:9',
    'P1:a.ts:2',
    'P1:b.ts:3',
  ])
  assert.equal(merged.findings[0].id.length, 12)
  assert.equal(merged.findings[0].rank, undefined)
  assert.equal(merged.overview, '共 3 个问题：P0 ×1 · P1 ×2')
  assert.equal(buildOverview([]), 'AI 未发现明显问题')
  assert.equal(findingId({ file: 'b.ts', line: 3, title: 'Minor  ISSUE' }), findingId({ file: 'b.ts', line: 3, title: 'minor issue' }))
  assert.ok(compareFindings({ severity: 'P0', file: 'a', line: 1 }, { severity: 'P1', file: 'a', line: 1 }) < 0)
})

/**
 * Build a fake async stream that returns one answer and one finish chunk.
 * @param {string} answer - text to stream.
 * @param {Record<string, unknown>} [reason] - finish reason.
 * @returns {{ streamLlm: (request: any) => AsyncIterable<any>, requests: any[] }} fake seam.
 */
function fakeStream(answer, reason = { kind: 'stop' }) {
  const requests = []
  return {
    requests,
    streamLlm: (request) => {
      requests.push(request)
      return (async function* generate() {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: answer }
        yield { type: 'finish', reason }
      })()
    },
  }
}

/** One PR snapshot used by the engine tests. */
const PR_INPUT = {
  repo: 'Acme/repo',
  number: 9,
  headSha: 'sha-1',
  title: '修复登录',
  body: '正文',
  baseRefName: 'main',
  headRefName: 'feat/login',
  files: [makeFile('src/a.ts', '@@ -1,2 +1,3 @@\n context\n+added')],
}

/** Findings answer that survives validation. */
const FINDINGS_ANSWER = JSON.stringify({
  findings: [{ severity: 'P1', file: 'src/a.ts', line: 2, title: '空指针', why: '为 null 时崩溃', fix: '判空', category: 'correctness' }],
})

test('ReviewEngine runs a job to done and reuses the cached result for the same head', async () => {
  const { streamLlm, requests } = fakeStream(FINDINGS_ANSWER)
  const engine = new ReviewEngine({
    streamLlm,
    resolveSelection: () => ({ provider: 'provider-a', model: 'model-a' }),
    config: { reviewChunkChars: 1000, maxChunks: 6, maxOutputTokens: 512, maxJobs: 5 },
    sleep: async () => {},
    now: () => 1000,
    callTimeoutMs: 5000,
  })
  assert.equal(engine.available(), true)
  const started = engine.start(PR_INPUT)
  assert.equal(started.cached, false)
  await engine.jobs.get(started.jobId).done
  const status = engine.status(started.jobId)
  assert.equal(status.state, 'done')
  assert.equal(status.progress.phase, 'done')
  assert.equal(status.progress.filesDone, 1)
  assert.equal(status.progress.filesTotal, 1)
  assert.equal(status.findings.length, 1)
  assert.equal(status.findings[0].file, 'src/a.ts')
  assert.equal(status.overview, '共 1 个问题：P1 ×1')
  assert.equal(status.model.provider, 'provider-a')
  assert.equal(status.partial, false)

  assert.equal(requests.length, 1)
  const request = requests[0]
  assert.equal(request.provider, 'provider-a')
  assert.equal(request.model, 'model-a')
  assert.ok(request.system.includes('资深代码审查者'))
  assert.equal(request.messages.length, 1)
  assert.equal(request.messages[0].role, 'user')
  assert.equal(request.messages[0].content[0].type, 'text')
  assert.ok(request.messages[0].content[0].text.includes('src/a.ts'))
  assert.equal(request.maxTokens, 512)
  assert.ok(request.signal instanceof AbortSignal)

  const cached = engine.start(PR_INPUT)
  assert.equal(cached.cached, true)
  assert.equal(cached.jobId, started.jobId)
  assert.equal(engine.existing('Acme/repo', 9, 'sha-1').state, 'done')
  assert.equal(engine.existing('Acme/repo', 9, 'sha-other').state, 'none')
  assert.throws(() => engine.status('missing'), (error) => error.code === 'BAD_REQUEST')
})

test('ReviewEngine marks a job partial when a chunk never returns valid JSON (retry once)', async () => {
  const { streamLlm, requests } = fakeStream('这次不是 JSON')
  const engine = new ReviewEngine({
    streamLlm,
    resolveSelection: () => ({ provider: 'p', model: 'm' }),
    config: { reviewChunkChars: 1000, maxChunks: 6 },
    sleep: async () => {},
  })
  const started = engine.start(PR_INPUT)
  await engine.jobs.get(started.jobId).done
  const status = engine.status(started.jobId)
  assert.equal(status.state, 'done')
  assert.equal(status.partial, true)
  assert.deepEqual(status.findings, [])
  assert.equal(status.overview, '部分内容未能完成审查（1 个文件块失败）')
  assert.deepEqual(status.partialReasons, ['1 个文件未完成：no-json-object'])
  assert.equal(requests.length, 2)
  assert.ok(requests[1].messages[0].content[0].text.includes('上一次输出不是合法 JSON'))
})

test('ReviewEngine settles an LLM failure as an error job with a stable code', async () => {
  const engine = new ReviewEngine({
    streamLlm: () => {
      const failure = new Error('no adapter for provider')
      failure.code = 'NO_ADAPTER'
      throw failure
    },
    resolveSelection: () => ({ provider: 'p', model: 'm' }),
    config: {},
  })
  const started = engine.start(PR_INPUT)
  await engine.jobs.get(started.jobId).done
  const status = engine.status(started.jobId)
  assert.equal(status.state, 'error')
  assert.equal(status.error.code, 'LLM_ERROR')
  assert.ok(status.error.message.includes('NO_ADAPTER'))
})

test('ReviewEngine reports LLM_UNAVAILABLE without the llm seam and cancels a running job', async () => {
  const unavailable = new ReviewEngine({ config: {} })
  assert.equal(unavailable.available(), false)
  assert.throws(() => unavailable.start(PR_INPUT), (error) => error.code === 'LLM_UNAVAILABLE')

  const engine = new ReviewEngine({
    streamLlm: () => (async function* slow() {
      await new Promise((resolve) => setTimeout(resolve, 5))
      yield { type: 'text-delta', index: 0, text: FINDINGS_ANSWER }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })(),
    resolveSelection: () => ({ provider: 'p', model: 'm' }),
    config: { reviewChunkChars: 1000 },
    sleep: async () => {},
  })
  const started = engine.start(PR_INPUT)
  assert.equal(engine.cancel(started.jobId), true)
  await engine.jobs.get(started.jobId).done
  assert.equal(engine.status(started.jobId).state, 'cancelled')
  assert.equal(engine.existing('Acme/repo', 9, 'sha-1').state, 'none')
  assert.equal(engine.cancel('missing'), false)
})

test('ReviewEngine maps a finish chunk error reason to LLM_ERROR', async () => {
  const { streamLlm } = fakeStream('', { kind: 'error', failure: { code: 'AUTH', message: 'bad key' } })
  const engine = new ReviewEngine({
    streamLlm,
    resolveSelection: () => ({ provider: 'p', model: 'm' }),
    config: {},
  })
  const started = engine.start(PR_INPUT)
  await engine.jobs.get(started.jobId).done
  const status = engine.status(started.jobId)
  assert.equal(status.state, 'error')
  assert.equal(status.error.code, 'LLM_ERROR')
  assert.ok(status.error.message.includes('AUTH'))
})

test('parseFindingsText also accepts a bare findings array', () => {
  const allowedFiles = new Set(['src/a.ts'])
  const parsed = parseFindingsText(
    '[{"severity":"P2","file":"src/a.ts","line":7,"title":"边界值","why":"空数组→越界","fix":"先判空"}]',
    { allowedFiles },
  )
  assert.equal(parsed.ok, true)
  assert.equal(parsed.findings.length, 1)
  assert.equal(parsed.findings[0].line, 7)
})

test('a prose "no issues" answer counts as a clean chunk, not a partial failure', async () => {
  const { streamLlm } = fakeStream('本块代码未发现问题，无需修改。')
  const engine = new ReviewEngine({
    streamLlm,
    resolveSelection: () => ({ provider: 'p', model: 'm' }),
    config: { reviewChunkChars: 1000, maxChunks: 6 },
    sleep: async () => {},
  })
  const started = engine.start(PR_INPUT)
  await engine.jobs.get(started.jobId).done
  const status = engine.status(started.jobId)
  assert.equal(status.state, 'done')
  assert.equal(status.partial, false)
  assert.equal(status.partialReasons, undefined)
  assert.deepEqual(status.findings, [])
  assert.equal(status.overview, 'AI 未发现明显问题')
})

test('every chunk request carries the review job id as the provider session id', async () => {
  const { streamLlm, requests } = fakeStream(FINDINGS_ANSWER)
  const engine = new ReviewEngine({
    streamLlm,
    resolveSelection: () => ({ provider: 'p', model: 'm' }),
    config: { reviewChunkChars: 1000, maxChunks: 6 },
    sleep: async () => {},
  })
  const started = engine.start(PR_INPUT)
  await engine.jobs.get(started.jobId).done
  assert.ok(requests.length > 0)
  for (const request of requests) assert.equal(request.sessionId, started.jobId)
})
