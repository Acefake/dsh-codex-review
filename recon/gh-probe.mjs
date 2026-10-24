#!/usr/bin/env node
/**
 * gh-probe.mjs —— 代码审查插件「宿主侧取 GitHub PR 数据」可行性探针（只读）
 *
 * 目的：用真实仓库跑通插件需要的每一类数据，并把「请求命令、耗时、原始大小、
 * 关键字段形状、截断结果」写成一份 JSON，供宿主实现（DSH Host 插件 / Node ESM）
 * 直接参考。脚本只做 GET / 只读命令，不会评论、合并或改动仓库。
 *
 * 用法（Windows，gh 已登录）:
 *   node gh-probe.mjs --repo Acefake/yingbox --pr 129
 *   node gh-probe.mjs --repo o/r --pr 1 --mode gh --max-diff-chars 60000
 *   node gh-probe.mjs --help
 *
 * 关键选项:
 *   --repo <owner/name>     默认 Acefake/yingbox
 *   --pr <number>           默认 129
 *   --review-sample-pr <n>  额外拉一个有已存在 review 的 PR 作形状样本（0=不拉）
 *   --out <path>            默认 <script dir>/probe-output.json
 *   --mode gh|token|both    默认 both：A=gh CLI 子进程，B=gh auth token + fetch 直连 REST
 *   --max-diff-chars <n>    diff 文本保留上限，默认 200000
 *   --max-patch-chars <n>   单文件 patch 保留上限，默认 30000
 *   --max-body-chars <n>    PR body 保留上限，默认 50000
 *   --skip-errors           跳过错误场景探测（404 / 401 / 未登录）
 *   --skip-graphql          跳过 GraphQL 单请求探测
 *   --quiet                 只打印最终摘要
 *
 * 退出码: 0=成功；2=参数/环境错误（gh 不存在、参数非法）；3=仓库/PR 读取失败。
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const KNOWN_GH_WIN = 'C:\\Program Files\\GitHub CLI\\gh.exe';

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const opts = {
    repo: 'Acefake/yingbox',
    pr: 129,
    reviewSamplePr: 0,
    out: join(SCRIPT_DIR, 'probe-output.json'),
    mode: 'both',
    maxDiffChars: 200000,
    maxPatchChars: 30000,
    maxBodyChars: 50000,
    maxReviewCommentBody: 4000,
    maxDiffHunk: 2000,
    maxComments: 100,
    skipErrors: false,
    skipGraphql: false,
    quiet: false,
  };
  const int = (v, name) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0) throw new Error(`--${name} 需要非负整数，收到: ${v}`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} 缺少值`);
      return argv[++i];
    };
    switch (a) {
      case '--repo': opts.repo = next(); break;
      case '--pr': opts.pr = int(next(), 'pr'); break;
      case '--review-sample-pr': opts.reviewSamplePr = int(next(), 'review-sample-pr'); break;
      case '--out': opts.out = next(); break;
      case '--mode': opts.mode = next(); break;
      case '--max-diff-chars': opts.maxDiffChars = int(next(), 'max-diff-chars'); break;
      case '--max-patch-chars': opts.maxPatchChars = int(next(), 'max-patch-chars'); break;
      case '--max-body-chars': opts.maxBodyChars = int(next(), 'max-body-chars'); break;
      case '--skip-errors': opts.skipErrors = true; break;
      case '--skip-graphql': opts.skipGraphql = true; break;
      case '--quiet': opts.quiet = true; break;
      case '-h': case '--help':
        console.log('node gh-probe.mjs --repo <owner/name> --pr <n> [--out path] [--mode gh|token|both]');
        console.log('可选: --review-sample-pr <n> --max-diff-chars <n> --max-patch-chars <n> --max-body-chars <n>');
        console.log('      --skip-errors --skip-graphql --quiet');
        process.exit(0);
        break;
      default:
        throw new Error(`未知参数: ${a}（--help 查看用法）`);
    }
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(opts.repo)) throw new Error(`--repo 需要 owner/repo 格式: ${opts.repo}`);
  if (!['gh', 'token', 'both'].includes(opts.mode)) throw new Error(`--mode 需要 gh|token|both: ${opts.mode}`);
  return opts;
}

// ---------------------------------------------------------------------------
// gh CLI 调用
// ---------------------------------------------------------------------------
const commandLog = [];

function resolveGhBin() {
  const candidates = [];
  if (process.env.GH_BIN) candidates.push(process.env.GH_BIN);
  if (process.platform === 'win32') {
    // where.exe 走 PATH，能找到 nvm/scoop/安装包里的 gh.exe
    const w = spawnSync('where.exe', ['gh'], { encoding: 'utf8', windowsHide: true });
    if (w.status === 0 && w.stdout) candidates.push(w.stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0]);
    if (existsSync(KNOWN_GH_WIN)) candidates.push(KNOWN_GH_WIN);
  }
  candidates.push('gh');
  for (const bin of candidates) {
    if (!bin) continue;
    const probe = spawnSync(bin, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    if (probe.status === 0) return { bin, version: (probe.stdout || '').split(/\r?\n/)[0].trim() };
  }
  throw new Error('找不到可用的 gh CLI；请安装 gh 或用 GH_BIN 指定路径（https://cli.github.com/）');
}

const ghBinInfo = resolveGhBin();

function firstLines(text, n = 4, maxChars = 600) {
  const s = (text || '').trim();
  if (!s) return '';
  const joined = s.split(/\r?\n/).slice(0, n).join(' | ');
  return joined.length > maxChars ? joined.slice(0, maxChars) + '…' : joined;
}

/** 统一执行 gh 子进程：buffer 输出 + UTF-8 解码（Windows 下不依赖控制台代码页）。 */
function runGh(args, { env } = {}) {
  const started = Date.now();
  const res = spawnSync(ghBinInfo.bin, args, {
    encoding: 'buffer',
    windowsHide: true,
    maxBuffer: 128 * 1024 * 1024,
    timeout: 120000,
    env: env || process.env,
  });
  const ms = Date.now() - started;
  const stdout = res.stdout ? res.stdout.toString('utf8') : '';
  const stderr = res.stderr ? res.stderr.toString('utf8') : '';
  commandLog.push({
    cmd: 'gh ' + args.map(a => (a.length > 120 ? a.slice(0, 120) + '…' : a)).join(' '),
    status: res.status,
    errorCode: res.error ? res.error.code : null,
    ms,
    stdoutChars: stdout.length,
    stderr: firstLines(stderr),
  });
  return { status: res.status, stdout, stderr, ms, errorCode: res.error ? res.error.code : null };
}

function parseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function requireJson(res, what) {
  const parsed = parseJson(res.stdout);
  if (parsed === null) {
    const err = new Error(`${what} 返回的不是 JSON（exit=${res.status}，stderr=${firstLines(res.stderr, 2)}，stdout前200字=${res.stdout.slice(0, 200)}）`);
    err.exitCode = 3;
    throw err;
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// 截断工具：所有大文本统一走这里，结果里记录 original/kept/dropped，便于复盘
// ---------------------------------------------------------------------------
function truncateText(text, maxChars, label) {
  const s = typeof text === 'string' ? text : '';
  if (s.length <= maxChars) {
    return { value: s, truncated: false, originalChars: s.length, keptChars: s.length, droppedChars: 0, marker: '' };
  }
  const kept = s.slice(0, maxChars);
  const dropped = s.length - maxChars;
  const marker = `\n…[truncated: kept ${maxChars}, dropped ${dropped}, total ${s.length} chars (${label})]`;
  return { value: kept + marker, truncated: true, originalChars: s.length, keptChars: maxChars, droppedChars: dropped, marker: marker.trim() };
}

function slimUser(user) {
  if (!user) return null;
  return {
    login: user.login ?? null,
    name: user.name ?? null,
    isBot: user.type === 'Bot' || user.is_bot === true || /\[bot\]$/.test(user.login || ''),
  };
}

function slimComment(c) {
  return {
    id: c.id ?? null,
    author: slimUser(c.user)?.login ?? null,
    bodyChars: typeof c.body === 'string' ? c.body.length : 0,
    body: c.body ?? '',
    createdAt: c.created_at ?? c.createdAt ?? null,
    url: c.html_url ?? c.url ?? null,
  };
}

// ---------------------------------------------------------------------------
// 各数据源
// ---------------------------------------------------------------------------
function probeRepo(repo) {
  const r = runGh(['api', `repos/${repo}`]);
  if (r.status !== 0) {
    const parsed = parseJson(r.stdout);
    const err = new Error(`无法读取仓库 ${repo}（exit=${r.status}）：${firstLines(r.stderr, 3)}${parsed ? ' | ' + JSON.stringify(parsed) : ''}`);
    err.exitCode = 3;
    err.detail = { status: r.status, stderr: firstLines(r.stderr), body: parsed };
    throw err;
  }
  const j = requireJson(r, 'repos/' + repo);
  return {
    rawBytes: Buffer.byteLength(r.stdout, 'utf8'),
    rawChars: r.stdout.length,
    fetchMs: r.ms,
    data: {
      full_name: j.full_name,
      private: j.private,
      visibility: j.visibility,
      default_branch: j.default_branch,
      language: j.language,
      sizeKb: j.size,
      pushed_at: j.pushed_at,
      updated_at: j.updated_at,
      open_issues_count: j.open_issues_count,
      html_url: j.html_url,
      permissions: j.permissions ?? null,
    },
  };
}

const PR_LIST_FIELDS = [
  'number', 'title', 'author', 'createdAt', 'updatedAt', 'headRefName', 'baseRefName',
  'isDraft', 'reviewDecision', 'additions', 'deletions', 'changedFiles', 'url',
];

const PR_VIEW_FIELDS = [
  'number', 'title', 'body', 'author', 'createdAt', 'updatedAt', 'headRefName', 'baseRefName',
  'isDraft', 'reviewDecision', 'additions', 'deletions', 'changedFiles', 'url', 'state',
  'mergeable', 'mergeStateStatus', 'files', 'comments', 'reviews', 'commits', 'labels',
  'assignees', 'reviewRequests', 'statusCheckRollup', 'headRefOid', 'baseRefOid',
];

function probeOpenPrs(repo) {
  const args = ['pr', 'list', '--repo', repo, '--state', 'open', '--limit', '100', '--json', PR_LIST_FIELDS.join(',')];
  const r = runGh(args);
  if (r.status !== 0) {
    const err = new Error(`pr list 失败（exit=${r.status}）：${firstLines(r.stderr, 3)}`);
    err.exitCode = 3;
    throw err;
  }
  const items = requireJson(r, 'pr list');
  return {
    fields: PR_LIST_FIELDS,
    count: items.length,
    rawChars: r.stdout.length,
    rawBytes: Buffer.byteLength(r.stdout, 'utf8'),
    fetchMs: r.ms,
    items: items.map(p => ({
      number: p.number,
      title: p.title,
      author: slimUser(p.author),
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      headRefName: p.headRefName,
      baseRefName: p.baseRefName,
      isDraft: p.isDraft,
      reviewDecision: p.reviewDecision,
      additions: p.additions,
      deletions: p.deletions,
      changedFiles: p.changedFiles,
      url: p.url,
    })),
  };
}

function probePrView(repo, number, maxBodyChars) {
  const args = ['pr', 'view', String(number), '--repo', repo, '--json', PR_VIEW_FIELDS.join(',')];
  const r = runGh(args);
  if (r.status !== 0) {
    const err = new Error(`pr view #${number} 失败（exit=${r.status}）：${firstLines(r.stderr, 3)}`);
    err.exitCode = 3;
    throw err;
  }
  const j = requireJson(r, `pr view #${number}`);
  const body = truncateText(j.body || '', maxBodyChars, 'pr body');
  return {
    fields: PR_VIEW_FIELDS,
    rawChars: r.stdout.length,
    rawBytes: Buffer.byteLength(r.stdout, 'utf8'),
    fetchMs: r.ms,
    bodyChars: (j.body || '').length,
    body: body.value,
    bodyTruncation: {
      truncated: body.truncated, originalChars: body.originalChars,
      keptChars: body.keptChars, droppedChars: body.droppedChars,
    },
    data: {
      number: j.number,
      title: j.title,
      body: body.value,
      bodyChars: (j.body || '').length,
      author: slimUser(j.author),
      state: j.state,
      isDraft: j.isDraft,
      reviewDecision: j.reviewDecision,
      mergeable: j.mergeable,
      mergeStateStatus: j.mergeStateStatus,
      additions: j.additions,
      deletions: j.deletions,
      changedFiles: j.changedFiles,
      baseRefName: j.baseRefName,
      headRefName: j.headRefName,
      headRefOid: j.headRefOid,
      baseRefOid: j.baseRefOid,
      createdAt: j.createdAt,
      updatedAt: j.updatedAt,
      url: j.url,
      counts: {
        files: (j.files || []).length,
        comments: (j.comments || []).length,
        reviews: (j.reviews || []).length,
        commits: (j.commits || []).length,
        labels: (j.labels || []).length,
        reviewRequests: (j.reviewRequests || []).length,
        statusCheckRollup: (j.statusCheckRollup || []).length,
      },
      // 注意：gh pr view --json files 只有 path/additions/deletions/changeType，没有 patch。
      filesShapeSample: (j.files || []).slice(0, 3).map(f => ({ path: f.path, additions: f.additions, deletions: f.deletions, changeType: f.changeType })),
      // comments 在这里是 issue 评论（PR 对话区），不是行内 review 评论。
      commentsShapeSample: (j.comments || []).slice(0, 2).map(slimComment),
      reviewsShapeSample: (j.reviews || []).slice(0, 2).map(rv => ({
        id: rv.id ?? null,
        author: rv.author?.login ?? null,
        state: rv.state ?? null,
        bodyChars: (rv.body || '').length,
        submittedAt: rv.submittedAt ?? null,
        commit: rv.commit?.oid ?? null,
      })),
      commitsShapeSample: (j.commits || []).slice(0, 2).map(c => ({
        oid: c.oid, headline: c.messageHeadline, author: c.authors?.[0]?.login ?? null, authoredDate: c.authoredDate,
      })),
      commits: j.commits || [],
      statusCheckRollup: j.statusCheckRollup || [],
    },
  };
}

function probeRestPrRaw(repo, number) {
  const r = runGh(['api', `repos/${repo}/pulls/${number}`]);
  const j = parseJson(r.stdout);
  return {
    status: r.status,
    rawBytes: Buffer.byteLength(r.stdout, 'utf8'),
    fetchMs: r.ms,
    keys: j ? Object.keys(j) : [],
    scalars: j ? {
      number: j.number, state: j.state, draft: j.draft, merged: j.merged,
      comments: j.comments, review_comments: j.review_comments, commits: j.commits,
      additions: j.additions, deletions: j.deletions, changed_files: j.changed_files,
      mergeable: j.mergeable, mergeable_state: j.mergeable_state,
      diff_url: j.diff_url, patch_url: j.patch_url,
      headSha: j.head?.sha, headRepo: j.head?.repo?.full_name,
      baseSha: j.base?.sha, baseRepo: j.base?.repo?.full_name,
    } : null,
  };
}

/** 单次 GraphQL 请求：PR 详情 + 文件列表 + reviews + issue 评论 + 行内评论线程 + checks。 */
function graphqlDetailQuery() {
  return 'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){' +
    'nameWithOwner pullRequest(number:$number){number title state isDraft mergeable mergeStateStatus reviewDecision ' +
    'additions deletions changedFiles body author{login ... on User{name}} baseRefName headRefName headRefOid baseRefOid ' +
    'createdAt updatedAt url ' +
    'commits(last:1){totalCount nodes{commit{oid messageHeadline authoredDate}}} ' +
    'files(first:100){totalCount pageInfo{hasNextPage endCursor} nodes{path additions deletions changeType}} ' +
    'reviews(first:50){totalCount nodes{id state body submittedAt author{login}}} ' +
    'comments(first:50){totalCount nodes{id body createdAt author{login}}} ' +
    'reviewThreads(first:50){totalCount pageInfo{hasNextPage endCursor} nodes{isResolved isOutdated path line startLine diffSide ' +
    'comments(first:20){totalCount nodes{id path line body diffHunk author{login} createdAt url}}}} ' +
    'statusCheckRollup{state}}}}';
}

function probeGraphqlDetail(repo, number, maxBodyChars, maxReviewCommentBody, maxDiffHunk) {
  const [owner, name] = repo.split('/');
  const q = graphqlDetailQuery();
  const r = runGh(['api', 'graphql', '-f', 'query=' + q, '-f', 'owner=' + owner, '-f', 'name=' + name, '-F', 'number=' + number]);
  if (r.status !== 0) {
    return { ok: false, rawBytes: Buffer.byteLength(r.stdout, 'utf8'), status: r.status, stderr: firstLines(r.stderr, 4) };
  }
  const j = parseJson(r.stdout);
  const pr = j?.data?.repository?.pullRequest;
  if (!pr) return { ok: false, rawBytes: Buffer.byteLength(r.stdout, 'utf8'), status: r.status, stderr: 'GraphQL 响应里没有 data.repository.pullRequest', rawPrefix: r.stdout.slice(0, 300) };
  const body = truncateText(pr.body || '', maxBodyChars, 'pr body');
  return {
    ok: true,
    rawBytes: Buffer.byteLength(r.stdout, 'utf8'),
    rawChars: r.stdout.length,
    fetchMs: r.ms,
    requestCount: 1,
    data: {
      number: pr.number,
      title: pr.title,
      state: pr.state,
      isDraft: pr.isDraft,
      mergeable: pr.mergeable,
      mergeStateStatus: pr.mergeStateStatus,
      // 注意：GraphQL 无 review 时 reviewDecision 是 JSON null（gh CLI 转成 ""）。
      reviewDecision: pr.reviewDecision,
      author: { login: pr.author?.login ?? null, name: pr.author?.name ?? null },
      additions: pr.additions,
      deletions: pr.deletions,
      changedFiles: pr.changedFiles,
      bodyChars: (pr.body || '').length,
      body: body.value,
      bodyTruncation: body,
      baseRefName: pr.baseRefName,
      headRefName: pr.headRefName,
      headRefOid: pr.headRefOid,
      baseRefOid: pr.baseRefOid,
      createdAt: pr.createdAt,
      updatedAt: pr.updatedAt,
      url: pr.url,
      counts: {
        commits: pr.commits?.totalCount ?? null,
        files: pr.files?.totalCount ?? null,
        reviews: pr.reviews?.totalCount ?? null,
        comments: pr.comments?.totalCount ?? null,
        reviewThreads: pr.reviewThreads?.totalCount ?? null,
      },
      // GraphQL 的 files 节点同样没有 patch 文本，patch 必须走 REST /pulls/{n}/files。
      filesShapeSample: (pr.files?.nodes || []).slice(0, 3),
      commitsShapeSample: (pr.commits?.nodes || []).slice(0, 2).map(n => n.commit),
      reviews: (pr.reviews?.nodes || []).map(rv => ({
        id: rv.id, author: rv.author?.login ?? null, state: rv.state,
        submittedAt: rv.submittedAt, body: truncateText(rv.body || '', maxReviewCommentBody, 'review body').value,
      })),
      comments: (pr.comments?.nodes || []).map(c => ({
        id: c.id, author: c.author?.login ?? null, createdAt: c.createdAt,
        body: truncateText(c.body || '', maxReviewCommentBody, 'issue comment body').value,
      })),
      reviewThreads: (pr.reviewThreads?.nodes || []).map(t => ({
        isResolved: t.isResolved, isOutdated: t.isOutdated, path: t.path, line: t.line,
        startLine: t.startLine, diffSide: t.diffSide,
        comments: (t.comments?.nodes || []).map(c => ({
          id: c.id, path: c.path, line: c.line, author: c.author?.login ?? null, createdAt: c.createdAt, url: c.url,
          body: truncateText(c.body || '', maxReviewCommentBody, 'review comment body').value,
          diffHunk: truncateText(c.diffHunk || '', maxDiffHunk, 'review diff hunk').value,
        })),
      })),
      statusCheckRollupState: pr.statusCheckRollup?.state ?? null,
    },
  };
}

/** GraphQL search：一次请求拿 PR 列表（含评论/审查计数），用于列表页。 */
function probeGraphqlSearchList(repo) {
  const q = 'query($q:String!,$first:Int!){search(query:$q,type:ISSUE,first:$first){issueCount ' +
    'nodes{... on PullRequest{number title state isDraft reviewDecision additions deletions changedFiles ' +
    'author{login} baseRefName headRefName createdAt updatedAt url comments{totalCount} reviews{totalCount}}}}}';
  const r = runGh(['api', 'graphql', '-f', 'query=' + q, '-f', 'q=repo:' + repo + ' is:pr is:open', '-F', 'first=100']);
  if (r.status !== 0) return { ok: false, status: r.status, stderr: firstLines(r.stderr, 4) };
  const j = parseJson(r.stdout);
  const search = j?.data?.search;
  if (!search) return { ok: false, status: r.status, rawPrefix: r.stdout.slice(0, 300) };
  return {
    ok: true,
    rawBytes: Buffer.byteLength(r.stdout, 'utf8'),
    fetchMs: r.ms,
    requestCount: 1,
    issueCount: search.issueCount,
    nodes: (search.nodes || []).map(p => ({
      number: p.number, title: p.title, state: p.state, isDraft: p.isDraft,
      reviewDecision: p.reviewDecision, additions: p.additions, deletions: p.deletions,
      changedFiles: p.changedFiles, author: p.author?.login ?? null,
      baseRefName: p.baseRefName, headRefName: p.headRefName,
      createdAt: p.createdAt, updatedAt: p.updatedAt, url: p.url,
      commentCount: p.comments?.totalCount ?? null, reviewCount: p.reviews?.totalCount ?? null,
    })),
  };
}

function probeDiff(repo, number, maxChars) {
  // 非 TTY：gh pr diff 自动关闭颜色；--color never 显式保证可解析。
  const r = runGh(['pr', 'diff', String(number), '--repo', repo, '--color', 'never']);
  if (r.status !== 0) {
    return { ok: false, status: r.status, stderr: firstLines(r.stderr, 4), rawChars: r.stdout.length };
  }
  const truncated = truncateText(r.stdout, maxChars, 'diff');
  const lines = r.stdout.split('\n');
  const fileHeaders = lines.filter(l => l.startsWith('diff --git ')).length;
  return {
    ok: true,
    status: r.status,
    fetchMs: r.ms,
    rawChars: r.stdout.length,
    rawBytes: Buffer.byteLength(r.stdout, 'utf8'),
    rawLines: lines.length,
    fileHeaders,
    sha256: createHash('sha256').update(r.stdout, 'utf8').digest('hex'),
    truncated: truncated.truncated,
    keptChars: truncated.keptChars,
    droppedChars: truncated.droppedChars,
    diff: truncated.value,
  };
}

function probeFiles(repo, number, maxPatchChars) {
  const r = runGh(['api', `repos/${repo}/pulls/${number}/files?per_page=100`, '--paginate', '--slurp']);
  if (r.status !== 0) return { ok: false, status: r.status, stderr: firstLines(r.stderr, 4) };
  const pages = parseJson(r.stdout);
  if (!Array.isArray(pages)) return { ok: false, status: r.status, rawPrefix: r.stdout.slice(0, 300) };
  const files = pages.flat();
  let totalPatchChars = 0;
  let maxObservedPatchChars = 0;
  let missingPatch = 0;
  const truncatedFiles = [];
  const items = files.map(f => {
    const patch = typeof f.patch === 'string' ? f.patch : null;
    if (patch) {
      totalPatchChars += patch.length;
      maxObservedPatchChars = Math.max(maxObservedPatchChars, patch.length);
    } else {
      missingPatch++;
    }
    const t = patch ? truncateText(patch, maxPatchChars, `patch ${f.filename}`) : null;
    if (t && t.truncated) truncatedFiles.push({ filename: f.filename, originalChars: t.originalChars, keptChars: t.keptChars, droppedChars: t.droppedChars });
    return {
      filename: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      changes: f.changes,
      sha: f.sha,
      patchChars: patch ? patch.length : 0,
      hasPatch: patch !== null,
      patchTruncated: t ? t.truncated : false,
      patch: t ? t.value : null,
      rawUrl: f.raw_url,
      blobUrl: f.blob_url,
    };
  });
  return {
    ok: true,
    status: r.status,
    pages: pages.length,
    requestCount: pages.length,
    rawChars: r.stdout.length,
    rawBytes: Buffer.byteLength(r.stdout, 'utf8'),
    fetchMs: r.ms,
    fileCount: files.length,
    totalPatchChars,
    maxObservedPatchChars,
    missingPatchCount: missingPatch,
    perFilePatchCap: maxPatchChars,
    truncatedFiles,
    items,
  };
}

function probeComments(repo, number, maxCommentChars) {
  const issueR = runGh(['api', `repos/${repo}/issues/${number}/comments?per_page=100`, '--paginate', '--slurp']);
  const reviewsR = runGh(['api', `repos/${repo}/pulls/${number}/reviews?per_page=100`, '--paginate', '--slurp']);
  const inlineR = runGh(['api', `repos/${repo}/pulls/${number}/comments?per_page=100`, '--paginate', '--slurp']);
  const flatten = (r) => {
    const pages = parseJson(r.stdout);
    if (!Array.isArray(pages)) return null;
    return pages.flat();
  };
  const issue = flatten(issueR) || [];
  const reviews = flatten(reviewsR) || [];
  const inline = flatten(inlineR) || [];
  return {
    issueComments: {
      count: issue.length,
      rawChars: issueR.stdout.length,
      requestCount: Array.isArray(parseJson(issueR.stdout)) ? parseJson(issueR.stdout).length : 0,
      shape: issue[0] ? Object.keys(issue[0]) : [],
      items: issue.slice(0, 50).map(c => ({
        ...slimComment(c),
        authorAssociation: c.author_association ?? null,
        isMinimized: c.minimized ?? null,
      })),
    },
    reviews: {
      count: reviews.length,
      rawChars: reviewsR.stdout.length,
      shape: reviews[0] ? Object.keys(reviews[0]) : [],
      items: reviews.slice(0, 50).map(rv => ({
        id: rv.id ?? null,
        author: slimUser(rv.user)?.login ?? null,
        state: rv.state ?? null,
        bodyChars: (rv.body || '').length,
        body: truncateText(rv.body || '', maxCommentChars, 'review body').value,
        submittedAt: rv.submitted_at ?? null,
        commitId: rv.commit_id ?? null,
        htmlUrl: rv.html_url ?? null,
      })),
    },
    reviewComments: {
      count: inline.length,
      rawChars: inlineR.stdout.length,
      shape: inline[0] ? Object.keys(inline[0]) : [],
      items: inline.slice(0, 50).map(c => ({
        id: c.id ?? null,
        reviewId: c.pull_request_review_id ?? null,
        author: slimUser(c.user)?.login ?? null,
        path: c.path ?? null,
        line: c.line ?? null,
        originalLine: c.original_line ?? null,
        side: c.side ?? null,
        startLine: c.start_line ?? null,
        subjectType: c.subject_type ?? null,
        inReplyToId: c.in_reply_to_id ?? null,
        createdAt: c.created_at ?? null,
        htmlUrl: c.html_url ?? null,
        diffHunkChars: (c.diff_hunk || '').length,
        diffHunk: truncateText(c.diff_hunk || '', 2000, 'diff hunk').value,
        body: truncateText(c.body || '', maxCommentChars, 'review comment body').value,
      })),
    },
  };
}

function probeCommentSamples(repo, samplePr, maxCommentChars) {
  if (!samplePr) return null;
  const flat = (r) => {
    const pages = parseJson(r.stdout);
    return Array.isArray(pages) ? pages.flat() : null;
  };
  const reviewsR = runGh(['api', `repos/${repo}/pulls/${samplePr}/reviews?per_page=100`, '--paginate', '--slurp']);
  const inlineR = runGh(['api', `repos/${repo}/pulls/${samplePr}/comments?per_page=100`, '--paginate', '--slurp']);
  const issueR = runGh(['api', `repos/${repo}/issues/${samplePr}/comments?per_page=100`, '--paginate', '--slurp']);
  const reviews = flat(reviewsR) || [];
  const inline = flat(inlineR) || [];
  const issue = flat(issueR) || [];
  return {
    pr: samplePr,
    note: '取一个「已有 review / 行内评论」的 PR，记录非空时的真实 REST 字段名（插件展示历史审查用）。',
    reviews: {
      count: reviews.length,
      rawChars: reviewsR.stdout.length,
      // REST 原始字段名，已验证
      rawKeys: reviews[0] ? Object.keys(reviews[0]) : [],
      items: reviews.slice(0, 20).map(rv => ({
        id: rv.id ?? null,
        author: slimUser(rv.user)?.login ?? null,
        authorAssociation: rv.author_association ?? null,
        state: rv.state ?? null,
        bodyChars: (rv.body || '').length,
        body: truncateText(rv.body || '', maxCommentChars, 'review body').value,
        submittedAt: rv.submitted_at ?? null,
        commitId: rv.commit_id ?? null,
        htmlUrl: rv.html_url ?? null,
      })),
    },
    reviewComments: {
      count: inline.length,
      rawChars: inlineR.stdout.length,
      rawKeys: inline[0] ? Object.keys(inline[0]) : [],
      items: inline.slice(0, 20).map(c => ({
        id: c.id ?? null,
        reviewId: c.pull_request_review_id ?? null,
        author: slimUser(c.user)?.login ?? null,
        path: c.path ?? null,
        line: c.line ?? null,
        originalLine: c.original_line ?? null,
        startLine: c.start_line ?? null,
        side: c.side ?? null,
        subjectType: c.subject_type ?? null,
        inReplyToId: c.in_reply_to_id ?? null,
        bodyChars: (c.body || '').length,
        body: truncateText(c.body || '', maxCommentChars, 'review comment body').value,
        diffHunkChars: (c.diff_hunk || '').length,
        diffHunk: truncateText(c.diff_hunk || '', 2000, 'review diff hunk').value,
        createdAt: c.created_at ?? null,
        htmlUrl: c.html_url ?? null,
      })),
    },
    issueComments: {
      count: issue.length,
      rawChars: issueR.stdout.length,
      items: issue.slice(0, 20).map(slimComment),
    },
  };
}

function probeChecks(repo, number, headRefOid) {
  const out = { ghPrChecks: null, restCheckRuns: null, restCombinedStatus: null };
  // 无 CI 时 gh pr checks 退出码为 1，stderr="no checks reported on the '...' branch"，stdout 为空。
  const r = runGh(['pr', 'checks', String(number), '--repo', repo, '--json', 'name,state,bucket,link,event,workflow']);
  const items = r.status === 0 ? parseJson(r.stdout) : null;
  const noChecks = /no checks reported/i.test(r.stderr || '');
  out.ghPrChecks = {
    exitCode: r.status,
    stdoutChars: r.stdout.length,
    stderr: firstLines(r.stderr, 3),
    noChecks,
    // 退出码 1 且 stderr 命中 no checks → 语义是「没有检查」，不是失败。
    normalized: noChecks ? { state: 'NONE', items: [] } : (items ?? { parseError: r.stdout.slice(0, 200) }),
    items: Array.isArray(items) ? items : [],
    fetchMs: r.ms,
  };
  if (headRefOid) {
    const cr = runGh(['api', `repos/${repo}/commits/${headRefOid}/check-runs`]);
    const cj = parseJson(cr.stdout);
    out.restCheckRuns = cr.status === 0 && cj ? {
      totalCount: cj.total_count,
      checkRuns: (cj.check_runs || []).map(x => ({ name: x.name, status: x.status, conclusion: x.conclusion, startedAt: x.started_at })),
    } : { error: firstLines(cr.stderr, 3), status: cr.status };
    const st = runGh(['api', `repos/${repo}/commits/${headRefOid}/status`]);
    const sj = parseJson(st.stdout);
    out.restCombinedStatus = st.status === 0 && sj ? {
      state: sj.state, totalCount: sj.total_count,
      // 没有 status 时 state 仍是 "pending"（容易误判），以 totalCount=0 判断「无检查」。
      statuses: (sj.statuses || []).map(x => ({ context: x.context, state: x.state })),
    } : { error: firstLines(st.stderr, 3), status: st.status };
  }
  return out;
}

const BODY_REF_RE = /(?:#|\/pull\/)(\d+)/g;
const DECLARED_BASE_RE = /base\s*(?:为|是|:)\s*`([^`]+)`/i;

function probeStack(repo, number, prData) {
  const [owner] = repo.split('/');
  const bodyText = prData?.body ?? '';
  const refs = [...new Set((bodyText.match(BODY_REF_RE) || []).map(s => Number(String(s).replace(/[^0-9]/g, ''))))];
  const declaredBase = (bodyText.match(DECLARED_BASE_RE) || [])[1] ?? null;
  const baseRefName = prData?.baseRefName ?? null;
  const result = { baseRefName, declaredBaseFromBody: declaredBase, referencedPrs: refs.slice(0, 20), basePr: null, inferredChain: [], allBaseMerged: null };
  if (!baseRefName) return result;
  const r = runGh(['api', `repos/${repo}/pulls?head=${encodeURIComponent(owner + ':' + baseRefName)}&state=all&per_page=100`]);
  if (r.status !== 0) { result.error = firstLines(r.stderr, 3); return result; }
  const list = parseJson(r.stdout) || [];
  const match = list.find(p => p.head?.ref === baseRefName);
  if (match) {
    result.basePr = {
      number: match.number, title: match.title, state: match.state,
      merged: Boolean(match.merged_at), mergedAt: match.merged_at,
      base: match.base?.ref, head: match.head?.ref, additions: match.additions,
      deletions: match.deletions, changedFiles: match.changed_files, url: match.html_url,
    };
    result.inferredChain = [{ pr: match.number, ref: baseRefName, merged: Boolean(match.merged_at) }, { pr: number, ref: prData?.headRefName ?? null, merged: false }];
    result.allBaseMerged = Boolean(match.merged_at);
  } else {
    result.basePr = null;
    result.note = `没有找到 head=${baseRefName} 的 PR（base 分支可能是 main 或未开 PR）`;
  }
  return result;
}

function probeRateLimit() {
  const r = runGh(['api', 'rate_limit']);
  const j = parseJson(r.stdout);
  if (!j) return { ok: false, status: r.status, stderr: firstLines(r.stderr, 3) };
  return {
    ok: true,
    core: j.resources?.core ?? null,
    graphql: j.resources?.graphql ?? null,
    search: j.resources?.search ?? null,
    integrationManifest: j.resources?.integration_manifest ?? null,
    measuredAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// B 方案：gh auth token + Node fetch 直连 REST（不依赖 undici 包，Node 18+ 全局 fetch 即可）
// ---------------------------------------------------------------------------
async function fetchWithAccept(url, token, accept) {
  const started = Date.now();
  const res = await fetch(url, {
    headers: {
      Authorization: `token ${token}`,
      Accept: accept,
      'User-Agent': 'dsh-codex-review-probe',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(60000),
  });
  const body = await res.text();
  return {
    status: res.status,
    ms: Date.now() - started,
    bytes: Buffer.byteLength(body, 'utf8'),
    chars: body.length,
    ratelimitRemaining: res.headers.get('x-ratelimit-remaining'),
    ratelimitLimit: res.headers.get('x-ratelimit-limit'),
    body,
  };
}

async function probeTokenMode(repo, number, cliDiffSha256) {
  const t = runGh(['auth', 'token']);
  if (t.status !== 0) return { ok: false, error: 'gh auth token 失败：' + firstLines(t.stderr, 3) };
  const token = t.stdout.trim();
  if (!token) return { ok: false, error: 'gh auth token 返回空' };
  const tokenSource = process.env.GH_TOKEN ? 'env GH_TOKEN' : process.env.GITHUB_TOKEN ? 'env GITHUB_TOKEN' : 'gh auth token';
  const out = { ok: true, tokenSource, tokenLen: token.length, tokenPrefix: token.slice(0, 4), token: '[REDACTED]' };
  try {
    const pr = await fetchWithAccept(`https://api.github.com/repos/${repo}/pulls/${number}`, token, 'application/vnd.github+json');
    out.prDetail = {
      status: pr.status, bytes: pr.bytes, ms: pr.ms,
      ratelimitRemaining: pr.ratelimitRemaining, ratelimitLimit: pr.ratelimitLimit,
      parsedTitle: (() => { const j = parseJson(pr.body); return j ? j.title : null; })(),
    };
    const diff = await fetchWithAccept(`https://api.github.com/repos/${repo}/pulls/${number}`, token, 'application/vnd.github.diff');
    const diffSha = createHash('sha256').update(diff.body, 'utf8').digest('hex');
    out.diff = {
      status: diff.status, chars: diff.chars, bytes: diff.bytes, ms: diff.ms,
      sha256: diffSha,
      equalsCliDiff: cliDiffSha256 ? diffSha === cliDiffSha256 : null,
      ratelimitRemaining: diff.ratelimitRemaining,
    };
    const files = await fetchWithAccept(`https://api.github.com/repos/${repo}/pulls/${number}/files?per_page=100`, token, 'application/vnd.github+json');
    out.filesPage1 = { status: files.status, bytes: files.bytes, ms: files.ms, count: (parseJson(files.body) || []).length };
    const rate = await fetchWithAccept('https://api.github.com/rate_limit', token, 'application/vnd.github+json');
    const rj = parseJson(rate.body);
    out.rateLimit = rj ? { core: rj.resources?.core ?? null, graphql: rj.resources?.graphql ?? null } : null;
  } catch (e) {
    out.error = String(e && e.message ? e.message : e);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 错误场景：用真实命令拿到 GitHub/gh 的失败形状（不依赖文档猜测）
// ---------------------------------------------------------------------------
function probeErrors(repo) {
  const out = {};
  // 1) 不存在的仓库 → REST 404
  const nfRepo = runGh(['api', `repos/Acefake/no-such-repo-${Date.now()}`]);
  out.nonexistentRepo = {
    exitCode: nfRepo.status,
    stderr: firstLines(nfRepo.stderr, 3),
    body: parseJson(nfRepo.stdout),
    stdoutChars: nfRepo.stdout.length,
  };
  // 2) 不存在的 PR → GraphQL 报错（stderr，stdout 为空）
  const nfPr = runGh(['pr', 'view', '999999', '--repo', repo]);
  out.nonexistentPr = { exitCode: nfPr.status, stderr: firstLines(nfPr.stderr, 3), stdoutChars: nfPr.stdout.length };
  // 3) 无效 token → 401 Bad credentials
  const badEnv = { ...process.env, GH_TOKEN: 'ghp_probe_invalid_token_000000000000000000000', GITHUB_TOKEN: '' };
  const bad = runGh(['api', 'user'], { env: badEnv });
  out.badCredentials = { exitCode: bad.status, stderr: firstLines(bad.stderr, 3), body: parseJson(bad.stdout) };
  // 4) 未登录（空 GH_CONFIG_DIR）→ auth 层错误，退出码 4
  const tmpCfg = join(SCRIPT_DIR, '.tmp-gh-config-noauth');
  const noAuthEnv = { ...process.env, GH_CONFIG_DIR: tmpCfg };
  delete noAuthEnv.GH_TOKEN;
  delete noAuthEnv.GITHUB_TOKEN;
  mkdirSync(tmpCfg, { recursive: true });
  try {
    const st = runGh(['auth', 'status'], { env: noAuthEnv });
    const list = runGh(['pr', 'list', '--repo', repo], { env: noAuthEnv });
    out.noAuth = {
      authStatus: { exitCode: st.status, stderr: firstLines(st.stderr, 3) },
      prList: { exitCode: list.status, stderr: firstLines(list.stderr, 4) },
    };
  } finally {
    rmSync(tmpCfg, { recursive: true, force: true });
  }
  // 5) 权限不足：用不存在的私有仓库近似 404；真正的 403 需另一账号 token，这里记录判断依据
  out.permissionHint = '私有仓库无权限与不存在都返回 404（不泄露存在性）；403 仅出现在 rate limit 或 token scope 不足（如 read:org）。';
  return out;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const startedAt = new Date();
  const t0 = Date.now();
  const log = (...a) => { if (!opts.quiet) console.log(...a); };

  log(`[gh-probe] repo=${opts.repo} pr=#${opts.pr} mode=${opts.mode} gh=${ghBinInfo.version}`);
  log(`[gh-probe] gh path: ${ghBinInfo.bin}`);

  const rateBefore = probeRateLimit();
  log(`[gh-probe] rate limit before: core=${rateBefore.core?.remaining}/${rateBefore.core?.limit}`);

  const repoProbe = probeRepo(opts.repo);
  log(`[gh-probe] repo: ${repoProbe.data.full_name} private=${repoProbe.data.private} default=${repoProbe.data.default_branch} raw=${repoProbe.rawChars} chars`);

  const openPrs = probeOpenPrs(opts.repo);
  openPrs.possiblyTruncated = openPrs.count >= 100;
  log(`[gh-probe] open PRs: ${openPrs.count} (json ${openPrs.rawChars} chars)`);

  const prView = probePrView(opts.repo, opts.pr, opts.maxBodyChars);
  log(`[gh-probe] PR #${opts.pr}: ${prView.rawChars} chars, body=${prView.bodyChars}, files=${prView.data.counts.files}, reviews=${prView.data.counts.reviews}, comments=${prView.data.counts.comments}`);

  const restPr = probeRestPrRaw(opts.repo, opts.pr);
  log(`[gh-probe] REST pull: ${restPr.rawBytes} bytes, ${restPr.keys.length} keys`);

  const diff = probeDiff(opts.repo, opts.pr, opts.maxDiffChars);
  if (diff.ok) {
    log(`[gh-probe] diff: ${diff.rawChars} chars / ${diff.rawLines} lines / ${diff.fileHeaders} files; kept=${diff.keptChars}, truncated=${diff.truncated}`);
  } else {
    log(`[gh-probe] diff FAILED: ${diff.stderr}`);
  }

  const files = probeFiles(opts.repo, opts.pr, opts.maxPatchChars);
  if (files.ok) {
    log(`[gh-probe] files: ${files.fileCount} files, patch=${files.totalPatchChars} chars, maxPatch=${files.maxObservedPatchChars}, missingPatch=${files.missingPatchCount}, truncated=${files.truncatedFiles.length}`);
  } else {
    log(`[gh-probe] files FAILED: ${files.stderr}`);
  }

  const comments = probeComments(opts.repo, opts.pr, opts.maxReviewCommentBody);
  log(`[gh-probe] comments: issue=${comments.issueComments.count}, reviews=${comments.reviews.count}, inline=${comments.reviewComments.count}`);

  const commentSamples = probeCommentSamples(opts.repo, opts.reviewSamplePr, opts.maxReviewCommentBody);
  if (commentSamples) {
    log(`[gh-probe] comment samples #${opts.reviewSamplePr}: reviews=${commentSamples.reviews.count}, inline=${commentSamples.reviewComments.count}, issue=${commentSamples.issueComments.count}`);
  }

  const checks = probeChecks(opts.repo, opts.pr, prView.data.headRefOid);
  log(`[gh-probe] checks: gh_pr_checks exit=${checks.ghPrChecks.exitCode} noChecks=${checks.ghPrChecks.noChecks}; check_runs=${checks.restCheckRuns?.totalCount ?? 'n/a'}; combined_state=${checks.restCombinedStatus?.state ?? 'n/a'}`);

  const stack = probeStack(opts.repo, opts.pr, prView.data);
  log(`[gh-probe] stack: base=${stack.baseRefName} basePR=${stack.basePr ? '#' + stack.basePr.number : 'none'} refs=${JSON.stringify(stack.referencedPrs)}`);

  let graphql = null;
  if (!opts.skipGraphql) {
    graphql = {
      detail: probeGraphqlDetail(opts.repo, opts.pr, opts.maxBodyChars, opts.maxReviewCommentBody, opts.maxDiffHunk),
      searchList: probeGraphqlSearchList(opts.repo),
    };
    log(`[gh-probe] graphql detail: ok=${graphql.detail.ok} ${graphql.detail.rawBytes ?? '?'} bytes; searchList: ok=${graphql.searchList.ok} count=${graphql.searchList.issueCount ?? '?'} ${graphql.searchList.rawBytes ?? '?'} bytes`);
    if (opts.reviewSamplePr > 0 && opts.reviewSamplePr !== opts.pr) {
      graphql.reviewSample = probeGraphqlDetail(opts.repo, opts.reviewSamplePr, opts.maxBodyChars, opts.maxReviewCommentBody, opts.maxDiffHunk);
      const d = graphql.reviewSample.data;
      log(`[gh-probe] graphql review sample #${opts.reviewSamplePr}: threads=${d?.counts?.reviewThreads ?? '?'} reviews=${d?.counts?.reviews ?? '?'} bytes=${graphql.reviewSample.rawBytes}`);
    }
  }

  let tokenMode = null;
  if (opts.mode === 'token' || opts.mode === 'both') {
    tokenMode = await probeTokenMode(opts.repo, opts.pr, diff.ok ? diff.sha256 : null);
    log(`[gh-probe] token mode: ok=${tokenMode.ok} prDetailStatus=${tokenMode.prDetail?.status ?? 'n/a'} diffEqualsCli=${tokenMode.diff?.equalsCliDiff ?? 'n/a'} diffChars=${tokenMode.diff?.chars ?? 'n/a'}`);
  }

  let errors = null;
  if (!opts.skipErrors) {
    errors = probeErrors(opts.repo);
    log(`[gh-probe] errors: 404=${errors.nonexistentRepo.exitCode} pr404=${errors.nonexistentPr.exitCode} badToken=${errors.badCredentials.exitCode} noAuth(prList)=${errors.noAuth.prList.exitCode}`);
  }

  const rateAfter = probeRateLimit();
  const consumed = {
    core: (rateAfter.core?.used ?? 0) - (rateBefore.core?.used ?? 0),
    graphql: (rateAfter.graphql?.used ?? 0) - (rateBefore.graphql?.used ?? 0),
    search: (rateAfter.search?.used ?? 0) - (rateBefore.search?.used ?? 0),
    note: `整轮探针 ${commandLog.length} 条 gh 命令的限流消耗（core + graphql 分池）。gh 子进程每条命令约 0.7–2.2s 进程开销，UI 应合并请求 + 缓存。`,
  };
  const elapsedMs = Date.now() - t0;

  // 编码校验：中文 title/body 必须原样往返
  const titleOk = typeof prView.data.title === 'string' && prView.data.title.includes('自动检测片头片尾');
  const replacementCount = (prView.data.title + (prView.data.body || '')).split('\uFFFD').length - 1;

  const output = {
    meta: {
      generator: 'gh-probe.mjs',
      purpose: '代码审查插件宿主侧 GitHub PR 数据获取探针（只读）',
      generatedAt: new Date().toISOString(),
      startedAt: startedAt.toISOString(),
      elapsedMs,
      platform: process.platform,
      osRelease: process.getSystemVersion?.() ?? null,
      node: process.version,
      nodeArch: process.arch,
      cwd: process.cwd(),
      gh: { path: ghBinInfo.bin, version: ghBinInfo.version },
      options: {
        repo: opts.repo, pr: opts.pr, mode: opts.mode, reviewSamplePr: opts.reviewSamplePr,
        maxDiffChars: opts.maxDiffChars, maxPatchChars: opts.maxPatchChars, maxBodyChars: opts.maxBodyChars,
      },
      encoding: {
        strategy: 'spawnSync 返回 Buffer，显式 .toString("utf8") 解码；Windows 控制台代码页不影响结果',
        utf8RoundTripOk: titleOk && replacementCount === 0,
        replacementChars: replacementCount,
        titleBytes: Buffer.byteLength(prView.data.title || '', 'utf8'),
        titleChars: (prView.data.title || '').length,
        note: 'PowerShell Out-String 会把 native stdout 的 LF 改写成 CRLF（#129 diff: 75069→77536 chars），Node 子进程按字节读则与 API 完全一致。',
      },
      commandCount: commandLog.length,
      commands: commandLog,
    },
    repo: repoProbe,
    openPrs,
    pr: {
      number: prView.data.number,
      title: prView.data.title,
      rawChars: prView.rawChars,
      bodyChars: prView.bodyChars,
      body: prView.data.body,
      bodyTruncation: prView.bodyTruncation,
      data: prView.data,
      restPullRaw: restPr,
    },
    diff,
    files,
    comments: { ...comments, samples: commentSamples },
    checks,
    stack,
    graphql,
    tokenMode,
    errors,
    rateLimit: { before: rateBefore, after: rateAfter, consumed },
    truncationPolicy: {
      diff: `gh pr diff / Accept:application/vnd.github.diff 全文截断到 maxDiffChars=${opts.maxDiffChars}，尾部加 marker；原始字符数记录在 rawChars。`,
      perFilePatch: `REST /pulls/{n}/files 的每个 patch 截断到 ${opts.maxPatchChars} 字符；只对超限文件记录 truncatedFiles。`,
      prBody: `PR body 截断到 ${opts.maxBodyChars} 字符。`,
      reviewCommentBody: `review / issue 评论 body 截断到 ${opts.maxReviewCommentBody} 字符，review 的 diffHunk 截断到 2000 字符。`,
      machineReadable: '所有截断都带 originalChars/keptChars/droppedChars；UI 应显示「已截断，查看 GitHub」而不是假装完整。',
    },
  };

  mkdirSync(dirname(opts.out), { recursive: true });
  writeFileSync(opts.out, JSON.stringify(output, null, 2), 'utf8');
  const size = statSync(opts.out).size;
  log(`[gh-probe] wrote ${opts.out} (${(size / 1024).toFixed(1)} KiB, commands=${commandLog.length}, elapsed=${(elapsedMs / 1000).toFixed(1)}s)`);
  if (output.meta.encoding.utf8RoundTripOk !== true) log('[gh-probe] WARNING: UTF-8 往返校验失败');
  return 0;
}

main().then(code => process.exit(code)).catch(err => {
  const code = err.exitCode || 2;
  console.error(`[gh-probe] ERROR: ${err.message}`);
  if (err.detail) console.error(JSON.stringify(err.detail));
  process.exit(code);
});
