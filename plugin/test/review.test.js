/**
 * Unit tests for the pure review primitives and the injectable job engine.
 * `node --test` only: no host context, no network, no real model.
 */

import test from 'node:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import {
  DEPTH_PRESETS,
  EVIDENCE_MAX_CHARS,
  ReviewEngine,
  buildOverview,
  buildReviewJobKey,
  buildUserPrompt,
  buildVerificationPrompt,
  chunkFiles,
  compareFindings,
  deriveVerdict,
  extractJsonObject,
  extractPatchExcerpt,
  fileCacheKey,
  filterFindingsByThreshold,
  findingId,
  mergeFindings,
  normalizeFinding,
  parseFindingsText,
  parseVerificationKeep,
  resolveReviewOptions,
  selectReviewableFiles,
  summarizeGuidelines,
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
  assert.equal(buildOverview([]), '共 0 个问题：AI 未发现明显问题')
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
  assert.equal(status.overview, '共 0 个问题：AI 未发现明显问题')
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

// ---------------------------------------------------------------------------
// v1.1: review options, file-level incremental cache, threshold/verdict,
// evidence/confidence and the deep verification round (CONTRACT §4).
// ---------------------------------------------------------------------------

/**
 * Build a fake stream that answers calls in sequence (one answer per model
 * call), repeating the last answer when more calls arrive. An `Error` entry is
 * thrown from the stream iterator.
 * @param {Array<string | Error>} answers - one answer per call.
 * @returns {{ streamLlm: (request: any) => AsyncIterable<any>, requests: any[] }} fake seam.
 */
function fakeSequence(answers) {
  const requests = []
  let index = 0
  return {
    requests,
    streamLlm: (request) => {
      requests.push(request)
      const answer = answers[Math.min(index, answers.length - 1)]
      index += 1
      return (async function* generate() {
        if (answer instanceof Error) throw answer
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: answer }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
}

/**
 * Build one engine with a fake model seam.
 * @param {{ streamLlm: (request: any) => AsyncIterable<any> }} seam - fake seam.
 * @param {Record<string, unknown>} [config] - config overrides.
 * @param {Record<string, unknown>} [extra] - engine options.
 * @returns {ReviewEngine} engine.
 */
function makeEngine(seam, config = {}, extra = {}) {
  return new ReviewEngine({
    streamLlm: seam.streamLlm,
    resolveSelection: () => ({ provider: 'p', model: 'm' }),
    config: { reviewChunkChars: 100_000, maxChunks: 20, ...config },
    sleep: async () => {},
    ...extra,
  })
}

/**
 * Findings answer for two files.
 * @returns {string} JSON model answer.
 */
function twoFileAnswer() {
  return JSON.stringify({
    findings: [
      { severity: 'P1', file: 'src/a.ts', line: 2, title: 'A 缺陷', why: '条件→崩溃', fix: '判空', category: 'correctness' },
      { severity: 'P2', file: 'src/b.ts', line: 3, title: 'B 缺陷', why: '边界', fix: '加校验', category: 'test' },
    ],
  })
}

/** Two reviewable files with distinct patches. */
const TWO_FILES = [
  makeFile('src/a.ts', '@@ -1,2 +1,3 @@\n context\n+added'),
  makeFile('src/b.ts', '@@ -2,2 +2,3 @@\n context\n+other'),
]

test('resolveReviewOptions expands depth presets and falls back on unknown values (CONTRACT §4.1)', () => {
  assert.deepEqual(resolveReviewOptions(undefined, {}), {
    depth: 'standard',
    severityThreshold: 'P2',
    includeGuidelines: true,
    chunkChars: 9000,
    maxChunks: 9,
    concurrency: 3,
  })
  assert.deepEqual(resolveReviewOptions({ depth: 'fast' }, {}), {
    depth: 'fast',
    severityThreshold: 'P2',
    includeGuidelines: true,
    chunkChars: DEPTH_PRESETS.fast.chunkChars,
    maxChunks: DEPTH_PRESETS.fast.maxChunks,
    concurrency: DEPTH_PRESETS.fast.concurrency,
  })
  assert.deepEqual(resolveReviewOptions({ depth: 'deep' }, {}), {
    depth: 'deep',
    severityThreshold: 'P2',
    includeGuidelines: true,
    chunkChars: DEPTH_PRESETS.deep.chunkChars,
    maxChunks: DEPTH_PRESETS.deep.maxChunks,
    concurrency: DEPTH_PRESETS.deep.concurrency,
  })
  // The standard depth honours the plugin's configured budgets (whose defaults
  // equal the contract preset).
  const configured = resolveReviewOptions({}, { reviewChunkChars: 1234, maxChunks: 4, reviewConcurrency: 2 })
  assert.equal(configured.chunkChars, 1234)
  assert.equal(configured.maxChunks, 4)
  assert.equal(configured.concurrency, 2)
  // … while fast/deep keep their contractual presets.
  assert.equal(resolveReviewOptions({ depth: 'fast' }, { reviewChunkChars: 1234 }).chunkChars, DEPTH_PRESETS.fast.chunkChars)
  // Unknown values fall back instead of failing the request.
  assert.deepEqual(resolveReviewOptions({ depth: 'turbo', severityThreshold: 'P9', includeGuidelines: null }, {}), {
    depth: 'standard',
    severityThreshold: 'P2',
    includeGuidelines: true,
    chunkChars: 9000,
    maxChunks: 9,
    concurrency: 3,
  })
  assert.equal(resolveReviewOptions({ includeGuidelines: false }, {}).includeGuidelines, false)
})

test('buildReviewJobKey separates head, depth, threshold and guideline choice (CONTRACT §4.1)', () => {
  const base = resolveReviewOptions({}, {})
  const key = buildReviewJobKey('Acme/repo', 9, 'sha-1', base)
  assert.equal(key, 'Acme/repo#9@sha-1|standard|P2|1')
  assert.equal(buildReviewJobKey('Acme/repo', 9, 'sha-1', resolveReviewOptions({ depth: 'fast' }, {})).includes('|fast|'), true)
  assert.notEqual(key, buildReviewJobKey('Acme/repo', 9, 'sha-1', resolveReviewOptions({ depth: 'fast' }, {})))
  assert.notEqual(key, buildReviewJobKey('Acme/repo', 9, 'sha-1', resolveReviewOptions({ severityThreshold: 'P0' }, {})))
  assert.notEqual(key, buildReviewJobKey('Acme/repo', 9, 'sha-1', resolveReviewOptions({ includeGuidelines: false }, {})))
  assert.notEqual(key, buildReviewJobKey('Acme/repo', 9, 'sha-2', base))
})

test('filterFindingsByThreshold and deriveVerdict implement CONTRACT §4.2', () => {
  const findings = [
    { severity: 'P0', file: 'a.ts', line: 1, title: 'a' },
    { severity: 'P1', file: 'b.ts', line: 2, title: 'b' },
    { severity: 'P2', file: 'c.ts', line: 3, title: 'c' },
  ]
  assert.deepEqual(filterFindingsByThreshold(findings, 'P0').map((finding) => finding.severity), ['P0'])
  assert.deepEqual(filterFindingsByThreshold(findings, 'P1').map((finding) => finding.severity), ['P0', 'P1'])
  assert.deepEqual(filterFindingsByThreshold(findings, 'P2').map((finding) => finding.severity), ['P0', 'P1', 'P2'])
  assert.equal(filterFindingsByThreshold(findings, 'bogus').length, 3)
  assert.deepEqual(filterFindingsByThreshold(null, 'P0'), [])

  assert.equal(deriveVerdict(findings), 'block')
  assert.equal(deriveVerdict([{ severity: 'P1' }, { severity: 'P2' }]), 'changes')
  assert.equal(deriveVerdict([{ severity: 'P2' }]), 'approve')
  assert.equal(deriveVerdict([]), 'approve')
})

test('normalizeFinding validates/truncates evidence and confidence (CONTRACT §4.2)', () => {
  const allowed = new Set(['src/a.ts'])
  const finding = normalizeFinding({
    severity: 'p1',
    file: './src/a.ts',
    line: 2,
    title: '  空指针  ',
    evidence: '  +const a = null  ',
    confidence: 'HIGH',
  }, allowed)
  assert.equal(finding.severity, 'P1')
  assert.equal(finding.file, 'src/a.ts')
  assert.equal(finding.title, '空指针')
  assert.equal(finding.evidence, '+const a = null')
  assert.equal(finding.confidence, 'high')

  const truncated = normalizeFinding({ severity: 'P2', file: 'src/a.ts', line: 1, title: 'x', evidence: 'e'.repeat(500) }, allowed)
  assert.equal(truncated.evidence.length, EVIDENCE_MAX_CHARS)

  const omitted = normalizeFinding({ severity: 'P2', file: 'src/a.ts', line: 1, title: 'x', evidence: '   ', confidence: 'sure' }, allowed)
  assert.equal('evidence' in omitted, false)
  assert.equal('confidence' in omitted, false)
})

test('fileCacheKey and extractPatchExcerpt are deterministic and line-accurate', () => {
  assert.equal(fileCacheKey('o/r', 1, 'a.ts', 'patch'), fileCacheKey('o/r', 1, 'a.ts', 'patch'))
  assert.notEqual(fileCacheKey('o/r', 1, 'a.ts', 'patch'), fileCacheKey('o/r', 1, 'a.ts', 'patch-changed'))
  assert.notEqual(fileCacheKey('o/r', 1, 'a.ts', 'patch'), fileCacheKey('o/r', 2, 'a.ts', 'patch'))
  assert.notEqual(fileCacheKey('o/r', 1, 'a.ts', 'patch'), fileCacheKey('o/r', 1, 'b.ts', 'patch'))
  assert.ok(fileCacheKey('o/r', 1, 'a.ts', 'patch').startsWith('o/r#1|a.ts|'))

  const patch = ['@@ -10,4 +20,5 @@', ' context20', '-removed', '+added21', ' context22', '+added23'].join('\n')
  assert.equal(extractPatchExcerpt(patch, 21, { context: 0 }), '   21\t+added21')
  const excerpt = extractPatchExcerpt(patch, 21, { context: 1 })
  assert.ok(excerpt.includes('   20\t context20'))
  assert.ok(excerpt.includes('   22\t context22'))
  assert.equal(extractPatchExcerpt(patch, 99), '')
  assert.equal(extractPatchExcerpt('', 1), '')
  // The excerpt must never quote removed lines: they have no new-file position.
  assert.equal(extractPatchExcerpt(patch, 20, { context: 0 }).includes('-removed'), false)
})

test('buildVerificationPrompt lists every finding with its patch lines and parseVerificationKeep reads the keep list', () => {
  const prompt = buildVerificationPrompt({
    findings: [
      { severity: 'P1', file: 'src/a.ts', line: 2, title: '有证据', why: 'w', fix: 'f', evidence: '+added' },
      { severity: 'P2', file: 'src/missing.ts', line: 9, title: '缺文件', why: 'w', fix: 'f' },
    ],
    files: TWO_FILES,
  })
  assert.ok(prompt.includes('[1] P1 · src/a.ts:2 · 有证据'))
  assert.ok(prompt.includes('[2] P2 · src/missing.ts:9 · 缺文件'))
  assert.ok(prompt.includes('+added'))
  assert.ok(prompt.includes('（未找到对应 patch 行）'))
  assert.ok(prompt.includes('{"keep"'))

  assert.deepEqual([...parseVerificationKeep('{"keep":[1,3]}')], [1, 3])
  assert.deepEqual([...parseVerificationKeep('```json\n{"keep":[2]}\n```')], [2])
  assert.deepEqual([...parseVerificationKeep('[2,4]')], [2, 4])
  assert.deepEqual([...parseVerificationKeep('{"keep":["2"]}')], [2])
  assert.equal(parseVerificationKeep('{"keep":[]}')?.size, 0)
  assert.equal(parseVerificationKeep('不是 JSON'), null)
  assert.equal(parseVerificationKeep('{"drop":[1]}'), null)
  assert.equal(parseVerificationKeep('{"keep":3}'), null)
})

test('buildUserPrompt injects repository guidelines as their own section (CONTRACT §4.4)', () => {
  const base = {
    pr: { repo: 'Acme/repo', number: 7, title: 't' },
    chunk: { files: [makeFile('src/a.ts', '@@ -1 +1 @@\n+a')] },
    chunkIndex: 0,
    chunkCount: 1,
  }
  const withGuidelines = buildUserPrompt({ ...base, guidelines: '## 仓库约定\n- 必须使用 X' })
  assert.ok(withGuidelines.includes('## 仓库审查指引'))
  assert.ok(withGuidelines.includes('必须使用 X'))
  assert.ok(withGuidelines.includes('不得覆盖「只报告本次 diff 引入的真实缺陷」'))
  assert.ok(withGuidelines.includes('"evidence"'))
  assert.ok(withGuidelines.includes('"confidence"'))
  assert.equal(buildUserPrompt(base).includes('## 仓库审查指引'), false)
  assert.equal(buildUserPrompt({ ...base, guidelines: '   ' }).includes('## 仓库审查指引'), false)
})

test('summarizeGuidelines normalizes the public guidelines status', () => {
  assert.deepEqual(summarizeGuidelines(undefined), { loaded: false, files: [], chars: 0 })
  assert.deepEqual(summarizeGuidelines({ loaded: true, files: ['AGENTS.md'], chars: 42, text: 'x' }), { loaded: true, files: ['AGENTS.md'], chars: 42 })
  assert.deepEqual(summarizeGuidelines({ loaded: 'yes', files: ['AGENTS.md'], chars: -1 }), { loaded: false, files: ['AGENTS.md'], chars: 0 })
  assert.deepEqual(summarizeGuidelines({ loaded: true, files: [], chars: 3 }), { loaded: false, files: [], chars: 3 })
})

test('ReviewEngine starts a distinct job per option set and only reuses the same one (CONTRACT §4.6 #1)', async () => {
  const seam = fakeSequence([FINDINGS_ANSWER])
  const engine = makeEngine(seam)
  const fast = engine.start({ ...PR_INPUT, options: { depth: 'fast' } })
  assert.equal(fast.cached, false)
  assert.equal(fast.options.depth, 'fast')
  // A second start while it runs joins the same job without claiming a cache hit.
  const joined = engine.start({ ...PR_INPUT, options: { depth: 'fast' } })
  assert.equal(joined.jobId, fast.jobId)
  assert.equal(joined.cached, false)
  await engine.jobs.get(fast.jobId).done

  const cached = engine.start({ ...PR_INPUT, options: { depth: 'fast' } })
  assert.equal(cached.cached, true)
  assert.equal(cached.jobId, fast.jobId)
  assert.equal(cached.options.depth, 'fast')

  const standard = engine.start({ ...PR_INPUT })
  assert.equal(standard.cached, false)
  assert.notEqual(standard.jobId, fast.jobId)
  assert.equal(standard.options.depth, 'standard')
  await engine.jobs.get(standard.jobId).done
  assert.equal(engine.status(standard.jobId).state, 'done')

  // The detail snapshot reports the most recent option variant for the head.
  assert.equal(engine.existing('Acme/repo', 9, 'sha-1').options.depth, 'standard')
  assert.equal(engine.existing('Acme/repo', 9, 'sha-1').state, 'done')
})

test('file-level cache serves unchanged files and all-cached reviews finish without any model call (CONTRACT §4.3)', async () => {
  const seam = fakeSequence([twoFileAnswer()])
  const engine = makeEngine(seam, { reviewChunkChars: 100_000 })
  const first = engine.start({ ...PR_INPUT, files: TWO_FILES, options: { depth: 'fast' } })
  await engine.jobs.get(first.jobId).done
  const firstStatus = engine.status(first.jobId)
  assert.equal(firstStatus.state, 'done')
  assert.equal(firstStatus.findings.length, 2)
  assert.equal(firstStatus.reusedFiles, 0)
  assert.equal(firstStatus.progress.filesTotal, 2)
  assert.equal(firstStatus.progress.filesDone, 2)
  assert.equal(seam.requests.length, 1)

  // Same head, different depth → different job, but every file is reused.
  const second = engine.start({ ...PR_INPUT, files: TWO_FILES, options: { depth: 'standard' } })
  assert.equal(second.cached, false)
  assert.notEqual(second.jobId, first.jobId)
  await engine.jobs.get(second.jobId).done
  const secondStatus = engine.status(second.jobId)
  assert.equal(secondStatus.state, 'done')
  assert.equal(secondStatus.reusedFiles, 2)
  assert.equal(secondStatus.progress.filesDone, 2)
  assert.equal(secondStatus.progress.filesTotal, 2)
  assert.equal(secondStatus.findings.length, 2)
  assert.ok(secondStatus.progress.elapsedMs < 1000, `all-cached review took ${secondStatus.progress.elapsedMs}ms`)
  assert.equal(seam.requests.length, 1)

  // Deep on a fully cached PR also short-circuits: no review, no verification.
  const deep = engine.start({ ...PR_INPUT, files: TWO_FILES, options: { depth: 'deep' } })
  await engine.jobs.get(deep.jobId).done
  assert.equal(engine.status(deep.jobId).reusedFiles, 2)
  assert.equal(seam.requests.length, 1)
  assert.equal(engine.existing('Acme/repo', 9, 'sha-1').reusedFiles, 2)
})

test('file-level cache only re-reviews files whose patch changed (CONTRACT §4.6 #2)', async () => {
  const changedAnswer = JSON.stringify({
    findings: [{ severity: 'P2', file: 'src/b.ts', line: 9, title: 'B 新缺陷', why: '边界', fix: '校验' }],
  })
  const seam = fakeSequence([twoFileAnswer(), changedAnswer])
  const engine = makeEngine(seam, { reviewChunkChars: 100_000 })
  const first = engine.start({ ...PR_INPUT, headSha: 'sha-1', files: TWO_FILES, options: { depth: 'fast' } })
  await engine.jobs.get(first.jobId).done
  assert.equal(seam.requests.length, 1)

  const changedFiles = [TWO_FILES[0], makeFile('src/b.ts', '@@ -2,2 +2,4 @@\n context\n+other\n+extra')]
  const second = engine.start({ ...PR_INPUT, headSha: 'sha-2', files: changedFiles, options: { depth: 'fast' } })
  await engine.jobs.get(second.jobId).done
  assert.equal(seam.requests.length, 2)
  // Only the changed file was sent: the whitelist of that chunk is exactly it.
  assert.ok(seam.requests[1].messages[0].content[0].text.includes('### src/b.ts'))
  assert.equal(seam.requests[1].messages[0].content[0].text.includes('### src/a.ts'), false)
  const status = engine.status(second.jobId)
  assert.equal(status.reusedFiles, 1)
  assert.deepEqual(status.findings.map((finding) => finding.file), ['src/a.ts', 'src/b.ts'])
})

test('the file-level cache is a bounded LRU', async () => {
  const seam = fakeSequence([twoFileAnswer()])
  const engine = makeEngine(seam, { reviewChunkChars: 100_000 }, { fileCacheMax: 2 })
  const files = [
    makeFile('src/a.ts', '@@ -1 +1 @@\n+a'),
    makeFile('src/b.ts', '@@ -1 +1 @@\n+b'),
    makeFile('src/c.ts', '@@ -1 +1 @@\n+c'),
  ]
  const first = engine.start({ ...PR_INPUT, headSha: 'sha-1', files, options: { depth: 'fast' } })
  await engine.jobs.get(first.jobId).done
  assert.equal(engine.fileCache.entries.size, 2)
  // src/a.ts was the oldest entry and got evicted; b/c are still served.
  const second = engine.start({ ...PR_INPUT, headSha: 'sha-1', files, options: { depth: 'standard' } })
  await engine.jobs.get(second.jobId).done
  const status = engine.status(second.jobId)
  assert.equal(status.reusedFiles, 2)
  assert.equal(seam.requests.length, 2)
  assert.ok(seam.requests[1].messages[0].content[0].text.includes('### src/a.ts'))
})

test('severityThreshold filters after merge and drives overview/verdict (CONTRACT §4.6 #4)', async () => {
  const answer = JSON.stringify({
    findings: [
      { severity: 'P0', file: 'src/a.ts', line: 2, title: '崩溃', why: 'w', fix: 'f' },
      { severity: 'P1', file: 'src/a.ts', line: 3, title: '错误', why: 'w', fix: 'f' },
      { severity: 'P2', file: 'src/a.ts', line: 4, title: '建议', why: 'w', fix: 'f' },
    ],
  })
  const seam = fakeSequence([answer])
  const engine = makeEngine(seam, { reviewChunkChars: 1000 })
  const all = engine.start({ ...PR_INPUT, options: { depth: 'fast' } })
  await engine.jobs.get(all.jobId).done
  const allStatus = engine.status(all.jobId)
  assert.equal(allStatus.findings.length, 3)
  assert.equal(allStatus.overview, '共 3 个问题：P0 ×1 · P1 ×1 · P2 ×1')
  assert.equal(allStatus.verdict, 'block')

  // P0-only threshold: findings, overview and verdict all use the filtered set.
  const p0 = engine.start({ ...PR_INPUT, options: { depth: 'standard', severityThreshold: 'P0' } })
  await engine.jobs.get(p0.jobId).done
  const p0Status = engine.status(p0.jobId)
  assert.equal(p0Status.reusedFiles, 1)
  assert.deepEqual(p0Status.findings.map((finding) => finding.severity), ['P0'])
  assert.equal(p0Status.overview, '共 1 个问题：P0 ×1')
  assert.equal(p0Status.verdict, 'block')
  assert.equal(p0Status.partial, false)

  const p1 = engine.start({ ...PR_INPUT, options: { depth: 'fast', severityThreshold: 'P1' } })
  await engine.jobs.get(p1.jobId).done
  const p1Status = engine.status(p1.jobId)
  assert.deepEqual(p1Status.findings.map((finding) => finding.severity), ['P0', 'P1'])
  assert.equal(p1Status.overview, '共 2 个问题：P0 ×1 · P1 ×1')
})

test('verdict is derived from the reported findings (P0 block / P1 changes / else approve)', async () => {
  const p2Only = JSON.stringify({ findings: [{ severity: 'P2', file: 'src/a.ts', line: 2, title: '建议', why: 'w', fix: 'f' }] })
  const approveEngine = makeEngine(fakeSequence([p2Only]), { reviewChunkChars: 1000 })
  const approveJob = approveEngine.start({ ...PR_INPUT, options: { depth: 'fast' } })
  await approveEngine.jobs.get(approveJob.jobId).done
  assert.equal(approveEngine.status(approveJob.jobId).verdict, 'approve')

  const p1Only = JSON.stringify({ findings: [{ severity: 'P1', file: 'src/a.ts', line: 2, title: '错误', why: 'w', fix: 'f' }] })
  const changesEngine = makeEngine(fakeSequence([p1Only]), { reviewChunkChars: 1000 })
  const changesJob = changesEngine.start({ ...PR_INPUT, options: { depth: 'fast' } })
  await changesEngine.jobs.get(changesJob.jobId).done
  assert.equal(changesEngine.status(changesJob.jobId).verdict, 'changes')
})

/** Deep-depth answer: one finding with evidence, one without. */
const DEEP_ANSWER = JSON.stringify({
  findings: [
    { severity: 'P1', file: 'src/a.ts', line: 2, title: '有证据', why: 'w', fix: 'f', evidence: '+added', confidence: 'high' },
    { severity: 'P2', file: 'src/a.ts', line: 9, title: '无证据', why: 'w', fix: 'f' },
  ],
})

test('deep review runs one verification round and drops findings without diff evidence (CONTRACT §4.6 #5)', async () => {
  const seam = fakeSequence([DEEP_ANSWER, '{"keep":[1]}'])
  const engine = makeEngine(seam, { reviewChunkChars: 1000 })
  const started = engine.start({ ...PR_INPUT, options: { depth: 'deep' } })
  await engine.jobs.get(started.jobId).done
  const status = engine.status(started.jobId)
  assert.equal(status.state, 'done')
  assert.equal(status.partial, false)
  assert.deepEqual(status.findings.map((finding) => finding.title), ['有证据'])
  assert.equal(status.findings[0].evidence, '+added')
  assert.equal(status.findings[0].confidence, 'high')
  assert.equal(status.verdict, 'changes')
  assert.equal(seam.requests.length, 2)
  assert.equal(seam.requests[1].system.includes('复核'), true)
  assert.equal(seam.requests[1].sessionId, started.jobId)
  const verificationPrompt = seam.requests[1].messages[0].content[0].text
  assert.ok(verificationPrompt.includes('[1] P1 · src/a.ts:2'))
  assert.ok(verificationPrompt.includes('[2] P2 · src/a.ts:9'))

  // An empty keep list drops every finding and approves.
  const emptySeam = fakeSequence([DEEP_ANSWER, '{"keep":[]}'])
  const emptyEngine = makeEngine(emptySeam, { reviewChunkChars: 1000 })
  const emptyJob = emptyEngine.start({ ...PR_INPUT, options: { depth: 'deep' } })
  await emptyEngine.jobs.get(emptyJob.jobId).done
  const emptyStatus = emptyEngine.status(emptyJob.jobId)
  assert.deepEqual(emptyStatus.findings, [])
  assert.equal(emptyStatus.verdict, 'approve')
  assert.equal(emptyStatus.partial, false)
})

test('a failed deep verification round keeps the original findings and marks the job partial', async () => {
  const failed = new Error('provider hiccup')
  failed.code = 'NO_ADAPTER'
  const seam = fakeSequence([DEEP_ANSWER, failed])
  const engine = makeEngine(seam, { reviewChunkChars: 1000 })
  const started = engine.start({ ...PR_INPUT, options: { depth: 'deep' } })
  await engine.jobs.get(started.jobId).done
  const status = engine.status(started.jobId)
  assert.equal(status.state, 'done')
  assert.equal(status.partial, true)
  assert.equal(status.findings.length, 2)
  assert.ok(status.partialReasons.some((reason) => reason.includes('复核轮失败')))

  const unparsable = fakeSequence([DEEP_ANSWER, '这不是 JSON'])
  const engine2 = makeEngine(unparsable, { reviewChunkChars: 1000 })
  const started2 = engine2.start({ ...PR_INPUT, options: { depth: 'deep' } })
  await engine2.jobs.get(started2.jobId).done
  const status2 = engine2.status(started2.jobId)
  assert.equal(status2.state, 'done')
  assert.equal(status2.partial, true)
  assert.equal(status2.findings.length, 2)
  assert.ok(status2.partialReasons.some((reason) => reason.includes('无法解析')))
})

test('guidelines are injected into every chunk prompt and reported in the status (CONTRACT §4.4)', async () => {
  const seam = fakeSequence([FINDINGS_ANSWER])
  const engine = makeEngine(seam, { reviewChunkChars: 1000 })
  const started = engine.start({
    ...PR_INPUT,
    options: { depth: 'fast', includeGuidelines: true },
    guidelines: { loaded: true, files: ['AGENTS.md'], chars: 9, text: '必须使用 X' },
  })
  await engine.jobs.get(started.jobId).done
  assert.ok(seam.requests[0].messages[0].content[0].text.includes('## 仓库审查指引'))
  assert.ok(seam.requests[0].messages[0].content[0].text.includes('必须使用 X'))
  const status = engine.status(started.jobId)
  assert.deepEqual(status.guidelines, { loaded: true, files: ['AGENTS.md'], chars: 9 })
  assert.deepEqual(status.options, {
    depth: 'fast',
    severityThreshold: 'P2',
    includeGuidelines: true,
    chunkChars: DEPTH_PRESETS.fast.chunkChars,
    maxChunks: DEPTH_PRESETS.fast.maxChunks,
    concurrency: DEPTH_PRESETS.fast.concurrency,
  })
  assert.equal(status.reusedFiles, 0)
  const snapshot = engine.existing('Acme/repo', 9, 'sha-1')
  assert.deepEqual(snapshot.guidelines, { loaded: true, files: ['AGENTS.md'], chars: 9 })
  assert.equal(snapshot.reusedFiles, 0)
  assert.equal(snapshot.verdict, 'changes')

  // Without guidelines the prompt has no guideline section and the status is empty.
  const plainSeam = fakeSequence([FINDINGS_ANSWER])
  const plainEngine = makeEngine(plainSeam, { reviewChunkChars: 1000 })
  const plainJob = plainEngine.start({ ...PR_INPUT, options: { depth: 'fast' } })
  await plainEngine.jobs.get(plainJob.jobId).done
  assert.equal(plainSeam.requests[0].messages[0].content[0].text.includes('## 仓库审查指引'), false)
  assert.deepEqual(plainEngine.status(plainJob.jobId).guidelines, { loaded: false, files: [], chars: 0 })

  // includeGuidelines:false wins even when the caller passed a guideline payload.
  const disabledSeam = fakeSequence([FINDINGS_ANSWER])
  const disabledEngine = makeEngine(disabledSeam, { reviewChunkChars: 1000 })
  const disabledJob = disabledEngine.start({
    ...PR_INPUT,
    options: { depth: 'fast', includeGuidelines: false },
    guidelines: { loaded: true, files: ['AGENTS.md'], chars: 9, text: '必须使用 X' },
  })
  await disabledEngine.jobs.get(disabledJob.jobId).done
  assert.equal(disabledSeam.requests[0].messages[0].content[0].text.includes('## 仓库审查指引'), false)
  assert.deepEqual(disabledEngine.status(disabledJob.jobId).guidelines, { loaded: false, files: [], chars: 0 })
})

test('invalidate drops the review jobs and file-cache entries of one merged PR', async () => {
  const seam = fakeSequence([twoFileAnswer()])
  const engine = makeEngine(seam, { reviewChunkChars: 100_000 })
  const first = engine.start({ ...PR_INPUT, files: TWO_FILES, options: { depth: 'fast' } })
  await engine.jobs.get(first.jobId).done
  // A second PR keeps its job and cache entries.
  const otherFiles = [makeFile('src/a.ts', '@@ -1 +1 @@\n+other')]
  const other = engine.start({ ...PR_INPUT, number: 10, files: otherFiles, options: { depth: 'fast' } })
  await engine.jobs.get(other.jobId).done
  assert.ok([...engine.fileCache.entries.keys()].some((key) => key.startsWith('github|Acme/repo#9|')))
  assert.ok([...engine.fileCache.entries.keys()].some((key) => key.startsWith('github|Acme/repo#10|')))
  engine.fileCache.set('gitlab|Acme/repo#9|src/a.ts|hash', [], Number.POSITIVE_INFINITY, 1)

  assert.equal(engine.invalidate('Acme/repo', 9), 1)
  assert.equal(engine.existing('Acme/repo', 9, 'sha-1').state, 'none')
  assert.equal(engine.status(other.jobId).state, 'done')
  const keys = [...engine.fileCache.entries.keys()]
  assert.equal(keys.some((key) => key.startsWith('github|Acme/repo#9|')), false)
  assert.ok(keys.some((key) => key.startsWith('github|Acme/repo#10|')))
  assert.ok(keys.includes('gitlab|Acme/repo#9|src/a.ts|hash'), 'other accounts keep their cache')
  assert.equal(engine.invalidate('Acme/repo', 999), 0)
  // A running job for the PR is cancelled and removed as well.
  const slow = new ReviewEngine({
    streamLlm: () => (async function* slowStream() {
      await new Promise((resolve) => setTimeout(resolve, 20))
      yield { type: 'text-delta', index: 0, text: twoFileAnswer() }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })(),
    resolveSelection: () => ({ provider: 'p', model: 'm' }),
    config: { reviewChunkChars: 1000 },
    sleep: async () => {},
  })
  const running = slow.start({ ...PR_INPUT, options: { depth: 'fast' } })
  assert.equal(slow.invalidate('Acme/repo', 9), 1)
  await running.done
  assert.throws(() => slow.status(running.jobId), (error) => error.code === 'BAD_REQUEST')
})

function resultPath(t) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-review-results-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return join(directory, 'results.json')
}

test('completed review survives engine reload and stays bound to its PR head', async t => {
  const statePath = resultPath(t)
  const { streamLlm } = fakeStream(FINDINGS_ANSWER)
  const options = { statePath, streamLlm, resolveSelection: () => ({ provider: 'p', model: 'm' }), sleep: async () => {} }
  const engine = new ReviewEngine(options)
  const started = engine.start(PR_INPUT)
  await engine.waitForCompletion(started.jobId)
  const before = engine.status(started.jobId)
  engine.dispose()
  const restored = new ReviewEngine(options)
  assert.deepEqual(restored.status(started.jobId), before)
  assert.equal(restored.existing(PR_INPUT.repo, PR_INPUT.number, PR_INPUT.headSha).state, 'done')
  assert.equal(restored.existing(PR_INPUT.repo, PR_INPUT.number, 'new-head').state, 'none')
  assert.equal(restored.start(PR_INPUT).cached, true)
  const saved = JSON.parse(readFileSync(statePath, 'utf8'))
  assert.equal('controller' in saved.jobs[0], false)
  assert.equal('done' in saved.jobs[0], false)
  assert.equal('guidelineText' in saved.jobs[0], false)
  restored.invalidate(PR_INPUT.repo, PR_INPUT.number)
  assert.equal(new ReviewEngine(options).existing(PR_INPUT.repo, PR_INPUT.number, PR_INPUT.headSha).state, 'none')
})

test('failed reviews survive reload and malformed files do not prevent startup', async t => {
  const statePath = resultPath(t)
  const engine = new ReviewEngine({
    statePath,
    streamLlm: () => { throw new Error('model unavailable') },
    resolveSelection: () => ({ provider: 'p', model: 'm' }),
    sleep: async () => {},
  })
  const started = engine.start(PR_INPUT)
  await engine.waitForCompletion(started.jobId)
  assert.equal(new ReviewEngine({ statePath }).status(started.jobId).state, 'error')
  writeFileSync(statePath, '{invalid json')
  assert.equal(new ReviewEngine({ statePath }).jobs.size, 0)
})

test('restoration skips interrupted and invalid jobs and respects maxJobs', async t => {
  const statePath = resultPath(t)
  const record = { id: 'one', repo: 'a/b', number: 1, headSha: 'sha', state: 'done', findings: [], options: resolveReviewOptions(), startedAt: 1, endedAt: 2 }
  writeFileSync(statePath, JSON.stringify({ version: 1, jobs: [
    { ...record, id: 'running', state: 'running' },
    { ...record, id: 'invalid', number: -1 },
    { ...record, id: 'one' },
    { ...record, id: 'two' },
  ] }))
  assert.deepEqual([...new ReviewEngine({ statePath }).jobs.keys()], ['one', 'two'])
  assert.deepEqual([...new ReviewEngine({ statePath, config: { maxJobs: 1 } }).jobs.keys()], ['two'])
})
