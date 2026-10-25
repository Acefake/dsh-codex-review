import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-autopull-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const remote = join(root, 'remote'), work = join(root, 'work')
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  mkdirSync(remote)
  git(remote, 'init', '-b', 'master')
  git(remote, 'config', 'user.name', 'Test')
  git(remote, 'config', 'user.email', 'test@example.com')
  writeFileSync(join(remote, 'file'), 'initial')
  git(remote, 'add', '.')
  git(remote, 'commit', '-m', 'initial')
  git(root, 'clone', remote, work)
  mkdirSync(join(work, 'tools'))
  copyFileSync(new URL('../../tools/autopull.mjs', import.meta.url), join(work, 'tools', 'autopull.mjs'))
  writeFileSync(join(work, '.git', 'info', 'exclude'), 'tools/\nverify/\n')
  const initial = git(work, 'rev-parse', 'HEAD')
  writeFileSync(join(remote, 'file'), 'master update')
  git(remote, 'commit', '-am', 'master update')
  const master = git(remote, 'rev-parse', 'HEAD')
  git(remote, 'checkout', '-b', 'release')
  writeFileSync(join(remote, 'file'), 'release update')
  git(remote, 'commit', '-am', 'release update')
  git(work, 'fetch', 'origin')
  const run = (...args) => spawnSync(process.execPath, ['tools/autopull.mjs', ...args], { cwd: work, encoding: 'utf8' })
  return { work, git, initial, master, run }
}

test('auto-pull refuses an unexpected or missing upstream', t => {
  const f = fixture(t)
  f.git(f.work, 'branch', '--set-upstream-to=origin/release', 'master')
  let result = f.run()
  assert.equal(result.status, 1)
  assert.match(result.stdout, /tracking origin\/release, expected origin\/master/)
  assert.equal(f.git(f.work, 'rev-parse', 'HEAD'), f.initial)
  f.git(f.work, 'branch', '--unset-upstream')
  result = f.run()
  assert.equal(result.status, 1)
  assert.match(result.stdout, /tracking \(none\)/)
  assert.equal(f.git(f.work, 'rev-parse', 'HEAD'), f.initial)
})

test('auto-pull fast-forwards exactly to origin/master, then reports up-to-date', t => {
  const f = fixture(t)
  assert.equal(f.run().status, 0)
  assert.equal(f.git(f.work, 'rev-parse', 'HEAD'), f.master)
  assert.match(f.run().stdout, /^UP-TO-DATE/)
})

test('auto-pull preserves dirty checkouts and dry-run never advances HEAD', t => {
  const f = fixture(t)
  assert.match(f.run('--dry-run').stdout, /dry-run: would fast-forward/)
  assert.equal(f.git(f.work, 'rev-parse', 'HEAD'), f.initial)
  writeFileSync(join(f.work, 'file'), 'local edits')
  const result = f.run()
  assert.equal(result.status, 1)
  assert.match(result.stdout, /uncommitted/)
  assert.equal(f.git(f.work, 'rev-parse', 'HEAD'), f.initial)
})
