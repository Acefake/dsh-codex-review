/**
 * Unit tests for the merge write path (CONTRACT §5.1). Every guard runs against
 * a fake fetch/`gh` terminal; no real PR is ever merged.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { GitHubClient } from '../lib/github.js'

/**
 * Run a test body with a temporary environment variable value.
 * @param {string} name - env var name.
 * @param {string | undefined} value - value to set (undefined deletes).
 * @param {() => Promise<void>} body - test body.
 * @returns {Promise<void>} resolves after the body.
 */
async function withEnv(name, value, body) {
  const previous = process.env[name]
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
  try {
    await body()
  } finally {
    if (previous === undefined) delete process.env[name]
    else process.env[name] = previous
  }
}

/**
 * Minimal Response-shaped object accepted by the client.
 * @param {unknown} body - JSON body or raw text.
 * @param {number} [status] - HTTP status.
 * @returns {any} response stub.
 */
function responseOf(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    async text() {
      return typeof body === 'string' ? body : JSON.stringify(body)
    },
  }
}

/** The PR fixture every guard test starts from. */
function basePull(overrides = {}) {
  return {
    number: 129,
    state: 'open',
    draft: false,
    merged: false,
    merged_at: null,
    mergeable: true,
    mergeable_state: 'clean',
    title: 'feat(player): 自动检测片头片尾',
    head: { sha: 'abc123def4567890abc123def4567890abc12345', ref: 'feat/intro-detect', repo: { full_name: 'Acme/repo' } },
    base: { ref: 'feat/skip-intro' },
    ...overrides,
  }
}

/** The head SHA callers must echo back as `expectedHeadSha`. */
const HEAD_SHA = 'abc123def4567890abc123def4567890abc12345'

/**
 * Build a client whose fetch terminal serves the merge endpoints.
 * @param {Record<string, any>} [options] - fixture overrides.
 * @returns {{ client: GitHubClient, state: any }} client plus observed calls.
 */
function makeMergeClient(options = {}) {
  /** @type {any} */
  const state = {
    pull: options.pull ?? basePull(),
    pullQueue: Array.isArray(options.pullQueue) ? [...options.pullQueue] : undefined,
    mergeStatus: options.mergeStatus ?? 200,
    mergeData: options.mergeData ?? { merged: true, sha: 'merge-sha-001', message: 'Pull Request successfully merged' },
    mergeErrorBody: options.mergeErrorBody ?? { message: 'Base branch was modified. Review and try the merge again.' },
    deleteStatus: options.deleteStatus ?? 204,
    deleteErrorBody: options.deleteErrorBody ?? { message: 'Protected branch' },
    calls: [],
    sleeps: [],
  }
  /** @type {any} */
  const fetchImpl = async (url, init) => {
    const method = init?.method ?? 'GET'
    state.calls.push({ url, method, body: init?.body })
    if (/\/pulls\/\d+\/merge$/.test(url) && method === 'PUT') {
      if (state.mergeStatus >= 400) return responseOf(state.mergeErrorBody, state.mergeStatus)
      return responseOf(state.mergeData)
    }
    if (method === 'DELETE') {
      if (state.deleteStatus >= 400) return responseOf(state.deleteErrorBody, state.deleteStatus)
      return responseOf('', 204)
    }
    if (/\/pulls\/\d+$/.test(url)) {
      let next
      if (state.pullQueue !== undefined && state.pullQueue.length > 0) next = state.pullQueue.shift()
      else next = state.pull
      return responseOf(next)
    }
    throw new Error(`unexpected fetch ${method} ${url}`)
  }
  const client = new GitHubClient({
    config: { requestTimeoutMs: 1000 },
    fetchImpl,
    // `gh auth token` answers a token so the client picks the fetch transport;
    // any other gh invocation is a test bug.
    execFileImpl: async (file, args) => {
      if (args[0] === 'auth') return { stdout: 'token-123\n', stderr: '' }
      throw new Error(`unexpected gh ${args.join(' ')}`)
    },
    sleep: async (ms) => {
      state.sleeps.push(ms)
    },
  })
  return { client, state }
}

/** A complete valid merge request. */
const MERGE_REQUEST = {
  repo: 'Acme/repo',
  number: 129,
  method: 'squash',
  expectedHeadSha: HEAD_SHA,
  confirm: true,
}

/**
 * Run one merge request against a fresh client and expect a stable AppError code.
 * @param {Record<string, any>} request - merge request overrides.
 * @param {string} code - expected AppError code.
 * @param {Record<string, any>} [clientOptions] - client fixture overrides.
 * @returns {Promise<any>} the observed state.
 */
async function expectMergeFailure(request, code, clientOptions = {}) {
  const { client, state } = makeMergeClient(clientOptions)
  await assert.rejects(client.mergePull(request), (error) => {
    assert.equal(error.code, code)
    return true
  })
  return state
}

test('mergePull validates confirm, method, head SHA and commit-field limits before any request', async () => {
  const { client, state } = makeMergeClient()
  await assert.rejects(client.mergePull({ ...MERGE_REQUEST, confirm: undefined }), (error) => error.code === 'BAD_REQUEST')
  await assert.rejects(client.mergePull({ ...MERGE_REQUEST, confirm: false }), (error) => error.code === 'BAD_REQUEST')
  await assert.rejects(client.mergePull({ ...MERGE_REQUEST, method: 'fast' }), (error) => error.code === 'BAD_REQUEST')
  await assert.rejects(client.mergePull({ ...MERGE_REQUEST, method: undefined }), (error) => error.code === 'BAD_REQUEST')
  await assert.rejects(client.mergePull({ ...MERGE_REQUEST, expectedHeadSha: '' }), (error) => error.code === 'BAD_REQUEST')
  await assert.rejects(client.mergePull({ ...MERGE_REQUEST, repo: 'not-a-repo' }), (error) => error.code === 'BAD_REQUEST')
  await assert.rejects(client.mergePull({ ...MERGE_REQUEST, number: 0 }), (error) => error.code === 'BAD_REQUEST')
  await assert.rejects(client.mergePull({ ...MERGE_REQUEST, commitTitle: 'x'.repeat(300) }), (error) => error.code === 'BAD_REQUEST')
  await assert.rejects(client.mergePull({ ...MERGE_REQUEST, commitMessage: 42 }), (error) => error.code === 'BAD_REQUEST')
  // Guard 1 runs before the PR read: nothing was fetched at all.
  assert.equal(state.calls.length, 0)
})

test('mergePull refuses merged, closed and draft PRs (guards 2)', async () => {
  const merged = await expectMergeFailure(MERGE_REQUEST, 'MERGE_NOT_ALLOWED', {
    pull: basePull({ state: 'closed', merged: true, merged_at: '2026-10-24T00:00:00Z' }),
  })
  assert.equal(merged.calls.filter((call) => call.url.endsWith('/merge')).length, 0)

  const closed = makeMergeClient({ pull: basePull({ state: 'closed' }) })
  await assert.rejects(closed.client.mergePull(MERGE_REQUEST), (error) => {
    assert.equal(error.code, 'MERGE_NOT_ALLOWED')
    assert.ok(error.message.includes('已关闭'))
    return true
  })

  const draft = makeMergeClient({ pull: basePull({ draft: true }) })
  await assert.rejects(draft.client.mergePull(MERGE_REQUEST), (error) => {
    assert.equal(error.code, 'MERGE_NOT_ALLOWED')
    assert.ok(error.message.includes('草稿'))
    return true
  })
  assert.equal(draft.state.calls.filter((call) => call.url.endsWith('/merge')).length, 0)
})

test('mergePull refuses to merge when the head moved (guard 3)', async () => {
  const { client, state } = makeMergeClient({ pull: basePull({ head: { sha: 'ffffffffffffffffffffffffffffffffffffffff', ref: 'feat/intro-detect', repo: { full_name: 'Acme/repo' } } }) })
  await assert.rejects(client.mergePull(MERGE_REQUEST), (error) => {
    assert.equal(error.code, 'MERGE_HEAD_MOVED')
    assert.ok(error.message.includes('ffffffffffff'))
    return true
  })
  assert.equal(state.calls.filter((call) => call.url.endsWith('/merge')).length, 0)
})

test('mergePull maps mergeable=false to MERGE_CONFLICT (guard 4)', async () => {
  const state = await expectMergeFailure(MERGE_REQUEST, 'MERGE_CONFLICT', { pull: basePull({ mergeable: false, mergeable_state: 'dirty' }) })
  assert.equal(state.calls.filter((call) => call.url.endsWith('/merge')).length, 0)
})

test('mergePull retries while GitHub computes mergeable and falls back to mergeable_state', async () => {
  // Two nulls, then GitHub answers: the third read allows the merge.
  const retried = makeMergeClient({ pullQueue: [basePull({ mergeable: null }), basePull({ mergeable: null }), basePull({ mergeable: true })] })
  const result = await retried.client.mergePull(MERGE_REQUEST)
  assert.equal(result.merged, true)
  assert.deepEqual(retried.state.sleeps, [800, 800])
  assert.equal(retried.state.calls.filter((call) => call.method === 'GET').length, 3)

  // Still null after two retries → mergeable_state decides.
  const clean = makeMergeClient({ pullQueue: [basePull({ mergeable: null }), basePull({ mergeable: null, mergeable_state: 'clean' }), basePull({ mergeable: null, mergeable_state: 'clean' })] })
  assert.equal((await clean.client.mergePull(MERGE_REQUEST)).merged, true)

  const dirty = makeMergeClient({ pullQueue: [basePull({ mergeable: null }), basePull({ mergeable: null, mergeable_state: 'dirty' }), basePull({ mergeable: null, mergeable_state: 'dirty' })] })
  await assert.rejects(dirty.client.mergePull(MERGE_REQUEST), (error) => error.code === 'MERGE_CONFLICT')

  const blocked = makeMergeClient({ pullQueue: [basePull({ mergeable: null }), basePull({ mergeable: null, mergeable_state: 'blocked' }), basePull({ mergeable: null, mergeable_state: 'blocked' })] })
  await assert.rejects(blocked.client.mergePull(MERGE_REQUEST), (error) => error.code === 'MERGE_NOT_ALLOWED')

  const unknown = makeMergeClient({ pullQueue: [basePull({ mergeable: null }), basePull({ mergeable: null, mergeable_state: '' }), basePull({ mergeable: null, mergeable_state: '' })] })
  await assert.rejects(unknown.client.mergePull(MERGE_REQUEST), (error) => error.code === 'MERGE_NOT_ALLOWED')

  // A head movement detected during a retry must still win.
  const moved = makeMergeClient({
    pullQueue: [
      basePull({ mergeable: null }),
      basePull({ mergeable: null, head: { sha: '9999999999999999999999999999999999999999', ref: 'feat/intro-detect', repo: { full_name: 'Acme/repo' } } }),
    ],
  })
  await assert.rejects(moved.client.mergePull(MERGE_REQUEST), (error) => error.code === 'MERGE_HEAD_MOVED')
})

test('mergePull maps merge write failures (guard 5)', async () => {
  await expectMergeFailure(MERGE_REQUEST, 'MERGE_CONFLICT', { mergeStatus: 405 })
  await expectMergeFailure(MERGE_REQUEST, 'MERGE_CONFLICT', { mergeStatus: 409 })
  await expectMergeFailure(MERGE_REQUEST, 'GH_FORBIDDEN', { mergeStatus: 403 })
  await expectMergeFailure(MERGE_REQUEST, 'GH_NOT_FOUND', { mergeStatus: 404 })
})

test('mergePull sends the contract PUT body and returns the success shape', async () => {
  const { client, state } = makeMergeClient()
  const result = await client.mergePull({
    ...MERGE_REQUEST,
    method: 'rebase',
    commitTitle: '  自定义标题  ',
    commitMessage: '自定义说明',
  })
  assert.deepEqual(result, { merged: true, sha: 'merge-sha-001', message: 'Pull Request successfully merged' })
  const mergeCall = state.calls.find((call) => call.url.endsWith('/pulls/129/merge'))
  assert.equal(mergeCall.method, 'PUT')
  assert.deepEqual(JSON.parse(mergeCall.body), {
    merge_method: 'rebase',
    sha: HEAD_SHA,
    commit_title: '自定义标题',
    commit_message: '自定义说明',
  })

  // A GitHub "merged:false" answer (e.g. a hook refused) is a NOT_ALLOWED failure.
  const refused = makeMergeClient({ mergeData: { merged: false, message: 'Pull request is not mergeable' } })
  await assert.rejects(refused.client.mergePull(MERGE_REQUEST), (error) => {
    assert.equal(error.code, 'MERGE_NOT_ALLOWED')
    assert.ok(error.message.includes('not mergeable'))
    return true
  })
})

test('mergePull deletes the head branch and degrades cleanly when the delete fails (guard 6)', async () => {
  const withDelete = makeMergeClient()
  const deleted = await withDelete.client.mergePull({ ...MERGE_REQUEST, deleteBranch: true })
  assert.equal(deleted.branchDeleted, true)
  assert.equal(deleted.branchWarning, undefined)
  const deleteCall = withDelete.state.calls.find((call) => call.method === 'DELETE')
  assert.ok(deleteCall.url.endsWith('/git/refs/heads/feat/intro-detect'))

  // A slashed branch keeps its path separators.
  const slashed = makeMergeClient({ pull: basePull({ head: { sha: HEAD_SHA, ref: 'feat/intro/detect', repo: { full_name: 'Acme/repo' } } }) })
  const slashedResult = await slashed.client.mergePull({ ...MERGE_REQUEST, deleteBranch: true })
  assert.equal(slashedResult.branchDeleted, true)
  assert.ok(slashed.state.calls.find((call) => call.method === 'DELETE').url.endsWith('/git/refs/heads/feat/intro/detect'))

  // Protected branch → the merge stands, the delete is reported.
  const protectedBranch = makeMergeClient({ deleteStatus: 422 })
  const degraded = await protectedBranch.client.mergePull({ ...MERGE_REQUEST, deleteBranch: true })
  assert.equal(degraded.merged, true)
  assert.equal(degraded.branchDeleted, false)
  assert.ok(degraded.branchWarning.includes('删除失败'))

  // Fork head branch → never touch another repository.
  const fork = makeMergeClient({ pull: basePull({ head: { sha: HEAD_SHA, ref: 'feat/intro-detect', repo: { full_name: 'Fork/repo' } } }) })
  const forkResult = await fork.client.mergePull({ ...MERGE_REQUEST, deleteBranch: true })
  assert.equal(forkResult.merged, true)
  assert.equal(forkResult.branchDeleted, false)
  assert.ok(forkResult.branchWarning.includes('fork'))
  assert.equal(fork.state.calls.filter((call) => call.method === 'DELETE').length, 0)

  // Not requested → no branch fields at all.
  const plain = makeMergeClient()
  const plainResult = await plain.client.mergePull(MERGE_REQUEST)
  assert.equal('branchDeleted' in plainResult, false)
  assert.equal(plain.state.calls.filter((call) => call.method === 'DELETE').length, 0)
})

test('mergePull bypasses and clears the stale PR caches (guard 7)', async () => {
  await withEnv('GH_TOKEN', 'token-123', async () => {
    const { client, state } = makeMergeClient()
    // A stale cached detail must not short-circuit the guards…
    client.cache.set('pr:Acme/repo#129', { headSha: 'stale', summary: {} }, 60_000, client.now())
    client.cache.set('files:Acme/repo#129@abc123def456', { files: [] }, 60_000, client.now())
    client.cache.set('checks:Acme/repo@abc123def456', { state: 'none' }, 60_000, client.now())
    client.cache.set('pr:Acme/repo#130', { headSha: 'other' }, 60_000, client.now())
    const result = await client.mergePull(MERGE_REQUEST)
    assert.equal(result.merged, true)
    assert.equal(state.calls.filter((call) => call.method === 'GET').length, 1)
    assert.equal(client.cache.get('pr:Acme/repo#129', client.now()), undefined)
    assert.equal(client.cache.get('files:Acme/repo#129@abc123def456', client.now()), undefined)
    assert.equal(client.cache.get('checks:Acme/repo@abc123def456', client.now()), undefined)
    assert.notEqual(client.cache.get('pr:Acme/repo#130', client.now()), undefined)
  })
})

test('mergePull writes through the gh CLI fallback when no token exists', async () => {
  const calls = []
  const pull = basePull()
  const execFileImpl = async (file, args) => {
    calls.push(args)
    if (args[0] === 'auth') {
      throw Object.assign(new Error('not logged in'), { code: 4, stderr: 'You are not logged into any GitHub hosts. To log in, run: gh auth login' })
    }
    if (args[0] !== 'api') throw new Error(`unexpected gh ${args.join(' ')}`)
    if (args[1].includes('/git/refs/heads/')) return { stdout: '', stderr: '' }
    if (args[1].endsWith('/pulls/129/merge')) return { stdout: JSON.stringify({ merged: true, sha: 'cli-merge-sha', message: 'merged via gh' }), stderr: '' }
    if (args[1].endsWith('/pulls/129')) return { stdout: JSON.stringify(pull), stderr: '' }
    throw new Error(`unexpected gh api ${args[1]}`)
  }
  const client = new GitHubClient({
    config: { requestTimeoutMs: 1000 },
    fetchImpl: async () => {
      throw new Error('fetch must not be used')
    },
    execFileImpl,
    sleep: async () => {},
  })
  await withEnv('GH_TOKEN', undefined, async () => {
    await withEnv('GITHUB_TOKEN', undefined, async () => {
      const result = await client.mergePull({ ...MERGE_REQUEST, deleteBranch: true })
      assert.deepEqual(result, { merged: true, sha: 'cli-merge-sha', message: 'merged via gh', branchDeleted: true })
    })
  })
  const mergeArgs = calls.find((args) => args[0] === 'api' && args[1].endsWith('/pulls/129/merge'))
  assert.ok(mergeArgs.includes('--method'))
  assert.ok(mergeArgs.includes('PUT'))
  assert.ok(mergeArgs.includes('-f'))
  assert.ok(mergeArgs.includes('merge_method=squash'))
  assert.ok(mergeArgs.includes(`sha=${HEAD_SHA}`))
  const deleteArgs = calls.find((args) => args[0] === 'api' && args[1].includes('/git/refs/heads/'))
  assert.ok(deleteArgs.includes('DELETE'))
})
