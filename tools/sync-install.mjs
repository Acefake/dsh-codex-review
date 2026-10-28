#!/usr/bin/env node
/**
 * Sync this checkout into an installed DSH profile, then verify the Host
 * picked it up.
 *
 * Why: the DSH plugin manager may reinstall `github:Acefake/dsh-codex-review`
 * from an older ref and silently downgrade the installed copy. This script
 * copies the working tree over the installed package, checks the version, and
 * nudges the profile patch so the Host recomposes the plugin roster.
 *
 * Usage:
 *   node tools/sync-install.mjs                    # sync default desktop profile
 *   node tools/sync-install.mjs --profile work     # another profile
 *   node tools/sync-install.mjs --url http://127.0.0.1:56881
 *   node tools/sync-install.mjs --dry-run          # only report paths/versions
 *   node tools/sync-install.mjs --no-reload        # copy + verify, skip reload
 *   node tools/sync-install.mjs --force-reload     # reload even when the host already matches
 *
 * Exit code 0 = installed copy matches this checkout and (unless --no-reload)
 * the Host reports the same plugin version.
 */

import { cpSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Parse `--key value` / `--flag` arguments. */
function parseArgs(argv) {
  const args = { profile: 'desktop', url: 'http://127.0.0.1:51356', dryRun: false, reload: true, forceReload: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--dry-run') args.dryRun = true
    else if (arg === '--no-reload') args.reload = false
    else if (arg === '--force-reload') args.forceReload = true
    else if (arg === '--profile') args.profile = argv[++index]
    else if (arg === '--url') args.url = argv[++index]
    else if (arg === '--target') args.target = argv[++index]
    else if (arg === '--help' || arg === '-h') args.help = true
    else {
      console.error(`unknown argument: ${arg}`)
      process.exit(2)
    }
  }
  return args
}

/** Read a package.json version without throwing. */
function versionOf(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8')).version ?? ''
  } catch {
    return ''
  }
}

/** Sleep helper for the reload probe. */
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

/** POST one route and return `{ status, json }`; null json when the body is not JSON. */
async function post(baseUrl, route, body) {
  const response = await fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  const text = await response.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    json = null
  }
  return { status: response.status, json, text: text.slice(0, 200) }
}

/** Read the host health route; null when the plugin is not registered or not JSON. */
async function health(baseUrl) {
  try {
    const { status, json, text } = await post(baseUrl, '/codex-review/health', {})
    if (status !== 200 || json?.ok !== true) return { ok: false, status, text }
    return { ok: true, status, value: json.value ?? {} }
  } catch (error) {
    return { ok: false, status: 0, text: String(error?.message ?? error) }
  }
}

/** Nudge one real config value so the loader recomposes the plugin row. */
async function triggerReload(patchPath, baseUrl, expectedVersion) {
  const original = readFileSync(patchPath, 'utf8')
  const match = original.match(/(\n\s*viewerLogin:\s*)([^\n]*)/)
  if (match === null) {
    return { ok: false, reason: 'profile patch has no viewerLogin line to toggle' }
  }
  const marker = `${match[2].trim()}__sync`
  const toggled = original.replace(/(\n\s*viewerLogin:\s*)([^\n]*)/, `$1${marker}`)
  try {
    writeFileSync(patchPath, toggled, 'utf8')
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await sleep(2_000)
      const result = await health(baseUrl)
      if (result.ok === true && result.value.version === expectedVersion) return { ok: true, value: result.value }
    }
    return { ok: false, reason: 'host did not report the expected version after reload' }
  } finally {
    writeFileSync(patchPath, original, 'utf8')
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log('usage: node tools/sync-install.mjs [--profile desktop] [--url http://127.0.0.1:51356] [--dry-run] [--no-reload] [--force-reload]')
    return 0
  }

  const repoVersion = versionOf(join(repoRoot, 'package.json'))
  const pluginVersion = versionOf(join(repoRoot, 'plugin', 'package.json'))
  if (repoVersion === '' || repoVersion !== pluginVersion) {
    console.error(`version mismatch in this checkout: root=${repoVersion} plugin=${pluginVersion}`)
    return 1
  }

  const profileDir = join(homedir(), '.dsh', 'profiles', args.profile)
  const installed = args.target !== undefined
    ? resolve(args.target)
    : join(profileDir, 'node_modules', 'dsh-codex-review')
  const patchPath = join(profileDir, 'cordis.patch.yml')

  console.log(`checkout:  ${repoRoot} (${repoVersion})`)
  console.log(`installed: ${installed} (${versionOf(join(installed, 'plugin', 'package.json')) || 'missing'})`)
  console.log(`patch:     ${patchPath}`)
  console.log(`host:      ${args.url}`)

  if (args.dryRun) return 0
  if (!existsSync(installed)) {
    console.error(`installed package missing: ${installed}`)
    return 1
  }

  // Copy the publishable surface; keep node_modules/lockfiles untouched.
  for (const [from, to] of [
    [join(repoRoot, 'package.json'), join(installed, 'package.json')],
    [join(repoRoot, 'README.md'), join(installed, 'README.md')],
    [join(repoRoot, 'plugin'), join(installed, 'plugin')],
  ]) {
    if (!existsSync(from)) continue
    cpSync(from, to, { recursive: statSync(from).isDirectory(), force: true })
  }

  const installedVersion = versionOf(join(installed, 'plugin', 'package.json'))
  if (installedVersion !== repoVersion) {
    console.error(`copy failed: installed plugin version is ${installedVersion || 'missing'}, expected ${repoVersion}`)
    return 1
  }
  for (const file of ['index.js', 'client.js', 'lib/gitlab.js', 'lib/publish.js', 'REVIEW_POLICY.md']) {
    if (!existsSync(join(installed, 'plugin', file))) {
      console.error(`copy failed: missing plugin/${file}`)
      return 1
    }
  }
  console.log(`copied:    ${repoVersion}`)

  if (!args.reload) {
    console.log('reload skipped (--no-reload)')
    return 0
  }

  const before = await health(args.url)
  console.log(`health:    ${before.ok ? `version ${before.value.version}, provider ${before.value.provider}` : `not ok (status ${before.status})`}`)

  const expected = repoVersion
  if (before.ok === true && before.value.version === expected && args.forceReload !== true) {
    console.log('host already reports the expected version; no reload needed (use --force-reload to force)')
    return 0
  }

  const reloaded = await triggerReload(patchPath, args.url, expected)
  if (reloaded.ok !== true) {
    console.error(`reload failed: ${reloaded.reason}. Restart DSH to pick up the new files.`)
    return 1
  }
  console.log(`health:    version ${reloaded.value.version}, provider ${reloaded.value.provider}`)

  // Deep check: the account and list routes must answer JSON, not HTML/empty.
  const accounts = await post(args.url, '/codex-review/accounts', {})
  if (accounts.status !== 200 || accounts.json?.ok !== true) {
    console.error(`accounts route failed: status ${accounts.status} body ${accounts.text}`)
    return 1
  }
  console.log(`accounts:  ${accounts.json.value.accounts.length} account(s), default ${accounts.json.value.defaultAccount}`)
  return 0
}

process.exitCode = await main()
