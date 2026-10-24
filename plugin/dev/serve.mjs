#!/usr/bin/env node
/**
 * Zero-dependency development server for the Code Review workbench.
 *
 * Serves the preview shell, the very same `plugin/client.js` the Host ships, the
 * vendored React UMD builds, and a mock implementation of every `/codex-review/*`
 * route with the exact same `{ok, value}` / `{ok: false, error}` envelope as the
 * Host half (CONTRACT.md §1.1). Nothing here is included in the installed
 * package; it exists so the UI can be exercised and screenshotted without
 * installing the plugin into a profile.
 *
 * Usage: node plugin/dev/serve.mjs [--port 4317] [--host 127.0.0.1]
 */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.resolve(here, '..')
const mockDir = path.join(here, 'mock')

function readArg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

const PORT = Number(readArg('port', '4317'))
const HOST = readArg('host', '127.0.0.1')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
}

/** Route table for the mock Host: maps pathname to the mock JSON file. */
const MOCKS = {
  '/codex-review/health': 'health.json',
}

const reviewJobs = new Map()

function readMock(name) {
  return JSON.parse(fs.readFileSync(path.join(mockDir, name), 'utf8'))
}

function ok(res, value) {
  sendJson(res, 200, { ok: true, value })
}

function fail(res, code, message, status = 200) {
  sendJson(res, status, { ok: false, error: { code, message } })
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 1_000_000) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (!text) return resolve({})
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(new Error('invalid JSON'))
      }
    })
    req.on('error', reject)
  })
}

/** PR list, filtered the way the Host would filter a GitHub search. */
function listPullRequests(payload) {
  const query = String(payload.query ?? '').trim()
  const source = /is:closed/i.test(query) ? readMock('prs-closed.json') : readMock('prs.json')
  const keyword = query
    .replace(/\b(is|author|label|review|repo|state):\S+/gi, '')
    .trim()
    .toLowerCase()
  const items = keyword
    ? source.items.filter(
        (item) =>
          String(item.title).toLowerCase().includes(keyword) ||
          String(item.author).toLowerCase().includes(keyword),
      )
    : source.items
  return { query: query || source.query, totalCount: items.length, items }
}

function prDetail(payload) {
  const number = Number(payload.number)
  const detail = readMock('pr-129.json')
  if (number === 129) return detail
  const generic = readMock('pr-generic.json')
  const list = readMock('prs.json')
  const summary = list.items.find((item) => item.number === number)
  if (summary) generic.summary = { ...summary, changedFiles: generic.files.length }
  return generic
}

function statusFor(job) {
  const base = readMock(
    job.mode === 'empty'
      ? 'review-empty.json'
      : job.mode === 'error'
        ? 'review-error.json'
        : job.mode === 'running'
          ? 'review-running.json'
          : job.mode === 'partial'
            ? 'review-partial.json'
            : 'review-done.json',
  )
  job.calls += 1
  if (job.mode === 'running') return base
  if (job.calls <= 1) {
    return { ...readMock('review-running.json'), jobId: job.id, progress: { ...readMock('review-running.json').progress, filesDone: Math.min(6, base.progress.filesTotal) } }
  }
  return { ...base, jobId: job.id, progress: { ...base.progress, startedAt: Date.now() - Math.max(1200, base.progress.elapsedMs) } }
}

async function handleApi(req, res, pathname) {
  if (req.method !== 'POST') {
    fail(res, 'BAD_REQUEST', '仅支持 POST', 405)
    return
  }
  let payload = {}
  try {
    payload = await readBody(req)
  } catch (error) {
    fail(res, 'BAD_REQUEST', `请求体不合法：${error.message}`)
    return
  }

  if (Object.hasOwn(MOCKS, pathname)) {
    ok(res, readMock(MOCKS[pathname]))
    return
  }

  switch (pathname) {
    case '/codex-review/prs':
      ok(res, listPullRequests(payload))
      return
    case '/codex-review/pr':
      ok(res, prDetail(payload))
      return
    case '/codex-review/review-start': {
      const mode = typeof payload.mockMode === 'string' ? payload.mockMode : 'done'
      const id = `mock-job-${reviewJobs.size + 1}-${mode}`
      reviewJobs.set(id, { id, mode, calls: 0 })
      ok(res, { jobId: id, headSha: readMock('pr-129.json').summary.headRefName, cached: false })
      return
    }
    case '/codex-review/review-status': {
      const job = reviewJobs.get(String(payload.jobId))
      if (!job) {
        fail(res, 'BAD_REQUEST', '未知的审查任务')
        return
      }
      ok(res, statusFor(job))
      return
    }
    case '/codex-review/review-cancel': {
      const job = reviewJobs.get(String(payload.jobId))
      if (job) job.cancelled = true
      ok(res, { cancelled: true })
      return
    }
    default:
      fail(res, 'GH_NOT_FOUND', `没有这个路由：${pathname}`, 404)
  }
}

function serveFile(res, filePath) {
  let stat
  try {
    stat = fs.statSync(filePath)
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('not found')
    return
  }
  if (!stat.isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('not found')
    return
  }
  res.writeHead(200, {
    'content-type': MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream',
    'cache-control': 'no-store',
    'content-length': stat.size,
  })
  fs.createReadStream(filePath).pipe(res)
}

/** Resolve a URL pathname to a file inside the dev tree or the plugin root. */
function resolveStatic(pathname) {
  const clean = decodeURIComponent(pathname.split('?')[0])
  if (clean === '/' || clean === '/index.html') return path.join(here, 'preview.html')
  if (clean === '/client.js') return path.join(pluginRoot, 'client.js')
  if (clean.startsWith('/vendor/') || clean.startsWith('/mock/') || clean.startsWith('/shots/')) {
    return path.join(here, clean)
  }
  return path.join(here, clean)
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  const pathname = url.pathname
  const started = Date.now()

  res.on('finish', () => {
    console.log(`${String(res.statusCode).padEnd(4)} ${req.method.padEnd(4)} ${pathname} ${Date.now() - started}ms`)
  })

  if (pathname.startsWith('/codex-review/')) {
    handleApi(req, res, pathname).catch((error) => fail(res, 'INTERNAL', String(error?.message ?? error), 500))
    return
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('method not allowed')
    return
  }
  serveFile(res, resolveStatic(pathname))
})

server.listen(PORT, HOST, () => {
  console.log(`Code Review preview: http://${HOST}:${PORT}/`)
  console.log('  ?scene=default|changes|review|running|error|empty|health')
  console.log('  ?theme=dark|light')
})
