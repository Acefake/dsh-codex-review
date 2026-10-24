#!/usr/bin/env node
/**
 * Lead integration smoke for the v2 surface.
 *
 * Deliberately NEVER performs a real merge: it only exercises the merge guards
 * (missing confirm, stale head) and then sends one real chat question through
 * the streaming route and prints the assembled answer.
 *
 * The target PR is taken from the plugin's default query (any repo authored by
 * the current user) so the smoke keeps working while one repository has no open
 * PRs. `--pr owner/repo#123` pins an explicit target.
 *
 * Usage: node tools/lead-v2-smoke.mjs [--pr Acefake/yingbox#129]
 */
const base = 'http://127.0.0.1:2632'

function parsePin(argv) {
  const index = argv.indexOf('--pr')
  const value = index === -1 ? undefined : argv[index + 1]
  if (value === undefined) return undefined
  const match = /^([^#]+)#(\d+)$/.exec(value)
  if (match === null) throw new Error(`bad --pr value: ${value}`)
  return { repo: match[1], number: Number(match[2]) }
}

const pin = parsePin(process.argv.slice(2))

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
  return { status: response.status, json }
}

function expectError(name, result, code) {
  const error = result.json?.error
  if (result.json?.ok !== false || error?.code !== code) {
    throw new Error(`${name}: expected ${code}, got ${JSON.stringify(result.json).slice(0, 300)}`)
  }
  console.log(`✓ ${name} -> ${code}`)
  return error
}

const health = await post('/codex-review/health')
console.log('health', JSON.stringify(health.json.value))

let target = pin
if (target === undefined) {
  const prs = await post('/codex-review/prs', { limit: 30 })
  const open = prs.json.value.items.filter((item) => item.state === 'open')
  if (open.length === 0) throw new Error('no open PR to exercise the merge guards')
  target = { repo: open[0].repo, number: open[0].number }
  console.log(`picked open PR ${target.repo}#${target.number} from the default query`)
} else {
  console.log(`pinned PR ${target.repo}#${target.number}`)
}

const detail = await post('/codex-review/pr', target)
if (detail.json.ok !== true) throw new Error(`pr failed: ${JSON.stringify(detail.json.error)}`)
const state = detail.json.value.summary.state
console.log(`target state=${state} files=${detail.json.value.files.length}`)
const staleSha = '0123456789abcdef0123456789abcdef01234567'

console.log('\n== merge guards (no real merge) ==')
expectError('missing confirm', await post('/codex-review/merge', {
  ...target, method: 'squash', expectedHeadSha: staleSha,
}), 'BAD_REQUEST')
expectError('invalid method', await post('/codex-review/merge', {
  ...target, method: 'nope', expectedHeadSha: staleSha, confirm: true,
}), 'BAD_REQUEST')
if (state === 'open') {
  const stale = await post('/codex-review/merge', {
    ...target, method: 'squash', expectedHeadSha: staleSha, confirm: true,
  })
  const staleError = expectError('stale head', stale, 'MERGE_HEAD_MOVED')
  if (String(staleError.message).length === 0) throw new Error('stale-head error message is empty')
  const after = await post('/codex-review/pr', target)
  if (after.json.value.summary.state !== 'open') throw new Error(`merge guards changed the PR state: ${after.json.value.summary.state}`)
  console.log('✓ PR state unchanged:', after.json.value.summary.state)
} else {
  console.log(`~ stale-head guard skipped: ${target.repo}#${target.number} is ${state}`)
}

console.log('\n== streaming chat (real model) ==')
const chatResponse = await fetch(base + '/codex-review/chat', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    ...target,
    messages: [{ role: 'user', content: '用三句话概括这个 PR 改了什么，并列出 1 个最值得注意的风险点。' }],
  }),
})
if (chatResponse.status !== 200) throw new Error(`chat HTTP ${chatResponse.status}: ${(await chatResponse.text()).slice(0, 300)}`)
if (!String(chatResponse.headers.get('content-type') ?? '').includes('text/event-stream')) {
  throw new Error(`chat content-type is not text/event-stream: ${chatResponse.headers.get('content-type')}`)
}
const reader = chatResponse.body.getReader()
const decoder = new TextDecoder()
let buffer = ''
let answer = ''
let done = false
let errorFrame
const startedAt = Date.now()
for (;;) {
  const { value, done: streamDone } = await reader.read()
  if (value !== undefined) buffer += decoder.decode(value, { stream: true })
  let boundary = buffer.indexOf('\n\n')
  while (boundary !== -1) {
    const frame = buffer.slice(0, boundary).trim()
    buffer = buffer.slice(boundary + 2)
    if (frame.startsWith('data:')) {
      const payload = frame.slice('data:'.length).trim()
      let parsed
      try {
        parsed = JSON.parse(payload)
      } catch {
        throw new Error(`unparsable SSE frame: ${payload.slice(0, 120)}`)
      }
      if (typeof parsed.delta === 'string') answer += parsed.delta
      if (parsed.done === true) done = true
      if (parsed.error !== undefined) errorFrame = parsed.error
    }
    boundary = buffer.indexOf('\n\n')
  }
  if (streamDone) break
}
const elapsedMs = Date.now() - startedAt
if (errorFrame !== undefined) throw new Error(`chat error frame: ${JSON.stringify(errorFrame)}`)
if (!done) throw new Error('chat stream ended without a done frame')
if (answer.trim().length < 20) throw new Error(`chat answer too short: ${JSON.stringify(answer.slice(0, 200))}`)
console.log(`✓ chat streamed ${answer.length} chars in ${elapsedMs}ms`)
console.log('--- answer preview ---')
console.log(answer.trim().slice(0, 500))
console.log('\nV2 SMOKE OK')
