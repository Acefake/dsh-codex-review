/** Exercise the installable artifacts, not only the source manifests. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
for (const entry of ['.', 'plugin']) {
  test(`npm artifact from ${entry} declares a resolvable DSH bundle and client`, t => {
    const temporary = mkdtempSync(join(tmpdir(), 'dsh-package-'))
    t.after(() => rmSync(temporary, { recursive: true, force: true }))
    const packed = JSON.parse(execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', [
      'pack', '--ignore-scripts', '--json', '--pack-destination', temporary,
    ], { cwd: resolve(root, entry), encoding: 'utf8', shell: process.platform === 'win32' }))[0]
    assert.equal(packed.name, 'dsh-codex-review')
    assert.ok(!packed.files.some(({ path }) => /(^|\/)(test|dev|node_modules|verify|tools)(\/|$)/.test(path)))
    execFileSync('tar', ['-xzf', join(temporary, packed.filename), '-C', temporary])
    const directory = join(temporary, 'package')
    const pkg = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
    assert.equal(typeof pkg.dsh?.bundle?.patch, 'string', 'plugin manager requires dsh.bundle.patch')
    assert.equal(pkg.dsh.client.platform, 'web')
    const patchPath = resolve(directory, pkg.dsh.bundle.patch)
    const patch = readFileSync(patchPath, 'utf8')
    assert.match(patch, /- insert:/)
    assert.match(patch, /id: dsh-codex-review\s+name: dsh-codex-review/)
    const profile = join(temporary, 'profile')
    mkdirSync(join(profile, 'node_modules'), { recursive: true })
    writeFileSync(join(profile, 'package.json'), '{}')
    symlinkSync(directory, join(profile, 'node_modules', pkg.name), process.platform === 'win32' ? 'junction' : 'dir')
    const require = createRequire(join(profile, 'package.json'))
    for (const specifier of [pkg.name, `${pkg.name}/client`, `${pkg.name}/icon`, `${pkg.name}/locale/zh.json`]) {
      assert.ok(existsSync(require.resolve(specifier)), `installed export ${specifier} must resolve`)
    }
    assert.equal(dirname(require.resolve(`${pkg.name}/package.json`)), directory)
    assert.match(readFileSync(require.resolve(`${pkg.name}/client`), 'utf8'), /window\.__ModuleLoader__\.load/)
    assert.equal(pkg.version, JSON.parse(readFileSync(join(root, 'plugin/package.json'), 'utf8')).version)
  })
}
