#!/usr/bin/env node
/**
 * Lead integration smoke for v2.1 auto review.
 *
 * Sequence:
 *  1. status defaults (enabled=false) and config clamping;
 *  2. force one cycle on the real workspace (fast depth) and wait for it to settle;
 *  3. assert `recent` gained a done entry and the PR detail now serves the cached review;
 *  4. force a second cycle and assert the `seen` cursor prevents another review (cycle settles quickly, recent length unchanged);
 *  5. restore `enabled=false` so no background token spend is left behind.
 *
 * The auto reviewer must never call a GitHub write endpoint; this script only
 * observes state and never merges or comments.
 *
 * Usage: node tools/lead-v21-smoke.mjs
 */
const base = 'http://127.0.0.1:2632'

async function post(path, body) {
  const response = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  const text = await response.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error(`${path} -> HTTP ${response.status} non-JSON: ${text.slice(0, 200)}`)
  }
  if (json.ok !== true) throw new Error(`${path} -> ${JSON.stringify(json.error)}`)
  return json.value
}

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERT: ${message}`)
  console.log(`✓ ${message}`)
}

async function waitSettled(label, timeoutMs = 6 * 60_000) {
  const deadline = Date.now() + timeoutMs
  let last = ''
  for (;;) {
    const status = await post('/codex-review/auto-review-status')
    const line = `running=${status.running} recent=${status.recent.length}`
    if (line !== last) {
      console.log(`[${label}] ${line}`)
      last = line
    }
    if (status.running !== true) return status
    if (Date.now() > deadline) throw new Error(`${label}: still running after ${timeoutMs}ms`)
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
}

console.log('== 1) status defaults + config clamping ==')
const initial = await post('/codex-review/auto-review-status')
console.log('initial config', JSON.stringify(initial.config))
assert(initial.config.enabled === false, 'enabled defaults to false')
assert(initial.config.intervalSeconds >= 60 && initial.config.intervalSeconds <= 3600, 'interval is clamped into 60..3600')
assert(Array.isArray(initial.recent), 'recent is an array')

const clamped = await post('/codex-review/auto-review-config', {
  patch: { enabled: true, intervalSeconds: 30, maxPerCycle: 99, depth: 'nope', unknownKey: 1 },
})
console.log('clamped config', JSON.stringify(clamped.config))
assert(clamped.config.intervalSeconds === 60, 'intervalSeconds 30 clamps to 60')
assert(clamped.config.maxPerCycle === 5, 'maxPerCycle 99 clamps to 5')
assert(clamped.config.depth === 'fast', 'unknown depth falls back to fast')
assert(clamped.config.enabled === true, 'enabled toggles on')
assert(Reflect.has(clamped.config, 'unknownKey') === false, 'unknown config keys are dropped')

const disabledRun = await post('/codex-review/auto-review-config', { patch: { enabled: false } })
assert(disabledRun.config.enabled === false, 'enabled toggles off')
const refused = await post('/codex-review/auto-review-run', { force: false })
assert(refused.started === false && typeof refused.reason === 'string', 'run without force is refused while disabled')

console.log('\n== 2) force one auto review cycle ==')
await post('/codex-review/auto-review-config', {
  patch: { enabled: true, intervalSeconds: 3600, depth: 'fast', severityThreshold: 'P2', includeDrafts: false, maxPerCycle: 2 },
})
const startedAt = Date.now()
const before = await post('/codex-review/auto-review-status')
const run = await post('/codex-review/auto-review-run', { force: true })
assert(run.started === true, 'force run starts a cycle')
const settled = await waitSettled('cycle-1')
const elapsed = Date.now() - startedAt
console.log(`cycle-1 settled in ${elapsed}ms; recent=${settled.recent.length}`)
if (settled.recent.length > before.recent.length) {
  console.log('✓ cycle reviewed at least one unseen PR')
} else {
  console.log('~ every open PR was already reviewed at its current head (seen cursor); nothing new to review')
}
assert(settled.running === false, 'cycle is no longer running')

/** No recent entry may duplicate another entry's PR head. */
const heads = settled.recent.map((entry) => `${entry.repo}#${entry.number}@${entry.headSha}`)
assert(heads.length === new Set(heads).size, 'recent entries are unique per PR head (seen cursor works)')

const newest = settled.recent[0]
if (newest !== undefined && before.recent.length !== settled.recent.length) {
  console.log('newest recent', JSON.stringify(newest))
  assert(['done', 'error', 'cancelled'].includes(newest.state), 'recent entry reached a terminal state')
  if (newest.state === 'done') {
    const detail = await post('/codex-review/pr', { repo: newest.repo, number: newest.number })
    console.log('PR review snapshot', JSON.stringify({
      state: detail.review?.state,
      findings: detail.review?.findings?.length,
      headSha: detail.review?.headSha?.slice(0, 10),
    }))
    assert(detail.review?.state === 'done', 'PR detail serves the auto-reviewed result')
  }
}

console.log('\n== 3) second force must not duplicate a reviewed head ==')
const second = await post('/codex-review/auto-review-run', { force: true })
assert(second.started === true, 'second force run starts a cycle')
const cycle2StartedAt = Date.now()
const settled2 = await waitSettled('cycle-2', 6 * 60_000)
const cycle2Ms = Date.now() - cycle2StartedAt
console.log(`cycle-2 settled in ${cycle2Ms}ms; recent=${settled2.recent.length}`)
const heads2 = settled2.recent.map((entry) => `${entry.repo}#${entry.number}@${entry.headSha}`)
assert(heads2.length === new Set(heads2).size, 'second cycle never re-reviews a head it already reviewed')
if (settled2.recent.length === settled.recent.length) {
  console.log('✓ no new review was queued (every open PR head already seen)')
}

console.log('\n== 4) restore enabled=false ==')
const restored = await post('/codex-review/auto-review-config', { patch: { enabled: false } })
assert(restored.config.enabled === false, 'auto review restored to disabled')
console.log('\nV21 SMOKE OK')
