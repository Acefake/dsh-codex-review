/**
 * Multi-account routing, capability flags and route guards. Both the GitHub and
 * GitLab clients are injected fakes; no network is used.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { PROVIDER_LABELS, buildClients, createRoutes, providerCapabilities } from '../index.js'
import { buildReviewJobKey, fileCacheKey } from '../lib/review.js'
import { ReviewPublisher } from '../lib/publish.js'
import { resolveConfig } from '../lib/config.js'

/** Minimal GitHub client double; `mergePull` enforces the expected head like the real client. */
function fakeGithubClient(options = {}) {
  const calls = { list: [], merge: [], comments: [], replies: [], resolves: [], pulls: [] }
  return {
    calls,
    ghStatus: async () => options.ghStatus ?? 'ok',
    listPullRequests: async () => {
      calls.list.push(1)
      return { query: '', totalCount: 1, items: [{ repo: options.listRepo ?? 'github/primary', number: 1 }] }
    },
    getPull: async () => {
      calls.pulls.push(1)
      return { headSha: options.headSha ?? 'gh1', summary: { repo: options.listRepo ?? 'github/primary' }, files: [] }
    },
    getPullHead: async () => 'gh1',
    getAuthenticatedUser: async () => {
      if ((options.ghStatus ?? 'ok') !== 'ok') throw Object.assign(new Error('not logged in'), { code: 'GH_NOT_LOGGED_IN' })
      return 'Acefake'
    },
    mergePull: async (input) => {
      calls.merge.push(input)
      if (input.expectedHeadSha !== 'gh1') {
        throw Object.assign(new Error('head moved'), { code: 'MERGE_HEAD_MOVED' })
      }
      return { merged: true }
    },
    createIssueComment: async (input) => {
      calls.comments.push(input)
      return { id: 1 }
    },
    replyToReviewComment: async (input) => {
      calls.replies.push(input)
      return { id: 1 }
    },
    resolveReviewThread: async (input) => {
      calls.resolves.push(input)
      return { resolved: true }
    },
  }
}

/** Minimal read-only GitLab client double. */
function fakeGitlabClient(options = {}) {
  const calls = { publishes: [], comments: [] }
  return {
    calls,
    providerKind: 'gitlab',
    status: async () => ({ ok: true, provider: 'gitlab', viewer: 'shims' }),
    listPullRequests: async () => ({ query: '', totalCount: 1, items: [{ repo: 'mdesign/m-design-client', number: 7 }] }),
    getPull: async () => ({ headSha: 'gl1', summary: { repo: 'mdesign/m-design-client' }, files: [] }),
    getPullHead: async () => 'gl1',
    getAuthenticatedUser: async () => 'shims',
    createIssueComment: async (input) => {
      calls.comments.push(input)
      return { id: 9, url: `http://gl.local/mr#note_9` }
    },
    publishReview: async (input) => {
      calls.publishes.push(input)
      return {
        published: true,
        reviewId: 42,
        url: 'http://gl.local/mr#note_42',
        comments: 1,
        skipped: 0,
        headSha: input.headSha ?? 'gl1',
        action: 'created',
      }
    },
  }
}

/** Build routes; `withGithub: false` models a GitLab-only profile. */
function buildRoutes(options = {}) {
  const defaultAccount = options.defaultAccount ?? 'gitlab'
  const withGithub = options.withGithub !== false
  const github = withGithub ? fakeGithubClient({ ghStatus: options.ghStatus, listRepo: 'github/primary' }) : undefined
  const fallbackGithub = withGithub ? fakeGithubClient({ listRepo: 'github/fallback', headSha: 'fallback-head' }) : undefined
  const gitlab = fakeGitlabClient()
  const clients = withGithub ? { github, gitlab } : { gitlab }
  const engineStub = {
    available: () => false,
    status: () => ({ state: 'none' }),
    existing: (repo, number, headSha, account) => ({
      state: options.reviewDone === true ? 'done' : 'none',
      headSha,
      findings: options.reviewDone === true ? [{ severity: 'P1', file: 'f.js', line: 1, title: 't' }] : [],
      overview: options.reviewDone === true ? 'overview' : undefined,
      account,
    }),
    start: () => { throw new Error('review must not start in this test') },
    cancel: () => false,
    invalidate: () => {},
    dispose: () => {},
  }
  const reviewerState = { status: { config: { publish: { enabled: false } }, publish: { enabled: false }, recent: [] }, patches: [], runs: 0 }
  const reviewer = withGithub ? {
    status: () => reviewerState.status,
    updateConfig: (patch) => {
      reviewerState.patches.push(patch)
      reviewerState.status = { ...reviewerState.status, config: { ...reviewerState.status.config, ...patch } }
      return reviewerState.status
    },
    runOnce: async () => {
      reviewerState.runs += 1
      return reviewerState.status
    },
    getPublished: () => undefined,
    dispose: () => {},
  } : undefined
  const config = resolveConfig({
    dataSource: defaultAccount,
    gitlabBaseUrl: 'http://gitlab.local:8090',
    gitlabToken: 'token',
    viewerLogin: 'shims',
  })
  const routes = createRoutes({
    config,
    clients,
    defaultAccount,
    github: fallbackGithub,
    engine: engineStub,
    saveStore: options.saveStore ?? (() => {}),
    tokenWriter: options.tokenWriter ?? (() => {}),
    tokenRemover: options.tokenRemover ?? (() => {}),
    reviewer,
    publisher: withGithub
      ? (options.realPublisher === true
          ? new ReviewPublisher({
              github: fallbackGithub,
              engine: engineStub,
              clientFor: (id) => clients[id],
              legacyAccount: 'github',
            })
          : { publish: async () => { throw new Error('publish must not run in this test') }, dispose: () => {} })
      : undefined,
    logger: { warn: () => {} },
    llmAvailable: () => false,
    llmInfo: async () => ({}),
    version: '0.13.0',
  })
  return { routes, github, fallbackGithub, gitlab, reviewer: reviewerState }}

test('providerCapabilities keeps merge/reply/resolve on GitHub; GitLab can publish and comment', () => {
  const github = providerCapabilities('github')
  const gitlab = providerCapabilities('gitlab')
  assert.equal(github.merge, true)
  assert.equal(github.publish, true)
  assert.equal(github.autoReview, true)
  assert.equal(gitlab.merge, false)
  assert.equal(gitlab.publish, true)
  assert.equal(gitlab.comment, true)
  assert.equal(gitlab.reply, false)
  assert.equal(gitlab.resolve, false)
  assert.equal(gitlab.autoReview, false)
  assert.equal(gitlab.browse, true)
  assert.equal(gitlab.review, true)
  assert.equal(gitlab.chat, true)
})

test('health lists both accounts and marks the default one', async () => {
  const { routes } = buildRoutes()
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
  assert.equal(gitlab.capabilities.publish, true)
  assert.equal(gitlab.capabilities.comment, true)
})

test('health keeps the gh missing / not-logged-in / ok tri-state', async () => {
  for (const [ghStatus, expectedOk] of [['ok', true], ['missing', false], ['not-logged-in', false]]) {
    const { routes } = buildRoutes({ defaultAccount: 'github', ghStatus })
    const health = await routes['/codex-review/health']()
    assert.equal(health.provider, 'github')
    assert.equal(health.gh, ghStatus)
    assert.equal(health.ok, expectedOk)
    assert.equal(health.capabilities.merge, true)
    assert.equal(health.accounts.length, 2)
    const github = health.accounts.find((entry) => entry.id === 'github')
    assert.equal(github.gh, ghStatus)
    assert.equal(github.ok, expectedOk)
  }
})

test('prs routes each account to its own client', async () => {
  const { routes, fallbackGithub } = buildRoutes()
  const gitlab = await routes['/codex-review/prs']({})
  assert.equal(gitlab.items[0].repo, 'mdesign/m-design-client')
  const github = await routes['/codex-review/prs']({ account: 'github' })
  assert.equal(github.items[0].repo, 'github/primary')
  assert.equal(fallbackGithub.calls.list.length, 0, 'the injected fallback client must not serve account routes')
  await assert.rejects(
    () => routes['/codex-review/prs']({ account: 'nope' }),
    (error) => error.code === 'BAD_REQUEST',
  )
})

test('write routes follow the selected account capabilities', async () => {
  const { routes, github } = buildRoutes()
  const gitlabPayload = { repo: 'mdesign/m-design-client', number: 7, confirm: true }
  const gitlabWrites = [
    ['/codex-review/merge', gitlabPayload],
    ['/codex-review/reply', { ...gitlabPayload, commentId: 1, body: 'x' }],
    ['/codex-review/resolve', { ...gitlabPayload, threadId: 't1' }],
  ]
  for (const [path, payload] of gitlabWrites) {
    await assert.rejects(
      () => routes[path](payload, { signal: undefined }),
      (error) => error.code === 'PROVIDER_UNSUPPORTED',
      `${path} must be rejected for the GitLab account`,
    )
  }
  assert.equal(github.calls.merge.length, 0)

  const merged = await routes['/codex-review/merge']({
    account: 'github',
    repo: 'Acefake/yingbox',
    number: 1,
    confirm: true,
    method: 'squash',
    expectedHeadSha: 'gh1',
  })
  assert.equal(merged.merged, true)
  assert.equal(github.calls.merge.length, 1)
  assert.equal(github.calls.merge[0].expectedHeadSha, 'gh1')

  await assert.rejects(
    () => routes['/codex-review/merge']({
      account: 'github',
      repo: 'Acefake/yingbox',
      number: 1,
      confirm: true,
      method: 'squash',
      expectedHeadSha: 'stale',
    }),
    (error) => error.code === 'MERGE_HEAD_MOVED',
  )
})

test('the GitLab account can publish its review and comment on the MR', async () => {
  const { routes, gitlab } = buildRoutes({ reviewDone: true, realPublisher: true })
  const result = await routes['/codex-review/review-publish']({
    account: 'gitlab',
    repo: 'mdesign/m-design-client',
    number: 7,
    confirm: true,
    mode: 'summary',
    minSeverity: 'P2',
  })
  assert.equal(result.published, true)
  assert.equal(result.reviewId, 42)
  assert.equal(gitlab.calls.publishes.length, 1)
  assert.equal(gitlab.calls.publishes[0].review.state, 'done')
  assert.equal(gitlab.calls.publishes[0].review.findings.length, 1)

  const comment = await routes['/codex-review/comment']({
    account: 'gitlab',
    repo: 'mdesign/m-design-client',
    number: 7,
    body: 'hello mr',
    confirm: true,
  })
  assert.equal(comment.id, 9)
  assert.equal(gitlab.calls.comments.length, 1)
  assert.equal(gitlab.calls.comments[0].body, 'hello mr')
})

test('pr detail and review snapshot are account-scoped end to end', async () => {
  const { routes, fallbackGithub } = buildRoutes()
  const github = await routes['/codex-review/pr']({ account: 'github', repo: 'Acefake/yingbox', number: 1 })
  const gitlab = await routes['/codex-review/pr']({ account: 'gitlab', repo: 'mdesign/m-design-client', number: 7 })
  assert.equal(github.headSha, 'gh1')
  assert.equal(gitlab.headSha, 'gl1')
  assert.equal(github.summary.repo, 'github/primary')
  assert.equal(gitlab.summary.repo, 'mdesign/m-design-client')
  assert.equal(github.review.account, 'github')
  assert.equal(gitlab.review.account, 'gitlab')
  assert.equal(fallbackGithub.calls.pulls.length, 0, 'detail must use the account client, not the injected fallback')
})

test('comment / reply / resolve pass the selected account and payload through', async () => {
  const { routes, github } = buildRoutes()
  const ref = { account: 'github', repo: 'Acefake/yingbox', number: 1, confirm: true }
  await routes['/codex-review/comment']({ ...ref, body: 'hello' })
  await routes['/codex-review/reply']({ ...ref, commentId: 12, body: 'reply' })
  await routes['/codex-review/resolve']({ ...ref, threadId: 't1' })
  assert.equal(github.calls.comments[0].body, 'hello')
  assert.equal(github.calls.replies[0].commentId, 12)
  assert.equal(github.calls.replies[0].body, 'reply')
  assert.equal(github.calls.resolves[0].threadId, 't1')
  assert.equal(github.calls.comments[0].repo, 'Acefake/yingbox')
})

test('auto-review routes reflect the injected reviewer and reject GitLab-only profiles', async () => {
  const { routes, reviewer } = buildRoutes()
  const status = await routes['/codex-review/auto-review-config']({ patch: { enabled: false } })
  assert.equal(status.config.enabled, false)
  assert.deepEqual(reviewer.patches, [{ enabled: false }])
  const run = await routes['/codex-review/auto-review-run']({ force: true })
  assert.equal(run.config.enabled, false)
  assert.equal(reviewer.runs, 1)

  const gitlabOnly = buildRoutes({ withGithub: false }).routes
  for (const path of ['/codex-review/auto-review-status', '/codex-review/auto-review-config', '/codex-review/auto-review-run']) {
    await assert.rejects(
      () => gitlabOnly[path]({ patch: { enabled: true }, force: true }),
      (error) => error.code === 'PROVIDER_UNSUPPORTED',
      `${path} must be rejected without a GitHub account`,
    )
  }

  // An explicitly selected non-GitHub account must not edit the GitHub schedule.
  await assert.rejects(
    () => routes['/codex-review/auto-review-config']({ account: 'gitlab', patch: { enabled: true } }),
    (error) => error.code === 'PROVIDER_UNSUPPORTED',
  )
})

test('repo validation follows the selected account provider and segment rules', async () => {
  const { routes } = buildRoutes()
  await assert.rejects(
    () => routes['/codex-review/pr']({ repo: 'mdesign/../secret', number: 1 }),
    (error) => error.code === 'BAD_REQUEST',
  )
  await assert.rejects(
    () => routes['/codex-review/pr']({ account: 'github', repo: 'a/b/c', number: 1 }),
    (error) => error.code === 'BAD_REQUEST',
  )
  await assert.rejects(
    () => routes['/codex-review/pr']({ repo: 'mdesign/-secret', number: 1 }),
    (error) => error.code === 'BAD_REQUEST',
  )
  await assert.rejects(
    () => routes['/codex-review/pr']({ repo: 'single', number: 1 }),
    (error) => error.code === 'BAD_REQUEST',
  )
  await assert.rejects(
    () => routes['/codex-review/pr']({ repo: Array.from({ length: 21 }, () => 'a').join('/'), number: 1 }),
    (error) => error.code === 'BAD_REQUEST',
  )
  const answer = await routes['/codex-review/pr']({ repo: 'mdesign/beijing/graphics-library-v2', number: 1 })
  assert.equal(answer.summary !== undefined, true)
  const twenty = Array.from({ length: 20 }, () => 'a').join('/')
  assert.equal((await routes['/codex-review/pr']({ repo: twenty, number: 1 })).summary !== undefined, true)
})

test('adding a GitHub account without its own token is rejected', async () => {
  const { routes } = buildRoutes()
  await assert.rejects(
    () => routes['/codex-review/accounts-add']({ type: 'github', label: 'Work', confirm: true }),
    (error) => error.code === 'BAD_REQUEST',
  )
})

test('account add / default / remove routes update the runtime list', async () => {
  const writes = []
  const { routes } = buildRoutes({
    tokenWriter: (id, token) => writes.push(['set', id, token]),
    tokenRemover: (id) => writes.push(['remove', id]),
  })
  const added = await routes['/codex-review/accounts-add']({
    type: 'gitlab', label: 'Second', baseUrl: 'http://gl.local:8090', username: 'u', token: 'tok', confirm: true,
  })
  assert.equal(added.accounts.length, 3)
  const id = added.accounts.at(-1).id
  assert.deepEqual(writes[0], ['set', id, 'tok'])
  const madeDefault = await routes['/codex-review/accounts-default']({ id, confirm: true })
  assert.equal(madeDefault.defaultAccount, id)
  const removed = await routes['/codex-review/accounts-remove']({ id, confirm: true })
  assert.equal(removed.accounts.length, 2)
  assert.deepEqual(writes[1], ['remove', id])
})

test('buildClients uses a stored token for a non-primary GitHub account', () => {
  const config = resolveConfig({})
  const clients = buildClients(config, { warn: () => {} }, undefined, [
    { id: 'github', type: 'github', label: 'GitHub', baseUrl: '', username: '' },
    { id: 'work', type: 'github', label: 'Work', baseUrl: '', username: '' },
  ], () => 'token')
  assert.equal(clients.github.unavailable, undefined)
  assert.equal(clients.work.unavailable, undefined)
})

test('buildClients marks non-primary GitHub/GitLab accounts without a token unavailable', () => {  const config = resolveConfig({})
  const clients = buildClients(config, { warn: () => {} }, undefined, [
    { id: 'github', type: 'github', label: 'GitHub', baseUrl: '', username: '' },
    { id: 'work', type: 'github', label: 'Work', baseUrl: '', username: '' },
    { id: 'gl', type: 'gitlab', label: 'GL', baseUrl: 'http://gitlab.local:8090', username: '' },
  ], () => '')
  assert.equal(clients.github.unavailable, undefined, 'the first GitHub account may fall back to gh')
  assert.equal(clients.work.unavailable, true, 'a second GitHub account needs its own token')
  assert.equal(clients.gl.unavailable, true, 'a GitLab account needs a token')
})

test('review job and file-cache keys are account-scoped', () => {
  const options = { depth: 'standard', severityThreshold: 'P1', includeGuidelines: true }
  const a = buildReviewJobKey('a/b', 1, 'sha', options, 'github')
  const b = buildReviewJobKey('a/b', 1, 'sha', options, 'gitlab')
  assert.notEqual(a, b)
  assert.notEqual(fileCacheKey('a/b', 1, 'x.js', 'patch', 'github'), fileCacheKey('a/b', 1, 'x.js', 'patch', 'gitlab'))
})
