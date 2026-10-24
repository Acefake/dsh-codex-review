/**
 * Unit tests for the browser half of dsh-codex-review.
 *
 * `plugin/client.js` is a module-loader bundle, not an ES module, so the tests
 * load it through `plugin/dev/loader-stub.mjs` (a tiny React stand-in) and then
 * assert two things:
 *   1. the bundle/registration contract from CONTRACT.md §2 (id, inject, slots);
 *   2. the pure helpers exposed on `__test` (diff parsing, markdown tokenizing,
 *      relative time, severity ordering, host-payload normalization).
 *
 * Run: node --test plugin/test/
 */
// Non-strict deepEqual on purpose: objects created inside the vm sandbox have a
// foreign Object prototype, and strict deep equality would reject them on identity.
import assert from 'node:assert'
import test from 'node:test'
import {
  EXPECTED_ID,
  PLATFORM_MODULES,
  createFakeCtx,
  listRequiredModules,
  loadPlugin,
} from '../dev/loader-stub.mjs'

const loaded = loadPlugin()
const api = loaded.plugin.__test

// ---------------------------------------------------------------------------
// bundle + registration contract
// ---------------------------------------------------------------------------

test('client bundle registers exactly one module-loader definition', () => {
  assert.equal(loaded.definitions.length, 1)
  assert.equal(loaded.definition.id, EXPECTED_ID)
  assert.equal(loaded.definition.id, 'dsh-codex-review')
  assert.equal(typeof loaded.definition.factory, 'function')
})

test('source is a classic script: no ESM syntax, no JSX, no innerHTML', () => {
  assert.ok(loaded.source.trimStart().startsWith('window.__ModuleLoader__.load({'))
  assert.ok(!/^\s*(import|export)\s/m.test(loaded.source), 'bundle must not use ESM syntax')
  assert.ok(!loaded.source.includes('dangerouslySetInnerHTML'))
  assert.ok(!/React\.createClass/.test(loaded.source))
  assert.ok(!/document\.querySelector/.test(loaded.source), 'must not read foreign DOM')
})

test('only platform-table modules are required', () => {
  const required = listRequiredModules(loaded.source)
  assert.deepEqual(required, ['react'])
  for (const name of required) assert.ok(PLATFORM_MODULES.has(name), `${name} is not a platform module`)
  for (const name of loaded.requireCalls) assert.ok(PLATFORM_MODULES.has(name))
})

test('plugin exports inject/apply/__test with the documented inject list', () => {
  assert.deepEqual(loaded.plugin.inject, ['slots', 'locale'])
  assert.equal(typeof loaded.plugin.apply, 'function')
  assert.equal(typeof api, 'object')
})

test('apply() registers the sidebar icon and the keyed main panel', () => {
  const fake = createFakeCtx()
  loaded.plugin.apply(fake.ctx)

  assert.deepEqual(fake.effects, ['codex-review: locale'])
  assert.equal(fake.localeRegistrations.length, 1)
  assert.equal(fake.localeRegistrations[0].namespace, 'codex-review')
  assert.equal(typeof fake.localeRegistrations[0].dictionaries.en, 'object')
  assert.equal(typeof fake.localeRegistrations[0].dictionaries.zh, 'object')

  assert.equal(fake.registrations.length, 2)
  const panel = fake.registrations[0].options
  assert.equal(panel.name, 'sidebar.panellist')
  assert.equal(panel.id, 'codex-review')
  assert.equal(panel.order, 5)
  assert.equal(panel.locale, 'codex-review')
  assert.equal(typeof panel.label, 'function')
  assert.equal(panel.label(), '代码审查')

  const main = fake.registrations[1].options
  assert.equal(main.name, 'main')
  assert.equal(main.key, 'codex-review')
  assert.equal(main.locale, 'codex-review')
  assert.equal(main.key, panel.id, 'main.key must equal sidebar.panellist.id')

  // Both components are plain functions that render without throwing.
  assert.equal(typeof fake.registrations[0].component, 'function')
  assert.equal(fake.registrations[0].component({ size: 18, active: false }).type, 'svg')
  assert.equal(typeof fake.registrations[1].component, 'function')
  assert.equal(typeof fake.registrations[1].component({ size: 18, active: false }).type, 'function')
})

test('locale dictionaries cover every literal t() key and match each other', () => {
  const { en, zh } = api.locales
  const missing = (dict) =>
    Object.keys(zh).filter((key) => !Object.prototype.hasOwnProperty.call(dict, key))
  assert.deepEqual(missing(en), [])
  assert.deepEqual(
    Object.keys(en).filter((key) => !Object.prototype.hasOwnProperty.call(zh, key)),
    [],
  )
  // Every literal key passed through tx(t, '...') must exist in both dictionaries.
  const used = new Set()
  for (const match of loaded.source.matchAll(/tx\(\s*t\s*,\s*'([A-Za-z0-9]+)'/g)) used.add(match[1])
  for (const key of ['summary', 'changes', 'open', 'closed', 'merged', 'draft', 'panel']) used.add(key)
  for (const key of used) {
    assert.ok(Object.prototype.hasOwnProperty.call(zh, key), `zh is missing "${key}"`)
    assert.ok(Object.prototype.hasOwnProperty.call(en, key), `en is missing "${key}"`)
  }
})

// ---------------------------------------------------------------------------
// formatting helpers
// ---------------------------------------------------------------------------

test('formatNumber adds thousands separators', () => {
  assert.equal(api.formatNumber(2117), '2,117')
  assert.equal(api.formatNumber(0), '0')
  assert.equal(api.formatNumber('12000'), '12,000')
  assert.equal(api.formatNumber(-5), '-5')
  assert.equal(api.formatNumber(undefined), '0')
  assert.equal(api.formatNumber('nope'), '0')
})

test('truncateMiddle keeps both branch-name ends', () => {
  assert.equal(api.truncateMiddle('feat/intro-detect', 60), 'feat/intro-detect')
  const short = api.truncateMiddle('feat/intro-detect-very-long', 12)
  assert.equal(short.length <= 12, true)
  assert.ok(short.startsWith('feat/'))
  assert.ok(short.endsWith('long'))
  assert.ok(short.includes('…'))
  assert.equal(api.truncateMiddle('', 10), '')
  assert.equal(api.truncateMiddle(null, 10), '')
})

test('relativeTime handles now/minutes/hours/days/dates and bad input', () => {
  const now = Date.parse('2026-10-24T12:00:00Z')
  assert.deepEqual(api.relativeTime('2026-10-24T11:59:40Z', now), { unit: 'now', value: 0 })
  assert.deepEqual(api.relativeTime('2026-10-24T11:55:00Z', now), { unit: 'minute', value: 5 })
  assert.deepEqual(api.relativeTime('2026-10-24T09:00:00Z', now), { unit: 'hour', value: 3 })
  assert.deepEqual(api.relativeTime('2026-10-22T12:00:00Z', now), { unit: 'day', value: 2 })
  const old = api.relativeTime('2026-01-01T00:00:00Z', now)
  assert.equal(old.unit, 'date')
  assert.equal(api.relativeTime('not-a-date', now), null)
  assert.equal(api.relativeTime(undefined, now), null)
})

test('formatRelative renders the locale template', () => {
  const t = (key) => api.locales.zh[key]
  assert.equal(api.formatRelative({ unit: 'now', value: 0 }, t), '刚刚')
  assert.equal(api.formatRelative({ unit: 'minute', value: 5 }, t), '5 分钟前')
  assert.equal(api.formatRelative({ unit: 'hour', value: 2 }, t), '2 小时前')
  assert.equal(api.formatRelative({ unit: 'day', value: 3 }, t), '3 天前')
  assert.equal(api.formatRelative({ unit: 'date', value: Date.parse('2026-01-02T00:00:00Z') }, t), '2026-01-02')
  assert.equal(api.formatRelative(null, t), '')
})

// ---------------------------------------------------------------------------
// findings
// ---------------------------------------------------------------------------

test('sortFindings orders P0 > P1 > P2, then file, then line', () => {
  const input = [
    { id: 'c', severity: 'P2', file: 'b.ts', line: 9 },
    { id: 'd', severity: 'P1', file: 'b.ts', line: 42 },
    { id: 'a', severity: 'P0', file: 'z.ts', line: 1 },
    { id: 'b', severity: 'P1', file: 'a.ts', line: 7 },
    { id: 'e', severity: 'P2', file: 'a.ts', line: 2 },
  ]
  const sorted = api.sortFindings(input)
  assert.deepEqual(sorted.map((item) => item.id), ['a', 'b', 'd', 'e', 'c'])
  assert.deepEqual(input.map((item) => item.id), ['c', 'd', 'a', 'b', 'e'], 'input must not be mutated')
  assert.deepEqual(api.sortFindings(undefined), [])
  assert.deepEqual(api.sortFindings([{ id: 'x', severity: 'weird' }]).map((item) => item.id), ['x'])
})

test('countSeverities and deriveVerdict map severities to v1.1 verdicts', () => {
  const findings = [
    { severity: 'P0' },
    { severity: 'P1' },
    { severity: 'P2' },
    { severity: 'P2' },
    { severity: 'unknown' },
  ]
  assert.deepEqual(api.countSeverities(findings), { P0: 1, P1: 1, P2: 2 })
  assert.deepEqual(api.countSeverities([]), { P0: 0, P1: 0, P2: 0 })
  assert.equal(api.deriveVerdict(findings), 'block')
  assert.equal(api.deriveVerdict([{ severity: 'P1' }]), 'changes')
  assert.equal(api.deriveVerdict([{ severity: 'P2' }]), 'approve')
  assert.equal(api.deriveVerdict([]), 'approve')
})

test('groupFindingsByFile buckets findings per path', () => {
  const grouped = api.groupFindingsByFile([
    { file: 'a.ts', line: 1 },
    { file: 'a.ts', line: 9 },
    { file: 'b.ts', line: 2 },
    null,
    { line: 3 },
  ])
  assert.equal(grouped['a.ts'].length, 2)
  assert.equal(grouped['b.ts'].length, 1)
  assert.equal(Object.keys(grouped).length, 2)
  assert.deepEqual(api.groupFindingsByFile(undefined), {})
})

// ---------------------------------------------------------------------------
// unified diff
// ---------------------------------------------------------------------------

test('parseHunkHeader reads both count forms', () => {
  assert.deepEqual(api.parseHunkHeader('@@ -0,0 +1,159 @@'), {
    oldStart: 0,
    oldCount: 0,
    newStart: 1,
    newCount: 159,
  })
  assert.deepEqual(api.parseHunkHeader('@@ -5 +7 @@'), {
    oldStart: 5,
    oldCount: 1,
    newStart: 7,
    newCount: 1,
  })
  assert.equal(api.parseHunkHeader('+not a hunk'), null)
  assert.equal(api.parseHunkHeader(''), null)
})

test('parseUnifiedDiff types rows and tracks old/new line numbers', () => {
  const patch = [
    '@@ -10,3 +10,4 @@ export function x() {',
    ' const a = 1',
    '-const b = 2',
    '+const b = 3',
    '+const c = 4',
    ' return a',
  ].join('\n')
  const rows = api.parseUnifiedDiff(patch)
  assert.deepEqual(
    rows.map((row) => row.type),
    ['hunk', 'ctx', 'del', 'add', 'add', 'ctx'],
  )
  const ctx = rows[1]
  assert.equal(ctx.oldLine, 10)
  assert.equal(ctx.newLine, 10)
  const del = rows[2]
  assert.equal(del.oldLine, 11)
  assert.equal(del.newLine, null)
  assert.equal(del.text, 'const b = 2')
  const add = rows[3]
  assert.equal(add.oldLine, null)
  assert.equal(add.newLine, 11)
  assert.equal(add.text, 'const b = 3')
  assert.equal(rows[4].newLine, 12)
  assert.equal(rows[5].oldLine, 12)
  assert.equal(rows[5].newLine, 13)
})

test('parseUnifiedDiff tolerates empty patches and no-newline markers', () => {
  assert.deepEqual(api.parseUnifiedDiff(''), [])
  assert.deepEqual(api.parseUnifiedDiff(undefined), [])
  const rows = api.parseUnifiedDiff('@@ -1 +1 @@\n-a\n+b\n\\ No newline at end of file')
  assert.deepEqual(rows.map((row) => row.type), ['hunk', 'del', 'add', 'meta'])
})

// ---------------------------------------------------------------------------
// markdown
// ---------------------------------------------------------------------------

test('tokenizeMarkdown handles headings, paragraphs, quotes, rules and fences', () => {
  const blocks = api.tokenizeMarkdown(
    [
      '# Big heading',
      '',
      '第一段',
      '第二行',
      '',
      '## 做了什么',
      '',
      '> 引用内容',
      '> 第二行引用',
      '',
      '---',
      '',
      '```ts',
      'const a = 1',
      '```',
    ].join('\n'),
  )
  assert.deepEqual(
    blocks.map((block) => block.type),
    ['h2', 'p', 'h2', 'quote', 'hr', 'code'],
  )
  assert.equal(blocks[0].text, 'Big heading')
  assert.equal(blocks[1].text, '第一段\n第二行')
  assert.equal(blocks[3].text, '引用内容\n第二行引用')
  assert.equal(blocks[5].lang, 'ts')
  assert.equal(blocks[5].text, 'const a = 1')
})

test('tokenizeMarkdown parses ordered lists and nested bullets with depth', () => {
  const blocks = api.tokenizeMarkdown(
    [
      '1. 第一项',
      '   - 嵌套 a',
      '   - 嵌套 b',
      '2. 第二项',
      '',
      '- 顶层',
    ].join('\n'),
  )
  assert.equal(blocks.length, 2)
  assert.equal(blocks[0].type, 'list')
  assert.deepEqual(
    blocks[0].items.map((item) => [item.marker, item.number, item.depth, item.text]),
    [
      ['number', 1, 0, '第一项'],
      ['bullet', null, 1, '嵌套 a'],
      ['bullet', null, 1, '嵌套 b'],
      ['number', 2, 0, '第二项'],
    ],
  )
  assert.equal(blocks[1].items[0].depth, 0)
})

test('tokenizeInline finds code, bold, italic and links', () => {
  assert.deepEqual(api.tokenizeInline('a `x = 1` b'), [
    { type: 'text', text: 'a ' },
    { type: 'code', text: 'x = 1' },
    { type: 'text', text: ' b' },
  ])
  assert.deepEqual(api.tokenizeInline('**粗**'), [{ type: 'strong', text: '粗' }])
  assert.deepEqual(api.tokenizeInline('*斜*'), [{ type: 'em', text: '斜' }])
  assert.deepEqual(api.tokenizeInline('[文档](https://example.com)'), [
    { type: 'link', text: '文档', href: 'https://example.com' },
  ])
  // Unclosed markers stay literal text (no crash, no swallowed characters).
  assert.deepEqual(api.tokenizeInline('a ` b'), [{ type: 'text', text: 'a ` b' }])
  assert.deepEqual(api.tokenizeInline(''), [])
})

// ---------------------------------------------------------------------------
// host payload normalization (real Host may send [], "none", or missing blocks)
// ---------------------------------------------------------------------------

test('normalizePrDetail fills every optional block', () => {
  const detail = api.normalizePrDetail({ summary: { number: 7, title: 'x' } })
  assert.deepEqual(detail.summary, { number: 7, title: 'x' })
  assert.equal(detail.body, '')
  assert.deepEqual(detail.files, [])
  assert.deepEqual(detail.comments, { total: 0, issue: [], reviews: [], inline: [] })
  assert.deepEqual(detail.checks, { state: 'none', items: [] })
  assert.deepEqual(detail.stack.chain, [])
  assert.equal(detail.review.state, 'none')
  assert.deepEqual(detail.review.findings, [])
})

test('normalizePrDetail tolerates [] / "none" / null for optional blocks', () => {
  const detail = api.normalizePrDetail({
    summary: { number: 1 },
    body: null,
    files: null,
    comments: [],
    checks: 'none',
    stack: [],
    review: null,
  })
  assert.deepEqual(detail.comments, { total: 0, issue: [], reviews: [], inline: [] })
  assert.deepEqual(detail.checks, { state: 'none', items: [] })
  assert.deepEqual(detail.stack.chain, [])
  assert.equal(detail.review.state, 'none')

  const withArrayComments = api.normalizePrDetail({ comments: [{ author: 'a', body: 'b' }] })
  assert.equal(withArrayComments.comments.issue.length, 1)
  assert.equal(withArrayComments.comments.total, 1)

  const withChecks = api.normalizePrDetail({
    checks: [{ name: 'build', state: 'failure' }],
  })
  assert.equal(withChecks.checks.state, 'failure')
  assert.equal(withChecks.checks.items.length, 1)

  const withStackChain = api.normalizePrDetail({
    stack: [{ number: 117, title: 'base', state: 'open' }],
  })
  assert.equal(withStackChain.stack.chain.length, 1)
  assert.equal(withStackChain.stack.chain[0].number, 117)
})

test('prStateKey maps summary flags to badge keys', () => {
  assert.equal(api.prStateKey(null), 'open')
  assert.equal(api.prStateKey({ state: 'open', isDraft: false }), 'open')
  assert.equal(api.prStateKey({ state: 'closed' }), 'closed')
  assert.equal(api.prStateKey({ state: 'open', isDraft: true }), 'draft')
  assert.equal(api.prStateKey({ state: 'merged' }), 'merged')
})

// ---------------------------------------------------------------------------
// v1.1 review options + settings persistence (localStorage['codex-review:settings'])
// ---------------------------------------------------------------------------

function memoryStorage(initial) {
  const data = { ...(initial || {}) }
  return {
    data,
    getItem(key) {
      return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null
    },
    setItem(key, value) {
      data[key] = String(value)
    },
  }
}

test('normalizeSettings clamps garbage to contract defaults', () => {
  assert.deepEqual(api.normalizeSettings(null), {
    depth: 'standard',
    severityThreshold: 'P2',
    includeGuidelines: true,
  })
  assert.deepEqual(api.normalizeSettings('nope'), api.DEFAULT_SETTINGS)
  assert.deepEqual(api.normalizeSettings({ depth: 'ultra', severityThreshold: 'P9' }), api.DEFAULT_SETTINGS)
  assert.deepEqual(api.normalizeSettings({ depth: 'deep', severityThreshold: 'P0', includeGuidelines: false }), {
    depth: 'deep',
    severityThreshold: 'P0',
    includeGuidelines: false,
  })
  assert.deepEqual(api.normalizeSettings({ includeGuidelines: 0 }), {
    depth: 'standard',
    severityThreshold: 'P2',
    includeGuidelines: false,
  })
  assert.equal(api.hasSettingsFields({ depth: 'fast' }), true)
  assert.equal(api.hasSettingsFields({ chunkChars: 9000 }), false)
  assert.equal(api.hasSettingsFields(null), false)
})

test('readSettings/writeSettings round-trip through a storage-like object', () => {
  const storage = memoryStorage()
  assert.deepEqual(api.readSettings(storage), api.DEFAULT_SETTINGS)
  assert.equal(api.writeSettings(storage, { depth: 'fast', severityThreshold: 'P1', includeGuidelines: false }), true)
  assert.equal(storage.data[api.SETTINGS_KEY], JSON.stringify({ depth: 'fast', severityThreshold: 'P1', includeGuidelines: false }))
  assert.deepEqual(api.readSettings(storage), {
    depth: 'fast',
    severityThreshold: 'P1',
    includeGuidelines: false,
  })
  // Corrupt JSON / throwing storage degrades to defaults, never throws.
  storage.setItem(api.SETTINGS_KEY, '{not json')
  assert.deepEqual(api.readSettings(storage), api.DEFAULT_SETTINGS)
  const throwing = {
    getItem() {
      throw new Error('blocked')
    },
    setItem() {
      throw new Error('blocked')
    },
  }
  assert.deepEqual(api.readSettings(throwing), api.DEFAULT_SETTINGS)
  assert.equal(api.writeSettings(throwing, api.DEFAULT_SETTINGS), false)
  assert.deepEqual(api.readSettings(null), api.DEFAULT_SETTINGS)
  assert.equal(api.writeSettings(null, api.DEFAULT_SETTINGS), false)
  assert.equal(api.localStore(), null, 'no localStorage in the sandbox')
})

test('settingsToOptions keeps exactly the review-start option fields', () => {
  assert.deepEqual(api.settingsToOptions({ depth: 'deep', severityThreshold: 'P1', includeGuidelines: false }), {
    depth: 'deep',
    severityThreshold: 'P1',
    includeGuidelines: false,
  })
  assert.deepEqual(api.settingsToOptions(undefined), {
    depth: 'standard',
    severityThreshold: 'P2',
    includeGuidelines: true,
  })
})

test('normalizeReviewOptions handles resolved echo and missing budgets', () => {
  assert.deepEqual(api.normalizeReviewOptions(undefined), {
    depth: 'standard',
    severityThreshold: 'P2',
    includeGuidelines: true,
    chunkChars: 0,
    maxChunks: 0,
    concurrency: 0,
  })
  const resolved = api.normalizeReviewOptions({
    depth: 'deep',
    severityThreshold: 'P0',
    includeGuidelines: true,
    chunkChars: 6000,
    maxChunks: 20,
    concurrency: 2,
  })
  assert.equal(resolved.depth, 'deep')
  assert.equal(resolved.chunkChars, 6000)
  assert.equal(resolved.maxChunks, 20)
  assert.equal(resolved.concurrency, 2)
  assert.equal(resolved.severityThreshold, 'P0')
})

test('normalizeGuidelines tolerates missing / empty reports', () => {
  assert.deepEqual(api.normalizeGuidelines(null), { loaded: false, files: [], chars: 0 })
  assert.deepEqual(api.normalizeGuidelines({ loaded: true, files: ['AGENTS.md', ''], chars: 3240.4 }), {
    loaded: true,
    files: ['AGENTS.md'],
    chars: 3240,
  })
  assert.deepEqual(api.normalizeGuidelines({ loaded: 'yes' }), { loaded: true, files: [], chars: 0 })
})

// ---------------------------------------------------------------------------
// v1.1 findings: extras, inline grouping, filtering, verdict echo
// ---------------------------------------------------------------------------

test('normalizeFinding keeps v1.1 evidence/confidence and degrades gracefully', () => {
  const full = api.normalizeFinding({
    id: 'f1',
    severity: 'P1',
    file: 'a.ts',
    line: 92,
    lineEnd: 94,
    title: 't',
    why: 'w',
    fix: 'fx',
    category: 'performance',
    evidence: '+const a = 1',
    confidence: 'high',
  })
  assert.equal(full.evidence, '+const a = 1')
  assert.equal(full.confidence, 'high')
  assert.equal(full.lineEnd, 94)

  const old = api.normalizeFinding({ severity: 'weird', file: 'b.ts', line: -3, confidence: 'certain' })
  assert.equal(old.severity, 'P2')
  assert.equal(old.line, null)
  assert.equal(old.lineEnd, null)
  assert.equal(old.evidence, '')
  assert.equal(old.confidence, '')
  assert.equal(old.title, '')
  const longEvidence = api.normalizeFinding({ severity: 'P0', evidence: 'x'.repeat(500) })
  assert.equal(longEvidence.evidence.length, 240)
})

test('normalizeReviewStatus fills v1.1 fields and keeps old payloads working', () => {
  const legacy = api.normalizeReviewStatus({ state: 'done', findings: [{ severity: 'P2', file: 'a', line: 1 }] })
  assert.equal(legacy.state, 'done')
  assert.equal(legacy.findings.length, 1)
  assert.equal(legacy.findings[0].severity, 'P2')
  assert.equal(legacy.verdict, null)
  assert.equal(legacy.options, null)
  assert.equal(legacy.guidelines, null)
  assert.equal(legacy.reusedFiles, 0)
  assert.equal(legacy.cached, false)

  const v11 = api.normalizeReviewStatus({
    state: 'done',
    verdict: 'changes',
    reusedFiles: 5,
    cached: true,
    options: { depth: 'deep', severityThreshold: 'P0', includeGuidelines: true, chunkChars: 6000, maxChunks: 20, concurrency: 2 },
    guidelines: { loaded: true, files: ['AGENTS.md'], chars: 3000 },
    findings: [{ severity: 'P1', evidence: 'x', confidence: 'medium' }],
  })
  assert.equal(v11.verdict, 'changes')
  assert.equal(v11.reusedFiles, 5)
  assert.equal(v11.cached, true)
  assert.equal(v11.options.depth, 'deep')
  assert.equal(v11.guidelines.loaded, true)
  assert.equal(v11.findings[0].confidence, 'medium')
  assert.equal(api.normalizeReviewStatus({ state: 'done', verdict: 'nonsense' }).verdict, null)
  assert.equal(api.normalizeReviewStatus(null).state, 'none')
})

test('reviewVerdict prefers the host verdict and falls back to findings', () => {
  assert.equal(api.reviewVerdict({ verdict: 'block', findings: [] }), 'block')
  assert.equal(api.reviewVerdict({ verdict: 'approve', findings: [{ severity: 'P0' }] }), 'approve')
  assert.equal(api.reviewVerdict({ findings: [{ severity: 'P1' }] }), 'changes')
  assert.equal(api.reviewVerdict({ findings: [] }), 'approve')
  assert.equal(api.reviewVerdict(null), 'approve')
})

test('groupFindingsByLine buckets findings per file and line', () => {
  const grouped = api.groupFindingsByLine([
    { file: 'a.ts', line: 3 },
    { file: 'a.ts', line: 3 },
    { file: 'a.ts', line: 9 },
    { file: 'b.ts', line: 3 },
    { file: 'c.ts', line: null },
    null,
  ])
  assert.equal(grouped['a.ts'][3].length, 2)
  assert.equal(grouped['a.ts'][9].length, 1)
  assert.equal(grouped['b.ts'][3].length, 1)
  assert.equal(Object.prototype.hasOwnProperty.call(grouped, 'c.ts'), false)
  assert.deepEqual(api.groupFindingsByLine(undefined), {})
})

test('filterFindings and stepSelection drive the review card + keyboard', () => {
  const findings = [{ severity: 'P0' }, { severity: 'P1' }, { severity: 'P2' }, { severity: 'P2' }]
  assert.equal(api.filterFindings(findings, 'all').length, 4)
  assert.equal(api.filterFindings(findings, 'P1').length, 1)
  assert.equal(api.filterFindings(findings, 'P2').length, 2)
  assert.deepEqual(api.filterFindings(findings, 'P0'), [{ severity: 'P0' }])
  assert.deepEqual(api.filterFindings(undefined, 'P0'), [])

  const items = [{ number: 3 }, { number: 7 }, { number: 129 }]
  assert.equal(api.stepSelection(items, 7, 1).number, 129)
  assert.equal(api.stepSelection(items, 129, 1).number, 3, 'wraps forward')
  assert.equal(api.stepSelection(items, 3, -1).number, 129, 'wraps backward')
  assert.equal(api.stepSelection(items, 99, 1).number, 3, 'unknown current -> first')
  assert.equal(api.stepSelection(items, 99, -1).number, 129, 'unknown current -> last going back')
  assert.equal(api.stepSelection([], 1, 1), null)
})

test('locale key helpers map enum values to t() keys', () => {
  assert.equal(api.depthKey('fast'), 'depthFast')
  assert.equal(api.depthKey('deep'), 'depthDeep')
  assert.equal(api.depthKey('weird'), 'depthStandard')
  assert.equal(api.thresholdKey('P0'), 'thresholdP0')
  assert.equal(api.thresholdKey('P1'), 'thresholdP1')
  assert.equal(api.thresholdKey('P2'), 'thresholdP2')
  assert.equal(api.verdictKey('block'), 'verdictBlock')
  assert.equal(api.verdictKey('changes'), 'verdictChanges')
  assert.equal(api.verdictKey('approve'), 'verdictApprove')
  assert.equal(api.verdictHintKey('block'), 'verdictBlockHint')
  assert.equal(api.confidenceKey('high'), 'confidenceHigh')
  assert.equal(api.confidenceKey('low'), 'confidenceLow')
  assert.equal(api.confidenceKey(''), '')
  const options = api.describeReviewOptions({ depth: 'fast', severityThreshold: 'P1' })
  assert.equal(options.depth, 'fast')
  assert.equal(options.severityThreshold, 'P1')
  for (const key of [
    'depthFast',
    'depthStandard',
    'depthDeep',
    'thresholdP0',
    'thresholdP1',
    'thresholdP2',
    'verdictBlock',
    'verdictChanges',
    'verdictApprove',
    'verdictBlockHint',
    'verdictChangesHint',
    'verdictApproveHint',
    'confidenceHigh',
    'confidenceMedium',
    'confidenceLow',
  ]) {
    assert.equal(typeof api.locales.zh[key], 'string', `zh is missing ${key}`)
    assert.equal(typeof api.locales.en[key], 'string', `en is missing ${key}`)
  }
})

// ---------------------------------------------------------------------------
// v1.1 existing GitHub inline comments
// ---------------------------------------------------------------------------

test('normalizeInlineComments drops unusable entries and fills defaults', () => {
  const list = api.normalizeInlineComments([
    { path: 'a.ts', line: 12, body: 'hi', author: 'bob', createdAt: '2026-10-24T04:01:00Z' },
    { path: 'a.ts', line: null, body: 'file level' },
    { line: 3, body: 'no path' },
    null,
    'nope',
  ])
  assert.equal(list.length, 2)
  assert.equal(list[0].line, 12)
  assert.equal(list[1].line, null)
  assert.equal(list[1].author, 'unknown')
  assert.deepEqual(api.normalizeInlineComments(undefined), [])
})

test('groupCommentsByFile separates line comments from file-level ones', () => {
  const grouped = api.groupCommentsByFile([
    { path: 'a.ts', line: 12, body: 'x' },
    { path: 'a.ts', line: 12, body: 'y' },
    { path: 'a.ts', line: null, body: 'general' },
    { path: 'b.ts', line: 7, body: 'z' },
  ])
  assert.equal(grouped['a.ts'].lines[12].length, 2)
  assert.equal(grouped['a.ts'].general.length, 1)
  assert.equal(grouped['b.ts'].lines[7].length, 1)
  assert.equal(Object.keys(grouped).length, 2)
})

test('truncateText caps comment bodies at the 400-char preview', () => {
  assert.deepEqual(api.truncateText('short', 400), { text: 'short', truncated: false })
  const long = api.truncateText('x'.repeat(500), 400)
  assert.equal(long.truncated, true)
  assert.equal(long.text.length, 400)
  assert.ok(long.text.endsWith('…'))
  assert.deepEqual(api.truncateText('a'.repeat(400), 400), { text: 'a'.repeat(400), truncated: false })
  assert.equal(api.truncateText(null, 10).text, '')
})

test('normalizePrDetail carries the v1.1 review extras and options', () => {
  const detail = api.normalizePrDetail({
    summary: { number: 129 },
    comments: { total: 1, inline: [{ path: 'a.ts', line: 3, body: 'c', author: 'x', createdAt: '' }] },
    review: {
      state: 'done',
      verdict: 'changes',
      reusedFiles: 4,
      options: { depth: 'fast', severityThreshold: 'P1', includeGuidelines: false, chunkChars: 16000, maxChunks: 6, concurrency: 4 },
      guidelines: { loaded: false, files: [], chars: 0 },
      findings: [{ severity: 'P1', file: 'a.ts', line: 3, evidence: '+x', confidence: 'low' }],
    },
  })
  assert.equal(detail.review.verdict, 'changes')
  assert.equal(detail.review.reusedFiles, 4)
  assert.equal(detail.review.options.depth, 'fast')
  assert.equal(detail.review.guidelines.loaded, false)
  assert.equal(detail.review.findings[0].confidence, 'low')
  assert.equal(detail.comments.inline.length, 1)
})

// ---------------------------------------------------------------------------
// transport envelope
// ---------------------------------------------------------------------------

test('post() decodes ok/error envelopes and never throws', async () => {
  loaded.sandbox.fetch = async () => ({
    json: async () => ({ ok: true, value: { gh: 'ok' } }),
  })
  assert.deepEqual(await api.post('codex-review/health', {}), { ok: true, value: { gh: 'ok' } })

  loaded.sandbox.fetch = async () => ({
    json: async () => ({ ok: false, error: { code: 'GH_MISSING', message: 'no gh' } }),
  })
  assert.deepEqual(await api.post('codex-review/prs', { query: 'x' }), {
    ok: false,
    error: { code: 'GH_MISSING', message: 'no gh' },
  })

  loaded.sandbox.fetch = async () => ({
    json: async () => ({ unexpected: true }),
  })
  const malformed = await api.post('codex-review/prs', {})
  assert.equal(malformed.ok, false)
  assert.equal(malformed.error.code, 'INTERNAL')

  loaded.sandbox.fetch = async () => ({
    json: async () => {
      throw new Error('not json')
    },
  })
  assert.equal((await api.post('codex-review/prs', {})).ok, false)

  loaded.sandbox.fetch = async () => {
    throw new Error('offline')
  }
  const offline = await api.post('codex-review/prs', {})
  assert.equal(offline.ok, false)
  assert.match(offline.error.message, /宿主路由/)
})
