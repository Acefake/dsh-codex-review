#!/usr/bin/env node
/**
 * Live smoke test for the GitHub data channel (CONTRACT §1.7).
 *
 * Runs without a DSH host: it uses the machine's real `gh` credentials
 * (`gh auth token`, or GH_TOKEN/GITHUB_TOKEN), lists the default PR query and
 * loads `Acefake/yingbox#129`, printing the normalized shape, timings and
 * truncation flags. Exits 0 only when the reconnaissance-known facts hold
 * (24 files, stack chain containing #117).
 *
 * Usage: node test/smoke-gh.mjs
 */

import { GUIDELINE_MAX_CHARS, GitHubClient } from '../lib/github.js'
import { resolveConfig } from '../lib/config.js'

const REPO = process.env.SMOKE_REPO ?? 'Acefake/yingbox'
const PR_NUMBER = Number(process.env.SMOKE_PR ?? 129)
/** Public repository with a root AGENTS.md, used to exercise the guidelines path. */
const GUIDELINE_REPO = process.env.SMOKE_GUIDELINE_REPO ?? 'sst/opencode'
/** Repository without AGENTS.md, used to prove the miss path degrades cleanly. */
const NO_GUIDELINE_REPO = process.env.SMOKE_NO_GUIDELINE_REPO ?? 'Acefake/sanguo'
const EXPECTED_FILES = 24
const EXPECTED_PARENT_PR = 117

const config = resolveConfig({ limit: 30, requestTimeoutMs: 20_000 })
const client = new GitHubClient({ config })
const startedAt = Date.now()

/**
 * Print one labelled fact.
 * @param {string} label - field label.
 * @param {unknown} value - value to print.
 */
function line(label, value) {
  console.log(`${label.padEnd(34)} ${String(value)}`)
}

try {
  const gh = await client.ghStatus()
  line('gh', gh)
  if (gh === 'missing') throw new Error('GitHub CLI (gh) is not installed')

  const listStarted = Date.now()
  const list = await client.listPullRequests({ query: 'is:open author:@me', limit: 30 })
  line('list.query', list.query)
  line('list.totalCount', list.totalCount)
  line('list.items', list.items.length)
  line('list.ms', Date.now() - listStarted)
  line('list.hasTargetPr', list.items.some((item) => item.number === PR_NUMBER))
  for (const item of list.items.slice(0, 5)) {
    console.log(`  #${item.number} ${item.repo} ${item.headRefName} -> ${item.baseRefName} ${item.title.slice(0, 36)}`)
  }

  const detailStarted = Date.now()
  const detail = await client.getPull(REPO, PR_NUMBER)
  line('detail.ms', Date.now() - detailStarted)
  line('detail.headSha', detail.headSha)
  line('detail.title', detail.summary.title)
  line('detail.author', detail.summary.author)
  line('detail.state', detail.summary.state)
  line('detail.additions/deletions', `${detail.summary.additions}/${detail.summary.deletions}`)
  line('detail.changedFiles', detail.summary.changedFiles)
  line('detail.files', detail.files.length)
  line('detail.filesTruncated', detail.filesTruncated)
  line('detail.bodyChars', detail.body.length)
  line('detail.bodyTruncated', detail.bodyTruncated)
  line('detail.patchChars', detail.files.reduce((sum, file) => sum + file.patch.length, 0))
  line('detail.patchTruncatedFiles', detail.files.filter((file) => file.patchTruncated).length)
  line('detail.comments.total', detail.comments.total)
  line('detail.comments.issue/reviews', `${detail.comments.issue.length}/${detail.comments.reviews.length}`)
  line('detail.comments.inline', detail.comments.inline.length)
  line('detail.checks', detail.checks.state)
  line('detail.stack.baseRefName', detail.stack.baseRefName)
  line('detail.stack.declaredBase', detail.stack.declaredBase ?? '(none)')
  line('detail.stack.basePr', detail.stack.basePr === undefined ? '(none)' : `#${detail.stack.basePr.number} (${detail.stack.basePr.state})`)
  line('detail.stack.chain', detail.stack.chain.length === 0 ? '(empty)' : detail.stack.chain.map((parent) => `#${parent.number}:${parent.state}`).join(' -> '))
  line('detail.stack.allBaseMerged', detail.stack.allBaseMerged)

  const largest = [...detail.files].sort((left, right) => right.patch.length - left.patch.length).slice(0, 5)
  for (const file of largest) {
    console.log(`  ${file.path} [${file.status}] +${file.additions} -${file.deletions} patch=${file.patch.length} truncated=${file.patchTruncated}`)
  }

  // Repository review guidelines (CONTRACT §4.4): the target PR's repository
  // (AGENTS.md added for the v1.1 demo) must load and truncate, a public
  // repository with a root AGENTS.md must load too, and a repository without
  // one must degrade to loaded=false without failing.
  /** @type {string[]} */
  const failures = []
  const guidelineStarted = Date.now()
  const targetGuidelines = await client.getGuidelines(REPO)
  line('guidelines.target.loaded', targetGuidelines.loaded)
  line('guidelines.target.files', targetGuidelines.files.length === 0 ? '(none)' : targetGuidelines.files.join(','))
  line('guidelines.target.chars', targetGuidelines.chars)
  line('guidelines.target.textChars', targetGuidelines.text.length)
  line('guidelines.target.ms', Date.now() - guidelineStarted)
  if (targetGuidelines.loaded) {
    if (targetGuidelines.files.length === 0 || targetGuidelines.text === '' || targetGuidelines.chars <= 0) {
      failures.push(`${REPO} reports guidelines without files/text`)
    }
    if (targetGuidelines.chars > GUIDELINE_MAX_CHARS || targetGuidelines.chars > targetGuidelines.text.length) {
      failures.push(`unexpected guideline char budget for ${REPO}: ${targetGuidelines.chars}`)
    }
  } else if (targetGuidelines.files.length !== 0 || targetGuidelines.chars !== 0 || targetGuidelines.text !== '') {
    failures.push(`${REPO} reports an inconsistent empty guideline payload`)
  }

  const loadedStarted = Date.now()
  const loadedGuidelines = await client.getGuidelines(GUIDELINE_REPO)
  line('guidelines.loaded.repo', GUIDELINE_REPO)
  line('guidelines.loaded.loaded', loadedGuidelines.loaded)
  line('guidelines.loaded.files', loadedGuidelines.files.join(','))
  line('guidelines.loaded.chars', loadedGuidelines.chars)
  line('guidelines.loaded.textChars', loadedGuidelines.text.length)
  line('guidelines.loaded.head', loadedGuidelines.text.slice(0, 60).replace(/\s+/g, ' '))
  line('guidelines.loaded.ms', Date.now() - loadedStarted)
  const cachedStarted = Date.now()
  const cachedGuidelines = await client.getGuidelines(GUIDELINE_REPO)
  line('guidelines.cached.ms', Date.now() - cachedStarted)
  if (loadedGuidelines.loaded !== true || loadedGuidelines.files.length === 0 || loadedGuidelines.text === '') {
    failures.push(`${GUIDELINE_REPO} must expose AGENTS.md guidelines`)
  }
  if (loadedGuidelines.chars > GUIDELINE_MAX_CHARS || loadedGuidelines.chars > loadedGuidelines.text.length) {
    failures.push(`unexpected guideline char budget: ${loadedGuidelines.chars}`)
  }
  if (cachedGuidelines.text !== loadedGuidelines.text) failures.push('guideline cache returned a different payload')

  const absentGuidelines = await client.getGuidelines(NO_GUIDELINE_REPO)
  line('guidelines.absent.repo', NO_GUIDELINE_REPO)
  line('guidelines.absent.loaded', absentGuidelines.loaded)
  line('guidelines.absent.files', absentGuidelines.files.length)
  if (absentGuidelines.loaded !== false || absentGuidelines.files.length !== 0 || absentGuidelines.text !== '') {
    failures.push(`${NO_GUIDELINE_REPO} must not report review guidelines`)
  }

  if (detail.files.length !== EXPECTED_FILES) failures.push(`expected ${EXPECTED_FILES} files, got ${detail.files.length}`)
  if (!detail.stack.chain.some((parent) => parent.number === EXPECTED_PARENT_PR)) failures.push(`stack chain must contain #${EXPECTED_PARENT_PR}`)
  if (detail.summary.headRefName !== 'feat/intro-detect') failures.push(`unexpected headRefName ${detail.summary.headRefName}`)
  if (detail.summary.baseRefName !== 'feat/skip-intro') failures.push(`unexpected baseRefName ${detail.summary.baseRefName}`)
  if (detail.summary.author !== 'Acefake') failures.push(`unexpected author ${detail.summary.author}`)
  if (detail.summary.additions !== 2117) failures.push(`unexpected additions ${detail.summary.additions}`)
  if (detail.summary.deletions !== 25) failures.push(`unexpected deletions ${detail.summary.deletions}`)

  line('total.ms', Date.now() - startedAt)
  if (failures.length > 0) {
    console.error('SMOKE FAILED:')
    for (const failure of failures) console.error(`  - ${failure}`)
    process.exit(1)
  }
  console.log('SMOKE OK')
} catch (error) {
  console.error(`SMOKE FAILED ${error?.code ?? error?.name ?? 'Error'}: ${error?.message ?? error}`)
  process.exit(1)
}
