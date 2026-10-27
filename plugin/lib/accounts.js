/**
 * Account store for the multi-account workbench.
 *
 * Accounts (type + label + base URL + username) live in the profile's
 * `.codex-review/accounts.json`; each account's token lives in
 * `~/.dsh/secrets/codex-review-<id>.token` so it never appears in config
 * snapshots or the store file.
 * @module dsh-codex-review/lib/accounts
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { AppError } from './errors.js'
import { normalizeGitlabBaseUrl } from './config.js'

/** Account types the store accepts. */
export const ACCOUNT_TYPES = Object.freeze(['github', 'gitlab'])

/** Resolve the profile directory the running Host was mounted for. */
function profileDirectory() {
  const configured = process.env.DSH_PROFILE_DIR
  if (typeof configured === 'string' && configured !== '') return configured
  const home = process.env.DSH_HOME
  const profile = process.env.DSH_PROFILE
  if (typeof home === 'string' && home !== '' && typeof profile === 'string' && profile !== '') {
    return join(home, 'profiles', profile)
  }
  return join(homedir(), '.dsh', 'profiles', 'desktop')
}

/** Resolve the DSH home directory. */
function dshHome() {
  const home = process.env.DSH_HOME
  if (typeof home === 'string' && home !== '') return home
  return join(homedir(), '.dsh')
}

/** `accounts.json` path for the running profile. */
export function accountsFilePath() {
  return join(profileDirectory(), '.codex-review', 'accounts.json')
}

/** Token file path for one account id. */
export function accountTokenPath(id) {
  const safe = String(id ?? '').replace(/[^a-zA-Z0-9_-]/g, '')
  return join(dshHome(), 'secrets', `codex-review-${safe}.token`)
}

/** Read one account's token ('' when the file is missing). */
export function readAccountToken(id) {
  try {
    return readFileSync(accountTokenPath(id), 'utf8').trim()
  } catch {
    return ''
  }
}

/** Persist one account's token with owner-only intent (best effort). */
export function writeAccountToken(id, token) {
  const file = accountTokenPath(id)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, String(token), { encoding: 'utf8', mode: 0o600 })
}

/** Remove one account's token file. */
export function removeAccountToken(id) {
  try {
    rmSync(accountTokenPath(id), { force: true })
  } catch {
    /* a missing token file is already the desired state */
  }
}

/** Trim a string field, defaulting to ''. */
function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/** Slugify an account label into an id-safe fragment. */
function slug(value) {
  const base = String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return base === '' ? 'account' : base.slice(0, 32)
}

/** Build a unique account id from its type and label. */
export function makeAccountId(type, label, existing = []) {
  const base = `${type}-${slug(label)}`
  let candidate = base
  let index = 2
  while (existing.some((account) => account.id === candidate)) {
    candidate = `${base}-${index}`
    index += 1
  }
  return candidate
}

/**
 * Validate one account input from the settings form.
 * @param {Record<string, unknown>} input - raw form payload.
 * @returns {{ type: 'github' | 'gitlab', label: string, baseUrl: string, username: string, token: string }} normalized account.
 * @throws {AppError} BAD_REQUEST for an unsupported type or missing GitLab fields.
 */
export function normalizeAccountInput(input) {
  const source = input !== null && typeof input === 'object' ? input : {}
  const type = ACCOUNT_TYPES.includes(source.type) ? source.type : ''
  if (type === '') throw new AppError('BAD_REQUEST', '账号类型必须是 github 或 gitlab')
  const label = text(source.label) || (type === 'github' ? 'GitHub' : 'GitLab')
  const username = text(source.username)
  const token = text(source.token)
  if (type === 'gitlab') {
    const baseUrl = normalizeGitlabBaseUrl(source.baseUrl)
    if (baseUrl === '') throw new AppError('BAD_REQUEST', 'GitLab 账号需要 http/https 地址')
    if (token === '') throw new AppError('BAD_REQUEST', 'GitLab 账号需要 Token')
    return { type, label, baseUrl, username, token }
  }
  return { type, label, baseUrl: '', username, token }
}

/**
 * Load the account store. A missing or malformed file degrades to an empty
 * store (legacy config is then used as the fallback account list).
 * @returns {{ accounts: Array<{ id: string, type: 'github' | 'gitlab', label: string, baseUrl: string, username: string }>, defaultAccount: string }} store.
 */
export function loadAccountStore() {
  const file = accountsFilePath()
  if (!existsSync(file)) return { accounts: [], defaultAccount: '' }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const accounts = Array.isArray(parsed?.accounts)
      ? parsed.accounts
        .filter((account) => account && ACCOUNT_TYPES.includes(account.type) && typeof account.id === 'string' && account.id !== '')
        .map((account) => ({
          id: account.id,
          type: account.type,
          label: text(account.label) || (account.type === 'github' ? 'GitHub' : 'GitLab'),
          baseUrl: account.type === 'gitlab' ? normalizeGitlabBaseUrl(account.baseUrl) : '',
          username: text(account.username),
        }))
      : []
    const defaultAccount = typeof parsed?.defaultAccount === 'string' ? parsed.defaultAccount : ''
    return { accounts, defaultAccount }
  } catch {
    return { accounts: [], defaultAccount: '' }
  }
}

/**
 * Persist the account store atomically.
 * @param {{ accounts: Array<any>, defaultAccount: string }} store - store to write.
 * @returns {void}
 */
export function saveAccountStore(store) {
  const file = accountsFilePath()
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.tmp`
  writeFileSync(temporary, JSON.stringify(store, null, 2), { encoding: 'utf8', mode: 0o600 })
  renameSync(temporary, file)
}

/**
 * Build the fallback account list from legacy config: GitHub via gh CLI plus,
 * when configured, one GitLab account.
 * @param {any} config - resolved config.
 * @returns {Array<{ id: string, type: 'github' | 'gitlab', label: string, baseUrl: string, username: string }>} legacy accounts.
 */
export function legacyAccounts(config) {
  const accounts = [{ id: 'github', type: 'github', label: 'GitHub', baseUrl: '', username: '' }]
  if (text(config?.gitlabBaseUrl) !== '' && text(config?.gitlabToken) !== '') {
    accounts.push({
      id: 'gitlab',
      type: 'gitlab',
      label: 'GitLab',
      baseUrl: normalizeGitlabBaseUrl(config.gitlabBaseUrl),
      username: text(config.viewerLogin),
    })
  }
  return accounts
}
