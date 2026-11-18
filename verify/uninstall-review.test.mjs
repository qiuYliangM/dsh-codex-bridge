import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanupCodexRegistration, configureCodex, listCodexRegistrations, registrationLocation, registrationSecret } from '../src/codex-registration.js'
import { migrateLegacyPatch } from '../src/legacy-migration.js'

function fixture(t) {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'bridge uninstall ')))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const home = join(directory, 'codex'); mkdirSync(home)
  const file = join(home, 'config.toml'); writeFileSync(file, '# private user settings\n', { mode: 0o600 })
  const state = { version: 1, servers: { other: { command: 'keep' } }, fail: false, writes: 0 }
  const rpc = async (_options, run) => run({ async call(method, args) {
    if (method === 'config/read') return { layers: [{ name: { type: 'user', file }, version: String(state.version), config: { mcp_servers: structuredClone(state.servers) } }] }
    assert.equal(method, 'config/batchWrite')
    if (state.fail) throw new Error('config write unavailable')
    assert.equal(args.expectedVersion, String(state.version))
    state.version++; state.writes++
    for (const edit of args.edits) {
      const name = edit.keyPath.slice('mcp_servers.'.length)
      if (edit.value === null) delete state.servers[name]
      else state.servers[name] = structuredClone(edit.value)
    }
    return { status: 'ok' }
  } })
  const options = { codexHome: home, directory: join(directory, 'private'), serverName: 'peerbridge', profileDir: join(directory, 'desktop'), url: 'http://127.0.0.1:3080/mcp', rpc }
  return { directory, options, state }
}

function simulateCrashedOwner(path) {
  const record = JSON.parse(readFileSync(path, 'utf8'))
  record.processBirth = 'an-earlier-process-with-this-pid'
  writeFileSync(path, JSON.stringify(record), { mode: 0o600 })
}

test('failed endpoint replacement retains ownership of the last working transport for restart and cleanup', async t => {
  const { options, state } = fixture(t)
  const token = await registrationSecret(options)
  const first = await configureCodex({ ...options, token })
  simulateCrashedOwner(first.location)
  state.fail = true
  const replacement = { ...options, token, url: 'http://127.0.0.1:4080/mcp' }
  await assert.rejects(configureCodex(replacement), /write unavailable/)
  assert.equal(state.servers.peerbridge.url, options.url)
  assert.equal((await cleanupCodexRegistration(options)).status, 'owned-stale-transport')
  state.fail = false
  const recovered = await configureCodex(replacement)
  assert.equal(state.servers.peerbridge.url, replacement.url)
  await recovered.release()
  assert.equal(state.servers.peerbridge, undefined)
})

test('explicit uninstall cleanup is inspect-only by default and removes credentials only after its transport is gone', async t => {
  const { options, state } = fixture(t)
  const token = await registrationSecret(options)
  const registration = await configureCodex({ ...options, token })
  assert.equal((await cleanupCodexRegistration({ ...options, apply: true })).status, 'active')
  assert.ok(existsSync(registration.location))
  assert.equal((await cleanupCodexRegistration({ ...options, profileDir: join(options.profileDir, 'other'), apply: true })).status, 'profile-mismatch')
  simulateCrashedOwner(registration.location)
  const writes = state.writes
  assert.equal((await cleanupCodexRegistration(options)).status, 'owned-stale-transport')
  assert.equal(state.writes, writes)
  const listed = listCodexRegistrations(options)
  assert.equal(listed[0].codexHome, options.codexHome)
  assert.equal(listed[0].serverName, options.serverName)
  assert.equal(listed[0].active, false)
  assert.ok(!JSON.stringify(listed).includes(token))
  assert.equal((await cleanupCodexRegistration({ ...options, apply: true })).status, 'cleaned')
  assert.equal(existsSync(registration.location), false)
  assert.equal(state.servers.peerbridge, undefined)
  assert.equal(state.servers.other.command, 'keep')
  assert.deepEqual(readdirSync(join(options.directory, 'registrations')), [])
  // A former lifecycle callback cannot affect a subsequent install.
  const nextToken = await registrationSecret(options)
  assert.notEqual(nextToken, token)
  const next = await configureCodex({ ...options, token: nextToken })
  assert.equal((await registration.release()).reason, 'ownership-changed')
  assert.equal(state.servers.peerbridge.http_headers.Authorization, `Bearer ${nextToken}`)
  await next.release()
})

test('explicit cleanup preserves user-modified transports and their recovery records', async t => {
  const { options, state } = fixture(t)
  const token = await registrationSecret(options)
  const registration = await configureCodex({ ...options, token })
  simulateCrashedOwner(registration.location)
  state.servers.peerbridge = { command: 'user-selected-server', args: ['keep'] }
  const writes = state.writes
  assert.equal((await cleanupCodexRegistration({ ...options, apply: true })).status, 'user-changed-transport')
  assert.equal(state.writes, writes)
  assert.ok(existsSync(registration.location))
  assert.equal(state.servers.peerbridge.command, 'user-selected-server')
})

test('old empty locks and locks belonging to a reused PID are recovered without persistent temp files', async t => {
  const { options } = fixture(t)
  const { path } = registrationLocation(options)
  const lock = `${path}.lock`
  writeFileSync(lock, '')
  const old = new Date(Date.now() - 60000); utimesSync(lock, old, old)
  const token = await registrationSecret(options)
  assert.equal(token.length, 64)
  writeFileSync(lock, JSON.stringify({ pid: process.pid, processBirth: 'an-earlier-process-with-this-pid', lockId: 'obsolete' }))
  assert.equal(await registrationSecret(options), token)
  assert.deepEqual(readdirSync(join(options.directory, 'registrations')), [path.split(/[\\/]/).at(-1)])
})

test('legacy migration preserves owner-only profile permissions', t => {
  const { directory } = fixture(t)
  const path = join(directory, 'cordis.patch.yml')
  writeFileSync(path, '- id: other\n  config:\n    secret: private\n# begin-peerbridge (managed by peerbridge CLI)\n- id: peerbridge\n# end-peerbridge\n', { mode: 0o600 })
  assert.equal(migrateLegacyPatch(path), true)
  assert.match(readFileSync(path, 'utf8'), /secret: private/)
  if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600)
})

test('a legacy marker on another TOML table never authorizes replacing a foreign plugin', async t => {
  const { options, state } = fixture(t)
  const marker = '# PeerBridge: peer collaboration bridge (managed by peerbridge CLI; remove via peerbridge uninstall)\n'
  state.servers.peerbridge = { command: 'node', args: ['/another/plugin/bin/codex-mcp.mjs'] }
  writeFileSync(join(options.codexHome, 'config.toml'), marker + '[mcp_servers.other]\ncommand = "keep"\n[mcp_servers.peerbridge]\n')
  const token = await registrationSecret(options)
  await assert.rejects(configureCodex({ ...options, token }), /已有其他连接/)
  assert.equal(state.writes, 0)
  const custom = { ...options, serverName: 'other' }
  state.servers.other = { command: 'node', args: ['/another/plugin/bin/codex-mcp.mjs'] }
  writeFileSync(join(options.codexHome, 'config.toml'), marker + '[mcp_servers.peerbridge]\n')
  const customToken = await registrationSecret(custom)
  await assert.rejects(configureCodex({ ...custom, token: customToken }), /已有其他连接/)
  assert.equal(state.writes, 0)
})

test('offline cleanup uses the real Codex CAS writer and removes its private record without changing other MCP entries', { skip: !process.env.PEERBRIDGE_TEST_CODEX_BIN }, async t => {
  const { options } = fixture(t)
  delete options.rpc
  options.codexBin = process.env.PEERBRIDGE_TEST_CODEX_BIN
  writeFileSync(join(options.codexHome, 'config.toml'), '# retain this comment\n[mcp_servers.other]\ncommand = "keep"\nenabled = false\n', { mode: 0o600 })
  const token = await registrationSecret(options)
  const registration = await configureCodex({ ...options, token })
  simulateCrashedOwner(registration.location)
  const before = readFileSync(join(options.codexHome, 'config.toml'), 'utf8')
  assert.equal((await cleanupCodexRegistration(options)).status, 'owned-stale-transport')
  assert.equal(readFileSync(join(options.codexHome, 'config.toml'), 'utf8'), before)
  assert.equal((await cleanupCodexRegistration({ ...options, apply: true })).status, 'cleaned')
  const after = readFileSync(join(options.codexHome, 'config.toml'), 'utf8')
  assert.match(after, /# retain this comment/)
  assert.match(after, /mcp_servers.other/)
  assert.match(after, /command = "keep"/)
  assert.doesNotMatch(after, /mcp_servers.peerbridge/)
  assert.equal(existsSync(registration.location), false)
})

test('inspecting a never-installed home does not create bridge state directories or spawn Codex', async t => {
  const { options } = fixture(t)
  options.rpc = () => { throw new Error('must not spawn a client for missing registration') }
  assert.equal((await cleanupCodexRegistration(options)).status, 'not-found')
  assert.equal(existsSync(options.directory), false)
})

test('real competing processes with different bridge data directories serialize one Codex configuration target', { timeout: 60000 }, async t => {
  const { options, directory } = fixture(t)
  const moduleUrl = new URL('../src/codex-registration.js', import.meta.url).href
  const events = join(directory, 'events.jsonl')
  const source = `
    import { appendFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { setTimeout as delay } from 'node:timers/promises';
    const { configureCodex, registrationSecret } = await import(${JSON.stringify(moduleUrl)});
    const options = JSON.parse(process.argv[1]);
    const event = kind => appendFileSync(options.events, JSON.stringify({ pid: process.pid, kind }) + '\\n');
    options.rpc = async (_options, run) => {
      event('enter');
      try {
        await delay(50);
        return await run({ async call(method) {
          if (method === 'config/read') return { layers: [{ name: { type: 'user', file: join(options.codexHome, 'config.toml') }, version: '1', config: {} }] };
          return { status: 'ok' };
        } });
      } finally { event('leave'); }
    };
    const token = await registrationSecret(options);
    await configureCodex({ ...options, token });
  `
  await Promise.all(Array.from({ length: 4 }, (_, index) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source, JSON.stringify({
      codexHome: options.codexHome, directory: join(directory, `bridge-${index}`), profileDir: options.profileDir,
      serverName: options.serverName, url: options.url, events,
    })], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    let error = ''; child.stderr.on('data', chunk => { error += chunk })
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`isolated lock contender exited ${code}: ${error}`)))
  })))
  const records = readFileSync(events, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.equal(records.length, 8)
  for (let index = 0; index < records.length; index += 2) {
    assert.equal(records[index].kind, 'enter')
    assert.equal(records[index + 1].kind, 'leave')
    assert.equal(records[index].pid, records[index + 1].pid, 'no second process may enter while the first owns the target')
  }
})

test('cleanup removes scoped crashed credential and lock artifacts and retains unrelated or live files', async t => {
  const { options } = fixture(t)
  await registrationSecret(options)
  const { path } = registrationLocation(options)
  const stale = JSON.parse(readFileSync(path, 'utf8'))
  const credential = `${path}.${randomUUID()}.tmp`
  const lock = `${path}.lock.${randomUUID()}.tmp`
  const unrelated = join(options.directory, 'registrations', `other-${randomUUID()}.tmp`)
  writeFileSync(credential, JSON.stringify(stale), { mode: 0o600 })
  writeFileSync(lock, JSON.stringify({ pid: process.pid, processBirth: 'a-past-process', lockId: randomUUID() }), { mode: 0o600 })
  writeFileSync(unrelated, 'other plugin state')
  const inspected = await cleanupCodexRegistration(options)
  assert.equal(inspected.removableArtifacts.length, 2)
  assert.ok(existsSync(credential))
  const cleaned = await cleanupCodexRegistration({ ...options, apply: true })
  assert.equal(cleaned.removedArtifacts.length, 2)
  assert.equal(existsSync(credential), false)
  assert.equal(existsSync(lock), false)
  assert.equal(existsSync(unrelated), true)
  const live = `${path}.lock.${randomUUID()}.tmp`
  writeFileSync(live, JSON.stringify({ pid: process.pid, lockId: randomUUID(), codexHome: options.codexHome, serverName: options.serverName }))
  assert.equal(listCodexRegistrations(options)[0].artifactOnly, true)
  assert.equal(listCodexRegistrations(options)[0].active, true)
  const retained = await cleanupCodexRegistration({ ...options, apply: true })
  assert.equal(retained.changed, false)
  assert.deepEqual(retained.retainedArtifacts, [live])
  assert.equal(existsSync(live), true)
})

test('a first-save crash leaving only a credential temporary file is discoverable and removable', async t => {
  const { options } = fixture(t)
  await registrationSecret(options)
  const { path } = registrationLocation(options)
  const candidate = `${path}.${randomUUID()}.tmp`
  const record = readFileSync(path)
  rmSync(path)
  writeFileSync(candidate, record, { mode: 0o600 })
  assert.equal(listCodexRegistrations(options)[0].artifactOnly, true)
  assert.equal((await cleanupCodexRegistration(options)).status, 'unused-registration')
  assert.equal((await cleanupCodexRegistration({ ...options, apply: true })).status, 'cleaned')
  assert.equal(existsSync(candidate), false)
  assert.equal(listCodexRegistrations(options).length, 0)
})

test('never-configured secrets can be deleted without modifying a rejected foreign MCP connection', async t => {
  const { options, state } = fixture(t)
  const token = await registrationSecret(options)
  state.servers.peerbridge = { command: 'foreign' }
  await assert.rejects(configureCodex({ ...options, token }), /已有其他连接/)
  assert.equal((await cleanupCodexRegistration({ ...options, apply: true })).status, 'cleaned')
  assert.deepEqual(state.servers.peerbridge, { command: 'foreign' })
  assert.equal(state.writes, 0)
  assert.equal(listCodexRegistrations(options).length, 0)
})

test('a dead lock candidate without any credential record is listed and removed independently', async t => {
  const { options } = fixture(t)
  const { path } = registrationLocation(options)
  const candidate = `${path}.lock.${randomUUID()}.tmp`
  writeFileSync(candidate, JSON.stringify({ pid: process.pid, processBirth: 'an-old-process', lockId: randomUUID(), codexHome: options.codexHome, serverName: options.serverName }))
  assert.equal(listCodexRegistrations(options)[0].artifactOnly, true)
  options.rpc = () => { throw new Error('lock-only residue does not require Codex configuration access') }
  assert.equal((await cleanupCodexRegistration(options)).status, 'artifacts-only')
  const result = await cleanupCodexRegistration({ ...options, apply: true })
  assert.equal(result.status, 'artifacts-cleaned')
  assert.deepEqual(result.removedArtifacts, [candidate])
  assert.equal(existsSync(candidate), false)
})

test('killing an isolated lock owner releases the OS mutex and permits safe recovery of its file lock', { timeout: 60000 }, async t => {
  const { options } = fixture(t)
  const moduleUrl = new URL('../src/codex-registration.js', import.meta.url).href
  const source = `
    const { configureCodex, registrationSecret } = await import(${JSON.stringify(moduleUrl)});
    const options = JSON.parse(process.argv[1]);
    const token = await registrationSecret(options);
    options.rpc = async () => { process.stdout.write('HELD\\n'); await new Promise(() => {}); };
    await configureCodex({ ...options, token });
  `
  const child = spawn(process.execPath, ['--input-type=module', '-e', source, JSON.stringify({
    codexHome: options.codexHome, directory: options.directory, profileDir: options.profileDir, serverName: options.serverName, url: options.url,
  })], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  t.after(() => child.kill('SIGKILL'))
  let error = ''; child.stderr.on('data', chunk => { error += chunk })
  await new Promise((resolve, reject) => {
    child.stdout.once('data', chunk => String(chunk).includes('HELD') ? resolve() : reject(new Error('unexpected isolated child output')))
    child.once('error', reject)
    child.once('exit', code => reject(new Error(`lock owner exited early ${code}: ${error}`)))
  })
  const exited = once(child, 'exit')
  child.kill('SIGKILL'); await exited
  const token = await registrationSecret(options)
  assert.equal(token.length, 64)
  const { path } = registrationLocation(options)
  assert.equal(existsSync(`${path}.lock`), false)
  assert.equal((await cleanupCodexRegistration({ ...options, apply: true })).status, 'cleaned')
})
