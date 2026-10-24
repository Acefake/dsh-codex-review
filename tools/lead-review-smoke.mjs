#!/usr/bin/env node
/**
 * Lead smoke test for the installed plugin: fetch PR #129, then run one real AI
 * review and poll it to a terminal state. Prints one line per transition.
 * Usage: node lead-review-smoke.mjs [repo] [number]
 */
const base = 'http://127.0.0.1:2632'
const repo = process.argv[2] ?? 'Acefake/yingbox'
const number = Number(process.argv[3] ?? 129)

async function post(path, body) {
  const started = Date.now()
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
    throw new Error(`${path} -> HTTP ${response.status} non-JSON: ${text.slice(0, 300)}`)
  }
  return { status: response.status, ms: Date.now() - started, json }
}

function fail(message) {
  console.error('FAIL:', message)
  process.exit(1)
}

const health = await post('/codex-review/health', {})
console.log('health', health.status, JSON.stringify(health.json.value))
if (health.json.ok !== true) fail('health not ok')

const prs = await post('/codex-review/prs', { query: 'is:open author:@me', limit: 30 })
const list = prs.json.value
console.log('prs', prs.status, `${prs.ms}ms`, 'totalCount', list.totalCount, 'items', list.items.length)
if (!Array.isArray(list.items) || list.items.length < 10) fail('pr list too small')

const pr = await post('/codex-review/pr', { repo, number })
if (pr.json.ok !== true) fail(`pr failed: ${JSON.stringify(pr.json.error)}`)
const detail = pr.json.value
console.log(
  'pr', pr.status, `${pr.ms}ms`,
  'title', JSON.stringify(detail.summary.title),
  'files', detail.files.length,
  'adds/dels', `${detail.summary.additions}/${detail.summary.deletions}`,
  'bodyChars', detail.body.length,
  'stack', JSON.stringify(detail.stack.chain),
  'checks', detail.checks.state,
  'comments', detail.comments.total,
)
if (detail.files.length !== 24) fail(`expected 24 files, got ${detail.files.length}`)
if (!detail.stack.chain.some((entry) => entry.number === 117)) fail('stack missing #117')

const started = await post('/codex-review/review-start', { repo, number })
if (started.json.ok !== true) fail(`review-start failed: ${JSON.stringify(started.json.error)}`)
const { jobId, headSha, cached } = started.json.value
console.log('review-start', started.status, `${started.ms}ms`, 'jobId', jobId, 'headSha', headSha.slice(0, 12), 'cached', cached)

const deadline = Date.now() + 9 * 60_000
let last = ''
let status
while (Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 2000))
  const polled = await post('/codex-review/review-status', { jobId })
  if (polled.json.ok !== true) fail(`review-status failed: ${JSON.stringify(polled.json.error)}`)
  status = polled.json.value
  const line = `${status.state} ${status.progress.filesDone}/${status.progress.filesTotal} findings=${status.findings.length} elapsed=${status.progress.elapsedMs}ms`
  if (line !== last) {
    console.log('review', line)
    last = line
  }
  if (['done', 'error', 'cancelled'].includes(status.state)) break
}

if (status === undefined) fail('no status observed')
if (status.state === 'error') fail(`review error: ${JSON.stringify(status.error)}`)
if (status.state !== 'done') fail(`review did not finish: ${status.state}`)
console.log('overview', JSON.stringify(status.overview))
console.log('model', JSON.stringify(status.model))
console.log('partial', status.partial === true)
const severityCount = status.findings.reduce((acc, finding) => {
  acc[finding.severity] = (acc[finding.severity] ?? 0) + 1
  return acc
}, {})
console.log('findings', status.findings.length, JSON.stringify(severityCount))
for (const finding of status.findings.slice(0, 10)) {
  console.log(
    `  [${finding.severity}] ${finding.file}:${finding.line} ${finding.title}`,
  )
}
const valid = status.findings.every((finding) =>
  ['P0', 'P1', 'P2'].includes(finding.severity)
  && typeof finding.file === 'string' && finding.file.length > 0
  && Number.isInteger(finding.line) && finding.line > 0
  && typeof finding.title === 'string' && typeof finding.why === 'string' && typeof finding.fix === 'string')
if (!valid) fail('finding schema invalid')
console.log('SMOKE OK')
