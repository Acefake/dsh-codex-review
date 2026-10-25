/**
 * Unit tests for the GitHub data channel: normalization, truncation, error
 * mapping, caching and both transports (fake fetch / fake execFile).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  GUIDELINE_MAX_CHARS,
  GUIDELINE_PATHS,
  GitHubClient,
  LruCache,
  MAX_TOTAL_PATCH_CHARS,
  appErrorFromGh,
  appErrorFromNetwork,
  applyPatchBudget,
  buildStack,
  decodeContentsPayload,
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

// ---------------------------------------------------------------------------
// v1.1: repository review guidelines (AGENTS.md) — CONTRACT §4.4.
// ---------------------------------------------------------------------------

/**
 * Encode a UTF-8 string the way the contents API does (base64, line-wrapped).
 * @param {string} text - file content.
 * @returns {string} base64 payload.
 */
function base64Content(text) {
  return Buffer.from(text, 'utf8').toString('base64').replace(/(.{60})/g, '$1\n')
}

test('decodeContentsPayload decodes base64 files, tolerates plain text and rejects non-files', () => {
  const text = '第一行\nsecond line'
  assert.equal(decodeContentsPayload({ type: 'file', encoding: 'base64', content: base64Content(text) }), text)
  assert.equal(decodeContentsPayload({ type: 'dir', encoding: 'base64', content: base64Content(text) }), '')
  assert.equal(decodeContentsPayload({ type: 'file', encoding: 'base64', content: '' }), '')
  assert.equal(decodeContentsPayload({ type: 'file', encoding: 'utf8', content: 'plain text' }), 'plain text')
  assert.equal(decodeContentsPayload(null), '')
  assert.equal(decodeContentsPayload({}), '')
})

test('GitHubClient loads AGENTS.md from both locations, truncates the total and caches per repo', async () => {
  assert.deepEqual([...GUIDELINE_PATHS], ['AGENTS.md', '.github/AGENTS.md'])
  await withEnv('GH_TOKEN', 'token-123', async () => {
    const rootText = '根指引\n'
    const githubText = '## GitHub 约定\n- 必须使用 X\n'
    const fetchImpl = fakeFetch([
      [/\/repos\/Acme\/repo\/contents\/AGENTS\.md$/, { type: 'file', encoding: 'base64', content: base64Content(rootText) }],
      [/\/repos\/Acme\/repo\/contents\/\.github\/AGENTS\.md$/, { type: 'file', encoding: 'base64', content: base64Content(githubText) }],
    ])
    const client = makeClient({}, fetchImpl)
    const guidelines = await client.getGuidelines('Acme/repo')
    assert.equal(guidelines.loaded, true)
    assert.deepEqual(guidelines.files, ['AGENTS.md', '.github/AGENTS.md'])
    assert.equal(guidelines.chars, rootText.trim().length + githubText.trim().length)
    assert.equal(guidelines.text.length, guidelines.chars + 2)
    assert.ok(guidelines.text.startsWith('根指引'))
    assert.ok(guidelines.text.includes('必须使用 X'))
    assert.equal(fetchImpl.calls.length, 2)
    assert.ok(fetchImpl.calls[0].url.includes('/contents/AGENTS.md'))
    assert.ok(fetchImpl.calls[1].url.includes('/contents/.github/AGENTS.md'))

    // Repo-level cache: a second lookup makes no request.
    const again = await client.getGuidelines('Acme/repo')
    assert.deepEqual(again, guidelines)
    assert.equal(fetchImpl.calls.length, 2)
  })
})

test('GitHubClient caps the injected guideline text at 4000 characters in total', async () => {
  await withEnv('GH_TOKEN', 'token-123', async () => {
    const rootText = 'A'.repeat(GUIDELINE_MAX_CHARS + 500)
    const fetchImpl = fakeFetch([
      [/\/repos\/Acme\/repo\/contents\/AGENTS\.md$/, { type: 'file', encoding: 'base64', content: base64Content(rootText) }],
      [/\/repos\/Acme\/repo\/contents\/\.github\/AGENTS\.md$/, { type: 'file', encoding: 'base64', content: base64Content('不应被读取') }],
    ])
    const client = makeClient({}, fetchImpl)
    const guidelines = await client.getGuidelines('Acme/repo')
    assert.equal(guidelines.loaded, true)
    assert.deepEqual(guidelines.files, ['AGENTS.md'])
    assert.equal(guidelines.chars, GUIDELINE_MAX_CHARS)
    assert.equal(guidelines.text.length, GUIDELINE_MAX_CHARS)
    // The budget is exhausted by the first file: the second is not fetched.
    assert.equal(fetchImpl.calls.length, 1)

    // Remaining budget is filled by the second file.
    const partialFetch = fakeFetch([
      [/\/repos\/Acme\/repo\/contents\/AGENTS\.md$/, { type: 'file', encoding: 'base64', content: base64Content('B'.repeat(GUIDELINE_MAX_CHARS - 10)) }],
      [/\/repos\/Acme\/repo\/contents\/\.github\/AGENTS\.md$/, { type: 'file', encoding: 'base64', content: base64Content('C'.repeat(100)) }],
    ])
    const partialClient = makeClient({}, partialFetch)
    const partialGuidelines = await partialClient.getGuidelines('Acme/repo')
    assert.deepEqual(partialGuidelines.files, ['AGENTS.md', '.github/AGENTS.md'])
    assert.equal(partialGuidelines.chars, GUIDELINE_MAX_CHARS)
    assert.ok(partialGuidelines.text.endsWith('C'.repeat(10)))
  })
})

test('GitHubClient treats missing guidelines as empty and never throws', async () => {
  await withEnv('GH_TOKEN', 'token-123', async () => {
    const calls = []
    const notFound = async (url) => {
      calls.push(url)
      return responseOf({ message: 'Not Found' }, 404)
    }
    const client = makeClient({}, notFound)
    const guidelines = await client.getGuidelines('Acme/repo')
    assert.deepEqual(guidelines, { loaded: false, files: [], chars: 0, text: '' })
    assert.equal(calls.length, 2)
    // The negative result is cached for the repository too.
    await client.getGuidelines('Acme/repo')
    assert.equal(calls.length, 2)

    // One failing location must not hide the other.
    const partial = async (url) => {
      calls.push(url)
      if (url.includes('/contents/AGENTS.md')) return responseOf({ message: 'boom' }, 500)
      return responseOf({ type: 'file', encoding: 'base64', content: base64Content('- 使用 X') })
    }
    const partialClient = makeClient({}, partial)
    const partialGuidelines = await partialClient.getGuidelines('Acme/repo')
    assert.equal(partialGuidelines.loaded, true)
    assert.deepEqual(partialGuidelines.files, ['.github/AGENTS.md'])
    assert.equal(partialGuidelines.chars, '- 使用 X'.length)

    // A deadline-aborted lookup must not be cached as "no guidelines".
    const ac = new AbortController()
    ac.abort()
    const abortCalls = []
    const abortFetch = async (url) => {
      abortCalls.push(url)
      return responseOf({ type: 'file', encoding: 'base64', content: base64Content('- 指引') })
    }
    const abortClient = makeClient({}, abortFetch)
    const aborted = await abortClient.getGuidelines('Acme/repo', { signal: ac.signal })
    assert.equal(aborted.loaded, true)
    assert.equal(abortCalls.length, 2)
    const retried = await abortClient.getGuidelines('Acme/repo')
    assert.equal(retried.loaded, true)
    assert.equal(abortCalls.length, 4)
  })
})

test('GitHubClient reads guidelines through the gh CLI fallback when no token exists', async () => {
  const calls = []
  const execFileImpl = async (file, args) => {
    calls.push(args)
    if (args[0] === 'auth') {
      throw Object.assign(new Error('not logged in'), { code: 4, stderr: 'You are not logged into any GitHub hosts. To log in, run: gh auth login' })
    }
    if (args[0] === 'api') {
      assert.ok(args[1].includes('/contents/'))
      return { stdout: JSON.stringify({ type: 'file', encoding: 'base64', content: base64Content('CLI 指引') }), stderr: '' }
    }
    throw new Error(`unexpected gh ${args.join(' ')}`)
  }
  const client = makeClient({}, async () => { throw new Error('fetch must not be used') }, execFileImpl)
  await withEnv('GH_TOKEN', undefined, async () => {
    await withEnv('GITHUB_TOKEN', undefined, async () => {
      const guidelines = await client.getGuidelines('o/r')
      assert.equal(guidelines.loaded, true)
      assert.deepEqual(guidelines.files, ['AGENTS.md', '.github/AGENTS.md'])
      assert.ok(guidelines.text.includes('CLI 指引'))
    })
  })
  assert.ok(calls.some((args) => args[0] === 'api' && args[1].includes('contents/AGENTS.md')))
})

// ---------------------------------------------------------------------------
// v2.2: publishing a PR review (CONTRACT §7.2)
// ---------------------------------------------------------------------------

test('createPullReview posts event COMMENT, inline comments and the head commit without caching', async () => {
  await withEnv('GH_TOKEN', 'token-123', async () => {
    const calls = []
    const fetchImpl = async (url, init) => {
      calls.push({ url, method: init.method, headers: init.headers, body: init.body === undefined ? undefined : JSON.parse(init.body) })
      return responseOf({ id: 77, html_url: 'https://github.com/Acme/repo/pull/1#pullrequestreview-77' })
    }
    const client = makeClient({}, fetchImpl)
    let invalidated = 0
    client.invalidatePullCache = () => {
      invalidated += 1
      return 0
    }
    const request = {
      repo: 'Acme/repo',
      number: 1,
      headSha: 'sha-1',
      body: '摘要',
      comments: [{ path: 'src/a.ts', line: 2, side: 'RIGHT', body: '**[P0] x**' }],
    }
    const result = await client.createPullReview(request)
    assert.deepEqual(result, { reviewId: 77, url: 'https://github.com/Acme/repo/pull/1#pullrequestreview-77', data: { id: 77, html_url: 'https://github.com/Acme/repo/pull/1#pullrequestreview-77' } })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].method, 'POST')
    assert.ok(calls[0].url.endsWith('/repos/Acme/repo/pulls/1/reviews'))
    assert.equal(calls[0].headers['content-type'], 'application/json')
    assert.deepEqual(calls[0].body, {
      event: 'COMMENT',
      body: '摘要',
      comments: [{ path: 'src/a.ts', line: 2, side: 'RIGHT', body: '**[P0] x**' }],
      commit_id: 'sha-1',
    })
    await client.createPullReview(request)
    assert.equal(calls.length, 2, 'a write must never be served from the cache')
    assert.equal(invalidated, 2, 'a published review invalidates the PR detail cache')
  })
})

test('createPullReview validates its content and maps GitHub failures', async () => {
  await withEnv('GH_TOKEN', 'token-123', async () => {
    /** @type {Array<(url: string, init: any) => any>} */
    const responders = []
    const fetchImpl = async (url, init) => responders.shift()(url, init)
    const client = makeClient({}, fetchImpl)

    // Nothing to publish: rejected before any request.
    await assert.rejects(client.createPullReview({ repo: 'Acme/repo', number: 1, comments: [] }), (error) => error.code === 'BAD_REQUEST')
    await assert.rejects(client.createPullReview({ repo: 'Acme/repo', number: 0, body: 'x' }), (error) => error.code === 'BAD_REQUEST')

    for (const [status, code] of [[422, 'BAD_REQUEST'], [403, 'GH_FORBIDDEN'], [429, 'GH_RATE_LIMIT'], [404, 'GH_NOT_FOUND'], [500, 'PUBLISH_UNKNOWN']]) {
      responders.push(() => responseOf({ message: `HTTP ${status}` }, status))
      await assert.rejects(client.createPullReview({ repo: 'Acme/repo', number: 1, body: 'x' }), (error) => {
        assert.equal(error.code, code)
        return true
      })
    }
    responders.push(() => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
    })
    await assert.rejects(client.createPullReview({ repo: 'Acme/repo', number: 1, body: 'x' }), (error) => error.code === 'GH_NETWORK')
  })
})

test('createPullReview falls back to gh api with --input for structured bodies', async () => {
  const calls = []
  const execFileImpl = async (file, args) => {
    calls.push(args)
    if (args[0] === 'auth') {
      throw Object.assign(new Error('not logged in'), { code: 4, stderr: 'You are not logged into any GitHub hosts. To log in, run: gh auth login' })
    }
    if (args[0] !== 'api') throw new Error(`unexpected gh ${args.join(' ')}`)
    return { stdout: JSON.stringify({ id: 88, html_url: 'https://github.com/Acme/repo/pull/1#pullrequestreview-88' }), stderr: '' }
  }
  const client = makeClient({}, async () => { throw new Error('fetch must not be used') }, execFileImpl)
  await withEnv('GH_TOKEN', undefined, async () => {
    await withEnv('GITHUB_TOKEN', undefined, async () => {
      const result = await client.createPullReview({
        repo: 'Acme/repo',
        number: 1,
        headSha: 'sha-1',
        comments: [{ path: 'src/a.ts', line: 2, side: 'RIGHT', body: 'x' }],
      })
      assert.equal(result.reviewId, 88)
    })
  })
  const apiArgs = calls.find((args) => args[0] === 'api')
  assert.ok(apiArgs.includes('--method'))
  assert.ok(apiArgs.includes('POST'))
  assert.ok(apiArgs.includes('--input'), 'structured bodies go through --input')
  assert.ok(!apiArgs.includes('-f'), '-f cannot express nested comment arrays')
})

test('listPullReviewComments paginates and normalizes existing comments', async () => {
  await withEnv('GH_TOKEN', 'token-123', async () => {
    const urls = []
    const fetchImpl = async (url) => {
      urls.push(url)
      if (url.endsWith('&page=1')) {
        return responseOf(Array.from({ length: 100 }, (_, index) => ({
          path: 'src/a.ts',
          line: index + 1,
          body: `comment ${index}`,
          user: { login: 'reviewer' },
          created_at: '2026-10-24T00:00:00Z',
        })))
      }
      return responseOf([{ path: 'src/b.ts', line: null, original_line: 7, body: 'tail', user: { login: 'u2' }, created_at: 'c' }])
    }
    const client = makeClient({}, fetchImpl)
    const comments = await client.listPullReviewComments('Acme/repo', 1)
    assert.equal(comments.length, 101)
    assert.deepEqual(comments[0], { path: 'src/a.ts', line: 1, body: 'comment 0', author: 'reviewer', createdAt: '2026-10-24T00:00:00Z' })
    assert.equal(comments[100].line, 7, 'falls back to original_line')
    assert.equal(urls.length, 2)
    assert.ok(urls[0].includes('/pulls/1/comments?per_page=100&page=1'))
    assert.ok(urls[1].includes('/pulls/1/comments?per_page=100&page=2'))
  })
})

test('updatePullReview replaces the review body in place, invalidates the cache and maps failures', async () => {
  await withEnv('GH_TOKEN', 'token-123', async () => {
    const calls = []
    const fetchImpl = async (url, init) => {
      calls.push({ url, init })
      return responseOf({ id: 77, html_url: 'https://github.com/Acme/repo/pull/1#pullrequestreview-77' })
    }
    const client = makeClient({}, fetchImpl)
    let invalidated = 0
    client.invalidatePullCache = () => {
      invalidated += 1
      return 0
    }

    // Validation happens before any request.
    await assert.rejects(client.updatePullReview({ repo: 'Acme/repo', number: 1, reviewId: 0, body: 'x' }), (error) => error.code === 'BAD_REQUEST')
    await assert.rejects(client.updatePullReview({ repo: 'Acme/repo', number: 1, reviewId: 7, body: '   ' }), (error) => error.code === 'BAD_REQUEST')
    assert.equal(calls.length, 0)

    const result = await client.updatePullReview({ repo: 'Acme/repo', number: 1, reviewId: 77, body: '新摘要' })
    assert.deepEqual(result, { reviewId: 77, url: 'https://github.com/Acme/repo/pull/1#pullrequestreview-77' })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].init.method, 'PUT')
    assert.ok(calls[0].url.endsWith('/repos/Acme/repo/pulls/1/reviews/77'))
    assert.deepEqual(JSON.parse(calls[0].init.body), { body: '新摘要' })
    assert.equal(invalidated, 1, 'an edited review invalidates the PR detail cache')

    // Failures use the same contract codes as a create.
    for (const [status, code] of [[422, 'BAD_REQUEST'], [403, 'GH_FORBIDDEN'], [429, 'GH_RATE_LIMIT'], [404, 'GH_NOT_FOUND'], [500, 'PUBLISH_UNKNOWN']]) {
      const failing = makeClient({}, async () => responseOf({ message: `HTTP ${status}` }, status))
      await assert.rejects(failing.updatePullReview({ repo: 'Acme/repo', number: 1, reviewId: 77, body: 'x' }), (error) => error.code === code)
    }
  })
})

test('listPullReviews normalizes submitted reviews and is never cached', async () => {
  await withEnv('GH_TOKEN', 'token-123', async () => {
    const urls = []
    const fetchImpl = async (url) => {
      urls.push(url)
      return responseOf([
        { id: 7, body: '**代码审查**', html_url: 'https://github.com/Acme/repo/pull/1#pullrequestreview-7', user: { login: 'bot' }, state: 'COMMENTED', submitted_at: '2026-10-25T00:00:00Z' },
        { id: 8, body: '', user: { login: 'bot' }, state: 'PENDING' },
        { id: null, body: 'bad id' },
      ])
    }
    const client = makeClient({}, fetchImpl)
    const first = await client.listPullReviews('Acme/repo', 1)
    assert.deepEqual(first[0], {
      id: 7,
      body: '**代码审查**',
      url: 'https://github.com/Acme/repo/pull/1#pullrequestreview-7',
      author: 'bot',
      state: 'COMMENTED',
      submittedAt: '2026-10-25T00:00:00Z',
    })
    assert.equal(first[1].url, '')
    assert.equal(first[1].state, 'PENDING')
    assert.equal(first[2].id, null)
    const second = await client.listPullReviews('Acme/repo', 1)
    assert.equal(second.length, 3)
    assert.equal(urls.length, 2, 'reviews are read uncached (only used for recovery)')
    assert.ok(urls[0].includes('/pulls/1/reviews?per_page=100'))
    await assert.rejects(client.listPullReviews('Acme/repo', 0), (error) => error.code === 'BAD_REQUEST')
  })
})

// ---------------------------------------------------------------------------
// v2.3: comment writes (CONTRACT §8)
// ---------------------------------------------------------------------------

test('inline comments carry ids and the GraphQL thread map is merged', async () => {
  await withEnv('GH_TOKEN', 'token-123', async () => {
    const fetchImpl = async (url) => {
      if (url.includes('/pulls/1/comments?')) {
        return responseOf([{ id: 11, in_reply_to_id: 10, pull_request_review_id: 7, path: 'a.ts', line: 3, body: 'hi', user: { login: 'x' }, created_at: 'c' }])
      }
      if (url.endsWith('/graphql')) {
        return responseOf({ data: { repository: { pullRequest: { reviewThreads: { nodes: [{ id: 'THREAD_1', isResolved: false, comments: { nodes: [{ databaseId: 11 }] } }] } } } } })
      }
      return responseOf({})
    }
    const client = makeClient({}, fetchImpl)
    const inline = await client.loadInlineComments('Acme', 'repo', 1)
    assert.equal(inline[0].id, 11)
    assert.equal(inline[0].inReplyToId, 10)
    assert.equal(inline[0].reviewId, 7)
    const threads = await client.loadReviewThreads('Acme', 'repo', 1)
    assert.deepEqual(threads[11], { threadId: 'THREAD_1', isResolved: false })
  })
})

test('comment writes post the body and invalidate the PR detail cache', async () => {
  await withEnv('GH_TOKEN', 'token-123', async () => {
    const calls = []
    const fetchImpl = async (url, init) => {
      calls.push({ url, init })
      if (url.includes('/issues/1/comments')) {
        return responseOf({ id: 5, html_url: 'https://github.com/Acme/repo/issues/1#issuecomment-5', created_at: '2026-10-25T00:00:00Z' })
      }
      if (url.includes('/pulls/1/comments/9/replies')) {
        return responseOf({ id: 6, html_url: 'https://github.com/Acme/repo/pull/1#discussion_r6', created_at: '2026-10-25T00:00:00Z' })
      }
      return responseOf({})
    }
    const client = makeClient({}, fetchImpl)
    const issue = await client.createIssueComment({ repo: 'Acme/repo', number: 1, body: 'hello' })
    assert.deepEqual(issue, { id: 5, url: 'https://github.com/Acme/repo/issues/1#issuecomment-5', createdAt: '2026-10-25T00:00:00Z' })
    const issueCall = calls.find((call) => call.url.includes('/issues/1/comments'))
    assert.equal(issueCall.init.method, 'POST')
    assert.deepEqual(JSON.parse(issueCall.init.body), { body: 'hello' })

    const reply = await client.replyToReviewComment({ repo: 'Acme/repo', number: 1, commentId: 9, body: 'thanks' })
    assert.equal(reply.id, 6)
    const replyCall = calls.find((call) => call.url.includes('/pulls/1/comments/9/replies'))
    assert.equal(replyCall.init.method, 'POST')
    assert.deepEqual(JSON.parse(replyCall.init.body), { body: 'thanks' })
  })
})

test('comment writes validate their payload before touching the network', async () => {
  const client = makeClient({}, async () => {
    throw new Error('network must not be used')
  })
  await assert.rejects(client.createIssueComment({ repo: 'Acme/repo', number: 1, body: '   ' }), (error) => error.code === 'BAD_REQUEST')
  await assert.rejects(client.createIssueComment({ repo: 'Acme/repo', number: 1, body: 'x'.repeat(4001) }), (error) => error.code === 'BAD_REQUEST')
  await assert.rejects(client.createIssueComment({ repo: 'not-a-repo', number: 1, body: 'x' }), (error) => error.code === 'BAD_REQUEST')
  await assert.rejects(client.replyToReviewComment({ repo: 'Acme/repo', number: 1, commentId: 0, body: 'x' }), (error) => error.code === 'BAD_REQUEST')
  await assert.rejects(client.replyToReviewComment({ repo: 'Acme/repo', number: 1, commentId: -2, body: 'x' }), (error) => error.code === 'BAD_REQUEST')
  await assert.rejects(client.resolveReviewThread({ repo: 'Acme/repo', number: 1, threadId: '' }), (error) => error.code === 'BAD_REQUEST')
  await assert.rejects(client.resolveReviewThread({ repo: 'Acme/repo', number: 1, threadId: 'x'.repeat(201) }), (error) => error.code === 'BAD_REQUEST')
})

test('resolveReviewThread runs the GraphQL mutation and reports resolution', async () => {
  await withEnv('GH_TOKEN', 'token-123', async () => {
    /** @type {any} */
    let sent
    const fetchImpl = async (url, init) => {
      assert.ok(url.endsWith('/graphql'))
      sent = JSON.parse(init.body)
      return responseOf({ data: { resolveReviewThread: { thread: { id: 'THREAD_1', isResolved: true } } } })
    }
    const client = makeClient({}, fetchImpl)
    const result = await client.resolveReviewThread({ repo: 'Acme/repo', number: 1, threadId: 'THREAD_1' })
    assert.deepEqual(result, { resolved: true })
    assert.ok(sent.query.includes('resolveReviewThread'))
    assert.deepEqual(sent.variables, { threadId: 'THREAD_1' })
  })
})

test('a GraphQL error array maps onto a stable code', async () => {
  await withEnv('GH_TOKEN', 'token-123', async () => {
    const fetchImpl = async () => responseOf({ errors: [{ type: 'FORBIDDEN', message: 'Resource not accessible by integration' }] })
    const client = makeClient({}, fetchImpl)
    await assert.rejects(client.resolveReviewThread({ repo: 'Acme/repo', number: 1, threadId: 'T' }), (error) => {
      assert.equal(error.code, 'GH_FORBIDDEN')
      return true
    })
  })
})

