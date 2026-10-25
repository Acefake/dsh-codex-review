/**
 * Guard against encoding damage in the files this plugin ships.
 *
 * A PowerShell `Get-Content`/`Set-Content` round trip used to silently rewrite
 * Chinese text as mojibake. This script fails when a shipped text file contains
 * U+FFFD (the replacement character) or loses all of its CJK text.
 *
 * Run: node plugin/dev/check-encoding.mjs
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Files that must keep readable Chinese text. */
const REQUIRED_CJK = [
  'index.js',
  'client.js',
  'CONTRACT.md',
  'README.md',
  'lib/errors.js',
  'lib/publish.js',
  'lib/github.js',
  'lib/auto-review.js',
  'lib/review.js',
  'lib/http.js',
]

/** Files that only need to be free of replacement characters. */
const NO_REPLACEMENT_ONLY = ['package.json', 'cordis.patch.yml']

/**
 * Count occurrences of one pattern in a text.
 * @param {string} text - file contents.
 * @param {RegExp} pattern - global pattern.
 * @returns {number} match count.
 */
function count(text, pattern) {
  return (text.match(pattern) ?? []).length
}

/** @type {string[]} */
const problems = []

for (const file of REQUIRED_CJK) {
  const text = readFileSync(join(root, file), 'utf8')
  const replacement = count(text, /\uFFFD/g)
  const cjk = count(text, /[\u4e00-\u9fff]/g)
  if (replacement > 0) problems.push(`${file}: ${replacement} replacement characters (U+FFFD)`)
  if (cjk === 0) problems.push(`${file}: no CJK text left (encoding was lost)`)
}

for (const file of NO_REPLACEMENT_ONLY) {
  const text = readFileSync(join(root, file), 'utf8')
  const replacement = count(text, /\uFFFD/g)
  if (replacement > 0) problems.push(`${file}: ${replacement} replacement characters (U+FFFD)`)
}

if (problems.length > 0) {
  console.error('encoding check failed:')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log(`encoding check passed (${REQUIRED_CJK.length + NO_REPLACEMENT_ONLY.length} files)`)
