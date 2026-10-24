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

/** Dev-only bookkeeping used by check-preview to assert what the client sent. */
const devState = {
  mergeCount: 0,
  lastMerge: null,
  chatCount: 0,
  lastChat: null,
}

/** Deterministic mock answer for /codex-review/chat, streamed frame by frame. */
function chatAnswerParts(payload) {
  const messages = Array.isArray(payload.messages) ? payload.messages : []
  let question = ''
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message && message.role === 'user' && typeof message.content === 'string') {
      question = message.content
      break
    }
  }
  const number = Number(payload.number) || 129
  const focus = typeof payload.focusFile === 'string' && payload.focusFile !== '' ? payload.focusFile : ''
  return [
    `关于 #${number}「${question.slice(0, 40) || '这个 PR'}」：\n\n`,
    '这个 PR 主要做了三件事：\n',
    '1. 音频指纹提取与两两比对（`ffmpeg.ts` / `match.ts`）；\n',
    '2. 多集投票与结果合并（`vote.ts` / `skip-store.ts`）；\n',
    '3. 播放器侧跳过与手动标记优先级（`detect-merge.ts`）。\n\n',
    '风险点集中在队列取消与长季全量扫描，建议先补回归测试。',
    focus === '' ? '' : `\n\n当前聚焦文件：\`${focus}\`。`,
  ]
}

/** depth presets from CONTRACT.md §4.1; the mock echoes them like the Host does. */
const DEPTH_PRESETS = {
  fast: { depth: 'fast', chunkChars: 16000, maxChunks: 6, concurrency: 4 },
  standard: { depth: 'standard', chunkChars: 9000, maxChunks: 9, concurrency: 3 },
  deep: { depth: 'deep', chunkChars: 6000, maxChunks: 20, concurrency: 2 },
}

/** Resolve the optional review-start options into the echo the client renders. */
function resolveOptions(payload) {
  const raw = payload && typeof payload.options === 'object' && payload.options ? payload.options : {}
  const preset = DEPTH_PRESETS[raw.depth] || DEPTH_PRESETS.standard
  const threshold =
    raw.severityThreshold === 'P0' || raw.severityThreshold === 'P1' ? raw.severityThreshold : 'P2'
  const includeGuidelines = raw.includeGuidelines === undefined ? true : Boolean(raw.includeGuidelines)
  return { ...preset, severityThreshold: threshold, includeGuidelines }
}

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
  const detail = readMock(
    payload.mockScenario === 'comments' && number === 129 ? 'pr-129-comments.json' : 'pr-129.json',
  )
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
  if (job.mode === 'running') return { ...base, options: job.options }
  if (job.calls <= 1) {
    return {
      ...readMock('review-running.json'),
      jobId: job.id,
      options: job.options,
      progress: {
        ...readMock('review-running.json').progress,
        filesDone: Math.min(6, base.progress.filesTotal),
      },
    }
  }
  return {
    ...base,
    jobId: job.id,
    options: job.options,
    progress: { ...base.progress, startedAt: Date.now() - Math.max(1200, base.progress.elapsedMs) },
  }
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
      const options = resolveOptions(payload)
      const headSha = readMock('review-done.json').headSha
      // cached=true when the same headSha + options + mock mode already finished
      // (CONTRACT §4.1). mockMode is dev-only and keeps the scenes independent.
      const key = `${payload.repo || ''}#${payload.number || ''}|${headSha}|${mode}|${JSON.stringify(options)}`
      const existing = [...reviewJobs.values()].find((job) => job.key === key && job.calls > 1)
      if (existing) {
        ok(res, { jobId: existing.id, headSha, cached: true, options })
        return
      }
      const id = `mock-job-${reviewJobs.size + 1}-${mode}`
      reviewJobs.set(id, { id, mode, calls: 0, key, options })
      ok(res, { jobId: id, headSha, cached: false, options })
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
    // v2 write route (CONTRACT §5.1): mirrors the Host guards, never touches GitHub.
    case '/codex-review/merge': {
      devState.mergeCount += 1
      devState.lastMerge = {
        repo: payload.repo,
        number: payload.number,
        method: payload.method,
        expectedHeadSha: payload.expectedHeadSha,
        deleteBranch: Boolean(payload.deleteBranch),
        commitTitle: payload.commitTitle || '',
        confirm: payload.confirm,
      }
      if (payload.confirm !== true) {
        fail(res, 'BAD_REQUEST', 'confirm 必须为 true')
        return
      }
      const detail = readMock('pr-129.json')
      const currentHead = typeof detail.headSha === 'string' ? detail.headSha : ''
      const mockMerge = typeof payload.mockMerge === 'string' ? payload.mockMerge : ''
      if (mockMerge === 'head-moved' || (currentHead !== '' && String(payload.expectedHeadSha) !== currentHead)) {
        fail(res, 'MERGE_HEAD_MOVED', `PR 有新提交（当前 ${currentHead.slice(0, 12)}）`)
        return
      }
      if (mockMerge === 'conflict') {
        fail(res, 'MERGE_CONFLICT', '存在合并冲突')
        return
      }
      if (mockMerge === 'not-allowed') {
        fail(res, 'MERGE_NOT_ALLOWED', '该 PR 当前不可合并')
        return
      }
      ok(res, {
        merged: true,
        sha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
        message: `Mock ${String(payload.method || 'squash')} merge done`,
        branchDeleted: payload.deleteBranch === true,
      })
      return
    }
    // v2 streaming route (CONTRACT §5.2): scripts SSE frames for preview/tests.
    case '/codex-review/chat': {
      devState.chatCount += 1
      devState.lastChat = {
        repo: payload.repo,
        number: payload.number,
        focusFile: typeof payload.focusFile === 'string' ? payload.focusFile : '',
        messages: Array.isArray(payload.messages)
          ? payload.messages.map((message) => ({
              role: message && message.role,
              content: message && typeof message.content === 'string' ? message.content.slice(0, 200) : '',
            }))
          : [],
      }
      const mode = typeof payload.mockChat === 'string' ? payload.mockChat : 'stream'
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      if (mode === 'error') {
        res.write(`data: ${JSON.stringify({ error: { code: 'LLM_UNAVAILABLE', message: '宿主没有可用的模型。' } })}\n\n`)
        res.end()
        return
      }
      const parts = chatAnswerParts(payload)
      const delayMs = mode === 'slow' ? 450 : 90
      let index = 0
      let closed = false
      const stop = () => {
        closed = true
        clearInterval(timer)
      }
      const timer = setInterval(() => {
        if (closed) return
        if (index < parts.length) {
          res.write(`data: ${JSON.stringify({ delta: parts[index] })}\n\n`)
          index += 1
          return
        }
        clearInterval(timer)
        res.write(
          `data: ${JSON.stringify({ done: true, model: { provider: 'mock', model: 'mock-review-chat' } })}\n\n`,
        )
        res.end()
      }, delayMs)
      req.on('close', stop)
      return
    }
    // dev-only: what the client sent (used by check-preview assertions)
    case '/codex-review/dev-state': {
      ok(res, devState)
      return
    }
    // dev-only: forget cached jobs so each screenshot/mock run starts clean
    case '/codex-review/dev-reset': {
      reviewJobs.clear()
      devState.mergeCount = 0
      devState.lastMerge = null
      devState.chatCount = 0
      devState.lastChat = null
      ok(res, { reset: true })
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
  console.log(
    '  ?scene=default|changes|review|running|error|empty|health|v11-*|v2-merge-dialog|v2-chat',
  )
  console.log('  ?theme=dark|light')
})
