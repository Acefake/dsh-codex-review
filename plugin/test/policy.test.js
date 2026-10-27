/** Review-policy prompt and auto-review filtering tests. */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  AUTO_REVIEW_DEFAULTS,
  filterAutoFindings,
  findingFingerprint,
  sanitizeAutoReviewConfig,
  sanitizeReviewedMap,
} from '../lib/auto-review.js'
import { REVIEW_POLICY_TEXT, buildUserPrompt } from '../lib/review.js'

const finding = (patch = {}) => ({
  severity: 'P1',
  file: 'plugin/index.js',
  line: 10,
  title: 'same title',
  confidence: 'high',
  ...patch,
})

test('the bundled policy is embedded in every review prompt', () => {
  const prompt = buildUserPrompt({
    pr: { repo: 'a/b', number: 1, title: 't' },
    chunk: { files: [{ path: 'x.js', patch: '@@ -1 +1 @@\n+a' }] },
    chunkIndex: 0,
    chunkCount: 1,
  })
  assert.ok(REVIEW_POLICY_TEXT.length > 0)
  assert.ok(prompt.includes('固定审查策略'))
  assert.ok(prompt.includes('GitLab 项目路径必须是'))
})

test('sanitizeAutoReviewConfig normalizes the filtering knobs', () => {
  const config = sanitizeAutoReviewConfig({
    onlySeverities: ['P0', 'bad', 'P0', 'P1'],
    maxFindingsPerRound: 99,
    stopOnLowConfidence: false,
  })
  assert.deepEqual(config.onlySeverities, ['P0', 'P1'])
  assert.equal(config.maxFindingsPerRound, 20)
  assert.equal(config.stopOnLowConfidence, false)
  assert.deepEqual(AUTO_REVIEW_DEFAULTS.onlySeverities, ['P0', 'P1', 'P2'])
})

test('filterAutoFindings applies severity, confidence, dedup and cap', () => {
  const rows = [
    finding({ severity: 'P0', line: 1, confidence: 'high' }),
    finding({ severity: 'P2', line: 2, confidence: 'high' }),
    finding({ severity: 'P1', line: 3, confidence: 'low' }),
    finding({ severity: 'P1', line: 1, confidence: 'high' }), // duplicate of the P0 by severity differs → not duplicate
  ]
  const first = filterAutoFindings(rows, {
    onlySeverities: ['P0', 'P1'],
    maxFindingsPerRound: 1,
    stopOnLowConfidence: true,
  }, {}, 'a/b#1', 1000)
  assert.equal(first.selected.length, 1)
  assert.equal(first.selected[0].severity, 'P0')
  assert.equal(first.suppressed, 3)
  const key = `a/b#1|${findingFingerprint(rows[0])}`
  assert.equal(first.reviewed[key], 1000)

  const second = filterAutoFindings(rows, {
    onlySeverities: ['P0', 'P1', 'P2'],
    maxFindingsPerRound: 10,
    stopOnLowConfidence: false,
  }, first.reviewed, 'a/b#1', 2000)
  assert.equal(second.selected.some((row) => row.severity === 'P0'), false, 'the emitted fingerprint is not repeated')
  assert.equal(second.selected.some((row) => row.severity === 'P1' && row.confidence === 'low'), true)
})

test('sanitizeReviewedMap keeps the newest bounded fingerprints', () => {
  const reviewed = sanitizeReviewedMap({ a: 1, b: 3, c: 2, bad: 'x' }, 2)
  assert.deepEqual(reviewed, { b: 3, c: 2 })
})
