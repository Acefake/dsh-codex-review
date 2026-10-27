/**
 * Unit tests for the GitLab read-only channel: normalization, pagination,
 * error mapping and the health probe. No network is used.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  GITLAB_REPO_RE,
  GitLabClient,
  countDiffLines,
  httpStatusToGlCode,
  isValidGitlabRepo,
  normalizeGitLabChecks,
  normalizeGitLabDiscussions,
  normalizeGitLabFile,
  normalizeGitLabSummary,
} from '../lib/gitlab.js'

/** Build a fetch-like response. */
function response(body, { status = 200, headers = {} } = {}) {
  const normalized = {}
  for (const [key, value] of Object.entries(headers)) normalized[key.toLowerCase()] = String(value)
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => normalized[String(name).toLowerCase()] ?? null },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  }
}

/** Wire a client whose fetch routes by URL substring. */
function makeClient(routes, config = {}) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    for (const [match, handler] of routes) {
      if (url.includes(match)) return handler(url)
    }
    return response({ message: 'not found' }, { status: 404 })
  }
  const client = new GitLabClient({
    config: { gitlabBaseUrl: 'http://gitlab.local', gitlabToken: 'token', ...config },
    fetchImpl,
  })
  return { client, calls }
}

const MR_LIST_ITEM = {
  iid: 7,
  title: 'feat: demo',
  state: 'opened',
  source_branch: 'feat/demo',
  target_branch: 'main',
  author: { username: 'shims', avatar_url: 'http://a' },
  work_in_progress: true,
  web_url: 'http://gitlab.local/mdesign/beijing/jinghang-project/-/merge_requests/7',
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-02T00:00:00Z',
  references: { full: 'mdesign/beijing/jinghang-project!7' },
}

const MR_DETAIL = {
  iid: 7,
  title: 'feat: demo',
  description: 'body text',
  state: 'opened',
  source_branch: 'feat/demo',
  target_branch: 'main',
  author: { username: 'shims' },
  work_in_progress: false,
  web_url: 'http://gitlab.local/mdesign/beijing/jinghang-project/-/merge_requests/7',
  sha: 'abc123',
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-02T00:00:00Z',
  references: { full: 'mdesign/beijing/jinghang-project!7' },
}

const CHANGES = {
  changes: [
    {
      old_path: 'src/a.ts',
      new_path: 'src/a.ts',
      new_file: false,
      deleted_file: false,
      renamed_file: false,
      diff: '@@ -1,2 +1,3 @@\n context\n+added\n-removed',
    },
  ],
  overflow: false,
}

const DISCUSSIONS = [
  {
    id: 'd1',
    notes: [
      { id: 1, body: 'general comment', author: { username: 'u' }, created_at: '2026-10-01T00:00:00Z', system: false },
      {
        id: 2,
        body: 'inline comment',
        author: { username: 'u' },
        created_at: '2026-10-01T00:00:00Z',
        system: false,
        resolved: false,
        position: { new_path: 'src/a.ts', new_line: 3, old_path: 'src/a.ts', old_line: 2 },
      },
    ],
  },
]

test('listPullRequests normalizes MRs and ignores GitHub-style query text', async () => {
  const { client, calls } = makeClient([
    ['/merge_requests?', () => response([MR_LIST_ITEM], { headers: { 'x-total': '1' } })],
  ])
  const page = await client.listPullRequests({ query: 'is:open author:@me', limit: 10 })
  assert.equal(page.totalCount, 1)
  assert.equal(page.items.length, 1)
  const item = page.items[0]
  assert.equal(item.repo, 'mdesign/beijing/jinghang-project')
  assert.equal(item.number, 7)
  assert.equal(item.isDraft, true)
  assert.equal(item.state, 'open')
  assert.equal(item.author, 'shims')
  assert.match(calls[0].url, /scope=created_by_me/)
  assert.doesNotMatch(calls[0].url, /search=/)
})

test('listPullRequests passes plain text as the GitLab search parameter', async () => {
  const { client, calls } = makeClient([
    ['/merge_requests?', () => response([], { headers: { 'x-total': '0' } })],
  ])
  await client.listPullRequests({ query: 'login bug', limit: 5 })
  assert.match(calls[0].url, /search=login%20bug/)
})

test('listPullRequests keeps plain keywords that contain a colon', async () => {
  const { client, calls } = makeClient([
    ['/merge_requests?', () => response([], { headers: { 'x-total': '0' } })],
  ])
  await client.listPullRequests({ query: 'fix: crash', limit: 5 })
  assert.match(calls[0].url, /search=fix%3A%20crash/)
})

test('getPull normalizes detail, changes, discussions, approvals and pipelines', async () => {
  const { client, calls } = makeClient([
    ['/merge_requests/7/changes', () => response(CHANGES)],
    ['/merge_requests/7/discussions', () => response(DISCUSSIONS)],
    ['/merge_requests/7/approvals', () => response({ approved: true, approved_by: [{ user: { username: 'shims' } }] })],
    ['/merge_requests/7/pipelines', () => response([{ id: 9, status: 'success', web_url: 'http://p/9' }])],
    ['/merge_requests/7', () => response(MR_DETAIL)],
  ])
  const detail = await client.getPull('mdesign/beijing/jinghang-project', 7)
  assert.equal(detail.headSha, 'abc123')
  assert.equal(detail.summary.repo, 'mdesign/beijing/jinghang-project')
  assert.equal(detail.summary.reviewDecision, 'APPROVED')
  assert.equal(detail.summary.additions, 1)
  assert.equal(detail.summary.deletions, 1)
  assert.equal(detail.files.length, 1)
  assert.equal(detail.files[0].path, 'src/a.ts')
  assert.equal(detail.files[0].patch.includes('+added'), true)
  assert.equal(detail.comments.issue.length, 1)
  assert.equal(detail.comments.inline.length, 1)
  assert.equal(detail.comments.inline[0].line, 3)
  assert.equal(detail.checks.state, 'success')
  assert.equal(detail.body, 'body text')
  assert.match(calls[0].url, /mdesign%2Fbeijing%2Fjinghang-project/)
})

test('discussion pagination follows x-next-page', async () => {
  const { client, calls } = makeClient([
    [
      '&page=1',
      () => response(DISCUSSIONS, { headers: { 'x-next-page': '2' } }),
    ],
    ['&page=2', () => response([], { headers: { 'x-next-page': '' } })],
    ['/merge_requests/7/changes', () => response(CHANGES)],
    ['/merge_requests/7/approvals', () => response({ approved: false })],
    ['/merge_requests/7/pipelines', () => response([])],
    ['/merge_requests/7', () => response(MR_DETAIL)],
  ])
  const detail = await client.getPull('mdesign/beijing/jinghang-project', 7)
  assert.equal(detail.comments.total, 2)
  const discussionCalls = calls.filter((call) => call.url.includes('/discussions'))
  assert.equal(discussionCalls.length, 2)
})

test('request failures map to the GL_* vocabulary', async () => {
  for (const [status, code] of [[401, 'GL_UNAUTHORIZED'], [404, 'GL_NOT_FOUND'], [500, 'GL_SERVER'], [503, 'GL_SERVER']]) {
    const { client } = makeClient([['/merge_requests?', () => response({ message: 'x' }, { status })]])
    await assert.rejects(
      () => client.listPullRequests({ limit: 1 }),
      (error) => error.code === code,
      `status ${status} should map to ${code}`,
    )
  }
})

test('missing base URL or token answers GL_MISSING_CONFIG', async () => {
  const noBase = new GitLabClient({ config: { gitlabToken: 't' }, fetchImpl: async () => response([]) })
  await assert.rejects(() => noBase.listPullRequests({ limit: 1 }), (error) => error.code === 'GL_MISSING_CONFIG')
  const noToken = new GitLabClient({ config: { gitlabBaseUrl: 'http://gitlab.local' }, fetchImpl: async () => response([]) })
  await assert.rejects(() => noToken.listPullRequests({ limit: 1 }), (error) => error.code === 'GL_MISSING_CONFIG')
})

test('status reports the token owner and degrades on failure', async () => {
  const ok = makeClient([['/user', () => response({ username: 'shims' })]])
  assert.deepEqual(await ok.client.status(), { ok: true, provider: 'gitlab', viewer: 'shims' })
  const bad = makeClient([['/user', () => response({ message: 'unauthorized' }, { status: 401 })]])
  assert.deepEqual(await bad.client.status(), { ok: false, provider: 'gitlab', viewer: '', error: 'GL_UNAUTHORIZED' })
})

test('a failing /changes read rejects instead of returning an empty diff', async () => {
  const { client } = makeClient([
    ['/merge_requests/7/changes', () => response({ message: 'boom' }, { status: 500 })],
    ['/merge_requests/7/discussions', () => response([])],
    ['/merge_requests/7/approvals', () => response({ approved: false })],
    ['/merge_requests/7/pipelines', () => response([])],
    ['/merge_requests/7', () => response(MR_DETAIL)],
  ])
  await assert.rejects(
    () => client.getPull('mdesign/beijing/jinghang-project', 7),
    (error) => error.code === 'GL_SERVER',
  )
})

test('caller abort maps to GL_ABORTED and a big change list reports filesTruncated', async () => {
  const controller = new AbortController()
  controller.abort()
  const aborted = new GitLabClient({
    config: { gitlabBaseUrl: 'http://gitlab.local', gitlabToken: 'token' },
    fetchImpl: async () => {
      const error = new Error('aborted')
      error.name = 'AbortError'
      throw error
    },
  })
  await assert.rejects(
    () => aborted.listPullRequests({ limit: 1, signal: controller.signal }),
    (error) => error.code === 'GL_ABORTED',
  )

  const manyChanges = Array.from({ length: 301 }, (_, index) => ({
    old_path: `src/f${index}.ts`,
    new_path: `src/f${index}.ts`,
    new_file: false,
    deleted_file: false,
    renamed_file: false,
    diff: '@@ -1 +1 @@\n-old\n+new',
  }))
  const { client } = makeClient([
    ['/merge_requests/7/changes', () => response({ changes: manyChanges })],
    ['/merge_requests/7/discussions', () => response([])],
    ['/merge_requests/7/approvals', () => response({ approved: false })],
    ['/merge_requests/7/pipelines', () => response([])],
    ['/merge_requests/7', () => response(MR_DETAIL)],
  ])
  const detail = await client.getPull('mdesign/beijing/jinghang-project', 7)
  assert.equal(detail.filesTruncated, true)
})

test('normalization helpers handle nested paths, drafts and pipeline states', () => {
  assert.equal(GITLAB_REPO_RE.test('mdesign/beijing/graphics-library-v2'), true)
  assert.equal(GITLAB_REPO_RE.test('mdesign'), false)
  assert.equal(GITLAB_REPO_RE.test('a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/p/q/r/s/t/u'), false)
  assert.equal(GITLAB_REPO_RE.test('bad path/repo'), false)
  assert.equal(isValidGitlabRepo('mdesign/beijing/graphics-library-v2'), true)
  assert.equal(isValidGitlabRepo('mdesign/../secret'), false)
  assert.equal(isValidGitlabRepo('mdesign/./secret'), false)
  assert.equal(isValidGitlabRepo('mdesign/-secret'), false)

  const summary = normalizeGitLabSummary({ ...MR_LIST_ITEM, work_in_progress: false, draft: true })
  assert.equal(summary.isDraft, true)

  const file = normalizeGitLabFile({ new_path: 'x', new_file: true, diff: '+a\n+b\n-c' })
  assert.equal(file.status, 'added')
  assert.equal(file.additions, 2)
  assert.equal(file.deletions, 1)

  assert.deepEqual(countDiffLines('+++ b\n--- a\n+one\n-two\n context'), { additions: 1, deletions: 1 })
  assert.deepEqual(countDiffLines('+++ b/f\n--- a/f\n++foo\n--bar'), { additions: 1, deletions: 1 })
  assert.equal(normalizeGitLabChecks([{ id: 1, status: 'failed' }]).state, 'failure')
  assert.equal(normalizeGitLabChecks([{ id: 1, status: 'skipped' }]).state, 'neutral')
  assert.equal(normalizeGitLabChecks([]).state, 'none')

  const comments = normalizeGitLabDiscussions(DISCUSSIONS)
  assert.equal(comments.issue.length, 1)
  assert.equal(comments.inline.length, 1)
  assert.equal(comments.total, 2)

  assert.equal(httpStatusToGlCode(401), 'GL_UNAUTHORIZED')
  assert.equal(httpStatusToGlCode(404), 'GL_NOT_FOUND')
  assert.equal(httpStatusToGlCode(429), 'GL_RATE_LIMIT')
  assert.equal(httpStatusToGlCode(503), 'GL_SERVER')
})
