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
  --review-timeout-ms <ms>  轮询审查终态上限（默认 600000，分块多时按需加大）
  --poll-ms <ms>            轮询间隔（默认 800）
  --skip-security           跳过信任围栏（Origin / x-forwarded-for / content-type）探测
  --v11                     启用 v1.1 断言（结构校验；未生效时新断言记 pending，不误报失败）
  --v11-ai                  启用 v1.1 真实审查探测：默认设置(命中缓存/必要时真跑) + depth=fast 新 job + 同设置二次调用 cached=true
  --v11-threshold           启用 v1.1 severityThreshold='P0' 探测（优先命中已缓存的 fast+P0，不 cancel）
  --v11-newjob              启用 v1.1 未缓存选项组合探测（fast+P1，预期 24/24 复用、秒回、0 模型调用）
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
        'review-timeout-ms': { type: 'string', default: '600000' },
        'poll-ms': { type: 'string', default: '800' },
        'skip-security': { type: 'boolean', default: false },
        v11: { type: 'boolean', default: false },
        'v11-ai': { type: 'boolean', default: false },
        'v11-threshold': { type: 'boolean', default: false },
        'v11-newjob': { type: 'boolean', default: false },
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
    reviewTimeoutMs: numeric('review-timeout-ms', 600_000, { min: 1000 }),
    pollMs: numeric('poll-ms', 800, { min: 100 }),
    skipSecurity: values['skip-security'],
    v11: values.v11,
    v11Ai: values['v11-ai'],
    v11Threshold: values['v11-threshold'],
    v11NewJob: values['v11-newjob'],
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
 * Record a v1.1 assertion that cannot run yet (capability not deployed).
 * Pending checks are reported but never fail the run.
 * @param {string} name
 * @param {string} detail
 */
function checkPending(name, detail) {
  checks.push({ name, pass: null, pending: true, detail })
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

// ---------------------------------------------------------------------------
// v1.1 validators (CONTRACT.md §4.1/§4.2)
// ---------------------------------------------------------------------------
const DEPTH_PRESETS = Object.freeze({
  fast: { chunkChars: 16000, maxChunks: 6, concurrency: 4 },
  standard: { chunkChars: 9000, maxChunks: 9, concurrency: 3 },
  deep: { chunkChars: 6000, maxChunks: 20, concurrency: 2 },
})
const DEPTHS = new Set(['fast', 'standard', 'deep'])
const THRESHOLDS = new Set(['P0', 'P1', 'P2'])
const VERDICTS = new Set(['block', 'changes', 'approve'])

/**
 * Validate `ResolvedReviewOptions` (CONTRACT §4.1).
 * @param {unknown} value
 * @returns {string[]} problems
 */
function validateResolvedOptions(value) {
  if (!isObject(value)) return ['options 不是对象']
  const problems = []
  if (!DEPTHS.has(value.depth)) problems.push(`depth 非法（${JSON.stringify(value.depth)}）`)
  if (!THRESHOLDS.has(value.severityThreshold)) problems.push(`severityThreshold 非法（${JSON.stringify(value.severityThreshold)}）`)
  if (typeof value.includeGuidelines !== 'boolean') problems.push('includeGuidelines 不是布尔')
  if (!isPositiveInt(value.chunkChars)) problems.push('chunkChars 不是正整数')
  if (!isPositiveInt(value.maxChunks)) problems.push('maxChunks 不是正整数')
  if (!isPositiveInt(value.concurrency)) problems.push('concurrency 不是正整数')
  return problems
}

/**
 * Validate the resolved options of one depth against the CONTRACT preset table.
 * @param {Record<string, unknown>} value
 * @returns {string[]}
 */
function validateDepthPreset(value) {
  const problems = validateResolvedOptions(value)
  if (problems.length > 0) return problems
  const preset = DEPTH_PRESETS[value.depth]
  if (value.chunkChars !== preset.chunkChars) problems.push(`chunkChars=${value.chunkChars}（期望 ${preset.chunkChars}）`)
  if (value.maxChunks !== preset.maxChunks) problems.push(`maxChunks=${value.maxChunks}（期望 ${preset.maxChunks}）`)
  if (value.concurrency !== preset.concurrency) problems.push(`concurrency=${value.concurrency}（期望 ${preset.concurrency}）`)
  return problems
}

/**
 * Validate `guidelines` (CONTRACT §4.2/§4.4).
 * @param {unknown} value
 * @returns {string[]}
 */
function validateGuidelines(value) {
  if (!isObject(value)) return ['guidelines 不是对象']
  const problems = []
  if (typeof value.loaded !== 'boolean') problems.push('loaded 不是布尔')
  if (!Array.isArray(value.files)) problems.push('files 不是数组')
  else if (value.files.some((file) => typeof file !== 'string')) problems.push('files 含非字符串')
  if (typeof value.chars !== 'number' || value.chars < 0) problems.push('chars 不是非负数')
  if (typeof value.chars === 'number' && value.chars > 4000) problems.push(`chars=${value.chars} 超过 4000 上限`)
  return problems
}

/**
 * Derive the expected verdict from findings (CONTRACT §4.2).
 * @param {Array<{severity?: string}>} findings
 * @returns {'block'|'changes'|'approve'}
 */
function deriveVerdict(findings) {
  const list = Array.isArray(findings) ? findings : []
  if (list.some((finding) => finding?.severity === 'P0')) return 'block'
  if (list.some((finding) => finding?.severity === 'P1')) return 'changes'
  return 'approve'
}

/**
 * Validate the v1.1 additions on `ReviewStatus` / `PrDetail.review`.
 * @param {Record<string, unknown>} review
 * @param {number} filesTotal
 * @returns {string[]} problems
 */
function validateV11ReviewFields(review, filesTotal) {
  const problems = []
  if (!isObject(review)) return ['review 不是对象']
  if (review.options !== undefined) problems.push(...validateResolvedOptions(review.options).map((problem) => `options.${problem}`))
  if (review.guidelines !== undefined) problems.push(...validateGuidelines(review.guidelines).map((problem) => `guidelines.${problem}`))
  if (review.verdict !== undefined) {
    if (!VERDICTS.has(review.verdict)) problems.push(`verdict 非法（${JSON.stringify(review.verdict)}）`)
    else {
      const expected = deriveVerdict(review.findings)
      if (review.verdict !== expected) problems.push(`verdict=${review.verdict} 与 findings 推导值 ${expected} 不一致`)
    }
  }
  if (review.reusedFiles !== undefined) {
    if (!Number.isInteger(review.reusedFiles) || review.reusedFiles < 0) problems.push('reusedFiles 不是非负整数')
    else if (Number.isFinite(filesTotal) && review.reusedFiles > filesTotal) problems.push(`reusedFiles=${review.reusedFiles} 超过 filesTotal=${filesTotal}`)
  }
  return problems
}

/**
 * A v1.1 review field set is "deployed" when any of the new fields is present.
 * @param {Record<string, unknown>} review
 * @returns {boolean}
 */
function hasV11Fields(review) {
  return isObject(review) && ['options', 'verdict', 'reusedFiles', 'guidelines'].some((key) => review[key] !== undefined)
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
// A live plugin reload (disable → enable) briefly removes the prefix route and
// answers 404/405; retry before declaring the plugin missing.
for (let attempt = 0; attempt < 3; attempt += 1) {
  try {
    health = await client.post('codex-review/health', {}, { timeoutMs: 20_000 })
  } catch (error) {
    console.error(`✗ 无法连接插件路由：${error.message}`)
    report.routesReady = false
    report.error = { message: error.message }
    writeJson(options.reportPath, report)
    process.exit(EXIT.ENV)
  }
  if (health.status === 200 || health.status === 401) break
  if (attempt < 2) await delay(1500)
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
  console.error('  若刚刚执行过插件 reload（disable→enable），可能只是重载窗口，稍等 2s 重跑即可。')
  console.error('  安装插件并使其生效后，重新运行本脚本即可。')
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
// llm-info (debug route added while diagnosing reasoning-budget failures)
// Informational: absence is not a contract failure, presence is validated.
// ---------------------------------------------------------------------------
const llmInfoResponse = await client.post('codex-review/llm-info', {}, { timeoutMs: 20_000 })
if (llmInfoResponse.status === 200) {
  const llmInfoEnvelope = parseEnvelope(llmInfoResponse)
  check('llm-info: 信封形状合法（调试路由）', llmInfoEnvelope.envelope, llmInfoEnvelope.note || (llmInfoEnvelope.ok ? 'ok:true' : `ok:false/${llmInfoEnvelope.error?.code}`))
  if (llmInfoEnvelope.ok) {
    report.routes.llmInfo = llmInfoEnvelope.value
  }
} else {
  report.routes.llmInfo = { available: false, status: llmInfoResponse.status, note: '调试路由不存在（可选）' }
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
    const totalCount = typeof value.totalCount === 'number' ? value.totalCount : null
    // The count is GitHub data, not plugin behavior: pass when either the
    // configured floor is met OR the returned page matches totalCount with a
    // minimal sane floor (open PRs get merged/closed while the repo is in use).
    const meetsMin = items.length >= options.minPrs
    const matchesTotal = totalCount !== null && items.length === totalCount && totalCount >= 5
    check(
      `prs: 返回至少 ${options.minPrs} 条（或与 totalCount 一致且 ≥5）`,
      meetsMin || matchesTotal,
      `实际 ${items.length} 条，totalCount=${String(totalCount)}${meetsMin ? '' : matchesTotal ? '（真实 open PR 数不足阈值，按 totalCount 一致放行）' : ''}`,
    )
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
        // A partial review means some chunks failed (JSON parse / max-tokens
        // truncation). Its empty findings are not a clean "0 problems" result.
        check(
          'review-status: 非 partial（所有分块均成功）',
          lastStatus.partial !== true,
          `partial=${String(lastStatus.partial)}${Array.isArray(lastStatus.partialReasons) && lastStatus.partialReasons.length > 0 ? `，reasons=${JSON.stringify(lastStatus.partialReasons).slice(0, 500)}` : ''}${lastStatus.truncatedCalls !== undefined ? `，truncatedCalls=${lastStatus.truncatedCalls}` : ''}`,
        )
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
          partialReasons: lastStatus.partialReasons,
          truncatedCalls: lastStatus.truncatedCalls,
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
    // is expected to report cancelled:false. Never cancel a live job from here:
    // a probe must not interfere with a review someone else is watching.
    const terminalReached = Boolean(lastStatus && TERMINAL_STATES.has(lastStatus.state))
    if (terminalReached) {
      const cancelResponse = await client.post('codex-review/review-cancel', { jobId }, { timeoutMs: 20_000 })
      const cancelEnvelope = settleEnvelope('review-cancel', cancelResponse)
      if (cancelEnvelope.envelope) {
        const cancelled = cancelEnvelope.ok ? cancelEnvelope.value?.cancelled : undefined
        check('review-cancel: ok:true 时 cancelled 是布尔', cancelEnvelope.ok ? typeof cancelled === 'boolean' : true, cancelEnvelope.ok ? JSON.stringify(cancelled) : `错误信封 ${cancelEnvelope.error.code}`)
        report.routes.reviewCancel = cancelEnvelope.ok ? { ok: true, cancelled } : { ok: false, error: cancelEnvelope.error }
      }
    } else {
      report.routes.reviewCancel = { skipped: true, reason: '审查未到终态；不调用真实 job 的 cancel，避免终止运行中的任务' }
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
// v1.1 assertions (CONTRACT.md §4.6)
//
// Structural checks read the cached review result and never start a model call.
// Real option-variation probes are opt-in (--v11-ai / --v11-threshold) because
// each one may start a full review; this probe NEVER cancels a live job.
// ---------------------------------------------------------------------------
if (options.v11) {
  const v11 = {
    enabled: true,
    capability: {},
    runs: [],
    statuses: [],
  }
  report.v11 = v11
  const v11StartIndex = checks.length
  const prRef = options.pr

  /**
   * POST review-start with optional v1.1 options.
   * @param {string} label
   * @param {Record<string, unknown> | undefined} reviewOptions
   */
  async function v11Start(label, reviewOptions) {
    const requestBody = { repo: prRef.repo, number: prRef.number }
    if (reviewOptions !== undefined) requestBody.options = reviewOptions
    const response = await client.post('codex-review/review-start', requestBody, { timeoutMs: 30_000 })
    const envelope = parseEnvelope(response)
    check(
      `v1.1[${label}]: review-start 信封合法`,
      response.status === 200 && envelope.envelope,
      `HTTP ${response.status}${envelope.note ? `，${envelope.note}` : ''}${envelope.ok === false ? `，${envelope.error.code}` : ''}`,
    )
    const value = envelope.ok ? envelope.value : undefined
    v11.runs.push({ label, request: requestBody, response: { status: response.status, value, error: envelope.error } })
    return { response, envelope, value }
  }

  /**
   * Poll review-status until a terminal state (never cancels).
   * @param {string} label
   * @param {string} jobId
   */
  async function v11Wait(label, jobId) {
    if (!isNonEmptyString(jobId)) return { status: null, note: '缺少 jobId' }
    const deadline = Date.now() + options.reviewTimeoutMs
    let last = null
    let polls = 0
    while (Date.now() < deadline) {
      const response = await client.post('codex-review/review-status', { jobId }, { timeoutMs: 20_000 })
      const envelope = parseEnvelope(response)
      polls += 1
      if (response.status !== 200 || !envelope.envelope || !envelope.ok) {
        return { status: last, note: `轮询失败 HTTP ${response.status}${envelope.error ? `/${envelope.error.code}` : ''}`, polls }
      }
      last = envelope.value
      if (TERMINAL_STATES.has(last?.state)) {
        v11.statuses.push({ label, jobId, state: last.state, polls, value: last })
        return { status: last, polls }
      }
      await delay(options.pollMs)
    }
    return { status: last, note: `超时 ${options.reviewTimeoutMs}ms 未到终态`, polls }
  }

  // Capability detection: a v1.1 Host returns the new review fields; read-only
  // when a cached review exists, otherwise defer to the opt-in real probes.
  const v11DetailResponse = await client.post('codex-review/pr', { repo: prRef.repo, number: prRef.number }, { timeoutMs: 30_000 })
  const v11DetailEnvelope = parseEnvelope(v11DetailResponse)
  const v11DetailReview = v11DetailEnvelope.ok && isObject(v11DetailEnvelope.value?.review) ? v11DetailEnvelope.value.review : {}
  v11.capability.fromPrDetail = hasV11Fields(v11DetailReview)
  v11.capability.prReviewKeys = Object.keys(v11DetailReview)

  /** @type {{value?: any} | null} */
  let defaultRun = null
  let fastRunId
  let deepRunId
  let p0RunId
  if (!v11.capability.fromPrDetail && (options.v11Ai || options.v11Threshold || options.v11NewJob)) {
    defaultRun = await v11Start('default', undefined)
    v11.capability.fromReviewStart = hasV11Fields(defaultRun.value?.options ? { options: defaultRun.value.options } : {})
  }
  const v11Active = v11.capability.fromPrDetail || v11.capability.fromReviewStart === true
  v11.active = v11Active
  check(
    'v1.1: Host 已部署 v1.1 契约（options/verdict/reusedFiles/guidelines 可见）',
    v11Active,
    JSON.stringify(v11.capability),
  )

  if (!v11Active) {
    checkPending('v1.1: ReviewStatus/PrDetail.review 新字段形状（options/verdict/reusedFiles/guidelines）', 'v1.1 尚未生效（Host 未部署）')
    checkPending('v1.1: depth=fast 与默认产生不同 job key', 'v1.1 尚未生效')
    checkPending('v1.1: 同设置同 headSha 二次 review-start cached=true', 'v1.1 尚未生效')
    checkPending('v1.1: severityThreshold=P0 时 findings 全 P0', 'v1.1 尚未生效')
    checkPending('v1.1: includeGuidelines/AGENTS.md 注入（guidelines.loaded）', 'v1.1 尚未生效')
    checkPending('v1.1: reusedFiles 增量复用', 'v1.1 尚未生效')
    checkPending('v1.1: 未缓存选项组合产生新 job key 且复用全命中', 'v1.1 尚未生效')
  } else {
    const filesTotal = typeof v11DetailReview.filesTotal === 'number'
      ? v11DetailReview.filesTotal
      : undefined
    // Structural validation of PrDetail.review (cached result is enough).
    const detailProblems = validateV11ReviewFields(v11DetailReview, filesTotal)
    check('v1.1: PrDetail.review 新字段形状合法', detailProblems.length === 0, detailProblems.slice(0, 6).join('；'))
    check(
      'v1.1: PrDetail.review.options.depth/severityThreshold/includeGuidelines 存在且合法',
      isObject(v11DetailReview.options) && validateResolvedOptions(v11DetailReview.options).length === 0,
      JSON.stringify(v11DetailReview.options),
    )
    check(
      'v1.1: PrDetail.review.verdict 合法且与 findings 一致',
      VERDICTS.has(v11DetailReview.verdict) && v11DetailReview.verdict === deriveVerdict(v11DetailReview.findings),
      `verdict=${JSON.stringify(v11DetailReview.verdict)}，findings=${(v11DetailReview.findings ?? []).length}`,
    )
    check(
      'v1.1: PrDetail.review.guidelines 形状合法',
      validateGuidelines(v11DetailReview.guidelines).length === 0,
      JSON.stringify(v11DetailReview.guidelines),
    )
    check(
      'v1.1: PrDetail.review.reusedFiles 为非负整数',
      Number.isInteger(v11DetailReview.reusedFiles) && v11DetailReview.reusedFiles >= 0,
      JSON.stringify(v11DetailReview.reusedFiles),
    )

    // ReviewStatus carries the same new fields; fetch the cached job if known.
    const cachedJobId = v11DetailReview.jobId
    if (isNonEmptyString(cachedJobId)) {
      const cachedStatusResponse = await client.post('codex-review/review-status', { jobId: cachedJobId }, { timeoutMs: 20_000 })
      const cachedEnvelope = parseEnvelope(cachedStatusResponse)
      if (cachedEnvelope.envelope && cachedEnvelope.ok) {
        const cachedStatus = cachedEnvelope.value
        v11.statuses.push({ label: 'cached-detail', jobId: cachedJobId, state: cachedStatus.state, polls: 1, value: cachedStatus })
        const statusProblems = validateV11ReviewFields(cachedStatus, cachedStatus.progress?.filesTotal)
        check('v1.1: ReviewStatus 新字段形状合法', statusProblems.length === 0, statusProblems.slice(0, 6).join('；'))
        check(
          'v1.1: ReviewStatus.options 与 depth 预设一致',
          validateDepthPreset(cachedStatus.options).length === 0,
          JSON.stringify(cachedStatus.options),
        )
      } else {
        checkPending('v1.1: ReviewStatus 新字段形状（缓存 job 不可读）', `review-status ${cachedEnvelope.note || cachedEnvelope.error?.code || 'failed'}`)
      }
    } else {
      checkPending('v1.1: ReviewStatus 新字段形状（当前无缓存 job）', '需要 --v11-ai 先完成一次审查')
    }

    // --- opt-in real option probes -----------------------------------------
    if (options.v11Ai) {
      if (!defaultRun) defaultRun = await v11Start('default', undefined)
      const defaultJobId = defaultRun.value?.jobId
      check(
        'v1.1[default]: review-start 返回 ResolvedReviewOptions',
        isObject(defaultRun.value?.options) && validateResolvedOptions(defaultRun.value.options).length === 0,
        JSON.stringify(defaultRun.value?.options),
      )
      check(
        'v1.1[default]: 默认 depth=standard、severityThreshold=P2、includeGuidelines=true',
        defaultRun.value?.options?.depth === 'standard'
          && defaultRun.value?.options?.severityThreshold === 'P2'
          && defaultRun.value?.options?.includeGuidelines === true,
        JSON.stringify(defaultRun.value?.options),
      )
      const defaultWait = await v11Wait('default', defaultJobId)
      const defaultStatus = defaultWait.status
      check('v1.1[default]: 到达 done 终态', defaultStatus?.state === 'done', defaultWait.note || `state=${defaultStatus?.state}`)
      if (defaultStatus?.state === 'done') {
        check('v1.1[default]: partial=false', defaultStatus.partial !== true, `partial=${String(defaultStatus.partial)}`)
        const g = defaultStatus.guidelines
        // Acefake/yingbox has an AGENTS.md (26959 bytes, truncated to <=4000).
        check(
          'v1.1[default]: includeGuidelines 生效（repo 有 AGENTS.md → guidelines.loaded=true）',
          isObject(g) && g.loaded === true && Array.isArray(g.files) && g.files.some((file) => /AGENTS\.md/iu.test(file)) && g.chars > 0 && g.chars <= 4000,
          JSON.stringify(g),
        )
      }

      // Same settings + same headSha second call must hit the cache.
      const secondRun = await v11Start('default-second', undefined)
      check(
        'v1.1: 同设置同 headSha 二次 review-start cached=true 且 jobId 相同',
        secondRun.value?.cached === true && secondRun.value?.jobId === defaultJobId,
        `cached=${JSON.stringify(secondRun.value?.cached)}，jobId=${secondRun.value?.jobId} vs ${defaultJobId}`,
      )

      // depth=fast must be a distinct job key with the fast preset budgets.
      const fastRun = await v11Start('fast', { depth: 'fast' })
      fastRunId = fastRun.value?.jobId
      check(
        'v1.1[fast]: depth=fast 产生不同 job key',
        isNonEmptyString(fastRun.value?.jobId) && fastRun.value.jobId !== defaultJobId,
        `fast=${fastRun.value?.jobId}，default=${defaultJobId}`,
      )
      check(
        'v1.1[fast]: options 与 fast 预设一致（16000/6/4）',
        fastRun.value?.options?.depth === 'fast' && validateDepthPreset(fastRun.value.options).length === 0,
        JSON.stringify(fastRun.value?.options),
      )
      const fastWait = await v11Wait('fast', fastRun.value?.jobId)
      check('v1.1[fast]: 到达 done 终态', fastWait.status?.state === 'done', fastWait.note || `state=${fastWait.status?.state}`)
      const filesTotal = defaultStatus?.progress?.filesTotal
      if (fastWait.status?.state === 'done') {
        check('v1.1[fast]: partial=false', fastWait.status.partial !== true, `partial=${String(fastWait.status.partial)}`)
        check(
          'v1.1[fast]: reusedFiles 为 0..filesTotal 的整数',
          Number.isInteger(fastWait.status.reusedFiles) && fastWait.status.reusedFiles >= 0 && (!Number.isFinite(filesTotal) || fastWait.status.reusedFiles <= filesTotal),
          `reusedFiles=${JSON.stringify(fastWait.status.reusedFiles)}，filesTotal=${String(filesTotal)}，elapsedMs=${fastWait.status.progress?.elapsedMs}`,
        )
        check(
          'v1.1[fast]: verdict 与 findings 一致',
          VERDICTS.has(fastWait.status.verdict) && fastWait.status.verdict === deriveVerdict(fastWait.status.findings),
          `verdict=${JSON.stringify(fastWait.status.verdict)}`,
        )
      }

      // Cross-depth incremental reuse: the pre-warmed deep run reuses every file
      // (reusedFiles === filesTotal, near-zero elapsed, no model calls).
      const deepRun = await v11Start('deep', { depth: 'deep' })
      deepRunId = deepRun.value?.jobId
      check(
        'v1.1[deep]: 与 default/fast 产生不同 job key',
        isNonEmptyString(deepRun.value?.jobId) && deepRun.value.jobId !== defaultJobId && deepRun.value.jobId !== fastRun.value?.jobId,
        `deep=${deepRun.value?.jobId}，default=${defaultJobId}，fast=${fastRun.value?.jobId}`,
      )
      check(
        'v1.1[deep]: options 与 deep 预设一致（6000/20/2）',
        deepRun.value?.options?.depth === 'deep' && validateDepthPreset(deepRun.value.options).length === 0,
        JSON.stringify(deepRun.value?.options),
      )
      const deepWait = await v11Wait('deep', deepRun.value?.jobId)
      check('v1.1[deep]: 到达 done 终态', deepWait.status?.state === 'done', deepWait.note || `state=${deepWait.status?.state}`)
      if (deepWait.status?.state === 'done') {
        check('v1.1[deep]: partial=false', deepWait.status.partial !== true, `partial=${String(deepWait.status.partial)}`)
        check(
          'v1.1[deep]: 增量复用全命中（reusedFiles === filesTotal 且 elapsedMs 很小）',
          Number.isInteger(deepWait.status.reusedFiles)
            && Number.isFinite(filesTotal)
            && deepWait.status.reusedFiles === filesTotal
            && Number(deepWait.status.progress?.elapsedMs) < 5000,
          `reusedFiles=${JSON.stringify(deepWait.status.reusedFiles)}，filesTotal=${String(filesTotal)}，elapsedMs=${deepWait.status.progress?.elapsedMs}`,
        )
        check(
          'v1.1[deep]: verdict 与 findings 一致',
          VERDICTS.has(deepWait.status.verdict) && deepWait.status.verdict === deriveVerdict(deepWait.status.findings),
          `verdict=${JSON.stringify(deepWait.status.verdict)}，findings=${(deepWait.status.findings ?? []).length}`,
        )
      }
    }

    if (options.v11Threshold) {
      // Use the pre-warmed fast+P0 combination so this probe never starts a long
      // review: cached results still prove the server-side severity filtering.
      const p0Run = await v11Start('threshold-P0', { depth: 'fast', severityThreshold: 'P0' })
      p0RunId = p0Run.value?.jobId
      check(
        'v1.1[threshold-P0]: options.severityThreshold=P0 回显',
        p0Run.value?.options?.severityThreshold === 'P0',
        JSON.stringify(p0Run.value?.options),
      )
      check(
        'v1.1[threshold-P0]: 与默认设置产生不同 job key',
        isNonEmptyString(p0Run.value?.jobId) && p0Run.value.jobId !== defaultRun?.value?.jobId,
        `p0=${p0Run.value?.jobId}，default=${defaultRun?.value?.jobId}`,
      )
      const p0Wait = await v11Wait('threshold-P0', p0Run.value?.jobId)
      check('v1.1[threshold-P0]: 到达 done 终态', p0Wait.status?.state === 'done', p0Wait.note || `state=${p0Wait.status?.state}`)
      if (p0Wait.status?.state === 'done') {
        const findings = Array.isArray(p0Wait.status.findings) ? p0Wait.status.findings : []
        check('v1.1[threshold-P0]: partial=false', p0Wait.status.partial !== true, `partial=${String(p0Wait.status.partial)}`)
        check(
          'v1.1[threshold-P0]: findings 全为 P0',
          findings.every((finding) => finding?.severity === 'P0'),
          `findings=${findings.length}，severity=${JSON.stringify([...new Set(findings.map((finding) => finding.severity))])}`,
        )
        check(
          'v1.1[threshold-P0]: verdict 与过滤后 findings 一致',
          p0Wait.status.verdict === deriveVerdict(findings),
          `verdict=${JSON.stringify(p0Wait.status.verdict)}，期望 ${deriveVerdict(findings)}`,
        )
        check(
          'v1.1[threshold-P0]: overview 统计与过滤后集合一致',
          typeof p0Wait.status.overview === 'string' && p0Wait.status.overview.includes(String(findings.length)),
          `overview=${JSON.stringify(p0Wait.status.overview)}，findings=${findings.length}`,
        )
        check(
          'v1.1[threshold-P0]: 过滤复用全命中（reusedFiles === filesTotal 且 elapsedMs 很小）',
          Number.isInteger(p0Wait.status.reusedFiles)
            && Number.isFinite(p0Wait.status.progress?.filesTotal)
            && p0Wait.status.reusedFiles === p0Wait.status.progress.filesTotal
            && Number(p0Wait.status.progress?.elapsedMs) < 5000,
          `reusedFiles=${JSON.stringify(p0Wait.status.reusedFiles)}，filesTotal=${String(p0Wait.status.progress?.filesTotal)}，elapsedMs=${p0Wait.status.progress?.elapsedMs}`,
        )
      }
    }

    if (options.v11NewJob) {
      // An uncached option combination still reuses every file (no model calls):
      // proves job keys include options while file-level reuse stays cross-option.
      const newRun = await v11Start('newjob-fast-P1', { depth: 'fast', severityThreshold: 'P1' })
      const knownJobIds = new Set([defaultRun?.value?.jobId, fastRunId, deepRunId, p0RunId].filter(isNonEmptyString))
      check(
        'v1.1[newjob]: 未缓存选项组合产生不同 job key',
        isNonEmptyString(newRun.value?.jobId) && !knownJobIds.has(newRun.value.jobId),
        `new=${newRun.value?.jobId}，known=${JSON.stringify([...knownJobIds])}`,
      )
      check(
        'v1.1[newjob]: options 回显 fast+P1',
        newRun.value?.options?.depth === 'fast' && newRun.value?.options?.severityThreshold === 'P1' && validateDepthPreset(newRun.value.options).length === 0,
        JSON.stringify(newRun.value?.options),
      )
      const newWait = await v11Wait('newjob-fast-P1', newRun.value?.jobId)
      check('v1.1[newjob]: 到达 done 终态', newWait.status?.state === 'done', newWait.note || `state=${newWait.status?.state}`)
      if (newWait.status?.state === 'done') {
        const findings = Array.isArray(newWait.status.findings) ? newWait.status.findings : []
        const filesTotalNew = newWait.status.progress?.filesTotal
        check('v1.1[newjob]: partial=false', newWait.status.partial !== true, `partial=${String(newWait.status.partial)}`)
        check(
          'v1.1[newjob]: 增量复用全命中且无长耗时（reusedFiles === filesTotal，elapsedMs < 5000）',
          Number.isInteger(newWait.status.reusedFiles) && Number.isFinite(filesTotalNew) && newWait.status.reusedFiles === filesTotalNew && Number(newWait.status.progress?.elapsedMs) < 5000,
          `reusedFiles=${JSON.stringify(newWait.status.reusedFiles)}，filesTotal=${String(filesTotalNew)}，elapsedMs=${newWait.status.progress?.elapsedMs}`,
        )
        check(
          'v1.1[newjob]: findings 仅含 P0/P1（P1 阈值过滤）',
          findings.every((finding) => finding?.severity === 'P0' || finding?.severity === 'P1'),
          `findings=${findings.length}，severity=${JSON.stringify([...new Set(findings.map((finding) => finding.severity))])}`,
        )
        check(
          'v1.1[newjob]: verdict 与过滤后 findings 一致',
          newWait.status.verdict === deriveVerdict(findings),
          `verdict=${JSON.stringify(newWait.status.verdict)}，期望 ${deriveVerdict(findings)}`,
        )
      }
    }
  }

  v11.checks = checks.slice(v11StartIndex)
  v11.pendingCount = v11.checks.filter((entry) => entry.pending === true).length
  v11.failedCount = v11.checks.filter((entry) => entry.pending !== true && entry.pass === false).length
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

const decisive = checks.filter((entry) => entry.pending !== true)
const ok = decisive.every((entry) => entry.pass)
report.verdict = {
  ok,
  failed: decisive.filter((entry) => !entry.pass).map((entry) => entry.name),
  passed: decisive.filter((entry) => entry.pass).length,
  pending: checks.filter((entry) => entry.pending === true).map((entry) => entry.name),
}
report.finishedAt = isoTimestamp()
writeJson(options.reportPath, report)

const summary = {
  ok,
  baseUrl: options.baseUrl,
  auth: report.auth,
  routesReady: report.routesReady,
  report: options.reportPath,
  totalChecks: checks.length,
  passedChecks: report.verdict.passed,
  failedChecks: report.verdict.failed,
  pendingChecks: report.verdict.pending,
  prsCount: report.routes.prs?.count ?? null,
  prFiles: report.routes.pr?.files ?? null,
  reviewState: report.routes.review?.state ?? null,
  findings: report.routes.review?.findingsCount ?? null,
  v11Active: report.v11?.active ?? null,
  v11Pending: report.v11?.pendingCount ?? 0,
  v11Failed: report.v11?.failedCount ?? 0,
}
if (options.jsonOnly) console.log(JSON.stringify(summary))
else {
  console.log(`${ok ? '✓' : '✗'} 插件路由契约检查完成（${checks.length} 项断言，${decisive.filter((entry) => entry.pass).length} 通过${report.verdict.pending.length > 0 ? `，${report.verdict.pending.length} pending` : ''}）`)
  for (const entry of checks) {
    const marker = entry.pending === true ? '  ○' : entry.pass ? '  ✓' : '  ✗'
    console.log(`${marker} ${entry.name}${entry.detail ? ` — ${entry.detail}` : ''}`)
  }
  console.log(JSON.stringify(summary, null, 2))
}
process.exitCode = ok ? EXIT.OK : EXIT.FAIL
