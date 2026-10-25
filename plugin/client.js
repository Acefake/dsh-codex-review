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
    /** Client-side PR detail TTL: revisits render instantly, stale entries refresh in the background. */
    const DETAIL_CACHE_TTL_MS = 120_000
/** Shared empty list so memoized rows keep reference equality on missing data. */
const EMPTY_LIST = Object.freeze([])
    const REQUEST_TIMEOUT_MS = 15000
    // A publish performs several sequential GitHub writes; the Host budgets
    // PUBLISH_TIMEOUT_MS for it, so the browser must wait at least that long.
    const PUBLISH_TIMEOUT_MS = 35000
    const MONO =
      'ui-monospace, "SF Mono", "JetBrains Mono", Consolas, "Liberation Mono", Menlo, monospace'
    const SANS = 'Inter, "PingFang SC", "Microsoft YaHei", system-ui, -apple-system, sans-serif'
    const DEFAULT_QUERY = 'is:open author:@me'
    /** localStorage key for the review-options popover (CONTRACT §4.5.3). */
    const SETTINGS_KEY = 'codex-review:settings'
    /** Valid values for the review-start options this client knows about. */
    const DEPTHS = ['fast', 'standard', 'deep']
    const THRESHOLDS = ['P0', 'P1', 'P2']
    const VERDICTS = ['block', 'changes', 'approve']
    const CONFIDENCES = ['high', 'medium', 'low']
    /** Defaults mirror the Host contract: standard depth, keep every severity, read AGENTS.md. */
    const DEFAULT_SETTINGS = { depth: 'standard', severityThreshold: 'P2', includeGuidelines: true }
    /** Existing GitHub inline comments show at most this many characters (CONTRACT §4.5.2). */
    const COMMENT_PREVIEW_CHARS = 400
    /** A single file patch larger than this is collapsed by default (huge diff guard). */
    const MAX_VISIBLE_ROWS = 1600
    /** Merge methods accepted by /codex-review/merge (CONTRACT §5.1); squash is the default. */
    const MERGE_METHODS = ['squash', 'merge', 'rebase']
    const DEFAULT_MERGE_METHOD = 'squash'
    /** Per-PR chat history (CONTRACT §5.2): localStorage key prefix + caps. */
    const CHAT_KEY_PREFIX = 'codex-review:chat:'
    const CHAT_HISTORY_LIMIT = 20
    const CHAT_REQUEST_MESSAGES = 10
    const CHAT_MESSAGE_CHARS = 4000
    /** Locale keys for the three quick questions shown in an empty chat panel. */
    const CHAT_QUICK_PROMPTS = ['chatSummarize', 'chatRisks', 'chatTest']
    /** v2.1 auto review (CONTRACT §6): polling cadence + config defaults/bounds. */
    const AUTO_REVIEW_POLL_MS = 15000
    const AUTO_REVIEW_RUNNING_POLL_MS = 2000
    const AUTO_REVIEW_RECENT_LIMIT = 20
    const AUTO_REVIEW_INTERVAL_PRESETS = [60, 180, 600]
    const AUTO_REVIEW_INTERVAL_MIN = 60
    const AUTO_REVIEW_INTERVAL_MAX = 3600
    const AUTO_REVIEW_MAX_PER_CYCLE_MIN = 1
    const AUTO_REVIEW_MAX_PER_CYCLE_MAX = 5
    const AUTO_REVIEW_DEFAULT = {
      enabled: false,
      intervalSeconds: 180,
      query: 'is:open author:@me',
      depth: 'fast',
      severityThreshold: 'P2',
      includeGuidelines: true,
      includeDrafts: false,
      maxPerCycle: 2,
    }
    /** v2.2 review publishing (CONTRACT §7.1–§7.3). */
    const PUBLISH_MODES = ['inline', 'summary', 'both']
    const PUBLISH_MIN_SEVERITIES = ['P0', 'P1', 'P2']
    const PUBLISH_MAX_COMMENTS_MIN = 1
    const PUBLISH_MAX_COMMENTS_MAX = 50
    const PUBLISH_DEFAULT_CONFIG = {
      enabled: false,
      mode: 'inline',
      minSeverity: 'P2',
      maxComments: 20,
    }

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
      reviewWithAi: 'Review with AI',
      reviewShort: 'Review',
      reviewSettings: 'Review settings',
      reviewersDisabled: 'Read-only v1: assigning reviewers is not available',
      readOnly: 'Read-only',
      preparing: 'Preparing…',
      reviewing: 'Reviewing…',
      phasePreparing: 'Collecting diff',
      phaseReviewing: 'Analysing changes',
      phaseMerging: 'Merging findings',
      phaseDone: 'Done',
      filesProgress: '{done}/{total} files analysed',
      cancel: 'Cancel',
      reviewAgain: 'Review again',
      aiReviewTitle: 'AI review',
      reviewDone: 'Done',
      reviewClean: 'No blocking findings',
      reviewCleanHint: 'This diff has no P0/P1 issues worth blocking on.',
      reviewFailed: 'Review failed',
      reviewPartial: 'Partial result',
      reviewPartialHint: 'Part of the review did not finish',
      truncatedCalls: '{n} model responses were truncated',
      findingsCount: '{n} findings',
      verdictApprove: 'Approve',
      verdictChanges: 'Needs changes',
      verdictBlock: 'Blocking',
      locate: 'Locate in diff',
      why: 'Why',
      fix: 'Fix',
      noFindings: 'Nothing to fix in this diff',
      comments: 'Comments',
      resolve: 'Resolve',
      resolved: 'Resolved',
      commentsShowMore: 'Show more',
      commentsShowLess: 'Show less',
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
      askPlaceholder: 'Ask about this pull request',
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
      moreFiles: '{n} more files',
      age: 'Age',
      diffstat: 'Diff stat',
      depth: 'Depth',
      depthFast: 'Fast',
      depthStandard: 'Standard',
      depthDeep: 'Deep',
      depthFastHint: 'Fewer, larger chunks — the quickest pass.',
      depthStandardHint: 'Balanced default.',
      depthDeepHint: 'Adds one verification pass over every finding, so it takes longer.',
      severityThreshold: 'Severity threshold',
      thresholdP0: 'P0 only',
      thresholdP1: 'P0 + P1',
      thresholdP2: 'P0–P2 (all)',
      thresholdHint: 'Findings below the threshold are dropped by the host.',
      includeGuidelines: 'Inject repo AGENTS.md guidelines',
      includeGuidelinesHint: 'Reads AGENTS.md or .github/AGENTS.md when the repo has one.',
      settingsNote: 'Saved in the host and shared by manual and automatic reviews.',
      settingsReset: 'Reset',
      close: 'Close',
      settingsSaved: 'Settings saved',
      reviewOptionsSummary: 'Depth {depth} · threshold {threshold}',
      cached: 'cached',
      reviewCached: 'Cache hit: reusing the previous result',
      reusedFiles: '{n} files reused',
      guidelinesLoaded: 'Repo guidelines: {files} ({chars} chars)',
      guidelinesMissing: 'No repo guidelines found',
      guidelinesDisabled: 'Repo guidelines: off',
      filters: 'Filter findings',
      filterAll: 'All',
      noFindingsForFilter: 'No findings with this severity',
      findingsOnLine: 'Line {line} · {n} findings',
      findingsOnLineAria: 'Line {line}, {n} findings, worst severity {severity}',
      inlineFindings: '{n} findings',
      closeCard: 'Collapse findings',
      confidence: 'Confidence',
      confidenceHigh: 'high',
      confidenceMedium: 'medium',
      confidenceLow: 'low',
      evidence: 'Evidence',
      existingComments: 'Existing comments',
      inlineCommentTitle: 'Comment on {path}:{line}',
      inlineCommentFile: 'File-level comment',
      commentTruncated: 'truncated',
      jumpToFile: 'Jump to {name}',
      filesList: 'Files',
      verdictApproveHint: 'No P0/P1 findings',
      verdictChangesHint: 'P1 findings need a second look',
      verdictBlockHint: 'P0 findings block merging',
      keyboardHint: 'j / k switch PR · / search · r review',
      lineLabel: 'line {line}',
      mergeNotAllowed: 'Only open, non-draft pull requests can be merged',
      mergeDraft: 'Draft pull requests cannot be merged',
      mergeClosed: 'This pull request is closed',
      mergeMerged: 'This pull request is already merged',
      mergeDialogTitle: 'Merge pull request',
      mergeRepo: 'Repository',
      mergePrTitle: 'Title',
      mergeTarget: 'Target',
      mergeHeadSha: 'Head commit',
      mergeMethodLabel: 'Merge method',
      mergeSquash: 'Squash',
      mergeSquashHint: 'One commit on the base branch (recommended)',
      mergeCommit: 'Merge commit',
      mergeCommitHint: 'Keep the full history with a merge commit',
      mergeRebase: 'Rebase',
      mergeRebaseHint: 'Replay commits onto the base branch, no merge commit',
      mergeDeleteBranch: 'Delete the source branch after merging',
      mergeDeleteBranchHint: 'Only possible while the branch belongs to this repository',
      mergeRisk: 'This is a write operation: it merges the pull request on GitHub for real.',
      mergeConfirm: 'Confirm merge',
      mergeSubmitting: 'Merging…',
      mergeSuccess: 'Merged as {sha}',
      mergeHeadMoved: 'The pull request has new commits. Refreshed — review and confirm again.',
      mergeConflict: 'GitHub reports merge conflicts; resolve them first',
      mergeForbidden: 'No permission to merge this pull request',
      mergeNotFound: 'Pull request or branch was not found',
      mergeBadRequest: 'The merge request was rejected as invalid',
      mergeUnavailable: 'The merge route is unavailable in this host version',
      mergeBranchWarning: 'Merged, but the source branch could not be deleted: {message}',
      mergeMethodRequired: 'Choose a merge method',
      mergeHeadMissing: 'The current head commit is unknown; refresh the pull request first',
      mergeErrorTitle: 'Merge failed',
      mergeStepConfirm: 'Confirm',
      mergeStepSubmit: 'Submitting',
      chatTitle: 'PR chat',
      chatOpen: 'Open PR chat',
      chatClose: 'Close PR chat',
      chatClear: 'Clear conversation',
      chatCleared: 'Conversation cleared',
      chatStop: 'Stop',
      chatRetry: 'Retry',
      chatSend: 'Send',
      chatInputLabel: 'Ask about this pull request',
      chatEmpty: 'Ask anything about this pull request',
      chatEmptyHint: 'Answers use the PR body, diff and the latest AI review.',
      chatQuick: 'Quick questions',
      chatSummarize: 'Summarize the changes in this PR',
      chatRisks: 'What are the risk points?',
      chatTest: 'How should this be tested?',
      chatThinking: 'Thinking…',
      chatStreaming: 'Answering…',
      chatAssistant: 'AI assistant',
      chatYou: 'You',
      chatErrorTitle: 'Chat failed',
      chatStopped: 'Stopped',
      chatBusy: 'Another chat is still answering; try again shortly',
      chatUnavailable: 'Chat is unavailable in this host version',
      chatNoSelection: 'Select a pull request first',
      chatUnsupported: 'This browser cannot read streaming responses',
      chatHistoryHint: 'Saved in this browser for this pull request',
      autoReview: 'Auto review',
      autoReviewHint: 'Scans open pull requests in the background and reviews new commits. It never writes to GitHub.',
      autoReviewEnabled: 'Enable auto review',
      autoReviewDisabledState: 'Auto review is off',
      autoReviewDisabledBody: 'Enable it in Review settings and the workbench will scan for new PRs / commits on a schedule.',
      autoReviewEnableAction: 'Turn it on',
      autoReviewInterval: 'Interval (seconds)',
      autoReviewIntervalHint: '60–3600 seconds; the minimum is one minute.',
      autoReviewIntervalCustom: 'Custom',
      autoReviewIncludeDrafts: 'Include draft pull requests',
      autoReviewMaxPerCycle: 'Max reviews per cycle',
      autoReviewMaxPerCycleHint: '1–5; the remaining PRs wait for the next cycle.',
      autoReviewQuery: 'Search query',
      autoReviewQueryHint: 'GitHub search syntax; defaults to is:open author:@me.',
      autoReviewStatusOn: 'On',
      autoReviewStatusOff: 'Off',
      autoReviewLastCycle: 'Last check: {time}',
      autoReviewNextCycle: 'Next check: {time}',
      autoReviewNever: 'not yet',
      autoReviewSeen: '{n} PRs checked',
      autoReviewRunning: 'Checking…',
      autoReviewRunNow: 'Check now',
      autoReviewRunStarted: 'Auto review started',
      autoReviewRunAlready: 'A check is already running',
      autoReviewRunDisabled: 'Enable auto review first',
      autoReviewRunFailed: 'Could not start the auto review check',
      autoReviewRecent: 'Recent results',
      autoReviewNoRecent: 'No auto review results yet',
      autoReviewRecentClean: 'No findings',
      autoReviewRecentError: 'Review failed',
      autoReviewMore: '{n} more',
      autoReviewLastError: 'Last check failed: {message}',
      autoReviewUnsupported: 'Auto review is not available in this host version',
      autoReviewUnsupportedHint: 'The plugin version running here has no auto-review route; upgrade the plugin to enable it.',
      autoReviewDoneToast: 'Auto review finished: {pr} · {n} findings',
      autoReviewDoneToastClean: 'Auto review finished: {pr} · no findings',
      autoReviewToastAction: 'Open',
      autoReviewRefresh: 'Refresh auto review status',
      autoReviewSettingsNote: 'Auto review is off by default and never writes to GitHub. Changes are saved immediately.',
      autoReviewSaving: 'Saving…',
      autoReviewConfigFailed: 'Saving auto review settings failed; reverted',
      autoReviewBadgeCount: 'Auto review: {n} findings',
      autoReviewBadgeClean: 'Auto review: no findings',
      autoReviewBadgeError: 'Auto review failed',
      autoReviewCollapse: 'Collapse auto review',
      autoReviewExpand: 'Expand auto review',
      publish: 'Publish to GitHub',
      publishDialogTitle: 'Publish review to GitHub',
      publishRepo: 'Pull request',
      publishHeadSha: 'Reviewed commit',
      publishMode: 'Publish mode',
      publishModeInline: 'Inline comments',
      publishModeInlineHint: 'One review comment per finding, anchored to the diff line.',
      publishModeSummary: 'Summary comment',
      publishModeSummaryHint: 'A single summary review in the PR conversation.',
      publishModeBoth: 'Inline + summary',
      publishModeBothHint: 'Inline comments first, with a summary review as well.',
      publishMinSeverity: 'Minimum severity',
      publishMinSeverityHint: 'Only findings at least this severe are published.',
      publishExpected: 'Estimated comments',
      publishExpectedValue: '{n}',
      publishWarning: 'This is a write operation: it creates a real review (and comments) on this pull request.',
      publishConfirm: 'Publish review',
      publishSubmitting: 'Publishing…',
      publishSuccess: 'Published to GitHub ({n} comments)',
      publishUpdated: 'Review updated on GitHub (no new inline comments)',
      publishUnchanged: 'Nothing changed since the last publish',
      publishPublishedLink: 'Published · view on GitHub',
      publishPublishedBadge: 'Published',
      publishView: 'View',
      publishNotReady: 'Run the AI review first, then publish',
      publishPartial: 'This review is incomplete (some files failed), so it cannot be published. Re-run the review.',
      publishHeadMoved: 'The pull request has new commits; re-run the review, then publish',
      publishUnknown: 'Publish result unknown: GitHub may already have the review. Refresh the pull request before retrying.',
      publishForbidden: 'The GitHub token has no write permission (repo scope required)',
      publishBadRequest: 'The publish request was rejected',
      publishFailed: 'Publishing the review failed',
      publishUnsupported: 'Publishing reviews is not available in this host version',
      publishNoFindings: 'Nothing to publish',
      publishErrorTitle: 'Publish failed',
      autoPublish: 'Publish reviews to GitHub',
      autoPublishHint: 'When enabled, every finished AI review — manual or automatic — is published to its pull request. One PR keeps a single summary review: later reviews update it in place instead of adding a new comment. This writes to GitHub.',
      autoPublishConfirmTitle: 'Enable automatic publishing?',
      autoPublishConfirmBody: 'Finished AI reviews (manual or automatic) will publish to their pull requests. The first review creates one summary review; later reviews update that same review in place, and only newly found inline issues are added. This is a write operation.',
      autoPublishConfirm: 'Enable publishing',
      autoPublishStatusOn: 'Publishing: on',
      autoPublishStatusOff: 'Publishing: off',
      autoPublishMode: 'Publish mode',
      autoPublishMinSeverity: 'Minimum severity',
      autoPublishMaxComments: 'Max comments',
      autoPublishMaxCommentsHint: '1–50 per review.',
      autoPublishNote: 'Automatic publishing is off by default and only applies to future auto reviews.',
      settingsLead: 'Review options apply to the next review you start. Automatic review and publishing are stored on the host.',
      reviewOptions: 'Review options',
      settingsAuto: 'Automatic review and publishing',
      settingsAutoHint: 'Runs in the background on an interval. Publishing keeps one summary review per pull request.',
      settingsStatus: 'Status',
      settingsHealthGh: 'GitHub CLI',
      settingsHealthLlm: 'Model',
      settingsSaved: 'Saved',
      settingsSaveFailed: 'Could not save; try again',
      settingsLoading: 'Loading…',
      settingsLoadFailed: 'Could not load settings. Retry to reconnect.',
      settingsMoved: 'More settings (auto review, publishing, status) live in DSH Settings → Code Review.',
      settingsReviewDesc: 'Shared by manual and automatic reviews. Saved in the host.',
      settingsAutoDesc: 'Scans the query in the background and reviews new commits. Nothing is written to GitHub.',
      settingsPublishDesc: 'Writes finished reviews to GitHub: one summary review per pull request, updated in place. This is a write operation.',
      settingsPluginVersion: 'Plugin version',
      settingsSaving: 'Saving…',
      settingsIntervalHint: '60–3600 s, default 180 s.',
      settingsQueryHint: 'GitHub search syntax, default is:open author:@me.',
      settingsDraftsHint: 'Draft pull requests are skipped by default.',
      settingsMaxPerCycleHint: '1–5 per cycle, default 2.',
      settingsPublishOnHint: 'On: finished reviews are written to GitHub automatically.',
      settingsPublishOffHint: 'Off by default. Enabling applies to future reviews.',
      inlineReply: 'Reply',
      inlineReplyPlaceholder: 'Write a reply…',
      inlineReplySend: 'Send reply',
      inlineResolve: 'Resolve',
      inlineResolved: 'Resolved',
      inlineResolveConfirm: 'Resolve this discussion?',
      inlineResolveYes: 'Resolve',
      writeCancel: 'Cancel',
      writeSending: 'Sending…',
      prComment: 'Comment',
      commentDialogTitle: 'Comment on this pull request',
      commentDialogPlaceholder: 'Write a comment…',
      commentDialogSend: 'Publish comment',
      commentDialogNote: 'This posts a public comment on the pull request and notifies watchers.',
      commentDone: 'Comment published',
      replyDone: 'Reply posted',
      resolveDone: 'Discussion resolved',
      writeFailed: 'GitHub rejected the write request',
      writeForbidden: 'The GitHub token has no write permission (repo scope required)',
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
      reviewWithAi: '用 AI 审查',
      reviewShort: 'AI 审查',
      reviewSettings: '审查设置',
      reviewersDisabled: 'v1 只读，暂不支持指派 reviewer',
      readOnly: '只读',
      preparing: '准备中…',
      reviewing: '审查中…',
      phasePreparing: '收集 diff',
      phaseReviewing: '分析变更',
      phaseMerging: '汇总发现',
      phaseDone: '完成',
      filesProgress: '已分析 {done}/{total} 文件',
      cancel: '取消',
      reviewAgain: '重新审查',
      aiReviewTitle: 'AI 审查',
      reviewDone: '完成',
      reviewClean: '未发现 P0/P1 问题',
      reviewCleanHint: '这次 diff 没有发现需要阻断的问题。',
      reviewFailed: '审查失败',
      reviewPartial: '部分结果',
      reviewPartialHint: '部分内容未能完成审查',
      truncatedCalls: '{n} 次模型输出被截断',
      findingsCount: '{n} 条发现',
      verdictApprove: '建议合并',
      verdictChanges: '需要修改',
      verdictBlock: '阻塞',
      locate: '定位到 diff',
      why: '为什么',
      fix: '怎么改',
      noFindings: '这次的改动没有需要修复的问题',
      comments: '评论',
      resolve: '解决',
      resolved: '已解决',
      commentsShowMore: '显示更多',
      commentsShowLess: '收起',
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
      askPlaceholder: '就此 Pull Request 提问',
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
      moreFiles: '还有 {n} 个文件',
      age: '时间',
      diffstat: '变更统计',
      depth: '审查深度',
      depthFast: '快',
      depthStandard: '标准',
      depthDeep: '深',
      depthFastHint: '分块更大、调用更少，最快。',
      depthStandardHint: '默认，速度与覆盖平衡。',
      depthDeepHint: '每条发现多一轮复核，耗时更长。',
      severityThreshold: '严重度阈值',
      thresholdP0: '仅 P0',
      thresholdP1: 'P0 + P1',
      thresholdP2: 'P0–P2（全部）',
      thresholdHint: '低于阈值的发现会被宿主直接丢弃，不返回给页面。',
      includeGuidelines: '注入仓库 AGENTS.md 审查指引',
      includeGuidelinesHint: '仓库存在 AGENTS.md 或 .github/AGENTS.md 时读取并注入提示词。',
      settingsNote: '审查参数统一由宿主保存，手动与自动审查共用。',
      settingsReset: '恢复默认',
      close: '关闭',
      settingsSaved: '设置已保存',
      reviewOptionsSummary: '深度 {depth} · 阈值 {threshold}',
      cached: '命中缓存',
      reviewCached: '命中缓存，直接复用上次结果',
      reusedFiles: '复用 {n} 个文件',
      guidelinesLoaded: '仓库指引：{files}（{chars} 字）',
      guidelinesMissing: '未找到仓库审查指引',
      guidelinesDisabled: '仓库指引：已关闭',
      filters: '按严重度筛选',
      filterAll: '全部',
      noFindingsForFilter: '没有该严重度的发现',
      findingsOnLine: '第 {line} 行 · {n} 条发现',
      findingsOnLineAria: '第 {line} 行，{n} 条发现，最高 {severity}',
      inlineFindings: '{n} 条发现',
      closeCard: '收起发现',
      confidence: '置信度',
      confidenceHigh: '高',
      confidenceMedium: '中',
      confidenceLow: '低',
      evidence: '证据',
      existingComments: '已有评论',
      inlineCommentTitle: '{path}:{line} 的评论',
      inlineCommentFile: '文件级评论',
      commentTruncated: '已截断',
      jumpToFile: '跳到 {name}',
      filesList: '文件',
      verdictApproveHint: '没有 P0/P1 问题',
      verdictChangesHint: 'P1 问题建议修改后再合并',
      verdictBlockHint: '存在 P0 问题，不建议合并',
      keyboardHint: 'j / k 切换 PR · / 搜索 · r 审查',
      lineLabel: '第 {line} 行',
      mergeNotAllowed: '只有 open 且非草稿的 PR 可以合并',
      mergeDraft: '草稿 PR 不能合并',
      mergeClosed: '该 PR 已关闭',
      mergeMerged: '该 PR 已合并',
      mergeDialogTitle: '合并 Pull Request',
      mergeRepo: '仓库',
      mergePrTitle: '标题',
      mergeTarget: '目标',
      mergeHeadSha: '当前 head',
      mergeMethodLabel: '合并方式',
      mergeSquash: 'Squash',
      mergeSquashHint: '压成一个提交落到目标分支（推荐）',
      mergeCommit: 'Merge commit',
      mergeCommitHint: '保留完整历史，生成合并提交',
      mergeRebase: 'Rebase',
      mergeRebaseHint: '把提交逐个重放到目标分支，不生成合并提交',
      mergeDeleteBranch: '合并后删除源分支',
      mergeDeleteBranchHint: '仅当源分支属于本仓库时可行',
      mergeRisk: '这是写操作：会真的在 GitHub 上合并这个 PR。',
      mergeConfirm: '确认合并',
      mergeSubmitting: '合并中…',
      mergeSuccess: '已合并为 {sha}',
      mergeHeadMoved: 'PR 有新提交，已刷新；请确认最新 head 后重试。',
      mergeConflict: 'GitHub 报告合并冲突，请先解决冲突',
      mergeForbidden: '没有权限合并该 PR',
      mergeNotFound: '找不到该 PR 或分支',
      mergeBadRequest: '合并请求被判定为不合法',
      mergeUnavailable: '当前宿主版本没有合并路由',
      mergeBranchWarning: '已合并，但源分支删除失败：{message}',
      mergeMethodRequired: '请选择合并方式',
      mergeHeadMissing: '当前 head 未知，请先刷新 PR 详情',
      mergeErrorTitle: '合并失败',
      mergeStepConfirm: '确认',
      mergeStepSubmit: '提交中',
      chatTitle: 'PR 对话',
      chatOpen: '打开 PR 对话',
      chatClose: '关闭 PR 对话',
      chatClear: '清空对话',
      chatCleared: '对话已清空',
      chatStop: '停止',
      chatRetry: '重试',
      chatSend: '发送',
      chatInputLabel: '就此 Pull Request 提问',
      chatEmpty: '可以就这个 PR 提问',
      chatEmptyHint: '回答会参考 PR 正文、diff 和最近一次 AI 审查结果。',
      chatQuick: '快捷提问',
      chatSummarize: '总结这个 PR 的改动',
      chatRisks: '有哪些风险点',
      chatTest: '怎么测试',
      chatThinking: '思考中…',
      chatStreaming: '回答中…',
      chatAssistant: 'AI 助手',
      chatYou: '我',
      chatErrorTitle: '对话失败',
      chatStopped: '已停止',
      chatBusy: '已有对话在回答中，请稍后再试',
      chatUnavailable: '当前宿主版本没有对话路由',
      chatNoSelection: '请先选择一个 PR',
      chatUnsupported: '当前浏览器无法读取流式响应',
      chatHistoryHint: '本机缓存，仅对该 PR 生效',
      autoReview: '自动审查',
      autoReviewHint: '后台定时扫描开放 PR，发现新提交时自动审查；不会向 GitHub 写任何内容。',
      autoReviewEnabled: '开启自动审查',
      autoReviewDisabledState: '自动审查已关闭',
      autoReviewDisabledBody: '在「审查设置」里开启后，工作台会按间隔自动扫描新 PR / 新提交。',
      autoReviewEnableAction: '去开启',
      autoReviewInterval: '检查间隔（秒）',
      autoReviewIntervalHint: '60–3600 秒，最小 1 分钟。',
      autoReviewIntervalCustom: '自定义',
      autoReviewIncludeDrafts: '包含草稿 PR',
      autoReviewMaxPerCycle: '每轮最多审查',
      autoReviewMaxPerCycleHint: '1–5 个；其余留到下一轮。',
      autoReviewQuery: '查询语句',
      autoReviewQueryHint: 'GitHub 搜索语法，默认 is:open author:@me。',
      autoReviewStatusOn: '已开启',
      autoReviewStatusOff: '已关闭',
      autoReviewLastCycle: '上次检查：{time}',
      autoReviewNextCycle: '下次检查：{time}',
      autoReviewNever: '尚未检查',
      autoReviewSeen: '已审查 {n} 个 PR',
      autoReviewRunning: '检查中…',
      autoReviewRunNow: '立即检查',
      autoReviewRunStarted: '已开始检查',
      autoReviewRunAlready: '已有检查在进行中',
      autoReviewRunDisabled: '请先开启自动审查',
      autoReviewRunFailed: '无法启动自动检查',
      autoReviewRecent: '最近结果',
      autoReviewNoRecent: '还没有自动审查结果',
      autoReviewRecentClean: '未发现问题',
      autoReviewRecentError: '审查失败',
      autoReviewMore: '还有 {n} 条',
      autoReviewLastError: '最近一次检查失败：{message}',
      autoReviewUnsupported: '宿主未启用自动审查',
      autoReviewUnsupportedHint: '当前插件版本没有自动审查路由；升级插件后可用。',
      autoReviewDoneToast: '自动审查完成：{pr} · {n} 个问题',
      autoReviewDoneToastClean: '自动审查完成：{pr} · 未发现问题',
      autoReviewToastAction: '查看',
      autoReviewRefresh: '刷新自动审查状态',
      autoReviewSettingsNote: '自动审查默认关闭，且不会向 GitHub 写任何内容；改动会立即保存。',
      autoReviewSaving: '保存中…',
      autoReviewConfigFailed: '自动审查设置保存失败，已回滚',
      autoReviewBadgeCount: '自动审查：{n} 个问题',
      autoReviewBadgeClean: '自动审查：未发现问题',
      autoReviewBadgeError: '自动审查失败',
      autoReviewCollapse: '收起自动审查',
      autoReviewExpand: '展开自动审查',
      publish: '发布到 GitHub',
      publishDialogTitle: '发布审查到 GitHub',
      publishRepo: 'Pull Request',
      publishHeadSha: '已审查的提交',
      publishMode: '发布方式',
      publishModeInline: '行内评论',
      publishModeInlineHint: '每条发现挂到对应的 diff 行上。',
      publishModeSummary: '汇总评论',
      publishModeSummaryHint: '在 PR 会话里发一条汇总 review。',
      publishModeBoth: '行内 + 汇总',
      publishModeBothHint: '以行内评论为主，同时发一条汇总。',
      publishMinSeverity: '最低严重度',
      publishMinSeverityHint: '只发布不弱于该级别的问题。',
      publishExpected: '预计评论数',
      publishExpectedValue: '{n} 条',
      publishWarning: '这是写操作：会真的在这个 PR 上创建 review 评论，并可能通知订阅者。',
      publishConfirm: '确认发布',
      publishSubmitting: '发布中…',
      publishSuccess: '已发布到 GitHub（{n} 条评论）',
      publishUpdated: '已更新 GitHub 上的审查（没有新增行内评论）',
      publishUnchanged: '和上次发布相比没有变化',
      publishPublishedLink: '已发布 · 在 GitHub 查看',
      publishPublishedBadge: '已发布',
      publishView: '查看',
      publishNotReady: '请先运行一次 AI 审查再发布',
      publishPartial: '这次审查没有完成全部文件，结果不完整，不能发布；请重新审查后再试',
      publishHeadMoved: 'PR 已有新提交，请重新审查后再发布',
      publishUnknown: '发布结果未知：GitHub 可能已经写入，请刷新 PR 确认后再决定是否重试',
      publishForbidden: '当前 GitHub token 没有写权限（需要 repo scope）',
      publishBadRequest: '发布请求被判定为不合法',
      publishFailed: '发布审查失败',
      publishUnsupported: '当前宿主版本不支持发布审查',
      publishNoFindings: '没有可发布的问题',
      publishErrorTitle: '发布失败',
      autoPublish: '发布审查到 GitHub',
      autoPublishHint: '开启后，AI 审查（手动点「用 AI 审查」或自动审查）完成后会自动把结果发布到对应 PR。一个 PR 只保留一条汇总 review：之后的审查原地更新它，不会每次新增评论；只有新发现的行内问题会单独补发。这会写入 GitHub。',
      autoPublishConfirmTitle: '确认开启自动发布？',
      autoPublishConfirmBody: '开启后，完成的 AI 审查（手动或自动）会发布到对应 PR：首次审查创建一条汇总 review，之后原地更新同一条；只有新发现的行内问题会补发。这是写操作。',
      autoPublishConfirm: '确认开启',
      autoPublishStatusOn: '发布：已开启',
      autoPublishStatusOff: '发布：已关闭',
      autoPublishMode: '发布方式',
      autoPublishMinSeverity: '最低严重度',
      autoPublishMaxComments: '最多评论数',
      autoPublishMaxCommentsHint: '每次 review 1–50 条。',
      autoPublishNote: '自动发布默认关闭；开启后对之后的手动与自动审查都生效。',
      settingsLead: '手动与自动审查共用一套参数，统一由宿主保存。',
      reviewOptions: '审查选项',
      settingsAuto: '自动审查与发布',
      settingsAutoHint: '后台按间隔扫描；发布会为每个 PR 保留一条汇总 review。',
      settingsStatus: '状态',
      settingsHealthGh: 'GitHub CLI',
      settingsHealthLlm: '模型',
      settingsSaved: '已保存',
      settingsSaveFailed: '保存失败，请重试',
      settingsLoading: '加载中…',
      settingsLoadFailed: '设置读取失败，请重试。',
      settingsMoved: '更多设置（自动审查、发布、状态）已移到 DSH 设置 → 代码审查。',
      settingsReviewDesc: '手动与自动审查共用，统一保存在宿主。',
      settingsAutoDesc: '后台按查询扫描新提交并自动审查；不会向 GitHub 写入任何内容。',
      settingsPublishDesc: '把完成的审查写入 GitHub：每个 PR 保留一条汇总 review，后续原地更新。这是写操作。',
      settingsPluginVersion: '插件版本',
      settingsSaving: '保存中…',
      settingsIntervalHint: '60–3600 秒，默认 180 秒。',
      settingsQueryHint: 'GitHub 搜索语法，默认 is:open author:@me。',
      settingsDraftsHint: '默认跳过草稿 PR。',
      settingsMaxPerCycleHint: '每轮 1–5 个，默认 2。',
      settingsPublishOnHint: '已开启：审查完成后会自动写入 GitHub。',
      settingsPublishOffHint: '默认关闭；开启后对之后的审查生效。',
      inlineReply: '回复',
      inlineReplyPlaceholder: '写一条回复…',
      inlineReplySend: '发送回复',
      inlineResolve: '解决',
      inlineResolved: '已解决',
      inlineResolveConfirm: '确认解决这条讨论？',
      inlineResolveYes: '确认解决',
      writeCancel: '取消',
      writeSending: '发送中…',
      prComment: '评论',
      commentDialogTitle: '就此 Pull Request 发表评论',
      commentDialogPlaceholder: '写一条评论…',
      commentDialogSend: '发表评论',
      commentDialogNote: '这会在 PR 上发布公开评论并通知关注者。',
      commentDone: '评论已发布',
      replyDone: '回复已发送',
      resolveDone: '讨论已解决',
      writeFailed: 'GitHub 拒绝了这次写入',
      writeForbidden: '当前 GitHub token 没有写权限（需要 repo scope）',
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
      return Object.assign({}, source, {
        summary,
        body: typeof source.body === 'string' ? source.body : '',
        files: asArray(source.files),
        comments: normalizeComments(source.comments),
        checks: normalizeChecks(source.checks),
        stack: normalizeStack(source.stack),
        review: normalizeReviewStatus(source.review),
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

    /** Verdict derived from findings (CONTRACT §4.2): P0 -> block, P1 -> changes, else approve. */
    function deriveVerdict(findings) {
      const counts = countSeverities(findings)
      if (counts.P0 > 0) return 'block'
      if (counts.P1 > 0) return 'changes'
      return 'approve'
    }

    /** Host verdict when present and valid, otherwise the local derivation. */
    function reviewVerdict(value) {
      const source = value && typeof value === 'object' ? value : {}
      if (VERDICTS.indexOf(source.verdict) >= 0) return source.verdict
      return deriveVerdict(source.findings)
    }

    /** Coerce the settings blob stored in localStorage into a usable shape. */
    function normalizeSettings(value) {
      const source = value && typeof value === 'object' ? value : {}
      return {
        depth: DEPTHS.indexOf(source.depth) >= 0 ? source.depth : DEFAULT_SETTINGS.depth,
        severityThreshold:
          THRESHOLDS.indexOf(source.severityThreshold) >= 0
            ? source.severityThreshold
            : DEFAULT_SETTINGS.severityThreshold,
        includeGuidelines:
          source.includeGuidelines === undefined
            ? DEFAULT_SETTINGS.includeGuidelines
            : Boolean(source.includeGuidelines),
      }
    }

    /** True when the value carries the fields a settings popover writes. */
    function hasSettingsFields(value) {
      return Boolean(
        value &&
          typeof value === 'object' &&
          (value.depth !== undefined ||
            value.severityThreshold !== undefined ||
            value.includeGuidelines !== undefined),
      )
    }

    /** localStorage read that never throws (private mode / disabled storage). */
    function readSettings(store) {
      try {
        if (!store || typeof store.getItem !== 'function') return normalizeSettings(null)
        const raw = store.getItem(SETTINGS_KEY)
        if (typeof raw !== 'string' || raw === '') return normalizeSettings(null)
        return normalizeSettings(JSON.parse(raw))
      } catch {
        return normalizeSettings(null)
      }
    }

    /** localStorage write that never throws; returns whether it persisted. */
    function writeSettings(store, settings) {
      const normalized = normalizeSettings(settings)
      try {
        if (!store || typeof store.setItem !== 'function') return false
        store.setItem(SETTINGS_KEY, JSON.stringify(normalized))
        return true
      } catch {
        return false
      }
    }

    /** The browser localStorage object, or null when unavailable (private mode / stub). */
    function localStore() {
      try {
        if (typeof localStorage !== 'undefined' && localStorage) return localStorage
      } catch {
        /* accessing localStorage can throw when storage is disabled */
      }
      return null
    }

    /** The subset of settings review-start accepts as `options` (CONTRACT §4.1). */
    function settingsToOptions(settings) {
      const normalized = normalizeSettings(settings)
      return {
        depth: normalized.depth,
        severityThreshold: normalized.severityThreshold,
        includeGuidelines: normalized.includeGuidelines,
      }
    }

    /** Coerce ResolvedReviewOptions (host echo) into display-safe shape. */
    function normalizeReviewOptions(value) {
      const source = value && typeof value === 'object' ? value : {}
      const settings = normalizeSettings(hasSettingsFields(source) ? source : null)
      const budget = (name) => {
        const number = Number(source[name])
        return Number.isFinite(number) && number > 0 ? number : 0
      }
      return {
        depth: settings.depth,
        severityThreshold: settings.severityThreshold,
        includeGuidelines: settings.includeGuidelines,
        chunkChars: budget('chunkChars'),
        maxChunks: budget('maxChunks'),
        concurrency: budget('concurrency'),
      }
    }

    /** Coerce the AGENTS.md injection report; absence means "not loaded". */
    function normalizeGuidelines(value) {
      const source = value && typeof value === 'object' ? value : {}
      const files = asArray(source.files)
        .map((file) => String(file === null || file === undefined ? '' : file).trim())
        .filter(Boolean)
      const chars = Number(source.chars)
      return {
        loaded: Boolean(source.loaded),
        files,
        chars: Number.isFinite(chars) && chars > 0 ? Math.round(chars) : 0,
      }
    }

    /** Coerce one Finding, tolerating older Host payloads without the v1.1 extras. */
    function normalizeFinding(value) {
      const source = value && typeof value === 'object' ? value : {}
      const line = Number(source.line)
      const lineEnd = Number(source.lineEnd)
      const evidence = typeof source.evidence === 'string' ? source.evidence : ''
      return {
        id: typeof source.id === 'string' ? source.id : '',
        severity: source.severity === 'P0' || source.severity === 'P1' || source.severity === 'P2'
          ? source.severity
          : 'P2',
        file: typeof source.file === 'string' ? source.file : '',
        line: Number.isFinite(line) && line > 0 ? line : null,
        lineEnd: Number.isFinite(lineEnd) && lineEnd > 0 ? lineEnd : null,
        title: typeof source.title === 'string' ? source.title : '',
        why: typeof source.why === 'string' ? source.why : '',
        fix: typeof source.fix === 'string' ? source.fix : '',
        category: typeof source.category === 'string' ? source.category : '',
        evidence: evidence.slice(0, 240),
        confidence: CONFIDENCES.indexOf(source.confidence) >= 0 ? source.confidence : '',
      }
    }

    /**
     * Normalize a ReviewStatus / PrDetail.review payload. Every v1.1 field is
     * optional so an older Host keeps working with a degraded card.
     */
    function normalizeReviewStatus(value) {
      const source = value && typeof value === 'object' ? value : {}
      const progress = source.progress && typeof source.progress === 'object' ? source.progress : {}
      const reusedFiles = Number(source.reusedFiles)
      const options = hasSettingsFields(source.options) || (source.options && source.options.chunkChars !== undefined)
        ? normalizeReviewOptions(source.options)
        : null
      const guidelinesPresent = source.guidelines && typeof source.guidelines === 'object'
      const error = source.error && typeof source.error === 'object' ? source.error : null
      return {
        state: typeof source.state === 'string' && source.state !== '' ? source.state : 'none',
        jobId: typeof source.jobId === 'string' ? source.jobId : undefined,
        headSha: typeof source.headSha === 'string' ? source.headSha : '',
        model: source.model && typeof source.model === 'object' ? source.model : null,
        overview: typeof source.overview === 'string' ? source.overview : '',
        findings: asArray(source.findings).map(normalizeFinding),
        partial: Boolean(source.partial),
        partialReasons: asArray(source.partialReasons).map((item) => String(item)),
        truncatedCalls: Number(source.truncatedCalls) || 0,
        progress,
        error,
        cached: Boolean(source.cached),
        reusedFiles: Number.isFinite(reusedFiles) && reusedFiles > 0 ? Math.round(reusedFiles) : 0,
        options,
        guidelines: guidelinesPresent ? normalizeGuidelines(source.guidelines) : null,
        published: normalizePublished(source.published || source.publishRecord || null),
        verdict: VERDICTS.indexOf(source.verdict) >= 0 ? source.verdict : null,
      }
    }

    /** Findings that hit one exact new-file line, keyed path -> line -> findings. */
    function groupFindingsByLine(findings) {
      const map = Object.create(null)
      for (const finding of asArray(findings)) {
        if (!finding || typeof finding.file !== 'string' || finding.file === '') continue
        const line = Number(finding.line)
        if (!Number.isFinite(line) || line <= 0) continue
        let byLine = map[finding.file]
        if (!byLine) {
          byLine = Object.create(null)
          map[finding.file] = byLine
        }
        if (!byLine[line]) byLine[line] = []
        byLine[line].push(finding)
      }
      return map
    }

    /** Coerce PrDetail.comments.inline into the read-only comment shape. */
    function normalizeInlineComments(value) {
      const list = []
      for (const entry of asArray(value)) {
        if (!entry || typeof entry !== 'object') continue
        const path = typeof entry.path === 'string' ? entry.path : ''
        if (path === '') continue
        const line = Number(entry.line)
        list.push({
          id: Number.isInteger(entry.id) && entry.id > 0 ? entry.id : null,
          inReplyToId: Number.isInteger(entry.inReplyToId) && entry.inReplyToId > 0 ? entry.inReplyToId : null,
          threadId: typeof entry.threadId === 'string' ? entry.threadId : '',
          isResolved: entry.isResolved === true,
          path,
          line: Number.isFinite(line) && line > 0 ? line : null,
          body: typeof entry.body === 'string' ? entry.body : '',
          author: typeof entry.author === 'string' && entry.author !== '' ? entry.author : 'unknown',
          avatarUrl: typeof entry.avatarUrl === 'string' ? entry.avatarUrl : '',
          createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : '',
        })
      }
      return list
    }

    /** Pull the severity prefix out of a published finding body: "**[P1] title**". */
    function parseFindingLine(body) {
      const value = String(body || '').trim()
      const bold = value.match(/^\*\*\s*\[?(P[0-3])\]?\s*([^\n*]+?)\s*\*\*/)
      if (bold) return { severity: bold[1], title: bold[2] }
      const plain = value.match(/^\[?(P[0-3])\]?\s*[-—:]?\s*([^\n]+)/)
      if (plain) return { severity: plain[1], title: plain[2].trim() }
      const first = value.split('\n')[0].trim()
      return { severity: '', title: first.length > 80 ? first.slice(0, 79) + '…' : first }
    }

    /** Group inline comments into threads: the root comment (no parent) plus replies. */
    function groupCommentThreads(inlineComments) {
      const threads = []
      const byKey = Object.create(null)
      for (const comment of asArray(inlineComments)) {
        if (!comment || typeof comment !== 'object') continue
        const key =
          typeof comment.threadId === 'string' && comment.threadId !== ''
            ? 't:' + comment.threadId
            : Number.isInteger(comment.inReplyToId) && comment.inReplyToId > 0
              ? 'c:' + comment.inReplyToId
              : 'c:' + String(comment.id)
        const existing = byKey[key]
        if (existing) {
          existing.replies += 1
          existing.resolved = existing.resolved || comment.isResolved === true
          continue
        }
        const thread = {
          threadId: typeof comment.threadId === 'string' ? comment.threadId : '',
          root: comment,
          replies: 0,
          resolved: comment.isResolved === true,
          path: typeof comment.path === 'string' ? comment.path : '',
          line: comment.line === null || comment.line === undefined ? null : Number(comment.line),
          author: comment.author,
          avatarUrl: comment.avatarUrl,
          body: comment.body,
        }
        const parsed = parseFindingLine(comment.body)
        thread.severity = parsed.severity
        thread.title = parsed.title
        byKey[key] = thread
        threads.push(thread)
      }
      return threads
    }

    /** Inline comments bucketed per file: {line: [...]} plus line-less `general`. */
    function groupCommentsByFile(inlineComments) {
      const map = Object.create(null)
      for (const comment of normalizeInlineComments(inlineComments)) {
        let bucket = map[comment.path]
        if (!bucket) {
          bucket = { lines: Object.create(null), general: [] }
          map[comment.path] = bucket
        }
        if (comment.line === null) bucket.general.push(comment)
        else {
          if (!bucket.lines[comment.line]) bucket.lines[comment.line] = []
          bucket.lines[comment.line].push(comment)
        }
      }
      return map
    }

    /** Shorten a comment body for the inline card while keeping a readable prefix. */
    function truncateText(text, max) {
      const source = String(text === null || text === undefined ? '' : text)
      const limit = Number.isFinite(max) ? Math.max(1, Math.trunc(max)) : COMMENT_PREVIEW_CHARS
      if (source.length <= limit) return { text: source, truncated: false }
      return { text: source.slice(0, limit - 1) + '…', truncated: true }
    }

    /** Severity filter used by the review-card chips (pure client-side). */
    function filterFindings(findings, filter) {
      const list = asArray(findings)
      if (THRESHOLDS.indexOf(filter) >= 0) {
        return list.filter((finding) => finding && finding.severity === filter)
      }
      return list.slice()
    }

    /** Next/previous PR for the j/k shortcuts; wraps around and tolerates no match. */
    function stepSelection(items, currentNumber, delta) {
      const list = asArray(items).filter((item) => item && item.number !== undefined)
      if (list.length === 0) return null
      const step = Number(delta) >= 0 ? 1 : -1
      let index = -1
      for (let cursor = 0; cursor < list.length; cursor += 1) {
        if (Number(list[cursor].number) === Number(currentNumber)) {
          index = cursor
          break
        }
      }
      if (index < 0) return step > 0 ? list[0] : list[list.length - 1]
      index = (index + step + list.length) % list.length
      return list[index]
    }

    /** Locale key for a depth value; unknown values fall back to "standard". */
    function depthKey(depth) {
      return depth === 'fast' ? 'depthFast' : depth === 'deep' ? 'depthDeep' : 'depthStandard'
    }

    /** Locale key for a severityThreshold value. */
    function thresholdKey(threshold) {
      return threshold === 'P0' ? 'thresholdP0' : threshold === 'P1' ? 'thresholdP1' : 'thresholdP2'
    }

    /** Locale key for a verdict badge. */
    function verdictKey(verdict) {
      return verdict === 'block' ? 'verdictBlock' : verdict === 'changes' ? 'verdictChanges' : 'verdictApprove'
    }

    /** Locale key for the one-line verdict explanation. */
    function verdictHintKey(verdict) {
      return verdict === 'block'
        ? 'verdictBlockHint'
        : verdict === 'changes'
          ? 'verdictChangesHint'
          : 'verdictApproveHint'
    }

    /** Locale key for a Finding.confidence value; empty means "not reported". */
    function confidenceKey(confidence) {
      return confidence === 'high'
        ? 'confidenceHigh'
        : confidence === 'low'
          ? 'confidenceLow'
          : confidence === 'medium'
            ? 'confidenceMedium'
            : ''
    }

    /** Human readable summary of the options a review ran with (or the current ones). */
    function describeReviewOptions(options) {
      const value = normalizeReviewOptions(options)
      return {
        depth: value.depth,
        severityThreshold: value.severityThreshold,
        includeGuidelines: value.includeGuidelines,
        chunkChars: value.chunkChars,
        maxChunks: value.maxChunks,
        concurrency: value.concurrency,
      }
    }

    // ---------------------------------------------------------------------
    // v2 helpers: merge guards + streaming chat (CONTRACT §5)
    // ---------------------------------------------------------------------

    /** Whether the toolbar merge button is actionable for this PR summary. */
    function mergeAvailability(summary) {
      const source = summary && typeof summary === 'object' ? summary : null
      if (!source) return { enabled: false, reason: 'unavailable' }
      const state = typeof source.state === 'string' && source.state !== '' ? source.state : 'open'
      const merged =
        source.merged === true ||
        state === 'merged' ||
        (typeof source.mergedAt === 'string' && source.mergedAt !== '')
      if (merged) return { enabled: false, reason: 'merged' }
      if (state !== 'open') return { enabled: false, reason: 'closed' }
      if (source.isDraft) return { enabled: false, reason: 'draft' }
      return { enabled: true, reason: '' }
    }

    /** The head SHA shown in the merge dialog and sent as expectedHeadSha. */
    function resolveHeadSha(detail) {
      const source = detail && typeof detail === 'object' ? detail : {}
      const summary = source.summary && typeof source.summary === 'object' ? source.summary : {}
      const review = source.review && typeof source.review === 'object' ? source.review : {}
      for (const candidate of [source.headSha, summary.headSha, review.headSha]) {
        if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()
      }
      return ''
    }

    /** First N characters of a SHA, or '' when there is nothing to show. */
    function shortSha(sha, length) {
      const source = typeof sha === 'string' ? sha.trim() : ''
      const limit = Number.isFinite(length) ? Math.max(1, Math.trunc(length)) : 7
      return source === '' ? '' : source.slice(0, limit)
    }

    /** Whitelist the merge method; anything unknown falls back to squash. */
    function normalizeMergeMethod(value) {
      return MERGE_METHODS.indexOf(value) >= 0 ? value : DEFAULT_MERGE_METHOD
    }

    /**
     * Build the write request sent to /codex-review/merge. Returns null when a
     * required field (repo / number / head sha) is missing so the UI can show a
     * clear error instead of sending a half-formed write.
     */
    function buildMergeRequest(input) {
      const source = input && typeof input === 'object' ? input : {}
      const summary = source.summary && typeof source.summary === 'object' ? source.summary : {}
      const repo = typeof summary.repo === 'string' ? summary.repo.trim() : ''
      const number = Number(summary.number)
      const headSha = typeof source.headSha === 'string' ? source.headSha.trim() : ''
      if (repo === '' || !Number.isFinite(number) || headSha === '') return null
      const request = {
        repo,
        number: Math.trunc(number),
        method: normalizeMergeMethod(source.method),
        expectedHeadSha: headSha,
        deleteBranch: Boolean(source.deleteBranch),
        confirm: true,
      }
      const commitTitle = typeof source.commitTitle === 'string' ? source.commitTitle.trim() : ''
      const commitMessage =
        typeof source.commitMessage === 'string' ? source.commitMessage.trim() : ''
      if (commitTitle !== '') request.commitTitle = commitTitle.slice(0, 256)
      if (commitMessage !== '') request.commitMessage = commitMessage.slice(0, 2000)
      return request
    }

    /** Locale key for a merge error code; '' means "show the host message". */
    const MERGE_ERROR_KEYS = {
      MERGE_HEAD_MOVED: 'mergeHeadMoved',
      MERGE_CONFLICT: 'mergeConflict',
      MERGE_NOT_ALLOWED: 'mergeNotAllowed',
      GH_FORBIDDEN: 'mergeForbidden',
      GH_NOT_FOUND: 'mergeNotFound',
      BAD_REQUEST: 'mergeBadRequest',
    }

    function mergeErrorKey(code) {
      const key = String(code === undefined || code === null ? '' : code)
      return Object.prototype.hasOwnProperty.call(MERGE_ERROR_KEYS, key) ? MERGE_ERROR_KEYS[key] : ''
    }

    /**
     * Incremental parser for the chat SSE stream (`data: {...}\n\n` frames).
     * push() returns finished events; a partially received frame stays buffered.
     */
    function createSseParser() {
      let buffer = ''
      const parseFrame = (rawFrame) => {
        const lines = String(rawFrame === undefined || rawFrame === null ? '' : rawFrame)
          .replace(/\r\n?/g, '\n')
          .split('\n')
        const data = []
        for (const line of lines) {
          if (line === '' || line.charAt(0) === ':') continue
          if (line.indexOf('data:') === 0) data.push(line.slice(5).replace(/^ /, ''))
        }
        if (data.length === 0) return null
        const text = data.join('\n').trim()
        if (text === '' || text === '[DONE]') return { type: 'done', model: null, usage: null }
        let payload
        try {
          payload = JSON.parse(text)
        } catch {
          return { type: 'invalid' }
        }
        if (!payload || typeof payload !== 'object') return { type: 'invalid' }
        if (typeof payload.delta === 'string') return { type: 'delta', text: payload.delta }
        if (payload.done === true) {
          return {
            type: 'done',
            model: payload.model && typeof payload.model === 'object' ? payload.model : null,
            usage: payload.usage && typeof payload.usage === 'object' ? payload.usage : null,
          }
        }
        if (payload.error && typeof payload.error === 'object') {
          return {
            type: 'error',
            error: {
              code: String(payload.error.code || 'INTERNAL'),
              message: String(payload.error.message || ''),
            },
          }
        }
        return { type: 'invalid' }
      }
      return {
        /** Feed decoded text; returns the events completed by this chunk. */
        push(chunk) {
          buffer = (buffer + String(chunk === undefined || chunk === null ? '' : chunk)).replace(
            /\r\n/g,
            '\n',
          )
          const events = []
          let index = buffer.indexOf('\n\n')
          while (index >= 0) {
            const frame = buffer.slice(0, index)
            buffer = buffer.slice(index + 2)
            const event = parseFrame(frame)
            if (event) events.push(event)
            index = buffer.indexOf('\n\n')
          }
          return events
        },
        /** Emit a trailing frame that was never followed by the blank line. */
        flush() {
          const frame = buffer
          buffer = ''
          if (frame.trim() === '') return []
          const event = parseFrame(frame)
          return event ? [event] : []
        },
        get pending() {
          return buffer
        },
      }
    }

    /** Coerce persisted chat history into [{role, content}], newest kept. */
    function normalizeChatHistory(value) {
      const list = Array.isArray(value) ? value : []
      const messages = []
      for (const entry of list) {
        if (!entry || typeof entry !== 'object') continue
        const role = entry.role === 'assistant' ? 'assistant' : entry.role === 'user' ? 'user' : ''
        const content = typeof entry.content === 'string' ? entry.content : ''
        if (role === '' || content.trim() === '') continue
        messages.push({ role, content })
      }
      return messages.slice(-CHAT_HISTORY_LIMIT)
    }

    /** localStorage key for one PR's chat history; '' when the PR is unknown. */
    function chatHistoryKey(repo, number) {
      const repoName = typeof repo === 'string' ? repo.trim() : ''
      const prNumber = Number(number)
      if (repoName === '' || !Number.isFinite(prNumber)) return ''
      return CHAT_KEY_PREFIX + repoName + '#' + Math.trunc(prNumber)
    }

    /** Read one PR's chat history; anything corrupt degrades to an empty list. */
    function readChatHistory(store, repo, number) {
      try {
        const key = chatHistoryKey(repo, number)
        if (key === '' || !store || typeof store.getItem !== 'function') return []
        const raw = store.getItem(key)
        if (typeof raw !== 'string' || raw === '') return []
        return normalizeChatHistory(JSON.parse(raw))
      } catch {
        return []
      }
    }

    /** Persist one PR's chat history (cap 20); never throws. */
    function writeChatHistory(store, repo, number, messages) {
      const key = chatHistoryKey(repo, number)
      if (key === '') return false
      try {
        if (!store || typeof store.setItem !== 'function') return false
        store.setItem(key, JSON.stringify(normalizeChatHistory(messages)))
        return true
      } catch {
        return false
      }
    }

    /** Messages sent to /codex-review/chat: last 10 turns, each capped at 4000 chars. */
    function chatRequestMessages(messages) {
      return normalizeChatHistory(messages)
        .slice(-CHAT_REQUEST_MESSAGES)
        .map((message) => ({
          role: message.role,
          content: message.content.slice(0, CHAT_MESSAGE_CHARS),
        }))
    }

    /** Append streamed text to the trailing assistant message (pure, for tests). */
    function applyChatDelta(messages, text) {
      const list = Array.isArray(messages) ? messages.slice() : []
      const delta = typeof text === 'string' ? text : ''
      if (list.length === 0) return list
      const last = list[list.length - 1]
      if (!last || last.role !== 'assistant') return list
      list[list.length - 1] = Object.assign({}, last, {
        content: String(last.content === undefined || last.content === null ? '' : last.content) + delta,
      })
      return list
    }

    /** Most recent user message, used by the retry button. */
    function chatLastUserMessage(messages) {
      const list = Array.isArray(messages) ? messages : []
      for (let index = list.length - 1; index >= 0; index -= 1) {
        const message = list[index]
        if (message && message.role === 'user' && typeof message.content === 'string') return message
      }
      return null
    }

    /** Drop a trailing empty assistant bubble (failed/stopped before any delta). */
    function dropEmptyAssistant(messages) {
      const list = Array.isArray(messages) ? messages.slice() : []
      while (list.length > 0) {
        const last = list[list.length - 1]
        if (last && last.role === 'assistant' && String(last.content || '').trim() === '') list.pop()
        else break
      }
      return list
    }

    /** Normal completion: drop transient streaming flags before persisting. */
    function settleChatMessages(messages) {
      return dropEmptyAssistant(messages).map((message) => {
        const next = Object.assign({}, message)
        delete next.stopped
        delete next.streaming
        return next
      })
    }

    /** User stopped the stream: keep the partial answer and flag the bubble. */
    function markChatStopped(messages) {
      const list = dropEmptyAssistant(messages)
      if (list.length === 0) return list
      const last = list[list.length - 1]
      if (!last || last.role !== 'assistant') return list
      list[list.length - 1] = Object.assign({}, last, { stopped: true })
      return list
    }

    // ---------------------------------------------------------------------
    // v2.1 helpers: auto review config/status, polling decision, recent diff
    // ---------------------------------------------------------------------

    /** Clamp a possibly-garbage number into [min, max], falling back when unusable. */
    function clampInteger(value, min, max, fallback) {
      const number = Number(value)
      if (!Number.isFinite(number)) return fallback
      return Math.min(max, Math.max(min, Math.round(number)))
    }

    /** Local storage mirrors shared settings for toolbar hints only. */
    function cacheSharedSettings(config, refresh = false) {
      const settings = normalizeSettings(config)
      writeSettings(localStore(), settings)
      try {
        window.dispatchEvent(new CustomEvent('codex-review:settings-changed', { detail: { refresh } }))
      } catch { /* a missing browser event API does not affect host settings */ }
      return settings
    }

    /** Normalize the Host's AutoReviewConfig (echoed by status/config routes). */
    function normalizeAutoReviewConfig(value) {
      const source = value && typeof value === 'object' ? value : {}
      const query =
        typeof source.query === 'string' && source.query.trim() !== ''
          ? source.query.trim().slice(0, 500)
          : AUTO_REVIEW_DEFAULT.query
      return {
        enabled:
          source.enabled === undefined ? AUTO_REVIEW_DEFAULT.enabled : Boolean(source.enabled),
        intervalSeconds: clampInteger(
          source.intervalSeconds,
          AUTO_REVIEW_INTERVAL_MIN,
          AUTO_REVIEW_INTERVAL_MAX,
          AUTO_REVIEW_DEFAULT.intervalSeconds,
        ),
        query,
        depth: DEPTHS.indexOf(source.depth) >= 0 ? source.depth : AUTO_REVIEW_DEFAULT.depth,
        severityThreshold:
          THRESHOLDS.indexOf(source.severityThreshold) >= 0
            ? source.severityThreshold
            : AUTO_REVIEW_DEFAULT.severityThreshold,
        includeGuidelines: source.includeGuidelines === undefined ? true : Boolean(source.includeGuidelines),
        includeDrafts:
          source.includeDrafts === undefined
            ? AUTO_REVIEW_DEFAULT.includeDrafts
            : Boolean(source.includeDrafts),
        maxPerCycle: clampInteger(
          source.maxPerCycle,
          AUTO_REVIEW_MAX_PER_CYCLE_MIN,
          AUTO_REVIEW_MAX_PER_CYCLE_MAX,
          AUTO_REVIEW_DEFAULT.maxPerCycle,
        ),
      }
    }

    /** Normalize one AutoReviewStatus.recent entry. */
    function normalizeAutoReviewRecentEntry(value) {
      const source = value && typeof value === 'object' ? value : null
      if (!source) return null
      const repo = typeof source.repo === 'string' ? source.repo : ''
      const number = Number(source.number)
      if (repo === '' || !Number.isFinite(number) || number <= 0) return null
      const findings = Number(source.findings)
      const finishedAt = Number(source.finishedAt)
      const state =
        source.state === 'error' ? 'error' : source.state === 'cancelled' ? 'cancelled' : 'done'
      const error =
        source.error && typeof source.error === 'object'
          ? {
              code: String(source.error.code || 'INTERNAL'),
              message: String(source.error.message || ''),
            }
          : null
      return {
        repo,
        number: Math.trunc(number),
        headSha: typeof source.headSha === 'string' ? source.headSha : '',
        state,
        findings: Number.isFinite(findings) && findings > 0 ? Math.round(findings) : 0,
        verdict: VERDICTS.indexOf(source.verdict) >= 0 ? source.verdict : '',
        overview: typeof source.overview === 'string' ? source.overview : '',
        finishedAt: Number.isFinite(finishedAt) && finishedAt > 0 ? Math.round(finishedAt) : 0,
        error,
        published: normalizePublished(
          source.published || source.publishResult || source.publish || null,
        ),
      }
    }

    /** Normalize AutoReviewStatus.recent (newest first, ≤20). */
    function normalizeAutoReviewRecent(value) {
      const list = []
      for (const entry of asArray(value)) {
        const normalized = normalizeAutoReviewRecentEntry(entry)
        if (normalized) list.push(normalized)
      }
      return list.slice(0, AUTO_REVIEW_RECENT_LIMIT)
    }

    /** Normalize the whole AutoReviewStatus payload (CONTRACT §6.3). */
    function normalizeAutoReviewStatus(value) {
      const source = value && typeof value === 'object' ? value : {}
      const lastCycleAt = Number(source.lastCycleAt)
      const nextCycleAt = Number(source.nextCycleAt)
      const seenCount = Number(source.seenCount)
      const lastError =
        source.lastError && typeof source.lastError === 'object'
          ? {
              code: String(source.lastError.code || 'INTERNAL'),
              message: String(source.lastError.message || ''),
            }
          : null
      return {
        config: normalizeAutoReviewConfig(source.config),
        running: Boolean(source.running),
        lastCycleAt: Number.isFinite(lastCycleAt) && lastCycleAt > 0 ? Math.round(lastCycleAt) : 0,
        nextCycleAt: Number.isFinite(nextCycleAt) && nextCycleAt > 0 ? Math.round(nextCycleAt) : 0,
        seenCount: Number.isFinite(seenCount) && seenCount > 0 ? Math.round(seenCount) : 0,
        recent: normalizeAutoReviewRecent(source.recent),
        publish:
          source.publish && typeof source.publish === 'object'
            ? normalizePublishConfig(source.publish)
            : null,
        lastError,
      }
    }

    /** Stable identity of one recent result, used to spot new entries. */
    function autoReviewRecentKey(entry) {
      const value = entry && typeof entry === 'object' ? entry : {}
      return (
        String(value.repo || '') +
        '#' +
        String(value.number === undefined ? '' : value.number) +
        '@' +
        String(value.headSha || '') +
        '@' +
        String(value.finishedAt || 0)
      )
    }

    /** Newly finished (done) results in `next` that were not in `previous`. */
    function diffAutoReviewRecent(previous, next) {
      const known = new Set(normalizeAutoReviewRecent(previous).map(autoReviewRecentKey))
      return normalizeAutoReviewRecent(next).filter(
        (entry) => entry.state === 'done' && !known.has(autoReviewRecentKey(entry)),
      )
    }

    /** Whether auto-review polling should run, and at which cadence. */
    function autoReviewPollDecision(input) {
      const source = input && typeof input === 'object' ? input : {}
      const interval = Number(source.intervalMs)
      const intervalMs =
        Number.isFinite(interval) && interval > 0 ? interval : AUTO_REVIEW_POLL_MS
      if (source.supported === false) return { active: false, intervalMs, reason: 'unsupported' }
      if (source.visible === false) return { active: false, intervalMs, reason: 'hidden' }
      if (source.enabled !== true) return { active: false, intervalMs, reason: 'disabled' }
      return { active: true, intervalMs, reason: 'polling' }
    }

    /** Latest auto-review state per PR key (repo#number). */
    function autoReviewBadgesByPr(recent) {
      const map = Object.create(null)
      for (const entry of normalizeAutoReviewRecent(recent)) {
        const key = entry.repo + '#' + entry.number
        const existing = map[key]
        if (!existing || entry.finishedAt >= existing.finishedAt) {
          map[key] = {
            findings: entry.findings,
            state: entry.state,
            verdict: entry.verdict,
            overview: entry.overview,
            error: entry.error,
            finishedAt: entry.finishedAt,
          }
        }
      }
      return map
    }

    /** Badge descriptor for a PR row (CONTRACT §6.4). */
    function autoReviewBadge(entry) {
      if (!entry || typeof entry !== 'object') return null
      if (entry.state === 'error') {
        return { kind: 'error', text: '!', titleKey: 'autoReviewBadgeError', titleVars: null }
      }
      if (entry.state !== 'done') return null
      const count = Number(entry.findings)
      if (Number.isFinite(count) && count > 0) {
        const rounded = Math.round(count)
        return {
          kind: 'count',
          text: String(rounded),
          titleKey: 'autoReviewBadgeCount',
          titleVars: { n: rounded },
        }
      }
      return { kind: 'clean', text: '✓', titleKey: 'autoReviewBadgeClean', titleVars: null }
    }

    /** True when an error means "this host has no auto-review routes". */
    function isAutoReviewRouteMissing(error) {
      const code = String((error && error.code) || '')
      const message = String((error && error.message) || '')
      if (code === 'GH_NOT_FOUND') return true
      if (code === 'BAD_REQUEST') {
        return (
          message.indexOf('路由') >= 0 ||
          message.indexOf('route') >= 0 ||
          message.indexOf('not found') >= 0
        )
      }
      return false
    }

    /** Map the auto-review-run response into what the toast should say. */
    function autoReviewRunState(value, error) {
      if (error) {
        if (isAutoReviewRouteMissing(error)) {
          return { kind: 'unsupported', messageKey: 'autoReviewUnsupported' }
        }
        return { kind: 'failed', messageKey: 'autoReviewRunFailed' }
      }
      const source = value && typeof value === 'object' ? value : {}
      if (source.started === true) {
        return { kind: 'started', messageKey: 'autoReviewRunStarted' }
      }
      const reason = String(source.reason || '')
      if (/running|正在运行|运行中|进行中/i.test(reason)) {
        return { kind: 'busy', messageKey: 'autoReviewRunAlready' }
      }
      if (/disabled|关闭/i.test(reason)) {
        return { kind: 'disabled', messageKey: 'autoReviewRunDisabled' }
      }
      if (/卸载|unavailable|unsupported|路由/i.test(reason)) {
        return { kind: 'failed', messageKey: 'autoReviewRunFailed' }
      }
      return { kind: 'busy', messageKey: 'autoReviewRunAlready' }
    }

    /** Toast text for a finished auto-review result. */
    function autoReviewDoneToastText(entry, t) {
      const value = entry && typeof entry === 'object' ? entry : null
      if (!value) return ''
      const pr =
        String(value.repo || '') + '#' + String(value.number === undefined ? '' : value.number)
      return Number(value.findings) > 0
        ? tx(t, 'autoReviewDoneToast', { pr, n: Math.round(Number(value.findings)) })
        : tx(t, 'autoReviewDoneToastClean', { pr })
    }

    // ---------------------------------------------------------------------
    // v2.2 helpers: publish config/request/filter/result (CONTRACT §7)
    // ---------------------------------------------------------------------

    /** Normalize PublishConfig (auto review state file, CONTRACT §7.1). */
    function normalizePublishConfig(value) {
      const source = value && typeof value === 'object' ? value : {}
      return {
        enabled:
          source.enabled === undefined ? PUBLISH_DEFAULT_CONFIG.enabled : Boolean(source.enabled),
        mode:
          PUBLISH_MODES.indexOf(source.mode) >= 0 ? source.mode : PUBLISH_DEFAULT_CONFIG.mode,
        minSeverity:
          PUBLISH_MIN_SEVERITIES.indexOf(source.minSeverity) >= 0
            ? source.minSeverity
            : PUBLISH_DEFAULT_CONFIG.minSeverity,
        maxComments: clampInteger(
          source.maxComments,
          PUBLISH_MAX_COMMENTS_MIN,
          PUBLISH_MAX_COMMENTS_MAX,
          PUBLISH_DEFAULT_CONFIG.maxComments,
        ),
      }
    }

    /** True when `severity` is at least as severe as `minSeverity` (P0 > P1 > P2). */
    function severityAtLeast(severity, minSeverity) {
      const sev = severityRank(severity)
      if (sev > 3) return false
      const min = severityRank(minSeverity)
      return sev <= (min > 3 ? 2 : min)
    }

    /** Findings that would be published for a minimum severity (sorted). */
    function filterPublishableFindings(findings, minSeverity) {
      const min =
        PUBLISH_MIN_SEVERITIES.indexOf(minSeverity) >= 0
          ? minSeverity
          : PUBLISH_DEFAULT_CONFIG.minSeverity
      return sortFindings(findings).filter((finding) => {
        if (!finding || typeof finding !== 'object') return false
        if (
          finding.severity !== 'P0' &&
          finding.severity !== 'P1' &&
          finding.severity !== 'P2'
        ) {
          return false
        }
        if (!severityAtLeast(finding.severity, min)) return false
        if (typeof finding.file !== 'string' || finding.file === '') return false
        const line = Number(finding.line)
        return Number.isFinite(line) && line > 0
      })
    }

    /** Estimated number of published comments (filtered + capped by maxComments). */
    function countPublishableFindings(findings, minSeverity, maxComments) {
      const limit = clampInteger(
        maxComments,
        PUBLISH_MAX_COMMENTS_MIN,
        PUBLISH_MAX_COMMENTS_MAX,
        PUBLISH_DEFAULT_CONFIG.maxComments,
      )
      return Math.min(filterPublishableFindings(findings, minSeverity).length, limit)
    }

    /** Build the /codex-review/review-publish body; null when required fields are missing. */
    function buildPublishRequest(input) {
      const source = input && typeof input === 'object' ? input : {}
      const summary = source.summary && typeof source.summary === 'object' ? source.summary : {}
      const repo = typeof summary.repo === 'string' ? summary.repo.trim() : ''
      const number = Number(summary.number)
      if (repo === '' || !Number.isFinite(number)) return null
      const request = {
        repo,
        number: Math.trunc(number),
        mode:
          PUBLISH_MODES.indexOf(source.mode) >= 0 ? source.mode : PUBLISH_DEFAULT_CONFIG.mode,
        minSeverity:
          PUBLISH_MIN_SEVERITIES.indexOf(source.minSeverity) >= 0
            ? source.minSeverity
            : PUBLISH_DEFAULT_CONFIG.minSeverity,
        confirm: true,
      }
      const body = typeof source.body === 'string' ? source.body.trim() : ''
      if (body !== '') request.body = body.slice(0, 4000)
      // Bind the publish to the review the user is looking at: the Host must not
      // pick a newer job or a different head behind the user's back.
      const headSha = typeof source.headSha === 'string' ? source.headSha.trim() : ''
      if (headSha !== '') request.headSha = headSha
      const jobId = typeof source.jobId === 'string' ? source.jobId.trim() : ''
      if (jobId !== '') request.jobId = jobId
      return request
    }

    /** Normalize a publish result / stored published record. */
    function normalizePublished(value) {
      const source = value && typeof value === 'object' ? value : null
      if (!source) return null
      const url =
        typeof source.url === 'string' && /^https?:\/\//i.test(source.url) ? source.url : ''
      const postedAt = Number(source.publishedAt)
      const reviewId = Number(source.reviewId)
      const comments = Number(source.comments)
      const skipped = Number(source.skipped)
      const result = {
        url,
        reviewId: Number.isFinite(reviewId) && reviewId > 0 ? Math.trunc(reviewId) : 0,
        comments: Number.isFinite(comments) && comments > 0 ? Math.round(comments) : 0,
        skipped: Number.isFinite(skipped) && skipped > 0 ? Math.round(skipped) : 0,
        publishedAt: Number.isFinite(postedAt) && postedAt > 0 ? Math.round(postedAt) : 0,
        headSha: typeof source.headSha === 'string' ? source.headSha : '',
      }
      if (result.url === '' && result.reviewId === 0) return null
      return result
    }

    /** Normalize a successful /review-publish response (published:true). */
    function normalizePublishResult(value) {
      const source = value && typeof value === 'object' ? value : {}
      if (source.published !== true) return null
      const record = normalizePublished(source)
      if (record === null) return null
      const action = source.action === 'created' || source.action === 'updated' || source.action === 'unchanged'
        ? source.action
        : 'created'
      return Object.assign({}, record, { action })
    }

    /** Locale key for a publish error code; '' means "use the Host message". */
    function publishErrorKey(code) {
      switch (String(code === undefined || code === null ? '' : code)) {
        case 'REVIEW_NOT_READY':
          return 'publishNotReady'
        case 'REVIEW_PARTIAL':
          return 'publishPartial'
        case 'REVIEW_HEAD_MOVED':
          return 'publishHeadMoved'
        case 'PUBLISH_UNKNOWN':
          return 'publishUnknown'
        case 'GH_FORBIDDEN':
          return 'publishForbidden'
        case 'BAD_REQUEST':
        case 'GH_NOT_FOUND':
          return 'publishBadRequest'
        case 'GH_RATE_LIMIT':
          return 'publishFailed'
        default:
          return ''
      }
    }

    /**
     * True when an error means the Host has no review-publish route. A GitHub
     * GH_NOT_FOUND is not evidence of an old Host: it means the repository or PR
     * is gone, so the button must stay available.
     */
    function isPublishRouteMissing(error) {
      const code = String((error && error.code) || '')
      const message = String((error && error.message) || '')
      if (code === 'BAD_REQUEST') {
        return (
          message.indexOf('路由') >= 0 ||
          message.indexOf('route') >= 0 ||
          message.indexOf('not found') >= 0
        )
      }
      return false
    }

    /** Key for a published record: repo#number@headSha. */
    function publishRecordKey(repo, number, headSha) {
      const repoName = typeof repo === 'string' ? repo.trim() : ''
      const prNumber = Number(number)
      if (repoName === '' || !Number.isFinite(prNumber)) return ''
      return repoName + '#' + Math.trunc(prNumber) + '@' + String(headSha || '')
    }

    /** Locale key for a publish mode label. */
    function publishModeLabelKey(mode) {
      return mode === 'summary'
        ? 'publishModeSummary'
        : mode === 'both'
          ? 'publishModeBoth'
          : 'publishModeInline'
    }

    /** Locale key for a publish mode hint. */
    function publishModeHintKey(mode) {
      return mode === 'summary'
        ? 'publishModeSummaryHint'
        : mode === 'both'
          ? 'publishModeBothHint'
          : 'publishModeInlineHint'
    }

    /** Auto-publish status label key for the auto-review card. */
    function autoPublishStatusKey(enabled) {
      return enabled ? 'autoPublishStatusOn' : 'autoPublishStatusOff'
    }

    // ---------------------------------------------------------------------
    // Transport: one document-relative POST, never throws
    // ---------------------------------------------------------------------

    /**
     * POST a JSON payload to a Host route and decode the {ok, value|error}
     * envelope. Returns {ok:true, value} or {ok:false, error:{code, message}}.
     * `options.timeoutMs` widens the wait for a route that legitimately performs
     * several sequential GitHub writes (publish).
     */
    async function post(path, payload, options) {
      const settings = options && typeof options === 'object' ? options : {}
      const timeoutMs =
        Number.isFinite(settings.timeoutMs) && settings.timeoutMs > 0
          ? settings.timeoutMs
          : REQUEST_TIMEOUT_MS
      const controller = typeof AbortController === 'function' ? new AbortController() : null
      const timer =
        controller !== null ? setTimeout(() => controller.abort(), timeoutMs) : null
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
            message: aborted
              ? `请求超时（${Math.round(timeoutMs / 1000)} 秒），请重试。`
              : '无法连接宿主路由，请刷新页面后重试。',
          },
        }
      } finally {
        if (timer !== null) clearTimeout(timer)
      }
    }

    /**
     * POST a JSON payload and consume a `text/event-stream` response with the
     * incremental SSE parser (CONTRACT §5.2). Returns {ok:true, done} or
     * {ok:false, error, aborted}; never throws. The caller's AbortSignal stops
     * the stream (the Host aborts the upstream model call).
     */
    async function streamPost(path, payload, options) {
      const settings = options && typeof options === 'object' ? options : {}
      const onEvent = typeof settings.onEvent === 'function' ? settings.onEvent : null
      const controller = typeof AbortController === 'function' ? new AbortController() : null
      const forwardAbort = () => {
        try {
          if (controller) controller.abort()
        } catch {
          /* abort is best effort */
        }
      }
      let removeAbortListener = () => {}
      if (settings.signal) {
        if (settings.signal.aborted) {
          forwardAbort()
        } else if (typeof settings.signal.addEventListener === 'function') {
          settings.signal.addEventListener('abort', forwardAbort)
          removeAbortListener = () => {
            try {
              settings.signal.removeEventListener('abort', forwardAbort)
            } catch {
              /* ignore */
            }
          }
        }
      }
      const abortedError = () => ({
        ok: false,
        aborted: true,
        error: { code: 'ABORTED', message: '已停止。' },
      })
      let response
      try {
        response = await fetch(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
          body: JSON.stringify(payload === undefined ? {} : payload),
          cache: 'no-store',
          signal: controller !== null ? controller.signal : undefined,
        })
      } catch (error) {
        removeAbortListener()
        const aborted =
          Boolean(settings.signal && settings.signal.aborted) ||
          Boolean(error && (error.name === 'AbortError' || error.code === 'ABORT_ERR'))
        if (aborted) return abortedError()
        return {
          ok: false,
          error: { code: 'INTERNAL', message: '无法连接宿主路由，请刷新页面后重试。' },
        }
      }
      const contentType =
        response && response.headers && typeof response.headers.get === 'function'
          ? String(response.headers.get('content-type') || '')
          : ''
      if (
        !response ||
        response.ok === false ||
        (contentType !== '' && contentType.indexOf('text/event-stream') < 0)
      ) {
        // Old Host / missing route: decode the JSON envelope so the UI can explain it.
        let envelope = null
        try {
          envelope = await response.json()
        } catch {
          envelope = null
        }
        removeAbortListener()
        const error =
          envelope && envelope.error && typeof envelope.error === 'object'
            ? envelope.error
            : {
                code: 'INTERNAL',
                message: '宿主没有返回流式响应（可能是旧版本插件）。',
              }
        return { ok: false, error }
      }
      if (!response.body || typeof response.body.getReader !== 'function') {
        removeAbortListener()
        return {
          ok: false,
          error: { code: 'INTERNAL', message: '当前浏览器无法读取流式响应。' },
        }
      }
      const reader = response.body.getReader()
      const decoder = typeof TextDecoder === 'function' ? new TextDecoder('utf-8') : null
      const parser = createSseParser()
      const emit = (event) => {
        if (!event) return null
        if (onEvent) {
          try {
            onEvent(event)
          } catch {
            /* a rendering callback must never break the stream */
          }
        }
        return event
      }
      try {
        for (;;) {
          const chunk = await reader.read()
          if (!chunk || chunk.done) break
          let text = ''
          try {
            text = decoder
              ? decoder.decode(chunk.value, { stream: true })
              : String.fromCharCode.apply(null, chunk.value || [])
          } catch {
            text = ''
          }
          for (const event of parser.push(text)) {
            const emitted = emit(event)
            if (emitted && emitted.type === 'done') return { ok: true, done: emitted }
            if (emitted && emitted.type === 'error') return { ok: false, error: emitted.error }
          }
        }
        if (decoder) {
          try {
            const tail = decoder.decode()
            if (tail) {
              for (const event of parser.push(tail)) {
                const emitted = emit(event)
                if (emitted && emitted.type === 'done') return { ok: true, done: emitted }
                if (emitted && emitted.type === 'error') return { ok: false, error: emitted.error }
              }
            }
          } catch {
            /* ignore decode tail errors */
          }
        }
        for (const event of parser.flush()) {
          const emitted = emit(event)
          if (emitted && emitted.type === 'done') return { ok: true, done: emitted }
          if (emitted && emitted.type === 'error') return { ok: false, error: emitted.error }
        }
        return { ok: true, done: null }
      } catch (error) {
        const aborted =
          Boolean(settings.signal && settings.signal.aborted) ||
          Boolean(controller && controller.signal && controller.signal.aborted) ||
          Boolean(error && (error.name === 'AbortError' || error.code === 'ABORT_ERR'))
        if (aborted) return abortedError()
        return {
          ok: false,
          error: { code: 'INTERNAL', message: '流式响应中断，请重试。' },
        }
      } finally {
        removeAbortListener()
        try {
          if (reader && typeof reader.releaseLock === 'function') reader.releaseLock()
        } catch {
          /* ignore */
        }
      }
    }

    // ---------------------------------------------------------------------
    // Styles: every color comes from a --dsw-alias-* token
    // ---------------------------------------------------------------------

    const CSS = `
.cr-root{
  container-type: inline-size;
  position:relative;
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
.cr-layout{display:flex;flex:1;min-width:0;min-height:0}
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
.cr-iconbtn:disabled{opacity:.35;cursor:not-allowed}
.cr-iconbtn:disabled:hover{background:transparent;color:var(--cr-text-2)}
.cr-review{display:inline-flex;align-items:stretch;height:32px;border-radius:16px;background:var(--cr-card);overflow:hidden;flex:none}
.cr-review-main{display:inline-flex;align-items:center;gap:8px;padding:0 14px;border:0;background:transparent;color:var(--cr-text);font-size:13px;font-weight:500;cursor:pointer;white-space:nowrap}
.cr-review-main:hover{background:var(--cr-raised)}
.cr-review-main:disabled{cursor:default;opacity:.75}
.cr-review-label{display:inline}
.cr-review-short{display:none}
.cr-review-gear{display:grid;place-items:center;width:32px;padding:0;border:0;border-left:1px solid var(--cr-border-strong);background:transparent;color:var(--cr-text);cursor:pointer}
.cr-review-gear:hover{background:var(--cr-raised)}
.cr-btn{display:inline-flex;align-items:center;gap:7px;height:32px;padding:0 14px;border:0;border-radius:16px;background:var(--cr-card);color:var(--cr-text);font-size:13px;font-weight:500;cursor:pointer;white-space:nowrap}
.cr-btn:hover{background:var(--cr-raised)}
.cr-btn:disabled{cursor:not-allowed;opacity:.5}
.cr-btn--merge{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);padding:0 11px 0 13px}
.cr-btn--merge:hover{background:var(--dsw-alias-button-primary-fill)}
.cr-btn--merge:disabled{opacity:.5;cursor:not-allowed}
.cr-root .cr-btn--merge{color:var(--dsw-alias-label-primary-foreground)}
.cr-root .cr-btn--primary{color:var(--dsw-alias-label-primary-foreground)}
.cr-root .cr-btn--primary:hover{background:var(--dsw-alias-button-primary-hover)}
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
.cr-details{width:300px;flex:none;align-self:flex-start;position:sticky;top:0;max-height:100%;min-height:0;overflow-y:auto;padding:10px 0 80px}

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

/* ---------------- v1.1: inline findings + existing comments in the diff ---------------- */
.cr-diff-mark{width:18px}
.cr-diff-dotbtn{display:inline-flex;align-items:center;justify-content:center;gap:2px;width:100%;height:100%;min-height:17px;padding:0;border:0;background:transparent;cursor:pointer;border-radius:4px}
.cr-diff-dotbtn:hover{background:color-mix(in srgb,var(--cr-sev-color,var(--cr-text-2)) 18%,transparent)}
.cr-diff-dot{display:block;width:6px;height:6px;border-radius:50%;background:var(--cr-sev-color,var(--cr-text-2));transition:transform .12s ease}
.cr-diff-dotbtn:hover .cr-diff-dot{transform:scale(1.25)}
.cr-diff-dot--P0{--cr-sev-color:var(--cr-red)}
.cr-diff-dot--P1{--cr-sev-color:var(--cr-orange)}
.cr-diff-dot--P2{--cr-sev-color:var(--cr-yellow)}
.cr-diff-dotcount{font-size:9px;line-height:1;font-weight:700;color:var(--cr-text-2);font-variant-numeric:tabular-nums}
.cr-diff-inline{position:sticky;left:0;width:100%;padding:6px 14px 8px 32px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 3.5%,var(--cr-bg));border-top:1px solid var(--cr-border);border-bottom:1px solid var(--cr-border)}
.cr-diff-inline-head{display:flex;align-items:center;gap:8px;margin:2px 0 2px;font-size:11.5px;line-height:17px;color:var(--cr-text-3)}
.cr-diff-comments{position:sticky;left:0;width:100%;padding:4px 14px 6px 32px}
.cr-inline-card{position:relative;margin:8px 0 2px;padding:10px 12px 10px 14px;border-radius:8px;background:var(--cr-card);border:1px solid var(--cr-border-2);overflow:hidden}
.cr-inline-card::before{content:"";position:absolute;left:0;top:0;bottom:0;width:2px;background:var(--cr-sev-color,var(--cr-text-3))}
.cr-inline-card--P0{--cr-sev-color:var(--cr-red)}
.cr-inline-card--P1{--cr-sev-color:var(--cr-orange)}
.cr-inline-card--P2{--cr-sev-color:var(--cr-yellow)}
.cr-inline-head{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.cr-inline-close{margin-left:auto;display:grid;place-items:center;width:22px;height:22px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--cr-text-3);cursor:pointer}
.cr-inline-close:hover{background:var(--cr-hover);color:var(--cr-text)}
.cr-inline-title{margin-top:5px;font-size:13px;line-height:20px;font-weight:600;color:var(--cr-text);overflow-wrap:anywhere}
.cr-inline-loc{display:inline-flex;align-items:center;gap:5px;margin-top:4px;font-family:var(--cr-mono);font-size:11px;line-height:17px;color:var(--cr-blue)}
.cr-inline-body{margin-top:6px;font-size:12px;line-height:19px;color:var(--cr-text-2);overflow-wrap:anywhere;white-space:pre-wrap}
.cr-inline-label{display:inline-block;margin-right:6px;font-size:10.5px;font-weight:600;line-height:16px;color:var(--cr-text);background:var(--cr-bg);border-radius:4px;padding:0 5px}
.cr-inline-evidence{margin-top:7px;padding:7px 9px;border-radius:6px;background:var(--dsw-alias-markdown-code-block);font-family:var(--cr-mono);font-size:11.5px;line-height:17px;color:var(--cr-text-2);overflow-x:auto;white-space:pre}
.cr-inline-foot{display:flex;align-items:center;gap:8px;margin-top:9px;flex-wrap:wrap}
.cr-chip-tag{display:inline-flex;align-items:center;gap:4px;height:18px;padding:0 6px;border-radius:5px;font-size:10.5px;font-weight:600;line-height:1;color:var(--cr-text-2);background:var(--cr-raised);border:1px solid var(--cr-border-2)}
.cr-chip-tag--confidence-high{color:var(--cr-green);border-color:color-mix(in srgb,var(--cr-green) 30%,transparent);background:color-mix(in srgb,var(--cr-green) 12%,transparent)}
.cr-chip-tag--confidence-medium{color:var(--cr-orange);border-color:color-mix(in srgb,var(--cr-orange) 30%,transparent);background:color-mix(in srgb,var(--cr-orange) 12%,transparent)}
.cr-chip-tag--confidence-low{color:var(--cr-text-3)}
.cr-inline-comment{position:relative;margin:6px 0 2px;padding:8px 10px 9px 12px;border-radius:8px;background:color-mix(in srgb,var(--cr-blue) 7%,transparent);border:1px solid color-mix(in srgb,var(--cr-blue) 24%,transparent);overflow:hidden}
.cr-inline-comment::before{content:"";position:absolute;left:0;top:0;bottom:0;width:2px;background:var(--cr-blue)}
.cr-inline-comment-head{display:flex;align-items:center;gap:6px;font-size:11px;line-height:16px;color:var(--cr-text-3);flex-wrap:wrap}
.cr-inline-comment-author{color:var(--cr-text-2);font-weight:500}
.cr-inline-comment-body{margin-top:4px;font-size:12px;line-height:19px;color:var(--cr-text-2);white-space:pre-wrap;overflow-wrap:anywhere}

/* ---------------- v2.3: comment write actions ---------------- */
.cr-inline-actions{display:flex;align-items:center;gap:6px;margin-top:6px;flex-wrap:wrap}
.cr-inline-actions .cr-btn{height:22px;padding:0 8px;border-radius:6px;font-size:11px}
.cr-inline-reply{margin-top:7px;display:flex;flex-direction:column;gap:6px}
.cr-inline-reply textarea,.cr-comment-dialog textarea{width:100%;min-height:58px;resize:vertical;padding:7px 9px;border-radius:7px;border:1px solid var(--cr-border-2);background:var(--cr-raised);color:var(--cr-text);font-size:12px;line-height:18px;font-family:inherit;box-sizing:border-box}
.cr-inline-reply textarea:focus,.cr-comment-dialog textarea:focus{outline:none;border-color:var(--cr-border-strong);background:var(--cr-card)}
.cr-inline-resolve-confirm{margin-top:7px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:7px 9px;border-radius:7px;background:color-mix(in srgb,var(--cr-orange) 9%,transparent);border:1px solid color-mix(in srgb,var(--cr-orange) 24%,transparent);font-size:11.5px;line-height:16px;color:var(--cr-text-2)}
.cr-comment-dialog{width:520px}
.cr-comment-dialog-body{margin-top:8px;display:flex;flex-direction:column;gap:8px}
.cr-comment-error{margin-top:6px;padding:6px 8px;border-radius:6px;font-size:11px;line-height:16px;color:var(--cr-text-2);background:color-mix(in srgb,var(--cr-red) 8%,transparent);border:1px solid color-mix(in srgb,var(--cr-red) 22%,transparent)}

/* ---------------- v1.1: verdict badge, filter chips, review meta ---------------- */
.cr-verdict{display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 9px;border-radius:11px;border:1px solid transparent;font-size:11.5px;font-weight:700;letter-spacing:.01em;white-space:nowrap}
.cr-verdict--block{color:var(--cr-red);background:color-mix(in srgb,var(--cr-red) 14%,transparent);border-color:color-mix(in srgb,var(--cr-red) 32%,transparent)}
.cr-verdict--changes{color:var(--cr-orange);background:color-mix(in srgb,var(--cr-orange) 14%,transparent);border-color:color-mix(in srgb,var(--cr-orange) 32%,transparent)}
.cr-verdict--approve{color:var(--cr-green);background:color-mix(in srgb,var(--cr-green) 14%,transparent);border-color:color-mix(in srgb,var(--cr-green) 32%,transparent)}
.cr-verdict-hint{font-size:12px;line-height:17px;color:var(--cr-text-3)}
.cr-review-verdict-row{display:flex;align-items:center;gap:9px;flex-wrap:wrap;margin-top:10px}
.cr-chips{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:10px}
.cr-chip{display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 9px;border-radius:12px;border:1px solid var(--cr-border-2);background:transparent;color:var(--cr-text-2);font-size:11.5px;font-weight:500;cursor:pointer;font-variant-numeric:tabular-nums;white-space:nowrap}
.cr-chip:hover{background:var(--cr-hover);color:var(--cr-text)}
.cr-chip--active,.cr-chip--active:hover{background:var(--cr-raised);border-color:var(--cr-border-strong);color:var(--cr-text)}
.cr-chip-count{color:var(--cr-text-3);font-weight:600}
.cr-chip--P0 .cr-chip-count{color:var(--cr-red)}
.cr-chip--P1 .cr-chip-count{color:var(--cr-orange)}
.cr-chip--P2 .cr-chip-count{color:var(--cr-yellow)}
.cr-review-meta-row{display:flex;align-items:center;flex-wrap:wrap;gap:5px 12px;margin-top:9px;font-size:11.5px;line-height:17px;color:var(--cr-text-3)}
.cr-review-meta-item{display:inline-flex;align-items:center;gap:5px;min-width:0}
.cr-review-meta-item--good{color:color-mix(in srgb,var(--cr-green) 78%,var(--cr-text-2))}
.cr-review-meta-item--warn{color:var(--cr-orange)}
.cr-filter-empty{margin-top:8px;font-size:12px;color:var(--cr-text-3)}

/* ---------------- v1.1: right-column file list ---------------- */
.cr-filelinks{display:flex;flex-direction:column;gap:1px;margin-top:7px}
.cr-filelink{display:flex;align-items:center;gap:6px;width:100%;padding:3px 6px;margin:0 -6px;border:0;border-radius:6px;background:transparent;cursor:pointer;text-align:left;color:var(--cr-text-2)}
.cr-filelink:hover{background:var(--cr-hover);color:var(--cr-text)}
.cr-filelink-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--cr-mono);font-size:11px;line-height:17px}
.cr-filelink-badge{flex:none;font-size:10px;font-weight:700;line-height:14px;padding:0 4px;border-radius:5px;color:var(--cr-text);background:var(--cr-raised)}
.cr-filelink-badge--P0{color:var(--cr-red);background:color-mix(in srgb,var(--cr-red) 16%,transparent)}
.cr-filelink-badge--P1{color:var(--cr-orange);background:color-mix(in srgb,var(--cr-orange) 16%,transparent)}
.cr-filelink-badge--P2{color:var(--cr-yellow);background:color-mix(in srgb,var(--cr-yellow) 16%,transparent)}

/* ---------------- v1.1: review settings popover ---------------- */
.cr-modal-backdrop{position:absolute;inset:0;z-index:20;display:flex;align-items:flex-start;justify-content:flex-end;padding:58px 20px 20px;background:var(--dsw-alias-bg-mask-1)}
.cr-modal{width:352px;max-width:100%;max-height:calc(100% - 78px);overflow-y:auto;background:var(--cr-card);border:1px solid var(--cr-border-strong);border-radius:12px;box-shadow:0 12px 32px var(--dsw-alias-bg-mask-2);padding:13px 15px 14px}
.cr-modal-head{display:flex;align-items:center;gap:8px;margin-bottom:8px}
.cr-modal-title{flex:1;min-width:0;font-size:14px;font-weight:600;color:var(--cr-text)}
.cr-modal-close{display:grid;place-items:center;width:26px;height:26px;padding:0;border:0;border-radius:7px;background:transparent;color:var(--cr-text-2);cursor:pointer}
.cr-modal-close:hover{background:var(--cr-hover);color:var(--cr-text)}
.cr-field{border:0;margin:0;padding:0}
.cr-field + .cr-field{margin-top:11px;padding-top:11px;border-top:1px solid var(--cr-border)}
.cr-field legend{padding:0;margin-bottom:4px;font-size:12px;font-weight:600;color:var(--cr-text-2)}
.cr-option{display:flex;align-items:flex-start;gap:8px;padding:5px 7px;border-radius:8px;cursor:pointer}
.cr-option:hover{background:var(--cr-hover)}
.cr-option input{flex:none;width:14px;height:14px;margin:3px 0 0;accent-color:var(--cr-green);cursor:pointer}
.cr-option-text{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
.cr-option-label{font-size:12.5px;line-height:18px;color:var(--cr-text)}
.cr-option-hint{font-size:11px;line-height:16px;color:var(--cr-text-3)}
.cr-modal-note{margin:7px 0 0;font-size:11px;line-height:17px;color:var(--cr-text-3)}
.cr-modal-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-top:13px}
.cr-modal-actions .cr-btn--ghost{margin-right:auto}

/* ---------------- v2.1: auto review card / badges / settings section ---------------- */
.cr-autoreview-head{display:flex;align-items:center;gap:6px}
.cr-autoreview-toggle{flex:1;min-width:0;display:flex;align-items:center;gap:6px;padding:0;border:0;background:transparent;color:var(--cr-text-2);font-size:13px;font-weight:500;line-height:18px;cursor:pointer;text-align:left}
.cr-autoreview-toggle:hover{color:var(--cr-text)}
.cr-autoreview-state{flex:none;display:inline-flex;align-items:center;gap:4px;height:18px;padding:0 6px;border-radius:9px;font-size:10.5px;font-weight:600;border:1px solid transparent;white-space:nowrap}
.cr-autoreview-state--on{color:var(--cr-green);background:color-mix(in srgb,var(--cr-green) 12%,transparent);border-color:color-mix(in srgb,var(--cr-green) 26%,transparent)}
.cr-autoreview-state--off{color:var(--cr-text-3);background:var(--cr-raised);border-color:var(--cr-border-2)}
.cr-autoreview-state--running{color:var(--cr-orange);background:color-mix(in srgb,var(--cr-orange) 12%,transparent);border-color:color-mix(in srgb,var(--cr-orange) 26%,transparent)}
.cr-autoreview-body{margin-top:8px}
.cr-autoreview-meta{display:flex;flex-direction:column;gap:3px;font-size:11.5px;line-height:17px;color:var(--cr-text-3)}
.cr-autoreview-run{display:flex;align-items:center;gap:8px;margin-top:9px}
.cr-autoreview-run .cr-btn{height:26px;padding:0 9px;border-radius:6px;font-size:12px}
.cr-autoreview-error{margin-top:8px;padding:7px 9px;border-radius:7px;font-size:11px;line-height:16px;color:var(--cr-text-2);background:color-mix(in srgb,var(--cr-red) 8%,transparent);border:1px solid color-mix(in srgb,var(--cr-red) 20%,transparent)}
.cr-autoreview-recent-title{margin-top:10px;font-size:11.5px;font-weight:600;color:var(--cr-text-2)}
.cr-autoreview-recent{display:flex;flex-direction:column;gap:2px;margin-top:5px}
.cr-autoreview-item{display:flex;align-items:center;gap:6px;width:calc(100% + 10px);padding:4px 5px;margin:0 -5px;border:0;border-radius:6px;background:transparent;cursor:pointer;text-align:left;color:var(--cr-text-2)}
.cr-autoreview-item:hover{background:var(--cr-hover);color:var(--cr-text)}
.cr-autoreview-item-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
.cr-autoreview-item-pr{font-family:var(--cr-mono);font-size:11.5px;line-height:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cr-autoreview-item-meta{font-size:10.5px;line-height:15px;color:var(--cr-text-3)}
.cr-autoreview-item-state{flex:none;font-size:10px;font-weight:700;line-height:15px;padding:0 5px;border-radius:5px;color:var(--cr-text);background:var(--cr-raised)}
.cr-autoreview-item-state--count{color:var(--cr-orange);background:color-mix(in srgb,var(--cr-orange) 15%,transparent)}
.cr-autoreview-item-state--clean{color:var(--cr-green);background:color-mix(in srgb,var(--cr-green) 15%,transparent)}
.cr-autoreview-item-state--error{color:var(--cr-red);background:color-mix(in srgb,var(--cr-red) 15%,transparent)}
.cr-autoreview-empty{font-size:12px;line-height:18px;color:var(--cr-text-3)}
.cr-autoreview-degraded{font-size:12px;line-height:18px;color:var(--cr-text-3);padding:2px 0}
.cr-autoreview-degraded b{display:block;margin-bottom:2px;color:var(--cr-text-2);font-weight:600}
.cr-row-auto{flex:none;margin-left:auto;display:inline-flex;align-items:center;justify-content:center;min-width:17px;height:17px;padding:0 4px;border-radius:9px;font-size:10px;font-weight:700;font-variant-numeric:tabular-nums;border:1px solid transparent}
.cr-row-auto--count{color:var(--cr-orange);background:color-mix(in srgb,var(--cr-orange) 14%,transparent);border-color:color-mix(in srgb,var(--cr-orange) 28%,transparent)}
.cr-row-auto--clean{color:var(--cr-green);background:color-mix(in srgb,var(--cr-green) 14%,transparent);border-color:color-mix(in srgb,var(--cr-green) 28%,transparent)}
.cr-row-auto--error{color:var(--cr-red);background:color-mix(in srgb,var(--cr-red) 14%,transparent);border-color:color-mix(in srgb,var(--cr-red) 28%,transparent)}
.cr-auto-section{display:flex;flex-direction:column;gap:8px}
.cr-auto-title{display:flex;align-items:center;gap:6px;font-size:12px;font-weight:600;color:var(--cr-text-2)}
.cr-auto-title-spacer{flex:1}
.cr-auto-note{margin:0;font-size:10.5px;line-height:15px;color:var(--cr-text-3)}
.cr-auto-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.cr-auto-label{flex:none;min-width:64px;font-size:11.5px;color:var(--cr-text-2)}
.cr-auto-presets{display:flex;align-items:center;gap:4px;flex-wrap:wrap}
.cr-auto-preset{height:22px;padding:0 8px;border:1px solid var(--cr-border-2);border-radius:11px;background:transparent;color:var(--cr-text-3);font-size:11px;cursor:pointer}
.cr-auto-preset:hover{background:var(--cr-hover);color:var(--cr-text)}
.cr-auto-preset--active{background:var(--cr-raised);border-color:var(--cr-border-strong);color:var(--cr-text)}
.cr-auto-num{width:64px;height:24px;padding:0 7px;border:1px solid var(--cr-border-2);border-radius:6px;background:var(--cr-bg);color:var(--cr-text);font:inherit;font-size:11.5px}
.cr-auto-query{flex:1;min-width:0;height:26px;padding:0 8px;border:1px solid var(--cr-border-2);border-radius:6px;background:var(--cr-bg);color:var(--cr-text);font:inherit;font-size:11.5px}
.cr-auto-query:focus,.cr-auto-num:focus{outline:none;border-color:var(--cr-border-strong)}
.cr-root .cr-toast--action{display:flex;align-items:center;gap:10px;bottom:74px;max-width:min(560px,calc(100% - 42px))}
.cr-toast-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cr-toast-btn{flex:none;height:20px;padding:0 7px;border:1px solid var(--cr-border-strong);border-radius:5px;background:transparent;color:var(--cr-text);font-size:11px;cursor:pointer}
.cr-toast-btn:hover{background:var(--cr-raised)}

/* ---------------- v2.2: publish review to GitHub ---------------- */
.cr-publish-published{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 9px;border:1px solid color-mix(in srgb,var(--cr-green) 32%,transparent);border-radius:6px;background:color-mix(in srgb,var(--cr-green) 10%,transparent);color:var(--cr-green);font-size:12px;font-weight:500;text-decoration:none;cursor:pointer;white-space:nowrap}
.cr-publish-published:hover{background:color-mix(in srgb,var(--cr-green) 16%,transparent)}
.cr-publish-expected{font-weight:600;color:var(--cr-text)}
.cr-publish-error{margin-top:10px;padding:8px 10px;border-radius:8px;font-size:11.5px;line-height:17px;color:var(--cr-text-2);background:color-mix(in srgb,var(--cr-red) 8%,transparent);border:1px solid color-mix(in srgb,var(--cr-red) 22%,transparent)}
.cr-publish-error b{color:var(--cr-red);font-weight:600;margin-right:5px}
.cr-autoreview-item-row{display:flex;align-items:center;gap:4px;margin:0 -5px}
.cr-autoreview-item-row .cr-autoreview-item{flex:1;min-width:0;margin:0}
.cr-autoreview-published{flex:none;padding:0 5px;border-radius:4px;font-size:10.5px;line-height:16px;color:var(--cr-blue);text-decoration:none;white-space:nowrap}
.cr-autoreview-published:hover{text-decoration:underline;background:var(--cr-hover)}
.cr-auto-publish-confirm{margin-top:6px;padding:8px 10px;border-radius:8px;background:color-mix(in srgb,var(--cr-orange) 10%,transparent);border:1px solid color-mix(in srgb,var(--cr-orange) 24%,transparent);font-size:11px;line-height:16px;color:var(--cr-text-2)}
.cr-auto-publish-confirm b{display:block;margin-bottom:3px;color:var(--cr-text)}
.cr-auto-publish-actions{display:flex;gap:6px;margin-top:7px}
.cr-auto-publish-status{font-size:10.5px;line-height:15px;color:var(--cr-text-3)}

/* ---------------- v2: merge confirmation dialog ---------------- */
.cr-modal-backdrop--center{align-items:center;justify-content:center;padding:24px}
.cr-modal--merge{width:460px}
.cr-merge-rows{display:flex;flex-direction:column;gap:6px;margin:2px 0 12px}
.cr-merge-row{display:flex;gap:10px;font-size:12px;line-height:18px;align-items:baseline}
.cr-merge-row-key{flex:none;width:64px;color:var(--cr-text-3)}
.cr-merge-row-val{flex:1;min-width:0;color:var(--cr-text-2);overflow-wrap:anywhere}
.cr-merge-row-val--mono{font-family:var(--cr-mono);font-size:11.5px;color:var(--cr-text-3)}
.cr-merge-row-val--title{color:var(--cr-text);font-weight:500}
.cr-merge-risk{margin-top:11px;padding:8px 10px;border-radius:8px;font-size:11.5px;line-height:17px;color:var(--dsw-alias-state-warn-label);background:color-mix(in srgb,var(--cr-orange) 10%,transparent);border:1px solid color-mix(in srgb,var(--cr-orange) 24%,transparent)}
.cr-merge-error{margin-top:10px;padding:8px 10px;border-radius:8px;font-size:11.5px;line-height:17px;color:var(--cr-text-2);background:color-mix(in srgb,var(--cr-red) 8%,transparent);border:1px solid color-mix(in srgb,var(--cr-red) 22%,transparent)}
.cr-merge-error b{color:var(--cr-red);font-weight:600;margin-right:5px}
.cr-merge-ok{margin-top:10px;padding:8px 10px;border-radius:8px;font-size:11.5px;line-height:17px;color:var(--cr-text-2);background:color-mix(in srgb,var(--cr-green) 9%,transparent);border:1px solid color-mix(in srgb,var(--cr-green) 24%,transparent)}

/* ---------------- v2: PR chat panel ---------------- */
.cr-chat{position:absolute;right:21px;bottom:80px;z-index:9;width:420px;max-width:calc(100% - 42px);max-height:60%;display:flex;flex-direction:column;border:1px solid var(--cr-border-strong);border-radius:12px;background:var(--cr-card);box-shadow:0 12px 32px var(--dsw-alias-bg-mask-2);overflow:hidden}
.cr-chat-head{flex:none;display:flex;align-items:center;gap:6px;padding:9px 8px 8px 13px;border-bottom:1px solid var(--cr-border)}
.cr-chat-title{flex:1;min-width:0;display:flex;align-items:center;gap:7px;font-size:13px;font-weight:600;color:var(--cr-text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cr-chat-status{flex:none;font-size:11px;color:var(--cr-text-3);font-variant-numeric:tabular-nums}
.cr-chat-head-btn{display:grid;place-items:center;width:26px;height:26px;padding:0;border:0;border-radius:7px;background:transparent;color:var(--cr-text-2);cursor:pointer}
.cr-chat-head-btn:hover{background:var(--cr-hover);color:var(--cr-text)}
.cr-chat-head-btn:disabled{opacity:.45;cursor:not-allowed}
.cr-chat-body{flex:1;min-height:0;overflow-y:auto;padding:12px 13px 8px;display:flex;flex-direction:column;gap:10px}
.cr-chat-msg{display:flex;flex-direction:column;gap:3px;max-width:100%}
.cr-chat-msg--user{align-items:flex-end}
.cr-chat-who{font-size:10.5px;line-height:15px;color:var(--cr-text-3);padding:0 2px}
.cr-chat-bubble{padding:8px 11px;border-radius:10px;font-size:12.5px;line-height:19px;white-space:pre-wrap;overflow-wrap:anywhere;max-width:100%;color:var(--cr-text-2);background:var(--cr-panel);border:1px solid var(--cr-border)}
.cr-chat-msg--user .cr-chat-bubble{background:color-mix(in srgb,var(--cr-blue) 12%,transparent);border-color:color-mix(in srgb,var(--cr-blue) 26%,transparent);color:var(--cr-text)}
.cr-chat-msg--assistant .cr-chat-bubble{background:var(--cr-bg)}
.cr-chat-caret{display:inline-block;width:6px;height:12px;margin-left:2px;vertical-align:-2px;background:var(--cr-text-2);animation:cr-blink 1s steps(1) infinite}
@keyframes cr-blink{50%{opacity:0}}
.cr-chat-empty{display:flex;flex-direction:column;gap:6px;padding:8px 2px}
.cr-chat-empty-title{font-size:13px;font-weight:600;color:var(--cr-text)}
.cr-chat-empty-text{font-size:12px;line-height:18px;color:var(--cr-text-3)}
.cr-chat-quick{display:flex;flex-direction:column;gap:6px;margin-top:6px}
.cr-chat-quick-btn{display:flex;align-items:center;gap:7px;width:100%;text-align:left;padding:7px 9px;border:1px solid var(--cr-border-2);border-radius:8px;background:transparent;color:var(--cr-text-2);font-size:12px;line-height:18px;cursor:pointer}
.cr-chat-quick-btn:hover{background:var(--cr-hover);color:var(--cr-text)}
.cr-chat-error{padding:8px 10px;border-radius:8px;background:color-mix(in srgb,var(--cr-red) 9%,transparent);border:1px solid color-mix(in srgb,var(--cr-red) 24%,transparent);font-size:11.5px;line-height:17px;color:var(--cr-text-2)}
.cr-chat-error-head{display:flex;align-items:center;gap:6px;color:var(--cr-red);font-weight:600;margin-bottom:2px}
.cr-chat-error-actions{display:flex;gap:6px;margin-top:6px}
.cr-chat-foot{flex:none;display:flex;align-items:center;gap:8px;padding:6px 8px 8px 12px;border-top:1px solid var(--cr-border);font-size:10.5px;line-height:15px;color:var(--cr-text-3)}
.cr-chat-foot-spacer{flex:1}
.cr-chat-stop{display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 8px;border:1px solid var(--cr-border-strong);border-radius:6px;background:transparent;color:var(--cr-text-2);font-size:11px;cursor:pointer}
.cr-chat-stop:hover{background:var(--cr-hover);color:var(--cr-text)}

/* ---------------- v2: interactive composer (real PR chat input) ---------------- */
.cr-composer{position:absolute;right:21px;bottom:21px;z-index:8;display:flex;align-items:flex-end;gap:7px;width:min(560px,calc(100% - 42px));min-height:43px;padding:5px 6px 5px 12px;border-radius:22px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 11%,var(--dsw-alias-bg-base));box-shadow:0 8px 24px var(--dsw-alias-bg-mask-2)}
.cr-composer:focus-within{outline:1px solid var(--cr-border-strong);outline-offset:0;border-color:var(--cr-text-2)}
.cr-root .cr-composer-input:focus-visible{outline:none;box-shadow:none}
.cr-composer-plus{flex:none;align-self:center;display:grid;place-items:center;color:var(--cr-text-3)}
.cr-composer-input{flex:1;min-width:0;max-height:92px;padding:8px 0;border:0;outline:none;background:transparent;color:var(--cr-text);font:13.5px/20px ${SANS};resize:none;overflow-y:auto}
.cr-composer-input::placeholder{color:var(--cr-text-3)}
.cr-composer-input:disabled{opacity:.6}
.cr-composer-icons{flex:none;display:flex;align-items:center;gap:1px;align-self:center;color:var(--cr-text-3)}
.cr-composer-iconbtn{display:grid;place-items:center;width:28px;height:28px;padding:0;border:0;border-radius:8px;background:transparent;color:var(--cr-text-3);cursor:pointer}
.cr-composer-iconbtn:hover{background:var(--cr-hover);color:var(--cr-text)}
.cr-composer-iconbtn:disabled{opacity:.4;cursor:not-allowed}
.cr-composer-send{flex:none;align-self:center;display:grid;place-items:center;width:31px;height:31px;border:0;border-radius:50%;background:color-mix(in srgb,var(--cr-blue) 55%,var(--cr-bg));color:var(--cr-text);cursor:pointer}
.cr-composer-send:hover:not(:disabled){background:color-mix(in srgb,var(--cr-blue) 72%,var(--cr-bg))}
.cr-composer-send:disabled{opacity:.45;cursor:not-allowed}
@container (max-width: 900px){
  .cr-chat{right:12px;left:12px;width:auto;bottom:72px}
  .cr-composer{right:12px;left:12px;width:auto}
}
@media (max-width: 900px){
  .cr-chat{right:12px;left:12px;width:auto;bottom:72px}
  .cr-composer{right:12px;left:12px;width:auto}
}

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
@container (max-width: 1240px){
  .cr-details{display:none}
  .cr-cluster{max-width:800px}
  .cr-toolbar-icons{display:none}
}
@container (max-width: 860px){
  .cr-review-label{display:none}
  .cr-review-short{display:inline}
}
@media (prefers-reduced-motion: reduce){
  .cr-root *,.cr-root *::before,.cr-root *::after{animation-duration:.001ms!important;animation-iteration-count:1!important;transition-duration:.001ms!important}
}

/* Workbench hierarchy: navigation, review document, supporting context. */
.cr-root{--cr-merge-bg:var(--dsw-alias-button-primary-fill);--cr-merge-fg:var(--dsw-alias-label-primary-foreground);font:14px/20px ${SANS}}
.cr-root ::selection{background:color-mix(in srgb,var(--cr-blue) 28%,transparent);color:var(--cr-text)}
.cr-root{scrollbar-color:var(--cr-raised) transparent;scrollbar-width:thin}
.cr-root input,.cr-root textarea{caret-color:var(--cr-blue)}
.cr-root a{text-underline-offset:3px}
.cr-side{border-right:1px solid var(--cr-border)}
.cr-side-head{padding:20px 16px 8px}
.cr-side-title{font-size:18px;line-height:26px;font-weight:650}
.cr-search-wrap{padding:8px 12px 16px}
.cr-search{width:100%;border-radius:8px;background:var(--cr-bg);border:1px solid var(--cr-border-strong)}
.cr-list{padding:0 8px 16px;gap:4px}
.cr-row{flex-shrink:0;min-height:104px;padding:12px;border-radius:8px}
.cr-row--active,.cr-row--active:hover{background:var(--cr-card);box-shadow:inset 0 0 0 1px var(--cr-border-strong)}
.cr-row-context{display:flex;justify-content:space-between;gap:8px;margin-bottom:6px;color:var(--cr-text-2);font-size:11px;line-height:16px}
.cr-row-context span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cr-row-title{font-size:13px;line-height:19px;color:var(--cr-text)}
.cr-row-meta{margin-top:8px;font-size:11px;color:var(--cr-text-2)}
.cr-row-author{color:var(--cr-text-2)}
.cr-toolbar{min-height:60px;height:auto;padding:12px 24px;gap:12px;border-bottom:1px solid var(--cr-border)}
.cr-tabs{border-radius:8px;padding:3px;background:var(--cr-panel)}
.cr-tab{height:30px;border-radius:6px;font-size:13px}
.cr-tab--active,.cr-tab--active:hover{background:var(--cr-raised);color:var(--cr-text)}
.cr-review{border-radius:8px;height:34px}
.cr-review-main{font-size:13px}
.cr-btn{border-radius:8px;font-size:13px}
.cr-btn--merge{background:var(--cr-merge-bg)}
.cr-root .cr-btn--merge{color:var(--cr-merge-fg)}
.cr-root .cr-btn--merge:hover{background:var(--dsw-alias-button-primary-hover)}
.cr-cluster{gap:32px;max-width:1240px;padding:0 24px}
.cr-doc{flex:1;width:auto;max-width:820px;padding:28px 0 112px;scrollbar-gutter:stable}
.cr-details{width:272px;padding:16px 0 88px}
.cr-pr-badges{gap:10px}
.cr-pr-repo{font-size:12px;color:var(--cr-text-2)}
.cr-pr-title{margin:16px 0 12px;font-size:26px;line-height:1.35;font-weight:650;letter-spacing:-.02em;overflow-wrap:anywhere}
.cr-pr-meta{flex-wrap:wrap;gap:8px;font-size:12px;color:var(--cr-text-2)}
.cr-branches{font-size:11px;min-width:0}
.cr-branch{max-width:180px}
.cr-md{margin-top:32px;font-size:15px;line-height:1.75;color:var(--cr-text);max-width:75ch}
.cr-md p{margin:0 0 16px}
.cr-md h2{margin:32px 0 12px;font-size:20px;line-height:1.4}
.cr-md h3{margin:24px 0 8px;font-size:17px;line-height:1.5}
.cr-md-list li{line-height:1.75;margin-bottom:8px}
.cr-md code{background:var(--dsw-alias-markdown-inline-code,var(--cr-card));color:var(--cr-text);font-size:12px}
.cr-md pre{background:var(--dsw-alias-markdown-code-block,var(--cr-panel));color:var(--cr-text);padding:16px;border-radius:8px}
.cr-md a{color:var(--cr-blue)}
.cr-review-card{margin:28px 0 8px;padding:20px 0;border:0;border-top:1px solid var(--cr-border);border-bottom:1px solid var(--cr-border);border-radius:0;background:transparent}
.cr-review-card-head{align-items:flex-start;gap:12px;flex-wrap:wrap}
.cr-review-card-title{font-size:14px;color:var(--cr-text)}
.cr-review-card-meta{font-size:12px;color:var(--cr-text-2);flex-wrap:wrap;gap:6px}
.cr-review-card-actions{gap:6px;flex-wrap:wrap}
.cr-review-verdict-row{margin-top:16px;gap:10px;flex-wrap:wrap}
.cr-verdict-hint{font-size:12px;color:var(--cr-text-2)}
.cr-review-counts{margin-top:16px;padding:12px 0;border-top:1px solid var(--cr-border);border-bottom:0;gap:24px;font-size:12px;font-variant-numeric:tabular-nums}
.cr-review-meta-row{flex-wrap:wrap;font-size:12px;color:var(--cr-text-2)}
.cr-chips{gap:6px;margin-top:16px}
.cr-chip{height:28px;border-radius:6px;border-color:var(--cr-border-strong);font-size:12px}
.cr-chip--active,.cr-chip--active:hover{background:var(--cr-raised);color:var(--cr-text);border-color:var(--cr-border-strong)}
.cr-finding{margin:0;padding:20px 0;border:0;border-bottom:1px solid var(--cr-border);border-radius:0;background:transparent}
.cr-finding::before{display:none}
.cr-finding:last-child{border-bottom:0;padding-bottom:0}
.cr-finding-head{gap:8px}
.cr-finding-title{margin-top:8px;font-size:15px;line-height:23px;font-weight:600;color:var(--cr-text)}
.cr-finding-loc{margin-top:6px;font-size:11px;line-height:18px;color:var(--cr-blue);overflow-wrap:anywhere}
.cr-finding-body{margin-top:12px;font-size:13px;line-height:22px;color:var(--cr-text-2)}
.cr-finding-label{font-size:12px;font-weight:600;color:var(--cr-text);background:transparent}
.cr-finding-actions{margin-top:12px}
.cr-inline-card,.cr-inline-comment{background:var(--cr-panel);border:1px solid var(--cr-border);border-radius:8px}
.cr-file{border-color:var(--cr-border);border-radius:8px;background:var(--cr-bg)}
.cr-file-head{min-height:42px;background:var(--cr-panel)}
.cr-file--open .cr-file-head{background:var(--cr-panel)}
.cr-file-path{color:var(--cr-text-2)}
.cr-diff{background:var(--cr-bg);font-size:12px;line-height:20px}
.cr-diff-hunk{background:var(--cr-panel);color:var(--cr-text-2)}
.cr-sec{padding:20px 0;border-bottom:1px solid var(--cr-border)}
.cr-sec-title{font-size:12px;font-weight:600;color:var(--cr-text)}
.cr-sec-body{margin-top:12px}
.cr-thread-dot{border-color:var(--cr-border-strong)}
.cr-thread-resolve:hover{background:var(--cr-hover)}
.cr-empty-line{font-size:12px;color:var(--cr-text-2)}
.cr-composer{border:1px solid var(--cr-border-strong);border-radius:12px;background:var(--cr-panel);box-shadow:0 8px 24px var(--dsw-alias-bg-mask-2)}
.cr-composer-input{font-size:13px}
.cr-modal,.cr-chat{background:var(--cr-panel)}

/* ---- real GitHub avatars ---- */
.cr-avatar{position:relative;overflow:hidden}
.cr-avatar-initial{line-height:1}
.cr-avatar-img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;border-radius:50%;background:var(--cr-raised)}
.cr-avatar:has(.cr-avatar-img) .cr-avatar-initial{visibility:hidden}

/* ---- comments: inline threads ---- */
.cr-threads{display:flex;flex-direction:column;gap:1px;margin:6px -6px 0}
.cr-thread{display:flex;align-items:flex-start;gap:8px;min-height:40px;padding:8px 6px;border-radius:6px;cursor:pointer;color:var(--cr-text-2)}
.cr-thread:hover{background:var(--cr-hover);color:var(--cr-text)}
.cr-thread:focus-visible{outline:2px solid rgba(64,201,119,.45);outline-offset:0}
.cr-thread--resolved{color:var(--cr-text-3)}
.cr-thread-state{flex:none;display:grid;place-items:center;width:16px;height:16px;border-radius:50%;color:var(--cr-green)}
.cr-thread--resolved .cr-thread-state{color:var(--cr-green)}
.cr-thread-dot{width:13px;height:13px;border:1.5px solid var(--cr-border-strong);border-radius:50%}
.cr-thread-title{flex:1;min-width:0;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow-wrap:anywhere;font-size:12px;line-height:18px}
.cr-thread--resolved .cr-thread-title{text-decoration:line-through;text-decoration-color:rgba(174,174,174,.5)}
.cr-thread-count{flex:none;font-size:11.5px;color:var(--cr-text-3)}
.cr-thread-resolve{flex:none;height:22px;padding:0 8px;border:0;border-radius:6px;background:var(--cr-raised);color:var(--cr-text);font-size:11.5px;cursor:pointer;display:inline-flex;align-items:center}
.cr-thread-resolve:hover{background:var(--cr-hover)}
.cr-thread-resolve:disabled{opacity:.6;cursor:default}
.cr-thread-resolved{flex:none;font-size:11.5px;color:var(--cr-text-3)}
.cr-comment-issue-list{margin-top:8px;display:flex;flex-direction:column;gap:2px}
.cr-comment-body{-webkit-line-clamp:3;display:-webkit-box;-webkit-box-orient:vertical;overflow:hidden}
.cr-comments-more{align-self:flex-start;margin-top:8px;height:24px;padding:0 8px;border:0;border-radius:6px;background:transparent;color:var(--cr-text-2);font-size:12px;cursor:pointer}
.cr-comments-more:hover{background:var(--cr-hover);color:var(--cr-text)}
.cr-changes-row{display:flex;align-items:center;gap:8px;margin-top:6px;font-size:13px}
.cr-changes-count{color:var(--cr-text);font-weight:500}
.cr-stat--add{color:var(--cr-green)}
.cr-stat--del{color:var(--cr-red)}

/* Compact screens keep PR navigation available above the document. */
@container (max-width:900px){
  .cr-layout{flex-direction:column}
  .cr-side{display:flex;flex:0 0 176px;width:100%;border-right:0;border-bottom:1px solid var(--cr-border)}
  .cr-side-head{padding:8px 16px 0}
  .cr-side-title{font-size:15px;line-height:22px}
  .cr-search-wrap{padding:4px 16px 8px}
  .cr-search{height:30px}
  .cr-list{flex-direction:row;padding:0 12px 8px;overflow-x:auto;overflow-y:hidden;gap:8px}
  .cr-row{flex:0 0 224px;min-height:0;padding:8px 10px}
  .cr-row-context{margin-bottom:2px}
  .cr-row-title{-webkit-line-clamp:1}
  .cr-row-meta{margin-top:4px}
  .cr-main{flex:1;min-height:0}
  .cr-toolbar{min-height:52px;padding:8px 12px;gap:6px;flex-wrap:wrap}
  .cr-cluster{padding:0 16px}
  .cr-doc{padding-top:20px}
  .cr-pr-title{font-size:22px}
  .cr-details{display:none}
  .cr-review-card{margin-top:20px}
  .cr-composer{bottom:12px}
}
@container (max-width:480px){
  .cr-tab{padding:0 8px;font-size:12px}
  .cr-toolbar .cr-btn--merge{padding:0 8px;font-size:12px}
  .cr-review-main{padding:0 8px;font-size:12px}
  .cr-review-gear{width:28px}
  .cr-review-card-actions{width:100%}
  .cr-review-counts{gap:16px}
}

/* ---- settings section (DSH panel) keeps host tokens ---- */
.cr-panel-root{
  --cr-bg:var(--dsw-alias-bg-base);
  --cr-side:color-mix(in srgb,var(--dsw-alias-label-primary) 3%,var(--cr-bg));
  --cr-panel:color-mix(in srgb,var(--dsw-alias-label-primary) 5%,var(--cr-bg));
  --cr-card:color-mix(in srgb,var(--dsw-alias-label-primary) 7%,var(--cr-bg));
  --cr-raised:color-mix(in srgb,var(--dsw-alias-label-primary) 12%,var(--cr-bg));
  --cr-hover:color-mix(in srgb,var(--dsw-alias-label-primary) 4.5%,var(--cr-bg));
  --cr-hair:color-mix(in srgb,var(--dsw-alias-label-primary) 13%,transparent);
  --cr-hair-soft:color-mix(in srgb,var(--dsw-alias-label-primary) 7%,transparent);
  --cr-text:var(--dsw-alias-label-primary);
  --cr-text-2:var(--dsw-alias-label-secondary);
  --cr-text-3:var(--dsw-alias-label-tertiary);
  --cr-faint:var(--dsw-alias-label-caption);
  --cr-border:var(--dsw-alias-border-l1);
  --cr-border-2:var(--dsw-alias-border-l2);
  --cr-border-strong:var(--dsw-alias-border-l3);
  --cr-green:var(--dsw-alias-state-success-primary);
  --cr-red:var(--dsw-alias-state-error-primary);
  --cr-orange:var(--dsw-alias-state-warn-primary);
  --cr-yellow:var(--dsw-alias-state-warn-secondary);
  --cr-blue:var(--dsw-alias-state-business-primary);
  --cr-mono:${MONO};
  font:13px/20px ${SANS};color:var(--cr-text);background:transparent;
}
.cr-panel-root :focus-visible{outline:2px solid color-mix(in srgb,var(--cr-blue) 60%,transparent);outline-offset:1px}
/* ---- v0.9: DSH Settings section (row-based, native settings language) ---- */
.cr-panel-root :focus-visible{outline:2px solid color-mix(in srgb,var(--dsw-alias-label-primary) 60%,transparent);outline-offset:1px}
.cr-set-page{width:100%;max-width:840px;margin:0 auto;padding:20px 24px 32px;box-sizing:border-box;color:var(--cr-text)}
.cr-set-sec{margin:0 0 28px}
.cr-set-sec:last-child{margin-bottom:0}
.cr-set-head{display:flex;align-items:baseline;gap:10px;margin:0 0 3px}
.cr-set-title{margin:0;font:600 14.5px/20px ${SANS};letter-spacing:-.01em;color:var(--cr-text)}
.cr-set-note{margin-left:auto;font:11.5px/16px ${SANS};color:var(--cr-text-3)}
.cr-set-desc{margin:0 0 6px;font:12px/18px ${SANS};color:var(--cr-text-3);max-width:56ch}
.cr-set-rows{border-top:1px solid var(--cr-hair-soft)}
.cr-set-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px 24px;padding:11px 0;border-bottom:1px solid var(--cr-hair-soft)}
.cr-set-row--stack{align-items:stretch;flex-direction:column;gap:8px}
.cr-set-text{flex:1 1 220px;min-width:0}
.cr-set-label{font:12.5px/18px ${SANS};color:var(--cr-text)}
.cr-set-hint{margin-top:2px;font:11.5px/16px ${SANS};color:var(--cr-text-3);max-width:54ch}
.cr-set-control{flex:0 1 auto;min-width:0;display:flex;flex-wrap:wrap;align-items:center;gap:8px;justify-content:flex-end}
.cr-set-row--stack .cr-set-control{justify-content:flex-start}
.cr-shared-settings{width:min(720px,calc(100% - 32px))}
.cr-shared-settings .cr-set-page{max-width:none;padding:8px 0 0}
.cr-shared-settings .cr-panel-root{background:transparent}
.cr-set-row--stack .cr-set-control{width:100%}
.cr-set-row--stack .cr-set-text{flex:0 0 auto}
.cr-seg{display:inline-flex;align-items:center;gap:2px;padding:2px;border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 6%,transparent)}
.cr-seg-btn{height:24px;padding:0 10px;border:0;border-radius:6px;background:transparent;color:var(--cr-text-2);font:12px/24px ${SANS};cursor:pointer;white-space:nowrap}
.cr-seg-btn:hover{color:var(--cr-text)}
.cr-seg-btn:disabled{opacity:.45;cursor:not-allowed}
.cr-seg-btn--on,.cr-seg-btn--on:hover{background:color-mix(in srgb,var(--cr-text) 10%,transparent);color:var(--cr-text);box-shadow:inset 0 0 0 1px var(--cr-hair),0 1px 2px color-mix(in srgb,#000 22%,transparent)}
.cr-toggle{position:relative;width:34px;height:20px;flex:none;padding:0;border:0;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 24%,transparent);cursor:pointer;transition:background .15s ease}
.cr-toggle:disabled{opacity:.45;cursor:not-allowed}
.cr-toggle--on{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 82%,var(--cr-bg))}
.cr-toggle-knob{position:absolute;left:2px;top:2px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 2px color-mix(in srgb,#000 26%,transparent);transition:transform .15s ease}
.cr-toggle--on .cr-toggle-knob{transform:translateX(14px)}
.cr-set-num{width:68px;height:26px;padding:0 7px;border:1px solid var(--cr-hair);border-radius:6px;background:color-mix(in srgb,var(--cr-text) 3%,transparent);color:var(--cr-text);font:12px/24px var(--cr-mono);text-align:right;font-variant-numeric:tabular-nums}
.cr-set-num:focus{outline:none;border-color:color-mix(in srgb,var(--dsw-alias-label-primary) 48%,transparent)}
.cr-set-input{width:100%;height:28px;padding:0 9px;border:1px solid var(--cr-hair);border-radius:6px;background:color-mix(in srgb,var(--cr-text) 3%,transparent);color:var(--cr-text);font:12px/26px var(--cr-mono)}
.cr-set-input:focus{outline:none;border-color:color-mix(in srgb,var(--dsw-alias-label-primary) 48%,transparent)}
.cr-set-unit{font:11.5px/16px ${SANS};color:var(--cr-text-3)}
.cr-set-inline{margin-top:8px;padding:8px 10px;border-radius:6px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 6%,transparent);font:11.5px/17px ${SANS};color:var(--cr-text-2)}
.cr-set-inline--warn{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 12%,transparent);color:var(--dsw-alias-state-warn-label)}
.cr-set-inline b{display:block;margin-bottom:2px;font-weight:600;color:var(--cr-text)}
.cr-set-actions{display:flex;gap:8px;margin-top:7px}
.cr-set-status{display:flex;flex-direction:column;border-top:1px solid var(--cr-hair-soft)}
.cr-set-status-row{display:flex;align-items:center;gap:12px;padding:9px 0;border-bottom:1px solid var(--cr-hair-soft)}
.cr-set-status-row:last-child{border-bottom:0}
.cr-set-status-key{flex:1;font:12.5px/18px ${SANS};color:var(--cr-text-2)}
.cr-set-status-val{font:12px/18px var(--cr-mono);color:var(--cr-text)}
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
      const src = typeof (props && props.src) === 'string' ? props.src : ''
      const initial = h('span', { className: 'cr-avatar-initial' }, name.slice(0, 1).toUpperCase())
      if (src === '') {
        return h(
          'span',
          { className: 'cr-avatar cr-avatar--' + size, 'aria-hidden': 'true', title: name },
          initial,
        )
      }
      return h(
        'span',
        { className: 'cr-avatar cr-avatar--' + size, 'aria-hidden': 'true', title: name },
        initial,
        h('img', {
          className: 'cr-avatar-img',
          src,
          alt: '',
          loading: 'lazy',
          decoding: 'async',
          referrerPolicy: 'no-referrer',
          onError: (event) => {
            const img = event && event.currentTarget
            if (!img) return
            img.style.display = 'none'
            const fallback = img.parentNode && img.parentNode.querySelector('.cr-avatar-initial')
            if (fallback) fallback.style.visibility = 'visible'
          },
        }),
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
          ref: props.inputRef,
          placeholder: tx(t, 'searchPlaceholder'),
          'aria-label': tx(t, 'searchLabel'),
          'aria-keyshortcuts': '/',
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
          onMouseEnter: () => {
            if (typeof props.onPrefetch === 'function') props.onPrefetch(pr)
          },
          onFocus: () => {
            if (typeof props.onPrefetch === 'function') props.onPrefetch(pr)
          },
        },
        h('span', { className: 'cr-row-context' },
          h('span', null, String(pr.repo || '')),
          h('span', null, '#' + String(pr.number || '')),
        ),
        h('span', { className: 'cr-row-title' }, pr.title || '(untitled)'),
        h(
          'span',
          { className: 'cr-row-meta' },
          h(Avatar, { name: pr.author, size: 16, src: pr.authorAvatarUrl }),
          h('span', { className: 'cr-row-author' }, pr.author || 'unknown'),
          h('span', { className: 'cr-row-sep' }, '·'),
          h(RelativeTime, { iso: pr.updatedAt, t }),
          pr.isDraft ? h('span', { className: 'cr-badge-draft' }, tx(t, 'draft')) : null,
          stateKey === 'closed' ? h('span', { className: 'cr-row-sep' }, '#' + pr.number) : null,
          props.autoBadge
            ? h(
                'span',
                {
                  className: 'cr-row-auto cr-row-auto--' + props.autoBadge.kind,
                  'data-auto-badge': props.autoBadge.kind,
                  title: tx(
                    t,
                    props.autoBadge.titleKey,
                    props.autoBadge.titleVars || undefined,
                  ),
                  'aria-label': tx(
                    t,
                    props.autoBadge.titleKey,
                    props.autoBadge.titleVars || undefined,
                  ),
                },
                props.autoBadge.text,
              )
            : null,
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
            inputRef: props.inputRef,
            onChange: props.onQueryChange,
            onCommit: props.onRefresh,
            onClear: props.onClearQuery,
          }),
        ),
        h(
          'div',
          {
            className: 'cr-list',
            ref: props.listRef,
            role: 'list',
            'aria-label': tx(t, 'panel'),
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
                      autoBadge: autoReviewBadge(
                        (props.autoBadges || Object.create(null))[
                          String(pr.repo || '') + '#' + String(pr.number)
                        ],
                      ),
                      t,
                      active: selectedNumber !== null && Number(pr.number) === Number(selectedNumber),
                      onSelect: props.onSelect,
                      onPrefetch: props.onPrefetch,
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
          title: tx(t, 'readOnly'),
          'aria-readonly': 'true',
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
      let reviewLabel = tx(t, 'reviewWithAi')
      let reviewShortLabel = tx(t, 'reviewShort')
      if (review.state === 'preparing') {
        reviewLabel = tx(t, 'preparing')
        reviewShortLabel = reviewLabel
      } else if (review.state === 'running') {
        reviewLabel = tx(t, 'reviewing')
        reviewShortLabel = reviewLabel
      }
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
              disabled: !props.url,
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
              disabled: !props.url,
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
              'aria-label': reviewLabel,
              'aria-keyshortcuts': 'r',
              title: props.settingsSummary ? reviewLabel + ' · ' + props.settingsSummary : reviewLabel,
              onClick: props.onReview,
            },
            busy ? h('span', { className: 'cr-spinner' }) : Icon('brain', 15),
            h('span', { className: 'cr-review-label' }, reviewLabel),
            h('span', { className: 'cr-review-short' }, reviewShortLabel),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'cr-review-gear',
              'data-action': 'review-settings',
              ref: props.gearRef,
              'aria-label': tx(t, 'reviewSettings'),
              'aria-haspopup': 'dialog',
              'aria-expanded': props.settingsOpen ? 'true' : 'false',
              title: tx(t, 'reviewSettings'),
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
            disabled: !props.mergeEnabled,
            'aria-disabled': props.mergeEnabled ? 'false' : 'true',
            'aria-haspopup': 'dialog',
            'aria-expanded': props.mergeOpen ? 'true' : 'false',
            title: props.mergeTitle || tx(t, 'merge'),
            onClick: props.onMerge,
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
          props.onComment
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'cr-btn cr-btn--ghost',
                  'data-action': 'pr-comment',
                  style: { marginLeft: 'auto' },
                  onClick: props.onComment,
                },
                Icon('comment', 12),
                h('span', { style: { marginLeft: '5px' } }, tx(t, 'prComment')),
              )
            : null,
        ),
        h(
          'h1',
          { className: 'cr-pr-title' },
          h('span', { className: 'cr-pr-title-text' }, summary.title || '(untitled)'),
        ),
        h(
          'div',
          { className: 'cr-pr-meta' },
          h(Avatar, { name: summary.author, size: 22, src: summary.authorAvatarUrl }),
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

    /** Verdict pill for the review card: block / changes / approve (CONTRACT §4.2). */
    function VerdictBadge(props) {
      const t = props.t
      const verdict = props.verdict
      if (verdict !== 'block' && verdict !== 'changes' && verdict !== 'approve') return null
      return h(
        'span',
        {
          className: 'cr-verdict cr-verdict--' + verdict,
          'data-verdict': verdict,
          title: tx(t, verdictHintKey(verdict)),
        },
        Icon(verdict === 'approve' ? 'check' : 'alert', 11, { strokeWidth: 2 }),
        tx(t, verdictKey(verdict)),
      )
    }

    /**
     * Review metadata that only exists in v1.1 payloads: resolved options,
     * reused files, cache hits and the AGENTS.md injection report. Renders
     * nothing for an older Host so the card degrades instead of breaking.
     */
    function ReviewMetaRow(props) {
      const t = props.t
      const review = props.review || {}
      const options =
        review.options && typeof review.options === 'object'
          ? describeReviewOptions(review.options)
          : null
      const guidelines =
        review.guidelines && typeof review.guidelines === 'object'
          ? normalizeGuidelines(review.guidelines)
          : null
      const items = []
      if (options) {
        const summary = tx(t, 'reviewOptionsSummary', {
          depth: tx(t, depthKey(options.depth)),
          threshold: tx(t, thresholdKey(options.severityThreshold)),
        })
        items.push(
          h(
            'span',
            { key: 'options', className: 'cr-review-meta-item', title: summary, 'data-review-options': 'ready' },
            Icon('gear', 11),
            h('span', null, summary),
          ),
        )
      }
      const reused = Number(review.reusedFiles) || 0
      if (reused > 0) {
        items.push(
          h(
            'span',
            { key: 'reused', className: 'cr-review-meta-item cr-review-meta-item--good', 'data-review-reused': String(reused) },
            Icon('clock', 11),
            h('span', null, tx(t, 'reusedFiles', { n: formatNumber(reused) })),
          ),
        )
      }
      if (review.cached) {
        items.push(
          h(
            'span',
            { key: 'cached', className: 'cr-review-meta-item', 'data-review-cached': 'true' },
            h('span', { className: 'cr-chip-tag' }, tx(t, 'cached')),
          ),
        )
      }
      if (guidelines) {
        let text
        if (!guidelines.loaded) {
          text =
            options && options.includeGuidelines === false
              ? tx(t, 'guidelinesDisabled')
              : tx(t, 'guidelinesMissing')
        } else {
          text = tx(t, 'guidelinesLoaded', {
            files: guidelines.files.join('、') || 'AGENTS.md',
            chars: formatNumber(guidelines.chars),
          })
        }
        items.push(
          h(
            'span',
            {
              key: 'guidelines',
              className:
                'cr-review-meta-item' + (guidelines.loaded ? ' cr-review-meta-item--good' : ''),
              title: guidelines.files.join(', '),
              'data-review-guidelines': guidelines.loaded ? 'loaded' : 'missing',
            },
            Icon('file', 11),
            h('span', null, text),
          ),
        )
      }
      if (items.length === 0) return null
      return h('div', { className: 'cr-review-meta-row' }, items)
    }

    /** One finding rendered inside an expanded diff line (CONTRACT §4.5.1). */
    function FindingInlineCard(props) {
      const t = props.t
      const finding = props.finding || {}
      const severity = finding.severity === 'P0' || finding.severity === 'P1' ? finding.severity : 'P2'
      const location =
        String(finding.file || '') +
        ':' +
        (finding.line === null || finding.line === undefined ? '?' : finding.line) +
        (finding.lineEnd ? '-' + finding.lineEnd : '')
      const confidence = confidenceKey(finding.confidence)
      return h(
        'div',
        {
          className: 'cr-inline-card cr-inline-card--' + severity,
          'data-inline-finding': finding.id || '',
          role: 'group',
          'aria-label': String(finding.title || '') + ' · ' + location,
        },
        h(
          'div',
          { className: 'cr-inline-head' },
          h(SeverityBadge, { severity }),
          finding.category
            ? h('span', { className: 'cr-finding-cat' }, String(finding.category))
            : null,
          confidence
            ? h(
                'span',
                { className: 'cr-chip-tag cr-chip-tag--confidence-' + finding.confidence },
                tx(t, 'confidence') + ' ' + tx(t, confidence),
              )
            : null,
          props.onClose
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'cr-inline-close',
                  'aria-label': tx(t, 'closeCard'),
                  title: tx(t, 'closeCard'),
                  onClick: () => {
                    if (typeof props.onClose === 'function') props.onClose()
                  },
                },
                Icon('close', 11, { strokeWidth: 2 }),
              )
            : null,
        ),
        h('div', { className: 'cr-inline-title' }, String(finding.title || '')),
        h(
          'div',
          { className: 'cr-inline-loc', title: location },
          Icon('file', 10),
          h('span', null, truncateMiddle(location, 80)),
        ),
        finding.why
          ? h(
              'div',
              { className: 'cr-inline-body' },
              h('span', { className: 'cr-inline-label' }, tx(t, 'why')),
              String(finding.why),
            )
          : null,
        finding.fix
          ? h(
              'div',
              { className: 'cr-inline-body' },
              h('span', { className: 'cr-inline-label' }, tx(t, 'fix')),
              String(finding.fix),
            )
          : null,
        finding.evidence
          ? h(
              'div',
              null,
              h('div', { className: 'cr-inline-loc', style: { color: 'var(--cr-text-3)' } }, tx(t, 'evidence')),
              h('pre', { className: 'cr-inline-evidence' }, String(finding.evidence)),
            )
          : null,
        h(
          'div',
          { className: 'cr-inline-foot' },
          h(
            'button',
            {
              type: 'button',
              className: 'cr-btn cr-btn--ghost',
              'data-action': 'locate-inline',
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

    /**
     * Existing GitHub inline comment (read-only body) plus the v2.3 write
     * actions: reply to the comment and resolve its discussion thread
     * (CONTRACT §8). The actions only appear when the Host supplied the comment
     * id / thread id, so an older Host degrades to the read-only card.
     */
    function InlineCommentCard(props) {
      const t = props.t
      const comment = props.comment || {}
      const [replyOpen, setReplyOpen] = useState(false)
      const [replyText, setReplyText] = useState('')
      const [phase, setPhase] = useState('idle')
      const [resolveConfirm, setResolveConfirm] = useState(false)
      const [resolved, setResolved] = useState(comment.isResolved === true)
      const preview = truncateText(comment.body, COMMENT_PREVIEW_CHARS)
      const line = comment.line === null || comment.line === undefined ? '' : comment.line
      const label =
        line === ''
          ? tx(t, 'inlineCommentFile')
          : tx(t, 'inlineCommentTitle', { path: String(comment.path || ''), line })
      const canReply = typeof props.onReply === 'function' && Number.isInteger(comment.id) && comment.id > 0
      const canResolve =
        typeof props.onResolve === 'function' && typeof comment.threadId === 'string' && comment.threadId !== '' && resolved !== true
      const busy = phase === 'sending'
      const sendReply = () => {
        const body = replyText.trim()
        if (body === '' || busy) return
        setPhase('sending')
        Promise.resolve(props.onReply(comment, body)).then(
          (ok) => {
            setPhase(ok === true ? 'idle' : 'error')
            if (ok === true) {
              setReplyOpen(false)
              setReplyText('')
            }
          },
          () => setPhase('error'),
        )
      }
      const resolveThread = () => {
        if (busy) return
        setPhase('sending')
        Promise.resolve(props.onResolve(comment)).then(
          (ok) => {
            setPhase('idle')
            if (ok === true) {
              setResolved(true)
              setResolveConfirm(false)
            }
          },
          () => setPhase('error'),
        )
      }
      return h(
        'div',
        {
          className: 'cr-inline-comment',
          'data-inline-comment': String(comment.path || '') + ':' + line,
          role: 'note',
          'aria-label': label,
        },
        h(
          'div',
          { className: 'cr-inline-comment-head' },
          Icon('comment', 11),
          h(Avatar, { name: comment.author, size: 16 }),
          h('span', { className: 'cr-inline-comment-author' }, String(comment.author || 'unknown')),
          h('span', null, '·'),
          h(RelativeTime, { iso: comment.createdAt, t }),
          preview.truncated
            ? h('span', { className: 'cr-chip-tag' }, tx(t, 'commentTruncated'))
            : null,
        ),
        h(
          'div',
          { className: 'cr-inline-comment-body', title: String(comment.body || '') },
          preview.text,
        ),
        canReply || canResolve || resolved
          ? h(
              'div',
              { className: 'cr-inline-actions' },
              canReply
                ? h(
                    'button',
                    {
                      type: 'button',
                      className: 'cr-btn cr-btn--ghost',
                      'data-action': 'inline-reply',
                      'aria-expanded': replyOpen ? 'true' : 'false',
                      onClick: () => {
                        setReplyOpen((previous) => !previous)
                        if (phase === 'error') setPhase('idle')
                      },
                    },
                    tx(t, 'inlineReply'),
                  )
                : null,
              canResolve
                ? h(
                    'button',
                    {
                      type: 'button',
                      className: 'cr-btn cr-btn--ghost',
                      'data-action': 'inline-resolve',
                      onClick: () => setResolveConfirm(true),
                    },
                    tx(t, 'inlineResolve'),
                  )
                : null,
              resolved
                ? h('span', { className: 'cr-chip-tag', 'data-inline-resolved': 'true' }, tx(t, 'inlineResolved'))
                : null,
            )
          : null,
        replyOpen
          ? h(
              'div',
              { className: 'cr-inline-reply', 'data-inline-reply-composer': 'ready' },
              h('textarea', {
                value: replyText,
                rows: 2,
                placeholder: tx(t, 'inlineReplyPlaceholder'),
                'aria-label': tx(t, 'inlineReply'),
                onChange: (event) => setReplyText(event.target.value),
              }),
              h(
                'div',
                { className: 'cr-inline-actions' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'cr-btn',
                    'data-action': 'inline-reply-send',
                    disabled: busy || replyText.trim() === '',
                    onClick: sendReply,
                  },
                  busy ? tx(t, 'writeSending') : tx(t, 'inlineReplySend'),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'cr-btn cr-btn--ghost',
                    'data-action': 'inline-reply-cancel',
                    onClick: () => {
                      setReplyOpen(false)
                      setReplyText('')
                      if (phase === 'error') setPhase('idle')
                    },
                  },
                  tx(t, 'writeCancel'),
                ),
              ),
              phase === 'error' ? h('div', { className: 'cr-comment-error' }, tx(t, 'writeFailed')) : null,
            )
          : null,
        resolveConfirm && resolved !== true
          ? h(
              'div',
              { className: 'cr-inline-resolve-confirm', 'data-inline-resolve-confirm': 'ready' },
              h('span', null, tx(t, 'inlineResolveConfirm')),
              h(
                'button',
                {
                  type: 'button',
                  className: 'cr-btn',
                  'data-action': 'inline-resolve-confirm',
                  disabled: busy,
                  onClick: resolveThread,
                },
                busy ? tx(t, 'writeSending') : tx(t, 'inlineResolveYes'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'cr-btn cr-btn--ghost',
                  'data-action': 'inline-resolve-cancel',
                  onClick: () => setResolveConfirm(false),
                },
                tx(t, 'writeCancel'),
              ),
            )
          : null,
      )
    }

    /**
     * Confirmation dialog for posting a PR conversation comment (CONTRACT §8).
     * The confirm button is the only path that issues the write.
     */
    function CommentDialog(props) {
      const t = props.t
      const text = typeof props.text === 'string' ? props.text : ''
      const busy = props.phase === 'submitting'
      const error = props.error && typeof props.error === 'object' ? props.error : null
      return h(
        'div',
        {
          className: 'cr-modal-backdrop',
          role: 'presentation',
          onMouseDown: (event) => {
            if (event.target === event.currentTarget) props.onCancel()
          },
        },
        h(
          'div',
          {
            className: 'cr-modal cr-comment-dialog',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-labelledby': 'cr-comment-title',
            'data-cr-comment-dialog': 'open',
            'data-comment-phase': props.phase || 'idle',
          },
          h(
            'div',
            { className: 'cr-modal-head' },
            h('span', { className: 'cr-modal-title', id: 'cr-comment-title' }, tx(t, 'commentDialogTitle')),
            h(
              'button',
              {
                type: 'button',
                className: 'cr-modal-close',
                'aria-label': tx(t, 'writeCancel'),
                title: tx(t, 'writeCancel'),
                onClick: props.onCancel,
              },
              Icon('close', 12),
            ),
          ),
          h('p', { className: 'cr-modal-note' }, tx(t, 'commentDialogNote')),
          h(
            'div',
            { className: 'cr-comment-dialog-body' },
            h('textarea', {
              value: text,
              rows: 5,
              placeholder: tx(t, 'commentDialogPlaceholder'),
              'aria-label': tx(t, 'commentDialogTitle'),
              disabled: busy,
              onChange: (event) => props.onTextChange(event.target.value),
            }),
          ),
          error
            ? h(
                'div',
                { className: 'cr-comment-error', 'data-comment-error': error.code || 'INTERNAL' },
                String(error.message || tx(t, 'writeFailed')),
              )
            : null,
          h(
            'div',
            { className: 'cr-modal-actions' },
            h(
              'button',
              {
                type: 'button',
                className: 'cr-btn cr-btn--ghost',
                'data-action': 'comment-cancel',
                onClick: props.onCancel,
              },
              tx(t, 'writeCancel'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'cr-btn',
                'data-action': 'comment-send',
                disabled: busy || text.trim() === '',
                onClick: props.onConfirm,
              },
              busy ? tx(t, 'writeSending') : tx(t, 'commentDialogSend'),
            ),
          ),
        ),
      )
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
      const findings = sortFindings(review.findings)
      const [filter, setFilter] = useState('all')
      const reviewKey = String(review.jobId || '') + ':' + state + ':' + findings.length
      // A new review (or a new PR) always starts on the "all" chip.
      useEffect(() => {
        setFilter('all')
      }, [reviewKey])
      if (state === 'none') return null
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
      const verdict = reviewVerdict(review)
      const filtered = filterFindings(findings, filter)
      // Host may report an incomplete review (some chunks failed / model output
      // truncated). Surface it instead of pretending the diff is clean.
      const partialReasons = Array.isArray(review.partialReasons) ? review.partialReasons : []
      const truncatedCalls = Number(review.truncatedCalls) || 0
      const partial = Boolean(review.partial) || partialReasons.length > 0 || truncatedCalls > 0
      const filters = [
        { value: 'all', label: tx(t, 'filterAll'), count: findings.length },
        { value: 'P0', label: 'P0', count: counts.P0 },
        { value: 'P1', label: 'P1', count: counts.P1 },
        { value: 'P2', label: 'P2', count: counts.P2 },
      ]
      return h(
        'section',
        { className: 'cr-review-card', 'data-review-state': state, 'aria-busy': running ? 'true' : 'false' },
        h(
          'div',
          { className: 'cr-review-card-head' },
          h('span', { className: 'cr-review-card-title' }, Icon('brain', 15), tx(t, 'aiReviewTitle')),
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
                props.finishedAt > 0
                  ? h(RelativeTime, { iso: new Date(props.finishedAt).toISOString(), t })
                  : null,
                partial ? h('span', { className: 'cr-file-badge' }, tx(t, 'reviewPartial')) : null,
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
            !running &&
            state === 'done' &&
            findings.length > 0 &&
            props.publish &&
            props.publish.supported
              ? props.publish.published && props.publish.published.url
                ? h(
                    'a',
                    {
                      className: 'cr-publish-published',
                      'data-action': 'review-published-link',
                      'data-publish-published': 'true',
                      href: props.publish.published.url,
                      target: '_blank',
                      rel: 'noopener noreferrer',
                      title: tx(t, 'publishPublishedLink'),
                    },
                    Icon('check', 12, { strokeWidth: 2 }),
                    tx(t, 'publishPublishedLink'),
                  )
                : h(
                    'button',
                    {
                      type: 'button',
                      className: 'cr-btn',
                      'data-action': 'review-publish',
                      onClick: () => {
                        if (typeof props.publish.onOpen === 'function') props.publish.onOpen()
                      },
                    },
                    Icon('comment', 12),
                    tx(t, 'publish'),
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
                { className: 'cr-review-verdict-row', 'data-review-verdict': verdict },
                h(VerdictBadge, { verdict, t }),
                h(
                  'span',
                  { className: 'cr-verdict-hint' },
                  partial ? tx(t, 'reviewPartialHint') : tx(t, verdictHintKey(verdict)),
                ),
              ),
              h(SeverityCounts, { counts }),
              h(ReviewMetaRow, { review, t }),
              review.overview ? h('div', { className: 'cr-review-verdict' }, String(review.overview)) : null,
              partial
                ? h(
                    'div',
                    { className: 'cr-review-error', 'data-review-partial': 'true' },
                    h('b', null, tx(t, 'reviewPartial') + ' '),
                    h(
                      'span',
                      null,
                      partialReasons.length > 0
                        ? partialReasons.slice(0, 3).join('；')
                        : tx(t, 'reviewPartialHint'),
                    ),
                    truncatedCalls > 0
                      ? h('div', null, tx(t, 'truncatedCalls', { n: truncatedCalls }))
                      : null,
                  )
                : null,
              findings.length === 0
                ? partial
                  ? null
                  : h(
                      'div',
                      { className: 'cr-review-progress' },
                      h('span', null, tx(t, 'reviewClean')),
                      h('span', { style: { color: 'var(--cr-text-3)' } }, tx(t, 'reviewCleanHint')),
                    )
                : h(
                    'div',
                    null,
                    h(
                      'div',
                      { className: 'cr-chips', role: 'group', 'aria-label': tx(t, 'filters') },
                      filters.map((chip) =>
                        h(
                          'button',
                          {
                            key: chip.value,
                            type: 'button',
                            className:
                              'cr-chip' +
                              (chip.value === 'all' ? '' : ' cr-chip--' + chip.value) +
                              (filter === chip.value ? ' cr-chip--active' : ''),
                            'aria-pressed': filter === chip.value ? 'true' : 'false',
                            'data-filter': chip.value,
                            onClick: () => setFilter(chip.value),
                          },
                          h('span', null, chip.label),
                          h('span', { className: 'cr-chip-count' }, String(chip.count)),
                        ),
                      ),
                    ),
                    filtered.length === 0
                      ? h('div', { className: 'cr-filter-empty' }, tx(t, 'noFindingsForFilter'))
                      : filtered.map((finding, findingIndex) =>
                          h(FindingItem, {
                            key:
                              (finding.id || finding.file + ':' + finding.line) +
                              ':' +
                              findingIndex,
                            finding,
                            t,
                            onLocate: props.onLocate,
                          }),
                        ),
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

    const DiffView = React.memo(function DiffView(props) {
      const t = props.t
      const rows = useMemo(() => parseUnifiedDiff(props.patch || ''), [props.patch])
      const [showAll, setShowAll] = useState(false)
      const [openLines, setOpenLines] = useState({})
      // Findings for this file, bucketed by new-file line for the gutter markers.
      const byLine = useMemo(() => {
        const byFile = groupFindingsByLine(props.findings)
        const scoped = props.filePath ? byFile[props.filePath] : null
        if (scoped) return scoped
        // Degraded host payload: findings may carry a shortened file path.
        const merged = Object.create(null)
        for (const finding of asArray(props.findings)) {
          const line = Number(finding && finding.line)
          if (!Number.isFinite(line) || line <= 0) continue
          if (!merged[line]) merged[line] = []
          merged[line].push(finding)
        }
        return merged
      }, [props.findings, props.filePath])
      // Existing GitHub review comments grouped by line; null-line ones are file-level.
      const commentLines = useMemo(() => {
        const lines = Object.create(null)
        const general = []
        for (const comment of normalizeInlineComments(props.comments)) {
          if (comment.line === null) {
            general.push(comment)
            continue
          }
          if (!lines[comment.line]) lines[comment.line] = []
          lines[comment.line].push(comment)
        }
        return { lines, general }
      }, [props.comments])
      const highlightLine = Number.isFinite(Number(props.highlightLine))
        ? Number(props.highlightLine)
        : null
      const toggleLine = useCallback((line) => {
        setOpenLines((previous) => Object.assign({}, previous, { [line]: !previous[line] }))
      }, [])
      // "Locate in diff" from the review list also expands the inline card.
      useEffect(() => {
        if (highlightLine === null) return
        setOpenLines((previous) =>
          previous[highlightLine] ? previous : Object.assign({}, previous, { [highlightLine]: true }),
        )
      }, [highlightLine])

      if (rows.length === 0) {
        return h('div', { className: 'cr-diff-empty' }, tx(t, 'emptyDiff'))
      }
      const visible = showAll ? rows : rows.slice(0, MAX_VISIBLE_ROWS)
      const children = []
      visible.forEach((row, index) => {
        if (row.type === 'hunk') {
          children.push(h('div', { key: 'h' + index, className: 'cr-diff-hunk' }, String(row.text || '')))
          return
        }
        if (row.type === 'meta') {
          children.push(h('div', { key: 'm' + index, className: 'cr-diff-meta' }, String(row.text || '')))
          return
        }
        const line = row.newLine === null || row.newLine === undefined ? null : Number(row.newLine)
        const marks = line !== null && byLine[line] ? sortFindings(byLine[line]) : null
        const worst = marks && marks.length > 0 ? marks[0].severity || 'P2' : 'P2'
        const isOpen = Boolean(line !== null && openLines[line])
        const isTarget = highlightLine !== null && line === highlightLine
        children.push(
          h(
            'div',
            {
              key: 'r' + index,
              className:
                'cr-diff-row cr-diff-row--' +
                row.type +
                (isTarget ? ' cr-diff-row--target' : '') +
                (isOpen ? ' cr-diff-row--open' : ''),
              'data-cr-line': line === null ? undefined : String(line),
            },
            h(
              'span',
              { className: 'cr-diff-mark' },
              marks
                ? h(
                    'button',
                    {
                      type: 'button',
                      className: 'cr-diff-dotbtn cr-diff-dot--' + worst,
                      'data-inline-marker': String(line),
                      'aria-expanded': isOpen ? 'true' : 'false',
                      'aria-label': tx(t, 'findingsOnLineAria', {
                        line,
                        n: marks.length,
                        severity: worst,
                      }),
                      title: tx(t, 'findingsOnLine', { line, n: marks.length }),
                      onClick: (event) => {
                        if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
                        toggleLine(line)
                      },
                    },
                    h('span', { className: 'cr-diff-dot' }),
                    marks.length > 1
                      ? h('span', { className: 'cr-diff-dotcount' }, String(marks.length))
                      : null,
                  )
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
          ),
        )
        if (isOpen && marks) {
          children.push(
            h(
              'div',
              {
                key: 'fi' + index,
                className: 'cr-diff-inline',
                'data-inline-open': String(line),
              },
              marks.length > 1
                ? h(
                    'div',
                    { className: 'cr-diff-inline-head' },
                    Icon('alert', 11),
                    h('span', null, tx(t, 'findingsOnLine', { line, n: marks.length })),
                  )
                : null,
              marks.map((finding, markIndex) =>
                h(FindingInlineCard, {
                  key: (finding.id || '') + ':' + markIndex,
                  finding,
                  t,
                  onLocate: props.onLocate,
                  onClose: () => toggleLine(line),
                }),
              ),
            ),
          )
        }
        if (line !== null && commentLines.lines[line]) {
          children.push(
            h(
              'div',
              { key: 'ci' + index, className: 'cr-diff-comments' },
              commentLines.lines[line].map((comment, commentIndex) =>
                h(InlineCommentCard, {
                  key: commentIndex,
                  comment,
                  t,
                  onReply: props.writeActions && props.writeActions.reply,
                  onResolve: props.writeActions && props.writeActions.resolve,
                }),
              ),
            ),
          )
        }
      })
      if (commentLines.general.length > 0) {
        children.push(
          h(
            'div',
            { key: 'cg', className: 'cr-diff-comments' },
            commentLines.general.map((comment, commentIndex) =>
              h(InlineCommentCard, {
                key: commentIndex,
                comment,
                t,
                onReply: props.writeActions && props.writeActions.reply,
                onResolve: props.writeActions && props.writeActions.resolve,
              }),
            ),
          ),
        )
      }
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
      return h(
        'div',
        { className: 'cr-diff', role: 'table', 'aria-label': 'diff' },
        children,
      )
    })

    const FileCard = React.memo(function FileCard(props) {
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
      const findings = Array.isArray(props.findings) ? props.findings : EMPTY_LIST
      const comments = Array.isArray(props.comments) ? props.comments : EMPTY_LIST
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
            onClick: () => {
              if (typeof props.onToggle === 'function') props.onToggle(props.fileKey)
            },
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
                comments,
                filePath: path,
                highlightLine: props.highlightLine,
                onLocate: props.onLocate,
                writeActions: props.writeActions,
                t,
              }),
              file.patchTruncated
                ? h('div', { className: 'cr-diff-empty' }, tx(t, 'patchTruncated'))
                : null,
            )
          : null,
      )
    })

    const ChangesView = React.memo(function ChangesView(props) {
      const t = props.t
      const detail = props.detail || {}
      const files = Array.isArray(detail.files) ? detail.files : []
      const summary = detail.summary || {}
      const reportedFiles = Number(summary.changedFiles) || 0
      const findingsByFile = props.findingsByFile || Object.create(null)
      const expanded = props.expanded || Object.create(null)
      // Existing GitHub review comments, re-bucketed per file for the diff.
      const commentsByFile = useMemo(() => {
        const grouped = groupCommentsByFile(detail.comments && detail.comments.inline)
        const map = Object.create(null)
        for (const path of Object.keys(grouped)) {
          const bucket = grouped[path]
          const list = []
          for (const line of Object.keys(bucket.lines)) {
            for (const comment of bucket.lines[line]) list.push(comment)
          }
          for (const comment of bucket.general) list.push(comment)
          map[path] = list
        }
        return map
      }, [detail.comments])
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
                fileKey: key,
                file,
                index,
                t,
                open: Boolean(expanded[key]),
                findings: findingsByFile[key] || EMPTY_LIST,
                comments: commentsByFile[key] || EMPTY_LIST,
                highlightLine: props.highlight && props.highlight.path === key ? props.highlight.line : null,
                onToggle: props.onToggleFile,
                onLocate: props.onLocate,
                writeActions: props.writeActions,
              })
            }),
        detail.filesTruncated
          ? h('div', { className: 'cr-md-notice' }, tx(t, 'filesTruncated'))
          : null,
      )
    })

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
      const fileList = Array.isArray(detail.files) ? detail.files : []
      const findingsByFile = props.findingsByFile || Object.create(null)
      const visibleFiles = fileList.slice(0, 6)
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
        fileList.length > 0
          ? h(
              'div',
              { className: 'cr-filelinks', 'data-cr-filelinks': 'ready' },
              visibleFiles.map((file, index) => {
                const path = String((file && file.path) || '')
                const key = fileKey(file, index)
                const scoped = findingsByFile[key] || []
                const worst = scoped.length > 0 ? sortFindings(scoped)[0].severity || 'P2' : null
                const label = tx(t, 'jumpToFile', { name: path })
                return h(
                  'button',
                  {
                    key,
                    type: 'button',
                    className: 'cr-filelink',
                    'data-action': 'goto-file',
                    'data-file-key': key,
                    title: label,
                    'aria-label': label,
                    onClick: () => {
                      if (typeof props.onJumpFile === 'function') props.onJumpFile(key, index)
                    },
                  },
                  Icon('file', 11),
                  h('span', { className: 'cr-filelink-name' }, path),
                  worst
                    ? h(
                        'span',
                        { className: 'cr-filelink-badge cr-filelink-badge--' + worst },
                        String(scoped.length),
                      )
                    : null,
                )
              }),
              fileList.length > visibleFiles.length
                ? h(
                    'div',
                    { className: 'cr-empty-line', style: { paddingLeft: 17 } },
                    tx(t, 'moreFiles', { n: fileList.length - visibleFiles.length }),
                  )
                : null,
            )
          : null,
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
      const threads = groupCommentThreads(comments.inline)
      const total = Number.isFinite(Number(comments.total))
        ? Number(comments.total)
        : issue.length + threads.length
      const [expanded, setExpanded] = useState(false)
      const [resolvedIds, setResolvedIds] = useState({})
      const [busyId, setBusyId] = useState('')
      if (issue.length === 0 && threads.length === 0) {
        return h(Section, { title: tx(t, 'noComments'), empty: true })
      }
      const canResolve = typeof props.onResolve === 'function'
      const canLocate = typeof props.onLocate === 'function'
      const requestResolve = (thread) => {
        if (!canResolve || !thread || busyId !== '') return
        if (thread.resolved || resolvedIds[thread.threadId] === true) return
        if (thread.threadId === '' || !thread.root) return
        setBusyId(thread.threadId)
        Promise.resolve(props.onResolve(thread.root)).then(
          (ok) => {
            setBusyId('')
            if (ok === true) {
              setResolvedIds((previous) => Object.assign({}, previous, { [thread.threadId]: true }))
            }
          },
          () => setBusyId(''),
        )
      }
      const locate = (thread) => {
        if (!canLocate || !thread) return
        props.onLocate({ file: thread.path, line: thread.line })
      }
      const visibleThreads = expanded ? threads : threads.slice(0, 5)
      const visibleIssue = expanded ? issue : issue.slice(0, 3)
      return h(
        Section,
        { title: tx(t, 'comments') + (total > 0 ? ' · ' + total : '') },
        threads.length > 0
          ? h(
              'div',
              { className: 'cr-threads', 'data-cr-threads': String(threads.length) },
              visibleThreads.map((thread) => {
                const resolved = thread.resolved || resolvedIds[thread.threadId] === true
                return h(
                  'div',
                  {
                    key: thread.threadId || 'c:' + String(thread.path) + ':' + String(thread.line) + ':' + String(thread.author),
                    className: 'cr-thread' + (resolved ? ' cr-thread--resolved' : ''),
                    role: 'button',
                    tabIndex: 0,
                    title: String(thread.path || '') + (thread.line === null ? '' : ':' + thread.line),
                    'data-cr-thread': resolved ? 'resolved' : 'open',
                    onClick: () => locate(thread),
                    onKeyDown: (event) => {
                      if (event && event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) {
                        event.preventDefault()
                        locate(thread)
                      }
                    },
                  },
                  h('span', { className: 'cr-thread-state', 'aria-hidden': 'true' }, resolved ? Icon('check', 11, { strokeWidth: 2.4 }) : h('span', { className: 'cr-thread-dot' })),
                  h(Avatar, { name: thread.author, size: 16, src: thread.avatarUrl }),
                  thread.severity
                    ? h('span', { className: 'cr-file-badge cr-file-badge--' + thread.severity }, thread.severity)
                    : null,
                  h('span', { className: 'cr-thread-title' }, String(thread.title || '')),
                  thread.replies > 0 ? h('span', { className: 'cr-thread-count' }, '+' + thread.replies) : null,
                  canResolve && thread.threadId !== '' && !resolved
                    ? h(
                        'button',
                        {
                          type: 'button',
                          className: 'cr-thread-resolve',
                          'data-action': 'thread-resolve',
                          disabled: busyId === thread.threadId,
                          'aria-label': tx(t, 'resolve') + ' ' + String(thread.title || ''),
                          onClick: (event) => {
                            if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
                            requestResolve(thread)
                          },
                        },
                        busyId === thread.threadId ? h('span', { className: 'cr-spinner' }) : tx(t, 'resolve'),
                      )
                    : resolved
                      ? h('span', { className: 'cr-thread-resolved' }, tx(t, 'resolved'))
                      : null,
                )
              }),
            )
          : null,
        visibleIssue.length > 0
          ? h(
              'div',
              { className: 'cr-comment-issue-list' },
              visibleIssue.map((comment, index) =>
                h(
                  'div',
                  { key: 'i' + index, className: 'cr-comment' },
                  h(
                    'div',
                    { className: 'cr-comment-head' },
                    h(Avatar, { name: comment.author, size: 16, src: comment.avatarUrl }),
                    h('span', { className: 'cr-comment-author' }, String(comment.author || 'unknown')),
                    h('span', null, '·'),
                    h(RelativeTime, { iso: comment.createdAt, t }),
                  ),
                  h('div', { className: 'cr-comment-body' }, truncateText(comment.body, 240).text),
                ),
              ),
            )
          : null,
        threads.length > 5 || issue.length > 3
          ? h(
              'button',
              {
                type: 'button',
                className: 'cr-comments-more',
                'data-action': 'comments-more',
                onClick: () => setExpanded((value) => !value),
              },
              expanded ? tx(t, 'commentsShowLess') : tx(t, 'commentsShowMore'),
            )
          : null,
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
          'aria-label': tx(t, 'reviewersDisabled'),
          title: tx(t, 'reviewersDisabled'),
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
            h(Avatar, { name: review.author, size: 16, src: review.avatarUrl }),
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
      const partial =
        Boolean(review.partial) ||
        (Array.isArray(review.partialReasons) && review.partialReasons.length > 0) ||
        Number(review.truncatedCalls) > 0
      return h(
        Section,
        { title: tx(t, 'aiReviewTitle') },
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
                { className: 'cr-review-verdict-row', 'data-review-verdict': reviewVerdict(review) },
                h(VerdictBadge, { verdict: reviewVerdict(review), t }),
                h(
                  'span',
                  { className: 'cr-verdict-hint' },
                  partial ? tx(t, 'reviewPartialHint') : tx(t, verdictHintKey(reviewVerdict(review))),
                ),
              ),
              h(SeverityCounts, { counts }),
              h(ReviewMetaRow, { review, t }),
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

    /**
     * Review-options popover opened by the toolbar gear (CONTRACT §4.5.3):
     * depth, severity threshold and the AGENTS.md toggle. Every change is
     * persisted immediately; Esc / the backdrop close it and focus returns to
     * the gear (handled by the workbench).
     */
    /**
     * The toolbar dialog renders the same settings form as the native settings page.
     */
    function ReviewSettings(props) {
      const t = props.t
      const dialogRef = useRef(null)
      const onClose = props.onClose
      useEffect(() => {
        try {
          const root = dialogRef.current
          if (!root || typeof root.querySelector !== 'function') return
          const checked = root.querySelector('input:checked')
          const target = checked || root
          if (target && typeof target.focus === 'function') target.focus()
        } catch {
          /* focus is a nicety; never let it break the dialog */
        }
      }, [])
      const handleKeyDown = (event) => {
        try {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            if (typeof onClose === 'function') onClose()
            return
          }
          if (event.key !== 'Tab') return
          const root = dialogRef.current
          if (!root || typeof root.querySelectorAll !== 'function') return
          const nodes = root.querySelectorAll(
            'button, input, [tabindex]:not([tabindex="-1"])',
          )
          if (nodes.length === 0) return
          const first = nodes[0]
          const last = nodes[nodes.length - 1]
          const active = typeof document !== 'undefined' ? document.activeElement : null
          if (event.shiftKey && active === first) {
            event.preventDefault()
            last.focus()
          } else if (!event.shiftKey && active === last) {
            event.preventDefault()
            first.focus()
          }
        } catch {
          /* a focus-trap failure must not break the dialog */
        }
      }
      return h(
        'div',
        {
          className: 'cr-modal-backdrop',
          'data-cr-settings-backdrop': 'ready',
          onMouseDown: (event) => {
            if (event && event.target === event.currentTarget && typeof onClose === 'function') {
              onClose()
            }
          },
        },
        h(
          'div',
          {
            className: 'cr-modal cr-shared-settings',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-labelledby': 'cr-review-settings-title',
            tabIndex: -1,
            ref: dialogRef,
            onKeyDown: handleKeyDown,
            'data-cr-settings': 'ready',
          },
          h(
            'div',
            { className: 'cr-modal-head' },
            h(
              'span',
              { className: 'cr-modal-title', id: 'cr-review-settings-title' },
              tx(t, 'reviewSettings'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'cr-modal-close',
                'aria-label': tx(t, 'close'),
                'data-action': 'settings-close',
                title: tx(t, 'close'),
                onClick: () => {
                  if (typeof onClose === 'function') onClose()
                },
              },
              Icon('close', 13, { strokeWidth: 2 }),
            ),
          ),
          h(CodeReviewSettingsPanel, { t }),
        ),
      )
    }

    /**
     * DSH Settings panel section (v0.9): a row-based page for review options,
     * automatic review, publishing and host status. All settings live on the
     * host and are shared by manual and automatic reviews.
     */

    /** A settings section: title, optional description, and rows. */
    function SettingsSection(props) {
      return h(
        'section',
        { className: 'cr-set-sec' },
        h(
          'div',
          { className: 'cr-set-head' },
          h('h2', { className: 'cr-set-title' }, props.title),
          props.note ? h('span', { className: 'cr-set-note' }, props.note) : null,
        ),
        props.desc ? h('p', { className: 'cr-set-desc' }, props.desc) : null,
        h('div', { className: 'cr-set-rows' }, props.children),
      )
    }

    /** One label/hint + control row; `stack` puts the control below the text. */
    function SettingRow(props) {
      return h(
        'div',
        { className: 'cr-set-row' + (props.stack ? ' cr-set-row--stack' : '') },
        h(
          'div',
          { className: 'cr-set-text' },
          h('div', { className: 'cr-set-label' }, props.label),
          props.hint ? h('div', { className: 'cr-set-hint' }, props.hint) : null,
        ),
        h('div', { className: 'cr-set-control' }, props.children),
      )
    }

    /** Segmented radio control used by the settings rows. */
    function Segmented(props) {
      return h(
        'div',
        { className: 'cr-seg', role: 'radiogroup', 'aria-label': props.label },
        (props.options || []).map((option) =>
          h(
            'button',
            {
              key: option.value,
              type: 'button',
              'data-depth': props.kind === 'depth' ? option.value : undefined,
              'data-threshold': props.kind === 'threshold' ? option.value : undefined,
              'data-auto-interval-preset': props.kind === 'interval' ? option.value : undefined,
              role: 'radio',
              'aria-checked': option.value === props.value ? 'true' : 'false',
              className: 'cr-seg-btn' + (option.value === props.value ? ' cr-seg-btn--on' : ''),
              title: option.hint || '',
              disabled: Boolean(props.disabled),
              onClick: () => {
                if (option.value !== props.value && typeof props.onChange === 'function') {
                  props.onChange(option.value)
                }
              },
            },
            option.label,
          ),
        ),
      )
    }

    /** Switch control used by the settings rows. */
    function Toggle(props) {
      return h(
        'button',
        {
          type: 'button',
          role: 'switch',
          'data-auto-enabled': props.kind === 'auto-enabled' ? 'toggle' : undefined,
          'data-guidelines': props.kind === 'guidelines' ? 'toggle' : undefined,
          'aria-checked': props.checked ? 'true' : 'false',
          'aria-label': props.label,
          className: 'cr-toggle' + (props.checked ? ' cr-toggle--on' : ''),
          disabled: Boolean(props.disabled),
          onClick: () => {
            if (typeof props.onChange === 'function') props.onChange(!props.checked)
          },
        },
        h('span', { className: 'cr-toggle-knob' }),
      )
    }

    function CodeReviewSettingsPanel(props) {
      const t = props.t
      const [autoReview, setAutoReview] = useState({ supported: true, loading: true, status: null })
      const [autoReviewBusy, setAutoReviewBusy] = useState(false)
      const [autoReviewResetToken, setAutoReviewResetToken] = useState(0)
      const [health, setHealth] = useState(null)
      const [note, setNote] = useState('')
      const [publishPending, setPublishPending] = useState(false)
      const [drafts, setDrafts] = useState({ interval: '', maxPerCycle: '', query: '', maxComments: '' })

      const refresh = useCallback(() => {
        setAutoReview((previous) => ({ ...previous, loading: true, error: null }))
        post(ROUTE + '/health', {}).then((result) => {
          setHealth(result.ok ? result.value || {} : { gh: 'unknown', llm: 'unknown', version: '' })
        })
        post(ROUTE + '/auto-review-status', {}).then((result) => {
          if (result.ok) {
            setAutoReview({ supported: true, loading: false, status: normalizeAutoReviewStatus(result.value) })
            cacheSharedSettings(result.value?.config)
            return
          }
          if (isAutoReviewRouteMissing(result.error)) {
            setAutoReview({ supported: false, loading: false, status: null })
            return
          }
          setAutoReview((previous) => ({ ...previous, loading: false, error: result.error || { code: 'INTERNAL' } }))
        })
      }, [])

      useEffect(() => {
        refresh()
      }, [refresh])

      useEffect(() => {
        if (note === '') return undefined
        const timer = setTimeout(() => setNote(''), 1800)
        return () => clearTimeout(timer)
      }, [note])

      const patchAutoReview = useCallback(
        (patch) => {
          if (!patch || typeof patch !== 'object') return
          setAutoReviewBusy(true)
          post(ROUTE + '/auto-review-config', { patch }).then((result) => {
            setAutoReviewBusy(false)
            if (result.ok) {
              setAutoReview({ supported: true, loading: false, status: normalizeAutoReviewStatus(result.value) })
              cacheSharedSettings(result.value?.config, true)
              setNote(tx(t, 'settingsSaved'))
              return
            }
            if (isAutoReviewRouteMissing(result.error)) {
              setAutoReview({ supported: false, loading: false, status: null })
              return
            }
            setNote(tx(t, 'settingsSaveFailed'))
            setAutoReviewResetToken((token) => token + 1)
            refresh()
          })
        },
        [refresh, t],
      )

      const status = autoReview.status
      const supported = autoReview.supported !== false
      const config = normalizeAutoReviewConfig(status ? status.config : null)
      const settings = normalizeSettings(config)
      const publish = status && status.publish ? status.publish : PUBLISH_DEFAULT_CONFIG
      const busy = autoReviewBusy || autoReview.loading || !status || !supported

      useEffect(() => {
        setDrafts({
          interval: String(config.intervalSeconds),
          maxPerCycle: String(config.maxPerCycle),
          query: config.query,
          maxComments: String(publish.maxComments),
        })
        if (publish.enabled) setPublishPending(false)
      }, [config.intervalSeconds, config.maxPerCycle, config.query, publish.maxComments, publish.enabled, autoReviewResetToken])

      const updateSettings = (partial) => {
        if (!busy && supported && status) patchAutoReview(partial)
      }

      const patch = (value) => {
        if (!busy) patchAutoReview(value)
      }
      const patchPublish = (partial) => patchAutoReview({ publish: partial })
      const setDraft = (key, value) => setDrafts((previous) => Object.assign({}, previous, { [key]: value }))
      const commitInterval = (raw) => {
        const value = clampInteger(raw, AUTO_REVIEW_INTERVAL_MIN, AUTO_REVIEW_INTERVAL_MAX, config.intervalSeconds)
        setDraft('interval', String(value))
        if (value !== config.intervalSeconds) patch({ intervalSeconds: value })
      }
      const commitMaxPerCycle = (raw) => {
        const value = clampInteger(raw, AUTO_REVIEW_MAX_PER_CYCLE_MIN, AUTO_REVIEW_MAX_PER_CYCLE_MAX, config.maxPerCycle)
        setDraft('maxPerCycle', String(value))
        if (value !== config.maxPerCycle) patch({ maxPerCycle: value })
      }
      const commitQuery = () => {
        const next = String(drafts.query || '').trim()
        if (next === '') {
          setDraft('query', config.query)
          return
        }
        if (next !== config.query) patch({ query: next })
      }
      const commitMaxComments = () => {
        const value = clampInteger(drafts.maxComments, PUBLISH_MAX_COMMENTS_MIN, PUBLISH_MAX_COMMENTS_MAX, publish.maxComments)
        setDraft('maxComments', String(value))
        if (value !== publish.maxComments) patchPublish({ maxComments: value })
      }
      const onEnter = (commit) => (event) => {
        if (event && event.key === 'Enter') {
          event.preventDefault()
          commit()
        }
      }

      const depthOptions = [
        { value: 'fast', label: tx(t, 'depthFast'), hint: tx(t, 'depthFastHint') },
        { value: 'standard', label: tx(t, 'depthStandard'), hint: tx(t, 'depthStandardHint') },
        { value: 'deep', label: tx(t, 'depthDeep'), hint: tx(t, 'depthDeepHint') },
      ]
      const depthHintKey =
        settings.depth === 'fast' ? 'depthFastHint' : settings.depth === 'deep' ? 'depthDeepHint' : 'depthStandardHint'
      const thresholdOptions = [
        { value: 'P0', label: tx(t, 'thresholdP0') },
        { value: 'P1', label: tx(t, 'thresholdP1') },
        { value: 'P2', label: tx(t, 'thresholdP2') },
      ]
      const publishModeOptions = [
        { value: 'inline', label: tx(t, 'publishModeInline') },
        { value: 'summary', label: tx(t, 'publishModeSummary') },
        { value: 'both', label: tx(t, 'publishModeBoth') },
      ]
      const statusRow = (key, value) =>
        h(
          'div',
          { className: 'cr-set-status-row' },
          h('span', { className: 'cr-set-status-key' }, key),
          h('span', { className: 'cr-set-status-val' }, value === undefined || value === null || value === '' ? '—' : String(value)),
        )

      return h(
        'div',
        { className: 'cr-panel-root cr-set-page', 'data-cr-settings-page': 'ready' },
        h('style', null, CSS),
        autoReview.error
          ? h('div', { className: 'cr-set-inline cr-set-inline--warn', role: 'alert' },
              h('span', null, tx(t, 'settingsLoadFailed')),
              h('div', { className: 'cr-set-actions' },
                h('button', {
                  type: 'button', className: 'cr-btn cr-btn--ghost',
                  'data-action': 'settings-retry', disabled: autoReview.loading,
                  onClick: refresh,
                }, tx(t, 'retry')),
              ),
            )
          : null,
        h(
          SettingsSection,
          { title: tx(t, 'reviewOptions'), desc: tx(t, 'settingsReviewDesc'), note: note || (autoReview.loading ? tx(t, 'settingsLoading') : '') },
          h(
            SettingRow,
            { label: tx(t, 'depth'), hint: tx(t, depthHintKey) },
            h(Segmented, {
              kind: 'depth',
              label: tx(t, 'depth'),
              disabled: busy || !supported || !status,
              value: settings.depth,
              options: depthOptions,
              onChange: (value) => updateSettings({ depth: value }),
            }),
          ),
          h(
            SettingRow,
            { label: tx(t, 'severityThreshold'), hint: tx(t, 'thresholdHint') },
            h(Segmented, {
              kind: 'threshold',
              label: tx(t, 'severityThreshold'),
              disabled: busy || !supported || !status,
              value: settings.severityThreshold,
              options: thresholdOptions,
              onChange: (value) => updateSettings({ severityThreshold: value }),
            }),
          ),
          h(
            SettingRow,
            { label: tx(t, 'includeGuidelines'), hint: tx(t, 'includeGuidelinesHint') },
            h(Toggle, {
              kind: 'guidelines',
              label: tx(t, 'includeGuidelines'),
              disabled: busy || !supported || !status,
              checked: settings.includeGuidelines,
              onChange: (value) => updateSettings({ includeGuidelines: value }),
            }),
          ),
        ),
        h(
          SettingsSection,
          { title: tx(t, 'autoReview'), desc: tx(t, 'settingsAutoDesc'), note: busy ? tx(t, 'settingsSaving') : '' },
          !supported
            ? h('div', { className: 'cr-set-inline cr-set-inline--warn' }, tx(t, 'autoReviewUnsupported') + ' · ' + tx(t, 'autoReviewUnsupportedHint'))
            : h(
                React.Fragment,
                null,
                h(
                  SettingRow,
                  { label: tx(t, 'autoReviewEnabled'), hint: tx(t, 'autoReviewHint') },
                  h(Toggle, {
                    kind: 'auto-enabled',
                    label: tx(t, 'autoReviewEnabled'),
                    checked: config.enabled,
                    disabled: busy,
                    onChange: (value) => patch({ enabled: value }),
                  }),
                ),
                !config.enabled
                  ? null
                  : h(
                      React.Fragment,
                      null,
                      h(
                        SettingRow,
                        { label: tx(t, 'autoReviewInterval'), hint: tx(t, 'settingsIntervalHint') },
                        h(Segmented, {
                          kind: 'interval',
                          label: tx(t, 'autoReviewInterval'),
                          value: config.intervalSeconds,
                          disabled: busy,
                          options: AUTO_REVIEW_INTERVAL_PRESETS.map((preset) => ({ value: preset, label: preset + 's' })),
                          onChange: (value) => commitInterval(value),
                        }),
                        h('input', {
                          type: 'number',
                          className: 'cr-set-num',
                          min: AUTO_REVIEW_INTERVAL_MIN,
                          max: AUTO_REVIEW_INTERVAL_MAX,
                          step: 10,
                          value: drafts.interval,
                          'aria-label': tx(t, 'autoReviewInterval'),
                          disabled: busy,
                          onChange: (event) => setDraft('interval', String(event.target.value)),
                          onBlur: () => commitInterval(drafts.interval),
                          onKeyDown: onEnter(() => commitInterval(drafts.interval)),
                        }),
                      ),
                      h(
                        SettingRow,
                        { label: tx(t, 'autoReviewQuery'), hint: tx(t, 'settingsQueryHint'), stack: true },
                        h('input', {
                          type: 'text',
                          className: 'cr-set-input',
                          value: drafts.query,
                          spellCheck: false,
                          'aria-label': tx(t, 'autoReviewQuery'),
                          'data-auto-query': 'ready',
                          disabled: busy,
                          onChange: (event) => setDraft('query', String(event.target.value)),
                          onBlur: commitQuery,
                          onKeyDown: onEnter(commitQuery),
                        }),
                      ),
                      h(
                        SettingRow,
                        { label: tx(t, 'autoReviewIncludeDrafts'), hint: tx(t, 'settingsDraftsHint') },
                        h(Toggle, {
                          label: tx(t, 'autoReviewIncludeDrafts'),
                          checked: config.includeDrafts,
                          disabled: busy,
                          onChange: (value) => patch({ includeDrafts: value }),
                        }),
                      ),
                      h(
                        SettingRow,
                        { label: tx(t, 'autoReviewMaxPerCycle'), hint: tx(t, 'settingsMaxPerCycleHint') },
                        h('input', {
                          type: 'number',
                          className: 'cr-set-num',
                          min: AUTO_REVIEW_MAX_PER_CYCLE_MIN,
                          max: AUTO_REVIEW_MAX_PER_CYCLE_MAX,
                          step: 1,
                          value: drafts.maxPerCycle,
                          'aria-label': tx(t, 'autoReviewMaxPerCycle'),
                          'data-auto-max': 'ready',
                          disabled: busy,
                          onChange: (event) => setDraft('maxPerCycle', String(event.target.value)),
                          onBlur: () => commitMaxPerCycle(drafts.maxPerCycle),
                          onKeyDown: onEnter(() => commitMaxPerCycle(drafts.maxPerCycle)),
                        }),
                      ),
                    ),
              ),
        ),
        h(
          SettingsSection,
          { title: tx(t, 'autoPublish'), desc: tx(t, 'settingsPublishDesc'), note: busy ? tx(t, 'settingsSaving') : '' },
          publishPending
            ? h(
                'div',
                { className: 'cr-set-inline cr-set-inline--warn' },
                h('b', null, tx(t, 'autoPublishConfirmTitle')),
                tx(t, 'autoPublishConfirmBody'),
                h(
                  'div',
                  { className: 'cr-set-actions' },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'cr-btn cr-btn--ghost',
                      onClick: () => setPublishPending(false),
                    },
                    tx(t, 'cancel'),
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'cr-btn cr-btn--primary',
                      onClick: () => {
                        setPublishPending(false)
                        patchPublish({ enabled: true })
                      },
                    },
                    tx(t, 'autoPublishConfirm'),
                  ),
                ),
              )
            : h(
                React.Fragment,
                null,
                h(
                  SettingRow,
                  { label: tx(t, 'autoPublish'), hint: publish.enabled ? tx(t, 'settingsPublishOnHint') : tx(t, 'settingsPublishOffHint') },
                  h(Toggle, {
                    label: tx(t, 'autoPublish'),
                    checked: publish.enabled,
                    disabled: busy,
                    onChange: (value) => {
                      if (value && !publish.enabled) setPublishPending(true)
                      else patchPublish({ enabled: false })
                    },
                  }),
                ),
                !publish.enabled
                  ? null
                  : h(
                      React.Fragment,
                      null,
                      h(
                        SettingRow,
                        { label: tx(t, 'autoPublishMode') },
                        h(Segmented, {
                          label: tx(t, 'autoPublishMode'),
                          value: publish.mode,
                          disabled: busy,
                          options: publishModeOptions,
                          onChange: (value) => patchPublish({ mode: value }),
                        }),
                      ),
                      h(
                        SettingRow,
                        { label: tx(t, 'autoPublishMinSeverity'), hint: tx(t, 'publishMinSeverityHint') },
                        h(Segmented, {
                          label: tx(t, 'autoPublishMinSeverity'),
                          value: publish.minSeverity,
                          disabled: busy,
                          options: thresholdOptions,
                          onChange: (value) => patchPublish({ minSeverity: value }),
                        }),
                      ),
                      h(
                        SettingRow,
                        { label: tx(t, 'autoPublishMaxComments'), hint: tx(t, 'autoPublishMaxCommentsHint') },
                        h('input', {
                          type: 'number',
                          className: 'cr-set-num',
                          min: PUBLISH_MAX_COMMENTS_MIN,
                          max: PUBLISH_MAX_COMMENTS_MAX,
                          step: 1,
                          value: drafts.maxComments,
                          'aria-label': tx(t, 'autoPublishMaxComments'),
                          disabled: busy,
                          onChange: (event) => setDraft('maxComments', String(event.target.value)),
                          onBlur: commitMaxComments,
                          onKeyDown: onEnter(commitMaxComments),
                        }),
                      ),
                    ),
              ),
        ),
        h(
          SettingsSection,
          { title: tx(t, 'settingsStatus') },
          h(
            'div',
            { className: 'cr-set-status' },
            statusRow(tx(t, 'settingsPluginVersion'), health ? health.version : ''),
            statusRow(tx(t, 'settingsHealthGh'), health ? health.gh : ''),
            statusRow(tx(t, 'settingsHealthLlm'), health ? health.llm : ''),
          ),
        ),
      )
    }

    /**
     * Merge confirmation dialog (CONTRACT §5.3). Nothing is sent until the user
     * presses 确认合并; cancelling / Esc / backdrop click never writes.
     */
    function MergeDialog(props) {
      const t = props.t
      const summary = props.summary && typeof props.summary === 'object' ? props.summary : {}
      const headSha = typeof props.headSha === 'string' ? props.headSha : ''
      const method = normalizeMergeMethod(props.method)
      const phase = props.phase === 'submitting' ? 'submitting' : 'idle'
      const error = props.error && typeof props.error === 'object' ? props.error : null
      const dialogRef = useRef(null)
      const disabled = phase === 'submitting'
      useEffect(() => {
        try {
          const node = dialogRef.current
          const first =
            node && typeof node.querySelector === 'function'
              ? node.querySelector('input[type="radio"]')
              : null
          const target = first || node
          if (target && typeof target.focus === 'function') target.focus()
        } catch {
          /* focus is best effort */
        }
      }, [])
      const cancel = () => {
        if (disabled) return
        if (typeof props.onCancel === 'function') props.onCancel()
      }
      const onKeyDown = (event) => {
        try {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            cancel()
          }
        } catch {
          /* never break the dialog */
        }
      }
      const number = summary.number === undefined ? '' : summary.number
      const repoName = String(summary.repo || '')
      const headRef = String(summary.headRefName || '')
      const baseRef = String(summary.baseRefName || '')
      const methodRows = [
        { value: 'squash', label: 'mergeSquash', hint: 'mergeSquashHint' },
        { value: 'merge', label: 'mergeCommit', hint: 'mergeCommitHint' },
        { value: 'rebase', label: 'mergeRebase', hint: 'mergeRebaseHint' },
      ]
      const errorKey = error ? mergeErrorKey(error.code) : ''
      return h(
        'div',
        {
          className: 'cr-modal-backdrop cr-modal-backdrop--center',
          'data-cr-merge-dialog': 'ready',
          onMouseDown: (event) => {
            if (event && event.target === event.currentTarget) cancel()
          },
        },
        h(
          'div',
          {
            className: 'cr-modal cr-modal--merge',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-labelledby': 'cr-merge-title',
            tabIndex: -1,
            ref: dialogRef,
            onKeyDown,
            'data-merge-phase': phase,
            'data-merge-method': method,
          },
          h(
            'div',
            { className: 'cr-modal-head' },
            h(
              'span',
              { className: 'cr-modal-title', id: 'cr-merge-title' },
              tx(t, 'mergeDialogTitle'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'cr-modal-close',
                'aria-label': tx(t, 'cancel'),
                title: tx(t, 'cancel'),
                disabled,
                onClick: cancel,
              },
              Icon('close', 13, { strokeWidth: 2 }),
            ),
          ),
          h(
            'div',
            { className: 'cr-merge-rows' },
            h(
              'div',
              { className: 'cr-merge-row' },
              h('span', { className: 'cr-merge-row-key' }, tx(t, 'mergeRepo')),
              h(
                'span',
                { className: 'cr-merge-row-val cr-merge-row-val--mono', 'data-merge-repo': 'ready' },
                repoName + (number === '' ? '' : ' #' + number),
              ),
            ),
            h(
              'div',
              { className: 'cr-merge-row' },
              h('span', { className: 'cr-merge-row-key' }, tx(t, 'mergeTarget')),
              h(
                'span',
                { className: 'cr-merge-row-val cr-merge-row-val--mono' },
                truncateMiddle(headRef, 34) + ' → ' + truncateMiddle(baseRef, 34),
              ),
            ),
            h(
              'div',
              { className: 'cr-merge-row' },
              h('span', { className: 'cr-merge-row-key' }, tx(t, 'mergeHeadSha')),
              h(
                'span',
                {
                  className: 'cr-merge-row-val cr-merge-row-val--mono',
                  'data-merge-sha': shortSha(headSha),
                  title: headSha,
                },
                shortSha(headSha) || '—',
              ),
            ),
            h(
              'div',
              { className: 'cr-merge-row' },
              h('span', { className: 'cr-merge-row-key' }, tx(t, 'mergePrTitle')),
              h('span', { className: 'cr-merge-row-val cr-merge-row-val--title' }, String(summary.title || '')),
            ),
          ),
          h(
            'fieldset',
            { className: 'cr-field' },
            h('legend', null, tx(t, 'mergeMethodLabel')),
            methodRows.map((row) =>
              h(
                'label',
                { key: row.value, className: 'cr-option' },
                h('input', {
                  type: 'radio',
                  name: 'cr-merge-method',
                  value: row.value,
                  'data-merge-method-value': row.value,
                  checked: method === row.value,
                  disabled,
                  onChange: () => {
                    if (typeof props.onMethodChange === 'function') props.onMethodChange(row.value)
                  },
                }),
                h(
                  'span',
                  { className: 'cr-option-text' },
                  h('span', { className: 'cr-option-label' }, tx(t, row.label)),
                  h('span', { className: 'cr-option-hint' }, tx(t, row.hint)),
                ),
              ),
            ),
          ),
          h(
            'label',
            { className: 'cr-option', style: { marginTop: 8 } },
            h('input', {
              type: 'checkbox',
              'data-merge-delete': 'toggle',
              checked: Boolean(props.deleteBranch),
              disabled,
              onChange: (event) => {
                if (typeof props.onDeleteBranchChange === 'function') {
                  props.onDeleteBranchChange(Boolean(event && event.target && event.target.checked))
                }
              },
            }),
            h(
              'span',
              { className: 'cr-option-text' },
              h('span', { className: 'cr-option-label' }, tx(t, 'mergeDeleteBranch')),
              h('span', { className: 'cr-option-hint' }, tx(t, 'mergeDeleteBranchHint')),
            ),
          ),
          h('div', { className: 'cr-merge-risk', role: 'note' }, Icon('alert', 12), ' ', tx(t, 'mergeRisk')),
          error
            ? h(
                'div',
                { className: 'cr-merge-error', 'data-merge-error': error.code || 'INTERNAL', role: 'alert' },
                h('b', null, String(error.code || 'INTERNAL')),
                h('span', null, errorKey ? tx(t, errorKey) : String(error.message || '')),
              )
            : null,
          h(
            'div',
            { className: 'cr-modal-actions' },
            h(
              'button',
              { type: 'button', className: 'cr-btn cr-btn--ghost', 'data-action': 'merge-cancel', disabled, onClick: cancel },
              tx(t, 'cancel'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'cr-btn cr-btn--primary',
                'data-action': 'merge-confirm',
                disabled,
                'aria-busy': disabled ? 'true' : 'false',
                onClick: () => {
                  if (!disabled && typeof props.onConfirm === 'function') props.onConfirm()
                },
              },
              disabled ? h('span', { className: 'cr-spinner' }) : Icon('merge', 13),
              tx(t, disabled ? 'mergeSubmitting' : 'mergeConfirm'),
            ),
          ),
        ),
      )
    }

    /**
     * Publish-review confirmation dialog (CONTRACT §7.3). Nothing is sent until
     * 确认发布; cancelling / Esc / backdrop never calls the publish route.
     */
    function PublishDialog(props) {
      const t = props.t
      const summary = props.summary && typeof props.summary === 'object' ? props.summary : {}
      const headSha = typeof props.headSha === 'string' ? props.headSha : ''
      const mode = PUBLISH_MODES.indexOf(props.mode) >= 0 ? props.mode : PUBLISH_DEFAULT_CONFIG.mode
      const minSeverity =
        PUBLISH_MIN_SEVERITIES.indexOf(props.minSeverity) >= 0
          ? props.minSeverity
          : PUBLISH_DEFAULT_CONFIG.minSeverity
      const phase = props.phase === 'submitting' ? 'submitting' : 'idle'
      const error = props.error && typeof props.error === 'object' ? props.error : null
      const expectedNumber = Number(props.expected)
      const expected =
        Number.isFinite(expectedNumber) && expectedNumber > 0 ? Math.round(expectedNumber) : 0
      const dialogRef = useRef(null)
      const disabled = phase === 'submitting'
      useEffect(() => {
        try {
          const node = dialogRef.current
          const first =
            node && typeof node.querySelector === 'function'
              ? node.querySelector('input[type="radio"]')
              : null
          const target = first || node
          if (target && typeof target.focus === 'function') target.focus()
        } catch {
          /* focus is best effort */
        }
      }, [])
      const cancel = () => {
        if (disabled) return
        if (typeof props.onCancel === 'function') props.onCancel()
      }
      const onKeyDown = (event) => {
        try {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            cancel()
          }
        } catch {
          /* never break the dialog */
        }
      }
      const number = summary.number === undefined ? '' : summary.number
      const repoName = String(summary.repo || '')
      const errorKey = error ? publishErrorKey(error.code) : ''
      return h(
        'div',
        {
          className: 'cr-modal-backdrop cr-modal-backdrop--center',
          'data-cr-publish-dialog': 'ready',
          onMouseDown: (event) => {
            if (event && event.target === event.currentTarget) cancel()
          },
        },
        h(
          'div',
          {
            className: 'cr-modal cr-modal--merge',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-labelledby': 'cr-publish-title',
            tabIndex: -1,
            ref: dialogRef,
            onKeyDown,
            'data-publish-phase': phase,
            'data-publish-mode': mode,
          },
          h(
            'div',
            { className: 'cr-modal-head' },
            h(
              'span',
              { className: 'cr-modal-title', id: 'cr-publish-title' },
              tx(t, 'publishDialogTitle'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'cr-modal-close',
                'aria-label': tx(t, 'cancel'),
                title: tx(t, 'cancel'),
                disabled,
                onClick: cancel,
              },
              Icon('close', 13, { strokeWidth: 2 }),
            ),
          ),
          h(
            'div',
            { className: 'cr-merge-rows' },
            h(
              'div',
              { className: 'cr-merge-row' },
              h('span', { className: 'cr-merge-row-key' }, tx(t, 'publishRepo')),
              h(
                'span',
                { className: 'cr-merge-row-val cr-merge-row-val--mono', 'data-publish-repo': 'ready' },
                repoName + (number === '' ? '' : ' #' + number),
              ),
            ),
            h(
              'div',
              { className: 'cr-merge-row' },
              h('span', { className: 'cr-merge-row-key' }, tx(t, 'publishHeadSha')),
              h(
                'span',
                { className: 'cr-merge-row-val cr-merge-row-val--mono', title: headSha },
                shortSha(headSha) || '—',
              ),
            ),
            h(
              'div',
              { className: 'cr-merge-row' },
              h('span', { className: 'cr-merge-row-key' }, tx(t, 'publishExpected')),
              h(
                'span',
                {
                  className: 'cr-merge-row-val cr-publish-expected',
                  'data-publish-expected': String(expected),
                },
                tx(t, 'publishExpectedValue', { n: expected }),
              ),
            ),
          ),
          h(
            'fieldset',
            { className: 'cr-field' },
            h('legend', null, tx(t, 'publishMode')),
            PUBLISH_MODES.map((value) =>
              h(
                'label',
                { key: value, className: 'cr-option' },
                h('input', {
                  type: 'radio',
                  name: 'cr-publish-mode',
                  value,
                  'data-publish-mode-value': value,
                  checked: mode === value,
                  disabled,
                  onChange: () => {
                    if (typeof props.onModeChange === 'function') props.onModeChange(value)
                  },
                }),
                h(
                  'span',
                  { className: 'cr-option-text' },
                  h('span', { className: 'cr-option-label' }, tx(t, publishModeLabelKey(value))),
                  h('span', { className: 'cr-option-hint' }, tx(t, publishModeHintKey(value))),
                ),
              ),
            ),
          ),
          h(
            'fieldset',
            { className: 'cr-field' },
            h('legend', null, tx(t, 'publishMinSeverity')),
            PUBLISH_MIN_SEVERITIES.map((value) =>
              h(
                'label',
                { key: value, className: 'cr-option' },
                h('input', {
                  type: 'radio',
                  name: 'cr-publish-min-severity',
                  value,
                  'data-publish-min-value': value,
                  checked: minSeverity === value,
                  disabled,
                  onChange: () => {
                    if (typeof props.onMinSeverityChange === 'function') {
                      props.onMinSeverityChange(value)
                    }
                  },
                }),
                h(
                  'span',
                  { className: 'cr-option-text' },
                  h('span', { className: 'cr-option-label' }, tx(t, thresholdKey(value))),
                ),
              ),
            ),
            h('p', { className: 'cr-modal-note' }, tx(t, 'publishMinSeverityHint')),
          ),
          h('div', { className: 'cr-merge-risk', role: 'note' }, Icon('alert', 12), ' ', tx(t, 'publishWarning')),
          error
            ? h(
                'div',
                {
                  className: 'cr-publish-error',
                  'data-publish-error': error.code || 'INTERNAL',
                  role: 'alert',
                },
                h('b', null, String(error.code || 'INTERNAL')),
                h('span', null, errorKey ? tx(t, errorKey) : String(error.message || '')),
              )
            : null,
          h(
            'div',
            { className: 'cr-modal-actions' },
            h(
              'button',
              {
                type: 'button',
                className: 'cr-btn cr-btn--ghost',
                'data-action': 'publish-cancel',
                disabled,
                onClick: cancel,
              },
              tx(t, 'cancel'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'cr-btn cr-btn--primary',
                'data-action': 'publish-confirm',
                disabled,
                'aria-busy': disabled ? 'true' : 'false',
                onClick: () => {
                  if (!disabled && typeof props.onConfirm === 'function') props.onConfirm()
                },
              },
              disabled ? h('span', { className: 'cr-spinner' }) : Icon('comment', 13),
              tx(t, disabled ? 'publishSubmitting' : 'publishConfirm'),
            ),
          ),
        ),
      )
    }

    /**
     * Right-column auto review card (CONTRACT §6.4): collapsible state, recent
     * results, "check now", and the degraded block for an older Host.
     */
    function AutoReviewCard(props) {
      const t = props.t
      const state = props.state && typeof props.state === 'object' ? props.state : {}
      const supported = state.supported !== false
      const status = state.status ? normalizeAutoReviewStatus(state.status) : null
      const config = status ? status.config : normalizeAutoReviewConfig(null)
      const open = props.open !== false
      const runBusy = Boolean(props.runBusy)
      const running = Boolean(status && status.running)
      const recent = status ? status.recent : []
      const shown = recent.slice(0, 6)
      const toggleLabel = open ? tx(t, 'autoReviewCollapse') : tx(t, 'autoReviewExpand')
      const stateLabel = running
        ? tx(t, 'autoReviewRunning')
        : config.enabled
          ? tx(t, 'autoReviewStatusOn')
          : tx(t, 'autoReviewStatusOff')
      const stateClass = running ? 'running' : config.enabled ? 'on' : 'off'
      const relativeLabel = (value) => {
        const relative = relativeTime(value, props.now)
        return relative ? formatRelative(relative, t) : ''
      }
      const lastText =
        status && status.lastCycleAt > 0
          ? relativeLabel(status.lastCycleAt)
          : tx(t, 'autoReviewNever')
      return h(
        'section',
        {
          className: 'cr-sec',
          'data-cr-autoreview': 'ready',
          'data-auto-supported': supported ? 'true' : 'false',
          'data-auto-enabled': config.enabled ? 'true' : 'false',
          'data-auto-running': running ? 'true' : 'false',
          'data-auto-recent': String(recent.length),
        },
        h(
          'div',
          { className: 'cr-autoreview-head' },
          h(
            'button',
            {
              type: 'button',
              className: 'cr-autoreview-toggle',
              'aria-expanded': open ? 'true' : 'false',
              'data-action': 'auto-review-toggle',
              title: toggleLabel,
              onClick: () => {
                if (typeof props.onToggle === 'function') props.onToggle()
              },
            },
            h(
              'span',
              { className: 'cr-chev', style: { transform: open ? 'rotate(90deg)' : 'none' } },
              Icon('chevronRight', 13, { strokeWidth: 2 }),
            ),
            h('span', null, tx(t, 'autoReview')),
            h(
              'span',
              { className: 'cr-autoreview-state cr-autoreview-state--' + stateClass },
              running
                ? h('span', { className: 'cr-spinner', style: { width: 9, height: 9 } })
                : null,
              stateLabel,
            ),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'cr-chat-head-btn',
              'data-action': 'auto-review-refresh',
              'aria-label': tx(t, 'autoReviewRefresh'),
              title: tx(t, 'autoReviewRefresh'),
              disabled: !supported,
              onClick: () => {
                if (typeof props.onRefresh === 'function') props.onRefresh()
              },
            },
            Icon('refresh', 13),
          ),
        ),
        open
          ? h(
              'div',
              { className: 'cr-autoreview-body' },
              !supported
                ? h(
                    'div',
                    { className: 'cr-autoreview-degraded' },
                    h('b', null, tx(t, 'autoReviewUnsupported')),
                    h('span', null, tx(t, 'autoReviewUnsupportedHint')),
                  )
                : !status
                  ? h(
                      'div',
                      { className: 'cr-autoreview-empty' },
                      state.error
                        ? tx(t, 'autoReviewLastError', {
                            message:
                              String(
                                (state.error && (state.error.message || state.error.code)) || '',
                              ) || String(state.error),
                          })
                        : tx(t, 'loading'),
                    )
                  : config.enabled
                    ? h(
                        React.Fragment,
                        null,
                        h(
                          'div',
                          { className: 'cr-autoreview-meta' },
                          h(
                            'span',
                            null,
                            tx(t, 'autoReviewLastCycle', { time: lastText }),
                          ),
                          running || status.nextCycleAt > 0
                            ? h(
                                'span',
                                null,
                                running
                                  ? tx(t, 'autoReviewRunning')
                                  : tx(t, 'autoReviewNextCycle', {
                                      time: relativeLabel(status.nextCycleAt),
                                    }),
                              )
                            : null,
                          h('span', null, tx(t, 'autoReviewSeen', { n: status.seenCount })),
                          status.publish
                            ? h(
                                'span',
                                {
                                  className: 'cr-auto-publish-status',
                                  'data-auto-publish-status': status.publish.enabled
                                    ? 'on'
                                    : 'off',
                                },
                                tx(t, autoPublishStatusKey(status.publish.enabled)),
                              )
                            : null,
                        ),
                        status.lastError
                          ? h(
                              'div',
                              { className: 'cr-autoreview-error', 'data-auto-last-error': 'true' },
                              tx(t, 'autoReviewLastError', {
                                message: status.lastError.message || status.lastError.code,
                              }),
                            )
                          : null,
                        h(
                          'div',
                          { className: 'cr-autoreview-run' },
                          h(
                            'button',
                            {
                              type: 'button',
                              className: 'cr-btn',
                              'data-action': 'auto-review-run',
                              disabled: running || runBusy,
                              'aria-busy': running ? 'true' : 'false',
                              onClick: () => {
                                if (typeof props.onRun === 'function') props.onRun()
                              },
                            },
                            running || runBusy
                              ? h('span', { className: 'cr-spinner' })
                              : Icon('refresh', 12),
                            running ? tx(t, 'autoReviewRunning') : tx(t, 'autoReviewRunNow'),
                          ),
                        ),
                        h(
                          'div',
                          { className: 'cr-autoreview-recent-title' },
                          tx(t, 'autoReviewRecent'),
                        ),
                        recent.length === 0
                          ? h(
                              'div',
                              { className: 'cr-autoreview-empty', style: { marginTop: 4 } },
                              tx(t, 'autoReviewNoRecent'),
                            )
                          : h(
                              'div',
                              { className: 'cr-autoreview-recent' },
                              shown.map((entry, index) => {
                                const badge = autoReviewBadge(entry)
                                const meta =
                                  entry.state === 'error'
                                    ? tx(t, 'autoReviewRecentError') +
                                      (entry.error && entry.error.message
                                        ? ' · ' + entry.error.message
                                        : '')
                                    : entry.findings > 0
                                      ? tx(t, 'findingsCount', { n: entry.findings })
                                      : tx(t, 'autoReviewRecentClean')
                                return h(
                                  'div',
                                  {
                                    key: autoReviewRecentKey(entry) + ':' + index,
                                    className: 'cr-autoreview-item-row',
                                  },
                                  h(
                                    'button',
                                    {
                                      type: 'button',
                                      className: 'cr-autoreview-item',
                                      'data-action': 'auto-review-jump',
                                      'data-auto-pr':
                                        String(entry.repo || '') + '#' + String(entry.number),
                                      title: entry.error
                                        ? entry.error.message
                                        : entry.overview || '',
                                      onClick: () => {
                                        if (typeof props.onJump === 'function') props.onJump(entry)
                                      },
                                    },
                                    h(
                                      'span',
                                      { className: 'cr-autoreview-item-main' },
                                      h(
                                        'span',
                                        { className: 'cr-autoreview-item-pr' },
                                        String(entry.repo || '').split('/').pop() +
                                          ' #' +
                                          String(entry.number),
                                      ),
                                      h(
                                        'span',
                                        { className: 'cr-autoreview-item-meta' },
                                        meta +
                                          (entry.finishedAt > 0
                                            ? ' · ' + relativeLabel(entry.finishedAt)
                                            : ''),
                                      ),
                                    ),
                                    badge
                                      ? h(
                                          'span',
                                          {
                                            className:
                                              'cr-autoreview-item-state cr-autoreview-item-state--' +
                                              badge.kind,
                                          },
                                          badge.text,
                                        )
                                      : null,
                                  ),
                                  entry.published && entry.published.url
                                    ? h(
                                        'a',
                                        {
                                          className: 'cr-autoreview-published',
                                          'data-auto-published': 'link',
                                          href: entry.published.url,
                                          target: '_blank',
                                          rel: 'noopener noreferrer',
                                          title: tx(t, 'publishPublishedBadge'),
                                        },
                                        tx(t, 'publishView'),
                                      )
                                    : null,
                                )
                              }),
                            ),
                        recent.length > shown.length
                          ? h(
                              'div',
                              { className: 'cr-autoreview-empty', style: { marginTop: 4 } },
                              tx(t, 'autoReviewMore', { n: recent.length - shown.length }),
                            )
                          : null,
                      )
                    : h(
                        'div',
                        {
                          className: 'cr-autoreview-empty',
                          style: { display: 'flex', flexDirection: 'column', gap: 6 },
                        },
                        h(
                          'span',
                          { style: { fontWeight: 600, color: 'var(--cr-text-2)' } },
                          tx(t, 'autoReviewDisabledState'),
                        ),
                        h('span', null, tx(t, 'autoReviewDisabledBody')),
                        h(
                          'div',
                          { className: 'cr-autoreview-run' },
                          h(
                            'button',
                            {
                              type: 'button',
                              className: 'cr-btn cr-btn--ghost',
                              'data-action': 'auto-review-open-settings',
                              onClick: () => {
                                if (typeof props.onOpenSettings === 'function') {
                                  props.onOpenSettings()
                                }
                              },
                            },
                            tx(t, 'autoReviewEnableAction'),
                          ),
                        ),
                      ),
            )
          : null,
      )
    }

    /** Right rail while the PR detail is in flight: real Changes counts, skeletons below. */
    function RightRailPending(props) {
      const t = props.t
      const summary = props.summary || {}
      const files = Number.isFinite(Number(summary.changedFiles)) ? Number(summary.changedFiles) : null
      const additions = Number(summary.additions) || 0
      const deletions = Number(summary.deletions) || 0
      return h(
        'aside',
        {
          className: 'cr-details',
          'data-cr-details-pending': 'ready',
          'aria-busy': 'true',
          'aria-label': 'PR details',
        },
        h(
          Section,
          { title: tx(t, 'changes') },
          files === null
            ? h(Skeleton, { rows: 1, height: 20 })
            : h(
                'div',
                { className: 'cr-changes-row', 'data-cr-pending-files': String(files) },
                h('span', { className: 'cr-changes-count' }, tx(t, 'fileCount', { n: String(files) })),
                h('span', { className: 'cr-stat cr-stat--add' }, '+' + additions),
                h('span', { className: 'cr-stat cr-stat--del' }, '−' + deletions),
              ),
        ),
        h('div', { style: { height: 14 } }),
        h(Skeleton, { rows: 2, height: 30 }),
        h('div', { style: { height: 14 } }),
        h(Skeleton, { rows: 2, height: 52 }),
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
          findingsByFile: props.findingsByFile,
          onJump: () => props.onTabChange('changes'),
          onJumpFile: props.onJumpFile,
        }),
        h(StackCard, { stack: detail.stack, t }),
        h(CommentsCard, {
          comments: detail.comments,
          t,
          onResolve: props.onResolve,
          onLocate: props.onLocate,
        }),
        h(ReviewersCard, {
          comments: detail.comments,
          reviewDecision: (detail.summary || {}).reviewDecision,
          t,
        }),
        h(ChecksCard, { checks: detail.checks, t }),
        h(AutoReviewCard, {
          t,
          state: props.autoReview,
          open: props.autoReviewOpen,
          runBusy: props.autoReviewRunBusy,
          now: props.now,
          onToggle: props.onAutoReviewToggle,
          onRefresh: props.onAutoReviewRefresh,
          onRun: props.onAutoReviewRun,
          onJump: props.onAutoReviewJump,
          onOpenSettings: props.onOpenSettings,
        }),
      )
    }

    // ---------------------------------------------------------------------
    // v2: floating PR chat panel + interactive composer (CONTRACT §5.2)
    // ---------------------------------------------------------------------

    /** Floating chat panel: message bubbles, streaming caret, stop/clear/retry. */
    function ChatPanel(props) {
      const t = props.t
      const chat = props.chat && typeof props.chat === 'object' ? props.chat : {}
      const messages = Array.isArray(chat.messages) ? chat.messages : []
      const streaming = Boolean(chat.streaming)
      const error = chat.error && typeof chat.error === 'object' ? chat.error : null
      const bodyRef = useRef(null)
      useEffect(() => {
        try {
          const node = bodyRef.current
          if (node) node.scrollTop = node.scrollHeight
        } catch {
          /* auto-scroll is best effort */
        }
      }, [messages, streaming, error])
      const onKeyDown = (event) => {
        try {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            if (typeof props.onClose === 'function') props.onClose()
          }
        } catch {
          /* never break the panel */
        }
      }
      const quick = typeof props.onQuickPrompt === 'function' ? props.onQuickPrompt : null
      return h(
        'section',
        {
          className: 'cr-chat',
          role: 'dialog',
          'aria-label': tx(t, 'chatTitle'),
          'data-cr-chat': 'ready',
          'data-chat-streaming': streaming ? 'true' : 'false',
          onKeyDown,
        },
        h(
          'div',
          { className: 'cr-chat-head' },
          h(
            'span',
            { className: 'cr-chat-title' },
            Icon('brain', 14),
            h('span', null, tx(t, 'chatTitle')),
          ),
          h(
            'span',
            { className: 'cr-chat-status', role: 'status' },
            streaming ? tx(t, 'chatStreaming') : '',
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'cr-chat-head-btn',
              'data-action': 'chat-clear',
              'aria-label': tx(t, 'chatClear'),
              title: tx(t, 'chatClear'),
              disabled: messages.length === 0 && !streaming && !error,
              onClick: () => {
                if (typeof props.onClear === 'function') props.onClear()
              },
            },
            Icon('refresh', 14),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'cr-chat-head-btn',
              'data-action': 'chat-close',
              'aria-label': tx(t, 'chatClose'),
              title: tx(t, 'chatClose'),
              onClick: () => {
                if (typeof props.onClose === 'function') props.onClose()
              },
            },
            Icon('close', 13, { strokeWidth: 2 }),
          ),
        ),
        h(
          'div',
          { className: 'cr-chat-body', ref: bodyRef, 'aria-live': 'polite', 'data-chat-body': 'ready' },
          messages.length === 0 && !error
            ? h(
                'div',
                { className: 'cr-chat-empty' },
                h('div', { className: 'cr-chat-empty-title' }, tx(t, 'chatEmpty')),
                h('div', { className: 'cr-chat-empty-text' }, tx(t, 'chatEmptyHint')),
                h(
                  'div',
                  { className: 'cr-chat-quick' },
                  CHAT_QUICK_PROMPTS.map((key, index) =>
                    h(
                      'button',
                      {
                        key,
                        type: 'button',
                        className: 'cr-chat-quick-btn',
                        'data-action': 'chat-quick',
                        'data-quick-index': String(index),
                        disabled: !quick,
                        onClick: () => {
                          if (quick) quick(tx(t, key))
                        },
                      },
                      Icon(index === 0 ? 'file' : index === 1 ? 'alert' : 'check', 12),
                      h('span', null, tx(t, key)),
                    ),
                  ),
                ),
              )
            : null,
          messages.map((message, index) => {
            if (!message || (message.role !== 'user' && message.role !== 'assistant')) return null
            const isUser = message.role === 'user'
            const content = typeof message.content === 'string' ? message.content : ''
            const isLast = index === messages.length - 1
            const showCaret = streaming && isLast && !isUser
            return h(
              'div',
              {
                key: index,
                className: 'cr-chat-msg cr-chat-msg--' + message.role,
                'data-chat-role': message.role,
              },
              h('span', { className: 'cr-chat-who' }, tx(t, isUser ? 'chatYou' : 'chatAssistant')),
              h(
                'div',
                { className: 'cr-chat-bubble' },
                content !== '' ? content : tx(t, 'chatThinking'),
                showCaret ? h('span', { className: 'cr-chat-caret', 'data-chat-caret': 'true' }) : null,
                !streaming && message.stopped ? h('span', { className: 'cr-chip-tag' }, tx(t, 'chatStopped')) : null,
              ),
            )
          }),
          error
            ? h(
                'div',
                { className: 'cr-chat-error', role: 'alert', 'data-chat-error': error.code || 'INTERNAL' },
                h(
                  'div',
                  { className: 'cr-chat-error-head' },
                  Icon('alert', 12),
                  tx(t, 'chatErrorTitle'),
                ),
                h('div', null, String(error.message || '') + (error.code ? ' (' + error.code + ')' : '')),
                h(
                  'div',
                  { className: 'cr-chat-error-actions' },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'cr-btn cr-btn--ghost',
                      'data-action': 'chat-retry',
                      disabled: streaming,
                      onClick: () => {
                        if (typeof props.onRetry === 'function') props.onRetry()
                      },
                    },
                    tx(t, 'chatRetry'),
                  ),
                ),
              )
            : null,
        ),
        h(
          'div',
          { className: 'cr-chat-foot' },
          streaming
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'cr-chat-stop',
                  'data-action': 'chat-stop',
                  'aria-label': tx(t, 'chatStop'),
                  onClick: () => {
                    if (typeof props.onStop === 'function') props.onStop()
                  },
                },
                Icon('square', 10),
                tx(t, 'chatStop'),
              )
            : null,
          h('span', { className: 'cr-chat-foot-spacer' }),
          h('span', null, tx(t, 'chatHistoryHint')),
        ),
      )
    }

    /** Floating input row: real textarea + send/stop/open-chat controls. */
    function Composer(props) {
      const t = props.t
      const value = typeof props.value === 'string' ? props.value : ''
      const streaming = Boolean(props.streaming)
      const canChat = Boolean(props.canChat)
      const canSend = value.trim() !== '' && !streaming && canChat
      const onKeyDown = (event) => {
        try {
          if (event.key !== 'Enter' || event.shiftKey) return
          if (event.isComposing || event.keyCode === 229) return
          event.preventDefault()
          if (canSend && typeof props.onSend === 'function') props.onSend(value)
        } catch {
          /* never break typing */
        }
      }
      return h(
        'div',
        { className: 'cr-composer', 'data-cr-composer': 'ready', 'data-composer-streaming': streaming ? 'true' : 'false' },
        h('span', { className: 'cr-composer-plus', 'aria-hidden': 'true' }, Icon('plus', 15)),
        h('textarea', {
          className: 'cr-composer-input',
          rows: 1,
          value,
          ref: props.inputRef,
          placeholder: tx(t, 'askPlaceholder'),
          'aria-label': tx(t, 'chatInputLabel'),
          'data-chat-input': 'ready',
          disabled: !canChat,
          onChange: (event) => {
            if (typeof props.onChange === 'function') props.onChange(String(event.target.value || ''))
          },
          onKeyDown,
          onFocus: () => {
            if (typeof props.onOpen === 'function') props.onOpen()
          },
        }),
        h(
          'span',
          { className: 'cr-composer-icons' },
          h(
            'button',
            {
              type: 'button',
              className: 'cr-composer-iconbtn',
              'data-action': 'chat-open',
              'aria-label': tx(t, 'chatOpen'),
              title: tx(t, 'chatOpen'),
              disabled: !canChat,
              onClick: () => {
                if (typeof props.onOpen === 'function') props.onOpen()
              },
            },
            Icon('brain', 15),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'cr-composer-iconbtn',
              'data-action': 'chat-quick-risks',
              'aria-label': tx(t, 'chatRisks'),
              title: tx(t, 'chatRisks'),
              disabled: !canChat || streaming,
              onClick: () => {
                if (typeof props.onQuickPrompt === 'function') props.onQuickPrompt(tx(t, 'chatRisks'))
              },
            },
            Icon('alert', 15),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'cr-composer-send',
              'data-action': 'chat-send',
              'aria-label': tx(t, 'chatSend'),
              title: tx(t, 'chatSend'),
              disabled: !canSend,
              onClick: () => {
                if (canSend && typeof props.onSend === 'function') props.onSend(value)
              },
            },
            streaming ? h('span', { className: 'cr-spinner' }) : Icon('arrowUp', 13),
          ),
        ),
      )
    }

    // ---------------------------------------------------------------------
    // Page state machine
    // ---------------------------------------------------------------------

    function sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms))
    }

    /** Toast that auto-dismisses; returns [toast, show, dismiss]. `toast` may be {text, action}. */
    function useToast() {
      const [message, setMessage] = useState(null)
      const timerRef = useRef(null)
      const dismiss = useCallback(() => {
        if (timerRef.current !== null) {
          clearTimeout(timerRef.current)
          timerRef.current = null
        }
        setMessage(null)
      }, [])
      const show = useCallback((next, durationMs) => {
        setMessage(next)
        if (timerRef.current !== null) clearTimeout(timerRef.current)
        const duration = Number(durationMs)
        timerRef.current = setTimeout(
          () => setMessage(null),
          Number.isFinite(duration) && duration > 0 ? duration : 2000,
        )
      }, [])
      useEffect(
        () => () => {
          if (timerRef.current !== null) clearTimeout(timerRef.current)
        },
        [],
      )
      return [message, show, dismiss]
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
      const [review, setReview] = useState(() => normalizeReviewStatus({ state: 'none' }))
      const [pinned, setPinned] = useState(false)
      const [settings, setSettings] = useState(() => readSettings(localStore()))
      const [settingsOpen, setSettingsOpen] = useState(false)
      /** When the current head's review finished (ms); shown in the summary header. */
      const [reviewFinishedAt, setReviewFinishedAt] = useState(0)
      // v0.9: settings also live in the DSH Settings panel; keep this page is copy in sync
      useEffect(() => {
        const reload = (event) => {
          setSettings(readSettings(localStore()))
          if (event?.detail?.refresh === true) refreshAutoReview()
        }
        try {
          window.addEventListener('codex-review:settings-changed', reload)
          window.addEventListener('storage', reload)
          return () => {
            window.removeEventListener('codex-review:settings-changed', reload)
            window.removeEventListener('storage', reload)
          }
        } catch {
          return undefined
        }
      }, [])
      const [jumpTarget, setJumpTarget] = useState(null)
      const [toast, showToast, dismissToast] = useToast()
      const [clock] = useState(() => Date.now())
      // v2: merge dialog + PR chat state (CONTRACT §5)
      const [mergeDialog, setMergeDialog] = useState({
        open: false,
        method: DEFAULT_MERGE_METHOD,
        deleteBranch: false,
        phase: 'idle',
        error: null,
      })
      const [mergedPrs, setMergedPrs] = useState({})
      const [composerText, setComposerText] = useState('')
      const [chat, setChat] = useState({ open: false, messages: [], streaming: false, error: null })
      // v2.1: auto review status (CONTRACT §6.4)
      const [autoReview, setAutoReview] = useState({ supported: true, loading: true, status: null })
      const [autoReviewOpen, setAutoReviewOpen] = useState(true)
      const [autoReviewRunBusy, setAutoReviewRunBusy] = useState(false)
      const [pageVisible, setPageVisible] = useState(() => {
        try {
          return typeof document === 'undefined' ? true : document.visibilityState !== 'hidden'
        } catch {
          return true
        }
      })
      const [autoReviewPollMs] = useState(() => {
        try {
          const override = typeof window !== 'undefined' ? Number(window.__CR_AUTO_POLL_MS__) : 0
          return Number.isFinite(override) && override > 0 ? override : AUTO_REVIEW_POLL_MS
        } catch {
          return AUTO_REVIEW_POLL_MS
        }
      })
      // v2.2: publish review to GitHub (CONTRACT §7.3)
      const [publishDialog, setPublishDialog] = useState({
        open: false,
        mode: 'inline',
        minSeverity: 'P2',
        phase: 'idle',
        error: null,
      })
      const [publishRecords, setPublishRecords] = useState({})
      const [publishUnsupported, setPublishUnsupported] = useState(false)

      const docRef = useRef(null)
      const listGeneration = useRef(0)
      const detailGeneration = useRef(0)
      const reviewGeneration = useRef(0)
      /** repo#number -> { value, at } for instant PR switches. */
      const detailCache = useRef(new Map())
      /** repo#number -> in-flight /pr promise so a hover prefetch and a click share one request. */
      const detailInflight = useRef(new Map())
      /** Per-PR epochs prevent invalidated requests from restoring stale snapshots. */
      const detailVersions = useRef(new Map())
      const selectedRef = useRef(null)
      selectedRef.current = selected
      const gearRef = useRef(null)
      const searchRef = useRef(null)
      const listRef = useRef(null)
      /** Per-tab scroll offsets so Summary/Changes switching keeps each position. */
      const scrollPositions = useRef({ summary: 0, changes: 0 })
      const composerRef = useRef(null)
      const chatAbortRef = useRef(null)
      const chatGeneration = useRef(0)
      const chatRef = useRef(null)
      chatRef.current = chat
      const mergeDialogRef = useRef(null)
      mergeDialogRef.current = mergeDialog
      const autoReviewRef = useRef(null)
      autoReviewRef.current = autoReview
      const autoReviewBaselineRef = useRef(false)
      const jumpAutoRef = useRef(null)
      const reviewRef = useRef(null)
      reviewRef.current = review
      const publishDialogRef = useRef(null)
      publishDialogRef.current = publishDialog

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

      const invalidateDetail = useCallback((summary) => {
        const key = String(summary.repo) + '#' + String(summary.number)
        detailVersions.current.set(key, (detailVersions.current.get(key) || 0) + 1)
        detailCache.current.delete(key)
        detailInflight.current.delete(key)
      }, [])

      /** Fetch one PR detail, sharing only requests from the current cache epoch. */
      const fetchDetail = useCallback((summary) => {
        const key = String(summary.repo) + '#' + String(summary.number)
        const pending = detailInflight.current.get(key)
        if (pending) return pending
        const version = detailVersions.current.get(key) || 0
        const release = () => {
          if (detailInflight.current.get(key) === request) detailInflight.current.delete(key)
        }
        const request = post(ROUTE + '/pr', { repo: summary.repo, number: summary.number })
          .then((result) => {
            release()
            // An obsolete response cannot update either the cache or its caller.
            // Join a newer request, or fetch the current snapshot instead.
            if (version !== (detailVersions.current.get(key) || 0)) return fetchDetail(summary)
            if (!result.ok) return result
            const value = normalizePrDetail(result.value)
            detailCache.current.set(key, { value, at: Date.now() })
            return { ok: true, value }
          })
          .catch((error) => {
            release()
            return { ok: false, error: { code: 'INTERNAL', message: String((error && error.message) || error) } }
          })
        detailInflight.current.set(key, request)
        return request
      }, [])

      /**
       * Warm a PR's detail when the pointer or focus rests on its row: by the time
       * the click lands the payload is cached or already in flight, so the right
       * rail and the document render without a cold network wait.
       */
      const prefetchDetail = useCallback((summary) => {
        if (!summary || summary.repo === undefined || summary.number === undefined) return
        const key = String(summary.repo) + '#' + String(summary.number)
        const cached = detailCache.current.get(key)
        if (cached && Date.now() - cached.at < DETAIL_CACHE_TTL_MS) return
        if (detailInflight.current.has(key)) return
        void fetchDetail(summary)
      }, [fetchDetail])

      const loadDetail = useCallback((summary) => {
        if (!summary || summary.repo === undefined || summary.number === undefined) return
        const generation = ++detailGeneration.current
        reviewGeneration.current += 1
        setReview(normalizeReviewStatus({ state: 'none' }))
        const seedGeneration = reviewGeneration.current
        let restoredGeneration = seedGeneration
        const key = String(summary.repo) + '#' + String(summary.number)
        const cached = detailCache.current.get(key)
        if (cached) {
          // A cached PR renders instantly; an expired entry refreshes in the background.
          setDetail({ state: 'ready', value: cached.value, error: null })
          const seed = cached.value.review
          if (seed && (seed.state === 'done' || seed.state === 'error')) {
            setReview(seed)
          } else if (seed && seed.state === 'running' && seed.jobId) {
            const nextGeneration = ++reviewGeneration.current
            restoredGeneration = nextGeneration
            setReview(Object.assign({}, seed, { progress: seed.progress || {} }))
            void pollReview(nextGeneration, seed.jobId, summary)
          }
          // Revalidate review state even while the cached PR body is fresh.
          // Automatic reviews and other tabs can finish without updating this cache.
        } else {
          setDetail({ state: 'loading', value: null, error: null })
        }
        fetchDetail(summary).then((result) => {
          if (generation !== detailGeneration.current) return
          if (!result.ok) {
            if (!cached) setDetail({ state: 'error', value: null, error: result.error })
            return
          }
          setDetail({ state: 'ready', value: result.value, error: null })
          if (seedGeneration !== reviewGeneration.current) {
            // A cached running job may belong to the previous head. Stop only
            // that restored poll; never override a review started meanwhile.
            if (restoredGeneration === seedGeneration || restoredGeneration !== reviewGeneration.current ||
                !cached?.value.headSha || !result.value.headSha || cached.value.headSha === result.value.headSha) return
            reviewGeneration.current += 1
          }
          const seed = result.value.review
          if (seed && seed.state === 'running' && seed.jobId) {
            const nextGeneration = ++reviewGeneration.current
            setReview(Object.assign({}, seed, { progress: seed.progress || {} }))
            void pollReview(nextGeneration, seed.jobId, summary)
          } else {
            setReview(seed || normalizeReviewStatus({ state: 'none' }))
          }
        })
      }, [fetchDetail])

      /**
       * Re-fetch one PR's detail without resetting the review card. Used after a
       * comment write so new comments/replies show up immediately.
       */
      const refreshDetail = useCallback((summary) => {
        if (!summary || summary.repo === undefined || summary.number === undefined) return
        invalidateDetail(summary)
        const current = selectedRef.current
        if (!current || current.repo !== summary.repo || Number(current.number) !== Number(summary.number)) return
        const generation = ++detailGeneration.current
        fetchDetail(summary).then((result) => {
          if (generation !== detailGeneration.current || !result.ok) return
          setDetail({ state: 'ready', value: result.value, error: null })
        })
      }, [fetchDetail, invalidateDetail])

      // Remember when the current head's review finished so the summary header can
      // show a relative timestamp (the review status payload has no finishedAt).
      useEffect(() => {
        if (!review || review.state !== 'done' || !review.headSha) return
        const current = selectedRef.current
        if (!current) return
        const key = 'codex-review:review-time:' + current.repo + '#' + current.number + '@' + review.headSha
        let at = 0
        try {
          at = Number(localStorage.getItem(key)) || 0
        } catch {
          at = 0
        }
        if (!at) {
          at = Date.now()
          try {
            localStorage.setItem(key, String(at))
          } catch {
            /* storage is optional */
          }
        }
        setReviewFinishedAt(at)
      }, [review, selected])

      const selectPr = useCallback(
        (summary) => {
          if (!summary) return
          selectedRef.current = summary
          setSelected(summary)
          setTab('summary')
          setExpanded({})
          setHighlight(null)
          setJumpTarget(null)
          scrollPositions.current = { summary: 0, changes: 0 }
          const doc = docRef.current
          if (doc) doc.scrollTop = 0
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
      const pollReview = useCallback(async (generation, jobId, summary) => {
        invalidateDetail(summary)
        while (generation === reviewGeneration.current) {
          await sleep(POLL_MS)
          if (generation !== reviewGeneration.current) return
          const result = await post(ROUTE + '/review-status', { jobId })
          if (generation !== reviewGeneration.current) return
          if (!result.ok) {
            invalidateDetail(summary)
            setReview({ state: 'error', error: result.error, jobId })
            return
          }
          const status = result.value || {}
          invalidateDetail(summary)
          if (status.state === 'done') {
            setReview(normalizeReviewStatus(Object.assign({}, status, { jobId })))
            return
          }
          if (status.state === 'error') {
            setReview(
              normalizeReviewStatus(
                Object.assign({}, status, {
                  state: 'error',
                  jobId,
                  error: status.error || { code: 'INTERNAL', message: '审查失败' },
                }),
              ),
            )
            return
          }
          if (status.state === 'cancelled') {
            setReview((previous) => normalizeReviewStatus({ state: 'none', options: previous.options }))
            return
          }
          setReview((previous) =>
            normalizeReviewStatus(
              Object.assign({}, previous, status, {
                state: 'running',
                jobId,
                progress: status.progress || previous.progress || {},
                options: status.options || previous.options,
              }),
            ),
          )
        }
      }, [invalidateDetail])

      const startReview = useCallback(() => {
        const current = selectedRef.current
        if (!current) return
        invalidateDetail(current)
        const generation = ++reviewGeneration.current
        const options = settingsToOptions(readSettings(localStore()))
        setReview(
          normalizeReviewStatus({
            state: 'preparing',
            options: normalizeReviewOptions(options),
            progress: {},
          }),
        )
        post(ROUTE + '/review-start', { repo: current.repo, number: current.number }).then(
          (result) => {
            if (generation !== reviewGeneration.current) return
            if (!result.ok) {
              setReview(
                normalizeReviewStatus({
                  state: 'error',
                  error: result.error,
                  options: normalizeReviewOptions(options),
                }),
              )
              return
            }
            const value = result.value || {}
            const jobId = value.jobId
            const cached = Boolean(value.cached)
            setReview(
              normalizeReviewStatus({
                state: 'running',
                jobId,
                cached,
                headSha: value.headSha,
                options: normalizeReviewOptions(value.options || options),
                progress: {
                  phase: 'preparing',
                  filesDone: 0,
                  filesTotal: 0,
                  startedAt: Date.now(),
                },
              }),
            )
            if (cached) showToast(tx(t, 'reviewCached'))
            void pollReview(generation, jobId, current)
          },
        )
      }, [pollReview, invalidateDetail, showToast, t])

      const cancelReview = useCallback(() => {
        const selectedPr = selectedRef.current
        if (selectedPr) invalidateDetail(selectedPr)
        const current = review
        reviewGeneration.current += 1
        setReview((previous) => normalizeReviewStatus({ state: 'none', options: previous.options }))
        if (current && current.jobId) {
          void post(ROUTE + '/review-cancel', { jobId: current.jobId })
        }
      }, [review, invalidateDetail])

      const locateFinding = useCallback((finding) => {
        if (!finding || typeof finding.file !== 'string') return
        const line = Number(finding.line)
        scrollPositions.current.changes = 0
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

      /** Switch tabs while remembering each tab's scroll offset (CONTRACT §4.5.5). */
      const changeTab = useCallback((next) => {
        const doc = docRef.current
        setTab((previous) => {
          if (previous === next) return previous
          if (doc) scrollPositions.current[previous] = doc.scrollTop
          return next
        })
      }, [])

      useEffect(() => {
        const doc = docRef.current
        if (!doc) return
        const top = scrollPositions.current[tab]
        doc.scrollTop = Number.isFinite(top) ? top : 0
      }, [tab])

      // Right-column file list: switch to Changes, expand the file, scroll to it.
      const jumpToFile = useCallback((key, index) => {
        if (typeof key !== 'string' || key === '') return
        scrollPositions.current.changes = 0
        setExpanded((previous) => Object.assign({}, previous, { [key]: true }))
        setTab('changes')
        setJumpTarget({
          key,
          index: Number.isFinite(Number(index)) ? Number(index) : -1,
          nonce: Date.now(),
        })
      }, [])

      useEffect(() => {
        if (!jumpTarget) return undefined
        const timer = setTimeout(() => {
          const doc = docRef.current
          if (!doc || typeof doc.querySelectorAll !== 'function') return
          let node = null
          const sections = doc.querySelectorAll('[data-file-path]')
          for (let index = 0; index < sections.length; index += 1) {
            if (sections[index].getAttribute('data-file-path') === jumpTarget.key) {
              node = sections[index]
              break
            }
          }
          if (!node && jumpTarget.index >= 0 && typeof doc.querySelector === 'function') {
            node = doc.querySelector('#cr-file-' + jumpTarget.index)
          }
          if (node && typeof node.scrollIntoView === 'function') {
            node.scrollIntoView({ block: 'start' })
          }
        }, 90)
        return () => clearTimeout(timer)
      }, [jumpTarget])

      const closeSettings = useCallback(() => {
        setSettingsOpen(false)
        const node = gearRef.current
        setTimeout(() => {
          try {
            if (node && typeof node.focus === 'function') node.focus()
          } catch {
            /* focus restore is best effort */
          }
        }, 0)
      }, [])

      // Keyboard shortcuts: j/k switch PR, / focuses search, r reviews, Esc closes the popover.
      useEffect(() => {
        const isTyping = (target) => {
          try {
            if (!target || typeof target !== 'object') return false
            const tag = String(target.tagName || '').toLowerCase()
            return (
              tag === 'input' ||
              tag === 'textarea' ||
              tag === 'select' ||
              Boolean(target.isContentEditable)
            )
          } catch {
            return false
          }
        }
        const onKeyDown = (event) => {
          try {
            if (!event || event.defaultPrevented) return
            if (event.metaKey || event.ctrlKey || event.altKey) return
            const key = String(event.key || '')
            if (key === 'Escape') {
              if (settingsOpen) {
                event.preventDefault()
                setSettingsOpen(false)
                return
              }
              if (mergeDialogRef.current && mergeDialogRef.current.open) {
                event.preventDefault()
                cancelMerge()
                return
              }
              if (publishDialogRef.current && publishDialogRef.current.open) {
                event.preventDefault()
                cancelPublish()
                return
              }
              if (chatRef.current && chatRef.current.open) {
                event.preventDefault()
                setChat((previous) => Object.assign({}, previous, { open: false }))
                return
              }
              return
            }
            if (settingsOpen) return
            if (mergeDialogRef.current && mergeDialogRef.current.open) return
            if (publishDialogRef.current && publishDialogRef.current.open) return
            if (isTyping(event.target)) return
            if (key === 'j' || key === 'k') {
              const items = Array.isArray(list.items) ? list.items : []
              if (items.length === 0) return
              const next = stepSelection(items, selected ? selected.number : null, key === 'j' ? 1 : -1)
              if (!next) return
              event.preventDefault()
              if (selected && Number(next.number) === Number(selected.number)) return
              selectPr(next)
              const container = listRef.current
              if (container && typeof container.querySelector === 'function') {
                const node = container.querySelector('[data-pr-number="' + String(next.number) + '"]')
                if (node && typeof node.scrollIntoView === 'function') {
                  node.scrollIntoView({ block: 'nearest' })
                }
              }
              return
            }
            if (key === '/') {
              event.preventDefault()
              const input = searchRef.current
              if (input && typeof input.focus === 'function') {
                input.focus()
                if (typeof input.select === 'function') input.select()
              }
              return
            }
            if (key === 'r' || key === 'R') {
              if (!selected) return
              if (review.state === 'preparing' || review.state === 'running') return
              event.preventDefault()
              startReview()
            }
          } catch {
            /* a shortcut must never break the workbench */
          }
        }
        document.addEventListener('keydown', onKeyDown, true)
        return () => document.removeEventListener('keydown', onKeyDown, true)
      }, [list.items, selected, settingsOpen, review.state, selectPr, startReview])

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

      // -------------------------------------------------------------------
      // v2: PR chat state machine (CONTRACT §5.2)
      // -------------------------------------------------------------------

      /** Abort the in-flight chat stream (if any); safe to call repeatedly. */
      const abortChatStream = useCallback(() => {
        const controller = chatAbortRef.current
        chatAbortRef.current = null
        try {
          if (controller && typeof controller.abort === 'function') controller.abort()
        } catch {
          /* abort is best effort */
        }
      }, [])

      /** Persist the current PR's settled chat history (best effort). */
      const persistChat = useCallback((messages) => {
        const current = selectedRef.current
        if (!current) return
        writeChatHistory(localStore(), current.repo, current.number, messages)
      }, [])

      // Switching PR: abort any stream, then load that PR's own history.
      const chatKey = selected ? chatHistoryKey(selected.repo, selected.number) : ''
      useEffect(() => {
        const repo = selected ? selected.repo : ''
        const number = selected ? selected.number : null
        chatGeneration.current += 1
        abortChatStream()
        setChat({
          open: false,
          messages: readChatHistory(localStore(), repo, number),
          streaming: false,
          error: null,
        })
        setComposerText('')
        return () => {
          const current = chatRef.current
          if (current && Array.isArray(current.messages) && current.messages.length > 0) {
            writeChatHistory(localStore(), repo, number, current.messages)
          }
        }
      }, [chatKey, abortChatStream])

      /** Optional focusFile context: the expanded diff file while on Changes. */
      const resolveFocusFile = useCallback(() => {
        if (tab !== 'changes') return ''
        const value = detail.value || {}
        const files = Array.isArray(value.files) ? value.files : []
        for (let index = 0; index < files.length; index += 1) {
          const file = files[index] || {}
          const key = fileKey(file, index)
          if (expanded[key]) return typeof file.path === 'string' ? file.path : key
        }
        return ''
      }, [tab, detail.value, expanded])

      const sendChat = useCallback(
        (rawText, options) => {
          const opts = options && typeof options === 'object' ? options : {}
          const current = selectedRef.current
          if (!current) {
            showToast(tx(t, 'chatNoSelection'))
            return
          }
          const text = String(rawText === undefined || rawText === null ? '' : rawText).trim()
          if (!opts.reuseLastUser && text === '') return
          const previous =
            chatRef.current && Array.isArray(chatRef.current.messages)
              ? chatRef.current.messages.slice()
              : []
          let baseMessages = previous.map((message) => ({
            role: message.role,
            content: message.content,
          }))
          let userMessage = { role: 'user', content: text }
          if (opts.reuseLastUser) {
            const lastUser = chatLastUserMessage(previous)
            if (!lastUser) return
            let index = -1
            for (let cursor = previous.length - 1; cursor >= 0; cursor -= 1) {
              if (previous[cursor] === lastUser) {
                index = cursor
                break
              }
            }
            if (index >= 0) {
              baseMessages = previous.slice(0, index).map((message) => ({
                role: message.role,
                content: message.content,
              }))
            }
            userMessage = { role: 'user', content: lastUser.content }
          }
          const generation = ++chatGeneration.current
          abortChatStream()
          const controller = typeof AbortController === 'function' ? new AbortController() : null
          chatAbortRef.current = controller
          const requestMessages = chatRequestMessages(baseMessages.concat([userMessage]))
          const focusFile = resolveFocusFile()
          const payload = { repo: current.repo, number: current.number, messages: requestMessages }
          if (focusFile !== '') payload.focusFile = focusFile
          setComposerText('')
          setChat({
            open: true,
            messages: baseMessages.concat([userMessage, { role: 'assistant', content: '' }]),
            streaming: true,
            error: null,
          })
          const settle = (updater) => {
            if (generation !== chatGeneration.current) return
            setChat((state) => {
              const next = updater(state)
              if (next && Array.isArray(next.messages)) persistChat(next.messages)
              return next
            })
          }
          streamPost(ROUTE + '/chat', payload, {
            signal: controller ? controller.signal : undefined,
            onEvent: (event) => {
              if (generation !== chatGeneration.current) return
              if (event.type === 'delta') {
                setChat((state) =>
                  Object.assign({}, state, {
                    messages: applyChatDelta(state.messages, event.text),
                  }),
                )
              }
            },
          }).then((result) => {
            if (generation !== chatGeneration.current) return
            chatAbortRef.current = null
            if (result && result.aborted) {
              settle((state) => ({
                open: true,
                messages: markChatStopped(state.messages),
                streaming: false,
                error: null,
              }))
              return
            }
            if (!result || !result.ok) {
              const error =
                result && result.error ? result.error : { code: 'INTERNAL', message: '对话失败' }
              settle((state) => ({
                open: true,
                messages: dropEmptyAssistant(state.messages),
                streaming: false,
                error,
              }))
              return
            }
            settle((state) => ({
              open: true,
              messages: settleChatMessages(state.messages),
              streaming: false,
              error: null,
            }))
          })
        },
        [abortChatStream, persistChat, resolveFocusFile, showToast, t],
      )

      const openChat = useCallback(() => {
        if (!selectedRef.current) {
          showToast(tx(t, 'chatNoSelection'))
          return
        }
        setChat((previous) => Object.assign({}, previous, { open: true }))
      }, [showToast, t])

      const closeChat = useCallback(() => {
        setChat((previous) => Object.assign({}, previous, { open: false }))
      }, [])

      const stopChat = useCallback(() => {
        const controller = chatAbortRef.current
        if (!controller) {
          setChat((previous) => Object.assign({}, previous, { streaming: false }))
          return
        }
        try {
          if (typeof controller.abort === 'function') controller.abort()
        } catch {
          /* ignore */
        }
      }, [])

      const clearChat = useCallback(() => {
        chatGeneration.current += 1
        abortChatStream()
        persistChat([])
        setChat({ open: true, messages: [], streaming: false, error: null })
        showToast(tx(t, 'chatCleared'))
      }, [abortChatStream, persistChat, showToast, t])

      const retryChat = useCallback(() => {
        sendChat('', { reuseLastUser: true })
      }, [sendChat])

      // -------------------------------------------------------------------
      // v2: merge confirmation (CONTRACT §5.3) — writes only after explicit confirm
      // -------------------------------------------------------------------

      const openMerge = useCallback(() => {
        const current = selectedRef.current
        if (!current) return
        if (!mergeAvailability(current).enabled) return
        setMergeDialog({
          open: true,
          method: DEFAULT_MERGE_METHOD,
          deleteBranch: false,
          phase: 'idle',
          error: null,
        })
      }, [])

      const cancelMerge = useCallback(() => {
        setMergeDialog((previous) =>
          Object.assign({}, previous, { open: false, phase: 'idle', error: null }),
        )
      }, [])

      const updateMerge = useCallback((patch) => {
        setMergeDialog((previous) => Object.assign({}, previous, patch))
      }, [])

      const confirmMerge = useCallback(() => {
        const current = selectedRef.current
        if (!current) return
        const currentDialog = mergeDialogRef.current
        if (!currentDialog || currentDialog.phase === 'submitting') return
        const detailValue = detail.value || {}
        const headSha = resolveHeadSha(detailValue)
        const request = buildMergeRequest({
          summary: detailValue.summary || current,
          headSha,
          method: currentDialog.method,
          deleteBranch: currentDialog.deleteBranch,
        })
        if (!request) {
          setMergeDialog((previous) =>
            Object.assign({}, previous, {
              phase: 'idle',
              error: {
                code: 'BAD_REQUEST',
                message: tx(t, headSha === '' ? 'mergeHeadMissing' : 'mergeMethodRequired'),
              },
            }),
          )
          return
        }
        setMergeDialog((previous) => Object.assign({}, previous, { phase: 'submitting', error: null }))
        post(ROUTE + '/merge', request).then((result) => {
          if (result.ok) {
            const value = result.value || {}
            const sha = shortSha(value.sha, 7) || shortSha(request.expectedHeadSha, 7)
            const key = String(current.repo || '') + '#' + String(current.number)
            setMergedPrs((previous) => Object.assign({}, previous, { [key]: sha || 'merged' }))
            setMergeDialog({
              open: false,
              method: DEFAULT_MERGE_METHOD,
              deleteBranch: false,
              phase: 'idle',
              error: null,
            })
            let message = tx(t, 'mergeSuccess', { sha })
            if (value.branchWarning) {
              message += ' · ' + tx(t, 'mergeBranchWarning', { message: String(value.branchWarning) })
            }
            showToast(message)
            loadDetail(current)
            return
          }
          const error = result.error || { code: 'INTERNAL', message: '合并失败' }
          setMergeDialog((previous) => Object.assign({}, previous, { phase: 'idle', error }))
          if (error.code === 'MERGE_HEAD_MOVED') {
            showToast(tx(t, 'mergeHeadMoved'))
            loadDetail(current)
          }
        })
      }, [detail.value, loadDetail, showToast, t])

      // -------------------------------------------------------------------
      // v2.1: auto review status / polling / notifications (CONTRACT §6.4)
      // -------------------------------------------------------------------

      /** Jump to a PR referenced by an auto-review result (list hit or synthesized). */
      const jumpToAutoReviewPr = useCallback(
        (entry) => {
          if (!entry || entry.number === undefined) return
          const number = Number(entry.number)
          if (!Number.isFinite(number)) return
          const items = Array.isArray(list.items) ? list.items : []
          const repo = String(entry.repo || '')
          const match =
            items.find(
              (item) => Number(item.number) === number && (repo === '' || String(item.repo) === repo),
            ) || items.find((item) => Number(item.number) === number)
          if (match) {
            selectPr(match)
            return
          }
          selectPr({
            repo,
            number,
            title: '#' + String(number),
            author: '',
            isDraft: false,
            state: 'open',
            updatedAt: '',
            url: '',
          })
        },
        [list.items, selectPr],
      )
      jumpAutoRef.current = jumpToAutoReviewPr

      /** Apply a Host AutoReviewStatus; toast new done results (not on first load). */
      const applyAutoReviewStatus = useCallback(
        (value) => {
          const status = normalizeAutoReviewStatus(value)
          const previousState = autoReviewRef.current
          const previousRecent =
            previousState && previousState.status ? previousState.status.recent : []
          const firstLoad = !autoReviewBaselineRef.current
          autoReviewBaselineRef.current = true
          const newDone = firstLoad ? [] : diffAutoReviewRecent(previousRecent, status.recent)
          setAutoReview({ supported: true, loading: false, status })
          setSettings(cacheSharedSettings(status.config))
          if (newDone.length > 0) {
            const last = newDone[newDone.length - 1]
            const target = { repo: last.repo, number: last.number }
            showToast(
              {
                text: autoReviewDoneToastText(last, t),
                action: {
                  label: tx(t, 'autoReviewToastAction'),
                  onClick: () => {
                    if (jumpAutoRef.current) jumpAutoRef.current(target)
                  },
                },
              },
              5000,
            )
          }
        },
        [showToast, t],
      )

      const refreshAutoReview = useCallback(() => {
        post(ROUTE + '/auto-review-status', {}).then((result) => {
          if (result.ok) {
            applyAutoReviewStatus(result.value)
            return
          }
          if (isAutoReviewRouteMissing(result.error)) {
            setAutoReview({ supported: false, loading: false, status: null })
            return
          }
          setAutoReview((previous) =>
            Object.assign({}, previous, { loading: false, error: result.error }),
          )
        })
      }, [applyAutoReviewStatus])

      /** Persist one auto-review config patch; the Host echo wins. */
      const runAutoReview = useCallback(() => {
        if (autoReviewRunBusy) return
        setAutoReviewRunBusy(true)
        post(ROUTE + '/auto-review-run', { force: true }).then((result) => {
          setAutoReviewRunBusy(false)
          const outcome = autoReviewRunState(result.ok ? result.value : null, result.ok ? null : result.error)
          if (outcome.kind === 'unsupported') {
            setAutoReview({ supported: false, loading: false, status: null })
            showToast(tx(t, 'autoReviewUnsupported'))
            return
          }
          showToast(tx(t, outcome.messageKey))
          refreshAutoReview()
        })
      }, [autoReviewRunBusy, refreshAutoReview, showToast, t])

      // Visibility tracking: hidden tabs pause auto-review polling.
      useEffect(() => {
        const handler = () => {
          try {
            setPageVisible(
              typeof document === 'undefined' ? true : document.visibilityState !== 'hidden',
            )
          } catch {
            setPageVisible(true)
          }
        }
        try {
          document.addEventListener('visibilitychange', handler)
        } catch {
          /* ignore */
        }
        return () => {
          try {
            document.removeEventListener('visibilitychange', handler)
          } catch {
            /* ignore */
          }
        }
      }, [])

      // One initial read so the card knows the config even while disabled.
      useEffect(() => {
        refreshAutoReview()
      }, [refreshAutoReview])

      const autoEnabled = Boolean(autoReview.status && autoReview.status.config.enabled)
      const autoPollDecision = autoReviewPollDecision({
        supported: autoReview.supported !== false,
        enabled: autoEnabled,
        visible: pageVisible,
        intervalMs: autoReviewPollMs,
      })
      useEffect(() => {
        if (!autoPollDecision.active) return undefined
        const timer = setInterval(refreshAutoReview, autoPollDecision.intervalMs)
        return () => clearInterval(timer)
      }, [autoPollDecision.active, autoPollDecision.intervalMs, refreshAutoReview])

      const autoRunning = Boolean(autoReview.status && autoReview.status.running)
      useEffect(() => {
        if (!autoPollDecision.active || !autoRunning) return undefined
        const timer = setInterval(
          refreshAutoReview,
          Math.min(AUTO_REVIEW_RUNNING_POLL_MS, autoReviewPollMs),
        )
        return () => clearInterval(timer)
      }, [autoPollDecision.active, autoRunning, autoReviewPollMs, refreshAutoReview])

      // -------------------------------------------------------------------
      // v2.3: write comments — reply / resolve thread / PR conversation
      // (CONTRACT §8). Every path requires confirm:true on the Host side.
      // -------------------------------------------------------------------

      const [commentDialog, setCommentDialog] = useState({
        open: false,
        text: '',
        phase: 'idle',
        error: null,
      })

      const openCommentDialog = useCallback(() => {
        if (!selectedRef.current) return
        setCommentDialog({ open: true, text: '', phase: 'idle', error: null })
      }, [])

      const updateCommentText = useCallback((text) => {
        setCommentDialog((previous) => Object.assign({}, previous, { text, error: null }))
      }, [])

      const cancelCommentDialog = useCallback(() => {
        setCommentDialog({ open: false, text: '', phase: 'idle', error: null })
      }, [])

      const confirmComment = useCallback(() => {
        const current = selectedRef.current
        const body = String(commentDialog.text || '').trim()
        if (!current || body === '' || commentDialog.phase === 'submitting') return
        setCommentDialog((previous) =>
          Object.assign({}, previous, { phase: 'submitting', error: null }),
        )
        post(ROUTE + '/comment', {
          repo: current.repo,
          number: current.number,
          body,
          confirm: true,
        }).then((result) => {
          if (result.ok) {
            showToast(tx(t, 'commentDone'))
            setCommentDialog({ open: false, text: '', phase: 'idle', error: null })
            refreshDetail(current)
            return
          }
          setCommentDialog((previous) =>
            Object.assign({}, previous, { phase: 'error', error: result.error || null }),
          )
        })
      }, [commentDialog, refreshDetail, showToast, t])

      /** Reply / resolve helpers handed down to the inline comment cards. */
      const writeActions = useMemo(() => {
        const finish = (result, doneKey, origin) => {
          if (result && result.ok) {
            showToast(tx(t, doneKey))
            refreshDetail(origin)
            return true
          }
          const code = result && result.error ? result.error.code : ''
          showToast(tx(t, code === 'GH_FORBIDDEN' ? 'writeForbidden' : 'writeFailed'))
          return false
        }
        return {
          reply: (comment, body) => {
            const current = selectedRef.current
            if (!current || !comment || !Number.isInteger(comment.id)) return Promise.resolve(false)
            return post(ROUTE + '/reply', {
              repo: current.repo,
              number: current.number,
              commentId: comment.id,
              body,
              confirm: true,
            }).then((result) => finish(result, 'replyDone', current))
          },
          resolve: (comment) => {
            const current = selectedRef.current
            if (!current || !comment || typeof comment.threadId !== 'string' || comment.threadId === '') {
              return Promise.resolve(false)
            }
            return post(ROUTE + '/resolve', {
              repo: current.repo,
              number: current.number,
              threadId: comment.threadId,
              confirm: true,
            }).then((result) => finish(result, 'resolveDone', current))
          },
        }
      }, [refreshDetail, showToast, t])

      // -------------------------------------------------------------------
      // v2.2: publish the current review to GitHub (CONTRACT §7.3)
      // -------------------------------------------------------------------

      const openPublishDialog = useCallback(() => {
        const current = selectedRef.current
        if (!current) return
        const currentReview = reviewRef.current
        if (!currentReview || currentReview.state !== 'done') {
          showToast(tx(t, 'publishNotReady'))
          return
        }
        if (currentReview.partial === true) {
          showToast(tx(t, 'publishPartial'))
          return
        }
        const autoState = autoReviewRef.current
        const config =
          autoState && autoState.status && autoState.status.publish
            ? autoState.status.publish
            : normalizePublishConfig(null)
        setPublishDialog({
          open: true,
          mode: config.mode,
          minSeverity: config.minSeverity,
          phase: 'idle',
          error: null,
        })
      }, [showToast, t])

      const updatePublishDialog = useCallback((patch) => {
        setPublishDialog((previous) => Object.assign({}, previous, patch))
      }, [])

      const cancelPublish = useCallback(() => {
        setPublishDialog((previous) =>
          Object.assign({}, previous, { open: false, phase: 'idle', error: null }),
        )
      }, [])

      const confirmPublish = useCallback(() => {
        const current = selectedRef.current
        const dialog = publishDialogRef.current
        if (!current || !dialog || dialog.phase === 'submitting') return
        const request = buildPublishRequest({
          summary: current,
          headSha: (reviewRef.current && reviewRef.current.headSha) || '',
          jobId: (reviewRef.current && reviewRef.current.jobId) || '',
          mode: dialog.mode,
          minSeverity: dialog.minSeverity,
        })
        if (!request) {
          setPublishDialog((previous) =>
            Object.assign({}, previous, {
              phase: 'idle',
              error: { code: 'BAD_REQUEST', message: '' },
            }),
          )
          showToast(tx(t, 'publishBadRequest'))
          return
        }
        setPublishDialog((previous) =>
          Object.assign({}, previous, { phase: 'submitting', error: null }),
        )
        post(ROUTE + '/review-publish', request, { timeoutMs: PUBLISH_TIMEOUT_MS }).then((result) => {
          if (result.ok) {
            const value = result.value || {}
            const record = normalizePublishResult(value)
            const headSha =
              (typeof value.headSha === 'string' ? value.headSha : '') ||
              (reviewRef.current && reviewRef.current.headSha) ||
              ''
            const key = publishRecordKey(current.repo, current.number, headSha)
            if (record && key !== '') {
              setPublishRecords((previous) => Object.assign({}, previous, { [key]: record }))
            }
            setPublishDialog({
              open: false,
              mode: 'inline',
              minSeverity: 'P2',
              phase: 'idle',
              error: null,
            })
            // Tell the user what actually happened: a summary update or a no-op
            // must not read as "N comments created".
            const action = record ? record.action : 'created'
            if (action === 'unchanged') showToast(tx(t, 'publishUnchanged'))
            else if (action === 'updated') showToast(tx(t, 'publishUpdated'))
            else showToast(tx(t, 'publishSuccess', { n: record ? record.comments : 0 }))
            return
          }
          const error = result.error || { code: 'INTERNAL', message: '' }
          if (isPublishRouteMissing(error)) {
            setPublishUnsupported(true)
            setPublishDialog({
              open: false,
              mode: 'inline',
              minSeverity: 'P2',
              phase: 'idle',
              error: null,
            })
            showToast(tx(t, 'publishUnsupported'))
            return
          }
          setPublishDialog((previous) =>
            Object.assign({}, previous, { phase: 'idle', error }),
          )
          const localeKey = publishErrorKey(error.code)
          showToast(tx(t, localeKey || 'publishFailed'))
        })
      }, [showToast, t])

      // A new review / PR switch invalidates an open publish confirmation.
      useEffect(() => {
        if (review.state !== 'done') {
          setPublishDialog((previous) =>
            previous.open
              ? Object.assign({}, previous, { open: false, phase: 'idle', error: null })
              : previous,
          )
        }
      }, [review.state, review.jobId])

      const notice = healthNotice(health, t)
      const detailValue = detail.value
      const reviewValue = review || { state: 'none' }
      const findings = Array.isArray(reviewValue.findings) ? reviewValue.findings : []
      const findingsByFile = groupFindingsByFile(findings)
      const summary = detailValue && detailValue.summary ? detailValue.summary : selected || {}
      const settingsSummary = tx(t, 'reviewOptionsSummary', {
        depth: tx(t, depthKey(settings.depth)),
        threshold: tx(t, thresholdKey(settings.severityThreshold)),
      })
      const mergedKey = selected ? String(selected.repo || '') + '#' + String(selected.number) : ''
      const mergedSha = mergedKey !== '' ? mergedPrs[mergedKey] || '' : ''
      const summaryForMerge = detailValue && detailValue.summary ? detailValue.summary : selected || {}
      const mergeState = mergeAvailability(
        mergedSha !== '' ? Object.assign({}, summaryForMerge, { merged: true }) : summaryForMerge,
      )
      const mergeTitle = mergeState.enabled
        ? tx(t, 'merge')
        : tx(
            t,
            mergeState.reason === 'merged'
              ? 'mergeMerged'
              : mergeState.reason === 'draft'
                ? 'mergeDraft'
                : mergeState.reason === 'closed'
                  ? 'mergeClosed'
                  : 'mergeNotAllowed',
          )
      const currentHeadSha = resolveHeadSha(detailValue)
      const canChat = Boolean(selected)
      const autoStatus = autoReview.status
      const autoBadges = useMemo(
        () => autoReviewBadgesByPr(autoStatus ? autoStatus.recent : []),
        [autoStatus],
      )
      const publishConfig = autoStatus && autoStatus.publish ? autoStatus.publish : null
      const publishSupported =
        !publishUnsupported && autoReview.supported !== false && publishConfig !== null
      const reviewHeadSha = reviewValue.headSha || currentHeadSha
      const reviewPublishKey = publishRecordKey(summary.repo, summary.number, reviewHeadSha)
      const localPublished =
        reviewPublishKey !== '' ? publishRecords[reviewPublishKey] || null : null
      const reviewPublished =
        localPublished ||
        (reviewValue.published &&
        (reviewValue.published.headSha === '' || reviewValue.published.headSha === reviewHeadSha)
          ? reviewValue.published
          : null)
      const reviewPublish = {
        supported: publishSupported,
        published: reviewPublished,
        onOpen: openPublishDialog,
      }
      const publishExpectedCount = countPublishableFindings(
        findings,
        publishDialog.minSeverity,
        publishConfig ? publishConfig.maxComments : PUBLISH_DEFAULT_CONFIG.maxComments,
      )

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
          h(PrHeader, {
            detail: detailValue || { summary },
            t,
            onComment: selected ? openCommentDialog : null,
          }),
          selected
            ? h(ReviewCard, {
                review: reviewValue,
                finishedAt: reviewFinishedAt,
                t,
                publish: reviewPublish,
                onStart: startReview,
                onRetry: startReview,
                onCancel: cancelReview,
                onLocate: locateFinding,
              })
            : null,
          tab === 'changes'
            ? h(ChangesView, {
                detail: detailValue || {},
                expanded,
                onToggleFile: toggleFile,
                onToggleAll: toggleAllFiles,
                findingsByFile,
                highlight,
                onLocate: locateFinding,
                writeActions,
                t,
              })
            : h(SummaryView, {
                detail: detailValue || {},
                review: reviewValue,
                publish: reviewPublish,
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
          'data-cr-settings-open': settingsOpen ? 'open' : 'closed',
          'data-cr-settings-depth': settings.depth,
          'data-cr-settings-threshold': settings.severityThreshold,
          'data-cr-merge-open': mergeDialog.open ? 'open' : 'closed',
          'data-cr-chat-open': chat.open ? 'open' : 'closed',
          'data-cr-chat-streaming': chat.streaming ? 'true' : 'false',
          'data-cr-chat-messages': String(Array.isArray(chat.messages) ? chat.messages.length : 0),
          'data-cr-auto-supported': autoReview.supported ? 'true' : 'false',
          'data-cr-auto-enabled': autoEnabled ? 'true' : 'false',
          'data-cr-auto-running': autoRunning ? 'true' : 'false',
          'data-cr-auto-recent': String(autoStatus ? autoStatus.recent.length : 0),
          'data-cr-auto-open': autoReviewOpen ? 'true' : 'false',
          'data-cr-publish-supported': publishSupported ? 'true' : 'false',
          'data-cr-publish-dialog': publishDialog.open ? 'open' : 'closed',
          'data-cr-publish-published':
            reviewPublished && reviewPublished.url ? 'true' : 'false',
        },
        h('style', null, CSS),
        h('div', { className: 'cr-layout' },
          h(PrList, {
            state: list,
            queryInput,
            selectedNumber: selected ? selected.number : null,
            t,
            inputRef: searchRef,
            listRef,
            autoBadges,
            onSelect: selectPr,
            onPrefetch: prefetchDetail,
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
              settingsSummary,
              settingsOpen,
              gearRef,
              onTabChange: changeTab,
              onPin: () => setPinned((previous) => !previous),
              onCopy: copyLink,
              onGithub: openGithub,
              onReview: startReview,
              onGear: () => setSettingsOpen(true),
              mergeEnabled: mergeState.enabled,
              mergeTitle,
              mergeOpen: mergeDialog.open,
              onMerge: openMerge,
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
                      findingsByFile,
                      now: clock,
                      autoReview,
                      autoReviewOpen,
                      autoReviewRunBusy,
                      onAutoReviewToggle: () => setAutoReviewOpen((previous) => !previous),
                      onAutoReviewRefresh: refreshAutoReview,
                      onAutoReviewRun: runAutoReview,
                      onAutoReviewJump: jumpToAutoReviewPr,
                      onOpenSettings: () => setSettingsOpen(true),
                      t,
                      onTabChange: changeTab,
                      onJumpFile: jumpToFile,
                      onStartReview: startReview,
                      onCancelReview: cancelReview,
                      onResolve: writeActions.resolve,
                      onLocate: locateFinding,
                    })
                  : selected
                    ? h(RightRailPending, { summary: selected, t })
                    : detail.state === 'loading'
                    ? h(
                        'aside',
                        {
                          className: 'cr-details',
                          'data-cr-details-loading': 'ready',
                          'aria-busy': 'true',
                          'aria-hidden': 'true',
                        },
                        h(Skeleton, { rows: 2, height: 24 }),
                        h('div', { style: { height: 14 } }),
                        h(Skeleton, { rows: 2, height: 56 }),
                        h('div', { style: { height: 14 } }),
                        h(Skeleton, { rows: 1, height: 40 }),
                      )
                    : h('aside', { className: 'cr-details', 'aria-hidden': 'true' }),
              ),
            ),
          ),
        ),
        settingsOpen
          ? h(ReviewSettings, {
              t,
              onClose: () => { closeSettings(); refreshAutoReview() },
            })
          : null,
        publishDialog.open && selected
          ? h(PublishDialog, {
              summary,
              headSha: reviewHeadSha,
              mode: publishDialog.mode,
              minSeverity: publishDialog.minSeverity,
              expected: publishExpectedCount,
              phase: publishDialog.phase,
              error: publishDialog.error,
              t,
              onModeChange: (mode) => updatePublishDialog({ mode }),
              onMinSeverityChange: (minSeverity) => updatePublishDialog({ minSeverity }),
              onConfirm: confirmPublish,
              onCancel: cancelPublish,
            })
          : null,
        commentDialog.open && selected
          ? h(CommentDialog, {
              text: commentDialog.text,
              phase: commentDialog.phase,
              error: commentDialog.error,
              t,
              onTextChange: updateCommentText,
              onConfirm: confirmComment,
              onCancel: cancelCommentDialog,
            })
          : null,
        chat.open && selected
          ? h(ChatPanel, {
              chat,
              t,
              onClose: closeChat,
              onClear: clearChat,
              onStop: stopChat,
              onRetry: retryChat,
              onQuickPrompt: (text) => sendChat(text),
            })
          : null,
        mergeDialog.open && selected
          ? h(MergeDialog, {
              summary: summaryForMerge,
              headSha: currentHeadSha,
              method: mergeDialog.method,
              deleteBranch: mergeDialog.deleteBranch,
              phase: mergeDialog.phase,
              error: mergeDialog.error,
              t,
              onMethodChange: (method) => updateMerge({ method }),
              onDeleteBranchChange: (deleteBranch) => updateMerge({ deleteBranch }),
              onConfirm: confirmMerge,
              onCancel: cancelMerge,
            })
          : null,
        h(Composer, {
          t,
          value: composerText,
          onChange: setComposerText,
          onSend: (text) => sendChat(text),
          onQuickPrompt: (text) => sendChat(text),
          onOpen: openChat,
          streaming: chat.streaming,
          canChat,
          inputRef: composerRef,
        }),
        toast
          ? h(
              'div',
              {
                className: 'cr-toast' + (toast && toast.action ? ' cr-toast--action' : ''),
                role: 'status',
              },
              h(
                'span',
                { className: 'cr-toast-text' },
                typeof toast === 'string' ? toast : String((toast && toast.text) || ''),
              ),
              toast && toast.action
                ? h(
                    'button',
                    {
                      type: 'button',
                      className: 'cr-toast-btn',
                      onClick: () => {
                        try {
                          toast.action.onClick()
                        } catch {
                          /* a toast action must never break the page */
                        }
                        dismissToast()
                      },
                    },
                    String(toast.action.label || ''),
                  )
                : null,
            )
          : null,
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
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: PANEL_ID,
            order: 60,
            locale: NS,
            label: () => tx(t, 'panel'),
          },
          CodeReviewSettingsPanel,
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
        SETTINGS_KEY,
        DEFAULT_SETTINGS,
        DEPTHS,
        THRESHOLDS,
        COMMENT_PREVIEW_CHARS,
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
        reviewVerdict,
        normalizeSettings,
        hasSettingsFields,
        readSettings,
        writeSettings,
        localStore,
        settingsToOptions,
        normalizeReviewOptions,
        normalizeGuidelines,
        normalizeFinding,
        normalizeReviewStatus,
        groupFindingsByLine,
        normalizeInlineComments,
        CodeReviewSettingsPanel,
        ReviewSettings,
        groupCommentThreads,
        CommentsCard,
        Workbench,
        groupCommentsByFile,
        truncateText,
        filterFindings,
        stepSelection,
        depthKey,
        thresholdKey,
        verdictKey,
        verdictHintKey,
        confidenceKey,
        describeReviewOptions,
        MERGE_METHODS,
        DEFAULT_MERGE_METHOD,
        CHAT_KEY_PREFIX,
        CHAT_HISTORY_LIMIT,
        CHAT_REQUEST_MESSAGES,
        CHAT_MESSAGE_CHARS,
        CHAT_QUICK_PROMPTS,
        mergeAvailability,
        resolveHeadSha,
        shortSha,
        normalizeMergeMethod,
        buildMergeRequest,
        mergeErrorKey,
        createSseParser,
        normalizeChatHistory,
        chatHistoryKey,
        readChatHistory,
        writeChatHistory,
        chatRequestMessages,
        applyChatDelta,
        chatLastUserMessage,
        dropEmptyAssistant,
        settleChatMessages,
        markChatStopped,
        post,
        streamPost,
        AUTO_REVIEW_POLL_MS,
        AUTO_REVIEW_RUNNING_POLL_MS,
        AUTO_REVIEW_RECENT_LIMIT,
        AUTO_REVIEW_INTERVAL_PRESETS,
        AUTO_REVIEW_INTERVAL_MIN,
        AUTO_REVIEW_INTERVAL_MAX,
        AUTO_REVIEW_MAX_PER_CYCLE_MIN,
        AUTO_REVIEW_MAX_PER_CYCLE_MAX,
        AUTO_REVIEW_DEFAULT,
        clampInteger,
        normalizeAutoReviewConfig,
        normalizeAutoReviewRecentEntry,
        normalizeAutoReviewRecent,
        normalizeAutoReviewStatus,
        autoReviewRecentKey,
        diffAutoReviewRecent,
        autoReviewPollDecision,
        autoReviewBadgesByPr,
        autoReviewBadge,
        isAutoReviewRouteMissing,
        autoReviewRunState,
        autoReviewDoneToastText,
        PUBLISH_MODES,
        PUBLISH_MIN_SEVERITIES,
        PUBLISH_MAX_COMMENTS_MIN,
        PUBLISH_MAX_COMMENTS_MAX,
        PUBLISH_DEFAULT_CONFIG,
        normalizePublishConfig,
        severityAtLeast,
        filterPublishableFindings,
        countPublishableFindings,
        buildPublishRequest,
        normalizePublished,
        normalizePublishResult,
        publishErrorKey,
        isPublishRouteMissing,
        publishRecordKey,
        publishModeLabelKey,
        publishModeHintKey,
        autoPublishStatusKey,
      },
    }
  },
})

