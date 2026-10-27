/**
 * Provider selection, capability flags and route guards for the GitLab
 * read-only data source. No network: both clients are injected fakes.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { PROVIDER_LABELS, createRoutes, providerCapabilities } from '../index.js'
import { resolveConfig } from '../lib/config.js'

/** Minimal read-only GitLab client double. */
function fakeGitlabClient() {
  return {
    status: async () => ({ ok: true, provider: 'gitlab', viewer: 'shims' }),
    listPullRequests: async () => ({ query: '', totalCount: 0, items: [] }),
    getPull: async () => ({ summary: {}, files: [] }),
    getPullHead: async () => '',
    getAuthenticatedUser: async () => 'shims',
  }
}

/** Minimal GitHub client double whose gh CLI is not installed. */
function fakeGithubClient() {
  return {
    ghStatus: async () => 'missing',
    listPullRequests: async () => ({ query: '', totalCount: 0, items: [] }),
    getPull: async () => ({ summary: {}, files: [] }),
    getPullHead: async () => '',
    getAuthenticatedUser: async () => '',
  }
}

/** Build routes for one data source with inert engine/reviewer/publisher doubles. */
function buildRoutes(dataSource) {
  const reviewer = {
    status: () => ({ config: { publish: { enabled: false } }, publish: { enabled: false }, recent: [] }),
    updateConfig: () => ({ config: { publish: { enabled: false } }, publish: { enabled: false }, recent: [] }),
    getPublished: () => undefined,
    dispose: () => {},
  }
  const config = resolveConfig({
    dataSource,
    gitlabBaseUrl: dataSource === 'gitlab' ? 'http://gitlab.local:8090' : '',
    gitlabToken: dataSource === 'gitlab' ? 'token' : '',
    viewerLogin: dataSource === 'gitlab' ? 'shims' : '',
  })
  return createRoutes({
    config,
    github: dataSource === 'gitlab' ? fakeGitlabClient() : fakeGithubClient(),
    engine: {
      available: () => false,
      status: () => ({ state: 'none' }),
      existing: () => ({ state: 'none', headSha: '', findings: [] }),
      start: () => { throw new Error('review must not start in this test') },
      cancel: () => false,
      invalidate: () => {},
      dispose: () => {},
    },
    reviewer,
    publisher: {
      publish: async () => { throw new Error('publish must not run in this test') },
      dispose: () => {},
    },
    logger: { warn: () => {} },
    llmAvailable: () => false,
    llmInfo: async () => ({}),
    version: '0.12.0',
  })
}

test('providerCapabilities keeps write operations on GitHub only', () => {
  const github = providerCapabilities('github')
  const gitlab = providerCapabilities('gitlab')
  assert.equal(github.merge, true)
  assert.equal(github.publish, true)
  assert.equal(github.autoReview, true)
  assert.equal(gitlab.merge, false)
  assert.equal(gitlab.publish, false)
  assert.equal(gitlab.comment, false)
  assert.equal(gitlab.reply, false)
  assert.equal(gitlab.resolve, false)
  assert.equal(gitlab.autoReview, false)
  assert.equal(gitlab.browse, true)
  assert.equal(gitlab.review, true)
  assert.equal(gitlab.chat, true)
})

test('GitLab health reports provider, viewer, capabilities and labels', async () => {
  const routes = buildRoutes('gitlab')
  const health = await routes['/codex-review/health']()
  assert.equal(health.provider, 'gitlab')
  assert.equal(health.ok, true)
  assert.equal(health.viewer, 'shims')
  assert.equal(health.capabilities.merge, false)
  assert.equal(health.capabilities.browse, true)
  assert.deepEqual(health.labels, PROVIDER_LABELS.gitlab)
  assert.equal(health.gh, undefined)
})

test('GitHub health keeps the gh missing/not-logged-in/ok tri-state', async () => {
  const routes = buildRoutes('github')
  const health = await routes['/codex-review/health']()
  assert.equal(health.provider, 'github')
  assert.equal(health.gh, 'missing')
  assert.equal(health.ok, false)
  assert.equal(health.capabilities.merge, true)
})

test('GitLab write routes reject with PROVIDER_UNSUPPORTED', async () => {
  const routes = buildRoutes('gitlab')
  const calls = [
    ['/codex-review/merge', { repo: 'mdesign/m-design-client', number: 1, confirm: true }],
    ['/codex-review/review-publish', { repo: 'mdesign/m-design-client', number: 1, confirm: true }],
    ['/codex-review/comment', { repo: 'mdesign/m-design-client', number: 1, confirm: true, body: 'x' }],
    ['/codex-review/reply', { repo: 'mdesign/m-design-client', number: 1, confirm: true, commentId: 1, body: 'x' }],
    ['/codex-review/resolve', { repo: 'mdesign/m-design-client', number: 1, confirm: true, threadId: 't' }],
  ]
  for (const [path, payload] of calls) {
    await assert.rejects(
      () => routes[path](payload, { signal: undefined }),
      (error) => error.code === 'PROVIDER_UNSUPPORTED',
      `${path} must be rejected for GitLab`,
    )
  }
})

test('GitLab auto-review routes reject with PROVIDER_UNSUPPORTED', async () => {
  const routes = buildRoutes('gitlab')
  await assert.rejects(
    () => routes['/codex-review/auto-review-config']({ patch: { enabled: true } }),
    (error) => error.code === 'PROVIDER_UNSUPPORTED',
  )
  await assert.rejects(
    () => routes['/codex-review/auto-review-run']({ force: true }),
    (error) => error.code === 'PROVIDER_UNSUPPORTED',
  )
})

test('GitLab repo paths allow nested groups but reject dot segments', async () => {
  const routes = buildRoutes('gitlab')
  await assert.rejects(
    () => routes['/codex-review/pr']({ repo: 'mdesign/../secret', number: 1 }),
    (error) => error.code === 'BAD_REQUEST',
  )
  const answer = await routes['/codex-review/pr']({ repo: 'mdesign/beijing/graphics-library-v2', number: 1 })
  assert.equal(answer.summary !== undefined, true)
})
