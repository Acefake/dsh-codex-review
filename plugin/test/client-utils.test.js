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
  loadBundle,
  createReactStub,
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

  assert.equal(fake.registrations.length, 3)
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

  const settingsSection = fake.registrations[2].options
  assert.equal(settingsSection.name, 'settings.section')
  assert.equal(settingsSection.id, 'codex-review')
  assert.equal(settingsSection.order, 60)
  assert.equal(typeof settingsSection.label, 'function')
  assert.equal(typeof fake.registrations[2].component, 'function')
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

test('normalizeInlineComments keeps the write identifiers used by reply/resolve', () => {
  const list = api.normalizeInlineComments([
    { id: 11, inReplyToId: 10, threadId: 'THREAD_1', isResolved: true, path: 'a.ts', line: 3, body: 'x' },
    { id: 'nope', threadId: 42, isResolved: 1, path: 'a.ts', line: null, body: 'y' },
  ])
  assert.equal(list[0].id, 11)
  assert.equal(list[0].inReplyToId, 10)
  assert.equal(list[0].threadId, 'THREAD_1')
  assert.equal(list[0].isResolved, true)
  assert.equal(list[1].id, null)
  assert.equal(list[1].inReplyToId, null)
  assert.equal(list[1].threadId, '')
  assert.equal(list[1].isResolved, false)
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
// v2: merge guards + request body (CONTRACT §5.1 / §5.3)
// ---------------------------------------------------------------------------

test('mergeAvailability gates the merge button on state / draft / merged', () => {
  assert.deepEqual(api.mergeAvailability({ state: 'open', isDraft: false }), { enabled: true, reason: '' })
  assert.deepEqual(api.mergeAvailability({ state: 'open', isDraft: true }), { enabled: false, reason: 'draft' })
  assert.deepEqual(api.mergeAvailability({ state: 'closed' }), { enabled: false, reason: 'closed' })
  assert.deepEqual(api.mergeAvailability({ state: 'open', merged: true }), { enabled: false, reason: 'merged' })
  assert.deepEqual(api.mergeAvailability({ state: 'merged' }), { enabled: false, reason: 'merged' })
  assert.deepEqual(api.mergeAvailability({ state: 'open', mergedAt: '2026-10-24T00:00:00Z' }), {
    enabled: false,
    reason: 'merged',
  })
  assert.deepEqual(api.mergeAvailability(null), { enabled: false, reason: 'unavailable' })
})

test('resolveHeadSha prefers the detail payload then summary/review', () => {
  assert.equal(api.resolveHeadSha({ headSha: 'abc123def456' }), 'abc123def456')
  assert.equal(api.resolveHeadSha({ summary: { headSha: 'def456' } }), 'def456')
  assert.equal(api.resolveHeadSha({ review: { headSha: 'aaa111' } }), 'aaa111')
  assert.equal(api.resolveHeadSha({ headSha: '', summary: { headSha: 'bbb222' } }), 'bbb222')
  assert.equal(api.resolveHeadSha(null), '')
  assert.equal(api.resolveHeadSha({}), '')
})

test('shortSha trims to the dialog width', () => {
  assert.equal(api.shortSha('abcdef1234567890', 7), 'abcdef1')
  assert.equal(api.shortSha('abcdef1234567890'), 'abcdef1')
  assert.equal(api.shortSha('  abc  ', 7), 'abc')
  assert.equal(api.shortSha('', 7), '')
  assert.equal(api.shortSha(null, 7), '')
  assert.equal(api.shortSha('abcdef', 3), 'abc')
})

test('normalizeMergeMethod whitelists squash/merge/rebase', () => {
  assert.equal(api.normalizeMergeMethod('squash'), 'squash')
  assert.equal(api.normalizeMergeMethod('merge'), 'merge')
  assert.equal(api.normalizeMergeMethod('rebase'), 'rebase')
  assert.equal(api.normalizeMergeMethod('fast-forward'), 'squash')
  assert.equal(api.normalizeMergeMethod(undefined), 'squash')
  assert.deepEqual(api.MERGE_METHODS, ['squash', 'merge', 'rebase'])
})

test('buildMergeRequest emits the guarded write body', () => {
  const request = api.buildMergeRequest({
    summary: { repo: 'Acefake/yingbox', number: 129 },
    headSha: 'f31cec5c712d88c5f26bb0e6fcbf2e09e3954585',
    method: 'rebase',
    deleteBranch: true,
  })
  assert.deepEqual(request, {
    repo: 'Acefake/yingbox',
    number: 129,
    method: 'rebase',
    expectedHeadSha: 'f31cec5c712d88c5f26bb0e6fcbf2e09e3954585',
    deleteBranch: true,
    confirm: true,
  })
  const defaults = api.buildMergeRequest({
    summary: { repo: 'Acefake/yingbox', number: 129 },
    headSha: 'abc',
  })
  assert.equal(defaults.method, 'squash')
  assert.equal(defaults.deleteBranch, false)
  assert.equal(defaults.confirm, true)
  assert.equal(Object.prototype.hasOwnProperty.call(defaults, 'commitTitle'), false)

  const withTitle = api.buildMergeRequest({
    summary: { repo: 'Acefake/yingbox', number: 129 },
    headSha: 'abc',
    commitTitle: 'x'.repeat(400),
    commitMessage: 'y'.repeat(2500),
  })
  assert.equal(withTitle.commitTitle.length, 256)
  assert.equal(withTitle.commitMessage.length, 2000)

  // Missing repo / number / head sha must never send a half-formed write.
  assert.equal(api.buildMergeRequest({ summary: { number: 1 }, headSha: 'abc' }), null)
  assert.equal(api.buildMergeRequest({ summary: { repo: 'a/b' }, headSha: 'abc' }), null)
  assert.equal(api.buildMergeRequest({ summary: { repo: 'a/b', number: 1 }, headSha: '' }), null)
  assert.equal(api.buildMergeRequest(null), null)
})

test('mergeErrorKey maps host error codes to locale keys', () => {
  assert.equal(api.mergeErrorKey('MERGE_HEAD_MOVED'), 'mergeHeadMoved')
  assert.equal(api.mergeErrorKey('MERGE_CONFLICT'), 'mergeConflict')
  assert.equal(api.mergeErrorKey('MERGE_NOT_ALLOWED'), 'mergeNotAllowed')
  assert.equal(api.mergeErrorKey('GH_FORBIDDEN'), 'mergeForbidden')
  assert.equal(api.mergeErrorKey('GH_NOT_FOUND'), 'mergeNotFound')
  assert.equal(api.mergeErrorKey('BAD_REQUEST'), 'mergeBadRequest')
  assert.equal(api.mergeErrorKey('INTERNAL'), '')
  assert.equal(api.mergeErrorKey(null), '')
})

// ---------------------------------------------------------------------------
// v2: chat SSE parser + per-PR history (CONTRACT §5.2)
// ---------------------------------------------------------------------------

test('createSseParser reads multiple data frames in one chunk', () => {
  const parser = api.createSseParser()
  const events = parser.push(
    'data: {"delta":"你好"}\n\ndata: {"delta":"，世界"}\n\ndata: {"done":true,"model":{"provider":"p","model":"m"}}\n\n',
  )
  assert.equal(events.length, 3)
  assert.deepEqual(events[0], { type: 'delta', text: '你好' })
  assert.deepEqual(events[1], { type: 'delta', text: '，世界' })
  assert.equal(events[2].type, 'done')
  assert.equal(events[2].model.model, 'm')
})

test('createSseParser buffers frames split across chunks', () => {
  const parser = api.createSseParser()
  assert.deepEqual(parser.push('data: {"delta":"he'), [])
  assert.equal(parser.pending, 'data: {"delta":"he')
  assert.deepEqual(parser.push('llo"}\n'), [])
  const events = parser.push('\n')
  assert.deepEqual(events, [{ type: 'delta', text: 'hello' }])
  assert.equal(parser.pending, '')
})

test('createSseParser tolerates CRLF, comments and garbage frames', () => {
  const parser = api.createSseParser()
  const events = parser.push(
    ': keep-alive\r\n\r\ndata: {"delta":"a"}\r\n\r\ndata: not-json\n\ndata: {"delta":"b"}\n\n',
  )
  assert.deepEqual(events, [
    { type: 'delta', text: 'a' },
    { type: 'invalid' },
    { type: 'delta', text: 'b' },
  ])
  assert.deepEqual(parser.push(''), [])
})

test('createSseParser surfaces error frames and flush() emits trailing frames', () => {
  const failing = api.createSseParser()
  const errorEvents = failing.push('data: {"error":{"code":"BUSY","message":"忙"}}\n\n')
  assert.equal(errorEvents.length, 1)
  assert.equal(errorEvents[0].type, 'error')
  assert.equal(errorEvents[0].error.code, 'BUSY')

  const parser = api.createSseParser()
  assert.deepEqual(parser.push('data: {"delta":"tail"}'), [])
  assert.deepEqual(parser.flush(), [{ type: 'delta', text: 'tail' }])
  assert.deepEqual(parser.flush(), [])

  const doneOnly = api.createSseParser()
  assert.deepEqual(doneOnly.push('data: [DONE]\n\n'), [{ type: 'done', model: null, usage: null }])
})

test('normalizeChatHistory keeps valid turns and caps at 20', () => {
  assert.deepEqual(api.normalizeChatHistory(undefined), [])
  assert.deepEqual(api.normalizeChatHistory('nope'), [])
  const messages = api.normalizeChatHistory([
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
    { role: 'system', content: 'drop' },
    { role: 'user', content: '   ' },
    { role: 'assistant', content: 'ok' },
    null,
    'raw',
  ])
  assert.deepEqual(messages, [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
    { role: 'assistant', content: 'ok' },
  ])
  const many = []
  for (let index = 0; index < 30; index += 1) {
    many.push({ role: index % 2 === 0 ? 'user' : 'assistant', content: 'm' + index })
  }
  const capped = api.normalizeChatHistory(many)
  assert.equal(capped.length, api.CHAT_HISTORY_LIMIT)
  assert.equal(capped[0].content, 'm10')
  assert.equal(capped[capped.length - 1].content, 'm29')
})

test('chatHistoryKey / readChatHistory / writeChatHistory are per-PR and never throw', () => {
  assert.equal(api.chatHistoryKey('Acefake/yingbox', 129), 'codex-review:chat:Acefake/yingbox#129')
  assert.equal(api.chatHistoryKey('', 129), '')
  assert.equal(api.chatHistoryKey('a/b', 'nope'), '')
  assert.equal(api.chatHistoryKey('a/b', undefined), '')
  assert.equal(api.CHAT_KEY_PREFIX, 'codex-review:chat:')

  const storage = memoryStorage()
  assert.deepEqual(api.readChatHistory(storage, 'a/b', 1), [])
  assert.equal(
    api.writeChatHistory(storage, 'a/b', 1, [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a' },
    ]),
    true,
  )
  assert.deepEqual(api.readChatHistory(storage, 'a/b', 1), [
    { role: 'user', content: 'q' },
    { role: 'assistant', content: 'a' },
  ])
  assert.deepEqual(api.readChatHistory(storage, 'a/b', 2), [], 'history is isolated per PR')
  storage.setItem('codex-review:chat:a/b#1', '{broken')
  assert.deepEqual(api.readChatHistory(storage, 'a/b', 1), [])
  const throwing = {
    getItem() {
      throw new Error('blocked')
    },
    setItem() {
      throw new Error('blocked')
    },
  }
  assert.deepEqual(api.readChatHistory(throwing, 'a/b', 1), [])
  assert.equal(api.writeChatHistory(throwing, 'a/b', 1, [{ role: 'user', content: 'q' }]), false)
  assert.equal(api.writeChatHistory(null, 'a/b', 1, []), false)
})

test('chatRequestMessages keeps the last 10 turns and caps each at 4000 chars', () => {
  const messages = []
  for (let index = 0; index < 14; index += 1) {
    messages.push({ role: index % 2 === 0 ? 'user' : 'assistant', content: 'm' + index })
  }
  messages.push({ role: 'user', content: 'x'.repeat(5000) })
  const request = api.chatRequestMessages(messages)
  assert.equal(request.length, api.CHAT_REQUEST_MESSAGES)
  assert.equal(request[request.length - 1].role, 'user')
  assert.equal(request[request.length - 1].content.length, api.CHAT_MESSAGE_CHARS)
  assert.deepEqual(api.chatRequestMessages(undefined), [])
})

test('applyChatDelta only touches the trailing assistant bubble', () => {
  const base = [
    { role: 'user', content: 'q' },
    { role: 'assistant', content: 'he' },
  ]
  const next = api.applyChatDelta(base, 'llo')
  assert.equal(next[1].content, 'hello')
  assert.equal(base[1].content, 'he', 'input must not be mutated')
  assert.deepEqual(api.applyChatDelta([{ role: 'user', content: 'q' }], 'x'), [
    { role: 'user', content: 'q' },
  ])
  assert.deepEqual(api.applyChatDelta([], 'x'), [])
  assert.deepEqual(api.applyChatDelta(undefined, 'x'), [])
})

test('chat settle helpers drop empty answers, flag stops and find the last user turn', () => {
  const pending = [
    { role: 'user', content: 'q' },
    { role: 'assistant', content: '' },
  ]
  assert.deepEqual(api.dropEmptyAssistant(pending), [{ role: 'user', content: 'q' }])
  assert.deepEqual(api.settleChatMessages(pending), [{ role: 'user', content: 'q' }])
  assert.deepEqual(api.settleChatMessages([{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a', stopped: true }]), [
    { role: 'user', content: 'q' },
    { role: 'assistant', content: 'a' },
  ])
  const stopped = api.markChatStopped([
    { role: 'user', content: 'q' },
    { role: 'assistant', content: 'partial' },
  ])
  assert.equal(stopped[1].stopped, true)
  assert.deepEqual(api.markChatStopped(pending), [{ role: 'user', content: 'q' }])
  assert.deepEqual(api.chatLastUserMessage([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }]), {
    role: 'user',
    content: 'c',
  })
  assert.equal(api.chatLastUserMessage([{ role: 'assistant', content: 'b' }]), null)
  assert.equal(api.chatLastUserMessage(undefined), null)
})

// ---------------------------------------------------------------------------
// transport envelope
// ---------------------------------------------------------------------------

test('streamPost decodes SSE deltas/done and degrades on JSON or network errors', async () => {
  loaded.sandbox.TextDecoder = TextDecoder
  const chunks = [
    'data: {"delta":"你"}\n\ndata: {"delta":"好"}\n\n',
    'data: {"done":true,"model":{"provider":"p","model":"m"}}\n\n',
  ].map((text) => new Uint8Array(Buffer.from(text, 'utf8')))
  let index = 0
  const events = []
  loaded.sandbox.fetch = async () => ({
    ok: true,
    headers: { get: () => 'text/event-stream; charset=utf-8' },
    body: {
      getReader() {
        return {
          async read() {
            if (index >= chunks.length) return { done: true }
            const value = chunks[index]
            index += 1
            return { done: false, value }
          },
          releaseLock() {},
        }
      },
    },
  })
  const result = await api.streamPost(
    'codex-review/chat',
    { repo: 'a/b', number: 1 },
    { onEvent: (event) => events.push(event) },
  )
  assert.equal(result.ok, true)
  assert.equal(result.done.type, 'done')
  assert.deepEqual(
    events.filter((event) => event.type === 'delta').map((event) => event.text),
    ['你', '好'],
  )

  // Old Host / missing route answers with the JSON envelope instead of a stream.
  loaded.sandbox.fetch = async () => ({
    ok: false,
    headers: { get: () => 'application/json' },
    json: async () => ({ ok: false, error: { code: 'GH_NOT_FOUND', message: '没有这个路由' } }),
  })
  const legacy = await api.streamPost('codex-review/chat', {}, {})
  assert.equal(legacy.ok, false)
  assert.equal(legacy.error.code, 'GH_NOT_FOUND')

  loaded.sandbox.fetch = async () => {
    throw new Error('offline')
  }
  const offline = await api.streamPost('codex-review/chat', {}, {})
  assert.equal(offline.ok, false)
  assert.equal(offline.error.code, 'INTERNAL')
})

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

// ---------------------------------------------------------------------------
// v2.1: auto review config/status, polling decision, recent diff, badges
// ---------------------------------------------------------------------------

test('normalizeAutoReviewConfig clamps and defaults every field', () => {
  assert.deepEqual(api.normalizeAutoReviewConfig(null), api.AUTO_REVIEW_DEFAULT)
  assert.deepEqual(api.normalizeAutoReviewConfig('nope'), api.AUTO_REVIEW_DEFAULT)
  const clamped = api.normalizeAutoReviewConfig({
    enabled: 1,
    intervalSeconds: 5,
    query: '  is:closed author:@me  ',
    depth: 'ultra',
    severityThreshold: 'P9',
    includeDrafts: 'yes',
    maxPerCycle: 99,
    unknown: 'ignored',
  })
  assert.equal(clamped.enabled, true)
  assert.equal(clamped.intervalSeconds, api.AUTO_REVIEW_INTERVAL_MIN)
  assert.equal(clamped.query, 'is:closed author:@me')
  assert.equal(clamped.depth, 'fast')
  assert.equal(clamped.severityThreshold, 'P2')
  assert.equal(clamped.includeDrafts, true)
  assert.equal(clamped.maxPerCycle, api.AUTO_REVIEW_MAX_PER_CYCLE_MAX)
  assert.equal(Object.prototype.hasOwnProperty.call(clamped, 'unknown'), false)

  const upper = api.normalizeAutoReviewConfig({
    intervalSeconds: 99999,
    maxPerCycle: 0,
    depth: 'deep',
    severityThreshold: 'P1',
    includeDrafts: false,
  })
  assert.equal(upper.intervalSeconds, api.AUTO_REVIEW_INTERVAL_MAX)
  assert.equal(upper.maxPerCycle, 1)
  assert.equal(upper.depth, 'deep')
  assert.equal(upper.severityThreshold, 'P1')
  assert.equal(upper.includeDrafts, false)
  assert.equal(api.clampInteger('nope', 1, 5, 2), 2)
  assert.equal(api.clampInteger(3.6, 1, 5, 2), 4)
})

test('normalizeAutoReviewRecent filters, sorts by field and caps at 20', () => {
  assert.deepEqual(api.normalizeAutoReviewRecent(undefined), [])
  const list = api.normalizeAutoReviewRecent([
    { repo: 'a/b', number: 1, state: 'done', findings: 3, finishedAt: 100, verdict: 'changes' },
    { repo: 'a/b', number: 2, state: 'error', error: { code: 'LLM_ERROR', message: 'boom' }, finishedAt: 90 },
    { repo: '', number: 3 },
    { repo: 'a/b', number: 'x' },
    null,
  ])
  assert.equal(list.length, 2)
  assert.equal(list[0].findings, 3)
  assert.equal(list[0].verdict, 'changes')
  assert.equal(list[1].state, 'error')
  assert.equal(list[1].error.code, 'LLM_ERROR')
  assert.equal(api.normalizeAutoReviewRecentEntry({ repo: 'a/b', number: 1, findings: -2 }).findings, 0)
  assert.equal(api.normalizeAutoReviewRecentEntry({ repo: 'a/b', number: 1, state: 'weird' }).state, 'done')
  const many = []
  for (let index = 0; index < 30; index += 1) {
    many.push({ repo: 'a/b', number: index + 1, state: 'done', findings: 0, finishedAt: index + 1 })
  }
  assert.equal(api.normalizeAutoReviewRecent(many).length, api.AUTO_REVIEW_RECENT_LIMIT)
})

test('normalizeAutoReviewStatus fills config/running/recent and tolerates garbage', () => {
  const status = api.normalizeAutoReviewStatus({
    config: { enabled: true, intervalSeconds: 60, depth: 'deep' },
    running: true,
    lastCycleAt: 1792825340929,
    nextCycleAt: 'nope',
    seenCount: '7',
    recent: [{ repo: 'a/b', number: 1, state: 'done', findings: 1 }],
    lastError: { code: 'GH_TIMEOUT', message: 'timeout' },
  })
  assert.equal(status.config.enabled, true)
  assert.equal(status.config.intervalSeconds, 60)
  assert.equal(status.running, true)
  assert.equal(status.lastCycleAt, 1792825340929)
  assert.equal(status.nextCycleAt, 0)
  assert.equal(status.seenCount, 7)
  assert.equal(status.recent.length, 1)
  assert.equal(status.lastError.code, 'GH_TIMEOUT')
  const empty = api.normalizeAutoReviewStatus(null)
  assert.deepEqual(empty.config, api.AUTO_REVIEW_DEFAULT)
  assert.equal(empty.running, false)
  assert.deepEqual(empty.recent, [])
  assert.equal(empty.lastError, null)
})

test('autoReviewPollDecision decides polling from visibility + enabled + support', () => {
  assert.deepEqual(api.autoReviewPollDecision({ supported: true, enabled: true, visible: true }), {
    active: true,
    intervalMs: api.AUTO_REVIEW_POLL_MS,
    reason: 'polling',
  })
  assert.equal(
    api.autoReviewPollDecision({ supported: true, enabled: false, visible: true }).active,
    false,
  )
  assert.equal(
    api.autoReviewPollDecision({ supported: true, enabled: true, visible: false }).reason,
    'hidden',
  )
  assert.equal(
    api.autoReviewPollDecision({ supported: false, enabled: true, visible: true }).reason,
    'unsupported',
  )
  assert.equal(
    api.autoReviewPollDecision({ supported: true, enabled: true, visible: true, intervalMs: 1200 })
      .intervalMs,
    1200,
  )
  assert.equal(api.autoReviewPollDecision(null).active, false)
})

test('diffAutoReviewRecent only reports newly finished done results', () => {
  const first = [
    { repo: 'a/b', number: 1, state: 'done', findings: 2, finishedAt: 100 },
    { repo: 'a/b', number: 2, state: 'error', finishedAt: 90 },
  ]
  const next = [
    { repo: 'a/b', number: 3, state: 'done', findings: 1, finishedAt: 200 },
    { repo: 'a/b', number: 1, state: 'done', findings: 2, finishedAt: 100 },
    { repo: 'a/b', number: 2, state: 'done', findings: 0, finishedAt: 210 },
    { repo: 'a/b', number: 4, state: 'error', finishedAt: 220 },
  ]
  const newDone = api.diffAutoReviewRecent(first, next)
  assert.deepEqual(
    newDone.map((entry) => entry.number),
    [3, 2],
  )
  assert.deepEqual(api.diffAutoReviewRecent([], next).map((entry) => entry.number), [3, 1, 2])
  assert.deepEqual(api.diffAutoReviewRecent(first, first), [])
  assert.equal(api.autoReviewRecentKey({ repo: 'a/b', number: 1, headSha: 'x', finishedAt: 5 }), 'a/b#1@x@5')
})

test('autoReviewBadgesByPr + autoReviewBadge describe list-row badges', () => {
  const map = api.autoReviewBadgesByPr([
    { repo: 'a/b', number: 1, state: 'done', findings: 2, finishedAt: 100 },
    { repo: 'a/b', number: 1, state: 'done', findings: 0, finishedAt: 90 },
    { repo: 'a/b', number: 2, state: 'done', findings: 0, finishedAt: 50 },
    { repo: 'a/b', number: 3, state: 'error', finishedAt: 60, error: { code: 'X', message: 'boom' } },
  ])
  assert.equal(map['a/b#1'].findings, 2)
  assert.deepEqual(api.autoReviewBadge(map['a/b#1']), {
    kind: 'count',
    text: '2',
    titleKey: 'autoReviewBadgeCount',
    titleVars: { n: 2 },
  })
  assert.deepEqual(api.autoReviewBadge(map['a/b#2']), {
    kind: 'clean',
    text: '✓',
    titleKey: 'autoReviewBadgeClean',
    titleVars: null,
  })
  assert.equal(api.autoReviewBadge(map['a/b#3']).kind, 'error')
  assert.equal(api.autoReviewBadge(map['a/b#9']), null)
  assert.equal(api.autoReviewBadge(null), null)
})

test('isAutoReviewRouteMissing + autoReviewRunState map host responses', () => {
  assert.equal(api.isAutoReviewRouteMissing({ code: 'GH_NOT_FOUND', message: 'no' }), true)
  assert.equal(api.isAutoReviewRouteMissing({ code: 'BAD_REQUEST', message: '没有这个路由' }), true)
  assert.equal(api.isAutoReviewRouteMissing({ code: 'BAD_REQUEST', message: 'route missing' }), true)
  assert.equal(api.isAutoReviewRouteMissing({ code: 'BAD_REQUEST', message: 'invalid patch' }), false)
  assert.equal(api.isAutoReviewRouteMissing({ code: 'INTERNAL' }), false)
  assert.equal(api.isAutoReviewRouteMissing(null), false)

  assert.deepEqual(api.autoReviewRunState({ started: true }), {
    kind: 'started',
    messageKey: 'autoReviewRunStarted',
  })
  assert.equal(api.autoReviewRunState({ started: false, reason: 'running' }).kind, 'busy')
  assert.equal(api.autoReviewRunState({ started: false, reason: 'disabled' }).kind, 'disabled')
  // The Host sends Chinese reasons; the mapping must tolerate both languages.
  assert.equal(api.autoReviewRunState({ started: false, reason: '已有自动审查 cycle 正在运行' }).kind, 'busy')
  assert.equal(api.autoReviewRunState({ started: false, reason: '自动审查已关闭（可带 force:true 单次运行）' }).kind, 'disabled')
  assert.equal(api.autoReviewRunState({ started: false, reason: '插件已卸载' }).kind, 'failed')
  assert.equal(api.autoReviewRunState(null, { code: 'GH_NOT_FOUND' }).kind, 'unsupported')
  assert.equal(api.autoReviewRunState(null, { code: 'INTERNAL' }).kind, 'failed')
  assert.equal(api.autoReviewRunState({ started: false, reason: 'other' }).kind, 'busy')
})

test('autoReviewDoneToastText prefers findings count and falls back to clean', () => {
  const t = (key) => api.locales.zh[key]
  assert.equal(
    api.autoReviewDoneToastText({ repo: 'Acefake/yingbox', number: 129, findings: 3 }, t),
    '自动审查完成：Acefake/yingbox#129 · 3 个问题',
  )
  assert.equal(
    api.autoReviewDoneToastText({ repo: 'a/b', number: 7, findings: 0 }, t),
    '自动审查完成：a/b#7 · 未发现问题',
  )
  assert.equal(api.autoReviewDoneToastText(null, t), '')
})

// ---------------------------------------------------------------------------
// v2.5: publish request binding, result action, route-missing classification
// ---------------------------------------------------------------------------

test('buildPublishRequest carries the head and job the user published from', () => {
  const request = api.buildPublishRequest({
    summary: { repo: 'Acme/repo', number: 7 },
    headSha: ' abc123 ',
    jobId: ' job-9 ',
    mode: 'both',
    minSeverity: 'P1',
  })
  assert.deepEqual(request, {
    repo: 'Acme/repo',
    number: 7,
    mode: 'both',
    minSeverity: 'P1',
    confirm: true,
    headSha: 'abc123',
    jobId: 'job-9',
  })
  // Missing binding is still a valid request: the Host falls back to the current
  // head, which keeps an older client working.
  const bare = api.buildPublishRequest({ summary: { repo: 'Acme/repo', number: 7 } })
  assert.equal(bare.headSha, undefined)
  assert.equal(bare.jobId, undefined)
  assert.equal(api.buildPublishRequest({}), null)
})

test('normalizePublishResult keeps the Host action so the toast can tell them apart', () => {
  const base = {
    published: true,
    reviewId: 12,
    url: 'https://github.com/Acme/repo/pull/7#pullrequestreview-12',
    comments: 0,
    skipped: 2,
  }
  assert.equal(api.normalizePublishResult({ ...base, action: 'updated' }).action, 'updated')
  assert.equal(api.normalizePublishResult({ ...base, action: 'unchanged' }).action, 'unchanged')
  assert.equal(api.normalizePublishResult({ ...base, action: 'created' }).action, 'created')
  // An older Host sends no action: treat it as a create.
  assert.equal(api.normalizePublishResult(base).action, 'created')
  assert.equal(api.normalizePublishResult({ ...base, action: 'weird' }).action, 'created')
  assert.equal(api.normalizePublishResult({ published: false }), null)
})

test('isPublishRouteMissing treats GH_NOT_FOUND as a real error, not an old Host', () => {
  // A deleted repository / inaccessible PR must not hide the publish button.
  assert.equal(api.isPublishRouteMissing({ code: 'GH_NOT_FOUND', message: '没有这个仓库' }), false)
  assert.equal(api.isPublishRouteMissing({ code: 'GH_FORBIDDEN', message: 'forbidden' }), false)
  assert.equal(api.isPublishRouteMissing({ code: 'REVIEW_PARTIAL', message: '不完整' }), false)
  // A host that predates the route answers with a route-shaped BAD_REQUEST.
  assert.equal(api.isPublishRouteMissing({ code: 'BAD_REQUEST', message: '没有这个路由' }), true)
  assert.equal(api.isPublishRouteMissing({ code: 'BAD_REQUEST', message: 'route missing' }), true)
  assert.equal(api.isPublishRouteMissing({ code: 'BAD_REQUEST', message: 'invalid patch' }), false)
  assert.equal(api.isPublishRouteMissing(null), false)
})

test('publishErrorKey maps the new publish failures to their own sentences', () => {
  assert.equal(api.publishErrorKey('REVIEW_PARTIAL'), 'publishPartial')
  assert.equal(api.publishErrorKey('REVIEW_HEAD_MOVED'), 'publishHeadMoved')
  assert.equal(api.publishErrorKey('REVIEW_NOT_READY'), 'publishNotReady')
  assert.equal(api.publishErrorKey('PUBLISH_UNKNOWN'), 'publishUnknown')
  for (const key of ['publishPartial', 'publishHeadMoved', 'publishUnknown', 'publishUpdated', 'publishUnchanged']) {
    assert.equal(typeof api.locales.zh[key], 'string')
    assert.equal(typeof api.locales.en[key], 'string')
  }
})

test('threads keep REST roots and replies together when GraphQL is unavailable', () => {
  const threads = api.groupCommentThreads([
    { id: 10, body: '**[P1] Root**', author: 'a' },
    { id: 11, inReplyToId: 10, body: 'Reply', author: 'b' },
    { id: 12, body: 'Separate', author: 'c' },
  ])
  assert.equal(threads.length, 2)
  assert.equal(threads[0].replies, 1)
  assert.equal(threads[0].root.id, 10)
})

test('threads still group by GraphQL id and carry resolved state', () => {
  const threads = api.groupCommentThreads([
    { id: 10, threadId: 't1', body: 'Root' },
    { id: 11, threadId: 't1', body: 'Reply', isResolved: true },
  ])
  assert.equal(threads.length, 1)
  assert.equal(threads[0].resolved, true)
  assert.equal(threads[0].replies, 1)
})

function componentHarness() {
  const bundle = loadBundle()
  const react = createReactStub()
  const states = []
  const refs = []
  const callbacks = []
  let cursor = 0
  react.useState = initial => {
    const index = cursor++
    if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial
    return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value }]
  }
  react.useRef = initial => {
    const index = cursor++
    if (!(index in states)) states[index] = { current: initial }
    refs.push(states[index])
    return states[index]
  }
  react.useCallback = callback => { callbacks.push(callback); return callback }
  const api = bundle.definitions[0].factory(() => react).__test
  return { api, states, refs, callbacks, bundle, render(component, props) { cursor = 0; return component(props) } }
}

function nodes(tree) {
  if (!tree || typeof tree !== 'object') return []
  return [tree, ...(tree.props?.children || []).flat(Infinity).flatMap(nodes)]
}

test('expanded comments retain a working collapse button; unavailable threads cannot resolve', () => {
  const harness = componentHarness()
  const props = { comments: { inline: Array.from({ length: 6 }, (_, id) => ({ id, body: 'Comment' })) }, onResolve() {} }
  let tree = harness.render(harness.api.CommentsCard, props)
  const more = nodes(tree).find(node => node.props?.['data-action'] === 'comments-more')
  assert.ok(more)
  assert.equal(nodes(tree).filter(node => node.props?.['data-action'] === 'thread-resolve').length, 0)
  more.props.onClick()
  tree = harness.render(harness.api.CommentsCard, props)
  const collapse = nodes(tree).find(node => node.props?.['data-action'] === 'comments-more')
  assert.ok(collapse)
  assert.equal(nodes(tree).filter(node => node.props?.['data-cr-thread']).length, 6)
  collapse.props.onClick()
  tree = harness.render(harness.api.CommentsCard, props)
  assert.equal(nodes(tree).filter(node => node.props?.['data-cr-thread']).length, 5)
})

test('starting, completing and cancelling reviews invalidate cached review snapshots', async () => {
  for (const action of ['start', 'complete', 'cancel']) {
    const harness = componentHarness()
    harness.states[4] = { repo: 'a/b', number: 1 }
    harness.bundle.sandbox.fetch = async () => ({
      ok: true,
      async json() { return { ok: true, value: { state: 'done', findings: [] } } },
    })
    if (action === 'start') harness.bundle.sandbox.fetch = async () => ({
      async json() { return { ok: false, error: { code: 'INTERNAL' } } },
    })
    harness.render(harness.api.Workbench, {})
    const cache = harness.refs.find(ref => ref.current && typeof ref.current.set === 'function').current
    cache.set('a/b#1', { value: { review: { state: 'none' } }, at: Date.now() })
    if (action === 'start') {
      harness.callbacks.find(fn => String(fn).includes("'/review-start'"))()
    } else if (action === 'cancel') {
      harness.callbacks.find(fn => String(fn).includes("'/review-cancel'"))()
    } else {
      const poll = harness.callbacks.find(fn => String(fn).includes("'/review-status'"))
      const running = poll(0, 'job-1', harness.states[4])
      // Simulate a detail fetch caching the running review during polling.
      cache.set('a/b#1', { value: { review: { state: 'running' } }, at: Date.now() })
      await running
    }
    assert.equal(cache.has('a/b#1'), false, action)
  }
})

test('resuming cached review B invalidates B even before the selection ref rerenders', async () => {
  const harness = componentHarness()
  harness.states[4] = { repo: 'a/b', number: 1 }
  harness.bundle.sandbox.fetch = async () => ({
    async json() { return { ok: true, value: { state: 'done', headSha: 'bbb', findings: [] } } },
  })
  harness.render(harness.api.Workbench, {})
  const cache = harness.refs.find(ref => ref.current && typeof ref.current.set === 'function').current
  const originalA = { value: { review: { state: 'none' } }, at: Date.now() }
  cache.set('a/b#1', originalA)
  cache.set('a/b#2', { value: { review: { state: 'running', jobId: 'job-B' } }, at: Date.now() })
  harness.callbacks.find(fn => String(fn).includes('setSelected(summary)'))({ repo: 'a/b', number: 2 })
  await new Promise(resolve => setTimeout(resolve, 900))
  assert.equal(harness.states[9].state, 'done')
  assert.equal(cache.get('a/b#1'), originalA)
  assert.equal(cache.has('a/b#2'), false)
})

test('invalidated detail responses join the fresh request without restoring stale reviews', async () => {
  const harness = componentHarness()
  const summary = { repo: 'a/b', number: 1 }
  harness.states[4] = summary
  const responses = []
  harness.bundle.sandbox.fetch = async () => ({
    json: () => new Promise(resolve => responses.push(resolve)),
  })
  harness.render(harness.api.Workbench, {})
  const cache = harness.refs.find(ref => ref.current && typeof ref.current.set === 'function').current
  const fetchDetail = harness.callbacks.find(fn => String(fn).includes('detailInflight.current.get(key)'))
  const invalidate = harness.callbacks.find(fn => String(fn).includes('detailVersions.current.set(key,'))
  const old = fetchDetail(summary)
  await new Promise(resolve => setImmediate(resolve))
  invalidate(summary)
  const fresh = fetchDetail(summary)
  await new Promise(resolve => setImmediate(resolve))
  responses[0]({ ok: true, value: { summary, review: { state: 'none' } } })
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(cache.has('a/b#1'), false)
  assert.equal(fetchDetail(summary), fresh, 'obsolete cleanup must not remove the newer in-flight request')
  responses[1]({ ok: true, value: { summary, review: { state: 'done', jobId: 'new' } } })
  const [oldResult, freshResult] = await Promise.all([old, fresh])
  assert.equal(oldResult.value.review.jobId, 'new')
  assert.equal(freshResult.value.review.jobId, 'new')
  assert.equal(cache.get('a/b#1').value.review.jobId, 'new')
})

test('a delayed refresh cannot replace the latest detail after review invalidation', async () => {
  const harness = componentHarness()
  const summary = { repo: 'a/b', number: 1 }
  harness.states[4] = summary
  const responses = []
  harness.bundle.sandbox.fetch = async () => ({ json: () => new Promise(resolve => responses.push(resolve)) })
  harness.render(harness.api.Workbench, {})
  const refresh = harness.callbacks.find(fn => String(fn).includes('invalidateDetail(summary)') && String(fn).includes('setDetail({ state:'))
  const invalidate = harness.callbacks.find(fn => String(fn).includes('detailVersions.current.set(key,'))
  refresh(summary)
  await new Promise(resolve => setImmediate(resolve))
  invalidate(summary)
  responses[0]({ ok: true, value: { summary, review: { state: 'none' }, body: 'old' } })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(responses.length, 2, 'refresh retries with the current epoch')
  responses[1]({ ok: true, value: { summary, review: { state: 'done' }, body: 'new' } })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(harness.states[5].value.body, 'new')
})

test('selecting a freshly cached PR revalidates and restores reviews completed elsewhere', async () => {
  const harness = componentHarness()
  const summary = { repo: 'a/b', number: 2 }
  let calls = 0
  harness.bundle.sandbox.fetch = async () => {
    calls += 1
    return { async json() { return { ok: true, value: { summary, review: { state: 'done', jobId: 'automatic-result', findings: [{ file: 'a.js', line: 1, title: 'Bug', severity: 'P1' }] } } } } }
  }
  harness.render(harness.api.Workbench, {})
  const cache = harness.refs.find(ref => ref.current && typeof ref.current.set === 'function').current
  cache.set('a/b#2', { at: Date.now(), value: { summary, review: { state: 'none' } } })
  harness.callbacks.find(fn => String(fn).includes('setSelected(summary)'))(summary)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls, 1)
  assert.equal(harness.states[9].state, 'done')
  assert.equal(harness.states[9].jobId, 'automatic-result')
})

test('toolbar and native settings reuse the same form with one set of review controls', () => {
  const dialog = api.ReviewSettings({})
  assert.equal(nodes(dialog).filter(node => node.type === api.CodeReviewSettingsPanel).length, 1)
  const harness = componentHarness()
  // Native form after the host loaded; automatic review enabled.
  harness.states[0] = { supported: true, loading: false, status: { config: { enabled: true, depth: 'deep', severityThreshold: 'P0', includeGuidelines: false } } }
  const panel = harness.render(harness.api.CodeReviewSettingsPanel, {})
  const controls = nodes(panel).filter(node => node.props?.label)
  assert.equal(controls.filter(node => node.props.label === 'depth' && node.props.options).length, 1)
  assert.equal(controls.filter(node => node.props.label === 'severityThreshold' && node.props.options).length, 1)
})

test('settings load errors offer retry and failed refreshes preserve the last good config', async () => {
  const harness = componentHarness()
  let fail = true
  harness.bundle.sandbox.fetch = async path => ({ async json() {
    if (path.endsWith('/health')) return { ok: true, value: {} }
    return fail ? { ok: false, error: { code: 'GH_NETWORK' } } : {
      ok: true, value: { config: { depth: 'deep', severityThreshold: 'P0', includeGuidelines: false } },
    }
  } })
  harness.render(harness.api.CodeReviewSettingsPanel, {})
  const refresh = harness.callbacks.find(fn => String(fn).includes("'/auto-review-status'"))
  refresh()
  await new Promise(resolve => setImmediate(resolve))
  let tree = harness.render(harness.api.CodeReviewSettingsPanel, {})
  assert.ok(nodes(tree).some(node => node.props?.role === 'alert'))
  assert.equal(nodes(tree).find(node => node.props?.kind === 'depth').props.disabled, true)
  const retry = nodes(tree).find(node => node.props?.['data-action'] === 'settings-retry')
  fail = false
  retry.props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  tree = harness.render(harness.api.CodeReviewSettingsPanel, {})
  assert.equal(nodes(tree).some(node => node.props?.role === 'alert'), false)
  assert.equal(nodes(tree).find(node => node.props?.kind === 'depth').props.disabled, false)
  const config = harness.states[0].status
  assert.equal(config.config.depth, 'deep')
  fail = true
  refresh()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(harness.states[0].status, config)
})

test('fresh detail with no review clears a cached result from an older head', async () => {
  const harness = componentHarness()
  const summary = { repo: 'a/b', number: 1 }
  harness.bundle.sandbox.fetch = async () => ({ async json() { return { ok: true, value: { summary, headSha: 'new-head', review: { state: 'none', headSha: 'new-head' } } } } })
  harness.render(harness.api.Workbench, {})
  const cache = harness.refs.find(ref => ref.current && typeof ref.current.set === 'function').current
  cache.set('a/b#1', { at: Date.now(), value: { summary, headSha: 'old-head', review: { state: 'done', headSha: 'old-head', findings: [] } } })
  harness.callbacks.find(fn => String(fn).includes('setSelected(summary)'))(summary)
  assert.equal(harness.states[9].state, 'done')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(harness.states[9].state, 'none')
  assert.equal(harness.states[5].value.headSha, 'new-head')
})

test('a late comment refresh invalidates its original PR without replacing another selection', async () => {
  const harness = componentHarness()
  harness.states[4] = { repo: 'a/b', number: 2 }
  const originalDetail = { state: 'ready', value: { body: 'PR B' } }
  harness.states[5] = originalDetail
  let requests = 0
  harness.bundle.sandbox.fetch = async () => { requests += 1; return { async json() { return { ok: true, value: {} } } } }
  harness.render(harness.api.Workbench, {})
  const cache = harness.refs.find(ref => ref.current && typeof ref.current.set === 'function').current
  cache.set('a/b#1', { at: Date.now(), value: {} })
  const refresh = harness.callbacks.find(fn => String(fn).includes('invalidateDetail(summary)') && String(fn).includes('setDetail({ state:'))
  refresh({ repo: 'a/b', number: 1 })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(cache.has('a/b#1'), false)
  assert.equal(harness.states[5], originalDetail)
  assert.equal(requests, 0)
})

test('a cached running review is stopped when revalidation discovers a new PR head', async () => {
  const harness = componentHarness()
  const summary = { repo: 'a/b', number: 1 }
  let statusCalls = 0
  harness.bundle.sandbox.fetch = async path => {
    if (path.endsWith('/review-status')) statusCalls += 1
    return { async json() { return { ok: true, value: { summary, headSha: 'new', review: { state: 'none', headSha: 'new' } } } } }
  }
  harness.render(harness.api.Workbench, {})
  const cache = harness.refs.find(ref => ref.current && typeof ref.current.set === 'function').current
  cache.set('a/b#1', { at: Date.now(), value: { summary, headSha: 'old', review: { state: 'running', headSha: 'old', jobId: 'old-job' } } })
  harness.callbacks.find(fn => String(fn).includes('setSelected(summary)'))(summary)
  await new Promise(resolve => setTimeout(resolve, 900))
  assert.equal(harness.states[9].state, 'none')
  assert.equal(statusCalls, 0)
})

test('actions immediately after selecting a PR target the new PR before rerender', async () => {
  const harness = componentHarness()
  harness.states[4] = { repo: 'a/b', number: 1 }
  const writes = []
  harness.bundle.sandbox.fetch = async (path, init) => {
    if (path.endsWith('/review-start')) writes.push(JSON.parse(init.body))
    return { async json() { return { ok: false, error: { code: 'INTERNAL' } } } }
  }
  harness.render(harness.api.Workbench, {})
  harness.callbacks.find(fn => String(fn).includes('setSelected(summary)'))({ repo: 'a/b', number: 2 })
  harness.callbacks.find(fn => String(fn).includes("'/review-start'"))()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(writes.length, 1)
  assert.equal(writes[0].number, 2)
})
