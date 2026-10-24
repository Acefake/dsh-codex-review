/**
 * Unit tests for Config resolution and the Standard-Schema export the Loader
 * validates the profile patch against.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { CONFIG_FIELDS, Config, DEFAULT_CONFIG, configSchemaKind, resolveConfig } from '../lib/config.js'

test('resolveConfig applies every default and ignores an empty config', () => {
  assert.deepEqual(resolveConfig(undefined), { ...DEFAULT_CONFIG })
  assert.deepEqual(resolveConfig(null), { ...DEFAULT_CONFIG })
  assert.deepEqual(resolveConfig({}), { ...DEFAULT_CONFIG })
  assert.deepEqual(Object.keys(resolveConfig({})), [...CONFIG_FIELDS])
})

test('resolveConfig merges overrides, clamps numbers and trims strings', () => {
  const resolved = resolveConfig({
    defaultQuery: '  is:open label:bug ',
    limit: 999,
    maxPatchChars: 10,
    maxBodyChars: 2000,
    reviewChunkChars: '12000',
    maxChunks: 0,
    maxOutputTokens: 1024,
    provider: ' opencode-go ',
    model: 'deepseek-v4.1-flash',
    maxJobs: 3,
    requestTimeoutMs: 10,
    ghPath: '  ',
    unknownKey: true,
  })
  assert.equal(resolved.defaultQuery, 'is:open label:bug')
  assert.equal(resolved.limit, 100)
  assert.equal(resolved.maxPatchChars, 1000)
  assert.equal(resolved.maxBodyChars, 2000)
  assert.equal(resolved.reviewChunkChars, 12000)
  assert.equal(resolved.maxChunks, 1)
  assert.equal(resolved.maxOutputTokens, 1024)
  assert.equal(resolved.provider, 'opencode-go')
  assert.equal(resolved.model, 'deepseek-v4.1-flash')
  assert.equal(resolved.maxJobs, 3)
  assert.equal(resolved.requestTimeoutMs, 1000)
  assert.equal(resolved.ghPath, 'gh')
  assert.equal(resolved.unknownKey, undefined)
})

test('Config is a Standard Schema the Cordis Loader can validate', () => {
  assert.ok(configSchemaKind === 'schemastery' || configSchemaKind === 'standard')
  assert.equal(typeof Config['~standard'].validate, 'function')
  assert.equal(typeof Config['~standard'].version, 'number')
  assert.equal(typeof Config['~standard'].vendor, 'string')
  const defaults = Config['~standard'].validate({})
  assert.equal(defaults.issues, undefined)
  assert.deepEqual({ ...defaults.value }, { ...DEFAULT_CONFIG })
  const overridden = Config['~standard'].validate({ limit: 12, provider: 'p', model: 'm' })
  assert.equal(overridden.issues, undefined)
  assert.equal(overridden.value.limit, 12)
  assert.equal(overridden.value.provider, 'p')
  assert.equal(overridden.value.model, 'm')
})
