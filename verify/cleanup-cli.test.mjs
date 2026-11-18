import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { registrationLocation, registrationSecret } from '../src/codex-registration.js'

const exec = promisify(execFile)
const root = resolve(import.meta.dirname, '..')
function isolated(t) {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'bridge cleanup cli ')))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
const invoke = (dir, args = []) => exec(process.execPath, ['scripts/cleanup.mjs', '--directory', join(dir, 'bridge'), ...args], { cwd: root, env: { ...process.env, HOME: dir, USERPROFILE: dir, CODEX_HOME: join(dir, 'codex'), PEERBRIDGE_HOME: join(dir, 'bridge') }, timeout: 10000 })

test('cleanup CLI inspects an unused home without creating state and requires explicit profile for mutations', async t => {
  const dir = isolated(t)
  assert.deepEqual(JSON.parse((await invoke(dir)).stdout), { apply: false, results: [] })
  assert.equal(existsSync(join(dir, 'bridge')), false)
  await assert.rejects(invoke(dir, ['--apply']), error => /requires --profile-dir/.test(error.stderr))
  await assert.rejects(invoke(dir, ['--unknown']), error => /Unknown or incomplete/.test(error.stderr))
  assert.equal(existsSync(join(dir, 'bridge')), false)
})

test('cleanup CLI never prints credentials and refuses to clear an active profile', async t => {
  const dir = isolated(t)
  const options = { directory: join(dir, 'bridge'), codexHome: join(dir, 'codex'), serverName: 'peerbridge' }
  const token = await registrationSecret(options)
  const location = registrationLocation(options)
  const profileDir = join(dir, 'desktop')
  const record = JSON.parse(readFileSync(location.path))
  writeFileSync(location.path, JSON.stringify({ ...record, profileDir, active: true, pid: process.pid, ownerId: 'test-active-owner' }))
  const result = await invoke(dir)
  assert.equal(JSON.parse(result.stdout).results[0].status, 'active')
  assert.equal(result.stdout.includes(token), false)
  await assert.rejects(invoke(dir, ['--apply', '--profile-dir', profileDir]), error => error.code === 2 && JSON.parse(error.stdout).results[0].status === 'active' && !error.stdout.includes(token))
  assert.equal(existsSync(location.path), true)
  if (process.platform !== 'win32') {
    const alias = join(dir, 'alias')
    symlinkSync(dir, alias, 'dir')
    const viaAlias = await invoke(dir, ['--profile-dir', join(alias, 'desktop')])
    assert.equal(JSON.parse(viaAlias.stdout).results[0].status, 'active')
  }
})

test('cleanup CLI can inspect an older record without stored home using an explicit home', async t => {
  const dir = isolated(t)
  const options = { directory: join(dir, 'bridge'), codexHome: join(dir, 'codex'), serverName: 'peerbridge' }
  const token = await registrationSecret(options)
  const location = registrationLocation(options)
  writeFileSync(location.path, JSON.stringify({ schema: 1, token, profileDir: join(dir, 'desktop'), active: true, pid: process.pid, ownerId: 'legacy-active' }))
  const result = JSON.parse((await invoke(dir, ['--codex-home', options.codexHome])).stdout)
  assert.equal(result.results[0].status, 'active')
  assert.equal(existsSync(location.path), true)
})

test('cleanup CLI reports mismatched ownership as a refusal before accessing Codex', async t => {
  const dir = isolated(t)
  const options = { directory: join(dir, 'bridge'), codexHome: join(dir, 'codex'), serverName: 'peerbridge' }
  await registrationSecret(options)
  const location = registrationLocation(options)
  const record = JSON.parse(readFileSync(location.path))
  const profileDir = join(dir, 'desktop')
  writeFileSync(location.path, JSON.stringify({ ...record, serverName: 'foreign', profileDir }))
  await assert.rejects(invoke(dir, ['--apply', '--profile-dir', profileDir]), error => error.code === 2 && JSON.parse(error.stdout).results[0].status === 'server-mismatch')
  assert.equal(existsSync(location.path), true)
})

test('cleanup CLI discovers dead lock-only residue and reports the exact removed artifact', async t => {
  const dir = isolated(t)
  const options = { directory: join(dir, 'bridge'), codexHome: join(dir, 'codex'), serverName: 'peerbridge' }
  const { path } = registrationLocation(options)
  const candidate = `${path}.lock.11111111-1111-4111-8111-111111111111.tmp`
  writeFileSync(candidate, JSON.stringify({ pid: process.pid, processBirth: 'past-process', lockId: 'dead', codexHome: options.codexHome, serverName: options.serverName }))
  const before = JSON.parse((await invoke(dir)).stdout).results[0]
  assert.equal(before.status, 'artifacts-only')
  assert.deepEqual(before.removableArtifacts, [candidate])
  const after = JSON.parse((await invoke(dir, ['--apply', '--profile-dir', join(dir, 'desktop')])).stdout).results[0]
  assert.equal(after.status, 'artifacts-cleaned')
  assert.deepEqual(after.removedArtifacts, [candidate])
  assert.equal(existsSync(candidate), false)
})

test('cleanup CLI reports retained live artifacts and exits nonzero on apply', async t => {
  const dir = isolated(t)
  const options = { directory: join(dir, 'bridge'), codexHome: join(dir, 'codex'), serverName: 'peerbridge' }
  const { path } = registrationLocation(options)
  const candidate = `${path}.lock.22222222-2222-4222-8222-222222222222.tmp`
  writeFileSync(candidate, JSON.stringify({ pid: process.pid, lockId: 'live', codexHome: options.codexHome, serverName: options.serverName }))
  await assert.rejects(invoke(dir, ['--apply', '--profile-dir', join(dir, 'desktop')]), error => error.code === 2 && JSON.parse(error.stdout).results[0].retainedArtifacts.includes(candidate))
  assert.equal(existsSync(candidate), true)
})

test('cleanup CLI does not redirect inspection to a corrupted home from the record', async t => {
  const dir = isolated(t)
  const options = { directory: join(dir, 'bridge'), codexHome: join(dir, 'codex'), serverName: 'peerbridge' }
  await registrationSecret(options)
  const location = registrationLocation(options)
  const record = JSON.parse(readFileSync(location.path))
  writeFileSync(location.path, JSON.stringify({ ...record, codexHome: join(dir, 'foreign'), profileDir: join(dir, 'desktop') }))
  assert.equal(JSON.parse((await invoke(dir)).stdout).results[0].status, 'home-mismatch')
  await assert.rejects(invoke(dir, ['--apply', '--profile-dir', join(dir, 'desktop')]), error => error.code === 2 && JSON.parse(error.stdout).results[0].status === 'home-mismatch')
  assert.equal(existsSync(location.path), true)
})
