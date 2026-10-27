/** Unit tests for the multi-account store helpers. */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  accountTokenInput,
  makeAccountId,
  normalizeAccountInput,
} from '../lib/accounts.js'
import { buildReviewJobKey, fileCacheKey } from '../lib/review.js'
import { publishRecordKeys } from '../lib/publish.js'

test('account-scoped cache and publish keys differ from legacy keys', () => {
  const options = { depth: 'standard', severityThreshold: 'P1', includeGuidelines: true }
  assert.notEqual(buildReviewJobKey('a/b', 1, 'sha', options, 'github'), buildReviewJobKey('a/b', 1, 'sha', options))
  assert.notEqual(fileCacheKey('a/b', 1, 'x.js', 'patch', 'github'), fileCacheKey('a/b', 1, 'x.js', 'patch'))
  assert.deepEqual(publishRecordKeys('', 'a/b', 1, 'sha'), { prKey: 'a/b#1', headKey: 'a/b#1@sha' })
  assert.deepEqual(publishRecordKeys(' github ', 'a/b', 1, 'sha'), { prKey: 'github|a/b#1', headKey: 'github|a/b#1@sha' })
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

test('makeAccountId slugifies labels and avoids collisions', () => {
  assert.equal(makeAccountId('gitlab', 'Work GitLab', []), 'gitlab-work-gitlab')
  assert.equal(makeAccountId('gitlab', 'Work GitLab', [{ id: 'gitlab-work-gitlab' }]), 'gitlab-work-gitlab-2')
  assert.equal(makeAccountId('github', '!!!', []), 'github-account')
})
