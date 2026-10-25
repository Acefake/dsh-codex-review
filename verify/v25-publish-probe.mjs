/**
 * Read-only end-to-end probe of the v2.5 publish guards against the real GitHub
 * API. It never writes to GitHub: the two write methods are replaced by
 * tripwires that fail loudly, so any unexpected write path shows up as a FAIL.
 *
 * Run: node verify/v25-publish-probe.mjs
 */

import { GitHubClient } from '../plugin/lib/github.js'
import { ReviewPublisher, findPublishedSummaryReview, parsePublishMarkers, publishRequestKey } from '../plugin/lib/publish.js'
import { AppError } from '../plugin/lib/errors.js'

const REPO = 'Acefake/yingbox'
const NUMBER = 139

/** Real client for reads only; every write method is replaced by a tripwire. */
const github = new GitHubClient({ ghPath: 'gh' })

/**
 * Tripwire counter: increments when a code path actually reached a write. The
 * real write method is never called, so a non-zero count here proves the guard
 * under test did not stop the publish (it does not mean GitHub was written to).
 * @type {number}
 */
let writeTripwires = 0
github.createPullReview = async () => {
  writeTripwires += 1
  throw new AppError('INTERNAL', 'probe tripwire: createPullReview must not be reached')
}
github.updatePullReview = async () => {
  writeTripwires += 1
  throw new AppError('INTERNAL', 'probe tripwire: updatePullReview must not be reached')
}

const head = await github.getPullHead(REPO, NUMBER)
if (head === '') {
  console.error('cannot read the PR head; aborting')
  process.exit(2)
}

const base = { mode: 'summary', minSeverity: 'P2', maxComments: 20 }
const requestKey = publishRequestKey(base)
const summaryUrl = `https://github.com/${REPO}/pull/${NUMBER}#pullrequestreview-5641606932`

/**
 * Engine stub returning one fixed snapshot.
 * @param {any} snapshot - review snapshot.
 * @returns {any} engine.
 */
function engineWith(snapshot) {
  return { existing: () => snapshot, status: () => snapshot }
}

/** @type {Array<{ case: string, pass: boolean, detail: string }>} */
const results = []

// 1) Replay: the head already published this exact request, so nothing is sent.
const replay = await new ReviewPublisher({
  github,
  engine: engineWith({ state: 'done', headSha: head, findings: [] }),
  store: {
    get: (key) => (key === `${REPO}#${NUMBER}@${head}`
      ? { publishedAt: 1, reviewId: 5_641_606_932, url: summaryUrl, request: requestKey }
      : undefined),
    set: () => {},
  },
  logger: { warn() {} },
}).publish({ repo: REPO, number: NUMBER, confirm: true, headSha: head, ...base })
results.push({
  case: '同请求 + 已发布 head → 直接回放，0 次 GitHub 调用',
  pass: replay.action === 'unchanged' && replay.comments === 0 && replay.reviewId === 5_641_606_932 && writeTripwires === 0,
  detail: `action=${replay.action} comments=${replay.comments} reviewId=${replay.reviewId} tripwires=${writeTripwires}`,
})

// 2) A partial review is refused before any GitHub content read.
let partialCode = ''
try {
  await new ReviewPublisher({
    github,
    engine: engineWith({ state: 'done', headSha: head, partial: true, partialReasons: ['chunk 2 timeout'], findings: [] }),
    store: { get: () => undefined, set: () => {} },
    logger: { warn() {} },
  }).publish({ repo: REPO, number: NUMBER, confirm: true, headSha: head, ...base })
} catch (error) {
  partialCode = error instanceof AppError ? error.code : 'unknown'
}
results.push({
  case: 'partial 审查被拒绝（REVIEW_PARTIAL）',
  pass: partialCode === 'REVIEW_PARTIAL' && writeTripwires === 0,
  detail: `code=${partialCode} tripwires=${writeTripwires}`,
})

// 3) A publish bound to a head that is no longer the PR head is refused.
let movedCode = ''
try {
  await new ReviewPublisher({
    github,
    engine: engineWith({ state: 'done', headSha: 'deadbeefdeadbeef', findings: [] }),
    store: { get: () => undefined, set: () => {} },
    logger: { warn() {} },
  }).publish({ repo: REPO, number: NUMBER, confirm: true, headSha: 'deadbeefdeadbeef', ...base })
} catch (error) {
  movedCode = error instanceof AppError ? error.code : 'unknown'
}
results.push({
  case: '过期 head 被拒绝（REVIEW_HEAD_MOVED）',
  pass: movedCode === 'REVIEW_HEAD_MOVED' && writeTripwires === 0,
  detail: `code=${movedCode} tripwires=${writeTripwires}`,
})

// 4) A record written for a different request must not answer this one; the
//    publish then proceeds and hits the write tripwire, which proves the stale
//    record was not replayed.
const otherRequest = publishRequestKey({ ...base, mode: 'both' })
let reachedWrite = false
try {
  const result = await new ReviewPublisher({
    github,
    engine: engineWith({ state: 'done', headSha: head, findings: [] }),
    store: {
      get: (key) => (key === `${REPO}#${NUMBER}@${head}`
        ? { publishedAt: 1, reviewId: 5_641_606_932, url: summaryUrl, request: otherRequest }
        : undefined),
      set: () => {},
    },
    logger: { warn() {} },
  }).publish({ repo: REPO, number: NUMBER, confirm: true, headSha: head, ...base })
  reachedWrite = result.action !== 'unchanged'
} catch (error) {
  reachedWrite = error instanceof AppError && error.message.includes('probe tripwire')
}
results.push({
  case: '不同请求参数的旧记录不会回放（会真的走发布路径）',
  pass: reachedWrite && writeTripwires === 1,
  detail: `reachedWrite=${reachedWrite} tripwires=${writeTripwires}`,
})

// 5) Real read: the rolling summary review comes back after "state loss".
const reviews = await github.listPullReviews(REPO, NUMBER)
const mine = await github.getAuthenticatedUser()
const found = findPublishedSummaryReview(reviews, mine)
results.push({
  case: '真实 PR 上能找回唯一一条汇总 review',
  pass: found !== undefined && reviews.length > 0,
  detail: `reviews=${reviews.length} summary=${found === undefined ? 'none' : found.id}`,
})

// 6) Real read: markers only count when the author is the signed-in user.
const comments = await github.listPullReviewComments(REPO, NUMBER)
const own = parsePublishMarkers(comments, mine).size
const foreign = parsePublishMarkers(comments, 'someone-else').size
results.push({
  case: '行内 marker 只认本人评论',
  pass: own > 0 && foreign === 0,
  detail: `own=${own} foreign=${foreign} comments=${comments.length}`,
})

for (const result of results) console.log(`${result.pass ? 'PASS' : 'FAIL'}  ${result.case}  (${result.detail})`)
const failed = results.filter((result) => !result.pass).length
// Case 4 deliberately reaches the write method once (that is how it proves the
// stale record was not replayed). Every other case must leave the tripwire
// untouched, and no real write method exists on this client at all.
const unexpectedWrites = Math.max(0, writeTripwires - 1)
console.log(`\n${results.length - failed}/${results.length} passed; tripwires hit: ${writeTripwires} (1 expected), unexpected: ${unexpectedWrites}`)
process.exit(failed === 0 && unexpectedWrites === 0 ? 0 : 1)
