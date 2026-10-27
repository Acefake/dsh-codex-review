/** Unit tests for the multi-account store helpers. */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  accountTokenInput,
  makeAccountId,
  normalizeAccountInput,
} from '../lib/accounts.js'
import { buildReviewJobKey, fileCacheKey, ReviewEngine } from '../lib/review.js'
import { publishRecordKeys } from '../lib/publish.js'

test('account-scoped cache and publish keys differ from legacy keys', () => {
  const options = { depth: 'standard', severityThreshold: 'P1', includeGuidelines: true }
  assert.equal(buildReviewJobKey('a/b', 1, 'sha', options, 'github'), buildReviewJobKey('a/b', 1, 'sha', options))
  assert.notEqual(buildReviewJobKey('a/b', 1, 'sha', options, 'gitlab'), buildReviewJobKey('a/b', 1, 'sha', options))
  assert.equal(fileCacheKey('a/b', 1, 'x.js', 'patch', 'github'), fileCacheKey('a/b', 1, 'x.js', 'patch'))
  assert.notEqual(fileCacheKey('a/b', 1, 'x.js', 'patch', 'gitlab'), fileCacheKey('a/b', 1, 'x.js', 'patch'))
  assert.deepEqual(publishRecordKeys('', 'a/b', 1, 'sha'), { prKey: 'a/b#1', headKey: 'a/b#1@sha' })
  assert.deepEqual(publishRecordKeys('github', 'a/b', 1, 'sha'), { prKey: 'a/b#1', headKey: 'a/b#1@sha' })
  assert.deepEqual(publishRecordKeys('work', 'a/b', 1, 'sha'), { prKey: 'work|a/b#1', headKey: 'work|a/b#1@sha' })
  assert.deepEqual(
    buildReviewJobKey('a/b', 1, 'sha', options),
    'a/b#1@sha|standard|P1|1',
    'the default key keeps the legacy format',
  )
})

test('normalizeAccountInput validates type and GitLab fields without returning the token', () => {
  const gitlab = normalizeAccountInput({
    type: 'gitlab',
    label: ' Work ',
    baseUrl: 'http://gitlab.example.com:8090/',
    username: ' shims ',
    token: ' tok ',
  })
  assert.deepEqual(gitlab, {
    type: 'gitlab',
    label: 'Work',
    baseUrl: 'http://gitlab.example.com:8090',
    username: 'shims',
  })
  assert.equal(accountTokenInput({ token: ' tok ' }), 'tok')
  assert.throws(() => normalizeAccountInput({ type: 'gitee' }), (error) => error.code === 'BAD_REQUEST')
  assert.throws(() => normalizeAccountInput({ type: 'gitlab', baseUrl: 'gitlab.local:8090', token: 't' }), (error) => error.code === 'BAD_REQUEST')
  assert.throws(() => normalizeAccountInput({ type: 'gitlab', baseUrl: 'http://g', token: '' }), (error) => error.code === 'BAD_REQUEST')
  const github = normalizeAccountInput({ type: 'github', label: '' })
  assert.equal(github.type, 'github')
  assert.equal(github.label, 'GitHub')
  assert.equal(github.baseUrl, '')
  assert.equal('token' in github, false)
})

test('invalidate clears only the selected account jobs and file cache', () => {
  const engine = new ReviewEngine({})
  engine.jobs.set('gh', { id: 'gh', repo: 'r/x', number: 1, headSha: 's', account: '', state: 'done' })
  engine.jobs.set('gl', { id: 'gl', repo: 'r/x', number: 1, headSha: 's', account: 'gitlab', state: 'done' })
  const ghKey = fileCacheKey('r/x', 1, 'f', 'h', 'github')
  const glKey = fileCacheKey('r/x', 1, 'f', 'h', 'gitlab')
  const legacyKey = fileCacheKey('r/x', 1, 'f', 'h')
  engine.fileCache.set(ghKey, [], Number.POSITIVE_INFINITY, 1)
  engine.fileCache.set(glKey, [], Number.POSITIVE_INFINITY, 1)
  engine.fileCache.set(legacyKey, [], Number.POSITIVE_INFINITY, 1)
  engine.invalidate('r/x', 1, 'github')
  assert.equal(engine.jobs.has('gh'), false)
  assert.equal(engine.jobs.has('gl'), true)
  const keys = [...engine.fileCache.entries.keys()]
  assert.equal(keys.includes(ghKey), false)
  assert.equal(keys.includes(legacyKey), false)
  assert.equal(keys.includes(glKey), true)
  engine.invalidate('r/x', 1, 'gitlab')
  assert.equal(engine.jobs.has('gl'), false)
})


test('makeAccountId slugifies labels and avoids collisions', () => {
  assert.equal(makeAccountId('gitlab', 'Work GitLab', []), 'gitlab-work-gitlab')
  assert.equal(makeAccountId('gitlab', 'Work GitLab', [{ id: 'gitlab-work-gitlab' }]), 'gitlab-work-gitlab-2')
  assert.equal(makeAccountId('github', '!!!', []), 'github-account')
})
