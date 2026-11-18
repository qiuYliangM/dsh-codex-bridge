// Explicit opt-in: a real DSH host and Codex, isolated homes, no model prompts.
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { DshClient } from '../src/dsh-client.js'
import { withCodex } from '../src/codex-client.js'
import { cleanupCodexRegistration } from '../src/codex-registration.js'

let dsh = process.env.PEERBRIDGE_TEST_DSH_SHIM
const codex = process.env.PEERBRIDGE_TEST_CODEX_BIN
if (!dsh || !codex) throw new Error('Set PEERBRIDGE_TEST_DSH_SHIM and PEERBRIDGE_TEST_CODEX_BIN')
const root = resolve(import.meta.dirname, '..')
mkdirSync(join(root, '.build'), { recursive: true })
const work = mkdtempSync(join(root, '.build/live-dsh-'))
// The desktop-generated shim intentionally pins its user's home. A private
// copy keeps its official core launch but removes that pin and PATH delegation.
// Never edit the user's installed launcher.
const launcher = readFileSync(dsh, 'utf8')
if (launcher.includes('# DeepSeek Harness Desktop - dsh command shim')) {
  const hook = join(dirname(dsh), 'asar-native.cjs')
  const isolated = launcher.replace(/remaining_path=[\s\S]*?\ndone\n/, '')
    .replace(/^export DSH_HOME=.*\n/m, '')
    .replace('"$(dirname "$0")/asar-native.cjs"', `'${hook.replaceAll("'", "'\\''")}'`)
  dsh = join(work, 'dsh-isolated')
  writeFileSync(dsh, isolated, { mode: 0o700 })
}
const home = join(work, 'home'); mkdirSync(home)
const codexHome = join(work, 'codex'); mkdirSync(codexHome)
const env = { ...process.env, HOME: home, USERPROFILE: home, DSH_HOME: join(work, 'dsh'), CODEX_HOME: codexHome, PEERBRIDGE_HOME: join(work, 'bridge'), DSH_TELEMETRY_DISABLED: '1' }
// Optional existing native package manager avoids fetching Corepack/pnpm into
// every isolated HOME. Only the private test PATH is changed.
if (process.env.PEERBRIDGE_TEST_PNPM_BIN) {
  const bin = join(work, 'bin'); mkdirSync(bin)
  const executable = resolve(process.env.PEERBRIDGE_TEST_PNPM_BIN)
  if (!existsSync(executable) || process.platform === 'win32') throw new Error('PEERBRIDGE_TEST_PNPM_BIN requires an existing POSIX executable')
  writeFileSync(join(bin, 'pnpm'), `#!/bin/sh\nexec '${executable.replaceAll("'", "'\\''")}' "$@"\n`, { mode: 0o700 })
  env.PATH = `${bin}${delimiter}${env.PATH || ''}`
}
for (const key of Object.keys(env)) if (/(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN)$/.test(key)) delete env[key]
mkdirSync(env.PEERBRIDGE_HOME)
writeFileSync(join(env.PEERBRIDGE_HOME, 'config.json'), JSON.stringify({ codexBin: codex }), { mode: 0o600 })
const manifest = JSON.parse(readFileSync(join(root, 'dist/plugin-manifest.json')))
const tarball = join(root, 'dist', manifest.filename)
const fixture = join(work, 'coexist-fixture'); mkdirSync(fixture)
writeFileSync(join(fixture, 'package.json'), JSON.stringify({ name: 'bridge-coexist-fixture', version: '1.0.0', type: 'module', main: 'index.js', dsh: { manifestVersion: 1, bundle: { patch: './cordis.patch.yml' } }, engines: { dsh: '>=0.2.2-rc.4 <0.3.0-0' }, peerDependencies: { '@deepseek-ai/dsh-tools': '>=0.2.2-rc.4 <0.3.0-0' } }))
writeFileSync(join(fixture, 'cordis.patch.yml'), '- insert:\n    - id: bridge-coexist-fixture\n      name: bridge-coexist-fixture\n')
writeFileSync(join(fixture, 'index.js'), `import { defineTool } from '@deepseek-ai/dsh-tools'
export const inject = ['tools', 'webServer']
export function apply(ctx) {
  return ctx.effect(() => {
    const tool = ctx.tools.register(defineTool({ name: 'unrelated_bridge_probe', description: 'Isolated coexistence test fixture', parameters: {}, output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }, async execute() { return { ok: true } } }))
    const route = ctx.webServer.register({ kind: 'exact', path: '/_bridge_coexist_probe', handler(_req, res) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ fixture: !!ctx.tools.get('unrelated_bridge_probe'), bridge: !!ctx.tools.get('peer_send') })) } })
    return () => { route(); tool() }
  })
}
`)
async function coexistence(gateway, bridgeEnabled) {
  const result = await fetch(new URL('/_bridge_coexist_probe', gateway))
  assert.equal(result.status, 200)
  assert.deepEqual(await result.json(), { fixture: true, bridge: bridgeEnabled })
}
const execute = promisify(execFile)
const redact = text => text.replace(/token=[^\s&"'<>]+/g, 'token=REDACTED').replace(/Bearer [A-Za-z0-9_-]+/g, 'Bearer REDACTED')
async function command(args) {
  const result = await execute(dsh, args, { env, cwd: work, encoding: 'utf8', timeout: 180000, maxBuffer: 4 * 1024 * 1024 })
  writeFileSync(join(work, `command-${Date.now()}.log`), redact(result.stdout + result.stderr), { mode: 0o600 })
}
let child, log = ''
async function stop() {
  if (!child || child.exitCode !== null) return
  const current = child
  const done = once(current, 'exit')
  const timer = setTimeout(() => current.kill('SIGKILL'), 15000)
  current.kill('SIGTERM')
  try { await done } finally { clearTimeout(timer) }
  child = undefined
}
async function start() {
  log = ''
  child = spawn(dsh, ['--profile', 'web', '--no-open', '--port', '0'], { env, cwd: work, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', data => { log += data.toString() })
  child.stderr.on('data', data => { log += data.toString() })
  for (let i = 0; i < 600; i++) {
    const match = /http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s\x1b]+/.exec(log)
    if (match) return match[0]
    if (child.exitCode !== null) throw new Error(`DSH exited ${child.exitCode}: ${redact(log).slice(-2500)}`)
    await delay(100)
  }
  throw new Error(`DSH startup timeout: ${redact(log).slice(-2500)}`)
}
async function poll(check) {
  for (let i = 0; i < 200; i++) { const value = await check(); if (value) return value; await delay(100) }
  throw new Error(`State transition timeout: ${redact(log).slice(-3500)}`)
}
async function block() {
  return withCodex({ codexBin: codex, codexHome }, async client => {
    const value = await client.call('config/read', { includeLayers: true })
    return value.layers.find(layer => layer.name.type === 'user').config?.mcp_servers?.peerbridge
  })
}
try {
  await command(['--profile', 'web', '--dump-config'])
  assert.ok(existsSync(join(env.DSH_HOME, 'profiles/web/package.json')), 'DSH launcher ignored isolated DSH_HOME; installation refused')
  await command(['plugin', '--profile', 'web', 'add', fixture])
  await command(['plugin', '--profile', 'web', 'add', tarball])
  console.log('Real DSH: bundle installed once into an isolated Web profile.')
  let gateway = await start()
  let client = new DshClient({ url: gateway, timeoutMs: 60000 })
  await poll(async () => (await client.call('pluginInventory/list', {})).entries.find(entry => entry.moduleName === 'peerbridge-dsh-plugin' && entry.fiberPhase === 'active'))
  const bundles = await client.call('pluginManager/listBundles', {})
  const bundle = bundles.find(bundle => bundle.name === 'peerbridge-dsh-plugin')
  assert.ok(bundle?.enabled && bundle.installed)
  await coexistence(gateway, true)
  const connection = await poll(block)
  assert.equal(existsSync(join(env.PEERBRIDGE_HOME, 'web-url.txt')), false, 'Pure plugin must not require a manually copied gateway token')
  const init = await fetch(connection.url, { method: 'POST', headers: { ...connection.http_headers, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) })
  assert.equal(init.status, 200)
  const session = init.headers.get('mcp-session-id')
  const status = await fetch(connection.url, { method: 'POST', headers: { ...connection.http_headers, 'content-type': 'application/json', 'mcp-session-id': session }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'peer_status', arguments: {} } }) })
  const result = await status.json()
  assert.equal(result.result.isError, false, JSON.stringify(result))
  assert.equal(JSON.parse(result.result.content[0].text).peer, 'dsh')
  console.log('Real DSH: standard plugin-manager listing and gateway calls through MCP passed.')
  const native = await withCodex({ codexBin: codex, codexHome, timeoutMs: 60000 }, async rpc => {
    const snapshot = await rpc.call('mcpServerStatus/list', { serverName: 'peerbridge' })
    const server = snapshot.data.find(server => server.name === 'peerbridge')
    assert.ok(server, 'Codex did not discover peerbridge')
    assert.equal(Object.keys(server.tools).length, 12)
    return { name: server.name, tools: Object.keys(server.tools) }
  })
  console.log('Real Codex: discovered all 12 tools from the auto-registered HTTP MCP.')
  const change = await client.call('pluginManager/setBundleEnabled', { name: 'peerbridge-dsh-plugin', enabled: false })
  if (change.application === 'restart-required') { await stop(); gateway = await start(); client = new DshClient({ url: gateway, timeoutMs: 60000 }) }
  await poll(async () => !(await block()))
  await coexistence(gateway, false)
  console.log('Real DSH: disabling removed the owned Codex MCP registration and preserved the unrelated plugin.')
  await client.call('pluginManager/setBundleEnabled', { name: 'peerbridge-dsh-plugin', enabled: true })
  await stop()
  gateway = await start(); client = new DshClient({ url: gateway, timeoutMs: 60000 })
  const restored = await poll(block)
  await coexistence(gateway, true)
  assert.equal(restored.http_headers.Authorization, connection.http_headers.Authorization)
  await command(['plugin', '--profile', 'web', 'add', tarball])
  const profile = JSON.parse(readFileSync(join(env.DSH_HOME, 'profiles/web/package.json')))
  assert.equal(profile.dsh.profile.bundles.filter(name => name === 'peerbridge-dsh-plugin').length, 1)
  await client.call('pluginManager/removeBundle', { name: 'peerbridge-dsh-plugin' })
  await stop()
  gateway = await start()
  await coexistence(gateway, false)
  await stop()
  assert.equal(await block(), undefined)
  const after = JSON.parse(readFileSync(join(env.DSH_HOME, 'profiles/web/package.json')))
  assert.equal(after.dependencies?.['peerbridge-dsh-plugin'], undefined)
  const clean = await cleanupCodexRegistration({ codexBin: codex, codexHome, directory: env.PEERBRIDGE_HOME, profileDir: join(env.DSH_HOME, 'profiles/web'), apply: true })
  assert.equal(clean.status, 'cleaned')
  assert.equal(existsSync(clean.path), false)
  assert.equal(after.dependencies?.['bridge-coexist-fixture'] !== undefined, true)
  const report = { unrelatedPluginPreserved: true, privateRegistrationRemoved: true, version: manifest.version, isolated: true, modelPromptsSent: 0, bundleListed: true, nativeCodexTools: native.tools.length, gatewayThroughMcp: true, disableCleanup: true, restartRecovery: true, reinstallNoDuplicate: true, removalCleanup: true }
  writeFileSync(join(work, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
  console.log(`Live validation passed: ${join(work, 'report.json')}`)
} catch (error) {
  writeFileSync(join(work, 'host-redacted.log'), redact(log), { mode: 0o600 })
  throw new Error(`${redact(error.message)}; artifacts: ${work}`)
} finally { await stop() }
