/**
 * Multi-account routing, capability flags and route guards. Both the GitHub and
 * GitLab clients are injected fakes; no network is used.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { PROVIDER_LABELS, createRoutes, providerCapabilities } from '../index.js'
import { resolveConfig } from '../lib/config.js'

/** Minimal GitHub client double. */
function fakeGithubClient() {
  return {
    ghStatus: async () => 'ok',
    listPullRequests: async () => ({ query: '', totalCount: 1, items: [{ repo: 'github/only', number: 1 }] }),
    getPull: async () => ({ headSha: 'gh1', summary: {}, files: [] }),
    getPullHead: async () => 'gh1',
    getAuthenticatedUser: async () => 'Acefake',
    mergePull: async () => ({ merged: true }),
    createIssueComment: async () => ({ id: 1 }),
    replyToReviewComment: async () => ({ id: 1 }),
    resolveReviewThread: async () => ({ resolved: true }),
  }
}

/** Minimal read-only GitLab client double. */
function fakeGitlabClient() {
  return {
    status: async () => ({ ok: true, provider: 'gitlab', viewer: 'shims' }),
    listPullRequests: async () => ({ query: '', totalCount: 1, items: [{ repo: 'mdesign/m-design-client', number: 7 }] }),
    getPull: async () => ({ headSha: 'gl1', summary: {}, files: [] }),
    getPullHead: async () => 'gl1',
    getAuthenticatedUser: async () => 'shims',
  }
}

/** Build routes with both accounts present and an inert engine/reviewer/publisher. */
function buildRoutes(defaultAccount = 'gitlab') {
  const github = fakeGithubClient()
  const clients = { github, gitlab: fakeGitlabClient() }
  const reviewer = {
    status: () => ({ config: { publish: { enabled: false } }, publish: { enabled: false }, recent: [] }),
    updateConfig: () => ({ config: { publish: { enabled: false } }, publish: { enabled: false }, recent: [] }),
    runOnce: async () => ({ config: { publish: { enabled: false } }, publish: { enabled: false }, recent: [] }),
    getPublished: () => undefined,
    dispose: () => {},
  }
  const config = resolveConfig({
    dataSource: defaultAccount,
    gitlabBaseUrl: 'http://gitlab.local:8090',
    gitlabToken: 'token',
    viewerLogin: 'shims',
  })
  return createRoutes({
    config,
    clients,
    defaultAccount,
    github,
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
    version: '0.13.0',
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

test('health lists both accounts and marks the default one', async () => {
  const routes = buildRoutes('gitlab')
  const health = await routes['/codex-review/health']()
  assert.equal(health.provider, 'gitlab')
  assert.equal(health.defaultAccount, 'gitlab')
  assert.equal(health.viewer, 'shims')
  assert.equal(health.capabilities.merge, false)
  assert.deepEqual(health.labels, PROVIDER_LABELS.gitlab)
  assert.equal(health.accounts.length, 2)
  const github = health.accounts.find((entry) => entry.id === 'github')
  const gitlab = health.accounts.find((entry) => entry.id === 'gitlab')
  assert.equal(github.viewer, 'Acefake')
  assert.equal(github.capabilities.merge, true)
  assert.equal(gitlab.viewer, 'shims')
  assert.equal(gitlab.capabilities.merge, false)
})

test('health keeps the GitHub gh tri-state when GitHub is the default', async () => {
  const routes = buildRoutes('github')
  const health = await routes['/codex-review/health']()
  assert.equal(health.provider, 'github')
  assert.equal(health.gh, 'ok')
  assert.equal(health.capabilities.merge, true)
  assert.equal(health.accounts.length, 2)
})

test('prs routes each account to its own client', async () => {
  const routes = buildRoutes('gitlab')
  const gitlab = await routes['/codex-review/prs']({})
  assert.equal(gitlab.items[0].repo, 'mdesign/m-design-client')
  const github = await routes['/codex-review/prs']({ account: 'github' })
  assert.equal(github.items[0].repo, 'github/only')
  await assert.rejects(
    () => routes['/codex-review/prs']({ account: 'nope' }),
    (error) => error.code === 'BAD_REQUEST',
  )
})

test('write routes follow the selected account capabilities', async () => {
  const routes = buildRoutes('gitlab')
  const gitlabPayload = { repo: 'mdesign/m-design-client', number: 7, confirm: true }
  for (const path of ['/codex-review/merge', '/codex-review/review-publish', '/codex-review/comment']) {
    await assert.rejects(
      () => routes[path](gitlabPayload, { signal: undefined }),
      (error) => error.code === 'PROVIDER_UNSUPPORTED',
      `${path} must be rejected for the GitLab account`,
    )
  }
  const merged = await routes['/codex-review/merge']({
    account: 'github',
    repo: 'Acefake/yingbox',
    number: 1,
    confirm: true,
    method: 'squash',
    expectedHeadSha: 'a'.repeat(40),
  })
  assert.equal(merged.merged, true)
})

test('auto-review routes stay available because they are GitHub-backed', async () => {
  const routes = buildRoutes('gitlab')
  const status = await routes['/codex-review/auto-review-config']({ patch: { enabled: false } })
  assert.equal(status.config.publish.enabled, false)
  const run = await routes['/codex-review/auto-review-run']({ force: true })
  assert.equal(run.config.publish.enabled, false)
})

test('repo validation follows the selected account provider', async () => {
  const routes = buildRoutes('gitlab')
  await assert.rejects(
    () => routes['/codex-review/pr']({ repo: 'mdesign/../secret', number: 1 }),
    (error) => error.code === 'BAD_REQUEST',
  )
  await assert.rejects(
    () => routes['/codex-review/pr']({ account: 'github', repo: 'a/b/c', number: 1 }),
    (error) => error.code === 'BAD_REQUEST',
  )
  const answer = await routes['/codex-review/pr']({ repo: 'mdesign/beijing/graphics-library-v2', number: 1 })
  assert.equal(answer.summary !== undefined, true)
})
