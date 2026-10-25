#!/usr/bin/env node
/**
 * Auto-pull guard for this checkout: fetch `origin/master` and fast-forward the
 * working tree only when it is safe to do so.
 *
 * Safety rules, in order:
 *   1. no uncommitted changes (staged / unstaged / untracked)      -> skip
 *   2. on the `master` branch, tracking `origin/master`            -> else skip
 *   3. remote commit is a fast-forward of HEAD                     -> else skip
 *   4. `git pull --ff-only` must succeed                           -> else report
 *
 * Never rebases, never stashes, never touches a dirty tree: a skipped run is
 * reported as `SKIP` with the reason, so a human can decide.
 *
 *   node tools/autopull.mjs            # one check
 *   node tools/autopull.mjs --dry-run  # report only, no pull
 *
 * Exit codes: 0 = up to date / pulled, 1 = skipped (dirty tree, diverged, wrong
 * branch), 2 = git failure.
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const LOG_DIR = path.join(ROOT, 'verify', 'out')
const LOG_FILE = path.join(LOG_DIR, 'autopull.log')

/** Run git in the checkout and return trimmed stdout; throws on non-zero exit. */
function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

/** Append one line to the rolling log, creating verify/out when missing. */
function log(line) {
  try {
    mkdirSync(LOG_DIR, { recursive: true })
    appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`, 'utf8')
  } catch {
    /* logging must never fail the guard */
  }
}

/**
 * @returns {{ status: 'up-to-date' | 'pulled' | 'skip' | 'error', detail: string }}
 */
function run() {
  const dryRun = process.argv.includes('--dry-run')
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'])
  if (branch !== 'master') return { status: 'skip', detail: `on branch ${branch}, expected master` }

  const dirty = git(['status', '--porcelain=v1'])
  if (dirty !== '') {
    const lines = dirty.split('\n').length
    return { status: 'skip', detail: `working tree has ${lines} uncommitted change(s)` }
  }

  git(['fetch', 'origin', '--prune', '--quiet'])
  const local = git(['rev-parse', 'HEAD'])
  const remote = git(['rev-parse', 'origin/master'])
  if (local === remote) return { status: 'up-to-date', detail: `HEAD ${local.slice(0, 7)}` }

  const behind = git(['rev-list', '--count', `HEAD..origin/master`])
  const ahead = git(['rev-list', '--count', `origin/master..HEAD`])
  if (Number(ahead) > 0) {
    return { status: 'skip', detail: `diverged: ${ahead} ahead / ${behind} behind` }
  }
  if (dryRun) return { status: 'skip', detail: `dry-run: would fast-forward ${behind} commit(s)` }

  git(['pull', '--ff-only', '--quiet'])
  const head = git(['rev-parse', 'HEAD'])
  return { status: 'pulled', detail: `fast-forwarded ${behind} commit(s) to ${head.slice(0, 7)}` }
}

let result
try {
  result = run()
} catch (error) {
  const message = String((error && (error.stderr || error.message)) || error).trim().split('\n')[0]
  result = { status: 'error', detail: message }
}
const line = `${result.status.toUpperCase()} ${result.detail}`
console.log(line)
log(line)
process.exit(result.status === 'error' ? 2 : result.status === 'skip' ? 1 : 0)
