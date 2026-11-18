import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer, request } from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createMcpHttp } from '../src/mcp-http.js'
import { withCodex } from '../src/codex-client.js'
import { configureCodex, registrationLocation, registrationSecret } from '../src/codex-registration.js'
import { migrateLegacyPatch } from '../src/legacy-migration.js'
import { localOrigin, mountPlugin } from '../src/plugin-runtime.js'

function temporary(t, beforeCleanup) {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'bridge plugin ')))
  const previous = process.env.PEERBRIDGE_HOME
  process.env.PEERBRIDGE_HOME = join(directory, 'private')
  mkdirSync(process.env.PEERBRIDGE_HOME)
  t.after(async () => {
    await beforeCleanup?.()
    if (previous === undefined) delete process.env.PEERBRIDGE_HOME
    else process.env.PEERBRIDGE_HOME = previous
    rmSync(directory, { recursive: true, force: true })
  })
  return directory
}

function fakeConfig(directory, initial = {}) {
  const home = join(directory, 'codex')
  mkdirSync(home, { recursive: true })
  const file = join(home, 'config.toml')
  writeFileSync(file, '# preserved by the real writer in the integration test\n')
  const state = { servers: structuredClone(initial), version: 1, edits: [], conflicts: 0 }
  const rpc = async (_options, run) => run({ async call(method, args) {
    if (method === 'config/read') return { layers: [{ name: { type: 'user', file }, version: String(state.version), config: { mcp_servers: structuredClone(state.servers) } }] }
    assert.equal(method, 'config/batchWrite')
    assert.equal(args.filePath, file)
    if (state.conflicts > 0) { state.conflicts--; state.version++; state.servers.concurrent = { command: 'keep' }; throw new Error('version conflict') }
    assert.equal(args.expectedVersion, String(state.version))
    for (const edit of args.edits) {
      state.edits.push(edit)
      const name = edit.keyPath.slice('mcp_servers.'.length)
      if (edit.value === null) delete state.servers[name]
      else state.servers[name] = structuredClone(edit.value)
    }
    state.version++
    return { status: 'ok' }
  } })
  return { home, state, rpc }
}

test('plugin uses the actual loopback listener and refuses unsupported network/TLS configurations', () => {
  assert.equal(localOrigin({ port: 3080, host: '::1' }), 'http://[::1]:3080')
  assert.equal(localOrigin({ port: 3080, protocol: 'http' }), 'http://127.0.0.1:3080')
  assert.equal(localOrigin({ port: 3080, getOrigin: () => 'http://127.0.0.1:3080' }), 'http://127.0.0.1:3080')
  assert.throws(() => localOrigin({ port: 3080, getOrigin: () => 'https://127.0.0.1:3080' }), /TLS/)
  assert.throws(() => localOrigin({ port: 3080, host: '10.0.0.1' }), /网络绑定/)
})

test('MCP registration preserves unrelated entries, handles CAS conflicts and removes only its own transport', async t => {
  const directory = temporary(t)
  const { home, state, rpc } = fakeConfig(directory, { other: { command: 'keep' } })
  const options = { codexHome: home, serverName: 'peerbridge', profileDir: join(directory, 'desktop'), url: 'http://127.0.0.1:3080/peerbridge/peerbridge/mcp', rpc }
  const token = await registrationSecret(options)
  state.conflicts = 1
  const registration = await configureCodex({ ...options, token })
  assert.equal(state.servers.other.command, 'keep')
  assert.equal(state.servers.concurrent.command, 'keep')
  assert.equal(state.servers.peerbridge.http_headers.Authorization, `Bearer ${token}`)
  assert.equal(state.servers.peerbridge.tool_timeout_sec, 910)
  if (process.platform !== 'win32') assert.equal(statSync(registration.location).mode & 0o777, 0o600)
  await assert.rejects(configureCodex({ ...options, token }), /活动 DSH 插件/)
  await registration.release()
  assert.equal(state.servers.peerbridge, undefined)
  assert.equal(state.servers.other.command, 'keep')
  const again = await configureCodex({ ...options, token })
  state.servers.peerbridge.url = 'http://127.0.0.1:9999/user-changed'
  assert.equal((await again.release()).reason, 'user-changed-transport')
  assert.equal(state.servers.peerbridge.url, 'http://127.0.0.1:9999/user-changed')
  assert.equal(await registrationSecret(options), token)
})

test('MCP registration rejects foreign connections and profile takeover without writing them', async t => {
  const directory = temporary(t)
  const { home, state, rpc } = fakeConfig(directory, { peerbridge: { command: 'foreign' } })
  const options = { codexHome: home, profileDir: join(directory, 'first'), url: 'http://127.0.0.1:3080/mcp', rpc }
  const token = await registrationSecret(options)
  await assert.rejects(configureCodex({ ...options, token }), /已有其他连接/)
  assert.equal(state.edits.length, 0)
  delete state.servers.peerbridge
  const registration = await configureCodex({ ...options, token })
  const owned = structuredClone(state.servers.peerbridge)
  await registration.release()
  state.servers.peerbridge = owned
  await assert.rejects(configureCodex({ ...options, token, profileDir: join(directory, 'other') }), /另一 DSH profile/)
  await registration.release()
})

test('standard plugin migrates only the old installer-owned YAML block', t => {
  const directory = temporary(t)
  const file = join(directory, 'cordis.patch.yml')
  const before = '- id: other\n  config:\n    value: !!js process.env.KEEP\n'
  writeFileSync(file, before + '# begin-peerbridge (managed by peerbridge CLI)\n- insert:\n    - id: peerbridge\n      name: peerbridge-dsh-plugin\n# end-peerbridge\n')
  assert.equal(migrateLegacyPatch(file), true)
  assert.equal(readFileSync(file, 'utf8'), before)
  assert.equal(migrateLegacyPatch(file), false)
  writeFileSync(file, '# begin-peerbridge (managed by peerbridge CLI)\ntruncated\n')
  const original = readFileSync(file, 'utf8')
  assert.throws(() => migrateLegacyPatch(file), /未闭合/)
  assert.equal(readFileSync(file, 'utf8'), original)
})

test('failed cleanup keeps recovery intent and can retry without removing a foreign connection', async t => {
  const directory = temporary(t)
  const { home, state, rpc } = fakeConfig(directory, { other: { command: 'keep' } })
  let unavailable = false
  const options = { codexHome: home, profileDir: directory, url: 'http://127.0.0.1:3080/mcp', rpc: (...args) => {
    if (unavailable) throw new Error('CLI unavailable')
    return rpc(...args)
  } }
  const token = await registrationSecret(options)
  const registration = await configureCodex({ ...options, token })
  unavailable = true
  await assert.rejects(registration.release(), /CLI unavailable/)
  assert.equal(JSON.parse(readFileSync(registration.location)).pending, true)
  unavailable = false
  await registration.release()
  assert.equal(state.servers.peerbridge, undefined)
  assert.equal(state.servers.other.command, 'keep')
})

test('an inherited MCP entry is not shadowed by automatic registration', async t => {
  const directory = temporary(t)
  const { home, state, rpc } = fakeConfig(directory)
  const options = { codexHome: home, profileDir: directory, url: 'http://127.0.0.1:3080/mcp', rpc: (options, run) => rpc(options, client => run({
    async call(method, args) {
      const result = await client.call(method, args)
      if (method === 'config/read') result.config = { mcp_servers: { peerbridge: { command: 'administrator-provided' } } }
      return result
    },
  })) }
  const token = await registrationSecret(options)
  await assert.rejects(configureCodex({ ...options, token }), /其他配置层/)
  assert.equal(state.edits.length, 0)
})

test('marked legacy stdio MCP migrates while preserving user enablement and tool policies', async t => {
  const directory = temporary(t)
  const oldBin = join(directory, 'old repo', 'bin'); mkdirSync(oldBin, { recursive: true })
  writeFileSync(join(oldBin, 'codex-mcp.mjs'), "#!/usr/bin/env node\n// PeerBridge Codex MCP bridge 启动器（stdio JSON-RPC）\nawait import('../src/codex/mcp.js')\n")
  const { home, state, rpc } = fakeConfig(directory, { peerbridge: { command: 'node', args: [join(oldBin, 'codex-mcp.mjs')], enabled: false, enabled_tools: ['peer_status'] } })
  writeFileSync(join(home, 'config.toml'), '# PeerBridge: peer collaboration bridge (managed by peerbridge CLI; remove via peerbridge uninstall)\n[mcp_servers.peerbridge]\n')
  const options = { codexHome: home, profileDir: directory, url: 'http://127.0.0.1:3080/mcp', rpc }
  const token = await registrationSecret(options)
  const registration = await configureCodex({ ...options, token })
  assert.equal(state.servers.peerbridge.command, undefined)
  assert.equal(state.servers.peerbridge.args, undefined)
  assert.equal(state.servers.peerbridge.enabled, false)
  assert.deepEqual(state.servers.peerbridge.enabled_tools, ['peer_status'])
  await registration.release()
})

async function httpFixture(t, options = {}) {
  let transport
  const server = createServer((req, res) => transport.handler(req, res))
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const origin = `http://127.0.0.1:${server.address().port}`
  const token = 'test-only-token'
  transport = createMcpHttp({ token, origin, ...options })
  t.after(async () => { transport.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  const post = async (message, session, extra = {}) => fetch(`${origin}/mcp`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(session ? { 'mcp-session-id': session } : {}), ...extra }, body: JSON.stringify(message),
  })
  const init = async () => {
    const response = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
    assert.equal(response.status, 200)
    assert.equal((await response.json()).result.serverInfo.version, '0.5.2')
    return response.headers.get('mcp-session-id')
  }
  return { post, init, origin, token, transport }
}

test('HTTP source context comes from each call, rejects conflicts and never sticks to the MCP session', async t => {
  temporary(t)
  const sent = []
  const adapter = { workspaces: async () => [{ workspaceId: 'w', path: '/one' }], sessions: async () => [{ workspaceId: 'w', sessionId: 's' }], send: async (_target, text) => { sent.push(text); return { state: 'queued' } } }
  const fixture = await httpFixture(t, { adapter: () => adapter })
  const session = await fixture.init()
  let id = 1
  const send = async (meta, extra = {}) => (await fixture.post({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: {
    name: 'peer_send', arguments: { workspace: 'w', session: 's', text: 'test', ...extra }, ...(meta === undefined ? {} : { _meta: meta }),
  } }, session)).json()
  assert.equal((await send({ threadId: 'thread-one' })).result.isError, false)
  assert.equal((await send({ threadId: 'thread-two' })).result.isError, false)
  assert.match(sent[0], /会话 thread-one/); assert.match(sent[1], /会话 thread-two/)
  const mismatch = await send({ threadId: 'thread-one' }, { sourceSession: 'thread-two' })
  assert.equal(JSON.parse(mismatch.result.content[0].text).error.code, 'SOURCE_SESSION_MISMATCH')
  for (const meta of [{ threadId: '' }, { threadId: 123 }, { threadId: 'bad\nsource' }, []]) {
    const result = await send(meta)
    assert.equal(JSON.parse(result.result.content[0].text).error.code, 'INVALID_SOURCE_CONTEXT')
  }
  assert.equal(sent.length, 2)
  assert.equal((await send(undefined)).result.isError, false)
  assert.equal(sent[2], '【来自 ChatGPT/Codex】\ntest')
  assert.equal((await send(undefined, { sourceSession: 'legacy-label' })).result.isError, false)
  assert.match(sent[3], /会话 legacy-label/)
})

test('HTTP MCP authenticates, fences browser origins, limits bodies and returns actionable target errors', async t => {
  temporary(t)
  const fixture = await httpFixture(t, { adapter: () => ({ workspaces: async () => [] }) })
  assert.equal((await fixture.post({}, undefined, { authorization: '' })).status, 401)
  assert.equal((await fixture.post({}, undefined, { origin: 'https://evil.example' })).status, 403)
  const rejectedHost = await new Promise(resolve => {
    request(`${fixture.origin}/mcp`, { method: 'POST', headers: { host: 'evil.example', authorization: 'Bearer test-only-token', 'content-type': 'application/json' } }, response => { response.resume(); resolve(response.statusCode) }).end('{}')
  })
  assert.equal(rejectedHost, 403)
  assert.equal((await fixture.post({ big: 'x'.repeat(1024 * 1024) })).status, 413)
  const session = await fixture.init()
  const listed = await (await fixture.post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, session)).json()
  assert.equal(listed.result.tools.length, 12)
  const missing = await (await fixture.post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'peer_send', arguments: { text: 'fail' } } }, session)).json()
  assert.equal(missing.result.isError, true)
  const unknown = await (await fixture.post({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'peer_sessions', arguments: { workspace: 'unknown' } } }, session)).json()
  assert.equal(JSON.parse(unknown.result.content[0].text).error.code, 'WORKSPACE_NOT_FOUND')
  assert.equal((await fixture.post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, 'expired')).status, 404)
})

test('HTTP MCP cancellation is per session and disabling aborts outstanding questions', async t => {
  temporary(t)
  let sent = 0
  const adapter = { workspaces: async () => [{ workspaceId: 'w', path: '/one' }], sessions: async () => [{ workspaceId: 'w', sessionId: 's' }], send: async () => { sent++; return { state: 'queued' } } }
  const fixture = await httpFixture(t, { adapter: () => adapter })
  const first = await fixture.init(), second = await fixture.init()
  const ask = session => fixture.post({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'peer_ask', arguments: { workspace: 'w', session: 's', question: 'q' } } }, session)
  const one = ask(first), two = ask(second)
  while (sent < 2) await delay(5)
  await fixture.post({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 7 } }, first)
  assert.equal((await (await one).json()).result.isError, true)
  fixture.transport.close()
  assert.equal((await (await two).json()).result.isError, true)
})

test('one plugin enable configures MCP and all tools; disable and reinstall release and restore them', async t => {
  const directory = temporary(t, () => stop())
  const { home, rpc, state } = fakeConfig(directory)
  const routes = new Map(), tools = new Map(), effects = []
  const profileDir = join(directory, 'desktop'); mkdirSync(profileDir)
  const ctx = {
    profileContext: { dir: profileDir, patchPath: join(profileDir, 'cordis.patch.yml') },
    fiber: { entry: { options: { id: 'codex-deepseek-bridge' } } },
    logger: { info() {} }, loader: { entries: () => [] }, get: () => undefined,
    webServer: { port: 3080, register(route) { assert.equal(routes.has(route.path), false); routes.set(route.path, route); return () => routes.delete(route.path) } },
    connection: { authenticatedUrl: origin => `${origin}/?token=host-only-test` },
    tools: { register(tool) { assert.equal(tools.has(tool.name), false); tools.set(tool.name, tool); return () => tools.delete(tool.name) } },
    async effect(start) { effects.push(await start()) },
  }
  const options = { register: args => configureCodex({ ...args, rpc }) }
  const stop = async () => { for (const effect of effects.splice(0).reverse()) await effect() }
  await mountPlugin(ctx, { codexHome: home }, value => value, options)
  assert.equal(tools.size, 12); assert.equal(routes.size, 1)
  await assert.rejects(tools.get('peer_send').execute({ workspace: 'unused', session: 'unused', text: 'test', sourceSession: 'other-session' }, {
    agent: { session: { id: 'host-session' } }, signal: new AbortController().signal,
  }), { code: 'SOURCE_SESSION_MISMATCH' })
  assert.match(state.servers.peerbridge.url, /\/peerbridge\/peerbridge\/mcp$/)
  await stop()
  assert.equal(tools.size, 0); assert.equal(routes.size, 0); assert.equal(state.servers.peerbridge, undefined)
  await mountPlugin(ctx, { codexHome: home }, value => value, options)
  assert.equal(tools.size, 12)
})

test('real Codex config writer preserves TOML comments and other MCP entries in an isolated home', { skip: !process.env.PEERBRIDGE_TEST_CODEX_BIN }, async t => {
  const directory = temporary(t)
  const home = join(directory, 'real-codex'); mkdirSync(home)
  const file = join(home, 'config.toml')
  writeFileSync(file, '# user comment\n[mcp_servers.other]\ncommand = "keep"\nenabled = false\n')
  const options = { codexHome: home, profileDir: join(directory, 'profile'), url: 'http://127.0.0.1:9999/mcp', codexBin: process.env.PEERBRIDGE_TEST_CODEX_BIN }
  const token = await registrationSecret(options)
  const registration = await configureCodex({ ...options, token })
  assert.match(readFileSync(file, 'utf8'), /# user comment/)
  assert.match(readFileSync(file, 'utf8'), /command = "keep"/)
  await registration.release()
  const result = readFileSync(file, 'utf8')
  assert.match(result, /# user comment/); assert.match(result, /mcp_servers.other/)
  assert.doesNotMatch(result, /mcp_servers.peerbridge/)
})

test('real Codex automatically supplies distinct per-thread HTTP MCP context without source arguments or model prompts', { skip: !process.env.PEERBRIDGE_TEST_CODEX_BIN }, async t => {
  const directory = temporary(t)
  const sent = []
  const adapter = { workspaces: async () => [{ workspaceId: 'w', path: '/one' }], sessions: async () => [{ workspaceId: 'w', sessionId: 's' }], send: async (_target, text) => { sent.push(text); return { state: 'queued' } } }
  const fixture = await httpFixture(t, { adapter: () => adapter })
  const home = join(directory, 'native-codex'); mkdirSync(home)
  writeFileSync(join(home, 'config.toml'), `[mcp_servers.context_probe]\nurl = "${fixture.origin}/mcp"\nhttp_headers = { Authorization = "Bearer ${fixture.token}" }\n`, { mode: 0o600 })
  await withCodex({ codexBin: process.env.PEERBRIDGE_TEST_CODEX_BIN, codexHome: home, timeoutMs: 60000 }, async client => {
    const first = (await client.call('thread/start', { cwd: directory, ephemeral: true })).thread.id
    const second = (await client.call('thread/start', { cwd: directory, ephemeral: true })).thread.id
    for (const id of [first, second]) {
      await client.call('mcpServerStatus/list', { threadId: id, serverName: 'context_probe' })
      await client.call('mcpServer/tool/call', { threadId: id, server: 'context_probe', tool: 'peer_send', arguments: { workspace: 'w', session: 's', text: 'isolated native test' } })
    }
    assert.equal(sent.length, 2)
    assert.ok(sent[0].includes(`会话 ${first}`)); assert.ok(sent[1].includes(`会话 ${second}`))
    assert.ok(!sent[0].includes(second)); assert.ok(!sent[1].includes(first))
  })
})
