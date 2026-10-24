/**
 * Unit tests for the GitHub data channel: normalization, truncation, error
 * mapping, caching and both transports (fake fetch / fake execFile).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  GitHubClient,
  LruCache,
  MAX_TOTAL_PATCH_CHARS,
  appErrorFromGh,
  appErrorFromNetwork,
  applyPatchBudget,
  buildStack,
  findParentPull,
  ghFailureCode,
  httpStatusToCode,
  normalizeChecks,
  normalizeFilePatch,
  normalizePullSummary,
  normalizeSearchItem,
  parseDeclaredBase,
  truncateText,
} from '../lib/github.js'

/**
 * Minimal Response-shaped object accepted by the client.
 * @param {unknown} body - JSON body or raw text.
 * @param {number} [status] - HTTP status.
 * @param {Record<string, string>} [headers] - response headers.
 * @returns {any} response stub.
 */
function responseOf(body, status = 200, headers = {}) {
  const normalized = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]))
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => normalized[String(name).toLowerCase()] ?? null },
    async text() {
      return typeof body === 'string' ? body : JSON.stringify(body)
    },
  }
}

/**
 * Build a URL-routing fake fetch that records calls.
 * @param {Array<[RegExp, any]>} routes - pattern → body/function.
 * @returns {any} fake fetch with a `calls` array.
 */
function fakeFetch(routes) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url, init })
    for (const [pattern, responder] of routes) {
      if (!pattern.test(url)) continue
      const body = typeof responder === 'function' ? responder(url) : responder
      return responseOf(body)
    }
    throw new Error(`unexpected fetch ${url}`)
  }
  impl.calls = calls
  return impl
}

/**
 * Build a GitHubClient with both terminals faked.
 * @param {Record<string, unknown>} [config] - plugin config overrides.
 * @param {any} [fetchImpl] - fake fetch.
 * @param {any} [execFileImpl] - fake execFile.
 * @returns {GitHubClient} client.
 */
function makeClient(config = {}, fetchImpl = undefined, execFileImpl = undefined) {
  return new GitHubClient({
    config: { requestTimeoutMs: 1000, maxPatchChars: 24000, maxBodyChars: 50000, ...config },
    fetchImpl: fetchImpl ?? (async () => responseOf({})),
    execFileImpl: execFileImpl ?? (async () => ({ stdout: '', stderr: '' })),
  })
}

/** Run one test body with a temporary environment variable value. */
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

test('LruCache honours TTL and eviction order', () => {
  const cache = new LruCache(2)
  cache.set('a', 1, 100, 0)
  cache.set('b', 2, 100, 0)
  assert.equal(cache.get('a', 50), 1)
  cache.set('c', 3, 100, 50)
  assert.equal(cache.get('b', 60), undefined)
  assert.equal(cache.get('a', 60), 1)
  assert.equal(cache.get('a', 200), undefined)
})

test('truncateText and applyPatchBudget enforce the configured caps', () => {
  assert.deepEqual(truncateText('abcdef', 3), { text: 'abc', truncated: true })
  assert.deepEqual(truncateText('ab', 3), { text: 'ab', truncated: false })
  const files = [0, 1, 2].map((index) => normalizeFilePatch({ filename: `f${index}.ts`, status: 'modified', additions: 1, deletions: 1, patch: 'x'.repeat(600) }))
  const bounded = applyPatchBudget(files, 700)
  assert.equal(bounded.filesTruncated, true)
  assert.equal(bounded.files[0].patch.length, 600)
  assert.equal(bounded.files[0].patchTruncated, false)
  assert.equal(bounded.files[1].patch.length, 100)
  assert.equal(bounded.files[1].patchTruncated, true)
  assert.equal(bounded.files[2].patch, '')
  assert.equal(bounded.files[2].patchTruncated, true)
  assert.equal(applyPatchBudget([], MAX_TOTAL_PATCH_CHARS).filesTruncated, false)
})

test('normalizeSearchItem maps the search payload to PrSummary', () => {
  const item = normalizeSearchItem({
    number: 129,
    title: 'feat(player): 自动检测片头片尾',
    state: 'open',
    draft: false,
    user: { login: 'Acefake' },
    created_at: '2026-10-24T06:05:38Z',
    updated_at: '2026-10-24T06:05:38Z',
    html_url: 'https://github.com/Acefake/yingbox/pull/129',
    repository_url: 'https://api.github.com/repos/Acefake/yingbox',
    pull_request: { head: { ref: 'feat/intro-detect' }, base: { ref: 'feat/skip-intro' } },
  })
  assert.equal(item.repo, 'Acefake/yingbox')
  assert.equal(item.number, 129)
  assert.equal(item.author, 'Acefake')
  assert.equal(item.isDraft, false)
  assert.equal(item.state, 'open')
  assert.equal(item.headRefName, 'feat/intro-detect')
  assert.equal(item.baseRefName, 'feat/skip-intro')
  assert.equal(item.reviewDecision, undefined)
  assert.equal(item.url, 'https://github.com/Acefake/yingbox/pull/129')
  const closed = normalizeSearchItem({ number: 3, state: 'closed', draft: true, repository_url: 'https://api.github.com/repos/a/b' })
  assert.equal(closed.state, 'closed')
  assert.equal(closed.isDraft, true)
  assert.equal(normalizeSearchItem({ number: 0 }), null)
  assert.equal(normalizeSearchItem(null), null)
})

test('normalizePullSummary keeps empty reviewDecision and merged state', () => {
  const summary = normalizePullSummary({
    number: 1,
    title: 't',
    user: { login: 'u' },
    draft: true,
    state: 'open',
    created_at: 'a',
    updated_at: 'b',
    head: { ref: 'h' },
    base: { ref: 'b' },
    review_decision: null,
    additions: 3,
    deletions: 1,
    changed_files: 2,
    html_url: 'u',
    merged_at: null,
  }, 'o/r', 1)
  assert.equal(summary.reviewDecision, '')
  assert.equal(summary.additions, 3)
  assert.equal(summary.changedFiles, 2)
  const merged = normalizePullSummary({ number: 2, state: 'closed', merged_at: '2026-01-01T00:00:00Z' }, 'o/r', 2)
  assert.equal(merged.state, 'closed')
})

test('normalizeChecks treats an empty set as none and derives failure/pending/neutral', () => {
  assert.deepEqual(normalizeChecks(undefined, undefined), { state: 'none', items: [] })
  assert.deepEqual(normalizeChecks({ check_runs: [] }, { state: 'pending', total_count: 0, statuses: [] }), { state: 'none', items: [] })
  const failure = normalizeChecks({ check_runs: [{ name: 'build', status: 'completed', conclusion: 'failure', html_url: 'u' }] }, undefined)
  assert.equal(failure.state, 'failure')
  assert.deepEqual(failure.items[0], { name: 'build', state: 'failure', url: 'u' })
  const pending = normalizeChecks({ check_runs: [{ name: 'build', status: 'in_progress', conclusion: null }] }, undefined)
  assert.equal(pending.state, 'pending')
  const neutral = normalizeChecks(undefined, { statuses: [{ context: 'ci', state: 'success' }] })
  assert.equal(neutral.state, 'success')
  assert.deepEqual(normalizeChecks(undefined, { statuses: [{ context: 'x', state: 'error' }] }).state, 'failure')
})

test('stack inference reads the declared base and walks parent PRs', () => {
  assert.equal(parseDeclaredBase('stacked PR：base 为 `feat/skip-intro`，#117 合并后再改'), 'feat/skip-intro')
  assert.equal(parseDeclaredBase('base: feat/x'), 'feat/x')
  assert.equal(parseDeclaredBase('no base note'), undefined)
  assert.equal(parseDeclaredBase(undefined), undefined)

  const parent = findParentPull([
    { number: 117, title: '父 PR', state: 'open', head: { ref: 'feat/skip-intro' }, base: { ref: 'main' }, merged_at: null },
  ], 'feat/skip-intro')
  assert.deepEqual(parent, { number: 117, title: '父 PR', state: 'open', baseRefName: 'main', merged: false })
  assert.equal(findParentPull([], 'feat/skip-intro'), undefined)

  const stack = buildStack({ baseRefName: 'feat/skip-intro', declaredBase: 'feat/skip-intro', parents: [parent] })
  assert.equal(stack.baseRefName, 'feat/skip-intro')
  assert.equal(stack.declaredBase, 'feat/skip-intro')
  assert.deepEqual(stack.basePr, { number: 117, title: '父 PR', state: 'open' })
  assert.deepEqual(stack.chain, [{ number: 117, title: '父 PR', state: 'open' }])
  assert.equal(stack.allBaseMerged, false)
  assert.deepEqual(buildStack({ baseRefName: 'main', parents: [] }), { baseRefName: 'main', chain: [], allBaseMerged: true })
})

test('error mapping covers 401/403/404/429/5xx and gh stderr/exit shapes', () => {
  assert.equal(httpStatusToCode(401), 'GH_NOT_LOGGED_IN')
  assert.equal(httpStatusToCode(403, '0'), 'GH_RATE_LIMIT')
  assert.equal(httpStatusToCode(403, '42'), 'GH_FORBIDDEN')
  assert.equal(httpStatusToCode(403, undefined, 'API rate limit exceeded'), 'GH_RATE_LIMIT')
  assert.equal(httpStatusToCode(404), 'GH_NOT_FOUND')
  assert.equal(httpStatusToCode(429), 'GH_RATE_LIMIT')
  assert.equal(httpStatusToCode(503), 'GH_NETWORK')
  assert.equal(httpStatusToCode(418), 'INTERNAL')

  assert.equal(ghFailureCode('gh: Not Found (HTTP 404)'), 'GH_NOT_FOUND')
  assert.equal(ghFailureCode('gh: Bad credentials (HTTP 401)'), 'GH_NOT_LOGGED_IN')
  assert.equal(ghFailureCode('You are not logged into any GitHub hosts. To log in, run: gh auth login'), 'GH_NOT_LOGGED_IN')
  assert.equal(ghFailureCode('gh: API rate limit exceeded (HTTP 403)'), 'GH_RATE_LIMIT')
  assert.equal(ghFailureCode('gh: Resource not accessible by integration (HTTP 403)'), 'GH_FORBIDDEN')
  assert.equal(ghFailureCode('', { exitCode: 4 }), 'GH_NOT_LOGGED_IN')
  assert.equal(ghFailureCode('', { missing: true }), 'GH_MISSING')
  assert.equal(ghFailureCode('fetch failed ECONNRESET'), 'GH_NETWORK')

  const missing = appErrorFromGh({ code: 'ENOENT' })
  assert.equal(missing.code, 'GH_MISSING')
  const timeout = appErrorFromGh({ killed: true, signal: 'SIGTERM', stderr: '' })
  assert.equal(timeout.code, 'GH_TIMEOUT')
  const notFound = appErrorFromGh({ code: 1, stderr: 'gh: Not Found (HTTP 404)\n' })
  assert.equal(notFound.code, 'GH_NOT_FOUND')
  const abort = appErrorFromNetwork(Object.assign(new Error('aborted'), { name: 'AbortError' }), { aborted: true })
  assert.equal(abort.code, 'GH_TIMEOUT')
  const network = appErrorFromNetwork(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }))
  assert.equal(network.code, 'GH_NETWORK')
  assert.ok(network.message.includes('ECONNREFUSED'))
})

test('GitHubClient fetches the PR list through the token+fetch transport with identity encoding', async () => {
  await withEnv('GH_TOKEN', 'token-123', async () => {
    const fetchImpl = fakeFetch([[/\/search\/issues\?/, {
      total_count: 1,
      items: [{
        number: 129,
        title: 'feat(player)',
        state: 'open',
        draft: false,
        user: { login: 'Acefake' },
        created_at: '2026-10-24T06:05:38Z',
        updated_at: '2026-10-24T06:05:38Z',
        html_url: 'https://github.com/Acefake/yingbox/pull/129',
        repository_url: 'https://api.github.com/repos/Acefake/yingbox',
        pull_request: { head: { ref: 'feat/intro-detect' }, base: { ref: 'feat/skip-intro' } },
      }],
    }]])
    const client = makeClient({}, fetchImpl)
    const list = await client.listPullRequests({ query: 'is:open author:@me', limit: 30 })
    assert.equal(list.totalCount, 1)
    assert.equal(list.items[0].repo, 'Acefake/yingbox')
    assert.equal(list.query, 'is:open author:@me')
    assert.equal(fetchImpl.calls.length, 1)
    const { url, init } = fetchImpl.calls[0]
    assert.ok(url.includes('q=is%3Aopen%20author%3A%40me%20is%3Apr'))
    assert.equal(init.headers['accept-encoding'], 'identity')
    assert.equal(init.headers.authorization, 'Bearer token-123')
    assert.equal(init.headers['user-agent'], 'dsh-codex-review')
    assert.equal(init.headers['x-github-api-version'], '2022-11-28')
    // second call is served from cache
    await client.listPullRequests({ query: 'is:open author:@me', limit: 30 })
    assert.equal(fetchImpl.calls.length, 1)
    assert.equal(await client.ghStatus(), 'ok')
  })
})

test('GitHubClient retries a 401 once after refreshing the token', async () => {
  const tokens = ['stale-token', 'fresh-token']
  let tokenCall = 0
  const execFileImpl = async (file, args) => {
    assert.deepEqual(args, ['auth', 'token'])
    const token = tokens[tokenCall]
    tokenCall += 1
    return { stdout: `${token}\n`, stderr: '' }
  }
  let attempt = 0
  const fetchImpl = async () => {
    attempt += 1
    if (attempt === 1) return responseOf({ message: 'Bad credentials' }, 401)
    return responseOf({ total_count: 0, items: [] })
  }
  const client = makeClient({}, fetchImpl, execFileImpl)
  await withEnv('GH_TOKEN', undefined, async () => {
    await withEnv('GITHUB_TOKEN', undefined, async () => {
      const list = await client.listPullRequests({ query: 'x', limit: 1 })
      assert.deepEqual(list.items, [])
    })
  })
  assert.equal(attempt, 2)
  assert.equal(tokenCall, 2)
})

test('GitHubClient falls back to the gh CLI when no token can be obtained', async () => {
  const calls = []
  const execFileImpl = async (file, args) => {
    calls.push(args)
    if (args[0] === 'auth') {
      throw Object.assign(new Error('not logged in'), { code: 4, stderr: 'You are not logged into any GitHub hosts. To log in, run: gh auth login' })
    }
    if (args[0] === 'api') {
      return { stdout: JSON.stringify([{ number: 5, state: 'open', user: { login: 'u' }, head: { ref: 'feat/base' }, base: { ref: 'main' }, merged_at: null }]), stderr: '' }
    }
    throw new Error(`unexpected gh ${args.join(' ')}`)
  }
  const client = makeClient({}, async () => { throw new Error('fetch must not be used') }, execFileImpl)
  await withEnv('GH_TOKEN', undefined, async () => {
    await withEnv('GITHUB_TOKEN', undefined, async () => {
      assert.equal(await client.ghStatus(), 'not-logged-in')
      const parents = await client.loadStack('o', 'r', 'feat/base', 'base: `feat/base`')
      assert.equal(parents.chain.length, 1)
      assert.equal(parents.chain[0].number, 5)
      assert.equal(parents.allBaseMerged, false)
    })
  })
  assert.ok(calls.some((args) => args[0] === 'api' && args[1].includes('/pulls?head=')))
})

test('GitHubClient reports GH_MISSING when gh is not installed and no env token exists', async () => {
  const execFileImpl = async () => {
    throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' })
  }
  const client = makeClient({}, async () => responseOf({}), execFileImpl)
  await withEnv('GH_TOKEN', undefined, async () => {
    await withEnv('GITHUB_TOKEN', undefined, async () => {
      assert.equal(await client.ghStatus(), 'missing')
      await assert.rejects(client.listPullRequests({ query: 'x', limit: 1 }), (error) => error.code === 'GH_MISSING')
    })
  })
})

test('GitHubClient normalizes a full PR detail (files, checks, comments, stack)', async () => {
  await withEnv('GH_TOKEN', 'token-123', async () => {
    const pull = {
      number: 129,
      title: 'feat(player): 自动检测片头片尾',
      body: 'stacked PR：base 为 `feat/skip-intro`，基于 #117',
      user: { login: 'Acefake' },
      draft: false,
      state: 'open',
      merged_at: null,
      created_at: '2026-10-24T06:05:38Z',
      updated_at: '2026-10-24T06:05:38Z',
      head: { sha: 'f31cec5c712d', ref: 'feat/intro-detect' },
      base: { ref: 'feat/skip-intro' },
      review_decision: null,
      additions: 2117,
      deletions: 25,
      changed_files: 2,
      html_url: 'https://github.com/Acefake/yingbox/pull/129',
      comments: 1,
      review_comments: 2,
    }
    const fetchImpl = fakeFetch([
      [/\/repos\/Acefake\/yingbox\/pulls\/129\/files\?per_page=100&page=1$/, [
        { filename: 'src/a.ts', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1 +1 @@\n-a\n+b' },
        { filename: 'tests/b.test.ts', status: 'added', additions: 2, deletions: 0, patch: '@@ -0,0 +1,2 @@\n+x\n+y' },
      ]],
      [/\/repos\/Acefake\/yingbox\/issues\/129\/comments\?per_page=20$/, [{ user: { login: 'u1' }, body: 'hello', created_at: 'c' }]],
      [/\/repos\/Acefake\/yingbox\/pulls\/129\/reviews\?per_page=20$/, [{ user: { login: 'u2' }, state: 'APPROVED', body: '' }]],
      [/\/repos\/Acefake\/yingbox\/pulls\/129\/comments\?per_page=50$/, [{ path: 'src/a.ts', line: 1, user: { login: 'u3' }, body: 'nit', created_at: 'c' }]],
      [/\/commits\/f31cec5c712d\/check-runs$/, { total_count: 0, check_runs: [] }],
      [/\/commits\/f31cec5c712d\/status$/, { state: 'pending', total_count: 0, statuses: [] }],
      [/\/pulls\?head=Acefake%3Afeat%2Fskip-intro/, [{ number: 117, title: '父 PR', state: 'open', head: { ref: 'feat/skip-intro' }, base: { ref: 'main' }, merged_at: null }]],
      [/\/pulls\?head=Acefake%3Amain/, []],
      [/\/repos\/Acefake\/yingbox\/pulls\/129$/, pull],
    ])
    const client = makeClient({ maxPatchChars: 24000, maxBodyChars: 50000 }, fetchImpl)
    const detail = await client.getPull('Acefake/yingbox', 129)
    assert.equal(detail.headSha, 'f31cec5c712d')
    assert.equal(detail.summary.number, 129)
    assert.equal(detail.summary.repo, 'Acefake/yingbox')
    assert.equal(detail.summary.author, 'Acefake')
    assert.equal(detail.summary.reviewDecision, '')
    assert.equal(detail.summary.additions, 2117)
    assert.equal(detail.files.length, 2)
    assert.equal(detail.files[0].path, 'src/a.ts')
    assert.equal(detail.files[0].patchTruncated, false)
    assert.equal(detail.filesTruncated, false)
    assert.ok(detail.body.includes('stacked PR'))
    assert.equal(detail.bodyTruncated, false)
    assert.equal(detail.comments.total, 3)
    assert.equal(detail.comments.issue.length, 1)
    assert.equal(detail.comments.reviews.length, 1)
    assert.equal(detail.comments.inline.length, 1)
    assert.equal(detail.checks.state, 'none')
    assert.equal(detail.stack.baseRefName, 'feat/skip-intro')
    assert.equal(detail.stack.declaredBase, 'feat/skip-intro')
    assert.equal(detail.stack.basePr.number, 117)
    assert.equal(detail.stack.chain.length, 1)
    assert.equal(detail.stack.allBaseMerged, false)
    const fetchCount = fetchImpl.calls.length
    const again = await client.getPull('Acefake/yingbox', 129)
    assert.equal(again.summary.number, 129)
    assert.equal(fetchImpl.calls.length, fetchCount)
  })
})

test('GitHubClient truncates an oversized patch and degrades failed checks to unknown', async () => {
  await withEnv('GH_TOKEN', 'token-123', async () => {
    const fetchImpl = async (url) => {
      if (/\/pulls\/7\/files/.test(url)) {
        return responseOf([{ filename: 'big.ts', status: 'modified', additions: 1, deletions: 1, patch: 'p'.repeat(100) }])
      }
      if (/\/pulls\/7$/.test(url)) {
        return responseOf({ number: 7, title: 't', state: 'open', head: { sha: 's', ref: 'h' }, base: { ref: 'main' }, merged_at: null, comments: 0, review_comments: 0, body: '这是一个很长的正文' })
      }
      if (/\/issues\/7\/comments|\/pulls\/7\/reviews|\/pulls\/7\/comments/.test(url)) return responseOf([])
      return responseOf({ message: 'boom' }, 500)
    }
    const client = makeClient({ maxPatchChars: 10, maxBodyChars: 5 }, fetchImpl)
    const detail = await client.getPull('o/r', 7)
    assert.equal(detail.files[0].patch.length, 10)
    assert.equal(detail.files[0].patchTruncated, true)
    assert.equal(detail.body, '这是一个很')
    assert.equal(detail.bodyTruncated, true)
    assert.equal(detail.checks.state, 'unknown')
  })
})
