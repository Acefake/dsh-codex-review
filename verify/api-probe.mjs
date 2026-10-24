#!/usr/bin/env node
/**
 * Contract probe for the dsh-codex-review Host routes.
 *
 *   node verify/api-probe.mjs                       # 全量（含一次真实 AI 审查）
 *   node verify/api-probe.mjs --skip-ai             # 只读路由
 *   node verify/api-probe.mjs --report verify/final/api-probe.json
 *
 * Posts to every route from `plugin/CONTRACT.md` §1.1 over the authenticated
 * same-origin channel and validates the `{ok:true,value}|{ok:false,error}`
 * envelope plus the data shapes of §1.2:
 *
 *   health        gh/llm/version enums
 *   prs           >= 20 items, PrSummary field shapes
 *   pr            Acefake/yingbox#129 → 24 files, body, stack chain contains #117
 *   review-start  jobId/headSha/cached, then review-status polled to a terminal
 *                 state with a valid ReviewStatus and Finding[] schema
 *   review-cancel boolean result / legal error envelope
 *
 * When the plugin is not installed yet the routes answer HTTP 404/405 instead of
 * JSON; the probe then prints 「路由未就绪」 and exits 3 without crashing.
 *
 * Exit codes: 0 all assertions pass, 1 assertion failed, 2 environment/auth
 * error, 3 plugin routes not ready.
 */
import { parseArgs } from 'node:util'
import path from 'node:path'
import { GuiClient } from './lib/gui.mjs'
import { EXIT, fail, isoTimestamp, OUT_ROOT, timestampForFile, writeJson } from './lib/util.mjs'

const TERMINAL_STATES = new Set(['done', 'error', 'cancelled'])
const REVIEW_STATES = new Set(['queued', 'running', 'done', 'error', 'cancelled'])
const DETAIL_REVIEW_STATES = new Set(['none', 'running', 'done', 'error'])
const PHASES = new Set(['preparing', 'reviewing', 'merging', 'done'])
const SEVERITIES = new Set(['P0', 'P1', 'P2'])
const CATEGORIES = new Set(['correctness', 'security', 'data', 'concurrency', 'performance', 'api', 'test'])
const FILE_STATUSES = new Set(['added', 'modified', 'removed', 'renamed', 'copied', 'changed', 'unchanged'])
const PR_STATES = new Set(['open', 'closed'])
const GH_STATES = new Set(['ok', 'not-logged-in', 'missing'])
const LLM_STATES = new Set(['ok', 'unavailable'])

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0
const isIsoDate = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value))
const isPositiveInt = (value) => Number.isInteger(value) && value > 0

const USAGE = `用法: node verify/api-probe.mjs [选项]

选项:
  --base-url <url>          DSH Web GUI 根地址（默认 http://127.0.0.1:2632）
  --token <token>           DSH 启动 URL 里的 token（不传则用本机凭据自动认证）
  --prs-limit <n>           prs 请求的 limit（默认 30）
  --min-prs <n>             prs 至少返回条数（默认 20）
  --pr <owner/name#num>     详情断言目标（默认 Acefake/yingbox#129）
  --expect-files <n>        详情文件数断言（默认 24）
  --stack-ref <num>         stack 链路应包含的 PR 编号（默认 117）
  --skip-ai                 跳过 review-start/review-status/review-cancel
  --review-timeout-ms <ms>  轮询审查终态上限（默认 240000）
  --poll-ms <ms>            轮询间隔（默认 800）
  --skip-security           跳过信任围栏（Origin / x-forwarded-for / content-type）探测
  --out-dir <dir>           报告目录（默认 verify/out）
  --report <json>           报告路径（默认 <out-dir>/api-probe-<时间>.json）
  --json                    只输出 JSON 摘要
  -h, --help                显示本帮助`

function parseCli() {
  let parsed
  try {
    parsed = parseArgs({
      allowPositionals: false,
      options: {
        'base-url': { type: 'string', default: process.env.DSH_WEB_URL ?? 'http://127.0.0.1:2632' },
        token: { type: 'string' },
        'prs-limit': { type: 'string', default: '30' },
        'min-prs': { type: 'string', default: '20' },
        pr: { type: 'string', default: 'Acefake/yingbox#129' },
        'expect-files': { type: 'string', default: '24' },
        'stack-ref': { type: 'string', default: '117' },
        'skip-ai': { type: 'boolean', default: false },
        'review-timeout-ms': { type: 'string', default: '240000' },
        'poll-ms': { type: 'string', default: '800' },
        'skip-security': { type: 'boolean', default: false },
        'out-dir': { type: 'string', default: OUT_ROOT },
        report: { type: 'string' },
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    })
  } catch (error) {
    fail(`参数解析失败：${error.message}\n\n${USAGE}`, EXIT.ENV)
  }
  const { values } = parsed
  if (values.help) {
    console.log(USAGE)
    process.exit(EXIT.OK)
  }
  const numeric = (name, fallback, { min = 0 } = {}) => {
    const raw = values[name] ?? String(fallback)
    const value = Number(raw)
    if (!Number.isFinite(value) || value < min) fail(`--${name} 必须是不小于 ${min} 的数字，收到 ${JSON.stringify(raw)}`, EXIT.ENV)
    return Math.round(value)
  }
  const prMatch = String(values.pr).match(/^([^/\s#]+)\/([^/\s#]+)#(\d+)$/u)
  if (!prMatch) fail(`--pr 格式应为 owner/name#number，收到 ${JSON.stringify(values.pr)}`, EXIT.ENV)
  const outDir = path.resolve(values['out-dir'])
  return {
    baseUrl: values['base-url'],
    token: values.token,
    prsLimit: numeric('prs-limit', 30, { min: 1 }),
    minPrs: numeric('min-prs', 20, { min: 0 }),
    pr: { repo: `${prMatch[1]}/${prMatch[2]}`, number: Number(prMatch[3]) },
    expectFiles: numeric('expect-files', 24, { min: 0 }),
    stackRef: numeric('stack-ref', 117, { min: 1 }),
    skipAi: values['skip-ai'],
    reviewTimeoutMs: numeric('review-timeout-ms', 240_000, { min: 1000 }),
    pollMs: numeric('poll-ms', 800, { min: 100 }),
    skipSecurity: values['skip-security'],
    reportPath: path.resolve(outDir, values.report ?? `api-probe-${timestampForFile()}.json`),
    jsonOnly: values.json,
  }
}

const options = parseCli()
const report = {
  harness: 'verify/api-probe.mjs',
  generatedAt: isoTimestamp(),
  baseUrl: options.baseUrl,
  pr: options.pr,
  routesReady: null,
  auth: null,
  checks: [],
  routes: {},
}
const checks = report.checks

/**
 * Record one assertion.
 * @param {string} name
 * @param {boolean} pass
 * @param {string} [detail]
 */
function check(name, pass, detail = '') {
  checks.push({ name, pass: Boolean(pass), detail })
}

/**
 * Parse the plugin envelope. Never throws.
 * @param {{json: unknown, status: number, text: string, parseError?: string}} response
 * @returns {{envelope: boolean, ok: boolean, value: any, error: any, note: string}}
 */
function parseEnvelope(response) {
  if (response.parseError) return { envelope: false, ok: false, value: undefined, error: undefined, note: response.parseError }
  const json = response.json
  if (!isObject(json) || typeof json.ok !== 'boolean') return { envelope: false, ok: false, value: undefined, error: undefined, note: '响应不是 {ok:...} 信封' }
  if (json.ok === true) {
    if (!('value' in json)) return { envelope: false, ok: false, value: undefined, error: undefined, note: 'ok:true 但缺少 value' }
    return { envelope: true, ok: true, value: json.value, error: undefined, note: '' }
  }
  if (!isObject(json.error) || !isNonEmptyString(json.error.code) || typeof json.error.message !== 'string') {
    return { envelope: false, ok: false, value: undefined, error: undefined, note: 'ok:false 但 error 缺少 code/message' }
  }
  return { envelope: true, ok: false, value: undefined, error: json.error, note: '' }
}

/**
 * @param {string} routeLabel
 * @param {Awaited<ReturnType<GuiClient['post']>>} response
 * @returns {{envelope: boolean, ok: boolean, value: any, error: any}}
 */
function settleEnvelope(routeLabel, response) {
  const parsed = parseEnvelope(response)
  check(`${routeLabel}: HTTP 200`, response.status === 200, `HTTP ${response.status}，${response.elapsedMs}ms`)
  check(`${routeLabel}: 信封形状合法`, parsed.envelope, parsed.note || (parsed.ok ? 'ok:true' : `ok:false/${parsed.error?.code}`))
  report.routeHeaders = report.routeHeaders ?? {}
  report.routeHeaders[routeLabel] = { status: response.status, elapsedMs: response.elapsedMs, contentType: response.contentType, cacheControl: response.cacheControl }
  return parsed
}

function validatePrSummary(item) {
  if (!isObject(item)) return ['条目不是对象']
  const problems = []
  if (typeof item.repo !== 'string' || !/^[^/\s]+\/[^/\s]+$/u.test(item.repo)) problems.push('repo 不是 owner/name')
  if (!isPositiveInt(item.number)) problems.push('number 不是正整数')
  if (!isNonEmptyString(item.title)) problems.push('title 为空')
  if (!isNonEmptyString(item.author)) problems.push('author 为空')
  if (typeof item.isDraft !== 'boolean') problems.push('isDraft 不是布尔')
  if (!PR_STATES.has(item.state)) problems.push(`state 非法（${JSON.stringify(item.state)}）`)
  if (!isIsoDate(item.createdAt)) problems.push('createdAt 不是 ISO 日期')
  if (!isIsoDate(item.updatedAt)) problems.push('updatedAt 不是 ISO 日期')
  // The list channel is the GitHub search API, which does not carry ref names;
  // CONTRACT §1.4 normalizes them to '' — require the field to exist as a
  // string, and report empty values as a warning rather than a failure.
  if (typeof item.headRefName !== 'string') problems.push('headRefName 不是字符串')
  if (typeof item.baseRefName !== 'string') problems.push('baseRefName 不是字符串')
  if (!isNonEmptyString(item.url)) problems.push('url 为空')
  return problems
}

function validateFilePatch(file) {
  if (!isObject(file)) return ['文件条目不是对象']
  const problems = []
  if (!isNonEmptyString(file.path)) problems.push('path 为空')
  if (!FILE_STATUSES.has(file.status)) problems.push(`status 非法（${JSON.stringify(file.status)}）`)
  if (typeof file.additions !== 'number' || file.additions < 0) problems.push('additions 非法')
  if (typeof file.deletions !== 'number' || file.deletions < 0) problems.push('deletions 非法')
  if (typeof file.patch !== 'string') problems.push('patch 不是字符串')
  if (typeof file.patchTruncated !== 'boolean') problems.push('patchTruncated 不是布尔')
  return problems
}

function validateFinding(finding) {
  if (!isObject(finding)) return ['finding 不是对象']
  const problems = []
  if (!isNonEmptyString(finding.id)) problems.push('id 为空')
  if (!SEVERITIES.has(finding.severity)) problems.push(`severity 非法（${JSON.stringify(finding.severity)}）`)
  if (!isNonEmptyString(finding.file)) problems.push('file 为空')
  if (!isPositiveInt(finding.line)) problems.push('line 不是正整数')
  if (finding.lineEnd !== undefined && !isPositiveInt(finding.lineEnd)) problems.push('lineEnd 非法')
  if (!isNonEmptyString(finding.title)) problems.push('title 为空')
  if (!isNonEmptyString(finding.why)) problems.push('why 为空')
  if (!isNonEmptyString(finding.fix)) problems.push('fix 为空')
  if (finding.category !== undefined && !CATEGORIES.has(finding.category)) problems.push(`category 非法（${JSON.stringify(finding.category)}）`)
  return problems
}

function validateStatusShape(status) {
  const problems = []
  if (!isNonEmptyString(status.jobId)) problems.push('jobId 为空')
  if (!REVIEW_STATES.has(status.state)) problems.push(`state 非法（${JSON.stringify(status.state)}）`)
  if (!isObject(status.progress)) problems.push('progress 不是对象')
  else {
    const progress = status.progress
    if (!PHASES.has(progress.phase)) problems.push(`progress.phase 非法（${JSON.stringify(progress.phase)}）`)
    if (typeof progress.filesDone !== 'number' || progress.filesDone < 0) problems.push('progress.filesDone 非法')
    if (typeof progress.filesTotal !== 'number' || progress.filesTotal < 0) problems.push('progress.filesTotal 非法')
    if (typeof progress.startedAt !== 'number') problems.push('progress.startedAt 非法')
    if (typeof progress.elapsedMs !== 'number' || progress.elapsedMs < 0) problems.push('progress.elapsedMs 非法')
  }
  if (!isNonEmptyString(status.headSha)) problems.push('headSha 为空')
  if (!Array.isArray(status.findings)) problems.push('findings 不是数组')
  if (status.overview !== undefined && typeof status.overview !== 'string') problems.push('overview 不是字符串')
  if (status.partial !== undefined && typeof status.partial !== 'boolean') problems.push('partial 不是布尔')
  return problems
}

function stackReferences(stack, number) {
  if (!isObject(stack)) return { found: false, chainNumbers: [], reason: 'stack 不是对象' }
  const chain = Array.isArray(stack.chain) ? stack.chain : []
  const chainNumbers = chain.map((entry) => entry?.number).filter((value) => typeof value === 'number')
  const found = chainNumbers.includes(number) || stack.basePr?.number === number
  return { found, chainNumbers, basePr: stack.basePr?.number, declaredBase: stack.declaredBase }
}

let client
try {
  client = new GuiClient(options.baseUrl, { token: options.token })
  const auth = await client.authenticate()
  report.auth = auth.source
} catch (error) {
  console.error(`✗ 认证失败：${error.message}`)
  report.auth = 'failed'
  report.error = { message: error.message }
  writeJson(options.reportPath, report)
  process.exitCode = EXIT.ENV
  process.exit()
}

/** @type {Awaited<ReturnType<GuiClient['post']>>} */
let health
try {
  health = await client.post('codex-review/health', {}, { timeoutMs: 20_000 })
} catch (error) {
  console.error(`✗ 无法连接插件路由：${error.message}`)
  report.routesReady = false
  report.error = { message: error.message }
  writeJson(options.reportPath, report)
  process.exit(EXIT.ENV)
}

// Route readiness: the prefix handler answers JSON once installed; before that
// the static/SPA handler answers 404 (GET) or 405 (POST) with an empty body.
if (health.status === 401) {
  console.error('✗ 路由返回 401：浏览器会话 cookie 无效或已过期。')
  console.error('  请用 --token <启动 URL 中的 token> 重跑，或确认 DSH_HOME/.credentials.yaml 可读。')
  report.routesReady = false
  report.authError = true
  writeJson(options.reportPath, report)
  process.exit(EXIT.ENV)
}
if (health.status === 404 || health.status === 405) {
  console.error(`✗ 路由未就绪：POST /codex-review/health 返回 HTTP ${health.status}（${health.contentType || '空 content-type'}，${health.elapsedMs}ms）。`)
  console.error('  说明 dsh-codex-review 插件尚未安装/加载：/codex-review 前缀路由不存在。')
  console.error('  安装插件并重启宿主（或使其 HMR 生效）后，重新运行本脚本即可。')
  report.routesReady = false
  report.healthResponse = { status: health.status, contentType: health.contentType, text: health.text.slice(0, 200), elapsedMs: health.elapsedMs }
  writeJson(options.reportPath, report)
  process.exit(EXIT.ROUTES_NOT_READY)
}
if (health.status !== 200) {
  console.error(`✗ 路由异常：POST /codex-review/health 返回 HTTP ${health.status}：${health.text.slice(0, 300)}`)
  report.routesReady = false
  report.healthResponse = { status: health.status, text: health.text.slice(0, 300) }
  writeJson(options.reportPath, report)
  process.exit(EXIT.ENV)
}
report.routesReady = true

// ---------------------------------------------------------------------------
// health
// ---------------------------------------------------------------------------
const healthEnvelope = settleEnvelope('health', health)
if (healthEnvelope.ok) {
  const value = healthEnvelope.value
  check('health: value 是对象', isObject(value), typeof value)
  if (isObject(value)) {
    check('health: gh 枚举合法', GH_STATES.has(value.gh), JSON.stringify(value.gh))
    check('health: llm 枚举合法', LLM_STATES.has(value.llm), JSON.stringify(value.llm))
    check('health: version 是非空字符串', isNonEmptyString(value.version), JSON.stringify(value.version))
    report.routes.health = { value }
  }
}

// ---------------------------------------------------------------------------
// prs
// ---------------------------------------------------------------------------
const prsResponse = await client.post('codex-review/prs', { query: 'is:open author:@me', limit: options.prsLimit }, { timeoutMs: 20_000 })
const prsEnvelope = settleEnvelope('prs', prsResponse)
if (prsEnvelope.ok) {
  const value = prsEnvelope.value
  check('prs: value 是对象', isObject(value))
  if (isObject(value)) {
    check('prs: items 是数组', Array.isArray(value.items))
    const items = Array.isArray(value.items) ? value.items : []
    check(`prs: 返回至少 ${options.minPrs} 条`, items.length >= options.minPrs, `实际 ${items.length} 条`)
    check('prs: totalCount 是数字', typeof value.totalCount === 'number', JSON.stringify(value.totalCount))
    check('prs: query 是字符串', typeof value.query === 'string', JSON.stringify(value.query))
    const problems = []
    items.forEach((item, index) => {
      for (const problem of validatePrSummary(item)) problems.push(`#${index}: ${problem}`)
    })
    check('prs: 条目字段形状合法', problems.length === 0, problems.slice(0, 6).join('；'))
    report.routes.prs = {
      count: items.length,
      totalCount: value.totalCount,
      query: value.query,
      sample: items.slice(0, 3).map((item) => ({
        repo: item.repo,
        number: item.number,
        title: item.title,
        author: item.author,
        updatedAt: item.updatedAt,
        state: item.state,
      })),
      fieldProblems: problems.slice(0, 20),
    }
  }
}

// ---------------------------------------------------------------------------
// pr detail
// ---------------------------------------------------------------------------
const prResponse = await client.post('codex-review/pr', { repo: options.pr.repo, number: options.pr.number }, { timeoutMs: 30_000 })
const prEnvelope = settleEnvelope('pr', prResponse)
if (prEnvelope.ok) {
  const value = prEnvelope.value
  check('pr: value 是对象', isObject(value))
  if (isObject(value)) {
    const summary = value.summary
    check('pr: summary.repo/number 与请求一致', isObject(summary) && summary.repo === options.pr.repo && summary.number === options.pr.number, `repo=${summary?.repo} number=${summary?.number}`)
    check('pr: body 是字符串', typeof value.body === 'string', `长度 ${typeof value.body === 'string' ? value.body.length : 'N/A'}`)
    check('pr: files 是数组', Array.isArray(value.files))
    const files = Array.isArray(value.files) ? value.files : []
    check(`pr: 文件数为 ${options.expectFiles}`, files.length === options.expectFiles, `实际 ${files.length}`)
    const fileProblems = []
    files.forEach((file, index) => {
      for (const problem of validateFilePatch(file)) fileProblems.push(`#${index}: ${problem}`)
    })
    check('pr: files 字段形状合法', fileProblems.length === 0, fileProblems.slice(0, 6).join('；'))
    const stack = value.stack
    const stackInfo = stackReferences(stack, options.stackRef)
    check(`pr: stack 链路包含 #${options.stackRef}`, stackInfo.found, `chain=${JSON.stringify(stackInfo.chainNumbers)} basePr=${stackInfo.basePr ?? '-'} declaredBase=${stackInfo.declaredBase ?? '-'}`)
    check('pr: review 状态对象合法', isObject(value.review) && DETAIL_REVIEW_STATES.has(value.review.state) && Array.isArray(value.review.findings), JSON.stringify(value.review?.state))
    report.routes.pr = {
      files: files.length,
      fileStatuses: [...new Set(files.map((file) => file.status))],
      bodyLength: typeof value.body === 'string' ? value.body.length : null,
      bodyTruncated: value.bodyTruncated,
      filesTruncated: value.filesTruncated,
      stack: { chainNumbers: stackInfo.chainNumbers, basePr: stackInfo.basePr, declaredBase: stackInfo.declaredBase, allBaseMerged: stack?.allBaseMerged },
      comments: value.comments ? { total: value.comments.total, issue: value.comments.issue?.length, reviews: value.comments.reviews?.length, inline: value.comments.inline?.length } : null,
      checks: value.checks ? { state: value.checks.state, items: value.checks.items?.length } : null,
      review: { state: value.review?.state, findings: value.review?.findings?.length ?? null, headSha: value.review?.headSha },
    }
  }
}

// ---------------------------------------------------------------------------
// review flow (one real model call, allowed by the verification brief)
// ---------------------------------------------------------------------------
if (!options.skipAi) {
  const startResponse = await client.post('codex-review/review-start', { repo: options.pr.repo, number: options.pr.number }, { timeoutMs: 30_000 })
  const startEnvelope = settleEnvelope('review-start', startResponse)
  let jobId
  if (!startEnvelope.ok && startEnvelope.envelope) {
    check('review-start: ok:true', false, `${startEnvelope.error.code}：${startEnvelope.error.message}`)
  }
  if (startEnvelope.ok && isObject(startEnvelope.value)) {
    const value = startEnvelope.value
    jobId = value.jobId
    check('review-start: jobId 非空', isNonEmptyString(value.jobId), JSON.stringify(value.jobId))
    check('review-start: headSha 非空', isNonEmptyString(value.headSha), JSON.stringify(value.headSha))
    check('review-start: cached 是布尔', typeof value.cached === 'boolean', JSON.stringify(value.cached))
    report.routes.reviewStart = { jobId: value.jobId, headSha: value.headSha, cached: value.cached }
  }
  if (isNonEmptyString(jobId)) {
    const deadline = Date.now() + options.reviewTimeoutMs
    const pollStartedAt = Date.now()
    const timeline = []
    let lastStatus
    let lastEnvelope
    let polls = 0
    while (Date.now() < deadline) {
      const statusResponse = await client.post('codex-review/review-status', { jobId }, { timeoutMs: 20_000 })
      polls += 1
      const envelope = parseEnvelope(statusResponse)
      if (statusResponse.status !== 200 || !envelope.envelope) {
        check('review-status: 轮询响应合法', false, `HTTP ${statusResponse.status}，${envelope.note || '信封非法'}`)
        lastEnvelope = envelope
        break
      }
      if (!envelope.ok) {
        check('review-status: 轮询返回 ok:true', false, `${envelope.error.code}：${envelope.error.message}`)
        lastEnvelope = envelope
        break
      }
      lastEnvelope = envelope
      lastStatus = envelope.value
      const state = lastStatus?.state
      timeline.push({ t: Date.now() - pollStartedAt, state, filesDone: lastStatus?.progress?.filesDone, filesTotal: lastStatus?.progress?.filesTotal })
      if (timeline.length > 120) timeline.splice(0, timeline.length - 120)
      if (TERMINAL_STATES.has(state)) break
      await delay(options.pollMs)
    }
    const elapsedMs = Date.now() - pollStartedAt
    if (lastEnvelope?.ok && lastStatus) {
      const problems = validateStatusShape(lastStatus)
      check('review-status: ReviewStatus 形状合法', problems.length === 0, problems.slice(0, 6).join('；'))
      check('review-status: jobId 一致', lastStatus.jobId === jobId, `${lastStatus.jobId} vs ${jobId}`)
      check('review-status: 到达终态', TERMINAL_STATES.has(lastStatus.state), `状态 ${lastStatus.state}（等待 ${elapsedMs}ms，轮询 ${polls} 次）`)
      if (lastStatus.state === 'done') {
        const findings = Array.isArray(lastStatus.findings) ? lastStatus.findings : []
        const findingProblems = []
        findings.forEach((finding, index) => {
          for (const problem of validateFinding(finding)) findingProblems.push(`#${index}: ${problem}`)
        })
        check('review-status: findings 字段形状合法', findingProblems.length === 0, findingProblems.slice(0, 8).join('；'))
        report.routes.review = {
          state: lastStatus.state,
          elapsedMs,
          polls,
          progress: lastStatus.progress,
          model: lastStatus.model,
          findingsCount: findings.length,
          findingsSample: findings.slice(0, 5),
          overview: lastStatus.overview,
          partial: lastStatus.partial,
          fieldProblems: findingProblems.slice(0, 20),
          timeline,
        }
      } else {
        check('review-status: 审查成功完成（state=done）', false, `终态 ${lastStatus.state}${lastStatus.error ? `：${lastStatus.error.code} ${lastStatus.error.message}` : ''}`)
        report.routes.review = { state: lastStatus.state, elapsedMs, polls, error: lastStatus.error, timeline }
      }
    } else if (lastEnvelope && !lastEnvelope.ok) {
      check('review-status: 轮询到终态', false, `${lastEnvelope.error.code}：${lastEnvelope.error.message}`)
    } else {
      check('review-status: 在超时前到达终态', false, `超时 ${options.reviewTimeoutMs}ms 未到终态（轮询 ${polls} 次）`)
      report.routes.review = { state: 'timeout', elapsedMs, polls, timeline }
    }

    // review-cancel: legal envelope is the assertion; cancelling a finished job
    // is expected to report cancelled:false.
    const cancelResponse = await client.post('codex-review/review-cancel', { jobId }, { timeoutMs: 20_000 })
    const cancelEnvelope = settleEnvelope('review-cancel', cancelResponse)
    if (cancelEnvelope.envelope) {
      const cancelled = cancelEnvelope.ok ? cancelEnvelope.value?.cancelled : undefined
      check('review-cancel: ok:true 时 cancelled 是布尔', cancelEnvelope.ok ? typeof cancelled === 'boolean' : true, cancelEnvelope.ok ? JSON.stringify(cancelled) : `错误信封 ${cancelEnvelope.error.code}`)
      report.routes.reviewCancel = cancelEnvelope.ok ? { ok: true, cancelled } : { ok: false, error: cancelEnvelope.error }
    }
    const unknownCancel = await client.post('codex-review/review-cancel', { jobId: `verify-unknown-${Date.now()}` }, { timeoutMs: 20_000 })
    const unknownEnvelope = parseEnvelope(unknownCancel)
    check('review-cancel(未知 jobId): 返回合法信封', unknownEnvelope.envelope, unknownEnvelope.note || (unknownEnvelope.ok ? 'ok:true' : `错误信封 ${unknownEnvelope.error.code}`))
    report.routes.reviewCancelUnknown = unknownEnvelope.envelope
      ? (unknownEnvelope.ok ? { ok: true, cancelled: unknownEnvelope.value?.cancelled } : { ok: false, error: unknownEnvelope.error })
      : { malformed: true, status: unknownCancel.status, text: unknownCancel.text.slice(0, 200) }
  }
}

// ---------------------------------------------------------------------------
// trust fence probes (local-only loopback server must reject these)
// ---------------------------------------------------------------------------
if (!options.skipSecurity) {
  const securityCases = [
    { name: 'Origin 跨站被拒绝', headers: { origin: 'http://evil.example' } },
    { name: 'x-forwarded-for 被拒绝', headers: { 'x-forwarded-for': '203.0.113.7' } },
    { name: 'content-type 非 JSON 被拒绝', headers: { 'content-type': 'text/plain' } },
  ]
  for (const testCase of securityCases) {
    const response = await client.post('codex-review/health', { probe: 'security' }, { timeoutMs: 20_000, headers: testCase.headers })
    const rejected = response.status >= 400 || response.json?.ok === false
    check(`信任围栏: ${testCase.name}`, rejected, `HTTP ${response.status}${response.json?.ok === false ? ` error=${response.json.error?.code}` : ''}`)
  }
}

// ---------------------------------------------------------------------------
// verdict + report
// ---------------------------------------------------------------------------
// Envelope/header hygiene across all JSON routes that answered 200.
const jsonHeaderProblems = Object.entries(report.routeHeaders ?? {})
  .filter(([, header]) => header.status === 200)
  .flatMap(([route, header]) => {
    const problems = []
    if (!header.contentType.includes('application/json')) problems.push(`${route}: content-type=${JSON.stringify(header.contentType)}`)
    if (!header.cacheControl.includes('no-store')) problems.push(`${route}: cache-control=${JSON.stringify(header.cacheControl)}`)
    return problems
  })
check('响应头: 200 响应均为 application/json 且 no-store', jsonHeaderProblems.length === 0, jsonHeaderProblems.slice(0, 6).join('；'))

const ok = checks.every((entry) => entry.pass)
report.verdict = { ok, failed: checks.filter((entry) => !entry.pass).map((entry) => entry.name) }
report.finishedAt = isoTimestamp()
writeJson(options.reportPath, report)

const summary = {
  ok,
  baseUrl: options.baseUrl,
  auth: report.auth,
  routesReady: report.routesReady,
  report: options.reportPath,
  totalChecks: checks.length,
  failedChecks: report.verdict.failed,
  prsCount: report.routes.prs?.count ?? null,
  prFiles: report.routes.pr?.files ?? null,
  reviewState: report.routes.review?.state ?? null,
  findings: report.routes.review?.findingsCount ?? null,
}
if (options.jsonOnly) console.log(JSON.stringify(summary))
else {
  console.log(`${ok ? '✓' : '✗'} 插件路由契约检查完成（${checks.length} 项断言，${checks.filter((entry) => entry.pass).length} 通过）`)
  for (const entry of checks) console.log(`${entry.pass ? '  ✓' : '  ✗'} ${entry.name}${entry.detail ? ` — ${entry.detail}` : ''}`)
  console.log(JSON.stringify(summary, null, 2))
}
process.exitCode = ok ? EXIT.OK : EXIT.FAIL
