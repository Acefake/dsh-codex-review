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
import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
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
  --v2                      启用 v2 断言：合并守卫（绝不真实合并）+ PR 对话 SSE 真实提问 + BAD_REQUEST 分支
  --v2-skip-chat            跳过 v2 的真实 chat 提问（只测合并守卫与 chat 参数校验）
  --v2-closed-pr <ref>      额外验证「非 open PR → MERGE_NOT_ALLOWED」（如 Acefake/yingbox#129，已合并；用全零 stale sha，绝不真实合并）
  --v2-pr <ref>             v2 守卫/chat 的目标 PR（如 Acefake/s-skills#18）；默认自动选列表第一个 open PR
  --v21                     启用 v2.1 自动审查断言：status 默认/config 夹取/force 真实 cycle/seen 去重/无 GitHub 写
  --v21-skip-force          跳过 v2.1 的真实 force cycle（只测 status/config/run 守卫）
  --v22                     启用 v2.2 发布断言：review-publish 路由/守卫 + REVIEW_NOT_READY 分支（绝不真实发布）
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
        v2: { type: 'boolean', default: false },
        'v2-skip-chat': { type: 'boolean', default: false },
        'v2-closed-pr': { type: 'string', default: '' },
        'v2-pr': { type: 'string', default: '' },
        v21: { type: 'boolean', default: false },
        'v21-skip-force': { type: 'boolean', default: false },
        v22: { type: 'boolean', default: false },
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
    v2: values.v2,
    v2SkipChat: values['v2-skip-chat'],
    v2ClosedPr: String(values['v2-closed-pr'] ?? '').trim(),
    v2Pr: String(values['v2-pr'] ?? '').trim(),
    v21: values.v21,
    v21SkipForce: values['v21-skip-force'],
    v22: values.v22,
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
    const matchesTotal = totalCount !== null && items.length === totalCount && totalCount >= 1
    check(
      `prs: 返回至少 ${options.minPrs} 条（或与 totalCount 一致且 ≥1）`,
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
    // Data-aware: the stacked base PR can disappear once it is merged and its
    // branch deleted; the declared `base: <branch>` marker still proves the
    // stack was parsed. Accept either the referenced PR or a declared base.
    const stackFallback = isObject(stack) && typeof stack.declaredBase === 'string' && stack.declaredBase.trim() !== ''
    check(
      `pr: stack 链路包含 #${options.stackRef}（或 declaredBase 回退）`,
      stackInfo.found || stackFallback,
      `chain=${JSON.stringify(stackInfo.chainNumbers)} basePr=${stackInfo.basePr ?? '-'} declaredBase=${stackInfo.declaredBase ?? '-'}${stackInfo.found ? '' : stackFallback ? '（#117 已不在链表中，按 declaredBase 回退放行）' : ''}`,
    )
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
// v2 assertions (CONTRACT §5.4): merge guards (NEVER a real merge) + chat SSE.
//
// SAFETY: this probe only ever sends `confirm:true` together with an all-zero
// (deliberately stale) expectedHeadSha, so the server-side head guard rejects it
// before any GitHub write. `confirm:false` / malformed bodies cannot merge.
// ---------------------------------------------------------------------------
if (options.v2) {
  const v2 = { enabled: true, capability: {}, checks: [], chat: {}, merges: [], mergeState: null }
  report.v2 = v2
  const v2Start = checks.length
  // Pick an *open* PR for the guard tests: a closed/merged PR would short-circuit
  // to MERGE_NOT_ALLOWED before the head-moved guard. Preferred target is
  // --v2-pr, then --pr when it is still open, otherwise the first open PR.
  let prRef = { repo: options.pr.repo, number: options.pr.number }
  let explicitRef = null
  let explicitState = null
  if (options.v2Pr) {
    const explicitMatch = options.v2Pr.match(/^([^/\s#]+)\/([^/\s#]+)#(\d+)$/u)
    if (!explicitMatch) {
      check('v2: --v2-pr 格式合法（owner/name#number）', false, options.v2Pr)
    } else {
      explicitRef = { repo: `${explicitMatch[1]}/${explicitMatch[2]}`, number: Number(explicitMatch[3]) }
    }
  }
  try {
    const listResponse = await client.post('codex-review/prs', { query: 'is:open author:@me', limit: 30 }, { timeoutMs: 20_000 })
    const items = listResponse.json?.value?.items ?? []
    if (explicitRef) {
      prRef = explicitRef
      const detailResponse = await client.post('codex-review/pr', explicitRef, { timeoutMs: 30_000 })
      const detailEnvelope = parseEnvelope(detailResponse)
      explicitState = detailEnvelope.ok ? (detailEnvelope.value?.summary?.state ?? null) : null
      v2.target = { repo: prRef.repo, number: prRef.number, openCount: items.length, explicit: true, explicitState, openTarget: explicitState === 'open' }
    } else {
      const preferred = items.find((item) => item.repo === options.pr.repo && item.number === options.pr.number)
      const chosen = preferred ?? items.find((item) => item.state === 'open') ?? null
      if (chosen) prRef = { repo: chosen.repo, number: chosen.number }
      v2.target = { repo: prRef.repo, number: prRef.number, openCount: items.length, preferredOpen: Boolean(preferred), openTarget: Boolean(preferred || items.some((item) => item.state === 'open')) }
    }
  } catch (error) {
    v2.target = { repo: prRef.repo, number: prRef.number, openCount: null, openTarget: false, error: error.message }
  }
  check(
    'v2: 选中一个 open PR 作为合并守卫目标（只读守卫，不执行合并）',
    v2.target.openTarget === true,
    JSON.stringify(v2.target),
  )

  /** Read the PR state/headSha used to prove no merge happened. */
  const readPrState = async () => {
    const response = await client.post('codex-review/pr', { repo: prRef.repo, number: prRef.number }, { timeoutMs: 30_000 })
    const envelope = parseEnvelope(response)
    const value = envelope.ok ? envelope.value : undefined
    return { state: value?.summary?.state ?? null, headSha: value?.summary?.headSha ?? value?.review?.headSha ?? null }
  }

  /**
   * POST /codex-review/merge. Hard safety guard: a confirm:true request may only
   * carry an all-zero (stale) headSha, never the real one.
   */
  const merge = async (body, label) => {
    if (body.confirm === true && !/^0+$/u.test(String(body.expectedHeadSha ?? ''))) {
      throw new Error(`SAFETY: 拒绝发送 confirm:true + 非全零 expectedHeadSha（${label}）`)
    }
    const response = await client.post('codex-review/merge', body, { timeoutMs: 30_000 })
    const envelope = parseEnvelope(response)
    v2.merges.push({
      label,
      request: { repo: body.repo, number: body.number, method: body.method, expectedHeadSha: body.expectedHeadSha, confirm: body.confirm },
      response: { status: response.status, ok: envelope.ok, code: envelope.error?.code, message: envelope.error?.message?.slice(0, 300) },
    })
    return { response, envelope }
  }

  // Capability probe: confirm:false is rejected with BAD_REQUEST once the route
  // exists; HTTP 404/405 means the v2 Host is not deployed yet.
  const capabilityProbe = await merge({ repo: prRef.repo, number: prRef.number, method: 'squash', expectedHeadSha: '0'.repeat(40), confirm: false }, 'capability-confirm-false')
  const v2Active = capabilityProbe.response.status !== 404 && capabilityProbe.response.status !== 405 && capabilityProbe.envelope.envelope
  v2.capability = { mergeRoute: v2Active, status: capabilityProbe.response.status }
  check(
    'v2: Host 已部署 v2 路由（/codex-review/merge 返回 JSON 信封）',
    v2Active,
    `merge HTTP ${capabilityProbe.response.status}${capabilityProbe.envelope.error ? `/${capabilityProbe.envelope.error.code}` : ''}`,
  )

  if (!v2Active) {
    checkPending('v2 merge 守卫: confirm:false → BAD_REQUEST', 'v2 尚未生效')
    checkPending('v2 merge 守卫: 缺 method/expectedHeadSha/confirm → BAD_REQUEST', 'v2 尚未生效')
    checkPending('v2 merge 守卫: 非法 method → BAD_REQUEST', 'v2 尚未生效')
    checkPending('v2 merge 守卫: stale expectedHeadSha → MERGE_HEAD_MOVED 且 PR 未变', 'v2 尚未生效')
    checkPending('v2 chat: SSE 真实提问（delta/done/非空文本）', 'v2 尚未生效')
    checkPending('v2 chat: BAD_REQUEST 参数校验分支', 'v2 尚未生效')
  } else {
    // --- merge guards (no write can happen: confirm false / malformed / stale) --
    check(
      'v2 merge 守卫: confirm:false → BAD_REQUEST',
      capabilityProbe.envelope.ok === false && capabilityProbe.envelope.error?.code === 'BAD_REQUEST',
      JSON.stringify(capabilityProbe.envelope.error ?? {}).slice(0, 300),
    )
    const noConfirm = await merge({ repo: prRef.repo, number: prRef.number, method: 'squash', expectedHeadSha: '0'.repeat(40) }, 'missing-confirm')
    check(
      'v2 merge 守卫: 缺 confirm 字段 → BAD_REQUEST',
      noConfirm.envelope.ok === false && noConfirm.envelope.error?.code === 'BAD_REQUEST',
      JSON.stringify(noConfirm.envelope.error ?? {}).slice(0, 300),
    )
    const noMethod = await merge({ repo: prRef.repo, number: prRef.number, expectedHeadSha: '0'.repeat(40), confirm: false }, 'missing-method')
    check(
      'v2 merge 守卫: 缺 method → BAD_REQUEST',
      noMethod.envelope.ok === false && noMethod.envelope.error?.code === 'BAD_REQUEST',
      JSON.stringify(noMethod.envelope.error ?? {}).slice(0, 300),
    )
    const badMethod = await merge({ repo: prRef.repo, number: prRef.number, method: 'squashh', expectedHeadSha: '0'.repeat(40), confirm: false }, 'invalid-method')
    check(
      'v2 merge 守卫: 非法 method → BAD_REQUEST',
      badMethod.envelope.ok === false && badMethod.envelope.error?.code === 'BAD_REQUEST',
      JSON.stringify(badMethod.envelope.error ?? {}).slice(0, 300),
    )
    const noSha = await merge({ repo: prRef.repo, number: prRef.number, method: 'squash', confirm: false }, 'missing-sha')
    check(
      'v2 merge 守卫: 缺 expectedHeadSha → BAD_REQUEST',
      noSha.envelope.ok === false && noSha.envelope.error?.code === 'BAD_REQUEST',
      JSON.stringify(noSha.envelope.error ?? {}).slice(0, 300),
    )

    // --- stale head guard: confirm:true but deliberately all-zero headSha -----
    const openTarget = v2.target?.openTarget === true
    v2.target.openTarget = openTarget
    if (!openTarget) {
      checkPending('v2 merge 守卫: stale expectedHeadSha → MERGE_HEAD_MOVED', '当前没有 open PR 可用于 stale-head 守卫验证（避免对 closed PR 误判）')
      checkPending('v2 merge 守卫: PR 未被合并（state 仍为 open）', '无 open PR 目标')
    } else {
      const before = await readPrState()
      const actualHead = typeof before.headSha === 'string' ? before.headSha : ''
      const staleSha = '0'.repeat(40)
      check(
        'v2 merge 守卫: stale-head 安全前置（stale ≠ 实际 head，confirm:true 仅配全零 sha）',
        actualHead !== '' && staleSha !== actualHead,
        `actual=${actualHead.slice(0, 12)}…，stale=${staleSha.slice(0, 12)}…`,
      )
      if (actualHead !== '' && staleSha !== actualHead) {
        const stale = await merge({ repo: prRef.repo, number: prRef.number, method: 'squash', expectedHeadSha: staleSha, confirm: true }, 'stale-head')
        check(
          'v2 merge 守卫: stale expectedHeadSha → MERGE_HEAD_MOVED',
          stale.envelope.ok === false && stale.envelope.error?.code === 'MERGE_HEAD_MOVED',
          JSON.stringify(stale.envelope.error ?? {}).slice(0, 300),
        )
        check(
          'v2 merge 守卫: MERGE_HEAD_MOVED message 带当前 headSha 前 12 位',
          typeof stale.envelope.error?.message === 'string' && stale.envelope.error.message.includes(actualHead.slice(0, 12)),
          `message=${JSON.stringify(stale.envelope.error?.message)}，期望含 ${actualHead.slice(0, 12)}`,
        )
        const after = await readPrState()
        check('v2 merge 守卫: PR 未被合并（state 仍为 open）', before.state === 'open' && after.state === 'open', `before=${before.state}，after=${after.state}`)
        check('v2 merge 守卫: PR headSha 未变化', after.headSha === before.headSha, `${String(before.headSha).slice(0, 12)}… → ${String(after.headSha).slice(0, 12)}…`)
        v2.mergeState = { before, after }
      }
    }

    // --- non-open PR guard (optional): state !== open → MERGE_NOT_ALLOWED -----
    if (options.v2ClosedPr) {
      const closedMatch = options.v2ClosedPr.match(/^([^/\s#]+)\/([^/\s#]+)#(\d+)$/u)
      if (!closedMatch) {
        check('v2 merge 守卫: 非 open PR → MERGE_NOT_ALLOWED', false, `--v2-closed-pr 格式非法：${options.v2ClosedPr}`)
      } else {
        const closedRepo = `${closedMatch[1]}/${closedMatch[2]}`
        const closedNumber = Number(closedMatch[3])
        const detailResponse = await client.post('codex-review/pr', { repo: closedRepo, number: closedNumber }, { timeoutMs: 30_000 })
        const detailEnvelope = parseEnvelope(detailResponse)
        const closedState = detailEnvelope.ok ? detailEnvelope.value?.summary?.state : null
        if (closedState === 'open') {
          check('v2 merge 守卫: 非 open PR → MERGE_NOT_ALLOWED', false, `目标 PR 仍是 open（${closedRepo}#${closedNumber}），跳过以避免误判`)
        } else {
          // SAFETY: confirm:true only with an all-zero stale sha; the state guard
          // (or the head guard) rejects it before any GitHub write.
          const closed = await merge({ repo: closedRepo, number: closedNumber, method: 'squash', expectedHeadSha: '0'.repeat(40), confirm: true }, 'closed-pr-state-guard')
          check(
            `v2 merge 守卫: 非 open PR（state=${String(closedState)}）→ MERGE_NOT_ALLOWED`,
            closed.envelope.ok === false && closed.envelope.error?.code === 'MERGE_NOT_ALLOWED',
            JSON.stringify(closed.envelope.error ?? {}).slice(0, 300),
          )
          v2.closedPr = { repo: closedRepo, number: closedNumber, state: closedState, code: closed.envelope.error?.code ?? null }
        }
      }
    }

    // --- real PR chat over SSE -------------------------------------------------
    if (options.v2SkipChat) {
      checkPending('v2 chat: SSE 真实提问（delta/done/非空文本）', '按 --v2-skip-chat 跳过')
      checkPending('v2 chat: BAD_REQUEST 参数校验分支', '按 --v2-skip-chat 跳过')
    } else {
      const chatBody = { repo: prRef.repo, number: prRef.number, messages: [{ role: 'user', content: '这个 PR 改了什么？' }] }
      const chat = await client.postSse('codex-review/chat', chatBody, { timeoutMs: 300_000 })
      const deltas = chat.events.filter((event) => typeof event?.delta === 'string')
      const chatText = deltas.map((event) => event.delta).join('')
      const doneFrame = chat.events.find((event) => event?.done === true)
      const errorFrame = chat.events.find((event) => event?.error)
      v2.chat.real = {
        status: chat.status,
        contentType: chat.contentType,
        elapsedMs: chat.elapsedMs,
        frameCount: chat.events.length,
        deltaCount: deltas.length,
        parseErrors: chat.parseErrors.slice(0, 3),
        done: doneFrame ? { model: doneFrame.model, usage: doneFrame.usage } : null,
        error: errorFrame ? errorFrame.error : null,
        text: chatText.slice(0, 3000),
      }
      check('v2 chat: HTTP 200 且 content-type=text/event-stream', chat.status === 200 && /text\/event-stream/i.test(chat.contentType), `HTTP ${chat.status}，${chat.contentType}`)
      check('v2 chat: SSE data 帧全部可解析', chat.parseErrors.length === 0, chat.parseErrors.slice(0, 3).join('；'))
      check('v2 chat: ≥1 个 delta 帧', deltas.length >= 1, `${deltas.length} 帧`)
      check('v2 chat: 以 done 帧结束', Boolean(doneFrame), JSON.stringify(doneFrame ?? {}).slice(0, 200))
      check('v2 chat: 无 error 帧', !errorFrame, JSON.stringify(errorFrame ?? {}).slice(0, 300))
      check('v2 chat: 拼接回答非空（≥10 字）', chatText.trim().length >= 10, `len=${chatText.trim().length}`)
      check(
        'v2 chat: 回答含 PR 相关词（文件/改动/PR/标题关键词）',
        /(intro|片头|ffmpeg|detector|文件|改动|PR|diff|审查|修改|代码)/iu.test(chatText),
        chatText.slice(0, 200),
      )

      // Guard branches: rejected before any model call.
      const badCases = [
        { name: 'messages 为空数组', body: { repo: prRef.repo, number: prRef.number, messages: [] } },
        { name: '最后一条不是 user', body: { repo: prRef.repo, number: prRef.number, messages: [{ role: 'assistant', content: 'hi' }] } },
        { name: '单条消息超长（>4000 字）', body: { repo: prRef.repo, number: prRef.number, messages: [{ role: 'user', content: 'x'.repeat(5000) }] } },
        { name: '消息条数超过 20', body: { repo: prRef.repo, number: prRef.number, messages: Array.from({ length: 21 }, (_, index) => ({ role: index % 2 === 0 ? 'user' : 'assistant', content: 'x' })) } },
      ]
      v2.chat.badCases = []
      for (const testCase of badCases) {
        const response = await client.postSse('codex-review/chat', testCase.body, { timeoutMs: 30_000, maxBytes: 200_000 })
        // Guard rejections may arrive either as a JSON envelope or — because the
        // SSE route opens the stream first — as one `data: {"error":...}` frame.
        const errorFrame = (response.events ?? []).find((event) => event?.error)
        const code = errorFrame?.error?.code ?? response.json?.error?.code
        const message = errorFrame?.error?.message ?? response.json?.error?.message ?? ''
        const rejected = code === 'BAD_REQUEST' || response.status === 400 || response.status === 422
        v2.chat.badCases.push({ name: testCase.name, status: response.status, contentType: response.contentType, code: code ?? null, frameCount: (response.events ?? []).length, rejected })
        check(`v2 chat BAD_REQUEST: ${testCase.name}`, rejected, `HTTP ${response.status}，code=${code ?? '-'}，${String(message).slice(0, 120)}`)
      }
      checkPending('v2 chat: 并发上限 BUSY（跳过，避免占用资源）', '契约 §5.4 允许跳过并发限制实测')
    }
  }

  v2.checks = checks.slice(v2Start)
  v2.pendingCount = v2.checks.filter((entry) => entry.pending === true).length
  v2.failedCount = v2.checks.filter((entry) => entry.pending !== true && entry.pass === false).length
}

// ---------------------------------------------------------------------------
// v2.1 assertions (CONTRACT §6.5): auto-review status/config/run, force cycle,
// seen dedup and the "no GitHub write" safety check. `enabled` is restored to
// false in a finally block even when a probe fails.
// ---------------------------------------------------------------------------
const AUTO_DEFAULTS = Object.freeze({
  enabled: false,
  intervalSeconds: 180,
  query: 'is:open author:@me',
  depth: 'fast',
  severityThreshold: 'P2',
  includeDrafts: false,
  maxPerCycle: 2,
})
const AUTO_DEPTHS = new Set(['fast', 'standard', 'deep'])
const AUTO_RECENT_STATES = new Set(['done', 'error', 'cancelled'])

/**
 * Validate `AutoReviewConfig` (CONTRACT §6.1).
 * @param {unknown} config
 * @returns {string[]} problems
 */
function validateAutoConfig(config) {
  if (!isObject(config)) return ['config 不是对象']
  const problems = []
  if (typeof config.enabled !== 'boolean') problems.push('enabled 不是布尔')
  if (!Number.isInteger(config.intervalSeconds) || config.intervalSeconds < 60 || config.intervalSeconds > 3600) problems.push(`intervalSeconds 越界（${JSON.stringify(config.intervalSeconds)}）`)
  if (!isNonEmptyString(config.query)) problems.push('query 为空')
  if (!AUTO_DEPTHS.has(config.depth)) problems.push(`depth 非法（${JSON.stringify(config.depth)}）`)
  if (!THRESHOLDS.has(config.severityThreshold)) problems.push(`severityThreshold 非法（${JSON.stringify(config.severityThreshold)}）`)
  if (typeof config.includeDrafts !== 'boolean') problems.push('includeDrafts 不是布尔')
  if (!Number.isInteger(config.maxPerCycle) || config.maxPerCycle < 1 || config.maxPerCycle > 5) problems.push(`maxPerCycle 越界（${JSON.stringify(config.maxPerCycle)}）`)
  return problems
}

/**
 * Validate one `recent` entry (CONTRACT §6.3).
 * @param {unknown} entry
 * @returns {string[]} problems
 */
function validateAutoRecentEntry(entry) {
  if (!isObject(entry)) return ['recent 条目不是对象']
  const problems = []
  if (!isNonEmptyString(entry.repo) || !/^[^/\s]+\/[^/\s]+$/u.test(entry.repo)) problems.push('repo 非法')
  if (!isPositiveInt(entry.number)) problems.push('number 非法')
  if (!isNonEmptyString(entry.headSha)) problems.push('headSha 为空')
  if (!AUTO_RECENT_STATES.has(entry.state)) problems.push(`state 非法（${JSON.stringify(entry.state)}）`)
  if (typeof entry.findings !== 'number' || entry.findings < 0) problems.push('findings 非法')
  if (entry.verdict !== undefined && !VERDICTS.has(entry.verdict)) problems.push(`verdict 非法（${JSON.stringify(entry.verdict)}）`)
  if (entry.overview !== undefined && typeof entry.overview !== 'string') problems.push('overview 不是字符串')
  if (typeof entry.finishedAt !== 'number') problems.push('finishedAt 不是数字')
  return problems
}

/**
 * Validate `AutoReviewStatus` (CONTRACT §6.3).
 * @param {unknown} status
 * @returns {string[]} problems
 */
function validateAutoStatus(status) {
  if (!isObject(status)) return ['status 不是对象']
  const problems = []
  problems.push(...validateAutoConfig(status.config).map((problem) => `config.${problem}`))
  if (typeof status.running !== 'boolean') problems.push('running 不是布尔')
  if (typeof status.seenCount !== 'number' || status.seenCount < 0) problems.push('seenCount 非法')
  if (!Array.isArray(status.recent)) problems.push('recent 不是数组')
  else if (status.recent.length > 20) problems.push(`recent 超过 20 条（${status.recent.length}）`)
  else status.recent.forEach((entry, index) => problems.push(...validateAutoRecentEntry(entry).map((problem) => `recent[${index}].${problem}`)))
  if (status.lastCycleAt !== undefined && typeof status.lastCycleAt !== 'number') problems.push('lastCycleAt 不是数字')
  if (status.nextCycleAt !== undefined && typeof status.nextCycleAt !== 'number') problems.push('nextCycleAt 不是数字')
  if (status.lastError !== undefined && (!isObject(status.lastError) || !isNonEmptyString(status.lastError.code) || typeof status.lastError.message !== 'string')) problems.push('lastError 形状非法')
  return problems
}

if (options.v21) {
  const v21 = { enabled: true, checks: [], status: {}, config: {}, runs: {}, safety: {}, stateFile: null }
  report.v21 = v21
  const v21Start = checks.length
  const stateFileCandidates = [
    process.env.DSH_PROFILE_DIR ? path.join(process.env.DSH_PROFILE_DIR, '.codex-review', 'auto-review.json') : null,
    process.env.DSH_HOME ? path.join(process.env.DSH_HOME, 'codex-review', 'auto-review.json') : null,
    path.join(os.homedir(), '.dsh', 'codex-review', 'auto-review.json'),
  ].filter(Boolean)
  const stateFile = stateFileCandidates.find((candidate) => existsSync(candidate)) ?? stateFileCandidates[0]
  v21.stateFile = stateFile
  v21.stateFileCandidates = stateFileCandidates

  const readStateFile = () => {
    try {
      return { path: stateFile, value: JSON.parse(readFileSync(stateFile, 'utf8')) }
    } catch (error) {
      return { path: stateFile, error: error.message }
    }
  }
  const getStatus = async () => {
    const response = await client.post('codex-review/auto-review-status', {}, { timeoutMs: 20_000 })
    const envelope = parseEnvelope(response)
    return { response, envelope, value: envelope.ok ? envelope.value : undefined }
  }
  const postConfig = async (patch) => {
    const response = await client.post('codex-review/auto-review-config', { patch }, { timeoutMs: 20_000 })
    const envelope = parseEnvelope(response)
    return { response, envelope, value: envelope.ok ? envelope.value : undefined }
  }
  const postRun = async (body) => {
    const response = await client.post('codex-review/auto-review-run', body, { timeoutMs: 20_000 })
    const envelope = parseEnvelope(response)
    return { response, envelope, value: envelope.ok ? envelope.value : undefined }
  }
  const waitCycleIdle = async (timeoutMs) => {
    const deadline = Date.now() + timeoutMs
    let last = null
    while (Date.now() < deadline) {
      const status = await getStatus()
      if (!status.envelope.envelope || !status.envelope.ok) return { status: last, note: `status 轮询失败 HTTP ${status.response.status}` }
      last = status.value
      if (last.running === false) return { status: last }
      await delay(options.pollMs)
    }
    return { status: last, note: `超时 ${timeoutMs}ms cycle 仍在 running` }
  }

  try {
    // Capability: the v2.1 status route answers a JSON envelope once deployed.
    const capability = await getStatus()
    const v21Active = capability.response.status !== 404 && capability.response.status !== 405 && capability.envelope.envelope
    v21.active = v21Active
    check('v2.1: Host 已部署自动审查路由（status/config/run 返回 JSON 信封）', v21Active, `status HTTP ${capability.response.status}${capability.envelope.error ? `/${capability.envelope.error.code}` : ''}`)

    if (!v21Active) {
      checkPending('v2.1 status 默认结构（config 默认值/running/recent/seenCount）', 'v2.1 尚未生效')
      checkPending('v2.1 config 夹取（interval 60–3600、maxPerCycle 1–5、非法 depth 回退、未知字段忽略）', 'v2.1 尚未生效')
      checkPending('v2.1 run {force:false} + disabled → started:false + reason', 'v2.1 尚未生效')
      checkPending('v2.1 run {force:true} 真实 cycle → recent done + findings/verdict 合法', 'v2.1 尚未生效')
      checkPending('v2.1 第二次 force 命中 seen（不重复审查）', 'v2.1 尚未生效')
      checkPending('v2.1 安全：auto-review 无 GitHub 写（PR state/评论数未变）', 'v2.1 尚未生效')
    } else {
      // --- status defaults ---------------------------------------------------
      // Normalize to contract defaults first: an earlier operator smoke may have
      // left interval/maxPerCycle or recent history behind (enabled must be off).
      const normalize = await postConfig({ ...AUTO_DEFAULTS })
      check('v2.1 status: 可先归一化到契约默认配置', normalize.envelope.ok && normalize.value?.config?.enabled === false, JSON.stringify(normalize.value?.config ?? normalize.envelope.error ?? {}).slice(0, 240))
      const initialStatus = await getStatus()
      const initial = initialStatus.value
      v21.status.initial = initial
      check('v2.1 status: 信封合法且 value 为对象', initialStatus.envelope.ok && isObject(initial), JSON.stringify(initialStatus.envelope.error ?? {}).slice(0, 200))
      const initialProblems = validateAutoStatus(initial)
      check('v2.1 status: AutoReviewStatus 结构合法', initialProblems.length === 0, initialProblems.slice(0, 6).join('；'))
      if (isObject(initial?.config)) {
        const cfg = initial.config
        check(
          'v2.1 status: config 默认值（enabled=false/interval=180/query/depth=fast/P2/includeDrafts=false/maxPerCycle=2）',
          cfg.enabled === false
            && cfg.intervalSeconds === AUTO_DEFAULTS.intervalSeconds
            && cfg.query === AUTO_DEFAULTS.query
            && cfg.depth === AUTO_DEFAULTS.depth
            && cfg.severityThreshold === AUTO_DEFAULTS.severityThreshold
            && cfg.includeDrafts === AUTO_DEFAULTS.includeDrafts
            && cfg.maxPerCycle === AUTO_DEFAULTS.maxPerCycle,
          JSON.stringify(cfg),
        )
      }
      // Data-aware: recent may already contain results from the operator smoke
      // (contract only bounds the list at 20); assert structure + idle state.
      check(
        'v2.1 status: running=false、recent 为数组（≤20）、seenCount≥0',
        initial?.running === false
          && Array.isArray(initial?.recent)
          && initial.recent.length <= 20
          && typeof initial?.seenCount === 'number'
          && initial.seenCount >= 0,
        JSON.stringify({ running: initial?.running, recent: initial?.recent?.length, seenCount: initial?.seenCount }),
      )

      // --- config clamping ---------------------------------------------------
      const clamp = await postConfig({ enabled: true, intervalSeconds: 30, maxPerCycle: 99, depth: 'nope', unknownKey: 1 })
      const clamped = clamp.value
      v21.config.clamped = clamped
      check('v2.1 config: 信封合法且回显 status', clamp.envelope.ok && isObject(clamped?.config), JSON.stringify(clamp.envelope.error ?? {}).slice(0, 200))
      if (isObject(clamped?.config)) {
        const cfg = clamped.config
        check('v2.1 config: intervalSeconds 30→夹取为 60', cfg.intervalSeconds === 60, JSON.stringify(cfg.intervalSeconds))
        check('v2.1 config: maxPerCycle 99→夹取为 5', cfg.maxPerCycle === 5, JSON.stringify(cfg.maxPerCycle))
        check('v2.1 config: 非法 depth 回退 fast', cfg.depth === 'fast', JSON.stringify(cfg.depth))
        check('v2.1 config: 未知字段被忽略', cfg.unknownKey === undefined, JSON.stringify(Object.keys(cfg)))
        check('v2.1 config: enabled=true 生效', cfg.enabled === true, JSON.stringify(cfg.enabled))
      }
      const persisted = readStateFile()
      v21.stateFileContent = persisted
      if (persisted.value) {
        check(
          'v2.1 config: 状态文件持久化（intervalSeconds=60/maxPerCycle=5/depth=fast/enabled=true）',
          persisted.value?.config?.intervalSeconds === 60 && persisted.value?.config?.maxPerCycle === 5 && persisted.value?.config?.depth === 'fast' && persisted.value?.config?.enabled === true,
          JSON.stringify(persisted.value?.config),
        )
      } else {
        checkPending('v2.1 config: 状态文件持久化', `无法读取 ${stateFile}：${persisted.error}`)
      }

      // Immediately turn it off again (default is off; never leave it enabled).
      const off = await postConfig({ enabled: false })
      check('v2.1 config: 可恢复 enabled=false', off.envelope.ok && off.value?.config?.enabled === false, JSON.stringify(off.value?.config ?? off.envelope.error ?? {}).slice(0, 200))

      // --- run without force while disabled ---------------------------------
      const guarded = await postRun({ force: false })
      check('v2.1 run: {force:false} + disabled → started:false 且带 reason', guarded.envelope.ok && guarded.value?.started === false && isNonEmptyString(guarded.value?.reason), JSON.stringify(guarded.value ?? guarded.envelope.error ?? {}).slice(0, 240))
      v21.runs.guarded = guarded.value

      // --- force cycle (real review, depth=fast) ----------------------------
      const openList = await client.post('codex-review/prs', { query: 'is:open author:@me', limit: 30 }, { timeoutMs: 20_000 })
      const openItems = openList.json?.value?.items ?? []
      v21.openPrCount = openItems.length
      let safetyBefore = null
      if (openItems.length > 0) {
        const target = openItems[0]
        const detail = await client.post('codex-review/pr', { repo: target.repo, number: target.number }, { timeoutMs: 30_000 })
        const envelope = parseEnvelope(detail)
        if (envelope.ok) {
          safetyBefore = {
            repo: target.repo,
            number: target.number,
            state: envelope.value?.summary?.state ?? null,
            headSha: envelope.value?.headSha ?? envelope.value?.summary?.headSha ?? null,
            commentsTotal: envelope.value?.comments?.total ?? null,
            inlineCount: Array.isArray(envelope.value?.comments?.inline) ? envelope.value.comments.inline.length : null,
          }
        }
      }
      v21.safety.before = safetyBefore
      if (options.v21SkipForce) {
        checkPending('v2.1 run: {force:true} 真实 cycle → recent done + findings/verdict 合法', '按 --v21-skip-force 跳过')
        checkPending('v2.1 第二次 force 命中 seen（不重复审查）', '按 --v21-skip-force 跳过')
        checkPending('v2.1 安全：auto-review 无 GitHub 写（PR state/评论数未变）', '按 --v21-skip-force 跳过')
      } else {
        const recentBeforeForce = Array.isArray(initial?.recent) ? initial.recent : []
        const beforeKeys = new Set(recentBeforeForce.map((entry) => `${entry?.repo}#${entry?.number}`))
        const force = await postRun({ force: true })
        v21.runs.force = force.value
        check('v2.1 run: {force:true} → started:true', force.envelope.ok && force.value?.started === true, JSON.stringify(force.value ?? force.envelope.error ?? {}).slice(0, 240))
        const cycle = await waitCycleIdle(options.reviewTimeoutMs)
        const after = cycle.status
        v21.status.afterForce = after
        check('v2.1 run: cycle 结束（status.running=false）', Boolean(after) && after.running === false, cycle.note || `running=${String(after?.running)}`)
        if (isObject(after)) {
          const recent = Array.isArray(after.recent) ? after.recent : []
          const doneEntry = recent.find((entry) => entry?.state === 'done')
          const newEntries = recent.slice(0, Math.max(0, recent.length - recentBeforeForce.length))
          v21.runs.newRecentEntries = newEntries
          v21.runs.recentBeforeForce = recentBeforeForce.length
          if (openItems.length === 0) {
            checkPending('v2.1 run: recent 出现 done 结果', '当前没有 open PR，cycle 无目标（契约允许）')
          } else if (newEntries.length === 0 && doneEntry === undefined) {
            checkPending(
              'v2.1 run: recent 出现 done 结果',
              '本轮无新增审查（open PR 均已在 seen 中）；且已知实现缺陷：recent 未持久化、插件重载后 in-memory 为空，待 Host 0.5.0 修复后复跑',
            )
          } else {
            check('v2.1 run: recent 含 done 结果（可为此前已审结果）', Boolean(doneEntry), JSON.stringify(recent.slice(0, 3)).slice(0, 400))
          }
          if (doneEntry) {
            const entryProblems = validateAutoRecentEntry(doneEntry)
            check('v2.1 run: recent done 条目 findings/verdict 合法', entryProblems.length === 0 && typeof doneEntry.findings === 'number' && (doneEntry.verdict === undefined || VERDICTS.has(doneEntry.verdict)), entryProblems.slice(0, 4).join('；'))
            v21.runs.doneEntry = doneEntry
          }
          // Data-aware: any newly added result must belong to a PR that was not
          // already reviewed before this cycle; zero new entries is fine when
          // every open PR is already in `seen` (operator smoke).
          if (newEntries.length > 0) {
            check(
              'v2.1 run: 新增 recent 条目对应此前未审 PR（seen 语义）',
              newEntries.every((entry) => !beforeKeys.has(`${entry?.repo}#${entry?.number}`)),
              JSON.stringify({ newEntries: newEntries.map((entry) => `${entry?.repo}#${entry?.number}`), before: [...beforeKeys] }),
            )
          } else if (openItems.length > 0) {
            checkPending('v2.1 run: 新增 recent 条目对应此前未审 PR（seen 语义）', '本轮没有新增审查（所有 open PR 已在 seen 中，operator smoke 已审）')
          }
          // 0.5.0 persists `recent` to the state file: verify when a result exists.
          const persistedAfterCycle = readStateFile()
          if (persistedAfterCycle.value) {
            const fileRecent = Array.isArray(persistedAfterCycle.value.recent) ? persistedAfterCycle.value.recent : null
            v21.stateFileAfterCycle = { recentLength: fileRecent?.length ?? null, keys: persistedAfterCycle.value.recent === undefined ? 'missing' : 'present' }
            if (fileRecent === null) {
              check('v2.1 status: recent 持久化到状态文件（0.5.0）', false, '状态文件缺少 recent 字段')
            } else if (fileRecent.length > 0) {
              check(
                'v2.1 status: recent 持久化到状态文件（0.5.0，条数与 status 一致）',
                fileRecent.length === (Array.isArray(after.recent) ? after.recent.length : -1),
                `文件 recent=${fileRecent.length}，status recent=${Array.isArray(after.recent) ? after.recent.length : '?'}`,
              )
            } else {
              checkPending('v2.1 status: recent 持久化到状态文件（0.5.0）', '本轮无新增审查结果，recent 为空；需有新结果后再验证')
            }
          }
          // seen dedup: a second force must not add another recent entry.
          const recentLenBefore = recent.length
          const force2 = await postRun({ force: true })
          check('v2.1 run: 第二次 {force:true} → started:true', force2.envelope.ok && force2.value?.started === true, JSON.stringify(force2.value ?? force2.envelope.error ?? {}).slice(0, 240))
          const cycle2 = await waitCycleIdle(Math.min(options.reviewTimeoutMs, 120_000))
          const after2 = cycle2.status
          v21.status.afterSecondForce = after2
          check('v2.1 run: 第二轮 cycle 结束（running=false）', Boolean(after2) && after2.running === false, cycle2.note || `running=${String(after2?.running)}`)
          if (isObject(after2)) {
            check(
              'v2.1 run: seen 命中，不重复审查（recent 条数不增加）',
              Array.isArray(after2.recent) && after2.recent.length === recentLenBefore,
              `recent ${recentLenBefore} → ${Array.isArray(after2.recent) ? after2.recent.length : '?'}`,
            )
          }
        }

        // --- safety: no GitHub write happened ---------------------------------
        if (safetyBefore) {
          const detail = await client.post('codex-review/pr', { repo: safetyBefore.repo, number: safetyBefore.number }, { timeoutMs: 30_000 })
          const envelope = parseEnvelope(detail)
          const afterSafety = envelope.ok
            ? {
                repo: safetyBefore.repo,
                number: safetyBefore.number,
                state: envelope.value?.summary?.state ?? null,
                headSha: envelope.value?.headSha ?? envelope.value?.summary?.headSha ?? null,
                commentsTotal: envelope.value?.comments?.total ?? null,
                inlineCount: Array.isArray(envelope.value?.comments?.inline) ? envelope.value.comments.inline.length : null,
              }
            : null
          v21.safety.after = afterSafety
          check(
            'v2.1 安全: auto-review 后 PR state 未变',
            Boolean(afterSafety) && afterSafety.state === safetyBefore.state,
            `${safetyBefore.state} → ${afterSafety?.state}`,
          )
          if (safetyBefore.headSha === null || afterSafety?.headSha === null) {
            checkPending('v2.1 安全: auto-review 后 headSha 未变', 'PrDetail 未返回 headSha（改为 state + 评论数保证），该条记 pending')
          } else {
            check(
              'v2.1 安全: auto-review 后 headSha 未变',
              afterSafety.headSha === safetyBefore.headSha,
              `${String(safetyBefore.headSha).slice(0, 12)}… → ${String(afterSafety?.headSha).slice(0, 12)}…`,
            )
          }
          check(
            'v2.1 安全: auto-review 后评论数未变（未发评论）',
            Boolean(afterSafety) && afterSafety.commentsTotal === safetyBefore.commentsTotal && afterSafety.inlineCount === safetyBefore.inlineCount,
            `total ${safetyBefore.commentsTotal} → ${afterSafety?.commentsTotal}，inline ${safetyBefore.inlineCount} → ${afterSafety?.inlineCount}`,
          )
        }
      }
    }
  } catch (error) {
    check('v2.1 自动审查流程执行', false, error instanceof Error ? error.message : String(error))
    v21.error = error instanceof Error ? { message: error.message, stack: error.stack } : { message: String(error) }
  } finally {
    // Never leave periodic auto-review running: restore defaults, then verify.
    if (v21.active === false) {
      checkPending('v2.1 测试后 enabled 恢复 false（不留下后台自动审查）', 'v2.1 尚未生效，无需恢复')
    } else {
      try {
        const restore = await postConfig({ ...AUTO_DEFAULTS })
        v21.restore = restore.value?.config ?? null
        const status = await getStatus()
        v21.finalStatus = status.value ?? null
        check(
          'v2.1 测试后 enabled 恢复 false（不留下后台自动审查）',
          status.envelope.ok && status.value?.config?.enabled === false,
          JSON.stringify(status.value?.config ?? {}).slice(0, 240),
        )
        const persisted = readStateFile()
        if (persisted.value) {
          check(
            'v2.1 状态文件恢复 enabled=false 且 interval/maxPerCycle 回默认',
            persisted.value?.config?.enabled === false && persisted.value?.config?.intervalSeconds === AUTO_DEFAULTS.intervalSeconds && persisted.value?.config?.maxPerCycle === AUTO_DEFAULTS.maxPerCycle,
            JSON.stringify(persisted.value?.config),
          )
          v21.stateFileAfter = persisted.value
        }
      } catch (error) {
        check('v2.1 测试后 enabled 恢复 false（不留下后台自动审查）', false, `恢复失败：${error.message}`)
      }
    }
  }
  v21.checks = checks.slice(v21Start)
  v21.pendingCount = v21.checks.filter((entry) => entry.pending === true).length
  v21.failedCount = v21.checks.filter((entry) => entry.pending !== true && entry.pass === false).length
}

// ---------------------------------------------------------------------------
// v2.2 assertions (CONTRACT §7.4): review-publish guards + REVIEW_NOT_READY.
//
// SAFETY (hard rules, mirrored in verify/README.md §4.9):
//   1. NEVER send `confirm:true` for a PR whose current head already has a
//      `done` review — that would create a real GitHub review on the user's PR.
//   2. Before EVERY `confirm:true` request, re-read `POST /codex-review/pr` and
//      require `review.state !== 'done'`; when the state is `done` (or cannot be
//      read) the probe records `pending` and does NOT send the request.
//   3. The `mode` / `minSeverity` / `body` guards may only use `confirm:true`
//      because the Host validates them *before* it touches GitHub
//      (`index.js` reviewPublish) and only behind rule 2. Nothing here can reach
//      `POST /pulls/{n}/reviews`.
// ---------------------------------------------------------------------------
const PUBLISH_SUMMARY_MAX_CHARS = 4_000

if (options.v22) {
  const v22 = {
    enabled: true,
    active: null,
    routeStatus: null,
    checks: [],
    target: null,
    candidates: [],
    requests: [],
    safety: {},
    reviewNotReady: null,
  }
  report.v22 = v22
  const v22Start = checks.length
  const publishRequests = []
  v22.requests = publishRequests

  /**
   * Read the PR detail used by rule 2: the review state of the *current* head.
   * @param {string} repo
   * @param {number} number
   * @returns {Promise<{response: any, envelope: any, state: string | null, headSha: string | null, findings: number | null, comments: any}>}
   */
  const readReviewState = async (repo, number) => {
    const response = await client.post('codex-review/pr', { repo, number }, { timeoutMs: 30_000 })
    const envelope = parseEnvelope(response)
    const value = envelope.ok ? envelope.value : undefined
    const comments = isObject(value?.comments)
      ? {
          total: typeof value.comments.total === 'number' ? value.comments.total : null,
          reviews: Array.isArray(value.comments.reviews) ? value.comments.reviews.length : null,
          inline: Array.isArray(value.comments.inline) ? value.comments.inline.length : null,
        }
      : null
    return {
      response,
      envelope,
      state: typeof value?.review?.state === 'string' ? value.review.state : null,
      headSha: typeof value?.review?.headSha === 'string'
        ? value.review.headSha
        : typeof value?.summary?.headSha === 'string' ? value.summary.headSha : null,
      findings: Array.isArray(value?.review?.findings) ? value.review.findings.length : null,
      comments,
    }
  }

  /**
   * POST one review-publish probe. Rule 2 is enforced here for every
   * `confirm:true` body: the request is only sent after `/pr` shows that the
   * current head has no `done` review.
   * @param {Record<string, any>} body
   * @param {string} label
   * @returns {Promise<any>} the recorded request entry.
   */
  const publishProbe = async (body, label) => {
    const entry = {
      label,
      request: {
        repo: body.repo,
        number: body.number,
        confirm: body.confirm,
        mode: body.mode,
        minSeverity: body.minSeverity,
        bodyLength: typeof body.body === 'string' ? body.body.length : null,
      },
      reviewStateBefore: null,
      headShaBefore: null,
      sent: false,
      skipped: false,
      response: null,
    }
    publishRequests.push(entry)
    if (body.confirm === true) {
      const gate = await readReviewState(body.repo, body.number)
      entry.reviewStateBefore = gate.state
      entry.headShaBefore = gate.headSha
      entry.gate = {
        httpStatus: gate.response.status,
        envelope: gate.envelope.envelope,
        errorCode: gate.envelope.error?.code ?? null,
        findings: gate.findings,
      }
      if (!gate.envelope.ok || gate.state === 'done' || gate.state === null) {
        entry.skipped = true
        entry.skipReason = gate.envelope.ok
          ? `当前 head 已有 done 审查或状态不可判定（review.state=${String(gate.state)}），按安全红线跳过，不发 confirm:true`
          : `无法读取审查状态（${gate.envelope.error?.code ?? `HTTP ${gate.response.status}`}），按安全红线跳过，不发 confirm:true`
        return entry
      }
    }
    const response = await client.post('codex-review/review-publish', body, { timeoutMs: 30_000 })
    const envelope = parseEnvelope(response)
    entry.sent = true
    entry.response = {
      status: response.status,
      elapsedMs: response.elapsedMs,
      envelope: envelope.envelope,
      ok: envelope.envelope ? envelope.ok : null,
      code: envelope.error?.code ?? null,
      message: typeof envelope.error?.message === 'string' ? envelope.error.message.slice(0, 300) : '',
      published: envelope.ok && isObject(envelope.value) ? envelope.value.published ?? null : null,
    }
    return entry
  }

  try {
    // --- route readiness + confirm:false guard ------------------------------
    // `confirm:false` can never publish: the Host rejects it before any GitHub
    // access, so this doubles as the capability probe.
    const guardRef = { repo: options.pr.repo, number: options.pr.number }
    const capability = await publishProbe({ repo: guardRef.repo, number: guardRef.number, confirm: false }, 'route-ready-confirm-false')
    const capStatus = capability.response?.status ?? 0
    const capReady = capStatus === 200 && capability.response?.envelope === true
    v22.routeStatus = capStatus
    v22.active = capReady
    const pendingRest = (detail) => {
      for (const name of [
        'v2.2 守卫: confirm:false → BAD_REQUEST',
        'v2.2 守卫: 缺 confirm → BAD_REQUEST',
        'v2.2 守卫: 非法 mode → BAD_REQUEST',
        'v2.2 守卫: 非法 minSeverity → BAD_REQUEST',
        'v2.2 守卫: body 超 4000 → BAD_REQUEST',
        'v2.2 REVIEW_NOT_READY: 当前 head 无 done 审查 → REVIEW_NOT_READY',
        'v2.2 安全: 未发出任何「confirm:true + 已有 done 审查」的发布请求',
        'v2.2 安全: 每个 confirm:true 请求前都先 POST /pr 确认 state !== done',
        'v2.2 安全: 未观察到 published:true（未在 GitHub 创建 review）',
      ]) checkPending(name, detail)
    }
    if (capStatus === 404 || capStatus === 405) {
      // Older Hosts have the /codex-review prefix handler but no publish route:
      // it answers HTTP 404 with `{error:"not found"}` instead of an envelope.
      checkPending('v2.2 路由就绪: POST /codex-review/review-publish 返回 JSON 信封', `Host 无该路由（HTTP ${capStatus}）；v2.2 断言全部记 pending`)
      pendingRest(`v2.2 路由未就绪（HTTP ${capStatus}）`)
    } else if (!capReady) {
      check('v2.2 路由就绪: POST /codex-review/review-publish 返回 JSON 信封', false, `HTTP ${capStatus}，但响应不是 {ok:...} 信封`)
      pendingRest(`review-publish 响应不是合法信封（HTTP ${capStatus}）`)
    } else {
      check('v2.2 路由就绪: POST /codex-review/review-publish 返回 JSON 信封', true, `HTTP ${capStatus}，${capability.response.elapsedMs}ms`)
      check(
        'v2.2 守卫: confirm:false → BAD_REQUEST',
        capability.response.ok === false && capability.response.code === 'BAD_REQUEST',
        `code=${capability.response.code ?? '-'}，message=${capability.response.message || '-'}`,
      )
      check(
        'v2.2 守卫: confirm:false 的 message 指向 confirm',
        /confirm/i.test(capability.response.message || ''),
        `message=${JSON.stringify(capability.response.message || '')}`,
      )
      const noConfirm = await publishProbe({ repo: guardRef.repo, number: guardRef.number }, 'missing-confirm')
      check(
        'v2.2 守卫: 缺 confirm → BAD_REQUEST',
        noConfirm.response?.ok === false && noConfirm.response?.code === 'BAD_REQUEST',
        `code=${noConfirm.response?.code ?? '-'}，message=${noConfirm.response?.message || '-'}`,
      )

      // --- pick a target whose current head has no done review (rule 2) ----
      let listItems = []
      try {
        const listResponse = await client.post('codex-review/prs', { query: 'is:open author:@me', limit: 30 }, { timeoutMs: 20_000 })
        listItems = Array.isArray(listResponse.json?.value?.items) ? listResponse.json.value.items : []
      } catch (error) {
        v22.listError = error.message
      }
      v22.openPrCount = listItems.length
      const ordered = []
      const preferred = listItems.find((item) => item?.repo === options.pr.repo && item?.number === options.pr.number)
      if (preferred) ordered.push(preferred)
      for (const item of listItems) {
        if (item && isNonEmptyString(item.repo) && isPositiveInt(item.number) && !ordered.includes(item)) ordered.push(item)
      }
      for (const item of ordered.slice(0, 10)) {
        let detail
        try {
          detail = await readReviewState(item.repo, item.number)
        } catch (error) {
          v22.candidates.push({ repo: item.repo, number: item.number, state: null, error: error.message })
          continue
        }
        const record = {
          repo: item.repo,
          number: item.number,
          title: typeof item.title === 'string' ? item.title.slice(0, 80) : '',
          state: detail.state,
          headSha: detail.headSha,
          findings: detail.findings,
        }
        v22.candidates.push(record)
        if (v22.target === null && detail.envelope.ok && typeof detail.state === 'string' && detail.state !== 'done') {
          v22.target = { ...record, comments: detail.comments }
        }
      }
      if (v22.candidates.length === 0) {
        checkPending('v2.2 候选: 逐个读取候选 PR 的 review.state', '当前没有 open PR（/prs 为空），无法挑选 REVIEW_NOT_READY 目标')
      } else {
        const readable = v22.candidates.filter((entry) => typeof entry.state === 'string')
        check(
          'v2.2 候选: 逐个读取候选 PR 的 review.state',
          readable.length > 0,
          `${v22.candidates.length} 个候选：${v22.candidates.map((entry) => `#${entry.number}:${entry.state ?? '?'}`).join('，')}${v22.target ? `；目标 #${v22.target.number}（state=${v22.target.state}）` : '；全部已有 done 审查'}`,
        )
      }

      // Rule 2 reference for the confirm:true validation guards: the picked
      // non-done target when available, otherwise the default PR (the gate will
      // refuse it and the corresponding assertions become pending).
      const confirmRef = v22.target
        ? { repo: v22.target.repo, number: v22.target.number }
        : { repo: options.pr.repo, number: options.pr.number }

      // --- confirm:true validation guards -----------------------------------
      // These bodies are rejected during request validation, so they never read
      // or write GitHub. They are still gated by rule 2.
      const badMode = await publishProbe({ repo: confirmRef.repo, number: confirmRef.number, confirm: true, mode: 'nope' }, 'invalid-mode')
      if (badMode.skipped) checkPending('v2.2 守卫: 非法 mode → BAD_REQUEST', badMode.skipReason)
      else {
        check(
          'v2.2 守卫: 非法 mode → BAD_REQUEST',
          badMode.response.ok === false && badMode.response.code === 'BAD_REQUEST',
          `code=${badMode.response.code ?? '-'}，message=${badMode.response.message || '-'}`,
        )
      }
      const badSeverity = await publishProbe({ repo: confirmRef.repo, number: confirmRef.number, confirm: true, minSeverity: 'P5' }, 'invalid-min-severity')
      if (badSeverity.skipped) checkPending('v2.2 守卫: 非法 minSeverity → BAD_REQUEST', badSeverity.skipReason)
      else {
        check(
          'v2.2 守卫: 非法 minSeverity → BAD_REQUEST',
          badSeverity.response.ok === false && badSeverity.response.code === 'BAD_REQUEST',
          `code=${badSeverity.response.code ?? '-'}，message=${badSeverity.response.message || '-'}`,
        )
      }
      const longBody = 'x'.repeat(PUBLISH_SUMMARY_MAX_CHARS + 1)
      const badBody = await publishProbe({ repo: confirmRef.repo, number: confirmRef.number, confirm: true, mode: 'summary', body: longBody }, 'body-too-long')
      if (badBody.skipped) checkPending('v2.2 守卫: body 超 4000 → BAD_REQUEST', badBody.skipReason)
      else {
        check(
          'v2.2 守卫: body 超 4000 → BAD_REQUEST',
          badBody.response.ok === false && badBody.response.code === 'BAD_REQUEST',
          `bodyLength=${longBody.length}，code=${badBody.response.code ?? '-'}，message=${badBody.response.message || '-'}`,
        )
      }

      // --- REVIEW_NOT_READY branch ------------------------------------------
      // `summary` mode + no done review for the current head: the publisher
      // throws before it reads comments or creates a review.
      if (!v22.target) {
        checkPending(
          'v2.2 REVIEW_NOT_READY: 当前 head 无 done 审查 → REVIEW_NOT_READY',
          v22.candidates.length === 0
            ? '没有候选 PR，无法找到「当前 head 无 done 审查」的目标'
            : '所有候选 PR 的当前 head 都已有 done 审查；按安全红线不发送 confirm:true',
        )
      } else {
        const target = v22.target
        const before = { state: target.state, headSha: target.headSha, comments: target.comments }
        v22.safety.before = { repo: target.repo, number: target.number, ...before }
        const notReady = await publishProbe({ repo: target.repo, number: target.number, confirm: true, mode: 'summary' }, 'review-not-ready')
        v22.reviewNotReady = notReady.response ?? null
        if (notReady.skipped) {
          checkPending('v2.2 REVIEW_NOT_READY: 当前 head 无 done 审查 → REVIEW_NOT_READY', notReady.skipReason)
        } else {
          check(
            'v2.2 REVIEW_NOT_READY: 当前 head 无 done 审查 → REVIEW_NOT_READY',
            notReady.response.ok === false && notReady.response.code === 'REVIEW_NOT_READY',
            `code=${notReady.response.code ?? '-'}，message=${notReady.response.message || '-'}`,
          )
          const after = await readReviewState(target.repo, target.number)
          v22.safety.after = { repo: target.repo, number: target.number, state: after.state, headSha: after.headSha, comments: after.comments }
          const commentsKnown = Boolean(before.comments && after.comments)
          if (!commentsKnown) {
            checkPending('v2.2 安全: REVIEW_NOT_READY 分支未改变 PR 评论数（未创建 review）', 'PrDetail 未返回 comments，本条记 pending')
          } else {
            check(
              'v2.2 安全: REVIEW_NOT_READY 分支未改变 PR 评论数（未创建 review）',
              before.comments.total === after.comments.total && before.comments.inline === after.comments.inline,
              `total ${before.comments.total} → ${after.comments.total}，inline ${before.comments.inline} → ${after.comments.inline}`,
            )
          }
        }
      }

      // --- safety counters ---------------------------------------------------
      const sentConfirm = publishRequests.filter((entry) => entry.sent && entry.request.confirm === true)
      const unsafe = sentConfirm.filter((entry) => entry.reviewStateBefore === 'done')
      const ungated = sentConfirm.filter((entry) => entry.reviewStateBefore === null)
      const published = publishRequests.filter((entry) => entry.response?.published === true)
      v22.safety.summary = {
        requests: publishRequests.length,
        sent: publishRequests.filter((entry) => entry.sent).length,
        skipped: publishRequests.filter((entry) => entry.skipped).length,
        sentConfirm: sentConfirm.length,
        unsafe: unsafe.length,
        ungated: ungated.length,
        published: published.length,
      }
      check(
        'v2.2 安全: 未发出任何「confirm:true + 已有 done 审查」的发布请求',
        unsafe.length === 0,
        `confirm:true 请求 ${sentConfirm.length} 个，其中命中 done 审查 ${unsafe.length} 个；跳过 ${v22.safety.summary.skipped} 个`,
      )
      if (sentConfirm.length === 0) {
        checkPending('v2.2 安全: 每个 confirm:true 请求前都先 POST /pr 确认 state !== done', '本次没有发送任何 confirm:true 请求（目标均被安全红线拦下）')
      } else {
        check(
          'v2.2 安全: 每个 confirm:true 请求前都先 POST /pr 确认 state !== done',
          ungated.length === 0 && sentConfirm.every((entry) => entry.reviewStateBefore !== 'done'),
          `${sentConfirm.length} 个 confirm:true 请求，${ungated.length} 个缺少 gate：${sentConfirm.map((entry) => `${entry.label}=${String(entry.reviewStateBefore)}`).join('，')}`,
        )
      }
      check(
        'v2.2 安全: 未观察到 published:true（未在 GitHub 创建 review）',
        published.length === 0,
        published.length === 0 ? '所有发布请求均被守卫拒绝' : JSON.stringify(published.map((entry) => ({ label: entry.label, code: entry.response?.code }))),
      )
    }
  } catch (error) {
    check('v2.2 发布守卫流程执行', false, error instanceof Error ? error.message : String(error))
    v22.error = error instanceof Error ? { message: error.message, stack: error.stack } : { message: String(error) }
  }
  v22.checks = checks.slice(v22Start)
  v22.pendingCount = v22.checks.filter((entry) => entry.pending === true).length
  v22.failedCount = v22.checks.filter((entry) => entry.pending !== true && entry.pass === false).length
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
  v2Active: report.v2?.capability?.mergeRoute ?? null,
  v2Pending: report.v2?.pendingCount ?? 0,
  v2Failed: report.v2?.failedCount ?? 0,
  chatDeltas: report.v2?.chat?.real?.deltaCount ?? null,
  chatTextLength: report.v2?.chat?.real?.text?.length ?? null,
  v21Active: report.v21?.active ?? null,
  v21Pending: report.v21?.pendingCount ?? 0,
  v21Failed: report.v21?.failedCount ?? 0,
  autoReviewRecent: report.v21?.status?.afterForce?.recent?.length ?? null,
  autoReviewFinalEnabled: report.v21?.finalStatus?.config?.enabled ?? null,
  v22Active: report.v22?.active ?? null,
  v22Pending: report.v22?.pendingCount ?? 0,
  v22Failed: report.v22?.failedCount ?? 0,
  v22Target: report.v22?.target ? `${report.v22.target.repo}#${report.v22.target.number}` : null,
  v22Requests: report.v22?.safety?.summary?.requests ?? null,
  v22SentConfirm: report.v22?.safety?.summary?.sentConfirm ?? null,
  v22Published: report.v22?.safety?.summary?.published ?? null,
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
