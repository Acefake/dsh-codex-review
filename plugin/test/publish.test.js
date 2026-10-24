/**
 * Unit tests for the publish-to-GitHub feature (CONTRACT §7): finding →
 * inline comment mapping, severity/max caps, marker dedupe, summary rendering,
 * the confirm/REVIEW_NOT_READY guards, one-publish-per-head records and error
 * mapping. Every GitHub terminal is fake; no real PR is ever published.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PUBLISH_COMMENT_MAX_CHARS,
  PUBLISH_DEFAULTS,
  PUBLISH_SUMMARY_MAX_CHARS,
  ReviewPublisher,
  buildInlineCommentBody,
  buildSummaryBody,
  filterPublishableFindings,
  parsePublishMarkers,
  preparePublish,
  publishFindingHash,
  publishMarker,
  sanitizePublishConfig,
} from '../lib/publish.js'
import { AppError } from '../lib/errors.js'

/** Findings used by most tests (P0 is the strongest, sorting puts it first). */
const FINDINGS = [
  { id: 'a1b2c3d4e5f6', severity: 'P2', file: 'src/b.ts', line: 9, title: '边界值', why: '空数组时越界', fix: '先判空' },
  { id: 'f6e5d4c3b2a1', severity: 'P0', file: 'src/a.ts', line: 3, title: '空指针', why: '为 null 时崩溃', fix: '加判空' },
  { id: '0f1e2d3c4b5a', severity: 'P1', file: 'src/a.ts', line: 5, title: '错误处理', why: '异常被吞', fix: '记录日志', evidence: '+throw', confidence: 'high' },
]

/** A completed review snapshot. */
const REVIEW = {
  state: 'done',
  headSha: 'head-1',
  overview: '共 3 个问题：P0 ×1 · P1 ×1 · P2 ×1',
  findings: FINDINGS,
  verdict: 'block',
}

/**
 * Build a store backed by a Map matching the auto-review adapter contract.
 * @param {Record<string, any>} [initial] - initial records.
 * @returns {{ map: Map<string, any>, get: Function, set: Function, writes: number }} store.
 */
function makeStore(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    map,
    writes: 0,
    get(key) {
      return map.get(key)
    },
    set(key, value) {
      map.set(key, value)
      this.writes += 1
    },
  }
}

/**
 * Build a publisher over fake terminals.
 * @param {{ review?: any, detail?: any, created?: any, existingComments?: any[], records?: Record<string, any>, pullError?: Error, commentsError?: Error, reviewError?: Error }} [options] - fixtures.
 * @returns {{ publisher: ReviewPublisher, engine: any, store: any, calls: any }} harness.
 */
function makePublisher(options = {}) {
  const calls = { pulls: [], commentReads: [], reviews: [] }
  const github = {
    async getPull(repo, number) {
      calls.pulls.push(`${repo}#${number}`)
      if (options.pullError !== undefined) throw options.pullError
      return options.detail ?? { headSha: REVIEW.headSha }
    },
    async listPullReviewComments(repo, number) {
      calls.commentReads.push(`${repo}#${number}`)
      if (options.commentsError !== undefined) throw options.commentsError
      return options.existingComments ?? []
    },
    async createPullReview(input) {
      calls.reviews.push(input)
      if (options.reviewError !== undefined) throw options.reviewError
      return options.created ?? { reviewId: 42, url: 'https://github.com/Acme/repo/pull/1#pullrequestreview-42' }
    },
  }
  const engine = {
    existing(repo, number, headSha) {
      if (options.review === undefined) return REVIEW
      return options.review
    },
  }
  const store = makeStore(options.records)
  const publisher = new ReviewPublisher({ github, engine, store, now: () => 1_234, logger: { warn() {} } })
  return { publisher, engine, store, calls, github }
}

/** One valid publish request. */
const PUBLISH_REQUEST = { repo: 'Acme/repo', number: 1, confirm: true, mode: 'inline', minSeverity: 'P2', maxComments: 20 }

test('sanitizePublishConfig clamps maxComments, validates enums and keeps live values for bad patches', () => {
  assert.deepEqual(sanitizePublishConfig(undefined), PUBLISH_DEFAULTS)
  assert.deepEqual(sanitizePublishConfig({ enabled: true, mode: 'both', minSeverity: 'P1', maxComments: 99 }), {
    enabled: true,
    mode: 'both',
    minSeverity: 'P1',
    maxComments: 50,
  })
  assert.equal(sanitizePublishConfig({ maxComments: 0 }).maxComments, 1)
  assert.equal(sanitizePublishConfig({ maxComments: 'abc' }).maxComments, 20)
  assert.equal(sanitizePublishConfig({ mode: 'nope' }).mode, 'inline')
  assert.equal(sanitizePublishConfig({ minSeverity: 'P9' }).minSeverity, 'P2')
  const kept = sanitizePublishConfig({ mode: 'nope', minSeverity: 'P9' }, { ...PUBLISH_DEFAULTS, mode: 'both', minSeverity: 'P1' })
  assert.equal(kept.mode, 'both')
  assert.equal(kept.minSeverity, 'P1')
})

test('finding hash, marker and marker parsing are stable', () => {
  const finding = FINDINGS[0]
  assert.equal(publishFindingHash(finding), finding.id)
  const derived = publishFindingHash({ file: 'src/a.ts', line: 3, title: '空指针' })
  assert.match(derived, /^[0-9a-f]{12}$/)
  assert.equal(publishMarker(derived), `<!-- dsh-codex-review:${derived} -->`)
  assert.equal(publishFindingHash({ file: '', line: 1, title: 'x' }), '')

  const comments = [
    { body: `**[P0] a**\n\n<!-- dsh-codex-review:${derived} -->` },
    { body: '普通评论，没有任何 marker' },
    { body: '<!-- dsh-codex-review:aaaaaaaaaaaa -->' },
    { body: '' },
    { body: undefined },
  ]
  const markers = parsePublishMarkers(comments)
  assert.deepEqual([...markers].sort(), [derived, 'aaaaaaaaaaaa'].sort())
  assert.equal(parsePublishMarkers(null).size, 0)
})

test('filterPublishableFindings filters by severity, sorts and caps', () => {
  const all = filterPublishableFindings(FINDINGS, { minSeverity: 'P2', maxComments: 20 })
  assert.deepEqual(all.selected.map((finding) => `${finding.severity}:${finding.file}:${finding.line}`), [
    'P0:src/a.ts:3',
    'P1:src/a.ts:5',
    'P2:src/b.ts:9',
  ])
  assert.equal(all.overLimit, 0)

  const strong = filterPublishableFindings(FINDINGS, { minSeverity: 'P0', maxComments: 20 })
  assert.deepEqual(strong.selected.map((finding) => finding.severity), ['P0'])
  const capped = filterPublishableFindings(FINDINGS, { minSeverity: 'P2', maxComments: 2 })
  assert.equal(capped.selected.length, 2)
  assert.equal(capped.overLimit, 1)

  const invalid = filterPublishableFindings([
    { severity: 'P9', file: 'a', line: 1, title: 'bad sev' },
    { severity: 'P1', file: '', line: 1, title: 'no file' },
    { severity: 'P1', file: 'a', line: 0, title: 'bad line' },
    null,
  ], { minSeverity: 'P2', maxComments: 5 })
  assert.equal(invalid.selected.length, 0)
})

test('buildInlineCommentBody renders severity/title/why/fix plus the marker and never exceeds 2000 chars', () => {
  const body = buildInlineCommentBody(FINDINGS[1])
  assert.ok(body.startsWith('**[P0] 空指针**'))
  assert.ok(body.includes('为什么：为 null 时崩溃'))
  assert.ok(body.includes('建议：加判空'))
  assert.ok(body.endsWith(publishMarker(FINDINGS[1].id)))

  const huge = buildInlineCommentBody({ id: 'abcdef123456', severity: 'P1', file: 'a', line: 1, title: 't'.repeat(500), why: 'w'.repeat(5000), fix: 'f'.repeat(5000) })
  assert.ok(huge.length <= PUBLISH_COMMENT_MAX_CHARS)
  assert.ok(huge.endsWith(publishMarker('abcdef123456')))

  const minimal = buildInlineCommentBody({ id: 'abcdef123456', severity: 'P2', file: 'a', line: 1, title: '', why: '', fix: '' })
  assert.ok(minimal.startsWith('**[P2] （未命名问题）**'))
  assert.ok(minimal.endsWith(publishMarker('abcdef123456')))
})

test('buildSummaryBody renders the deterministic header/list, honours custom bodies and truncates', () => {
  const body = buildSummaryBody({ overview: REVIEW.overview, findings: FINDINGS })
  assert.ok(body.startsWith('**代码审查（dsh-codex-review）**'))
  assert.ok(body.includes(REVIEW.overview))
  assert.ok(body.includes('- [P0] src/a.ts:3 空指针'))
  assert.ok(body.includes('- [P2] src/b.ts:9 边界值'))

  assert.equal(buildSummaryBody({ overview: 'x', findings: FINDINGS, customBody: '  自定义正文  ' }), '自定义正文')
  assert.equal(buildSummaryBody({ findings: [], customBody: '' }).includes('AI 未发现明显问题'), true)
  const long = buildSummaryBody({ overview: 'x'.repeat(5000), findings: [] })
  assert.ok(long.length <= PUBLISH_SUMMARY_MAX_CHARS)
})

test('preparePublish builds inline comments, dedupes markers and falls back to a summary', () => {
  const prepared = preparePublish({ findings: FINDINGS, mode: 'inline', minSeverity: 'P2', maxComments: 20 })
  assert.equal(prepared.inlineComments.length, 3)
  assert.deepEqual(prepared.inlineComments[0], {
    path: 'src/a.ts',
    line: 3,
    side: 'RIGHT',
    body: buildInlineCommentBody(FINDINGS[1]),
  })
  assert.equal(prepared.summaryBody, undefined)

  const deduped = preparePublish({
    findings: FINDINGS,
    mode: 'inline',
    minSeverity: 'P2',
    maxComments: 20,
    existingMarkers: new Set([FINDINGS[1].id]),
  })
  assert.equal(deduped.inlineComments.length, 2)
  assert.equal(deduped.skipped, 1)
  assert.equal(deduped.deduped, 1)

  // Inline mode with nothing anchorable falls back to a summary review.
  const empty = preparePublish({ findings: FINDINGS, mode: 'inline', minSeverity: 'P0', maxComments: 20, existingMarkers: new Set([FINDINGS[1].id]) })
  assert.equal(empty.inlineComments.length, 0)
  assert.ok(empty.summaryBody.includes('**代码审查（dsh-codex-review）**'))

  const summary = preparePublish({ findings: FINDINGS, mode: 'summary', minSeverity: 'P2', maxComments: 20 })
  assert.equal(summary.inlineComments.length, 0)
  assert.ok(summary.summaryBody.includes('- [P1] src/a.ts:5 错误处理'))

  const both = preparePublish({ findings: FINDINGS, mode: 'both', minSeverity: 'P2', maxComments: 20 })
  assert.equal(both.inlineComments.length, 3)
  assert.ok(both.summaryBody.includes('**代码审查（dsh-codex-review）**'))
})

test('publish requires confirm, validates the mode/severity/body before touching GitHub', async () => {
  const harness = makePublisher()
  await assert.rejects(harness.publisher.publish({ ...PUBLISH_REQUEST, confirm: false }), (error) => error.code === 'BAD_REQUEST')
  await assert.rejects(harness.publisher.publish({ ...PUBLISH_REQUEST, mode: 'nope' }), (error) => error.code === 'BAD_REQUEST')
  await assert.rejects(harness.publisher.publish({ ...PUBLISH_REQUEST, minSeverity: 'P9' }), (error) => error.code === 'BAD_REQUEST')
  await assert.rejects(harness.publisher.publish({ ...PUBLISH_REQUEST, body: 'x'.repeat(PUBLISH_SUMMARY_MAX_CHARS + 1) }), (error) => error.code === 'BAD_REQUEST')
  await assert.rejects(harness.publisher.publish({ ...PUBLISH_REQUEST, repo: 'nope' }), (error) => error.code === 'BAD_REQUEST')
  assert.equal(harness.calls.pulls.length, 0)
  assert.equal(harness.calls.reviews.length, 0)
})

test('publish refuses when the current head has no completed review (REVIEW_NOT_READY)', async () => {
  for (const review of [null, { state: 'none', findings: [] }, { state: 'running', findings: [] }, { state: 'error', findings: [] }]) {
    const harness = makePublisher({ review })
    await assert.rejects(harness.publisher.publish(PUBLISH_REQUEST), (error) => error.code === 'REVIEW_NOT_READY')
    assert.equal(harness.calls.reviews.length, 0)
  }
  const notFound = makePublisher({ detail: { headSha: '' } })
  await assert.rejects(notFound.publisher.publish(PUBLISH_REQUEST), (error) => error.code === 'GH_NOT_FOUND')
})

test('publish posts one PR review with inline comments and persists the record', async () => {
  const harness = makePublisher()
  const result = await harness.publisher.publish(PUBLISH_REQUEST)
  assert.deepEqual(result, {
    published: true,
    reviewId: 42,
    url: 'https://github.com/Acme/repo/pull/1#pullrequestreview-42',
    comments: 3,
    skipped: 0,
    headSha: 'head-1',
  })
  assert.deepEqual(harness.calls.pulls, ['Acme/repo#1'])
  assert.deepEqual(harness.calls.commentReads, ['Acme/repo#1'])
  assert.equal(harness.calls.reviews.length, 1)
  const request = harness.calls.reviews[0]
  assert.equal(request.repo, 'Acme/repo')
  assert.equal(request.number, 1)
  assert.equal(request.headSha, 'head-1')
  assert.equal(request.body, undefined)
  assert.equal(request.comments.length, 3)
  assert.equal(request.comments[0].side, 'RIGHT')
  assert.ok(request.comments[0].body.includes(publishMarker(FINDINGS[1].id)))
  assert.deepEqual(harness.store.get('Acme/repo#1@head-1'), {
    publishedAt: 1234,
    reviewId: 42,
    url: 'https://github.com/Acme/repo/pull/1#pullrequestreview-42',
  })
})

test('publish applies minSeverity/maxComments and marker dedupe from existing comments', async () => {
  const harness = makePublisher({
    existingComments: [
      { body: `**[P0] 空指针**\n\n${publishMarker(FINDINGS[1].id)}` },
    ],
  })
  // P1+P2 filter keeps P0/P1; the two-comment cap then keeps P0, and the P0
  // marker dedupes it → one inline comment (one finding skipped by the marker).
  const result = await harness.publisher.publish({ ...PUBLISH_REQUEST, minSeverity: 'P1', maxComments: 2 })
  assert.equal(result.comments, 1)
  assert.equal(result.skipped, 1)
  const paths = harness.calls.reviews[0].comments.map((comment) => `${comment.path}:${comment.line}`)
  assert.deepEqual(paths, ['src/a.ts:5'])
})

test('a published head is idempotent: repeat returns the stored record with no GitHub write', async () => {
  const harness = makePublisher()
  const first = await harness.publisher.publish(PUBLISH_REQUEST)
  const record = harness.store.get('Acme/repo#1@head-1')
  const second = await harness.publisher.publish(PUBLISH_REQUEST)
  assert.deepEqual(second, {
    published: true,
    reviewId: record.reviewId,
    url: record.url,
    comments: 0,
    skipped: 3,
    headSha: 'head-1',
  })
  assert.equal(harness.calls.reviews.length, 1)
  // The replay does not even read GitHub comments again.
  assert.equal(harness.calls.commentReads.length, 1)
})

test('a new head publishes again (record is keyed by repo#number@headSha)', async () => {
  const harness = makePublisher()
  await harness.publisher.publish(PUBLISH_REQUEST)
  harness.engine.existing = () => ({ ...REVIEW, headSha: 'head-2', findings: FINDINGS })
  // The fake git client still reports head-1; simulate a moved head.
  const publisher2 = new ReviewPublisher({
    github: {
      async getPull() {
        return { headSha: 'head-2' }
      },
      async listPullReviewComments() {
        return []
      },
      async createPullReview() {
        return { reviewId: 43, url: 'https://github.com/Acme/repo/pull/1#pullrequestreview-43' }
      },
    },
    engine: { existing: () => ({ ...REVIEW, headSha: 'head-2' }) },
    store: harness.store,
    now: () => 2_000,
  })
  const result = await publisher2.publish(PUBLISH_REQUEST)
  assert.equal(result.reviewId, 43)
  assert.ok(harness.store.get('Acme/repo#1@head-2') !== undefined)
})

test('summary and both modes publish the expected body shape', async () => {
  const summary = makePublisher()
  const summaryResult = await summary.publisher.publish({ ...PUBLISH_REQUEST, mode: 'summary' })
  assert.equal(summaryResult.comments, 0)
  const summaryReview = summary.calls.reviews[0]
  assert.equal(summaryReview.comments, undefined)
  assert.ok(summaryReview.body.includes('**代码审查（dsh-codex-review）**'))
  assert.ok(summaryReview.body.includes('- [P0] src/a.ts:3 空指针'))

  const both = makePublisher()
  await both.publisher.publish({ ...PUBLISH_REQUEST, mode: 'both', body: '自定义摘要' })
  const bothReview = both.calls.reviews[0]
  assert.equal(bothReview.body, '自定义摘要')
  assert.equal(bothReview.comments.length, 3)

  const fallback = makePublisher()
  await fallback.publisher.publish({ ...PUBLISH_REQUEST, mode: 'inline', minSeverity: 'P0', maxComments: 20 })
  const fallbackReview = fallback.calls.reviews[0]
  assert.equal(fallbackReview.comments.length, 1)
  assert.equal(fallbackReview.body, undefined)
})

test('publish propagates GitHub failures untouched and persists nothing', async () => {
  for (const code of ['GH_FORBIDDEN', 'GH_NOT_FOUND', 'GH_RATE_LIMIT', 'GH_NETWORK']) {
    const harness = makePublisher({ reviewError: new AppError(code) })
    await assert.rejects(harness.publisher.publish(PUBLISH_REQUEST), (error) => error.code === code)
    assert.equal(harness.store.writes, 0)
  }
  const readFailure = makePublisher({ commentsError: new AppError('GH_NETWORK') })
  await assert.rejects(readFailure.publisher.publish(PUBLISH_REQUEST), (error) => error.code === 'GH_NETWORK')
  assert.equal(readFailure.calls.reviews.length, 0)
})

test('concurrent publishes of the same head collapse into one GitHub review', async () => {
  const harness = makePublisher()
  // A slow create call keeps the first publish in flight long enough for the
  // second one to arrive (a real double click looks exactly like this).
  const created = harness.calls.reviews
  harness.github.createPullReview = async (input) => {
    created.push(input)
    await new Promise((resolve) => setTimeout(resolve, 20))
    return { reviewId: 42, url: 'https://github.com/Acme/repo/pull/1#pullrequestreview-42' }
  }

  const [first, second] = await Promise.all([
    harness.publisher.publish(PUBLISH_REQUEST),
    harness.publisher.publish(PUBLISH_REQUEST),
  ])

  assert.equal(harness.calls.reviews.length, 1, 'a double click must create exactly one review')
  assert.deepEqual(first, second)
  assert.equal(harness.store.writes, 1)
  assert.equal(harness.publisher.inflight.size, 0, 'the in-flight guard must be released')
})
