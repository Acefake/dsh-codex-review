#!/usr/bin/env node
/**
 * Lead integration smoke for the v1.1 review options / cache / threshold.
 *
 * Sequence (cheap 鈫?cheap):
 *  1. start a `fast` review (real model calls) and poll to a terminal state;
 *  2. start the same options again  鈫?must be `cached: true` with the same job id;
 *  3. start `standard` for the same head 鈫?must reuse every file (`reusedFiles` = filesTotal, ~0 model calls);
 *  4. report the v1.1 fields (options / guidelines / verdict / reusedFiles).
 */
const base = 'http://127.0.0.1:2632'
const repo = process.argv[2] ?? 'Acefake/yingbox'
const number = Number(process.argv[3] ?? 129)
const FAST_OPTIONS = { depth: 'fast', severityThreshold: 'P2', includeGuidelines: true }

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

async function waitJob(jobId, label, timeoutMs = 8 * 60_000) {
  const deadline = Date.now() + timeoutMs
  let last = ''
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 2000))
    const status = await post('/codex-review/review-status', { jobId })
    const line = `${status.state} ${status.progress.filesDone}/${status.progress.filesTotal} findings=${status.findings.length}`
    if (line !== last) {
      console.log(`[${label}] ${line} ${status.progress.elapsedMs}ms`)
      last = line
    }
    if (['done', 'error', 'cancelled'].includes(status.state)) return status
    if (Date.now() > deadline) throw new Error(`${label}: timeout, last=${line}`)
  }
}

function summarize(status) {
  return {
    jobId: status.jobId,
    state: status.state,
    partial: status.partial,
    elapsedMs: status.progress.elapsedMs,
    filesDone: status.progress.filesDone,
    filesTotal: status.progress.filesTotal,
    reusedFiles: status.reusedFiles ?? 0,
    options: status.options,
    guidelines: status.guidelines,
    verdict: status.verdict,
    findings: status.findings.length,
    severities: status.findings.reduce((acc, finding) => {
      acc[finding.severity] = (acc[finding.severity] ?? 0) + 1
      return acc
    }, {}),
    overview: status.overview,
    error: status.error,
  }
}

const health = await post('/codex-review/health')
console.log('health', JSON.stringify(health))
const llm = await post('/codex-review/llm-info')
console.log('llm', JSON.stringify({ selection: llm.selection, effort: llm.reasoningEffort, transport: llm.transport }))

const detail = await post('/codex-review/pr', { repo, number })
console.log('pr', JSON.stringify({
  title: detail.summary.title,
  files: detail.files.length,
  reviewState: detail.review?.state,
  headSha: detail.review?.headSha?.slice(0, 10),
}))

console.log('\n== 1) fast review (real model calls) ==')
const started = await post('/codex-review/review-start', { repo, number, options: FAST_OPTIONS })
console.log('started', JSON.stringify(started))
const finished = await waitJob(started.jobId, 'fast')
console.log('fast', JSON.stringify(summarize(finished), null, 1))
if (finished.state !== 'done') throw new Error(`fast review not done: ${JSON.stringify(finished.error)}`)
if (finished.options?.depth !== 'fast') throw new Error('options were not echoed back / not resolved')

console.log('\n== 2) same options again (expect cached) ==')
const again = await post('/codex-review/review-start', { repo, number, options: FAST_OPTIONS })
console.log('again', JSON.stringify(again))
if (again.cached !== true) throw new Error('same options + same head should be cached')
if (again.jobId !== started.jobId) throw new Error('cached call returned a different job id')

console.log('\n== 3) standard depth, same head (expect file-level reuse, no model calls) ==')
const standard = await post('/codex-review/review-start', { repo, number, options: { depth: 'standard', severityThreshold: 'P2', includeGuidelines: true } })
console.log('standard started', JSON.stringify(standard))
const reused = await waitJob(standard.jobId, 'standard')
const reuseSummary = summarize(reused)
console.log('standard', JSON.stringify(reuseSummary, null, 1))
if (reused.state !== 'done') throw new Error(`standard review not done: ${JSON.stringify(reused.error)}`)
if ((reused.reusedFiles ?? 0) !== reused.progress.filesTotal) throw new Error(`expected all files reused, got ${reused.reusedFiles}/${reused.progress.filesTotal}`)
if (reused.progress.elapsedMs > 5000) throw new Error(`expected fast cache hit, took ${reused.progress.elapsedMs}ms`)

const prAfter = await post('/codex-review/pr', { repo, number })
console.log('\npr review snapshot', JSON.stringify({
  state: prAfter.review?.state,
  verdict: prAfter.review?.verdict,
  reusedFiles: prAfter.review?.reusedFiles,
  guidelines: prAfter.review?.guidelines,
  options: prAfter.review?.options,
  findings: prAfter.review?.findings?.length,
}))
console.log('\nV11 SMOKE OK')

