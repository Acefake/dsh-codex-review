window.__ModuleLoader__.load({
  id: 'dsh-codex-review',
  factory(require) {
    'use strict'

    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useMemo, useRef, useCallback } = React

    /** Locale namespace owned by this plugin (registered through ctx.locale). */
    const NS = 'codex-review'
    /** Sidebar list id and main keyed-slot key; the two must stay equal. */
    const PANEL_ID = 'codex-review'
    /** Document-relative route base: the host page is served with <base href="./">. */
    const ROUTE = 'codex-review'
    const POLL_MS = 800
    const REQUEST_TIMEOUT_MS = 15000
    const MONO =
      'ui-monospace, "SF Mono", "JetBrains Mono", Consolas, "Liberation Mono", Menlo, monospace'
    const SANS = 'Inter, "PingFang SC", "Microsoft YaHei", system-ui, -apple-system, sans-serif'
    const DEFAULT_QUERY = 'is:open author:@me'
    /** A single file patch larger than this is collapsed by default (huge diff guard). */
    const MAX_VISIBLE_ROWS = 1600

    // ---------------------------------------------------------------------
    // Locale dictionaries
    // ---------------------------------------------------------------------

    const en = {
      panel: 'Code review',
      refresh: 'Refresh list',
      searchLabel: 'Filter pull requests',
      searchPlaceholder: 'is:open author:@me',
      clearSearch: 'Clear filter',
      listLoading: 'Loading pull requests…',
      listEmpty: 'No matching pull requests',
      listEmptyHint: 'Try is:open, is:closed or a keyword',
      listError: 'Failed to load pull requests',
      retry: 'Retry',
      detailLoading: 'Loading pull request…',
      detailError: 'Failed to load this pull request',
      noSelection: 'Select a pull request',
      noSelectionHint: 'The list mirrors a GitHub search: is:open author:@me',
      summary: 'Summary',
      changes: 'Changes',
      filesChanged: '{n} files changed',
      expandAll: 'Expand all',
      collapseAll: 'Collapse all',
      expandDiff: 'Show all {n} lines',
      reviewWithCodex: 'Review with Codex',
      reviewShort: 'Review',
      preparing: 'Preparing…',
      reviewing: 'Reviewing…',
      phasePreparing: 'Collecting diff',
      phaseReviewing: 'Analysing changes',
      phaseMerging: 'Merging findings',
      phaseDone: 'Done',
      filesProgress: '{done}/{total} files analysed',
      cancel: 'Cancel',
      reviewAgain: 'Review again',
      reviewResultTitle: 'Codex review',
      reviewDone: 'Done',
      reviewClean: 'No blocking findings',
      reviewCleanHint: 'This diff has no P0/P1 issues worth blocking on.',
      reviewFailed: 'Review failed',
      reviewPartial: 'Partial result',
      findingsCount: '{n} findings',
      verdictApprove: 'Looks good: no P0/P1 findings',
      verdictRequestChanges: 'Changes requested before merge',
      verdictBlocked: 'Could not finish the review',
      locate: 'Locate in diff',
      why: 'Why',
      fix: 'Fix',
      noFindings: 'Nothing to fix in this diff',
      comments: 'Comments',
      commentsCount: '{n} comments',
      noComments: 'No comments',
      reviewers: 'Reviewers',
      noReviewers: 'No reviewers',
      checks: 'Checks',
      noChecks: 'No checks reported',
      checksFailing: '{n} checks failing',
      stack: 'Stack',
      current: 'current',
      open: 'Open',
      closed: 'Closed',
      draft: 'Draft',
      merged: 'Merged',
      copied: 'Link copied',
      copyFailed: 'Could not copy the link',
      copyLink: 'Copy link',
      openOnGithub: 'Open on GitHub',
      pin: 'Pin to top',
      pinned: 'Pinned',
      merge: 'Merge',
      mergeDisabled: 'Read-only v1: merging lands later',
      askPlaceholder: 'Ask about this pull request',
      askDisabled: 'Read-only v1: only AI review is available',
      healthGhMissing: 'gh CLI not found: showing cached data only',
      healthGhNotLoggedIn: 'gh is not signed in. Run "gh auth login" in a terminal.',
      healthLlm: 'No model is configured, so AI review is unavailable',
      loading: 'Loading…',
      emptyDiff: 'No diff to show (binary or too large)',
      patchTruncated: 'patch truncated',
      bodyTruncated: 'Body truncated',
      filesTruncated: 'File list truncated',
      timeNow: 'just now',
      timeMinute: '{n} min ago',
      timeHour: '{n} h ago',
      timeDay: '{n} d ago',
      timeDate: '{date}',
      added: 'added',
      removed: 'removed',
      modified: 'modified',
      renamed: 'renamed',
      fileCountOne: '1 file',
      fileCount: '{n} files',
      age: 'Age',
      diffstat: 'Diff stat',
    }

    const zh = {
      panel: '代码审查',
      refresh: '刷新列表',
      searchLabel: '筛选 Pull Request',
      searchPlaceholder: 'is:open author:@me',
      clearSearch: '清除筛选',
      listLoading: '正在加载 Pull Request…',
      listEmpty: '没有匹配的 Pull Request',
      listEmptyHint: '试试 is:open、is:closed 或关键词',
      listError: '列表加载失败',
      retry: '重试',
      detailLoading: '正在加载 PR…',
      detailError: 'PR 详情加载失败',
      noSelection: '选择一个 Pull Request',
      noSelectionHint: '列表来自 GitHub 搜索：is:open author:@me',
      summary: 'Summary',
      changes: 'Changes',
      filesChanged: '{n} files changed',
      expandAll: '全部展开',
      collapseAll: '全部折叠',
      expandDiff: '展开全部 {n} 行',
      reviewWithCodex: 'Review with Codex',
      reviewShort: 'AI 审查',
      preparing: '准备中…',
      reviewing: '审查中…',
      phasePreparing: '收集 diff',
      phaseReviewing: '分析变更',
      phaseMerging: '汇总发现',
      phaseDone: '完成',
      filesProgress: '已分析 {done}/{total} 文件',
      cancel: '取消',
      reviewAgain: '重新审查',
      reviewResultTitle: 'Codex 审查',
      reviewDone: '完成',
      reviewClean: '未发现 P0/P1 问题',
      reviewCleanHint: '这次 diff 没有发现需要阻断的问题。',
      reviewFailed: '审查失败',
      reviewPartial: '部分结果',
      findingsCount: '{n} 条发现',
      verdictApprove: '建议合并：没有 P0/P1 问题',
      verdictRequestChanges: '建议修改后再合并',
      verdictBlocked: '无法完成审查',
      locate: '定位到 diff',
      why: '为什么',
      fix: '怎么改',
      noFindings: '这次的改动没有需要修复的问题',
      comments: '评论',
      commentsCount: '{n} 条评论',
      noComments: 'No comments',
      reviewers: 'Reviewers',
      noReviewers: 'No reviewers',
      checks: 'Checks',
      noChecks: 'No checks reported',
      checksFailing: '{n} 项检查失败',
      stack: 'Stack',
      current: '当前',
      open: 'Open',
      closed: 'Closed',
      draft: 'Draft',
      merged: 'Merged',
      copied: '已复制链接',
      copyFailed: '复制失败',
      copyLink: '复制链接',
      openOnGithub: '在 GitHub 中打开',
      pin: '钉住到顶部',
      pinned: '已钉住',
      merge: '合并',
      mergeDisabled: 'v1 只读，合并功能后续开放',
      askPlaceholder: '就此 Pull Request 提问',
      askDisabled: 'v1 仅支持 AI 审查，提问功能在后续版本',
      healthGhMissing: '未检测到 gh CLI：只能查看缓存数据',
      healthGhNotLoggedIn: 'gh 未登录，请在终端执行 gh auth login',
      healthLlm: '宿主没有可用模型，AI 审查不可用',
      loading: '加载中…',
      emptyDiff: '没有可展示的 diff（二进制文件或内容过大）',
      patchTruncated: 'patch 已截断',
      bodyTruncated: '正文已截断',
      filesTruncated: '文件列表已截断',
      timeNow: '刚刚',
      timeMinute: '{n} 分钟前',
      timeHour: '{n} 小时前',
      timeDay: '{n} 天前',
      timeDate: '{date}',
      added: '新增',
      removed: '删除',
      modified: '修改',
      renamed: '重命名',
      fileCountOne: '1 file',
      fileCount: '{n} files',
      age: '时间',
      diffstat: '变更统计',
    }

    // ---------------------------------------------------------------------
    // Pure helpers (also exposed through __test for node --test)
    // ---------------------------------------------------------------------

    /** Render `t(key)` defensively: the slot locale face may be missing in dev. */
    function tx(t, key, vars) {
      let text
      try {
        text = typeof t === 'function' ? t(key) : undefined
      } catch {
        text = undefined
      }
      if (typeof text !== 'string' || text.length === 0) text = key
      if (vars) {
        text = text.replace(/\{(\w+)\}/g, (match, name) =>
          vars[name] === undefined ? match : String(vars[name]),
        )
      }
      return text
    }

    /** 2117 -> "2,117"; non numeric input -> "0". */
    function formatNumber(value) {
      const number = Number(value)
      if (!Number.isFinite(number)) return '0'
      return String(Math.trunc(number)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    }

    /** Clamp a long branch name in the middle: feat/intro-de…ct. */
    function truncateMiddle(text, max) {
      const source = String(text === null || text === undefined ? '' : text)
      const limit = Number.isFinite(max) ? Math.max(3, Math.trunc(max)) : 20
      if (source.length <= limit) return source
      const budget = limit - 1
      const left = Math.ceil(budget / 2)
      const right = Math.floor(budget / 2)
      return source.slice(0, left) + '…' + source.slice(source.length - right)
    }

    /**
     * Relative timestamp used by list rows and the PR meta line.
     * Returns null for unparseable input, otherwise {unit, value}.
     */
    function relativeTime(iso, now) {
      let stamp
      if (typeof iso === 'number') stamp = iso
      else if (typeof iso === 'string') stamp = Date.parse(iso)
      else stamp = NaN
      if (!Number.isFinite(stamp)) return null
      const base = Number.isFinite(now) ? now : Date.now()
      const diff = Math.max(0, base - stamp)
      if (diff < 45000) return { unit: 'now', value: 0 }
      const minutes = Math.max(1, Math.round(diff / 60000))
      if (minutes < 60) return { unit: 'minute', value: minutes }
      const hours = Math.round(minutes / 60)
      if (hours < 24) return { unit: 'hour', value: hours }
      const days = Math.round(hours / 24)
      if (days < 30) return { unit: 'day', value: days }
      return { unit: 'date', value: stamp }
    }

    /** Format a relativeTime() result through the locale face. */
    function formatRelative(relative, t) {
      if (!relative) return ''
      switch (relative.unit) {
        case 'now':
          return tx(t, 'timeNow')
        case 'minute':
          return tx(t, 'timeMinute', { n: relative.value })
        case 'hour':
          return tx(t, 'timeHour', { n: relative.value })
        case 'day':
          return tx(t, 'timeDay', { n: relative.value })
        default: {
          try {
            return tx(t, 'timeDate', { date: new Date(relative.value).toISOString().slice(0, 10) })
          } catch {
            return ''
          }
        }
      }
    }

    function severityRank(severity) {
      switch (severity) {
        case 'P0':
          return 0
        case 'P1':
          return 1
        case 'P2':
          return 2
        case 'P3':
          return 3
        default:
          return 4
      }
    }

    /** P0 -> P1 -> P2 -> P3, then stable by file path and line. */
    function sortFindings(findings) {
      const list = Array.isArray(findings) ? findings.slice() : []
      return list.sort(
        (a, b) =>
          severityRank(a && a.severity) - severityRank(b && b.severity) ||
          String((a && a.file) || '').localeCompare(String((b && b.file) || '')) ||
          (Number(a && a.line) || 0) - (Number(b && b.line) || 0),
      )
    }

    function countSeverities(findings) {
      const counts = { P0: 0, P1: 0, P2: 0 }
      for (const finding of Array.isArray(findings) ? findings : []) {
        const severity = finding && finding.severity
        if (severity === 'P0' || severity === 'P1' || severity === 'P2') counts[severity] += 1
      }
      return counts
    }

    /** Parse the `@@ -a,b +c,d @@` hunk header; missing counts mean 1. */
    function parseHunkHeader(line) {
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(String(line || ''))
      if (!match) return null
      return {
        oldStart: Number(match[1]),
        oldCount: match[2] === undefined ? 1 : Number(match[2]),
        newStart: Number(match[3]),
        newCount: match[4] === undefined ? 1 : Number(match[4]),
      }
    }

    /**
     * Turn a unified diff body into typed rows for the diff viewer.
     * Rows: {type:'hunk'|'add'|'del'|'ctx'|'meta', text, oldLine, newLine}.
     */
    function parseUnifiedDiff(patch) {
      const rows = []
      const source = String(patch === null || patch === undefined ? '' : patch)
      if (source.trim() === '') return rows
      const lines = source.replace(/\r\n?/g, '\n').split('\n')
      let oldLine = 0
      let newLine = 0
      for (const raw of lines) {
        if (raw === '') continue
        const hunk = parseHunkHeader(raw)
        if (hunk) {
          oldLine = hunk.oldStart
          newLine = hunk.newStart
          rows.push({ type: 'hunk', text: raw, oldLine: null, newLine: null })
          continue
        }
        const sign = raw.charAt(0)
        const body = raw.slice(1)
        if (sign === '+') {
          rows.push({ type: 'add', text: body, oldLine: null, newLine })
          newLine += 1
        } else if (sign === '-') {
          rows.push({ type: 'del', text: body, oldLine, newLine: null })
          oldLine += 1
        } else if (sign === ' ') {
          rows.push({ type: 'ctx', text: body, oldLine, newLine })
          oldLine += 1
          newLine += 1
        } else if (sign === '\\') {
          rows.push({ type: 'meta', text: raw.slice(1).trim(), oldLine: null, newLine: null })
        } else {
          rows.push({ type: 'meta', text: raw, oldLine: null, newLine: null })
        }
      }
      return rows
    }

    /** Group findings per file for inline markers in the diff. */
    function groupFindingsByFile(findings) {
      const map = Object.create(null)
      for (const finding of Array.isArray(findings) ? findings : []) {
        if (!finding || typeof finding.file !== 'string') continue
        if (!map[finding.file]) map[finding.file] = []
        map[finding.file].push(finding)
      }
      return map
    }

    const LIST_ITEM_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/

    /**
     * Tokenize the PR body / overview markdown subset we render ourselves:
     * h1-h6, paragraphs, ordered + nested unordered lists, quotes, fences, hr.
     */
    function tokenizeMarkdown(source) {
      const text = String(source === null || source === undefined ? '' : source).replace(/\r\n?/g, '\n')
      const lines = text.split('\n')
      const blocks = []
      let paragraph = []
      let index = 0
      const flushParagraph = () => {
        if (paragraph.length > 0) {
          const joined = paragraph.join('\n').trim()
          if (joined) blocks.push({ type: 'p', text: joined })
          paragraph = []
        }
      }
      while (index < lines.length) {
        const line = lines[index]
        const fence = /^\s*```(.*)$/.exec(line)
        if (fence) {
          flushParagraph()
          const lang = fence[1].trim()
          const body = []
          index += 1
          while (index < lines.length && !/^\s*```/.test(lines[index])) {
            body.push(lines[index])
            index += 1
          }
          index += 1
          blocks.push({ type: 'code', lang, text: body.join('\n') })
          continue
        }
        if (/^\s*$/.test(line)) {
          flushParagraph()
          index += 1
          continue
        }
        const heading = /^(#{1,6})\s+(.*)$/.exec(line)
        if (heading) {
          flushParagraph()
          blocks.push({
            type: heading[1].length <= 2 ? 'h2' : 'h3',
            text: heading[2].trim(),
          })
          index += 1
          continue
        }
        if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
          flushParagraph()
          blocks.push({ type: 'hr' })
          index += 1
          continue
        }
        if (/^\s*>/.test(line)) {
          flushParagraph()
          const quote = []
          while (index < lines.length && /^\s*>/.test(lines[index])) {
            quote.push(lines[index].replace(/^\s*>\s?/, ''))
            index += 1
          }
          blocks.push({ type: 'quote', text: quote.join('\n') })
          continue
        }
        if (LIST_ITEM_RE.test(line)) {
          flushParagraph()
          const items = []
          while (index < lines.length) {
            const match = LIST_ITEM_RE.exec(lines[index])
            if (!match) {
              if (items.length > 0 && /^\s+\S/.test(lines[index])) {
                items[items.length - 1].text += '\n' + lines[index].trim()
                index += 1
                continue
              }
              break
            }
            const indent = match[1].replace(/\t/g, '  ').length
            const depth = Math.min(3, Math.floor(indent / 2))
            const ordered = /^\d/.test(match[2])
            const number = ordered ? Number(match[2].replace(/[.)]$/, '')) : null
            items.push({
              depth,
              marker: ordered ? 'number' : 'bullet',
              number: Number.isFinite(number) ? number : null,
              text: match[3],
            })
            index += 1
          }
          blocks.push({ type: 'list', items })
          continue
        }
        paragraph.push(line)
        index += 1
      }
      flushParagraph()
      return blocks
    }

    /**
     * Inline markdown: `code`, **strong**, *em*, [text](href). Everything is
     * returned as tokens so rendering never needs innerHTML.
     */
    function tokenizeInline(source) {
      const text = String(source === null || source === undefined ? '' : source)
      const nodes = []
      let buffer = ''
      let index = 0
      const flush = () => {
        if (buffer) {
          nodes.push({ type: 'text', text: buffer })
          buffer = ''
        }
      }
      while (index < text.length) {
        const char = text.charAt(index)
        if (char === '`') {
          const end = text.indexOf('`', index + 1)
          if (end > index) {
            flush()
            nodes.push({ type: 'code', text: text.slice(index + 1, end) })
            index = end + 1
            continue
          }
        }
        if (char === '*' && text.charAt(index + 1) === '*') {
          const end = text.indexOf('**', index + 2)
          if (end > index + 2) {
            flush()
            nodes.push({ type: 'strong', text: text.slice(index + 2, end) })
            index = end + 2
            continue
          }
        }
        if (char === '*') {
          const end = text.indexOf('*', index + 1)
          if (end > index + 1 && end - index < 240) {
            flush()
            nodes.push({ type: 'em', text: text.slice(index + 1, end) })
            index = end + 1
            continue
          }
        }
        if (char === '[') {
          const close = text.indexOf(']', index + 1)
          if (close > index && text.charAt(close + 1) === '(') {
            const end = text.indexOf(')', close + 2)
            if (end > close) {
              flush()
              nodes.push({
                type: 'link',
                text: text.slice(index + 1, close),
                href: text.slice(close + 2, end),
              })
              index = end + 1
              continue
            }
          }
        }
        buffer += char
        index += 1
      }
      flush()
      return nodes
    }

    /** Coerce an unknown value into an array (host may send null/undefined). */
    function asArray(value) {
      return Array.isArray(value) ? value : []
    }

    /** Coerce comments into {total, issue, reviews, inline} for the details column. */
    function normalizeComments(value) {
      if (Array.isArray(value)) {
        return { total: value.length, issue: value, reviews: [], inline: [] }
      }
      const source = value && typeof value === 'object' ? value : {}
      const issue = asArray(source.issue)
      const reviews = asArray(source.reviews)
      const inline = asArray(source.inline)
      const total = Number.isFinite(Number(source.total))
        ? Number(source.total)
        : issue.length + reviews.length + inline.length
      return { total, issue, reviews, inline }
    }

    /** Coerce checks into {state, items}; [] and "none" both mean "no checks". */
    function normalizeChecks(value) {
      if (Array.isArray(value)) {
        const items = value
        const failing = items.some((item) => item && item.state === 'failure')
        return { state: failing ? 'failure' : items.length > 0 ? 'success' : 'none', items }
      }
      if (typeof value === 'string') {
        return { state: value === 'none' || value === '' ? 'none' : value, items: [] }
      }
      const source = value && typeof value === 'object' ? value : {}
      const state = typeof source.state === 'string' && source.state !== '' ? source.state : 'none'
      return { state, items: asArray(source.items) }
    }

    /** Coerce the stack block; an array is treated as the chain itself. */
    function normalizeStack(value) {
      if (Array.isArray(value)) {
        return { baseRefName: '', declaredBase: '', chain: value, allBaseMerged: false }
      }
      const source = value && typeof value === 'object' ? value : {}
      return Object.assign(
        { baseRefName: '', declaredBase: '', chain: [], allBaseMerged: false },
        source,
        { chain: asArray(source.chain) },
      )
    }

    /** Normalize a PrDetail payload before it reaches any component. */
    function normalizePrDetail(value) {
      const source = value && typeof value === 'object' ? value : {}
      const summary = source.summary && typeof source.summary === 'object' ? source.summary : {}
      const review = source.review && typeof source.review === 'object' ? source.review : {}
      return Object.assign({}, source, {
        summary,
        body: typeof source.body === 'string' ? source.body : '',
        files: asArray(source.files),
        comments: normalizeComments(source.comments),
        checks: normalizeChecks(source.checks),
        stack: normalizeStack(source.stack),
        review: {
          state: typeof review.state === 'string' ? review.state : 'none',
          jobId: review.jobId,
          headSha: typeof review.headSha === 'string' ? review.headSha : '',
          findings: asArray(review.findings),
          overview: typeof review.overview === 'string' ? review.overview : '',
        },
      })
    }

    /** Short one-line summary of a PR state for badges and aria labels. */
    function prStateKey(summary) {
      if (!summary) return 'open'
      if (summary.state === 'closed') return 'closed'
      if (summary.isDraft) return 'draft'
      if (summary.state === 'merged') return 'merged'
      return 'open'
    }

    /** Verdict derived from findings, matching the review card wording. */
    function deriveVerdict(findings) {
      const counts = countSeverities(findings)
      if (counts.P0 > 0 || counts.P1 > 0) return 'request_changes'
      return 'approve'
    }

    // ---------------------------------------------------------------------
    // Transport: one document-relative POST, never throws
    // ---------------------------------------------------------------------

    /**
     * POST a JSON payload to a Host route and decode the {ok, value|error}
     * envelope. Returns {ok:true, value} or {ok:false, error:{code, message}}.
     */
    async function post(path, payload) {
      const controller = typeof AbortController === 'function' ? new AbortController() : null
      const timer =
        controller !== null ? setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS) : null
      try {
        const response = await fetch(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload === undefined ? {} : payload),
          signal: controller !== null ? controller.signal : undefined,
        })
        let envelope = null
        try {
          envelope = await response.json()
        } catch {
          return { ok: false, error: { code: 'INTERNAL', message: '宿主返回了非 JSON 响应。' } }
        }
        if (envelope && envelope.ok === true) return { ok: true, value: envelope.value }
        const error =
          envelope && envelope.error && typeof envelope.error === 'object'
            ? envelope.error
            : { code: 'INTERNAL', message: '宿主响应格式不合法。' }
        return { ok: false, error }
      } catch (error) {
        const aborted = Boolean(
          error && (error.name === 'AbortError' || error.code === 'ABORT_ERR'),
        )
        return {
          ok: false,
          error: {
            code: 'INTERNAL',
            message: aborted ? '请求超时（15 秒），请重试。' : '无法连接宿主路由，请刷新页面后重试。',
          },
        }
      } finally {
        if (timer !== null) clearTimeout(timer)
      }
    }

    // ---------------------------------------------------------------------
    // Styles: every color comes from a --dsw-alias-* token
    // ---------------------------------------------------------------------

    const CSS = `
.cr-root{
  container-type: inline-size;
  --cr-bg: var(--dsw-alias-bg-base);
  --cr-side: color-mix(in srgb, var(--dsw-alias-label-primary) 2.2%, var(--dsw-alias-bg-base));
  --cr-panel: color-mix(in srgb, var(--dsw-alias-label-primary) 4%, var(--dsw-alias-bg-base));
  --cr-card: color-mix(in srgb, var(--dsw-alias-label-primary) 8%, var(--dsw-alias-bg-base));
  --cr-raised: color-mix(in srgb, var(--dsw-alias-label-primary) 14%, var(--dsw-alias-bg-base));
  --cr-hover: color-mix(in srgb, var(--dsw-alias-label-primary) 4.5%, var(--dsw-alias-bg-base));
  --cr-text: var(--dsw-alias-label-primary);
  --cr-text-2: var(--dsw-alias-label-secondary);
  --cr-text-3: var(--dsw-alias-label-tertiary);
  --cr-faint: var(--dsw-alias-label-caption);
  --cr-border: var(--dsw-alias-border-l1);
  --cr-border-2: var(--dsw-alias-border-l2);
  --cr-border-strong: var(--dsw-alias-border-l3);
  --cr-green: var(--dsw-alias-state-success-primary);
  --cr-red: var(--dsw-alias-state-error-primary);
  --cr-orange: var(--dsw-alias-state-warn-primary);
  --cr-yellow: var(--dsw-alias-state-warn-secondary);
  --cr-blue: var(--dsw-alias-state-business-primary);
  --cr-mono: ${MONO};
  display:flex;width:100%;height:100%;min-height:0;min-width:0;overflow:hidden;
  background:var(--cr-bg);color:var(--cr-text);
  font:14px/20px ${SANS};
  -webkit-font-smoothing:antialiased;
}
.cr-root *,.cr-root *::before,.cr-root *::after{box-sizing:border-box}
.cr-root button{font:inherit;color:inherit}
.cr-root ::-webkit-scrollbar{width:6px;height:6px}
.cr-root ::-webkit-scrollbar-thumb{background:var(--dsw-alias-scrollbar-bg-l2);border-radius:3px}
.cr-root ::-webkit-scrollbar-track{background:transparent}
.cr-root :focus-visible{outline:2px solid color-mix(in srgb,var(--cr-green) 70%,transparent);outline-offset:1px}

/* ---------------- left list ---------------- */
.cr-side{flex:0 0 238px;width:238px;display:flex;flex-direction:column;min-height:0;background:var(--cr-side)}
.cr-side-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:14px 12px 6px 18px;flex:none}
.cr-side-title{font-size:21px;line-height:28px;font-weight:700;letter-spacing:-.01em;color:var(--cr-text)}
.cr-search-wrap{padding:8px 14px 10px;flex:none}
.cr-search{display:flex;align-items:center;gap:8px;height:36px;padding:0 7px 0 12px;border-radius:18px;background:var(--cr-card);border:1px solid transparent;color:var(--cr-text-3)}
.cr-search:focus-within{border-color:var(--cr-border-strong)}
.cr-search-icon{flex:none;color:var(--cr-text-3)}
.cr-search input{flex:1;min-width:0;background:transparent;border:0;outline:none;color:var(--cr-text-2);font:inherit;font-size:13px;line-height:18px}
.cr-search input::placeholder{color:var(--cr-text-3)}
.cr-search-clear{flex:none;display:grid;place-items:center;width:19px;height:19px;padding:0;border:0;border-radius:50%;background:var(--cr-raised);color:var(--cr-text);cursor:pointer}
.cr-search-clear:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 22%,var(--cr-bg))}
.cr-list{flex:1;min-height:0;overflow-y:auto;padding:0 10px 16px;display:flex;flex-direction:column;gap:2px}
.cr-row{display:block;width:100%;text-align:left;border:0;border-radius:12px;background:transparent;padding:9px 10px 10px;cursor:pointer;color:inherit}
.cr-row:hover{background:var(--cr-hover)}
.cr-row--active,.cr-row--active:hover{background:var(--cr-card)}
.cr-row-title{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-size:13.5px;line-height:20px;font-weight:500;color:var(--cr-text);overflow-wrap:anywhere}
.cr-row-meta{display:flex;align-items:center;gap:6px;margin-top:6px;font-size:12px;line-height:16px;color:var(--cr-text-3);min-width:0}
.cr-row-author{color:var(--cr-text-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cr-row-sep{color:var(--cr-faint)}
.cr-avatar{flex:none;display:grid;place-items:center;border-radius:50%;background:var(--cr-raised);color:var(--cr-text-2);font-size:9px;font-weight:700;letter-spacing:.02em}
.cr-avatar--16{width:16px;height:16px}
.cr-avatar--22{width:22px;height:22px;font-size:10px}
.cr-badge-draft{margin-left:auto;font-size:10px;font-weight:600;color:var(--cr-text-3);border:1px solid var(--cr-border-strong);border-radius:5px;padding:0 4px;line-height:14px}
.cr-list-state{padding:14px 8px;font-size:13px;line-height:20px;color:var(--cr-text-3)}
.cr-list-state .cr-state-actions{margin-top:10px}

/* ---------------- main ---------------- */
.cr-main{flex:1;min-width:0;min-height:0;display:flex;flex-direction:column;background:var(--cr-bg)}
.cr-toolbar{flex:none;display:flex;align-items:center;gap:12px;height:52px;padding:0 18px 0 26px}
.cr-tabs{display:inline-flex;align-items:center;gap:2px;padding:2px;border-radius:17px;background:var(--cr-card);flex:none}
.cr-tab{display:inline-flex;align-items:center;gap:7px;height:29px;padding:0 13px;border:0;border-radius:15px;background:transparent;color:var(--cr-text-2);font-size:13.5px;font-weight:500;cursor:pointer;white-space:nowrap}
.cr-tab:hover{color:var(--cr-text)}
.cr-tab--active,.cr-tab--active:hover{background:var(--cr-raised);color:var(--cr-text);font-weight:600}
.cr-diffstat{display:inline-flex;align-items:center;gap:7px;font-size:12.5px;font-weight:500;font-variant-numeric:tabular-nums}
.cr-add{color:var(--cr-green)}
.cr-del{color:var(--cr-red)}
.cr-toolbar-spacer{flex:1}
.cr-toolbar-icons{display:flex;align-items:center;gap:2px}
.cr-iconbtn{display:grid;place-items:center;width:30px;height:30px;padding:0;border:0;border-radius:8px;background:transparent;color:var(--cr-text-2);cursor:pointer;text-decoration:none}
.cr-iconbtn:hover{background:var(--cr-hover);color:var(--cr-text)}
.cr-iconbtn[aria-pressed="true"]{color:var(--cr-text);background:var(--cr-hover)}
.cr-review{display:inline-flex;align-items:stretch;height:32px;border-radius:16px;background:var(--cr-card);overflow:hidden;flex:none}
.cr-review-main{display:inline-flex;align-items:center;gap:8px;padding:0 14px;border:0;background:transparent;color:var(--cr-text);font-size:13px;font-weight:500;cursor:pointer;white-space:nowrap}
.cr-review-main:hover{background:var(--cr-raised)}
.cr-review-main:disabled{cursor:default;opacity:.75}
.cr-review-gear{display:grid;place-items:center;width:32px;padding:0;border:0;border-left:1px solid var(--cr-border-strong);background:transparent;color:var(--cr-text);cursor:pointer}
.cr-review-gear:hover{background:var(--cr-raised)}
.cr-btn{display:inline-flex;align-items:center;gap:7px;height:32px;padding:0 14px;border:0;border-radius:16px;background:var(--cr-card);color:var(--cr-text);font-size:13px;font-weight:500;cursor:pointer;white-space:nowrap}
.cr-btn:hover{background:var(--cr-raised)}
.cr-btn:disabled{cursor:not-allowed;opacity:.5}
.cr-btn--merge{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);padding:0 11px 0 13px}
.cr-btn--merge:hover{background:var(--dsw-alias-button-primary-fill)}
.cr-btn--merge:disabled{opacity:1;cursor:not-allowed}
.cr-root .cr-btn--merge{color:var(--dsw-alias-label-primary-foreground)}
.cr-btn--ghost{background:transparent;color:var(--cr-text-2);height:26px;padding:0 9px;font-size:12px;border-radius:6px}
.cr-btn--ghost:hover{background:var(--cr-hover);color:var(--cr-text)}
.cr-btn--primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
.cr-btn--primary:hover{background:var(--dsw-alias-button-primary-hover)}
.cr-spinner{width:13px;height:13px;flex:none;border-radius:50%;border:1.6px solid color-mix(in srgb,currentColor 30%,transparent);border-top-color:currentColor;animation:cr-spin .8s linear infinite}
@keyframes cr-spin{to{transform:rotate(360deg)}}
.cr-health{flex:none;display:flex;align-items:center;gap:8px;padding:7px 18px 7px 26px;font-size:12.5px;color:var(--dsw-alias-state-warn-label);background:color-mix(in srgb,var(--cr-orange) 10%,transparent);border-bottom:1px solid color-mix(in srgb,var(--cr-orange) 20%,transparent)}

/* ---------------- body: doc + details, no divider, same background ---------------- */
.cr-body{flex:1;min-height:0;display:flex;justify-content:center;overflow:hidden}
.cr-cluster{display:flex;gap:44px;width:100%;max-width:1160px;min-height:0;padding:0 20px;justify-content:center}
.cr-doc{width:760px;max-width:100%;min-width:0;min-height:0;overflow-y:auto;padding:4px 0 96px;scrollbar-gutter:stable}
.cr-details{width:300px;flex:none;min-height:0;overflow-y:auto;padding:10px 0 80px}

/* ---------------- pr header ---------------- */
.cr-pr-badges{display:flex;align-items:center;gap:10px;min-height:26px}
.cr-badge{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 10px;border-radius:13px;border:1px solid transparent;font-size:12.5px;font-weight:600;line-height:1;cursor:default}
.cr-badge--open{color:var(--cr-green);background:color-mix(in srgb,var(--cr-green) 10%,transparent);border-color:color-mix(in srgb,var(--cr-green) 26%,transparent)}
.cr-badge--closed{color:var(--cr-red);background:color-mix(in srgb,var(--cr-red) 10%,transparent);border-color:color-mix(in srgb,var(--cr-red) 26%,transparent)}
.cr-badge--merged{color:var(--cr-blue);background:color-mix(in srgb,var(--cr-blue) 10%,transparent);border-color:color-mix(in srgb,var(--cr-blue) 26%,transparent)}
.cr-badge--draft{color:var(--cr-text-2);background:color-mix(in srgb,var(--cr-text-2) 10%,transparent);border-color:color-mix(in srgb,var(--cr-text-2) 26%,transparent)}
.cr-pr-repo{font-size:13px;color:var(--cr-text-2)}
.cr-pr-title{margin:14px 0 0;font-size:27px;line-height:1.33;font-weight:700;letter-spacing:-.015em;color:var(--cr-text);display:flex;align-items:flex-start;gap:10px}
.cr-pr-title-text{flex:1;min-width:0;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}
.cr-pr-edit{flex:none;margin-top:7px;color:var(--cr-faint)}
.cr-pr-meta{display:flex;align-items:center;gap:7px;margin-top:12px;font-size:12.5px;line-height:18px;color:var(--cr-text-2);flex-wrap:wrap;min-width:0}
.cr-pr-author{color:var(--cr-text-2)}
.cr-pr-time{color:var(--cr-text-3)}
.cr-pr-dot{color:var(--cr-faint)}
.cr-branches{display:inline-flex;align-items:center;gap:5px;font-family:var(--cr-mono);font-size:11.5px;color:var(--cr-text-3);min-width:0}
.cr-branch{max-width:190px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* ---------------- markdown ---------------- */
.cr-md{margin-top:22px;font-size:16px;line-height:27px;color:var(--cr-text)}
.cr-md > :first-child{margin-top:0}
.cr-md p{margin:0 0 16px;white-space:pre-wrap;overflow-wrap:anywhere}
.cr-md h2{margin:30px 0 12px;font-size:19.5px;line-height:28px;font-weight:700;letter-spacing:-.01em}
.cr-md h3{margin:24px 0 10px;font-size:17px;line-height:25px;font-weight:700}
.cr-md ul.cr-md-list,.cr-md ol.cr-md-list{list-style:none;margin:0 0 16px;padding:0}
.cr-md-list li{display:flex;gap:9px;margin:0 0 8px;line-height:27px}
.cr-md-marker{flex:none;min-width:17px;text-align:right;font-weight:600;color:var(--cr-text);font-variant-numeric:tabular-nums}
.cr-md-item{flex:1;min-width:0;white-space:pre-wrap;overflow-wrap:anywhere}
.cr-md code{font-family:var(--cr-mono);font-size:12.5px;line-height:19px;background:var(--dsw-alias-markdown-inline-code);color:var(--cr-text);border-radius:4px;padding:2px 5px}
.cr-md pre{margin:0 0 16px;padding:12px 14px;border-radius:6px;background:var(--dsw-alias-markdown-code-block);overflow-x:auto;font-family:var(--cr-mono);font-size:12.5px;line-height:19px}
.cr-md pre code{background:transparent;padding:0;font-size:inherit;border-radius:0}
.cr-md blockquote{margin:0 0 16px;padding:2px 0 2px 14px;border-left:3px solid var(--cr-border-strong);color:var(--cr-text-2)}
.cr-md blockquote p{margin:0 0 8px}
.cr-md a{color:var(--dsw-alias-link);text-decoration:none}
.cr-md a:hover{text-decoration:underline}
.cr-md strong{font-weight:700;color:var(--cr-text)}
.cr-md em{font-style:italic}
.cr-md hr{margin:22px 0;border:0;border-top:1px solid var(--cr-border-2)}
.cr-md-notice{margin-top:10px;font-size:12px;color:var(--cr-text-3)}

/* ---------------- review result card (summary top) ---------------- */
.cr-review-card{margin:20px 0 6px;border:1px solid var(--cr-border-2);border-radius:10px;background:var(--cr-panel);padding:14px 16px 6px}
.cr-review-card-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.cr-review-card-title{display:inline-flex;align-items:center;gap:7px;font-size:14px;font-weight:600;color:var(--cr-text)}
.cr-review-card-meta{display:inline-flex;align-items:center;gap:8px;font-size:12px;color:var(--cr-text-3);flex-wrap:wrap}
.cr-review-card-actions{margin-left:auto;display:inline-flex;gap:6px}
.cr-review-verdict{margin-top:10px;font-size:13px;font-weight:500;color:var(--cr-text-2)}
.cr-review-counts{display:flex;align-items:center;gap:14px;margin-top:10px;padding:9px 0;border-top:1px solid var(--cr-border-2);border-bottom:1px solid var(--cr-border-2);font-size:12px;color:var(--cr-text-3)}
.cr-count{display:inline-flex;align-items:center;gap:6px;font-variant-numeric:tabular-nums}
.cr-count b{font-weight:600;font-size:12.5px}
.cr-count--P0 b{color:var(--cr-red)}
.cr-count--P1 b{color:var(--cr-orange)}
.cr-count--P2 b{color:var(--cr-yellow)}
.cr-review-progress{display:flex;align-items:center;gap:10px;margin-top:10px;font-size:12.5px;color:var(--cr-text-2)}
.cr-review-progress-bar{flex:1;height:3px;border-radius:2px;background:var(--cr-card);overflow:hidden}
.cr-review-progress-fill{height:100%;border-radius:2px;background:var(--cr-green);transition:width .4s ease}
.cr-review-error{margin-top:10px;padding:10px 12px;border-radius:8px;background:color-mix(in srgb,var(--cr-red) 8%,transparent);border:1px solid color-mix(in srgb,var(--cr-red) 22%,transparent);font-size:12.5px;line-height:20px;color:var(--cr-text-2)}
.cr-review-error b{color:var(--cr-red);font-weight:600;margin-right:6px}
.cr-banner{display:flex;align-items:center;gap:8px;margin-top:10px;padding:8px 12px;border-radius:8px;font-size:12.5px;color:var(--cr-text-2);background:color-mix(in srgb,var(--cr-orange) 10%,transparent);border:1px solid color-mix(in srgb,var(--cr-orange) 22%,transparent)}

/* ---------------- findings ---------------- */
.cr-finding{position:relative;margin:12px 0 6px;padding:12px 14px 12px 16px;border-radius:10px;background:var(--cr-card);overflow:hidden}
.cr-finding::before{content:"";position:absolute;left:0;top:0;bottom:0;width:2px;background:var(--cr-sev-color,var(--cr-text-3))}
.cr-finding--P0{--cr-sev-color:var(--cr-red)}
.cr-finding--P1{--cr-sev-color:var(--cr-orange)}
.cr-finding--P2{--cr-sev-color:var(--cr-yellow)}
.cr-finding-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.cr-sev{display:inline-flex;align-items:center;height:18px;padding:0 6px;border-radius:5px;font-size:10.5px;font-weight:700;letter-spacing:.03em;color:var(--cr-sev-color,var(--cr-text-2));background:color-mix(in srgb,var(--cr-sev-color,var(--cr-text-3)) 14%,transparent);border:1px solid color-mix(in srgb,var(--cr-sev-color,var(--cr-text-3)) 30%,transparent)}
.cr-finding-title{margin-top:8px;font-size:14px;line-height:21px;font-weight:600;color:var(--cr-text);overflow-wrap:anywhere}
.cr-finding-loc{display:inline-flex;align-items:center;gap:6px;margin-top:6px;font-family:var(--cr-mono);font-size:11.5px;color:var(--cr-blue)}
.cr-finding-body{margin-top:9px;font-size:13px;line-height:21px;color:var(--cr-text-2);overflow-wrap:anywhere;white-space:pre-wrap}
.cr-finding-label{display:inline-block;margin-right:6px;font-size:11.5px;font-weight:600;color:var(--cr-text);background:var(--cr-card);border-radius:4px;padding:0 5px;line-height:17px}
.cr-finding-actions{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}
.cr-finding-cat{font-size:11px;color:var(--cr-text-3);border:1px solid var(--cr-border-strong);border-radius:4px;padding:0 5px;line-height:16px}

/* ---------------- changes / diff ---------------- */
.cr-changes-head{display:flex;align-items:center;gap:12px;margin:18px 0 12px;font-size:12.5px;color:var(--cr-text-2);flex-wrap:wrap}
.cr-changes-head b{font-weight:600;color:var(--cr-text)}
.cr-changes-head .cr-diffstat{margin-left:2px}
.cr-changes-actions{margin-left:auto;display:flex;gap:6px}
.cr-file{border:1px solid var(--cr-border-2);border-radius:8px;margin-bottom:12px;overflow:hidden;background:var(--cr-bg)}
.cr-file-head{display:flex;align-items:center;gap:8px;width:100%;min-height:38px;padding:5px 10px 5px 8px;border:0;background:var(--cr-hover);cursor:pointer;text-align:left;color:inherit}
.cr-file-head:hover{background:var(--cr-card)}
.cr-chev{flex:none;color:var(--cr-text-3);transition:transform .12s ease}
.cr-file--open .cr-chev{transform:rotate(90deg)}
.cr-file-status{flex:none;font-family:var(--cr-mono);font-size:10px;font-weight:700;width:14px;text-align:center;color:var(--cr-text-3)}
.cr-file-status--added{color:var(--cr-green)}
.cr-file-status--removed{color:var(--cr-red)}
.cr-file-path{display:flex;align-items:baseline;min-width:0;font-family:var(--cr-mono);font-size:12px;line-height:18px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cr-file-dir{color:var(--cr-text-3)}
.cr-file-name{color:var(--cr-text)}
.cr-file-stat{display:inline-flex;align-items:center;gap:7px;margin-left:auto;font-family:var(--cr-mono);font-size:11.5px;font-variant-numeric:tabular-nums;flex:none}
.cr-file-badge{display:inline-flex;align-items:center;gap:4px;height:17px;padding:0 6px;border-radius:9px;font-size:10.5px;font-weight:600;color:var(--cr-text);background:var(--cr-raised)}
.cr-file-badge--P0{color:var(--cr-red);background:color-mix(in srgb,var(--cr-red) 16%,transparent)}
.cr-file-badge--P1{color:var(--cr-orange);background:color-mix(in srgb,var(--cr-orange) 16%,transparent)}
.cr-file-badge--P2{color:var(--cr-yellow);background:color-mix(in srgb,var(--cr-yellow) 16%,transparent)}
.cr-diff{overflow-x:auto;font-family:var(--cr-mono);font-size:12px;line-height:19px;background:var(--cr-bg)}
.cr-diff-row{display:flex;min-width:max-content;align-items:flex-start}
.cr-diff-mark{flex:none;width:14px;display:flex;align-items:center;justify-content:center;align-self:stretch}
.cr-diff-dot{width:5px;height:5px;border-radius:50%;background:var(--cr-sev-color,var(--cr-text-3))}
.cr-diff-dot--P0{--cr-sev-color:var(--cr-red)}
.cr-diff-dot--P1{--cr-sev-color:var(--cr-orange)}
.cr-diff-dot--P2{--cr-sev-color:var(--cr-yellow)}
.cr-diff-gutter{flex:none;display:flex;width:82px;user-select:none}
.cr-diff-ln{width:38px;flex:none;text-align:right;padding-right:7px;color:var(--cr-faint)}
.cr-diff-sign{width:14px;flex:none;text-align:center;color:var(--cr-text-3)}
.cr-diff-code{padding-right:16px;white-space:pre;color:var(--cr-text)}
.cr-diff-row--add{background:var(--dsw-alias-code-diff-added)}
.cr-diff-row--add .cr-diff-sign{color:var(--cr-green)}
.cr-diff-row--add .cr-diff-ln{color:color-mix(in srgb,var(--cr-green) 55%,var(--cr-faint))}
.cr-diff-row--del{background:var(--dsw-alias-code-diff-deleted)}
.cr-diff-row--del .cr-diff-sign{color:var(--cr-red)}
.cr-diff-row--del .cr-diff-ln{color:color-mix(in srgb,var(--cr-red) 55%,var(--cr-faint))}
.cr-diff-hunk{display:flex;gap:10px;padding:1px 12px;background:var(--cr-hover);color:var(--cr-text-3);font-size:11.5px;line-height:18px;min-width:max-content;white-space:pre}
.cr-diff-meta{padding:1px 12px;color:var(--cr-faint);font-size:11px}
.cr-diff-row--target{background:color-mix(in srgb,var(--cr-green) 22%,transparent);transition:background .5s ease}
.cr-diff-empty{padding:14px;font-size:12.5px;color:var(--cr-text-3)}
.cr-diff-more{display:flex;justify-content:center;padding:8px}

/* ---------------- right details column ---------------- */
.cr-sec{padding:14px 0 15px;border-bottom:1px solid var(--cr-border-2)}
.cr-sec--first{padding-top:0;border-top:0}
.cr-sec:last-child{border-bottom:0}
.cr-sec-title{display:flex;align-items:center;gap:6px;font-size:13px;line-height:18px;font-weight:500;color:var(--cr-text-2);min-height:20px}
.cr-sec-title--empty{color:var(--cr-text-3)}
.cr-sec-title-main{flex:1;min-width:0}
.cr-sec-body{margin-top:8px}
.cr-changes-row{display:flex;align-items:center;gap:8px;width:calc(100% + 16px);margin:8px -8px -6px;padding:6px 8px;border:0;border-radius:8px;background:transparent;cursor:pointer;text-align:left;color:inherit}
.cr-changes-row:hover{background:var(--cr-hover)}
.cr-changes-row-icon{flex:none;color:var(--cr-text-3)}
.cr-changes-row-text{font-size:13px;font-weight:500;color:var(--cr-text)}
.cr-stack-item{display:flex;align-items:flex-start;gap:8px;margin-top:9px}
.cr-stack-num{flex:none;display:grid;place-items:center;width:20px;height:20px;border-radius:6px;border:1px solid var(--cr-border-strong);font-size:11px;font-weight:600;color:var(--cr-text-3)}
.cr-stack-num--current{border-color:var(--cr-text);background:var(--cr-text);color:var(--cr-bg)}
.cr-stack-title{flex:1;min-width:0;font-size:13px;line-height:19px;color:var(--cr-text);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}
.cr-stack-title--muted{color:var(--cr-text-3)}
.cr-empty-line{font-size:13px;line-height:20px;color:var(--cr-text-3)}
.cr-comment{margin-top:10px;padding-top:10px;border-top:1px solid var(--cr-border)}
.cr-comment:first-child{margin-top:0;padding-top:0;border-top:0}
.cr-comment-head{display:flex;align-items:center;gap:6px;font-size:11.5px;color:var(--cr-text-3)}
.cr-comment-author{color:var(--cr-text-2);font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cr-comment-body{margin-top:4px;font-size:12.5px;line-height:19px;color:var(--cr-text-2);display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}
.cr-check{display:flex;align-items:center;gap:7px;margin-top:8px;font-size:12.5px;color:var(--cr-text-2)}
.cr-check-dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--cr-text-3)}
.cr-check--success .cr-check-dot{background:var(--cr-green)}
.cr-check--failure .cr-check-dot{background:var(--cr-red)}
.cr-check--pending .cr-check-dot{background:var(--cr-orange)}

/* ---------------- composer (read-only placeholder) ---------------- */
.cr-composer{position:absolute;right:21px;bottom:21px;z-index:3;display:flex;align-items:center;gap:10px;height:43px;padding:0 12px 0 14px;border-radius:22px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 11%,var(--dsw-alias-bg-base));box-shadow:0 8px 24px var(--dsw-alias-bg-mask-2);pointer-events:none}
.cr-composer-plus{color:var(--cr-text-3);display:grid;place-items:center}
.cr-composer-text{font-size:13.5px;color:var(--cr-text-3);white-space:nowrap}
.cr-composer-icons{display:flex;align-items:center;gap:10px;margin-left:10px;color:var(--cr-text-3)}
.cr-composer-send{display:grid;place-items:center;width:27px;height:27px;border-radius:50%;background:color-mix(in srgb,var(--cr-blue) 45%,var(--cr-bg));color:var(--cr-text-3)}

/* ---------------- toast / states ---------------- */
.cr-toast{position:absolute;left:50%;bottom:26px;transform:translateX(-50%);z-index:6;padding:8px 14px;border-radius:8px;background:var(--dsw-alias-toast-bg);color:var(--cr-text);font-size:12.5px;box-shadow:0 8px 24px var(--dsw-alias-bg-mask-2)}
.cr-state{display:flex;flex-direction:column;gap:8px;padding:16px 0;font-size:13px;line-height:20px;color:var(--cr-text-3)}
.cr-state--error{color:var(--cr-text-2)}
.cr-state-title{display:flex;align-items:center;gap:8px;font-size:13.5px;font-weight:500;color:var(--cr-text)}
.cr-state--error .cr-state-title{color:var(--cr-red)}
.cr-state-detail{font-size:12.5px;line-height:20px;color:var(--cr-text-3);overflow-wrap:anywhere}
.cr-state-actions{display:flex;gap:8px;margin-top:2px}
.cr-skeleton{background:var(--dsw-alias-bg-skeleton);border-radius:10px;animation:cr-pulse 1.6s ease-in-out infinite}
@keyframes cr-pulse{0%,100%{opacity:.55}50%{opacity:1}}
.cr-center{display:flex;align-items:center;justify-content:center;min-height:320px;padding:40px 20px}
.cr-center-card{max-width:440px;text-align:left}
.cr-center-title{font-size:15px;font-weight:600;color:var(--cr-text);margin-bottom:6px}
.cr-center-text{font-size:13px;line-height:21px;color:var(--cr-text-3)}
.cr-progress-line{display:flex;align-items:center;gap:8px;padding:10px 0;font-size:12.5px;color:var(--cr-text-3)}

/* ---------------- responsive ---------------- */
@container (max-width: 1180px){
  .cr-details{display:none}
  .cr-cluster{max-width:800px}
  .cr-toolbar-icons{display:none}
}
@container (max-width: 900px){
  .cr-side{display:none}
  .cr-cluster{padding:0 16px}
  .cr-toolbar{height:46px;padding:0 12px}
  .cr-pr-title{font-size:23px}
}
@media (max-width: 1180px){
  .cr-details{display:none}
  .cr-cluster{max-width:800px}
  .cr-toolbar-icons{display:none}
}
@media (max-width: 900px){
  .cr-side{display:none}
  .cr-cluster{padding:0 16px}
  .cr-toolbar{height:46px;padding:0 12px}
  .cr-pr-title{font-size:23px}
}
@media (prefers-reduced-motion: reduce){
  .cr-root *,.cr-root *::before,.cr-root *::after{animation-duration:.001ms!important;animation-iteration-count:1!important;transition-duration:.001ms!important}
}
`

    // ---------------------------------------------------------------------
    // Icons (inline SVG, currentColor; artwork may use literals)
    // ---------------------------------------------------------------------

    const ICON_PATHS = {
      search: ['M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Z', 'M15.5 15.5 20 20'],
      close: ['M6 6l12 12', 'M18 6 6 18'],
      more: ['M6 12h.01', 'M12 12h.01', 'M18 12h.01'],
      refresh: ['M20 12a8 8 0 1 1-2.3-5.6', 'M20 4v5h-5'],
      pin: ['M9.5 4h5l-1 6 3.5 3.5V15H6v-1.5L9.5 10l-1-6Z', 'M12 15v5'],
      link: [
        'M10.5 13.5a4 4 0 0 0 5.7 0l2.3-2.3a4 4 0 0 0-5.7-5.7l-1 1',
        'M13.5 10.5a4 4 0 0 0-5.7 0L5.5 12.8a4 4 0 0 0 5.7 5.7l1-1',
      ],
      github: [
        'M9 19c-4.2 1.4-4.2-2.1-5.9-2.6',
        'M15 21v-3.4c0-.9.1-1.3-.4-1.8 2.6-.3 5.3-1.3 5.3-5.8a4.5 4.5 0 0 0-1.2-3.1 4.2 4.2 0 0 0-.1-3.1s-1-.3-3.4 1.3a11.6 11.6 0 0 0-6.2 0C6.6 3.5 5.6 3.8 5.6 3.8a4.2 4.2 0 0 0-.1 3.1A4.5 4.5 0 0 0 4.3 10c0 4.4 2.6 5.5 5.2 5.8-.5.5-.5 1-.4 1.8V21',
      ],
      gear: [
        'M12 8.6a3.4 3.4 0 1 0 0 6.8 3.4 3.4 0 0 0 0-6.8Z',
        'M12 3v2.1',
        'M12 18.9V21',
        'M3 12h2.1',
        'M18.9 12H21',
        'M5.6 5.6l1.5 1.5',
        'M16.9 16.9l1.5 1.5',
        'M18.4 5.6l-1.5 1.5',
        'M7.1 16.9l-1.5 1.5',
      ],
      merge: ['M7 4v9a4 4 0 0 0 4 4h5', 'M7 4a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z', 'M17 13a2.2 2.2 0 1 0 0 4.4 2.2 2.2 0 0 0 0-4.4Z'],
      chevronRight: ['M9.5 6 15 12l-5.5 6'],
      chevronDown: ['M6 9.5 12 15l6-5.5'],
      external: ['M14 4h6v6', 'M20 4l-8.5 8.5', 'M18 13.5V18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4.5'],
      file: ['M13 3H7.5A1.5 1.5 0 0 0 6 4.5v15A1.5 1.5 0 0 0 7.5 21h9a1.5 1.5 0 0 0 1.5-1.5V8l-5-5Z', 'M13 3v5h5'],
      check: ['M5 12.5l4.4 4.4L19 7.5'],
      comment: ['M20 12a8 8 0 0 1-8 8H5l-1 1V12a8 8 0 1 1 16 0Z'],
      plus: ['M12 5v14', 'M5 12h14'],
      alert: ['M12 4 3 20h18L12 4Z', 'M12 10v4', 'M12 17.3v.2'],
      branch: ['M7 4v9', 'M7 4a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z', 'M7 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z', 'M17 7a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z', 'M17 7v2a4 4 0 0 1-4 4H9'],
      square: ['M4.5 6.5a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2v-11Z', 'M8 10h8', 'M8 14h5'],
      pencil: ['M4 20h4L19.2 8.8a2.2 2.2 0 0 0-3.1-3.1L5 16.8 4 20Z', 'M14.8 7l3.2 3.2'],
      brain: ['M9 4a3 3 0 0 0-3 3 3 3 0 0 0-1 5.8V17a3 3 0 0 0 4 2.8', 'M15 4a3 3 0 0 1 3 3 3 3 0 0 1 1 5.8V17a3 3 0 0 1-4 2.8', 'M12 4v16'],
      mic: ['M12 4a2.5 2.5 0 0 0-2.5 2.5v5a2.5 2.5 0 0 0 5 0v-5A2.5 2.5 0 0 0 12 4Z', 'M6 11a6 6 0 0 0 12 0', 'M12 17v3'],
      arrowUp: ['M12 19V5', 'M6 11l6-6 6 6'],
      clock: ['M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16Z', 'M12 8v4.4l2.8 1.8'],
    }

    /** Small stroked line icon; `name` picks a path set from ICON_PATHS. */
    function Icon(name, size, extra) {
      const paths = ICON_PATHS[name] || ICON_PATHS.square
      const options = extra || {}
      return h(
        'svg',
        {
          width: size || 16,
          height: size || 16,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: options.strokeWidth || 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          style: { display: 'block', flex: 'none', ...(options.style || {}) },
        },
        paths.map((d, index) => h('path', { key: index, d })),
      )
    }

    /** Sidebar entry icon rendered by the host with {size, active}. */
    function PanelIcon(props) {
      const size = props && Number.isFinite(props.size) ? props.size : 20
      const active = Boolean(props && props.active)
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          style: {
            display: 'block',
            color: active
              ? 'var(--dsw-alias-label-primary)'
              : 'var(--dsw-alias-label-secondary)',
          },
        },
        h('path', { d: 'M6 3.2h7.2L19 8.5v11.3a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4.2a1 1 0 0 1 1-1Z' }),
        h('path', { d: 'M13 3.4V9h5.4' }),
        h('path', { d: 'm8.6 14.2 2 2 4-4.2' }),
      )
    }

    // ---------------------------------------------------------------------
    // Shared primitives
    // ---------------------------------------------------------------------

    /** Initial-letter circular avatar used by list rows, meta lines and comments. */
    function Avatar(props) {
      const name = String((props && props.name) || '?')
      const size = props && props.size === 22 ? 22 : 16
      return h(
        'span',
        {
          className: 'cr-avatar cr-avatar--' + size,
          'aria-hidden': 'true',
          title: name,
        },
        name.slice(0, 1).toUpperCase(),
      )
    }

    /** Relative time rendered through the locale face; stable across renders. */
    function RelativeTime(props) {
      const relative = useMemo(
        () => relativeTime(props && props.iso, props && props.now),
        [props && props.iso, props && props.now],
      )
      return h('span', null, formatRelative(relative, props && props.t))
    }

    function EmptyState(props) {
      return h(
        'div',
        { className: 'cr-state' + (props && props.error ? ' cr-state--error' : '') },
        h('div', { className: 'cr-state-title' }, props && props.title ? props.title : ''),
        props && props.text ? h('div', { className: 'cr-state-detail' }, props.text) : null,
        props && props.actions ? h('div', { className: 'cr-state-actions' }, props.actions) : null,
      )
    }

    function ErrorState(props) {
      const error = (props && props.error) || {}
      const t = props && props.t
      return h(
        'div',
        { className: 'cr-state cr-state--error', role: 'alert' },
        h(
          'div',
          { className: 'cr-state-title' },
          Icon('alert', 15),
          h('span', null, (props && props.title) || tx(t, 'detailError')),
        ),
        h(
          'div',
          { className: 'cr-state-detail' },
          String(error.message || '') + (error.code ? ' (' + error.code + ')' : ''),
        ),
        h(
          'div',
          { className: 'cr-state-actions' },
          h(
            'button',
            {
              type: 'button',
              className: 'cr-btn',
              onClick: () => {
                if (props && typeof props.onRetry === 'function') props.onRetry()
              },
            },
            tx(t, 'retry'),
          ),
        ),
      )
    }

    /** Placeholder blocks that keep the layout height while data loads. */
    function Skeleton(props) {
      const rows = (props && props.rows) || 5
      const height = (props && props.height) || 72
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 8, padding: '0 2px' }, 'aria-busy': 'true' },
        Array.from({ length: rows }, (_, index) =>
          h('div', { key: index, className: 'cr-skeleton', style: { height } }),
        ),
      )
    }

    function ProgressLine(props) {
      return h(
        'div',
        { className: 'cr-progress-line', role: 'status' },
        h('span', { className: 'cr-spinner' }),
        h('span', null, (props && props.label) || ''),
      )
    }

    // ---------------------------------------------------------------------
    // Left sidebar: search + PR list
    // ---------------------------------------------------------------------

    function SearchBox(props) {
      const t = props.t
      return h(
        'div',
        { className: 'cr-search' },
        h('span', { className: 'cr-search-icon' }, Icon('search', 15, { strokeWidth: 1.8 })),
        h('input', {
          type: 'text',
          value: props.value,
          placeholder: tx(t, 'searchPlaceholder'),
          'aria-label': tx(t, 'searchLabel'),
          spellCheck: false,
          onChange: (event) => props.onChange(event.target.value),
          onKeyDown: (event) => {
            if (event.key === 'Enter') props.onCommit()
            if (event.key === 'Escape') props.onClear()
          },
        }),
        props.value
          ? h(
              'button',
              {
                type: 'button',
                className: 'cr-search-clear',
                'aria-label': tx(t, 'clearSearch'),
                title: tx(t, 'clearSearch'),
                onClick: props.onClear,
              },
              Icon('close', 11, { strokeWidth: 2 }),
            )
          : null,
      )
    }

    /** One row of the pull request list; the active row is the selected PR. */
    function PrRow(props) {
      const pr = props.pr || {}
      const t = props.t
      const stateKey = prStateKey(pr)
      const active = Boolean(props.active)
      return h(
        'button',
        {
          type: 'button',
          className: 'cr-row' + (active ? ' cr-row--active' : ''),
          'aria-current': active ? 'true' : undefined,
          'data-pr-number': String(pr.number === undefined ? '' : pr.number),
          title: pr.title || '',
          onClick: () => props.onSelect(pr),
        },
        h('span', { className: 'cr-row-title' }, pr.title || '(untitled)'),
        h(
          'span',
          { className: 'cr-row-meta' },
          h(Avatar, { name: pr.author, size: 16 }),
          h('span', { className: 'cr-row-author' }, pr.author || 'unknown'),
          h('span', { className: 'cr-row-sep' }, '·'),
          h(RelativeTime, { iso: pr.updatedAt, t }),
          pr.isDraft ? h('span', { className: 'cr-badge-draft' }, tx(t, 'draft')) : null,
          stateKey === 'closed' ? h('span', { className: 'cr-row-sep' }, '#' + pr.number) : null,
        ),
      )
    }

    function PrList(props) {
      const t = props.t
      const state = props.state || {}
      const items = Array.isArray(state.items) ? state.items : []
      const selectedNumber = props.selectedNumber
      return h(
        'div',
        { className: 'cr-side', 'data-cr-side': 'ready' },
        h(
          'div',
          { className: 'cr-side-head' },
          h('div', { className: 'cr-side-title' }, tx(t, 'panel')),
          h(
            'button',
            {
              type: 'button',
              className: 'cr-iconbtn',
              'aria-label': tx(t, 'refresh'),
              title: tx(t, 'refresh'),
              onClick: props.onRefresh,
            },
            Icon('more', 18, { strokeWidth: 2.4 }),
          ),
        ),
        h(
          'div',
          { className: 'cr-search-wrap' },
          h(SearchBox, {
            value: props.queryInput,
            t,
            onChange: props.onQueryChange,
            onCommit: props.onRefresh,
            onClear: props.onClearQuery,
          }),
        ),
        h(
          'div',
          {
            className: 'cr-list',
            role: 'list',
            'aria-busy': state.state === 'loading' ? 'true' : 'false',
          },
          state.state === 'loading' && items.length === 0
            ? h(Skeleton, { rows: 5, height: 72 })
            : state.state === 'error' && items.length === 0
              ? h(
                  'div',
                  { className: 'cr-list-state' },
                  h(EmptyState, {
                    error: true,
                    title: tx(t, 'listError'),
                    text: ((state.error || {}).message || '') + ' ',
                    t,
                    actions: h(
                      'button',
                      { type: 'button', className: 'cr-btn', onClick: props.onRetry },
                      tx(t, 'retry'),
                    ),
                  }),
                )
              : items.length === 0
                ? h(
                    'div',
                    { className: 'cr-list-state' },
                    h(EmptyState, {
                      title: tx(t, 'listEmpty'),
                      text: tx(t, 'listEmptyHint'),
                      t,
                      actions: h(
                        'button',
                        { type: 'button', className: 'cr-btn', onClick: props.onClearQuery },
                        tx(t, 'clearSearch'),
                      ),
                    }),
                  )
                : items.map((pr) =>
                    h(PrRow, {
                      key: (pr.repo || '') + '#' + pr.number,
                      pr,
                      t,
                      active: selectedNumber !== null && Number(pr.number) === Number(selectedNumber),
                      onSelect: props.onSelect,
                    }),
                  ),
        ),
      )
    }

    // ---------------------------------------------------------------------
    // Main toolbar + PR header
    // ---------------------------------------------------------------------

    function PrStateBadge(props) {
      const t = props.t
      const key = prStateKey(props.summary)
      const label = tx(t, key === 'merged' ? 'merged' : key === 'closed' ? 'closed' : key === 'draft' ? 'draft' : 'open')
      return h(
        'span',
        {
          className: 'cr-badge cr-badge--' + key,
          'data-pr-state': key,
          title: key === 'closed' ? tx(t, 'closed') : undefined,
        },
        Icon(key === 'open' ? 'merge' : key === 'closed' ? 'close' : key === 'merged' ? 'merge' : 'square', 13),
        h('span', null, label),
        h('span', { style: { opacity: 0.75 } }, Icon('chevronDown', 11, { strokeWidth: 2 })),
      )
    }

    function TabBar(props) {
      const t = props.t
      const tabs = ['summary', 'changes']
      const onKeyDown = (event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
        event.preventDefault()
        const next = props.tab === 'summary' ? 'changes' : 'summary'
        props.onChange(next)
      }
      return h(
        'div',
        { className: 'cr-tabs', role: 'tablist', 'aria-label': tx(t, 'summary'), onKeyDown },
        tabs.map((tab) =>
          h(
            'button',
            {
              key: tab,
              type: 'button',
              role: 'tab',
              className: 'cr-tab' + (props.tab === tab ? ' cr-tab--active' : ''),
              'aria-selected': props.tab === tab ? 'true' : 'false',
              'data-tab': tab,
              onClick: () => props.onChange(tab),
            },
            h('span', null, tx(t, tab === 'summary' ? 'summary' : 'changes')),
            tab === 'changes'
              ? h(
                  'span',
                  { className: 'cr-diffstat', 'aria-label': tx(t, 'diffstat') },
                  h('span', { className: 'cr-add' }, '+' + formatNumber(props.additions || 0)),
                  h('span', { className: 'cr-del' }, '−' + formatNumber(props.deletions || 0)),
                )
              : null,
          ),
        ),
      )
    }

    function Toolbar(props) {
      const t = props.t
      const review = props.review || { state: 'none' }
      const busy = review.state === 'preparing' || review.state === 'running'
      let reviewLabel = tx(t, 'reviewWithCodex')
      if (review.state === 'preparing') reviewLabel = tx(t, 'preparing')
      else if (review.state === 'running') reviewLabel = tx(t, 'reviewing')
      return h(
        'div',
        { className: 'cr-toolbar' },
        h(TabBar, {
          tab: props.tab,
          t,
          additions: props.additions,
          deletions: props.deletions,
          onChange: props.onTabChange,
        }),
        h('div', { className: 'cr-toolbar-spacer' }),
        h(
          'div',
          { className: 'cr-toolbar-icons' },
          h(
            'button',
            {
              type: 'button',
              className: 'cr-iconbtn',
              'aria-pressed': props.pinned ? 'true' : 'false',
              'aria-label': props.pinned ? tx(t, 'pinned') : tx(t, 'pin'),
              title: props.pinned ? tx(t, 'pinned') : tx(t, 'pin'),
              onClick: props.onPin,
            },
            Icon('pin', 15),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'cr-iconbtn',
              'aria-label': tx(t, 'copyLink'),
              title: tx(t, 'copyLink'),
              onClick: props.onCopy,
            },
            Icon('link', 15),
          ),
          props.url
            ? h(
                'a',
                {
                  className: 'cr-iconbtn',
                  href: props.url,
                  target: '_blank',
                  rel: 'noopener noreferrer',
                  'aria-label': tx(t, 'openOnGithub'),
                  title: tx(t, 'openOnGithub'),
                  onClick: (event) => {
                    event.preventDefault()
                    if (typeof props.onGithub === 'function') props.onGithub()
                  },
                },
                Icon('github', 15),
              )
            : null,
        ),
        h(
          'div',
          { className: 'cr-review' },
          h(
            'button',
            {
              type: 'button',
              className: 'cr-review-main',
              'data-action': 'review',
              disabled: busy || !props.canReview,
              title: tx(t, 'reviewWithCodex'),
              onClick: props.onReview,
            },
            busy ? h('span', { className: 'cr-spinner' }) : Icon('brain', 15),
            h('span', null, reviewLabel),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'cr-review-gear',
              'data-action': 'review-settings',
              'aria-label': tx(t, 'reviewShort'),
              title: tx(t, 'reviewShort'),
              onClick: props.onGear,
            },
            Icon('gear', 14),
          ),
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'cr-btn cr-btn--merge',
            'data-action': 'merge',
            disabled: true,
            'aria-disabled': 'true',
            title: tx(t, 'mergeDisabled'),
          },
          Icon('merge', 14),
          h('span', null, tx(t, 'merge')),
          Icon('chevronDown', 12, { strokeWidth: 2 }),
        ),
      )
    }

    function PrHeader(props) {
      const t = props.t
      const summary = (props.detail && props.detail.summary) || {}
      const repoName = String(summary.repo || '').split('/').pop() || summary.repo || ''
      const headRef = String(summary.headRefName || '')
      const baseRef = String(summary.baseRefName || '')
      return h(
        'div',
        { className: 'cr-pr-head', 'data-cr-pr-head': 'ready' },
        h(
          'div',
          { className: 'cr-pr-badges' },
          h(PrStateBadge, { summary, t }),
          h(
            'span',
            { className: 'cr-pr-repo' },
            repoName + ' #' + (summary.number === undefined ? '' : summary.number),
          ),
        ),
        h(
          'h1',
          { className: 'cr-pr-title' },
          h('span', { className: 'cr-pr-title-text' }, summary.title || '(untitled)'),
          h('span', { className: 'cr-pr-edit', title: '只读', 'aria-hidden': 'true' }, Icon('pencil', 13)),
        ),
        h(
          'div',
          { className: 'cr-pr-meta' },
          h(Avatar, { name: summary.author, size: 22 }),
          h('span', { className: 'cr-pr-author' }, summary.author || 'unknown'),
          h(RelativeTime, { iso: summary.updatedAt, t }),
          headRef || baseRef ? h('span', { className: 'cr-pr-dot' }, '·') : null,
          headRef
            ? h(
                'span',
                { className: 'cr-branches', title: headRef },
                h('span', { className: 'cr-branch' }, truncateMiddle(headRef, 26)),
              )
            : null,
          headRef && baseRef
            ? h('span', { className: 'cr-pr-dot', 'aria-hidden': 'true' }, '→')
            : null,
          baseRef
            ? h(
                'span',
                { className: 'cr-branches', title: baseRef },
                h('span', { className: 'cr-branch' }, truncateMiddle(baseRef, 26)),
              )
            : null,
        ),
      )
    }

    // ---------------------------------------------------------------------
    // Markdown rendering (self-written; never innerHTML)
    // ---------------------------------------------------------------------

    function InlineCode(props) {
      return h('code', null, props.text)
    }

    /** Render inline tokens produced by tokenizeInline into React elements. */
    function Inline(props) {
      const nodes = useMemo(() => tokenizeInline(props.text), [props.text])
      return h(
        React.Fragment,
        null,
        nodes.map((node, index) => {
          if (node.type === 'code') return h(InlineCode, { key: index, text: node.text })
          if (node.type === 'strong') return h('strong', { key: index }, node.text)
          if (node.type === 'em') return h('em', { key: index }, node.text)
          if (node.type === 'link') {
            const safe = /^https?:\/\//i.test(node.href || '')
            if (!safe) return h(React.Fragment, { key: index }, node.text)
            return h(
              'a',
              { key: index, href: node.href, target: '_blank', rel: 'noopener noreferrer' },
              node.text,
            )
          }
          return h(React.Fragment, { key: index }, node.text)
        }),
      )
    }

    function renderMarkdownBlock(block, key, index) {
      if (!block) return null
      switch (block.type) {
        case 'h2':
          return h('h2', { key }, h(Inline, { text: block.text }))
        case 'h3':
          return h('h3', { key }, h(Inline, { text: block.text }))
        case 'p':
          return h('p', { key }, h(Inline, { text: block.text }))
        case 'quote':
          return h(
            'blockquote',
            { key },
            String(block.text || '')
              .split('\n')
              .map((line, lineIndex) => h('p', { key: lineIndex }, h(Inline, { text: line }))),
          )
        case 'hr':
          return h('hr', { key })
        case 'code':
          return h(
            'pre',
            { key, 'data-lang': block.lang || '' },
            h('code', null, String(block.text || '')),
          )
        case 'list':
          return h(
            'ul',
            { key, className: 'cr-md-list', role: 'list' },
            (block.items || []).map((item, itemIndex) =>
              h(
                'li',
                { key: itemIndex, style: { paddingLeft: (item.depth || 0) * 22 } },
                h(
                  'span',
                  { className: 'cr-md-marker' },
                  item.marker === 'bullet'
                    ? '•'
                    : (item.number === null || item.number === undefined
                        ? itemIndex + 1
                        : item.number) + '.',
                ),
                h('span', { className: 'cr-md-item' }, h(Inline, { text: item.text })),
              ),
            ),
          )
        default:
          return null
      }
    }

    function Markdown(props) {
      const blocks = useMemo(() => tokenizeMarkdown(props.text || ''), [props.text])
      return h(
        'div',
        { className: 'cr-md', 'data-cr-markdown': 'ready' },
        blocks.map((block, index) => renderMarkdownBlock(block, index, index)),
      )
    }
    // ---------------------------------------------------------------------
    // AI review result card (Summary top) + finding items
    // ---------------------------------------------------------------------

    function SeverityBadge(props) {
      const severity = props.severity === 'P0' || props.severity === 'P1' ? props.severity : props.severity === 'P3' ? 'P2' : (props.severity || 'P2')
      return h('span', { className: 'cr-sev cr-finding--' + severity }, severity)
    }

    /** Three-part finding: severity + title, location, why, fix, locate action. */
    function FindingItem(props) {
      const finding = props.finding || {}
      const t = props.t
      const location =
        String(finding.file || '') +
        ':' +
        (finding.line === undefined || finding.line === null ? '?' : finding.line) +
        (finding.lineEnd ? '-' + finding.lineEnd : '')
      return h(
        'div',
        {
          className: 'cr-finding cr-finding--' + (finding.severity || 'P2'),
          'data-finding-id': finding.id || '',
        },
        h(
          'div',
          { className: 'cr-finding-head' },
          h(SeverityBadge, { severity: finding.severity }),
          finding.category
            ? h('span', { className: 'cr-finding-cat' }, String(finding.category))
            : null,
        ),
        h('div', { className: 'cr-finding-title' }, String(finding.title || '')),
        h(
          'div',
          { className: 'cr-finding-loc', title: location },
          Icon('file', 11),
          h('span', null, truncateMiddle(location, 72)),
        ),
        h(
          'div',
          { className: 'cr-finding-body' },
          h('span', { className: 'cr-finding-label' }, tx(t, 'why')),
          String(finding.why || ''),
        ),
        h(
          'div',
          { className: 'cr-finding-body' },
          h('span', { className: 'cr-finding-label' }, tx(t, 'fix')),
          String(finding.fix || ''),
        ),
        h(
          'div',
          { className: 'cr-finding-actions' },
          h(
            'button',
            {
              type: 'button',
              className: 'cr-btn cr-btn--ghost',
              'data-action': 'locate',
              onClick: () => {
                if (typeof props.onLocate === 'function') props.onLocate(finding)
              },
            },
            Icon('external', 12),
            tx(t, 'locate'),
          ),
        ),
      )
    }

    function SeverityCounts(props) {
      const counts = props.counts || countSeverities(props.findings)
      return h(
        'div',
        { className: 'cr-review-counts' },
        h(
          'span',
          { className: 'cr-count cr-count--P0' },
          'P0',
          h('b', null, String(counts.P0)),
        ),
        h(
          'span',
          { className: 'cr-count cr-count--P1' },
          'P1',
          h('b', null, String(counts.P1)),
        ),
        h(
          'span',
          { className: 'cr-count cr-count--P2' },
          'P2',
          h('b', null, String(counts.P2)),
        ),
      )
    }

    function formatElapsed(review) {
      const progress = (review && review.progress) || {}
      const elapsed = Number(progress.elapsedMs)
      if (Number.isFinite(elapsed) && elapsed > 0) return Math.max(1, Math.round(elapsed / 1000))
      const startedAt = Number(progress.startedAt)
      if (Number.isFinite(startedAt) && startedAt > 0) {
        return Math.max(1, Math.round((Date.now() - startedAt) / 1000))
      }
      return 0
    }

    /**
     * The wide review card inserted above the PR body: progress while running,
     * verdict + severity counts + findings once done, message + retry on error.
     */
    function ReviewCard(props) {
      const t = props.t
      const review = props.review || { state: 'none' }
      const state = review.state
      if (state === 'none') return null
      const findings = sortFindings(review.findings)
      const counts = countSeverities(findings)
      const running = state === 'preparing' || state === 'running'
      const progress = review.progress || {}
      const filesTotal = Number(progress.filesTotal) || 0
      const filesDone = Number(progress.filesDone) || 0
      const ratio = filesTotal > 0 ? Math.min(1, filesDone / filesTotal) : 0
      const phaseLabel =
        progress.phase === 'preparing'
          ? tx(t, 'phasePreparing')
          : progress.phase === 'merging'
            ? tx(t, 'phaseMerging')
            : progress.phase === 'done'
              ? tx(t, 'phaseDone')
              : tx(t, 'phaseReviewing')
      const model = review.model && review.model.model ? String(review.model.model) : ''
      const elapsed = formatElapsed(review)
      const verdict = deriveVerdict(findings)
      return h(
        'section',
        { className: 'cr-review-card', 'data-review-state': state, 'aria-busy': running ? 'true' : 'false' },
        h(
          'div',
          { className: 'cr-review-card-head' },
          h('span', { className: 'cr-review-card-title' }, Icon('brain', 15), tx(t, 'reviewResultTitle')),
          running
            ? h(
                'span',
                { className: 'cr-review-card-meta' },
                h('span', { className: 'cr-spinner' }),
                h('span', null, state === 'preparing' ? tx(t, 'preparing') : tx(t, 'reviewing')),
              )
            : null,
          state === 'done'
            ? h(
                'span',
                { className: 'cr-review-card-meta' },
                h('span', null, tx(t, 'reviewDone')),
                elapsed > 0 ? h('span', null, '· ' + elapsed + 's') : null,
                filesTotal > 0
                  ? h('span', null, '· ' + tx(t, 'fileCount', { n: String(filesTotal) }))
                  : null,
                model ? h('span', null, '· ' + model) : null,
                review.partial ? h('span', { className: 'cr-file-badge' }, tx(t, 'reviewPartial')) : null,
              )
            : null,
          state === 'error'
            ? h('span', { className: 'cr-review-card-meta' }, tx(t, 'reviewFailed'))
            : null,
          h(
            'div',
            { className: 'cr-review-card-actions' },
            running
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'cr-btn',
                    'data-action': 'review-cancel',
                    onClick: props.onCancel,
                  },
                  tx(t, 'cancel'),
                )
              : null,
            !running
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'cr-btn',
                    'data-action': 'review-retry',
                    onClick: state === 'error' ? props.onRetry : props.onStart,
                  },
                  tx(t, 'reviewAgain'),
                )
              : null,
          ),
        ),
        running
          ? h(
              'div',
              null,
              h(
                'div',
                { className: 'cr-review-progress' },
                h('span', null, phaseLabel),
                filesTotal > 0
                  ? h('span', null, tx(t, 'filesProgress', { done: filesDone, total: filesTotal }))
                  : null,
                elapsed > 0 ? h('span', null, elapsed + 's') : null,
              ),
              h(
                'div',
                { className: 'cr-review-progress-bar' },
                h('span', {
                  className: 'cr-review-progress-fill',
                  style: { width: Math.max(3, Math.round(ratio * 100)) + '%' },
                }),
              ),
            )
          : null,
        state === 'error'
          ? h(
              'div',
              { className: 'cr-review-error' },
              h('b', null, ((review.error || {}).code || 'INTERNAL') + ' '),
              String((review.error || {}).message || '未知错误'),
            )
          : null,
        state === 'done'
          ? h(
              'div',
              null,
              h(
                'div',
                { className: 'cr-review-verdict' },
                verdict === 'approve' ? tx(t, 'verdictApprove') : tx(t, 'verdictRequestChanges'),
              ),
              h(SeverityCounts, { counts }),
              review.overview ? h('div', { className: 'cr-review-verdict' }, String(review.overview)) : null,
              findings.length === 0
                ? h(
                    'div',
                    { className: 'cr-review-progress' },
                    h('span', null, tx(t, 'reviewClean')),
                    h('span', { style: { color: 'var(--cr-text-3)' } }, tx(t, 'reviewCleanHint')),
                  )
                : findings.map((finding) =>
                    h(FindingItem, {
                      key: finding.id || finding.file + ':' + finding.line,
                      finding,
                      t,
                      onLocate: props.onLocate,
                    }),
                  ),
            )
          : null,
      )
    }

    function SummaryView(props) {
      const detail = props.detail || {}
      const t = props.t
      return h(
        'div',
        { 'data-cr-summary': 'ready' },
        h(ReviewCard, {
          review: props.review,
          t,
          onStart: props.onStartReview,
          onRetry: props.onRetryReview,
          onCancel: props.onCancelReview,
          onLocate: props.onLocate,
        }),
        h(Markdown, { text: detail.body || '' }),
        detail.bodyTruncated
          ? h('div', { className: 'cr-md-notice' }, tx(t, 'bodyTruncated'))
          : null,
        detail.filesTruncated
          ? h('div', { className: 'cr-md-notice' }, tx(t, 'filesTruncated'))
          : null,
      )
    }

    // ---------------------------------------------------------------------
    // Changes tab: file cards + unified diff
    // ---------------------------------------------------------------------

    function fileKey(file, index) {
      return file && typeof file.path === 'string' && file.path !== '' ? file.path : '#' + index
    }

    function DiffView(props) {
      const t = props.t
      const rows = useMemo(() => parseUnifiedDiff(props.patch || ''), [props.patch])
      const [showAll, setShowAll] = useState(false)
      const byLine = useMemo(() => {
        const map = Object.create(null)
        for (const finding of Array.isArray(props.findings) ? props.findings : []) {
          const line = Number(finding && finding.line)
          if (!Number.isFinite(line)) continue
          if (!map[line]) map[line] = []
          map[line].push(finding)
        }
        return map
      }, [props.findings])

      if (rows.length === 0) {
        return h('div', { className: 'cr-diff-empty' }, tx(t, 'emptyDiff'))
      }
      const visible = showAll ? rows : rows.slice(0, MAX_VISIBLE_ROWS)
      const highlightLine = Number.isFinite(Number(props.highlightLine))
        ? Number(props.highlightLine)
        : null
      const children = visible.map((row, index) => {
        if (row.type === 'hunk') {
          return h('div', { key: index, className: 'cr-diff-hunk' }, String(row.text || ''))
        }
        if (row.type === 'meta') {
          return h('div', { key: index, className: 'cr-diff-meta' }, String(row.text || ''))
        }
        const line = row.newLine === null || row.newLine === undefined ? null : Number(row.newLine)
        const marks = line !== null && byLine[line] ? byLine[line] : null
        const isTarget = highlightLine !== null && line === highlightLine
        return h(
          'div',
          {
            key: index,
            className:
              'cr-diff-row cr-diff-row--' +
              row.type +
              (isTarget ? ' cr-diff-row--target' : ''),
            'data-cr-line': line === null ? undefined : String(line),
          },
          h(
            'span',
            { className: 'cr-diff-mark' },
            marks
              ? h('span', {
                  className: 'cr-diff-dot cr-diff-dot--' + (marks[0].severity || 'P2'),
                  title: (marks[0].severity || '') + ' · ' + String(marks[0].title || ''),
                })
              : null,
          ),
          h(
            'span',
            { className: 'cr-diff-gutter' },
            h('span', { className: 'cr-diff-ln' }, row.oldLine === null ? '' : String(row.oldLine)),
            h('span', { className: 'cr-diff-ln' }, row.newLine === null ? '' : String(row.newLine)),
            h(
              'span',
              { className: 'cr-diff-sign' },
              row.type === 'add' ? '+' : row.type === 'del' ? '−' : '',
            ),
          ),
          h('span', { className: 'cr-diff-code' }, row.text === '' ? '\u00a0' : String(row.text)),
        )
      })
      if (rows.length > MAX_VISIBLE_ROWS && !showAll) {
        children.push(
          h(
            'div',
            { key: 'more', className: 'cr-diff-more' },
            h(
              'button',
              { type: 'button', className: 'cr-btn', onClick: () => setShowAll(true) },
              tx(t, 'expandDiff', { n: formatNumber(rows.length) }),
            ),
          ),
        )
      }
      return h('div', { className: 'cr-diff', role: 'table', 'aria-label': 'diff' }, children)
    }

    function FileCard(props) {
      const t = props.t
      const file = props.file || {}
      const path = String(file.path || '')
      const slash = path.lastIndexOf('/')
      const dir = slash >= 0 ? path.slice(0, slash + 1) : ''
      const name = slash >= 0 ? path.slice(slash + 1) : path
      const status = file.status || 'modified'
      const statusLetter =
        status === 'added'
          ? 'A'
          : status === 'removed'
            ? 'D'
            : status === 'renamed'
              ? 'R'
              : status === 'copied'
                ? 'C'
                : status === 'unchanged'
                  ? '≈'
                  : 'M'
      const findings = Array.isArray(props.findings) ? props.findings : []
      const worst =
        findings.length > 0
          ? sortFindings(findings)[0].severity === 'P0'
            ? 'P0'
            : sortFindings(findings)[0].severity === 'P1'
              ? 'P1'
              : 'P2'
          : null
      const key = fileKey(file, props.index)
      return h(
        'section',
        {
          className: 'cr-file' + (props.open ? ' cr-file--open' : ''),
          'data-file-path': key,
          id: 'cr-file-' + props.index,
        },
        h(
          'button',
          {
            type: 'button',
            className: 'cr-file-head',
            'aria-expanded': props.open ? 'true' : 'false',
            'aria-controls': 'cr-file-body-' + props.index,
            'data-file-index': String(props.index),
            onClick: props.onToggle,
          },
          h('span', { className: 'cr-chev' }, Icon('chevronRight', 13, { strokeWidth: 2 })),
          h(
            'span',
            { className: 'cr-file-status cr-file-status--' + status },
            statusLetter,
          ),
          h(
            'span',
            { className: 'cr-file-path', title: path },
            h('span', { className: 'cr-file-dir' }, dir),
            h('span', { className: 'cr-file-name' }, name),
          ),
          findings.length > 0
            ? h(
                'span',
                {
                  className: 'cr-file-badge cr-file-badge--' + (worst || 'P2'),
                  title: tx(t, 'findingsCount', { n: findings.length }),
                },
                Icon('alert', 10),
                String(findings.length),
              )
            : null,
          h(
            'span',
            { className: 'cr-file-stat' },
            h('span', { className: 'cr-add' }, '+' + formatNumber(file.additions || 0)),
            h('span', { className: 'cr-del' }, '−' + formatNumber(file.deletions || 0)),
          ),
        ),
        props.open
          ? h(
              'div',
              { id: 'cr-file-body-' + props.index },
              h(DiffView, {
                patch: file.patch || '',
                findings,
                highlightLine: props.highlightLine,
                t,
              }),
              file.patchTruncated
                ? h('div', { className: 'cr-diff-empty' }, tx(t, 'patchTruncated'))
                : null,
            )
          : null,
      )
    }

    function ChangesView(props) {
      const t = props.t
      const detail = props.detail || {}
      const files = Array.isArray(detail.files) ? detail.files : []
      const summary = detail.summary || {}
      const reportedFiles = Number(summary.changedFiles) || 0
      const findingsByFile = props.findingsByFile || Object.create(null)
      const expanded = props.expanded || Object.create(null)
      const allOpen =
        files.length > 0 && files.every((file, index) => Boolean(expanded[fileKey(file, index)]))
      return h(
        'div',
        { className: 'cr-changes', 'data-cr-changes': 'ready' },
        h(
          'div',
          { className: 'cr-changes-head' },
          h('b', null, tx(t, 'filesChanged', { n: formatNumber(Math.max(files.length, reportedFiles)) })),
          h(
            'span',
            { className: 'cr-diffstat' },
            h('span', { className: 'cr-add' }, '+' + formatNumber(summary.additions || 0)),
            h('span', { className: 'cr-del' }, '−' + formatNumber(summary.deletions || 0)),
          ),
          h(
            'div',
            { className: 'cr-changes-actions' },
            h(
              'button',
              {
                type: 'button',
                className: 'cr-btn cr-btn--ghost',
                'data-action': 'expand-all',
                onClick: () => props.onToggleAll(!allOpen),
              },
              allOpen ? tx(t, 'collapseAll') : tx(t, 'expandAll'),
            ),
          ),
        ),
        files.length === 0
          ? h(EmptyState, { title: tx(t, 'reviewClean'), text: tx(t, 'reviewCleanHint'), t })
          : files.map((file, index) => {
              const key = fileKey(file, index)
              return h(FileCard, {
                key,
                file,
                index,
                t,
                open: Boolean(expanded[key]),
                findings: findingsByFile[key] || [],
                highlightLine: props.highlight && props.highlight.path === key ? props.highlight.line : null,
                onToggle: () => props.onToggleFile(key),
              })
            }),
        detail.filesTruncated
          ? h('div', { className: 'cr-md-notice' }, tx(t, 'filesTruncated'))
          : null,
      )
    }

    // ---------------------------------------------------------------------
    // Right details column
    // ---------------------------------------------------------------------

    function Section(props) {
      return h(
        'section',
        { className: 'cr-sec' + (props.first ? ' cr-sec--first' : '') },
        h(
          'div',
          { className: 'cr-sec-title' + (props.empty ? ' cr-sec-title--empty' : ''), role: 'heading', 'aria-level': 2 },
          h('span', { className: 'cr-sec-title-main' }, props.title),
          props.actions || null,
        ),
        props.children ? h('div', { className: 'cr-sec-body' }, props.children) : null,
      )
    }

    function ChangesSection(props) {
      const t = props.t
      const detail = props.detail || {}
      const summary = detail.summary || {}
      const listed = Array.isArray(detail.files) ? detail.files.length : 0
      const files = listed > 0 ? listed : Number(summary.changedFiles) || 0
      const counts = props.counts || { P0: 0, P1: 0, P2: 0 }
      const findingCount = counts.P0 + counts.P1 + counts.P2
      return h(
        Section,
        { title: tx(t, 'changes'), first: true },
        h(
          'button',
          {
            type: 'button',
            className: 'cr-changes-row',
            'data-action': 'goto-changes',
            onClick: props.onJump,
          },
          h('span', { className: 'cr-changes-row-icon' }, Icon('file', 14)),
          h('span', { className: 'cr-changes-row-text' }, tx(t, 'fileCount', { n: formatNumber(files) })),
          h(
            'span',
            { className: 'cr-diffstat' },
            h('span', { className: 'cr-add' }, '+' + formatNumber(summary.additions || 0)),
            h('span', { className: 'cr-del' }, '−' + formatNumber(summary.deletions || 0)),
          ),
          findingCount > 0
            ? h('span', { className: 'cr-file-badge' }, String(findingCount))
            : null,
        ),
      )
    }

    function StackCard(props) {
      const t = props.t
      const stack = props.stack || {}
      let chain = Array.isArray(stack.chain) ? stack.chain.slice() : []
      if (chain.length === 0 && stack.basePr) {
        chain = [{ number: stack.basePr.number, title: stack.basePr.title, state: stack.basePr.state }]
      }
      if (chain.length === 0) return null
      return h(
        Section,
        { title: tx(t, 'stack') },
        chain.map((item, index) => {
          const current = index === chain.length - 1
          return h(
            'div',
            { key: String(item.number || index), className: 'cr-stack-item' },
            h(
              'span',
              { className: 'cr-stack-num' + (current ? ' cr-stack-num--current' : '') },
              String(index + 1),
            ),
            h(
              'span',
              {
                className: 'cr-stack-title' + (current ? '' : ' cr-stack-title--muted'),
                title: item.title || '',
              },
              String(item.title || '#' + item.number),
            ),
          )
        }),
      )
    }

    function CommentsCard(props) {
      const t = props.t
      const comments = props.comments || {}
      const issue = Array.isArray(comments.issue) ? comments.issue : []
      const inline = Array.isArray(comments.inline) ? comments.inline : []
      const total = Number.isFinite(Number(comments.total))
        ? Number(comments.total)
        : issue.length + inline.length
      if (issue.length === 0 && inline.length === 0) {
        return h(Section, { title: tx(t, 'noComments'), empty: true })
      }
      return h(
        Section,
        { title: tx(t, 'commentsCount', { n: total }) },
        issue.slice(0, 3).map((comment, index) =>
          h(
            'div',
            { key: 'i' + index, className: 'cr-comment' },
            h(
              'div',
              { className: 'cr-comment-head' },
              h(Avatar, { name: comment.author, size: 16 }),
              h('span', { className: 'cr-comment-author' }, String(comment.author || 'unknown')),
              h('span', null, '·'),
              h(RelativeTime, { iso: comment.createdAt, t }),
            ),
            h('div', { className: 'cr-comment-body' }, String(comment.body || '')),
          ),
        ),
        inline.slice(0, 3).map((comment, index) =>
          h(
            'div',
            { key: 'l' + index, className: 'cr-comment' },
            h(
              'div',
              { className: 'cr-comment-head' },
              h('span', { className: 'cr-finding-cat' }, String(comment.path || '') + ':' + comment.line),
            ),
            h('div', { className: 'cr-comment-body' }, String(comment.body || '')),
          ),
        ),
      )
    }

    function ReviewersCard(props) {
      const t = props.t
      const comments = props.comments || {}
      const reviews = Array.isArray(comments.reviews) ? comments.reviews : []
      const decision = props.reviewDecision
      const actions = h(
        'button',
        {
          type: 'button',
          className: 'cr-btn cr-btn--ghost',
          disabled: true,
          'aria-disabled': 'true',
          title: tx(t, 'mergeDisabled'),
          style: { height: 20, padding: 0, width: 20, justifyContent: 'center' },
        },
        Icon('plus', 13),
      )
      if (reviews.length === 0) {
        return h(Section, { title: tx(t, 'noReviewers'), empty: true, actions })
      }
      return h(
        Section,
        { title: tx(t, 'reviewers'), actions },
        reviews.slice(0, 4).map((review, index) =>
          h(
            'div',
            { key: index, className: 'cr-check' },
            h('span', { className: 'cr-check-dot' }),
            h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, String(review.author || '')),
            h('span', { style: { color: 'var(--cr-text-3)', marginLeft: 'auto' } }, String(review.state || '')),
          ),
        ),
        decision ? h('div', { className: 'cr-empty-line' }, String(decision)) : null,
      )
    }

    function ChecksCard(props) {
      const t = props.t
      const checks = props.checks || {}
      const items = Array.isArray(checks.items) ? checks.items : []
      const state = checks.state || 'none'
      if (items.length === 0) {
        return h(Section, { title: tx(t, 'noChecks'), empty: true })
      }
      const failing = items.filter((item) => item && item.state === 'failure').length
      return h(
        Section,
        { title: failing > 0 ? tx(t, 'checksFailing', { n: failing }) : tx(t, 'checks') },
        items.slice(0, 5).map((item, index) =>
          h(
            'div',
            { key: index, className: 'cr-check cr-check--' + String(item.state || 'none') },
            h('span', { className: 'cr-check-dot' }),
            h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, String(item.name || '')),
          ),
        ),
        state ? null : null,
      )
    }

    /** Compact status/controls card for the right column; findings live above. */
    function AiReviewCard(props) {
      const t = props.t
      const review = props.review || { state: 'none' }
      if (review.state === 'none') return null
      const findings = sortFindings(review.findings)
      const counts = countSeverities(findings)
      const running = review.state === 'preparing' || review.state === 'running'
      const progress = review.progress || {}
      const elapsed = formatElapsed(review)
      return h(
        Section,
        { title: tx(t, 'reviewResultTitle') },
        running
          ? h(
              'div',
              null,
              h(
                'div',
                { className: 'cr-review-progress' },
                h('span', { className: 'cr-spinner' }),
                h('span', null, tx(t, 'filesProgress', {
                  done: Number(progress.filesDone) || 0,
                  total: Number(progress.filesTotal) || 0,
                })),
              ),
              h(
                'div',
                { className: 'cr-finding-actions' },
                h(
                  'button',
                  { type: 'button', className: 'cr-btn cr-btn--ghost', onClick: props.onCancel },
                  tx(t, 'cancel'),
                ),
              ),
            )
          : null,
        review.state === 'done'
          ? h(
              'div',
              null,
              h(
                'div',
                { className: 'cr-empty-line', style: { marginBottom: 6 } },
                deriveVerdict(findings) === 'approve'
                  ? tx(t, 'verdictApprove')
                  : tx(t, 'verdictRequestChanges'),
              ),
              h(SeverityCounts, { counts }),
              h(
                'div',
                { className: 'cr-finding-actions' },
                h(
                  'button',
                  { type: 'button', className: 'cr-btn cr-btn--ghost', onClick: props.onStart },
                  tx(t, 'reviewAgain'),
                ),
              ),
            )
          : null,
        review.state === 'error'
          ? h(
              'div',
              null,
              h('div', { className: 'cr-review-error' }, String((review.error || {}).message || '')),
              h(
                'div',
                { className: 'cr-finding-actions' },
                h(
                  'button',
                  { type: 'button', className: 'cr-btn cr-btn--ghost', onClick: props.onStart },
                  tx(t, 'retry'),
                ),
              ),
            )
          : null,
        elapsed > 0 && !running
          ? h('div', { className: 'cr-empty-line', style: { marginTop: 8 } }, elapsed + 's')
          : null,
      )
    }

    function RightPanel(props) {
      const t = props.t
      const detail = props.detail || {}
      const counts = countSeverities(props.review && props.review.findings)
      return h(
        'aside',
        { className: 'cr-details', 'aria-label': 'PR details', 'data-cr-details': 'ready' },
        h(ChangesSection, {
          detail,
          counts,
          t,
          onJump: () => props.onTabChange('changes'),
        }),
        h(StackCard, { stack: detail.stack, t }),
        h(CommentsCard, { comments: detail.comments, t }),
        h(ReviewersCard, {
          comments: detail.comments,
          reviewDecision: (detail.summary || {}).reviewDecision,
          t,
        }),
        h(ChecksCard, { checks: detail.checks, t }),
        h(AiReviewCard, {
          review: props.review,
          t,
          onStart: props.onStartReview,
          onCancel: props.onCancelReview,
        }),
      )
    }

    // ---------------------------------------------------------------------
    // Read-only floating composer placeholder (ui-spec §2.9, disabled in v1)
    // ---------------------------------------------------------------------

    function Composer(props) {
      const t = props.t
      return h(
        'div',
        {
          className: 'cr-composer',
          'aria-hidden': 'true',
          'aria-disabled': 'true',
          title: tx(t, 'askDisabled'),
        },
        h('span', { className: 'cr-composer-plus' }, Icon('plus', 15)),
        h('span', { className: 'cr-composer-text' }, tx(t, 'askPlaceholder')),
        h(
          'span',
          { className: 'cr-composer-icons' },
          Icon('brain', 15),
          Icon('alert', 15),
          Icon('mic', 15),
          h('span', { className: 'cr-composer-send' }, Icon('arrowUp', 13)),
        ),
      )
    }
    // ---------------------------------------------------------------------
    // Page state machine
    // ---------------------------------------------------------------------

    function sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms))
    }

    /** Toast that auto-dismisses; returns [message, show]. */
    function useToast() {
      const [message, setMessage] = useState(null)
      const timerRef = useRef(null)
      const show = useCallback((next) => {
        setMessage(next)
        if (timerRef.current !== null) clearTimeout(timerRef.current)
        timerRef.current = setTimeout(() => setMessage(null), 2000)
      }, [])
      useEffect(
        () => () => {
          if (timerRef.current !== null) clearTimeout(timerRef.current)
        },
        [],
      )
      return [message, show]
    }

    /** Health banner text for a non-ok health snapshot. */
    function healthNotice(health, t) {
      const value = health && health.state === 'ok' ? health.value : null
      if (!value) return null
      if (value.gh === 'missing') return tx(t, 'healthGhMissing')
      if (value.gh === 'not-logged-in') return tx(t, 'healthGhNotLoggedIn')
      if (value.llm === 'unavailable') return tx(t, 'healthLlm')
      return null
    }

    function Workbench(props) {
      const t = props && props.t
      const [health, setHealth] = useState({ state: 'loading', value: null })
      const [queryInput, setQueryInput] = useState(DEFAULT_QUERY)
      const [query, setQuery] = useState(DEFAULT_QUERY)
      const [list, setList] = useState({ state: 'loading', items: [], totalCount: 0, error: null })
      const [selected, setSelected] = useState(null)
      const [detail, setDetail] = useState({ state: 'idle', value: null, error: null })
      const [tab, setTab] = useState('summary')
      const [expanded, setExpanded] = useState({})
      const [highlight, setHighlight] = useState(null)
      const [review, setReview] = useState({ state: 'none' })
      const [pinned, setPinned] = useState(false)
      const [toast, showToast] = useToast()
      const [clock] = useState(() => Date.now())

      const docRef = useRef(null)
      const listGeneration = useRef(0)
      const detailGeneration = useRef(0)
      const reviewGeneration = useRef(0)
      const selectedRef = useRef(null)
      selectedRef.current = selected

      // health: one shot, drives the top notice bar only
      useEffect(() => {
        let alive = true
        post(ROUTE + '/health', {}).then((result) => {
          if (!alive) return
          setHealth(
            result.ok
              ? { state: 'ok', value: result.value || {} }
              : { state: 'error', error: result.error },
          )
        })
        return () => {
          alive = false
        }
      }, [])

      const loadDetail = useCallback((summary) => {
        if (!summary || summary.repo === undefined || summary.number === undefined) return
        const generation = ++detailGeneration.current
        reviewGeneration.current += 1
        setReview({ state: 'none' })
        setDetail((previous) => ({ state: 'loading', value: previous.value, error: null }))
        post(ROUTE + '/pr', { repo: summary.repo, number: summary.number }).then((result) => {
          if (generation !== detailGeneration.current) return
          if (result.ok) {
            const value = normalizePrDetail(result.value)
            setDetail({ state: 'ready', value, error: null })
            const seed = value.review
            if (seed && (seed.state === 'done' || seed.state === 'error')) {
              setReview(Object.assign({}, seed))
            } else if (seed && seed.state === 'running' && seed.jobId) {
              const nextGeneration = ++reviewGeneration.current
              setReview({ state: 'running', jobId: seed.jobId, progress: seed.progress || {} })
              void pollReview(nextGeneration, seed.jobId)
            }
          } else {
            setDetail((previous) => ({ state: 'error', value: previous.value, error: result.error }))
          }
        })
      }, [])

      const selectPr = useCallback(
        (summary) => {
          if (!summary) return
          setSelected(summary)
          setTab('summary')
          setExpanded({})
          setHighlight(null)
          loadDetail(summary)
        },
        [loadDetail],
      )

      // list: debounce the search box, then reload
      useEffect(() => {
        const timer = setTimeout(() => setQuery(queryInput), 300)
        return () => clearTimeout(timer)
      }, [queryInput])

      useEffect(() => {
        const generation = ++listGeneration.current
        setList((previous) => Object.assign({}, previous, { state: 'loading' }))
        post(ROUTE + '/prs', { query }).then((result) => {
          if (generation !== listGeneration.current) return
          if (result.ok) {
            const value = result.value || {}
            const items = Array.isArray(value.items) ? value.items : []
            setList({ state: 'ready', items, totalCount: Number(value.totalCount) || items.length, error: null })
            if (selectedRef.current === null && items.length > 0) selectPr(items[0])
          } else {
            setList((previous) =>
              Object.assign({}, previous, { state: 'error', error: result.error }),
            )
          }
        })
      }, [query, selectPr])

      /** Poll review-status until a terminal state, guarded by a generation counter. */
      const pollReview = useCallback(async (generation, jobId) => {
        while (generation === reviewGeneration.current) {
          await sleep(POLL_MS)
          if (generation !== reviewGeneration.current) return
          const result = await post(ROUTE + '/review-status', { jobId })
          if (generation !== reviewGeneration.current) return
          if (!result.ok) {
            setReview({ state: 'error', error: result.error, jobId })
            return
          }
          const status = result.value || {}
          if (status.state === 'done') {
            setReview({
              state: 'done',
              jobId,
              headSha: status.headSha,
              model: status.model,
              overview: status.overview,
              partial: Boolean(status.partial),
              progress: status.progress || {},
              findings: Array.isArray(status.findings) ? status.findings : [],
            })
            return
          }
          if (status.state === 'error') {
            setReview({
              state: 'error',
              jobId,
              error: status.error || { code: 'INTERNAL', message: '审查失败' },
              progress: status.progress || {},
            })
            return
          }
          if (status.state === 'cancelled') {
            setReview({ state: 'none' })
            return
          }
          setReview((previous) =>
            Object.assign({}, previous, {
              state: 'running',
              jobId,
              headSha: status.headSha,
              model: status.model,
              progress: status.progress || previous.progress || {},
            }),
          )
        }
      }, [])

      const startReview = useCallback(() => {
        const current = selectedRef.current
        if (!current) return
        const generation = ++reviewGeneration.current
        setReview({ state: 'preparing' })
        post(ROUTE + '/review-start', { repo: current.repo, number: current.number }).then(
          (result) => {
            if (generation !== reviewGeneration.current) return
            if (!result.ok) {
              setReview({ state: 'error', error: result.error })
              return
            }
            const jobId = result.value && result.value.jobId
            setReview({
              state: 'running',
              jobId,
              progress: { phase: 'preparing', filesDone: 0, filesTotal: 0, startedAt: Date.now() },
            })
            void pollReview(generation, jobId)
          },
        )
      }, [pollReview])

      const cancelReview = useCallback(() => {
        const current = review
        reviewGeneration.current += 1
        setReview({ state: 'none' })
        if (current && current.jobId) {
          void post(ROUTE + '/review-cancel', { jobId: current.jobId })
        }
      }, [review])

      const locateFinding = useCallback((finding) => {
        if (!finding || typeof finding.file !== 'string') return
        const line = Number(finding.line)
        setTab('changes')
        setExpanded((previous) => Object.assign({}, previous, { [finding.file]: true }))
        setHighlight({ path: finding.file, line: Number.isFinite(line) ? line : null, nonce: Date.now() })
      }, [])

      const toggleFile = useCallback((key) => {
        setExpanded((previous) => Object.assign({}, previous, { [key]: !previous[key] }))
      }, [])

      const toggleAllFiles = useCallback(
        (open) => {
          const value = detail.value || {}
          const files = Array.isArray(value.files) ? value.files : []
          const next = {}
          files.forEach((file, index) => {
            next[fileKey(file, index)] = Boolean(open)
          })
          setExpanded(next)
        },
        [detail.value],
      )

      // scroll the located diff line into view, then fade the highlight out
      useEffect(() => {
        if (!highlight) return undefined
        const scrollTimer = setTimeout(() => {
          const root = docRef.current
          if (!root || typeof root.querySelectorAll !== 'function') return
          const sections = root.querySelectorAll('[data-file-path]')
          let section = null
          for (let index = 0; index < sections.length; index += 1) {
            if (sections[index].getAttribute('data-file-path') === highlight.path) {
              section = sections[index]
              break
            }
          }
          if (!section) return
          const rows = section.querySelectorAll('[data-cr-line]')
          const wanted = String(highlight.line)
          for (let index = 0; index < rows.length; index += 1) {
            if (rows[index].getAttribute('data-cr-line') === wanted) {
              if (typeof rows[index].scrollIntoView === 'function') {
                rows[index].scrollIntoView({ block: 'center' })
              }
              break
            }
          }
        }, 60)
        const clearTimer = setTimeout(() => setHighlight(null), 1600)
        return () => {
          clearTimeout(scrollTimer)
          clearTimeout(clearTimer)
        }
      }, [highlight])

      const copyLink = useCallback(() => {
        const url = selectedRef.current && selectedRef.current.url
        if (!url) return
        const done = () => showToast(tx(t, 'copied'))
        const failed = () => showToast(tx(t, 'copyFailed'))
        try {
          if (
            typeof navigator !== 'undefined' &&
            navigator.clipboard &&
            typeof navigator.clipboard.writeText === 'function'
          ) {
            navigator.clipboard.writeText(url).then(done, failed)
          } else {
            failed()
          }
        } catch {
          failed()
        }
      }, [showToast, t])

      const openGithub = useCallback(() => {
        const url = selectedRef.current && selectedRef.current.url
        if (!url) return
        try {
          window.open(url, '_blank', 'noopener,noreferrer')
        } catch {
          showToast(tx(t, 'copyFailed'))
        }
      }, [showToast, t])

      const notice = healthNotice(health, t)
      const detailValue = detail.value
      const reviewValue = review || { state: 'none' }
      const findings = Array.isArray(reviewValue.findings) ? reviewValue.findings : []
      const findingsByFile = groupFindingsByFile(findings)
      const summary = detailValue && detailValue.summary ? detailValue.summary : selected || {}

      let docBody
      if (!selected && detail.state === 'idle') {
        docBody = h(
          'div',
          { className: 'cr-center' },
          h(
            'div',
            { className: 'cr-center-card' },
            h('div', { className: 'cr-center-title' }, tx(t, 'noSelection')),
            h('div', { className: 'cr-center-text' }, tx(t, 'noSelectionHint')),
          ),
        )
      } else if (!detailValue && detail.state === 'loading') {
        docBody = h(
          'div',
          null,
          h(ProgressLine, { label: tx(t, 'detailLoading') }),
          h(Skeleton, { rows: 3, height: 28 }),
          h('div', { style: { height: 16 } }),
          h(Skeleton, { rows: 4, height: 64 }),
        )
      } else if (!detailValue && detail.state === 'error') {
        docBody = h(ErrorState, {
          error: detail.error,
          title: tx(t, 'detailError'),
          t,
          onRetry: () => loadDetail(selectedRef.current),
        })
      } else {
        docBody = h(
          'div',
          null,
          h(PrHeader, { detail: detailValue || { summary }, t }),
          tab === 'changes'
            ? h(ChangesView, {
                detail: detailValue || {},
                expanded,
                onToggleFile: toggleFile,
                onToggleAll: toggleAllFiles,
                findingsByFile,
                highlight,
                t,
              })
            : h(SummaryView, {
                detail: detailValue || {},
                review: reviewValue,
                onStartReview: startReview,
                onRetryReview: startReview,
                onCancelReview: cancelReview,
                onLocate: locateFinding,
                t,
              }),
          detail.state === 'loading'
            ? h(ProgressLine, { label: tx(t, 'detailLoading') })
            : null,
          detail.state === 'error' && detailValue
            ? h(ErrorState, {
                error: detail.error,
                title: tx(t, 'detailError'),
                t,
                onRetry: () => loadDetail(selectedRef.current),
              })
            : null,
        )
      }

      return h(
        'div',
        {
          className: 'cr-root',
          'data-cr-root': 'ready',
          'data-cr-review-state': reviewValue.state || 'none',
          'data-cr-tab': tab,
          'data-cr-detail': detailValue ? 'ready' : detail.state,
          'data-cr-list': list.state,
          'data-cr-files': detailValue ? String((detailValue.files || []).length) : '0',
        },
        h('style', null, CSS),
        h(PrList, {
          state: list,
          queryInput,
          selectedNumber: selected ? selected.number : null,
          t,
          onSelect: selectPr,
          onQueryChange: setQueryInput,
          onRefresh: () => setQuery(queryInput),
          onRetry: () => setQuery(queryInput + ' '),
          onClearQuery: () => {
            setQueryInput('')
            setQuery('')
          },
        }),
        h(
          'div',
          { className: 'cr-main', 'data-cr-main': 'ready' },
          notice
            ? h(
                'div',
                { className: 'cr-health', role: 'status' },
                Icon('alert', 14),
                h('span', null, notice),
              )
            : null,
          h(Toolbar, {
            tab,
            t,
            additions: summary.additions,
            deletions: summary.deletions,
            pinned,
            url: selected ? selected.url : undefined,
            canReview: Boolean(selected),
            review: reviewValue,
            onTabChange: setTab,
            onPin: () => setPinned((previous) => !previous),
            onCopy: copyLink,
            onGithub: openGithub,
            onReview: startReview,
            onGear: () => showToast(tx(t, 'askDisabled')),
          }),
          h(
            'div',
            { className: 'cr-body' },
            h(
              'div',
              { className: 'cr-cluster' },
              h(
                'div',
                {
                  className: 'cr-doc',
                  ref: docRef,
                  role: 'tabpanel',
                  'aria-label': tab === 'changes' ? tx(t, 'changes') : tx(t, 'summary'),
                },
                docBody,
              ),
              detailValue
                ? h(RightPanel, {
                    detail: detailValue,
                    review: reviewValue,
                    t,
                    onTabChange: setTab,
                    onStartReview: startReview,
                    onCancelReview: cancelReview,
                  })
                : h('aside', { className: 'cr-details', 'aria-hidden': 'true' }),
            ),
          ),
        ),
        h(Composer, { t }),
        toast ? h('div', { className: 'cr-toast', role: 'status' }, String(toast)) : null,
      )
    }

    /** Class boundary so a crash in one render cannot blank the whole slot. */
    class ErrorBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
        this.retry = this.retry.bind(this)
      }

      static getDerivedStateFromError(error) {
        return { error }
      }

      componentDidCatch(error, info) {
        try {
          console.error('[dsh-codex-review] render error', error, info)
        } catch {
          /* logging must never crash the boundary */
        }
      }

      retry() {
        this.setState({ error: null })
      }

      render() {
        if (this.state.error) {
          return h(
            'div',
            { className: 'cr-root' },
            h('style', null, CSS),
            h(
              'div',
              { className: 'cr-center' },
              h(
                'div',
                { className: 'cr-center-card' },
                h(
                  'div',
                  { className: 'cr-center-title' },
                  Icon('alert', 15),
                  ' 界面渲染出错',
                ),
                h('div', { className: 'cr-center-text' }, String(this.state.error.message || this.state.error)),
                h(
                  'div',
                  { className: 'cr-state-actions' },
                  h(
                    'button',
                    { type: 'button', className: 'cr-btn', onClick: this.retry },
                    '重试',
                  ),
                ),
              ),
            ),
          )
        }
        return this.props.children
      }
    }

    /** Root component mounted in the `main` keyed slot. */
    function CodeReviewPage(props) {
      const t = props && props.t
      return h(ErrorBoundary, null, h(Workbench, { t }))
    }

    // ---------------------------------------------------------------------
    // Plugin registration
    // ---------------------------------------------------------------------

    /** Last-resort dictionary lookup when the host locale face is unavailable. */
    function fallbackT(key) {
      return Object.prototype.hasOwnProperty.call(zh, key) ? zh[key] : key
    }

    /** Register both dictionaries, tolerating either host register signature. */
    function registerLocale(locale) {
      try {
        const dispose = locale.register(NS, { en, zh })
        return typeof dispose === 'function' ? dispose : () => {}
      } catch {
        try {
          locale.register(NS, 'en', en)
          const dispose = locale.register(NS, 'zh', zh)
          return typeof dispose === 'function' ? dispose : () => {}
        } catch {
          return () => {}
        }
      }
    }

    function apply(ctx) {
      try {
        ctx.effect(() => registerLocale(ctx.locale), 'codex-review: locale')
      } catch {
        /* a broken locale face must not take the workbench down */
      }
      let t = fallbackT
      try {
        if (ctx.locale && typeof ctx.locale.bind === 'function') {
          const bound = ctx.locale.bind(NS)
          if (typeof bound === 'function') {
            const probe = bound('panel')
            t = typeof probe === 'string' && probe !== '' && probe !== 'panel' ? bound : fallbackT
          }
        }
      } catch {
        t = fallbackT
      }
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 5,
            locale: NS,
            label: () => tx(t, 'panel'),
          },
          PanelIcon,
        ),
      )
      ctx.slots.inject('main', () =>
        ctx.slots.register(
          {
            name: 'main',
            key: PANEL_ID,
            locale: NS,
          },
          CodeReviewPage,
        ),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply,
      __test: {
        NS,
        PANEL_ID,
        ROUTE,
        DEFAULT_QUERY,
        locales: { en, zh },
        tx,
        formatNumber,
        truncateMiddle,
        relativeTime,
        formatRelative,
        severityRank,
        sortFindings,
        countSeverities,
        parseHunkHeader,
        parseUnifiedDiff,
        groupFindingsByFile,
        asArray,
        normalizeComments,
        normalizeChecks,
        normalizeStack,
        normalizePrDetail,
        tokenizeMarkdown,
        tokenizeInline,
        prStateKey,
        deriveVerdict,
        post,
      },
    }
  },
})

