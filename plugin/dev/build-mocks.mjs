#!/usr/bin/env node
/**
 * Generate the development-only mock API payloads from the real `gh` probe.
 *
 * Source of truth: `recon/probe-output.json` (captured by recon/gh-probe.mjs from
 * Acefake/yingbox). The generated files in `plugin/dev/mock/` mirror the wire
 * types of CONTRACT.md §1.2 so `plugin/dev/serve.mjs` can answer the exact same
 * routes as the Host half, with the exact same `{ok, value}` envelope.
 *
 * Usage: node plugin/dev/build-mocks.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')
const probe = JSON.parse(fs.readFileSync(path.join(root, 'recon/probe-output.json'), 'utf8'))
const outDir = path.join(here, 'mock')
fs.mkdirSync(outDir, { recursive: true })

const REPO = 'Acefake/yingbox'

/** Normalize one probe search item into the contract's PrSummary. */
function toSummary(item) {
  return {
    repo: REPO,
    number: item.number,
    title: item.title,
    author: item.author?.login ?? 'unknown',
    isDraft: Boolean(item.isDraft),
    state: 'open',
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    headRefName: item.headRefName,
    baseRefName: item.baseRefName,
    reviewDecision: item.reviewDecision ?? '',
    additions: item.additions ?? 0,
    deletions: item.deletions ?? 0,
    changedFiles: item.changedFiles ?? 0,
    url: item.url,
  }
}

const items = (probe.openPrs?.items ?? []).map(toSummary)
// Demo ordering: the reference window shows PR #129 as the first (selected) row.
items.sort((a, b) => (a.number === 129 ? -1 : b.number === 129 ? 1 : 0))
const pr129 = items.find((item) => item.number === 129) ?? items[0]
const headSha = probe.pr?.data?.headRefOid ?? '2e4024f903'.padEnd(40, '0')

/** Convert a probe `files.items[]` entry into a contract FilePatch. */
function toFilePatch(file) {
  return {
    path: file.filename,
    status: file.status,
    additions: file.additions ?? 0,
    deletions: file.deletions ?? 0,
    patch: typeof file.patch === 'string' ? file.patch : '',
    patchTruncated: Boolean(file.patchTruncated),
  }
}

const files = (probe.files?.items ?? []).map(toFilePatch)

/**
 * Walk a unified diff and return the new-file line numbers of added rows.
 * Findings must point at a line that exists on the RIGHT side of the diff.
 */
function addedLines(patch) {
  const rows = []
  let oldLine = 0
  let newLine = 0
  for (const line of String(patch || '').split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (hunk) {
      oldLine = Number(hunk[1])
      newLine = Number(hunk[2])
      continue
    }
    if (line.startsWith('+')) {
      rows.push(newLine)
      newLine += 1
    } else if (line.startsWith('-')) {
      oldLine += 1
    } else if (line.startsWith(' ') || line === '') {
      oldLine += 1
      newLine += 1
    }
  }
  return rows
}

function pickLine(fileName, fraction) {
  const file = files.find((entry) => entry.path.endsWith(fileName))
  const lines = file ? addedLines(file.patch) : []
  if (lines.length === 0) return 1
  return lines[Math.min(lines.length - 1, Math.max(0, Math.floor(lines.length * fraction)))]
}

/**
 * Text of the added (RIGHT-side) line at `line`, used for Finding.evidence.
 * Mirrors what the Host prompt asks the model to quote back.
 */
function addedLineText(fileName, line) {
  const file = files.find((entry) => entry.path.endsWith(fileName))
  if (!file) return ''
  let newLine = 0
  for (const raw of String(file.patch || '').split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw)
    if (hunk) {
      newLine = Number(hunk[2])
      continue
    }
    if (raw.startsWith('+')) {
      if (newLine === Number(line)) return raw.slice(1).trim().slice(0, 180)
      newLine += 1
    } else if (raw.startsWith(' ')) {
      newLine += 1
    }
  }
  return ''
}

/** The resolved options the Host echoes for each depth preset (CONTRACT §4.1). */
const DEPTH_PRESETS = {
  fast: { depth: 'fast', chunkChars: 16000, maxChunks: 6, concurrency: 4 },
  standard: { depth: 'standard', chunkChars: 9000, maxChunks: 9, concurrency: 3 },
  deep: { depth: 'deep', chunkChars: 6000, maxChunks: 20, concurrency: 2 },
}

function resolvedOptions(depth, severityThreshold = 'P2', includeGuidelines = true) {
  return {
    ...DEPTH_PRESETS[depth],
    severityThreshold,
    includeGuidelines,
  }
}

const findingSpecs = [
  {
    severity: 'P1',
    file: 'src/main/intro-detect/match.ts',
    lineFraction: 0.46,
    title: '倒排索引候选为空时会退化成全量扫描，长季会卡住主进程',
    why: '当改动让两集没有任何 32 位指纹完全相同的点时，`findCandidates` 返回空数组，`matchEpisodes` 随即进入分批全量扫描；一季 12 集 × 每集 5 分钟指纹 = 每批约 24 亿次汉明比较，批间只让出一次事件循环，播放器主线程会长时间不可用。',
    fix: '给全量扫描加一个「最大比较次数」预算（例如 2e8），超出就直接返回 `null` 并把结果标为 `no-match`；或在扫描前用 `POINT_SECONDS` 做一次粗粒度抽样筛候选。',
    category: 'performance',
    confidence: 'high',
  },
  {
    severity: 'P1',
    file: 'src/main/intro-detect/queue.ts',
    lineFraction: 0.3,
    title: '取消后队列没有出队，同一季会永久卡在「检测中」',
    why: '`cancel()` 只 abort 当前 ffmpeg 并清空 `current`，但没有把该季从 `pending` 里移除，也没重置 `running`；下一次队列 tick 看到 `running === false` 但 `pending` 里仍有同一季，会静默跳过，UI 永远拿不到「已取消」的终态。',
    fix: '在 `cancel()` 里同时 `pending.delete(key)`、`running = false`，并给等待中的 Promise 一个 `{ cancelled: true }` 的 resolve/reject，让调用方一定能收到终态。',
    category: 'concurrency',
    confidence: 'medium',
  },
  {
    severity: 'P2',
    file: 'src/main/intro-detect/match.ts',
    // Same line as the first P1: exercises the "N findings on one line" marker,
    // which folds into a single 「N 条」 gutter badge in the diff.
    lineFraction: 0.46,
    title: '找到候选后没有尽早结束扫描，后续批次仍在空转',
    why: '`compareClips` 在 `if (quick) return quick` 之后仍会继续 for 循环直到 `SHIFT_BATCH` 耗尽；命中快速的场景下每批会多跑约 300 次无关的 `bestMatch` 比较，量级不大但完全可避免。',
    fix: '在 `if (quick) return quick` 分支后直接 `break` 跳出分批循环，或把 `quick` 判定提前到每批开始处。',
    category: 'performance',
    confidence: 'low',
  },
  {
    severity: 'P2',
    file: 'src/main/intro-detect/vote.ts',
    lineFraction: 0.62,
    title: '票数刚好一半时按「≥ max(2, 一半)」放行，2 集季会误判片头',
    why: '2 集时 `Math.max(2, Math.ceil(2 / 2))` = 2，要求 2 个不同集支持，而一次两两比对只产生 2 集的候选，起止误差正好落在 5 秒边界时可能只算 1 个支持，于是整季被判为「没有统一片头」，手动标记被覆盖成空。',
    fix: '票数门槛改为 `Math.max(2, Math.ceil(total / 2))` 并显式处理 `total === 2`：要么要求 1 个支持（2 集时任意一对都算全票），要么在文档里明确 2 集季不支持自动检测。',
    category: 'correctness',
    confidence: 'medium',
  },
  {
    severity: 'P2',
    file: 'src/renderer/src/features/player/skip/detect-merge.ts',
    lineFraction: 0.35,
    title: '手动标记只比较 `start/end`，片尾长度变化时会被自动结果覆盖',
    why: '`isManual` 依据仅来自 `introSource` 字段，老记录没有该字段时按手动算；但迁移代码写回时只补 `introSource = manual` 而没有保留原有 `end`，第二次检测会把手动标好的片尾区间整体替换掉。',
    fix: '迁移时对已有标记同时写 `introSource: "manual"` 并保留原有区间字段；合并时用 `Object.assign({}, auto, manual)` 让手动字段整体优先，而不是逐字段覆盖。',
    category: 'data',
    confidence: 'low',
  },
  {
    severity: 'P2',
    file: 'src/main/intro-detect/ffmpeg.ts',
    lineFraction: 0.72,
    title: 'ffmpeg 输出到 stderr 进度信息时未限长，stdout 二进制可能撑爆 maxBuffer',
    why: '`runBinary` 只对 stdout 收集 chunks，但 `-progress` 未关闭，stderr 上每 0.1 秒一行；30 分钟分析会产生约 18000 行日志，Node 默认 `maxBuffer`（1 MiB）被撑满后进程被 SIGTERM 杀掉，表现为「检测随机失败」。',
    fix: 'spawn 时显式 `maxBuffer` 并给 stdout 设上限（例如 32 MiB）；关闭 `-progress`/`-nostats`，或按行消费 stderr 只保留最后 20 行。',
    category: 'correctness',
    confidence: 'high',
  },
  {
    severity: 'P2',
    file: 'tests/intro-detect.test.ts',
    lineFraction: 0.5,
    title: '新增的单测只覆盖纯函数，队列取消与子进程清理没有回归保护',
    why: '`queue.ts`、`ffmpeg.ts` 的取消路径（abort 后清理 map、子进程 kill）没有任何断言；上面两个 P1 都属于这条路径，后续重构会再次漏测。',
    fix: '为队列补两个用例：取消后再入队能重新开始、子进程 signal 后被等待结束；用 fake ffmpeg 脚本（node -e "process.exit(0)"）替代真实二进制。',
    category: 'test',
  },
]

function slugId(seed) {
  let hash = 0
  const text = String(seed)
  for (let i = 0; i < text.length; i += 1) {
    hash = (Math.imul(hash, 31) + text.charCodeAt(i)) | 0
  }
  return Math.abs(hash).toString(36).slice(0, 8)
}

const findings = findingSpecs.map((spec) => {
  const line = pickLine(spec.file, spec.lineFraction)
  const evidence = addedLineText(spec.file, line)
  const base = {
    id: '',
    severity: spec.severity,
    file: spec.file,
    line,
    title: spec.title,
    why: spec.why,
    fix: spec.fix,
    category: spec.category,
    // v1.1 extras: diff line that supports the finding + model self-rated confidence.
    evidence: evidence ? '+' + evidence : '',
  }
  if (spec.confidence) base.confidence = spec.confidence
  base.id = `${spec.file}:${line}:${slugId(spec.title)}`
  return base
})

const severityCount = (severity) => findings.filter((finding) => finding.severity === severity).length
const overviewParts = ['P0', 'P1', 'P2']
  .map((severity) => ({ severity, count: severityCount(severity) }))
  .filter((entry) => entry.count > 0)
  .map((entry) => `${entry.count} 个 ${entry.severity}`)

const reviewBase = {
  jobId: 'mock-job-1',
  headSha,
  model: { provider: 'deepseek', model: 'deepseek-v4-pro' },
  findings,
  overview: overviewParts.join(' · '),
  partial: false,
  // v1.1: resolved options echoed by review-start/review-status, AGENTS.md
  // report, file-level cache reuse and the derived verdict.
  options: resolvedOptions('standard'),
  guidelines: { loaded: true, files: ['AGENTS.md'], chars: 3240 },
  reusedFiles: 5,
  verdict: 'changes',
}

const reviewDone = {
  ...reviewBase,
  state: 'done',
  progress: {
    phase: 'done',
    filesDone: files.length,
    filesTotal: files.length,
    startedAt: Date.now() - 38_000,
    elapsedMs: 38_000,
  },
}

const reviewEmpty = {
  ...reviewBase,
  overview: '未发现 P0/P1 问题',
  findings: [],
  verdict: 'approve',
  reusedFiles: 3,
  state: 'done',
  progress: {
    phase: 'done',
    filesDone: files.length,
    filesTotal: files.length,
    startedAt: Date.now() - 21_000,
    elapsedMs: 21_000,
  },
}

const reviewRunning = {
  ...reviewBase,
  state: 'running',
  findings: [],
  verdict: undefined,
  reusedFiles: 0,
  progress: {
    phase: 'reviewing',
    filesDone: 12,
    filesTotal: files.length,
    startedAt: Date.now() - 6_200,
    elapsedMs: 6_200,
  },
}

const reviewError = {
  ...reviewBase,
  state: 'error',
  findings: [],
  verdict: undefined,
  reusedFiles: 0,
  // Degraded case: no AGENTS.md in the repo, and the model was unavailable.
  guidelines: { loaded: false, files: [], chars: 0 },
  progress: {
    phase: 'reviewing',
    filesDone: 3,
    filesTotal: files.length,
    startedAt: Date.now() - 9_400,
    elapsedMs: 9_400,
  },
  error: {
    code: 'LLM_UNAVAILABLE',
    message: '宿主没有可用的模型：请先配置默认模型后重试。',
  },
}

const reviewPartial = {
  ...reviewBase,
  state: 'done',
  partial: true,
  partialReasons: ['src/main/intro-detect/queue.ts：模型输出不是合法 JSON，已跳过该分块'],
  truncatedCalls: 1,
  // A deep run: shows the extra verification pass + its slower budget.
  options: resolvedOptions('deep', 'P1'),
  verdict: 'changes',
  reusedFiles: 2,
  progress: {
    phase: 'done',
    filesDone: files.length - 1,
    filesTotal: files.length,
    startedAt: Date.now() - 239_000,
    elapsedMs: 239_000,
  },
}

const stackTitle117 = probe.stack?.basePr?.title ?? 'feat(player): 跳过片头片尾（手动标记）'
const stack = {
  baseRefName: pr129.baseRefName,
  declaredBase: probe.stack?.declaredBaseFromBody ?? pr129.baseRefName,
  basePr: {
    number: 117,
    title: stackTitle117,
    state: probe.stack?.basePr?.state ?? 'open',
  },
  chain: [
    { number: 117, title: stackTitle117, state: 'open' },
    { number: 129, title: pr129.title, state: 'open' },
  ],
  allBaseMerged: Boolean(probe.stack?.allBaseMerged),
}

const pr129Detail = {
  summary: {
    ...pr129,
    additions: probe.pr?.data?.additions ?? pr129.additions,
    deletions: probe.pr?.data?.deletions ?? pr129.deletions,
    changedFiles: files.length,
  },
  body: probe.pr?.body ?? '',
  // v2: the Host exposes the head SHA on the detail payload; the merge dialog
  // shows its first 7 chars and sends the full value as expectedHeadSha.
  headSha,
  bodyTruncated: Boolean(probe.pr?.bodyTruncation?.truncated),
  files,
  filesTruncated: false,
  comments: {
    total: 0,
    issue: [],
    reviews: [],
    inline: [],
  },
  checks: { state: 'none', items: [] },
  stack,
  review: { state: 'none', headSha, findings: [], overview: '' },
}

/** A second detail used when the list demo selects any other PR. */
const otherSummary = items.find((item) => item.number !== 129) ?? pr129
const genericDetail = JSON.parse(JSON.stringify(pr129Detail))
genericDetail.summary = { ...otherSummary, additions: otherSummary.additions, deletions: otherSummary.deletions, changedFiles: files.length }
genericDetail.body = `${probe.pr?.body ?? ''}\n\n> 预览：这是从 PR #129 复用的 diff，仅用于点击列表其它条目时的占位。`
genericDetail.comments = {
  total: 3,
  issue: [
    {
      author: 'Acefake',
      body: '截图里的第一版检测结果：片头 00:12–01:38，片尾 41:02–42:30。冷开场那几集没统一，先手动标。',
      createdAt: '2026-10-24T03:12:00Z',
    },
    {
      author: 'chatgpt-codex-connector[bot]',
      body: '已在 #117 上留下 3 条行内建议，其中 1 条属于 P1：队列取消后没有出队。',
      createdAt: '2026-10-24T04:02:00Z',
    },
  ],
  reviews: [
    { author: 'chatgpt-codex-connector[bot]', state: 'COMMENTED', body: '3 条行内建议（1 个 P1）' },
  ],
  inline: [
    {
      path: 'src/main/intro-detect/queue.ts',
      line: 64,
      body: '取消后这里还需要 `pending.delete(key)`，否则同一季会卡在检测中。',
      author: 'chatgpt-codex-connector[bot]',
      createdAt: '2026-10-24T04:01:00Z',
    },
  ],
}
genericDetail.stack = { ...stack, chain: [{ number: otherSummary.number, title: otherSummary.title, state: 'open' }], basePr: undefined }

const checkItems = [
  { name: 'build (windows)', state: 'success', url: 'https://github.com/Acefake/yingbox/actions' },
  { name: 'typecheck', state: 'success' },
  { name: 'vitest / unit', state: 'failure' },
]
const checksDetail = JSON.parse(JSON.stringify(pr129Detail))
checksDetail.checks = { state: 'failure', items: checkItems }

const closedItems = items.slice(0, 4).map((item) => ({ ...item, state: 'closed' }))

/**
 * PR #129 with existing GitHub review comments, used by the v1.1
 * `v11-existing-comments` preview scene. Bodies include one >400-char comment so
 * the client's preview truncation is visible.
 */
const longCommentBody = [
  '这一段的注释和实现不一致：注释说「每批让出事件循环」，但 `SHIFT_BATCH` 循环里没有 `await`，',
  '实际上只有在每批结束才 `setImmediate`。建议把 `setImmediate` 提前到 for 循环体内部，',
  '或者把 `SHIFT_BATCH` 调小到 64 以内，避免单批耗时超过 16ms。',
  '另外 `candidateShifts` 数组在每批都会重新分配，可以提到循环外复用，减少 GC 压力。',
  '（这条评论故意写长，用来验证行内评论卡最多显示 400 字并在超出时标注「已截断」。）',
].join('')

const pr129CommentsDetail = JSON.parse(JSON.stringify(pr129Detail))
pr129CommentsDetail.comments = {
  total: 6,
  issue: [
    {
      author: 'Acefake',
      body: '截图里的第一版检测结果：片头 00:12–01:38，片尾 41:02–42:30。冷开场那几集没统一，先手动标。',
      createdAt: '2026-10-24T03:12:00Z',
    },
    {
      author: 'chatgpt-codex-connector[bot]',
      body: '已在 #117 上留下 3 条行内建议，其中 1 条属于 P1：队列取消后没有出队。',
      createdAt: '2026-10-24T04:02:00Z',
    },
  ],
  reviews: [
    { author: 'chatgpt-codex-connector[bot]', state: 'COMMENTED', body: '3 条行内建议（1 个 P1）' },
  ],
  inline: [
    {
      path: 'src/main/intro-detect/queue.ts',
      line: pickLine('src/main/intro-detect/queue.ts', 0.42),
      body: longCommentBody,
      author: 'chatgpt-codex-connector[bot]',
      createdAt: '2026-10-24T04:01:00Z',
    },
    {
      path: 'src/main/intro-detect/vote.ts',
      line: pickLine('src/main/intro-detect/vote.ts', 0.55),
      body: '这里的票数门槛建议改成 `Math.max(2, Math.ceil(total / 2))`，并在 `total === 2` 时给出明确行为。',
      author: 'Acefake',
      createdAt: '2026-10-24T03:40:00Z',
    },
    {
      path: 'src/main/intro-detect/detector.ts',
      line: pickLine('src/main/intro-detect/detector.ts', 0.3),
      body: '`yieldNow` 的导入顺序没问题，但注意不要再引入同步阻塞调用。',
      author: 'chatgpt-codex-connector[bot]',
      createdAt: '2026-10-23T22:12:00Z',
    },
    {
      path: 'src/main/intro-detect/queue.ts',
      line: null,
      body: '文件级评论示例：整份队列实现建议补一组取消路径的回归测试。',
      author: 'reviewer-bot',
      createdAt: '2026-10-23T22:20:00Z',
    },
  ],
}

const write = (name, value) => {
  fs.writeFileSync(path.join(outDir, name), `${JSON.stringify(value, null, 2)}\n`)
  console.log('wrote', path.relative(root, path.join(outDir, name)))
}

write('health.json', { gh: 'ok', llm: 'ok', version: '0.1.0' })
write('prs.json', { query: 'is:open author:@me', totalCount: items.length, items })
write('prs-closed.json', { query: 'is:closed author:@me', totalCount: closedItems.length, items: closedItems })
write('pr-129.json', pr129Detail)
write('pr-129-comments.json', pr129CommentsDetail)
write('pr-generic.json', genericDetail)
write('checks-demo.json', checksDetail)
write('review-done.json', reviewDone)
write('review-empty.json', reviewEmpty)
write('review-running.json', reviewRunning)
write('review-error.json', reviewError)
write('review-partial.json', reviewPartial)
console.log(`\n${items.length} PRs, ${files.length} files, ${findings.length} findings (head ${headSha.slice(0, 8)})`)
