/**
 * Unit tests for the automatic review scheduler (CONTRACT §6): config
 * clamping/persistence, the cycle decision tree, seen cursor and retry window,
 * serial execution, cycle-level error isolation and the read-only guarantee.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AUTO_REVIEW_DEFAULTS,
  AUTO_REVIEW_RETRY_AFTER_MS,
  AutoReviewer,
  prunePublishedMap,
  resolveAutoReviewStatePath,
  sanitizeAutoReviewConfig,
  sanitizePublishedMap,
  sanitizeRecentList,
  sanitizeSeenMap,
} from '../lib/auto-review.js'
import { AppError } from '../lib/errors.js'

/** @returns {string} a fresh temp directory for one test. */
function makeTempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-auto-review-'))
}

/**
 * Deterministic clock.
 * @param {number} [start] - initial epoch ms.
 * @returns {{ now: () => number, advance: (ms: number) => void }} clock.
 */
function makeClock(start = 1_000_000) {
  let current = start
  return {
    now: () => current,
    advance: (ms) => {
      current += ms
    },
  }
}

/**
 * Fake interval scheduler.
 * @returns {{ timers: any[], setInterval: Function, clearInterval: Function, active: () => any[], fire: (index?: number) => void }} scheduler.
 */
function makeScheduler() {
  /** @type {any[]} */
  const timers = []
  let nextId = 1
  const scheduler = {
    timers,
    setInterval(callback, ms) {
      const id = nextId
      nextId += 1
      timers.push({ id, callback, ms, cleared: false })
      return id
    },
    clearInterval(id) {
      const timer = timers.find((entry) => entry.id === id)
      if (timer !== undefined) timer.cleared = true
    },
    active() {
      return timers.filter((timer) => timer.cleared !== true)
    },
    fire(index = 0) {
      const active = scheduler.active()
      if (active[index] !== undefined) active[index].callback()
    },
  }
  return scheduler
}

/**
 * One search-result item.
 * @param {number} number - PR number.
 * @param {Record<string, unknown>} [overrides] - field overrides.
 * @returns {any} list item.
 */
function makeItem(number, overrides = {}) {
  return { repo: 'Acme/repo', number, title: `PR ${number}`, author: 'me', state: 'open', isDraft: false, ...overrides }
}

/**
 * One normalized PR detail.
 * @param {string} headSha - head commit.
 * @param {Record<string, unknown>} [overrides] - field overrides.
 * @returns {any} detail.
 */
function makeDetail(headSha, overrides = {}) {
  return {
    headSha,
    summary: {
      repo: 'Acme/repo',
      number: 1,
      title: '自动检测',
      author: 'me',
      state: 'open',
      isDraft: false,
      headRefName: 'feat/x',
      baseRefName: 'main',
      additions: 10,
      deletions: 2,
      changedFiles: 1,
    },
    body: 'PR 正文',
    files: [{ path: 'src/a.ts', patch: '@@ -1 +1 @@\n-a\n+b', status: 'modified', additions: 1, deletions: 1, patchTruncated: false }],
    ...overrides,
  }
}

/**
 * Fake GitHub client that records every call. Write methods exist only so the
 * tests can prove they are never called.
 * @param {{ items?: any[], details?: Record<number, any>, listError?: Error }} [options] - fixtures.
 * @returns {any} fake client.
 */
function makeGithub(options = {}) {
  const calls = { list: [], pulls: [], guidelines: [], writes: 0 }
  return {
    calls,
    async listPullRequests(input) {
      calls.list.push(input)
      if (options.listError !== undefined) throw options.listError
      const items = options.items ?? []
      return { query: input.query, totalCount: items.length, items }
    },
    async getPull(repo, number) {
      calls.pulls.push(`${repo}#${number}`)
      const detail = options.details?.[number]
      if (detail instanceof Error) throw detail
      return detail ?? makeDetail(`sha-${number}`)
    },
    async getGuidelines(repo) {
      calls.guidelines.push(repo)
      return { loaded: false, files: [], chars: 0, text: '' }
    },
    // Write endpoints: the auto reviewer must never touch them.
    async mergePull() {
      calls.writes += 1
      throw new Error('auto review must never merge')
    },
    async createIssueComment() {
      calls.writes += 1
      throw new Error('auto review must never comment')
    },
    async createReviewComment() {
      calls.writes += 1
      throw new Error('auto review must never comment')
    },
  }
}

/**
 * Fake review engine driven by the test.
 * @param {{ defer?: (jobId: string) => Promise<void>, statusFor?: (input: any) => any, activeJobs?: Set<string> }} [options] - behaviour overrides.
 * @returns {any} fake engine.
 */
function makeEngine(options = {}) {
  const state = { startCalls: [], waits: [], jobs: new Map() }
  let sequence = 0
  const doneStatus = {
    state: 'done',
    findings: [{ severity: 'P2', file: 'src/a.ts', line: 2, title: '建议' }],
    verdict: 'approve',
    overview: '共 1 个问题：P2 ×1',
  }
  return {
    state,
    hasActiveJob(repo, number) {
      return options.activeJobs?.has(`${repo}#${number}`) === true
    },
    start(input) {
      sequence += 1
      const id = `job-${sequence}`
      state.startCalls.push(input)
      state.jobs.set(id, { id, input, status: options.statusFor !== undefined ? options.statusFor(input) : doneStatus })
      return { jobId: id, headSha: input.headSha, cached: false, options: {} }
    },
    async waitForCompletion(jobId) {
      state.waits.push(jobId)
      if (options.defer !== undefined) await options.defer(jobId)
    },
    status(jobId) {
      const job = state.jobs.get(jobId)
      if (job === undefined) throw new AppError('BAD_REQUEST')
      return job.status
    },
  }
}

/**
 * Build one reviewer against a temp state path with injected clock/scheduler.
 * @param {{ github?: any, engine?: any, clock?: any, autoStart?: boolean, retryAfterMs?: number, recentLimit?: number, listLimit?: number, cycleTimeoutMs?: number, dir?: string }} [options] - wiring.
 * @returns {{ reviewer: AutoReviewer, github: any, engine: any, scheduler: any, clock: any, dir: string, statePath: string }} harness.
 */
function makeReviewer(options = {}) {
  const github = options.github ?? makeGithub()
  const engine = options.engine ?? makeEngine()
  const clock = options.clock ?? makeClock()
  const scheduler = makeScheduler()
  const dir = options.dir ?? makeTempDir()
  const statePath = join(dir, '.codex-review', 'auto-review.json')
  const reviewer = new AutoReviewer({
    github,
    engine,
    now: clock.now,
    setInterval: (callback, ms) => scheduler.setInterval(callback, ms),
    clearInterval: (id) => scheduler.clearInterval(id),
    statePath,
    autoStart: options.autoStart === true,
    retryAfterMs: options.retryAfterMs,
    recentLimit: options.recentLimit,
    listLimit: options.listLimit,
    cycleTimeoutMs: options.cycleTimeoutMs,
  })
  if (options.publisher !== undefined) reviewer.setPublisher(options.publisher)
  return { reviewer, github, engine, scheduler, clock, dir, statePath }
}

/**
 * Build a fake publisher that records auto-publish requests.
 * @param {{ result?: any, error?: Error }} [options] - behaviour.
 * @returns {{ calls: any[], publish: Function }} publisher spy.
 */
function makePublisherSpy(options = {}) {
  return {
    calls: [],
    async publish(input) {
      this.calls.push(input)
      if (options.error !== undefined) throw options.error
      return options.result ?? { published: true, reviewId: 9, url: 'https://github.com/Acme/repo/pull/1#pullrequestreview-9', comments: 1, skipped: 0, headSha: input.headSha }
    },
  }
}

/**
 * Let pending promise chains settle (the scheduler is fully promise based).
 * @param {number} [rounds] - microtask rounds.
 * @returns {Promise<void>} resolves after the rounds.
 */
async function flush(rounds = 8) {
  for (let index = 0; index < rounds; index += 1) await new Promise((resolve) => setImmediate(resolve))
}

/**
 * Write one state file.
 * @param {string} statePath - target path.
 * @param {Record<string, unknown>} value - file payload.
 * @returns {void}
 */
function writeStateFile(statePath, value) {
  mkdirSync(join(statePath, '..'), { recursive: true })
  writeFileSync(statePath, JSON.stringify(value), 'utf8')
}

/**
 * Read one persisted state file.
 * @param {string} statePath - path.
 * @returns {any} parsed payload.
 */
function readStateFile(statePath) {
  return JSON.parse(readFileSync(statePath, 'utf8'))
}

test('resolveAutoReviewStatePath prefers DSH_PROFILE_DIR and falls back to ~/.dsh', () => {
  assert.equal(
    resolveAutoReviewStatePath({ DSH_PROFILE_DIR: 'C:/profile' }, 'C:/home'),
    join('C:/profile', '.codex-review', 'auto-review.json'),
  )
  assert.equal(
    resolveAutoReviewStatePath({ DSH_HOME: 'C:/dsh', DSH_PROFILE: 'desktop' }, 'C:/home'),
    join('C:/dsh', 'profiles', 'desktop', '.codex-review', 'auto-review.json'),
  )
  assert.equal(resolveAutoReviewStatePath({}, 'C:/home'), join('C:/home', '.dsh', 'codex-review', 'auto-review.json'))
  assert.equal(resolveAutoReviewStatePath({ DSH_PROFILE_DIR: '   ' }, 'C:/home'), join('C:/home', '.dsh', 'codex-review', 'auto-review.json'))
})

test('sanitizeAutoReviewConfig clamps numbers, validates enums and drops unknown keys', () => {
  assert.deepEqual(sanitizeAutoReviewConfig(undefined), AUTO_REVIEW_DEFAULTS)
  const clamped = sanitizeAutoReviewConfig({ enabled: true, intervalSeconds: 30, maxPerCycle: 99, depth: 'nope', severityThreshold: 'P9', includeDrafts: 'yes', unknownKey: 1, query: '  is:open label:bug  ' })
  assert.equal(clamped.enabled, true)
  assert.equal(clamped.intervalSeconds, 60)
  assert.equal(clamped.maxPerCycle, 5)
  assert.equal(clamped.depth, 'fast')
  assert.equal(clamped.severityThreshold, 'P2')
  assert.equal(clamped.includeDrafts, false)
  assert.equal(clamped.query, 'is:open label:bug')
  assert.equal(Object.hasOwn(clamped, 'unknownKey'), false)
  const range = sanitizeAutoReviewConfig({ intervalSeconds: 99_999, maxPerCycle: -3 })
  assert.equal(range.intervalSeconds, 3_600)
  assert.equal(range.maxPerCycle, 1)
  assert.equal(sanitizeAutoReviewConfig({ intervalSeconds: 'abc' }).intervalSeconds, 180)
  // A patch keeps the live value when the incoming value is unusable.
  const kept = sanitizeAutoReviewConfig({ intervalSeconds: 'abc', depth: 'nope' }, { ...AUTO_REVIEW_DEFAULTS, intervalSeconds: 600, depth: 'deep' })
  assert.equal(kept.intervalSeconds, 600)
  assert.equal(kept.depth, 'deep')
})

test('sanitizeSeenMap keeps only well-formed cursor entries', () => {
  const seen = sanitizeSeenMap({
    'Acme/repo#1': { headSha: 'abc', at: 100 },
    'Acme/repo#2': { headSha: '', at: 100 },
    'Acme/repo#3': { headSha: 'abc', at: 'nope' },
    'Acme/repo#4': null,
    'Acme/repo#5': { headSha: 'def', at: 200.9 },
    __proto__: { headSha: 'x', at: 1 },
  })
  assert.deepEqual(seen, {
    'Acme/repo#1': { headSha: 'abc', at: 100 },
    'Acme/repo#5': { headSha: 'def', at: 200 },
  })
  assert.deepEqual(sanitizeSeenMap(null), {})
  assert.deepEqual(sanitizeSeenMap([1, 2]), {})
})

test('the state file is created on first change, persisted atomically and reloaded', () => {
  const dir = makeTempDir()
  const { reviewer, statePath, github, engine } = makeReviewer({ dir })
  assert.equal(existsSync(statePath), false, 'loading a missing file must not write one')
  assert.deepEqual(reviewer.status().config, AUTO_REVIEW_DEFAULTS)

  const status = reviewer.updateConfig({ enabled: true, intervalSeconds: 600, maxPerCycle: 4 })
  assert.equal(status.config.enabled, true)
  assert.equal(status.config.intervalSeconds, 600)
  const persisted = readStateFile(statePath)
  assert.equal(persisted.version, 1)
  assert.equal(persisted.config.enabled, true)
  assert.equal(persisted.config.intervalSeconds, 600)
  assert.deepEqual(persisted.seen, {})

  // A new instance reads the same file back.
  const reloaded = makeReviewer({ dir, github, engine })
  assert.deepEqual(reloaded.reviewer.status().config, { ...AUTO_REVIEW_DEFAULTS, enabled: true, intervalSeconds: 600, maxPerCycle: 4 })
})

test('status exposes the publish config at the top level for the client (CONTRACT §7.1)', () => {
  const dir = makeTempDir()
  const { reviewer } = makeReviewer({ dir })
  assert.deepEqual(reviewer.status().publish, AUTO_REVIEW_DEFAULTS.publish)
  const status = reviewer.updateConfig({ publish: { enabled: true, mode: 'summary', minSeverity: 'P1', maxComments: 5 } })
  assert.deepEqual(status.publish, { enabled: true, mode: 'summary', minSeverity: 'P1', maxComments: 5 })
  // The persisted state-file shape keeps the same section under `config`.
  assert.deepEqual(status.config.publish, status.publish)
})

test('a hung cycle trips the watchdog and releases the running flag', async () => {
  const hungGithub = {
    listPullRequests() {
      return new Promise(() => {})
    },
    async getPull() {
      return { headSha: 'abc' }
    },
  }
  const { reviewer } = makeReviewer({ github: hungGithub, cycleTimeoutMs: 30 })
  const result = await reviewer.runCycle({ force: true })
  assert.equal(result.started, true)
  const status = reviewer.status()
  assert.equal(status.running, false, 'the watchdog must clear the running flag')
  assert.equal(status.lastError?.code, 'INTERNAL')
  assert.match(status.lastError.message, /未结束/)
  // Not wedged: the next trigger is accepted and gets its own token.
  assert.equal(reviewer.startCycle({ force: true }).started, true)
  reviewer.dispose()
  assert.equal(reviewer.disposed, true)
  assert.equal(reviewer.status().running, true, 'an abandoned cycle is left to stop at its next boundary')
})

test('a corrupt state file is backed up and rebuilt with defaults', () => {
  const dir = makeTempDir()
  const statePath = join(dir, '.codex-review', 'auto-review.json')
  mkdirSync(join(dir, '.codex-review'), { recursive: true })
  writeFileSync(statePath, '{ not json at all', 'utf8')
  const { reviewer } = makeReviewer({ dir })
  assert.deepEqual(reviewer.status().config, AUTO_REVIEW_DEFAULTS)
  assert.equal(existsSync(statePath), true, 'the state file must be rebuilt')
  assert.equal(existsSync(`${statePath}.backup`), true, 'the corrupt file must be preserved')
  assert.equal(readFileSync(`${statePath}.backup`, 'utf8'), '{ not json at all')
  assert.deepEqual(readStateFile(statePath).config, AUTO_REVIEW_DEFAULTS)

  // A structurally wrong file (bad version) is treated as corrupt as well.
  writeFileSync(statePath, JSON.stringify({ version: 99, config: { enabled: true } }), 'utf8')
  const second = makeReviewer({ dir })
  assert.equal(second.reviewer.status().config.enabled, false)
})

test('a disabled scheduler performs no list request and records the skipped cycle', () => {
  const { reviewer, github, clock, scheduler } = makeReviewer({ autoStart: true })
  scheduler.fire()
  assert.equal(github.calls.list.length, 0)
  assert.equal(reviewer.status().lastCycleAt, clock.now())
  assert.equal(reviewer.status().running, false)
  // A manual non-force run is refused outright and does not touch the cycle timestamp.
  const before = reviewer.status().lastCycleAt
  clock.advance(5)
  assert.deepEqual(reviewer.runOnce({ force: false }), { started: false, reason: '自动审查已关闭（可带 force:true 单次运行）' })
  assert.equal(reviewer.status().lastCycleAt, before)
})

test('runOnce enforces the force/serial semantics (CONTRACT §6.3)', async () => {
  const gates = []
  const engine = makeEngine({ defer: () => new Promise((resolve) => gates.push(resolve)) })
  const { reviewer } = makeReviewer({
    engine,
    github: makeGithub({ items: [makeItem(1)], details: { 1: makeDetail('sha-1') } }),
  })
  assert.deepEqual(reviewer.runOnce({ force: false }), { started: false, reason: '自动审查已关闭（可带 force:true 单次运行）' })

  // force=true starts one cycle even while disabled; a second run is refused.
  assert.deepEqual(reviewer.runOnce({ force: true }), { started: true })
  await flush()
  assert.equal(reviewer.status().running, true)
  assert.equal(reviewer.runOnce({ force: true }).started, false)
  assert.equal(reviewer.runOnce({ force: false }).started, false)
  while (gates.length > 0) {
    gates.shift()()
    await flush()
  }
  await flush()
  assert.equal(reviewer.status().running, false)
  assert.equal(engine.state.startCalls.length, 1)
})

test('a cycle filters drafts, closed PRs, in-flight PRs and already-seen heads (CONTRACT §6.2)', async () => {
  const github = makeGithub({
    items: [
      makeItem(1),
      makeItem(2, { isDraft: true }),
      makeItem(3, { state: 'closed' }),
      makeItem(4),
      makeItem(5),
    ],
    details: {
      1: makeDetail('sha-1'),
      2: makeDetail('sha-2'),
      3: makeDetail('sha-3'),
      4: makeDetail('sha-4'),
      5: makeDetail('sha-5'),
    },
  })
  const engine = makeEngine({ activeJobs: new Set(['Acme/repo#4']) })
  const { reviewer, dir } = makeReviewer({ github, engine })
  // Pre-seed the cursor: PR #5 was already reviewed at this head.
  writeStateFile(join(dir, '.codex-review', 'auto-review.json'), {
    version: 1,
    config: { ...AUTO_REVIEW_DEFAULTS, enabled: true },
    seen: { 'Acme/repo#5': { headSha: 'sha-5', at: 1 } },
  })
  const reloaded = makeReviewer({ dir, github, engine })
  await reloaded.reviewer.runCycle({ force: false })
  assert.deepEqual(engine.state.startCalls.map((input) => input.number), [1])
  const input = engine.state.startCalls[0]
  assert.equal(input.repo, 'Acme/repo')
  assert.equal(input.headSha, 'sha-1')
  assert.equal(input.files.length, 1)
  assert.deepEqual(input.options, { depth: 'fast', severityThreshold: 'P2', includeGuidelines: true })
  assert.equal(input.guidelines.loaded, false)
  assert.equal(github.calls.guidelines.includes('Acme/repo'), true)
  // #5 is read to learn its headSha, then skipped by the seen cursor; draft /
  // closed / in-flight PRs are filtered before the detail request.
  assert.deepEqual(github.calls.pulls, ['Acme/repo#1', 'Acme/repo#5'])
})

test('includeDrafts allows draft PRs and maxPerCycle truncates the rest', async () => {
  const github = makeGithub({
    items: [makeItem(1), makeItem(2, { isDraft: true }), makeItem(3)],
    details: { 1: makeDetail('sha-1'), 2: makeDetail('sha-2'), 3: makeDetail('sha-3') },
  })
  const { reviewer } = makeReviewer({ github, engine: makeEngine() })
  reviewer.updateConfig({ enabled: true, includeDrafts: true, maxPerCycle: 2 })
  await reviewer.runCycle({ force: false })
  const engine = reviewer.engine
  assert.deepEqual(engine.state.startCalls.map((input) => input.number), [1, 2])
  assert.equal(reviewer.status().recent.length, 2)
})

test('reviews inside one cycle are serial and the cursor prevents repeats (CONTRACT §6.2)', async () => {
  const gates = []
  const engine = makeEngine({ defer: () => new Promise((resolve) => gates.push(resolve)) })
  const github = makeGithub({
    items: [makeItem(1), makeItem(2)],
    details: { 1: makeDetail('sha-1'), 2: makeDetail('sha-2') },
  })
  const { reviewer } = makeReviewer({ github, engine })
  reviewer.updateConfig({ enabled: true, maxPerCycle: 2 })
  const cycle = reviewer.runCycle({ force: false })
  await flush()
  assert.equal(engine.state.startCalls.length, 1, 'the second review must wait for the first')
  gates.shift()()
  await flush()
  assert.equal(engine.state.startCalls.length, 2)
  gates.shift()()
  await cycle
  const status = reviewer.status()
  assert.equal(status.recent.length, 2)
  assert.equal(status.recent[0].number, 2, 'newest result first')
  assert.equal(status.recent[0].state, 'done')
  assert.equal(status.recent[0].findings, 1)
  assert.equal(status.recent[0].verdict, 'approve')
  assert.equal(status.recent[0].overview, '共 1 个问题：P2 ×1')
  assert.equal(typeof status.recent[0].finishedAt, 'number')
  assert.equal(status.seenCount, 2)

  // A second cycle must not re-review the same heads.
  await reviewer.runCycle({ force: false })
  assert.equal(engine.state.startCalls.length, 2)
  assert.equal(reviewer.status().recent.length, 2)
  assert.deepEqual(readStateFile(join(reviewer.statePath)).seen, {
    'Acme/repo#1': { headSha: 'sha-1', at: reviewer.status().recent[1].finishedAt },
    'Acme/repo#2': { headSha: 'sha-2', at: reviewer.status().recent[0].finishedAt },
  })
})

test('a new head is reviewed again once the cursor differs', async () => {
  const github = makeGithub({ items: [makeItem(1)], details: { 1: makeDetail('sha-old') } })
  const { reviewer, engine } = makeReviewer({ github, engine: makeEngine() })
  reviewer.updateConfig({ enabled: true })
  await reviewer.runCycle({ force: false })
  assert.equal(engine.state.startCalls.length, 1)
  // Same PR with a new head commit.
  const detail = makeDetail('sha-new')
  github.getPull = async () => detail
  await reviewer.runCycle({ force: false })
  assert.equal(engine.state.startCalls.length, 2)
  assert.equal(engine.state.startCalls[1].headSha, 'sha-new')
})

test('a failed review is marked seen and retried only after the 30 minute window (CONTRACT §6.2)', async () => {
  const engine = makeEngine({ statusFor: () => ({ state: 'error', error: { code: 'LLM_ERROR', message: 'boom' }, findings: [] }) })
  const github = makeGithub({ items: [makeItem(1)], details: { 1: makeDetail('sha-1') } })
  const { reviewer, clock } = makeReviewer({ github, engine })
  reviewer.updateConfig({ enabled: true })
  await reviewer.runCycle({ force: false })
  assert.equal(engine.state.startCalls.length, 1)
  const failed = reviewer.status().recent[0]
  assert.equal(failed.state, 'error')
  assert.deepEqual(failed.error, { code: 'LLM_ERROR', message: 'boom' })
  assert.equal(reviewer.status().seenCount, 1)

  // Inside the retry window the same head is skipped.
  clock.advance(AUTO_REVIEW_RETRY_AFTER_MS - 1)
  await reviewer.runCycle({ force: false })
  assert.equal(engine.state.startCalls.length, 1)

  // After the window one retry is allowed.
  clock.advance(1)
  await reviewer.runCycle({ force: false })
  assert.equal(engine.state.startCalls.length, 2)

  // A done head is never retried, no matter how much time passes.
  const doneEngine = makeEngine()
  const doneGithub = makeGithub({ items: [makeItem(2)], details: { 2: makeDetail('sha-2') } })
  const done = makeReviewer({ github: doneGithub, engine: doneEngine, clock })
  done.reviewer.updateConfig({ enabled: true })
  await done.reviewer.runCycle({ force: false })
  clock.advance(AUTO_REVIEW_RETRY_AFTER_MS * 2)
  await done.reviewer.runCycle({ force: false })
  assert.equal(doneEngine.state.startCalls.length, 1)
})

test('single-PR failures are isolated and a failing list request is a cycle-level error', async () => {
  const listError = new AppError('GH_NETWORK', '无法连接 GitHub')
  const brokenList = makeGithub({ listError })
  const failing = makeReviewer({ github: brokenList })
  failing.reviewer.updateConfig({ enabled: true })
  await failing.reviewer.runCycle({ force: false })
  assert.equal(failing.reviewer.status().lastError.code, 'GH_NETWORK')
  assert.equal(failing.reviewer.status().running, false)

  // A successful cycle clears the stale error.
  failing.github.listPullRequests = async () => ({ query: 'q', totalCount: 0, items: [] })
  await failing.reviewer.runCycle({ force: false })
  assert.equal(failing.reviewer.status().lastError, undefined)

  // One unreadable PR does not stop the others.
  const github = makeGithub({
    items: [makeItem(1), makeItem(2)],
    details: { 1: new AppError('GH_NOT_FOUND', 'gone'), 2: makeDetail('sha-2') },
  })
  const engine = makeEngine()
  const isolated = makeReviewer({ github, engine })
  isolated.reviewer.updateConfig({ enabled: true, maxPerCycle: 2 })
  await isolated.reviewer.runCycle({ force: false })
  assert.deepEqual(engine.state.startCalls.map((input) => input.number), [2])
})

test('the auto reviewer never calls a GitHub write endpoint (CONTRACT §6.5 #4)', async () => {
  const github = makeGithub({ items: [makeItem(1), makeItem(2)], details: { 1: makeDetail('sha-1'), 2: makeDetail('sha-2') } })
  const { reviewer } = makeReviewer({ github })
  reviewer.updateConfig({ enabled: true, maxPerCycle: 2 })
  await reviewer.runCycle({ force: false })
  await reviewer.runCycle({ force: true })
  assert.equal(github.calls.writes, 0, 'merge/comment write calls must stay at zero')
  assert.deepEqual(Object.keys(github.calls).sort(), ['guidelines', 'list', 'pulls', 'writes'])
  assert.equal(github.calls.list.length >= 2, true)
})

test('status exposes the contract shape and omits nextCycleAt while running', async () => {
  const gates = []
  const engine = makeEngine({ defer: () => new Promise((resolve) => gates.push(resolve)) })
  const github = makeGithub({ items: [makeItem(1)], details: { 1: makeDetail('sha-1') } })
  const { reviewer, scheduler, clock } = makeReviewer({ github, engine, autoStart: true })
  const initial = reviewer.status()
  assert.deepEqual(initial.config, AUTO_REVIEW_DEFAULTS)
  assert.equal(initial.running, false)
  assert.equal(initial.seenCount, 0)
  assert.deepEqual(initial.recent, [])
  assert.equal(initial.nextCycleAt, clock.now() + 180_000)
  assert.equal(scheduler.active().length, 1)

  reviewer.updateConfig({ enabled: true })
  const cycle = reviewer.runCycle({ force: false })
  await flush()
  const running = reviewer.status()
  assert.equal(running.running, true)
  assert.equal('nextCycleAt' in running, false)
  gates.shift()()
  await cycle
  const settled = reviewer.status()
  assert.equal(settled.running, false)
  assert.equal('nextCycleAt' in settled, true)
  assert.equal(settled.seenCount, 1)
})

test('interval changes reschedule the timer and dispose clears it', () => {
  const { reviewer, scheduler } = makeReviewer({ autoStart: true })
  assert.equal(scheduler.active().length, 1)
  assert.equal(scheduler.active()[0].ms, 180_000)
  reviewer.updateConfig({ intervalSeconds: 600 })
  assert.equal(scheduler.active().length, 1)
  assert.equal(scheduler.active()[0].ms, 600_000)
  assert.equal(reviewer.status().nextCycleAt, reviewer.now() + 600_000)
  reviewer.dispose()
  assert.equal(scheduler.active().length, 0)
})

test('timer ticks honour enabled, record skips and never overlap cycles', async () => {
  const github = makeGithub({ items: [makeItem(1)], details: { 1: makeDetail('sha-1') } })
  const { reviewer, scheduler } = makeReviewer({ github, autoStart: true })
  scheduler.fire()
  assert.equal(github.calls.list.length, 0, 'a disabled tick must not list PRs')
  assert.equal(typeof reviewer.status().lastCycleAt, 'number')

  reviewer.updateConfig({ enabled: true })
  scheduler.fire()
  await flush()
  assert.equal(github.calls.list.length, 1)

  // While a cycle runs further ticks are dropped.
  const gates = []
  const slowEngine = makeEngine({ defer: () => new Promise((resolve) => gates.push(resolve)) })
  const slow = makeReviewer({ github: makeGithub({ items: [makeItem(1)], details: { 1: makeDetail('sha-1') } }), engine: slowEngine, autoStart: true })
  slow.reviewer.updateConfig({ enabled: true })
  slow.scheduler.fire()
  await flush()
  slow.scheduler.fire()
  await flush()
  assert.equal(slowEngine.state.startCalls.length, 1)
  while (gates.length > 0) {
    gates.shift()()
    await flush()
  }
})

test('the recent list is capped, newest first, and survives in-memory order', () => {
  const { reviewer } = makeReviewer({ recentLimit: 3 })
  for (let index = 1; index <= 5; index += 1) {
    reviewer.recordResult({ repo: 'Acme/repo', number: index, headSha: `sha-${index}`, state: 'done', findings: index, finishedAt: 100 + index })
  }
  const recent = reviewer.status().recent
  assert.equal(recent.length, 3)
  assert.deepEqual(recent.map((entry) => entry.number), [5, 4, 3])
})

test('the seen cursor and last cycle survive a reviewer restart', async () => {
  const dir = makeTempDir()
  const github = makeGithub({ items: [makeItem(1)], details: { 1: makeDetail('sha-1') } })
  const first = makeReviewer({ dir, github, engine: makeEngine() })
  first.reviewer.updateConfig({ enabled: true })
  await first.reviewer.runCycle({ force: false })
  const persisted = readStateFile(first.statePath)
  assert.equal(persisted.lastCycleAt, first.reviewer.status().lastCycleAt)
  assert.equal(persisted.seen['Acme/repo#1'].headSha, 'sha-1')

  const second = makeReviewer({ dir, github, engine: makeEngine() })
  const status = second.reviewer.status()
  assert.equal(status.config.enabled, true)
  assert.equal(status.seenCount, 1)
  assert.equal(status.lastCycleAt, persisted.lastCycleAt)
  await second.reviewer.runCycle({ force: false })
  assert.equal(second.engine.state.startCalls.length, 0, 'restart must keep the cursor')
})

test('updateConfig rejects non-object patches and clamps numbers', () => {
  const { reviewer } = makeReviewer()
  assert.throws(() => reviewer.updateConfig(null), (error) => error.code === 'BAD_REQUEST')
  assert.throws(() => reviewer.updateConfig([]), (error) => error.code === 'BAD_REQUEST')
  const status = reviewer.updateConfig({ intervalSeconds: 30, maxPerCycle: 99, depth: 'deep', severityThreshold: 'P0' })
  assert.equal(status.config.intervalSeconds, 60)
  assert.equal(status.config.maxPerCycle, 5)
  assert.equal(status.config.depth, 'deep')
  assert.equal(status.config.severityThreshold, 'P0')
})

// ---------------------------------------------------------------------------
// v2.2: persistent recent history, publish config and automatic publishing
// ---------------------------------------------------------------------------

test('the publish config is clamped and merged into the auto-review config (CONTRACT §7.1)', () => {
  const { reviewer } = makeReviewer()
  assert.deepEqual(reviewer.status().config.publish, { enabled: false, mode: 'inline', minSeverity: 'P2', maxComments: 20 })
  const status = reviewer.updateConfig({ publish: { enabled: true, mode: 'nope', minSeverity: 'P9', maxComments: 99 } })
  assert.deepEqual(status.config.publish, { enabled: true, mode: 'inline', minSeverity: 'P2', maxComments: 50 })
  const partial = reviewer.updateConfig({ publish: { mode: 'both' } })
  assert.deepEqual(partial.config.publish, { enabled: true, mode: 'both', minSeverity: 'P2', maxComments: 50 })
})

test('recent results are persisted to the state file and survive a restart', async () => {
  const dir = makeTempDir()
  const github = makeGithub({ items: [makeItem(1), makeItem(2)], details: { 1: makeDetail('sha-1'), 2: makeDetail('sha-2') } })
  const first = makeReviewer({ dir, github, engine: makeEngine() })
  first.reviewer.updateConfig({ enabled: true, maxPerCycle: 2 })
  await first.reviewer.runCycle({ force: false })
  assert.equal(first.reviewer.status().recent.length, 2)
  const file = JSON.parse(readFileSync(first.statePath, 'utf8'))
  assert.equal(file.recent.length, 2)
  assert.equal(file.recent[0].number, 2)
  assert.equal(file.recent[0].state, 'done')
  assert.equal(typeof file.recent[0].finishedAt, 'number')

  // A restarted Host still sees the history (the v2.1 acceptance gap).
  const second = makeReviewer({ dir, github: makeGithub(), engine: makeEngine() })
  assert.equal(second.reviewer.status().recent.length, 2)
  assert.equal(second.reviewer.status().recent[0].number, 2)
  assert.equal(second.reviewer.status().seenCount, 2)
})

test('a corrupt recent section is reset without losing config/seen', () => {
  const dir = makeTempDir()
  const statePath = join(dir, '.codex-review', 'auto-review.json')
  mkdirSync(join(dir, '.codex-review'), { recursive: true })
  writeFileSync(statePath, JSON.stringify({
    version: 1,
    config: { ...AUTO_REVIEW_DEFAULTS, enabled: true },
    seen: { 'Acme/repo#1': { headSha: 'sha-1', at: 5 } },
    recent: 'not-an-array',
  }), 'utf8')
  const { reviewer } = makeReviewer({ dir })
  assert.deepEqual(reviewer.status().recent, [])
  assert.equal(reviewer.status().seenCount, 1)
  assert.equal(reviewer.status().config.enabled, true)
})

test('sanitizeRecentList/sanitizePublishedMap keep only well-formed records', () => {
  const recent = sanitizeRecentList([
    { repo: 'A/b', number: 2, headSha: 'sha-2', state: 'done', findings: 3, finishedAt: 20, verdict: 'changes', overview: 'x' },
    { repo: 'A/b', number: 3, headSha: 'sha-3', state: 'error', findings: 0, finishedAt: 30, error: { code: 'LLM_ERROR', message: 'boom' } },
    { repo: 'A/b', number: 4, headSha: 'sha-4', state: 'done', findings: 2, finishedAt: 40, published: { reviewId: 7, url: 'u' } },
    { repo: '', number: 5, state: 'done', finishedAt: 1 },
    { repo: 'A/b', number: 6, state: 'bogus', finishedAt: 1 },
    null,
  ], 2)
  assert.equal(recent.length, 2)
  assert.deepEqual(recent[0], { repo: 'A/b', number: 2, headSha: 'sha-2', state: 'done', findings: 3, finishedAt: 20, verdict: 'changes', overview: 'x' })
  assert.deepEqual(recent[1].error, { code: 'LLM_ERROR', message: 'boom' })
  const full = sanitizeRecentList([{ repo: 'A/b', number: 4, headSha: 's', state: 'done', findings: 2, finishedAt: 40, published: { reviewId: 7, url: 'u' } }])
  assert.deepEqual(full[0].published, { reviewId: 7, url: 'u' })
  assert.deepEqual(sanitizePublishedMap({
    'A/b#2@sha': { publishedAt: 5, reviewId: 9, url: 'https://x' },
    'A/b#2': { publishedAt: 6, reviewId: 9, url: 'https://x', fingerprint: 'abcdef123456' },
    'A/b#3': { publishedAt: 7, reviewId: 10, url: 'https://y', fingerprint: 'not a hash' },
    bad: { publishedAt: 'nope' },
    null: null,
  }), {
    'A/b#2@sha': { publishedAt: 5, reviewId: 9, url: 'https://x' },
    'A/b#2': { publishedAt: 6, reviewId: 9, url: 'https://x', fingerprint: 'abcdef123456' },
    'A/b#3': { publishedAt: 7, reviewId: 10, url: 'https://y' },
  })
  assert.deepEqual(sanitizePublishedMap(null), {})
})

test('sanitizePublishedMap drops records that could never be replayed', () => {
  // reviewId 0 / empty url would replay as "published" with a dead link.
  assert.deepEqual(sanitizePublishedMap({
    'A/b#1@sha-0': { publishedAt: 5, reviewId: 0, url: 'https://x' },
    'A/b#1@sha-1': { publishedAt: 5, reviewId: 9, url: '' },
    'A/b#1@sha-2': { publishedAt: 5, reviewId: 9, url: 'https://x', request: 'deadbeef1234' },
  }), {
    'A/b#1@sha-2': { publishedAt: 5, reviewId: 9, url: 'https://x', request: 'deadbeef1234' },
  })
})

test('prunePublishedMap keeps every rolling record and the newest head records', () => {
  const published = {
    'A/b#1': { publishedAt: 1, reviewId: 11, url: 'u1' },
    'A/b#2': { publishedAt: 2, reviewId: 12, url: 'u2' },
    'A/b#1@sha-a': { publishedAt: 10, reviewId: 11, url: 'u1' },
    'A/b#1@sha-b': { publishedAt: 30, reviewId: 11, url: 'u1' },
    'A/b#1@sha-c': { publishedAt: 20, reviewId: 11, url: 'u1' },
  }
  const pruned = prunePublishedMap(published, 2)
  assert.deepEqual(Object.keys(pruned).sort(), ['A/b#1', 'A/b#1@sha-b', 'A/b#1@sha-c', 'A/b#2'])
})

test('shouldRetryFailedReview survives restart and recent-list eviction', async () => {
  const dir = makeTempDir()
  const clock = makeClock()
  const failing = {
    items: [makeItem(1)],
    details: { 1: makeDetail('sha-1') },
  }
  const first = makeReviewer({
    dir,
    clock,
    github: makeGithub(failing),
    engine: makeEngine({ statusFor: () => ({ state: 'error', findings: [], error: { code: 'LLM_ERROR', message: 'boom' } }) }),
    recentLimit: 1,
  })
  first.reviewer.updateConfig({ enabled: true })
  await first.reviewer.runCycle({ force: false })
  assert.equal(first.reviewer.status().recent[0].state, 'error')

  // A restart rebuilds the in-memory history from the state file; the persisted
  // cursor still knows when this head failed, even after `recent` was capped.
  const second = makeReviewer({ dir, clock, github: makeGithub(failing), recentLimit: 1, retryAfterMs: 60_000 })
  assert.equal(second.reviewer.shouldRetryFailedReview('Acme/repo', 1, 'sha-1'), false, 'inside the retry window')
  clock.advance(61_000)
  assert.equal(second.reviewer.shouldRetryFailedReview('Acme/repo', 1, 'sha-1'), true, 'after the window')

  // A head that finished successfully is never retried, even if the cursor
  // later loses its failedAt for a different head.
  second.reviewer.recordResult({ repo: 'Acme/repo', number: 1, headSha: 'sha-1', state: 'done', findings: 0, finishedAt: clock.now() })
  assert.equal(second.reviewer.shouldRetryFailedReview('Acme/repo', 1, 'sha-1'), false)
})

test('setPublishedMany writes the head pointer and rolling identity in one persist', () => {
  const dir = makeTempDir()
  const reviewer = makeReviewer({ dir }).reviewer
  reviewer.setPublishedMany([
    { key: 'Acme/repo#1@sha-1', record: { publishedAt: 1, reviewId: 42, url: 'https://x/42', fingerprint: 'abcdef123456', request: '0123456789ab' } },
    { key: 'Acme/repo#1', record: { publishedAt: 1, reviewId: 42, url: 'https://x/42', fingerprint: 'abcdef123456' } },
  ])
  const file = JSON.parse(readFileSync(join(dir, '.codex-review', 'auto-review.json'), 'utf8'))
  assert.equal(file.published['Acme/repo#1@sha-1'].request, '0123456789ab')
  assert.equal(file.published['Acme/repo#1'].reviewId, 42)
  // Unusable entries are skipped, never persisted as a dead pointer.
  reviewer.setPublishedMany([{ key: 'Acme/repo#2@sha-2', record: { publishedAt: 2, reviewId: 0, url: '' } }])
  assert.equal(reviewer.getPublished('Acme/repo#2@sha-2'), undefined)
})

test('publish records are persisted and readable after a restart (CONTRACT §7.2 #6)', () => {
  const dir = makeTempDir()
  const first = makeReviewer({ dir })
  assert.equal(first.reviewer.getPublished('Acme/repo#1@sha-1'), undefined)
  first.reviewer.setPublished('Acme/repo#1@sha-1', { publishedAt: 1_234, reviewId: 42, url: 'https://github.com/x/y/pull/1#pullrequestreview-42' })
  assert.deepEqual(first.reviewer.getPublished('Acme/repo#1@sha-1'), { publishedAt: 1_234, reviewId: 42, url: 'https://github.com/x/y/pull/1#pullrequestreview-42' })
  const second = makeReviewer({ dir })
  assert.deepEqual(second.reviewer.getPublished('Acme/repo#1@sha-1'), { publishedAt: 1_234, reviewId: 42, url: 'https://github.com/x/y/pull/1#pullrequestreview-42' })
  assert.equal(second.reviewer.getPublished('other/repo#1@sha'), undefined)

  // The rolling summary record keeps its content fingerprint across restarts.
  first.reviewer.setPublished('Acme/repo#1', { publishedAt: 1_234, reviewId: 42, url: 'https://github.com/x/y/pull/1#pullrequestreview-42', fingerprint: 'abcdef123456' })
  assert.deepEqual(first.reviewer.getPublished('Acme/repo#1'), {
    publishedAt: 1_234,
    reviewId: 42,
    url: 'https://github.com/x/y/pull/1#pullrequestreview-42',
    fingerprint: 'abcdef123456',
  })
  const third = makeReviewer({ dir })
  assert.deepEqual(third.reviewer.getPublished('Acme/repo#1'), {
    publishedAt: 1_234,
    reviewId: 42,
    url: 'https://github.com/x/y/pull/1#pullrequestreview-42',
    fingerprint: 'abcdef123456',
  })
})

test('automatic publishing is off unless publish.enabled is true (CONTRACT §7.4 #1)', async () => {
  const publisher = makePublisherSpy()
  const github = makeGithub({ items: [makeItem(1)], details: { 1: makeDetail('sha-1') } })
  const { reviewer } = makeReviewer({ github, engine: makeEngine(), publisher })
  reviewer.updateConfig({ enabled: true })
  await reviewer.runCycle({ force: false })
  assert.equal(publisher.calls.length, 0)
  assert.equal(reviewer.status().recent[0].published, undefined)
})

test('automatic publishing posts the just-reviewed head only when enabled', async () => {
  const publisher = makePublisherSpy()
  const github = makeGithub({ items: [makeItem(1)], details: { 1: makeDetail('sha-1') } })
  const { reviewer, dir } = makeReviewer({ github, engine: makeEngine(), publisher })
  reviewer.updateConfig({ enabled: true, publish: { enabled: true, mode: 'summary', minSeverity: 'P1', maxComments: 5 } })
  await reviewer.runCycle({ force: false })
  assert.equal(publisher.calls.length, 1)
  // The publish is bound to the head and the job this cycle just finished, so
  // the publisher cannot drift to a newer head or a different job.
  assert.deepEqual(publisher.calls[0], {
    repo: 'Acme/repo',
    number: 1,
    confirm: true,
    headSha: 'sha-1',
    jobId: 'job-1',
    mode: 'summary',
    minSeverity: 'P1',
    maxComments: 5,
  })
  assert.deepEqual(reviewer.status().recent[0].published, { reviewId: 9, url: 'https://github.com/Acme/repo/pull/1#pullrequestreview-9' })
  assert.equal(reviewer.status().lastError, undefined)
  const file = JSON.parse(readFileSync(join(dir, '.codex-review', 'auto-review.json'), 'utf8'))
  assert.deepEqual(file.recent[0].published, { reviewId: 9, url: 'https://github.com/Acme/repo/pull/1#pullrequestreview-9' })
})

test('automatic publishing is skipped for a partial review and never writes to GitHub', async () => {
  const publisher = makePublisherSpy()
  const github = makeGithub({ items: [makeItem(1)], details: { 1: makeDetail('sha-1') } })
  const engine = makeEngine({
    statusFor: () => ({ state: 'done', partial: true, partialReasons: ['chunk 2 超时'], findings: [], verdict: 'approve', overview: '部分结果' }),
  })
  const { reviewer } = makeReviewer({ github, engine, publisher })
  reviewer.updateConfig({ enabled: true, publish: { enabled: true } })
  await reviewer.runCycle({ force: false })
  assert.equal(publisher.calls.length, 0, 'an incomplete review must not publish')
  assert.equal(reviewer.status().recent[0].partial, true, 'the partial flag is kept in the history')
})

test('a failed automatic publish only records lastError and never retries in a loop', async () => {
  const publisher = makePublisherSpy({ error: new AppError('GH_FORBIDDEN', 'no permission') })
  const github = makeGithub({ items: [makeItem(1)], details: { 1: makeDetail('sha-1') } })
  const { reviewer } = makeReviewer({ github, engine: makeEngine(), publisher })
  reviewer.updateConfig({ enabled: true, publish: { enabled: true } })
  await reviewer.runCycle({ force: false })
  assert.equal(publisher.calls.length, 1)
  assert.equal(reviewer.status().lastError.code, 'GH_FORBIDDEN')
  assert.equal(reviewer.status().recent[0].state, 'done')
  assert.equal(reviewer.status().recent[0].published, undefined)
  // The seen cursor prevents a repeat cycle from re-reviewing/re-publishing.
  await reviewer.runCycle({ force: false })
  assert.equal(publisher.calls.length, 1)
})

test('automatic publishing is skipped for reviews that did not finish', async () => {
  const publisher = makePublisherSpy()
  const github = makeGithub({ items: [makeItem(1)], details: { 1: makeDetail('sha-1') } })
  const engine = makeEngine({ statusFor: () => ({ state: 'error', error: { code: 'LLM_ERROR', message: 'boom' }, findings: [] }) })
  const { reviewer } = makeReviewer({ github, engine, publisher })
  reviewer.updateConfig({ enabled: true, publish: { enabled: true } })
  await reviewer.runCycle({ force: false })
  assert.equal(publisher.calls.length, 0)
  assert.equal(reviewer.status().recent[0].state, 'error')
})

test('shared review parameters persist and automatic reviews respect disabled guidelines', async () => {
  const github = makeGithub({ items: [makeItem(1)], details: { 1: makeDetail('sha-1') } })
  const engine = makeEngine()
  const { reviewer, dir } = makeReviewer({ github, engine })
  reviewer.updateConfig({ enabled: true, depth: 'deep', severityThreshold: 'P0', includeGuidelines: false })
  const restored = makeReviewer({ dir, github, engine }).reviewer
  await restored.runCycle({ force: false })
  assert.deepEqual(engine.state.startCalls[0].options, { depth: 'deep', severityThreshold: 'P0', includeGuidelines: false })
  assert.deepEqual(github.calls.guidelines, [])
})
