/**
 * Verify the client bundle the running Host actually serves contains the v2.5
 * client changes. Read-only: fetches the page and the plugin bundle over HTTP.
 * Run: node verify/v25-bundle-check.mjs
 */

import { cookieForUrl } from './lib/util.mjs'

const BASE = process.env.DSH_GUI_URL || 'http://127.0.0.1:11702/'
const auth = await cookieForUrl(BASE, {})
const cookieHeader = auth === null || auth === undefined ? '' : `${auth.name}=${auth.value}`
const headers = cookieHeader === '' ? {} : { cookie: cookieHeader }

/**
 * Every preloaded script URL on the page. The plugin client bundles are served
 * through `<link rel="preload" as="script" href="plugins/??...">`, not a normal
 * script tag, so both carriers are read.
 * @param {string} html - served page.
 * @returns {string[]} absolute URLs.
 */
function scriptUrls(html) {
  const urls = []
  for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const raw = match[1].replaceAll('&amp;', '&')
    if (!raw.includes('/client.js')) continue
    urls.push(new URL(raw, BASE).toString())
  }
  return urls
}

const pageResponse = await fetch(BASE, { headers })
const html = await pageResponse.text()
const sources = scriptUrls(html)
const bundleUrl = sources.find((url) => url.includes('dsh-codex-review/client.js'))

if (bundleUrl === undefined) {
  console.error(`no plugin bundle URL found among ${sources.length} client bundle URLs`)
  process.exit(2)
}

const bundleResponse = await fetch(bundleUrl, { headers })
const source = await bundleResponse.text()

const expected = ['PUBLISH_TIMEOUT_MS', 'publishUnknown', 'REVIEW_PARTIAL', 'isPublishRouteMissing', 'timeoutMs: PUBLISH_TIMEOUT_MS']
const missing = expected.filter((needle) => !source.includes(needle))

console.log(`page status: ${pageResponse.status}`)
console.log(`bundle status: ${bundleResponse.status}, bytes: ${source.length}`)
console.log(`bundle url: ${bundleUrl.slice(0, 100)}...`)
for (const needle of expected) console.log(`${source.includes(needle) ? 'OK  ' : 'MISS'} ${needle}`)

if (missing.length > 0) {
  console.error(`served bundle is missing: ${missing.join(', ')}`)
  process.exit(1)
}
console.log('served bundle carries the v2.5 client changes')
