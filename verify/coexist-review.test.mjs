import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer, request } from 'node:http'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMcpHttp } from '../src/mcp-http.js'
import { mountPlugin } from '../src/plugin-runtime.js'
import { cleanupCodexRegistration, registrationLocation } from '../src/codex-registration.js'
import { test } from 'node:test'

async function httpFixture(t, options = {}) {
  let transport, uploading
  const server = createServer((req, res) => {
    if (req.headers['x-test-slow']) req.once('data', () => uploading?.())
    void transport.handler(req, res)
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const origin = `http://127.0.0.1:${server.address().port}`
  const headers = { 'content-type': 'application/json', authorization: 'Bearer isolated-test-token' }
  transport = createMcpHttp({ token: 'isolated-test-token', origin, ...options })
  t.after(async () => { transport.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  const post = (message, session) => fetch(origin, { method: 'POST', headers: { ...headers, ...(session ? { 'mcp-session-id': session } : {}) }, body: JSON.stringify(message) })
  const init = async () => {
    const response = await post({ jsonrpc: '2.0', id: 1, method: 'initialize' })
    assert.equal(response.status, 200); await response.json()
    return response.headers.get('mcp-session-id')
  }
  const slowPost = async (message, session) => {
    const body = JSON.stringify(message)
    const started = new Promise(resolve => { uploading = resolve })
    let req
    const completed = new Promise((resolve, reject) => {
      req = request(origin, { method: 'POST', headers: { ...headers, 'x-test-slow': '1', 'content-length': Buffer.byteLength(body), ...(session ? { 'mcp-session-id': session } : {}) } }, res => {
        const chunks = []; res.on('data', chunk => chunks.push(chunk))
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }))
      })
      req.on('error', reject); req.write(body.slice(0, 10))
    })
    await started
    return { finish() { req.end(body.slice(10)); return completed } }
  }
  return { transport, post, init, slowPost, origin, headers }
}

test('DELETE invalidates an authenticated MCP call still uploading its body before any peer mutation', async t => {
  let mutations = 0
  const fixture = await httpFixture(t, { adapter: () => ({ createWorkspace: async () => { mutations++; return {} } }) })
  const session = await fixture.init()
  const uploading = await fixture.slowPost({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'peer_create_workspace', arguments: { path: '/unused' } } }, session)
  const deleted = await fetch(fixture.origin, { method: 'DELETE', headers: { ...fixture.headers, 'mcp-session-id': session } })
  assert.equal(deleted.status, 200)
  assert.equal((await uploading.finish()).status, 404)
  assert.equal(mutations, 0)
})

test('disposal rejects initialize bodies already in flight and does not recreate transport sessions', async t => {
  const fixture = await httpFixture(t)
  const uploading = await fixture.slowPost({ jsonrpc: '2.0', id: 1, method: 'initialize' })
  fixture.transport.close()
  assert.equal((await uploading.finish()).status, 503)
})

test('MCP discovery and ping do not depend on a live peer gateway or invoke adapter factories', async t => {
  let attempts = 0
  const fixture = await httpFixture(t, { adapter() { attempts++; throw Object.assign(new Error('peer gateway unavailable'), { code: 'GATEWAY_UNAVAILABLE' }) } })
  const session = await fixture.init()
  for (const method of ['ping', 'tools/list']) {
    const response = await (await fixture.post({ jsonrpc: '2.0', id: method, method }, session)).json()
    assert.ok(response.result)
  }
  assert.equal(attempts, 0)
  const failure = await (await fixture.post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'peer_status' } }, session)).json()
  assert.equal(attempts, 1)
  assert.equal(failure.error.code, -32603)
  assert.match(failure.error.message, /gateway unavailable/)
})

function pluginFixture(t, { foreignTool, failingTool, failRouteOnce = false } = {}) {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'bridge coexist ')))
  const previous = process.env.PEERBRIDGE_HOME
  process.env.PEERBRIDGE_HOME = join(directory, 'private')
  mkdirSync(process.env.PEERBRIDGE_HOME)
  const foreignRoute = { path: '/other-plugin' }, foreign = { name: foreignTool || 'other_tool' }
  const routes = new Map([[foreignRoute.path, foreignRoute]]), tools = new Map([[foreign.name, foreign]])
  const effects = [], calls = { register: 0, release: 0, toolFailures: 0, routeFailures: 0 }
  const profileDir = join(directory, 'profile'); mkdirSync(profileDir)
  const ctx = {
    profileContext: { dir: profileDir, patchPath: join(profileDir, 'cordis.patch.yml') },
    fiber: { entry: { options: { id: 'codex-deepseek-bridge' } } },
    logger: { info() {} }, loader: { entries: () => [] }, get: () => undefined,
    webServer: { port: 3080, register(route) {
      assert.equal(routes.has(route.path), false); routes.set(route.path, route)
      return () => {
        if (failRouteOnce && calls.routeFailures++ === 0) throw new Error('route removal temporarily failed')
        routes.delete(route.path)
      }
    } },
    connection: { authenticatedUrl: origin => `${origin}/?token=host-test-only` },
    tools: { register(tool) {
      if (tools.has(tool.name)) throw new Error(`tool ${tool.name} already registered`)
      tools.set(tool.name, tool)
      return () => {
        if (tool.name === failingTool && calls.toolFailures++ === 0) throw new Error('tool removal temporarily failed')
        tools.delete(tool.name)
      }
    } },
    async effect(start) { effects.push(await start()) },
  }
  const register = async () => { calls.register++; return { async release() { calls.release++ } } }
  t.after(async () => {
    for (const dispose of effects) { try { await dispose() } catch {} }
    if (previous === undefined) delete process.env.PEERBRIDGE_HOME
    else process.env.PEERBRIDGE_HOME = previous
    rmSync(directory, { recursive: true, force: true })
  })
  return { directory, ctx, routes, tools, effects, calls, register, foreignRoute, foreign }
}

test('a conflicting peer tool preserves the foreign plugin and rolls back without editing Codex', async t => {
  const fixture = pluginFixture(t, { foreignTool: 'peer_send' })
  await assert.rejects(mountPlugin(fixture.ctx, { codexHome: join(fixture.directory, 'codex') }, value => value, { register: fixture.register }), /peer_send already registered/)
  assert.equal(fixture.calls.register, 0)
  assert.deepEqual([...fixture.routes.values()], [fixture.foreignRoute])
  assert.deepEqual([...fixture.tools.values()], [fixture.foreign])
})

test('disposal attempts every owned cleanup despite host failures and retries only failed resources', async t => {
  const fixture = pluginFixture(t, { failingTool: 'peer_send', failRouteOnce: true })
  await mountPlugin(fixture.ctx, { codexHome: join(fixture.directory, 'codex') }, value => value, { register: fixture.register })
  const dispose = fixture.effects[0]
  const first = dispose()
  assert.equal(dispose(), first, 'concurrent disposal shares one cleanup attempt')
  await assert.rejects(first, error => error instanceof AggregateError && error.errors.length === 2)
  assert.equal(fixture.calls.release, 1, 'Codex registration is still released after host errors')
  assert.deepEqual([...fixture.tools.keys()].sort(), ['other_tool', 'peer_send'])
  assert.equal(fixture.routes.get('/other-plugin'), fixture.foreignRoute)
  await dispose()
  assert.equal(fixture.calls.release, 1, 'successful cleanup is never repeated')
  assert.deepEqual([...fixture.routes.values()], [fixture.foreignRoute])
  assert.deepEqual([...fixture.tools.values()], [fixture.foreign])
})

test('startup failure after Codex registration releases the connection and all owned host resources', async t => {
  const fixture = pluginFixture(t)
  fixture.ctx.logger.info = () => { throw new Error('host logging failed after registration') }
  await assert.rejects(mountPlugin(fixture.ctx, { codexHome: join(fixture.directory, 'codex') }, value => value, { register: fixture.register }), /logging failed after registration/)
  assert.equal(fixture.calls.register, 1)
  assert.equal(fixture.calls.release, 1)
  assert.deepEqual([...fixture.routes.values()], [fixture.foreignRoute])
  assert.deepEqual([...fixture.tools.values()], [fixture.foreign])
})

test('manual MCP mode protects its live credential lease and releases it without editing Codex configuration', async t => {
  const fixture = pluginFixture(t)
  const codexHome = join(fixture.directory, 'codex'); mkdirSync(codexHome)
  const configFile = join(codexHome, 'config.toml'); writeFileSync(configFile, '# manual connection is user-managed\n')
  const options = { codexHome, profileDir: fixture.ctx.profileContext.dir }
  let configReads = 0
  const rpc = async (_options, run) => run({ async call(method) {
    assert.equal(method, 'config/read', 'manual runtime never edits a user-managed Codex connection')
    configReads++
    return { layers: [{ name: { type: 'user', file: configFile }, version: '1', config: { mcp_servers: {} } }] }
  } })
  await mountPlugin(fixture.ctx, { codexHome, autoConfigureCodex: false }, value => value, { register: fixture.register })
  assert.equal(fixture.calls.register, 0)
  const recordFile = registrationLocation(options).path
  const active = JSON.parse(readFileSync(recordFile, 'utf8'))
  assert.equal(active.active, true)
  assert.equal(active.profileDir, options.profileDir)
  assert.equal(active.url, 'http://127.0.0.1:3080/peerbridge/peerbridge/mcp')
  assert.equal((await cleanupCodexRegistration({ ...options, apply: true, rpc })).status, 'active')
  assert.equal(configReads, 0)
  await fixture.effects[0]()
  assert.equal(JSON.parse(readFileSync(recordFile, 'utf8')).active, false)
  assert.equal(configReads, 0)
  assert.equal(readFileSync(configFile, 'utf8'), '# manual connection is user-managed\n')
  assert.equal((await cleanupCodexRegistration({ ...options, apply: true, rpc })).status, 'cleaned')
})
