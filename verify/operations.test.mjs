import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chmodSync, mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync, realpathSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createInterface } from 'node:readline'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { WebSocketServer } from '../vendor/ws/wrapper.mjs'
import { PeerOperations } from '../src/operations.js'
import { runTool, toolDefinitions } from '../src/tools.js'
import { DshAdapter, CodexAdapter } from '../src/adapters.js'
import { queueToCodex } from '../src/codex-client.js'
import { desktopProjectStatus, readDesktopProjects, waitForDesktopProject, workspaceCreationReceipt } from '../src/codex-desktop.js'
import { cliCommand } from '../src/cli-command.js'

const root = resolve(import.meta.dirname, '..')
const executeFile = promisify(execFile)

test('desktop registration requires both matching roots and the canonical project ID', t => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'peerbridge-desktop-')))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const project = { id: 'server-1', name: 'Project', roots: [{ path: '/project' }] }
  const file = join(home, '.codex-global-state.json')
  assert.equal(desktopProjectStatus(project, readDesktopProjects(home)).state, 'unavailable')
  const state = {
    'local-projects': { ui1: { id: 'ui1', name: 'Project', rootPaths: ['/project'] } },
    'app-server-project-id-by-legacy-project-id-by-host': { [`local:${home}`]: { ui1: 'different-server-project' } },
  }
  writeFileSync(file, JSON.stringify(state))
  assert.equal(desktopProjectStatus(project, readDesktopProjects(home)).state, 'identity-mismatch')
  state['app-server-project-id-by-legacy-project-id-by-host'][`local:${home}`].ui1 = 'server-1'
  writeFileSync(file, JSON.stringify(state))
  const before = readFileSync(file, 'utf8')
  const status = desktopProjectStatus(project, readDesktopProjects(home))
  assert.equal(status.state, 'registered')
  assert.equal(status.desktopProjectId, 'ui1')
  assert.equal(status.liveUiVerified, false)
  assert.equal(readFileSync(file, 'utf8'), before)
  assert.equal(desktopProjectStatus({ ...project, roots: [{ path: '/other' }] }, readDesktopProjects(home)).state, 'missing')
  const receipt = workspaceCreationReceipt({ workspaceId: project.id, desktopSync: status }, true)
  assert.equal(receipt.backendRegistered, true)
  assert.equal(receipt.completed, true)
  const renamed = desktopProjectStatus({ ...project, name: 'Backend name only' }, readDesktopProjects(home))
  assert.equal(renamed.titleMatches, false)
  assert.equal(renamed.displayTitle, 'Project')
  assert.equal(workspaceCreationReceipt({ desktopSync: renamed }, false).completed, false)
  writeFileSync(file, '{broken json')
  assert.equal(readDesktopProjects(home).reason, 'desktop-state-unreadable')
})

function sandbox(t) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'peerbridge-ops-')))
  const previous = process.env.PEERBRIDGE_HOME
  process.env.PEERBRIDGE_HOME = directory
  t.after(() => {
    if (previous === undefined) delete process.env.PEERBRIDGE_HOME
    else process.env.PEERBRIDGE_HOME = previous
    rmSync(directory, { recursive: true, force: true })
  })
  return directory
}

test('Windows npm shims resolve directly to Node and preserve message metacharacters', async t => {
  const directory = sandbox(t)
  const bin = join(directory, 'bin with spaces')
  mkdirSync(bin)
  const entry = join(bin, 'entry.mjs')
  writeFileSync(entry, 'console.log(JSON.stringify(process.argv.slice(2)))\n')
  writeFileSync(join(bin, 'codex.cmd'), '@echo off\r\n"%_prog%" "%dp0%\\entry.mjs" %*\r\n')
  const args = ['queue', '--message', 'quotes " and & | < > %PATH% ! $ `\nnext line']
  const cli = cliCommand('codex', args, { platform: 'win32', env: { Path: bin } })
  const { stdout } = await executeFile(cli.command, cli.args)
  assert.deepEqual(JSON.parse(stdout), args)
  writeFileSync(join(bin, 'custom.cmd'), '@echo off\r\necho custom script\r\n')
  assert.throws(() => cliCommand(join(bin, 'custom.cmd'), args, { platform: 'win32' }), /真实 .exe/)
})

class MemoryAdapter {
  constructor() {
    this.workspacesData = [{ workspaceId: 'w1', path: '/one' }, { workspaceId: 'w2', path: '/two' }]
    this.sessionsData = [{ sessionId: 's1', cwd: '/one', workspaceId: 'w1', archived: false }, { sessionId: 's2', cwd: '/two', workspaceId: 'w2', archived: false }]
    this.sent = []
  }
  async workspaces() { return this.workspacesData }
  async sessions({ archived = false } = {}) { return this.sessionsData.filter(item => item.archived === archived) }
  async createSession(workspace, args) {
    const value = { sessionId: `s${this.sessionsData.length + 1}`, workspaceId: workspace.workspaceId, cwd: workspace.path, title: args.title, archived: false }
    this.sessionsData.push(value)
    return value
  }
  async createWorkspace(args) {
    const workspace = { workspaceId: 'new', path: args.path }
    this.workspacesData.push(workspace)
    return { workspace, created: true }
  }
  async send(target, text, requestId) { this.sent.push({ target, text, requestId }); return { state: 'queued' } }
  async archiveSession(id, archived) { this.sessionsData.find(item => item.sessionId === id).archived = archived }
  async renameSession(id, title) { this.sessionsData.find(item => item.sessionId === id).title = title }
  async renameWorkspace(id, title) { const item = this.workspacesData.find(item => item.workspaceId === id); item.title = title; return item }
}

test('each message requires explicit workspace and session, including after successful sends', async t => {
  sandbox(t)
  const adapter = new MemoryAdapter()
  const operations = new PeerOperations('dsh', { sourceSession: 'source-a', adapter })
  await assert.rejects(operations.send({}, 'x'), /workspace/)
  await assert.rejects(operations.send({ workspace: 'w1' }, 'x'), /session/)
  await operations.send({ workspace: 'w1', session: 's1' }, 'first')
  await operations.send({ workspace: 'w2', session: 's2' }, 'second')
  await assert.rejects(operations.send({}, 'must not reuse last target'), /workspace/)
  assert.deepEqual(adapter.sent.map(item => item.target.sessionId), ['s1', 's2'])
  assert.match(adapter.sent[0].text, /会话 source-a/)
})

test('legacy bindings and selection files are never used for routing', async t => {
  const directory = sandbox(t)
  writeFileSync(join(directory, 'config.json'), JSON.stringify({ codexThread: 's1' }))
  mkdirSync(join(directory, 'selections'))
  writeFileSync(join(directory, 'selections/old.json'), JSON.stringify({ workspaceId: 'w1', sessionId: 's1' }))
  const adapter = new MemoryAdapter()
  for (const peer of ['dsh', 'codex']) {
    const operations = new PeerOperations(peer, { sourceSession: 'same-source', adapter })
    await assert.rejects(operations.send({}, 'no fallback'), /workspace/)
    await assert.rejects(operations.send({ session: 's1' }, 'no fallback'), /workspace/)
    await assert.rejects(operations.send({ workspace: 'w1' }, 'no fallback'), /session/)
  }
  assert.equal(adapter.sent.length, 0)
  assert.equal(JSON.parse(readFileSync(join(directory, 'selections/old.json'))).sessionId, 's1')
})

test('unknown, ambiguous, moved and mismatched targets fail without creating or sending', async t => {
  sandbox(t)
  const adapter = new MemoryAdapter()
  const operations = new PeerOperations('dsh', { adapter })
  await assert.rejects(operations.send({ workspace: 'typo', session: 's1' }, 'x'), { code: 'WORKSPACE_NOT_FOUND' })
  await assert.rejects(operations.send({ workspace: 'w1', session: 'typo' }, 'x'), { code: 'SESSION_NOT_FOUND' })
  await assert.rejects(operations.send({ workspace: 'w1', session: 's2' }, 'x'), { code: 'TARGET_MISMATCH' })
  adapter.workspacesData.push({ workspaceId: 'w3', path: '/one' })
  await assert.rejects(operations.send({ workspace: '/one', session: 's1' }, 'x'), { code: 'WORKSPACE_AMBIGUOUS' })
  adapter.sessionsData[0].workspaceId = 'w2'
  await assert.rejects(operations.send({ workspace: 'w1', session: 's1' }, 'x'), { code: 'TARGET_MISMATCH' })
  assert.equal(adapter.workspacesData.length, 3)
  assert.equal(adapter.sessionsData.length, 2)
  assert.equal(adapter.sent.length, 0)
})

test('creation returns IDs without changing defaults; subsequent calls still require targets', async t => {
  const directory = sandbox(t)
  const adapter = new MemoryAdapter()
  const operations = new PeerOperations('dsh', { adapter })
  const created = await operations.execute('peer_create_workspace', { path: '/new' })
  assert.equal(created.workspace.workspaceId, 'new')
  assert.equal(created.selected, undefined)
  await assert.rejects(operations.execute('peer_create_session', {}), /workspace/)
  const result = await operations.execute('peer_create_session', { workspace: 'new', title: 'task' })
  assert.equal(result.session.workspaceId, 'new')
  assert.equal(result.selected, undefined)
  await assert.rejects(operations.send({}, 'still explicit'), /workspace/)
  assert.ok(!existsSync(join(directory, 'selections')))
  assert.equal(adapter.sent.length, 0)
})

test('session listing, renaming, archiving and restoring validate workspace membership', async t => {
  sandbox(t)
  const adapter = new MemoryAdapter()
  const operations = new PeerOperations('codex', { adapter })
  const target = { workspace: 'w1', session: 's1' }
  assert.equal((await operations.execute('peer_sessions', { workspace: 'w1' })).sessions.length, 1)
  await assert.rejects(operations.execute('peer_sessions', {}), /workspace/)
  await assert.rejects(operations.execute('peer_rename_session', { workspace: 'w2', session: 's1', title: 'bad' }), { code: 'TARGET_MISMATCH' })
  await operations.execute('peer_rename_session', { ...target, title: 'renamed' })
  assert.equal(adapter.sessionsData[0].title, 'renamed')
  await operations.execute('peer_archive_session', { ...target, archived: true })
  await assert.rejects(operations.send(target, 'archived'), { code: 'SESSION_NOT_FOUND' })
  assert.equal((await operations.execute('peer_sessions', { workspace: 'w1', archived: true })).sessions[0].sessionId, 's1')
  await operations.execute('peer_archive_session', { ...target, archived: false })
  await operations.send(target, 'restored')
  assert.equal(adapter.sent.length, 1)
})

test('shared answer IDs cannot escape the answer directory; limit zero returns zero', async t => {
  const directory = sandbox(t)
  writeFileSync(join(directory, 'config.json'), '{"keep":true}')
  await assert.rejects(runTool('dsh', 'peer_answer', { questionId: '../config', answer: 'x' }), /格式无效/)
  assert.equal(readFileSync(join(directory, 'config.json'), 'utf8'), '{"keep":true}')
  await assert.rejects(runTool('dsh', 'peer_answer', { questionId: 'q-123456abcdef', answer: 'yes' }), { code: 'QUESTION_NOT_PENDING' })
  assert.equal(existsSync(join(directory, 'answers')), false)
  assert.deepEqual(await runTool('dsh', 'peer_events', { limit: 0 }), { entries: [] })
})

test('already cancelled ask neither queues nor waits', async t => {
  sandbox(t)
  const adapter = new MemoryAdapter()
  await assert.rejects(runTool('dsh', 'peer_ask', { workspace: 'w1', session: 's1', question: 'q' }, { adapter, signal: AbortSignal.abort(new Error('stop')) }), /stop/)
  assert.equal(adapter.sent.length, 0)
})

test('bad tool parameter types are rejected before directory creation or messaging', async t => {
  const directory = sandbox(t)
  const adapter = new MemoryAdapter()
  await assert.rejects(runTool('dsh', 'peer_create_workspace', { path: join(directory, 'should-not-exist'), createDirectory: 'false' }, { adapter }), /boolean/)
  await assert.rejects(runTool('dsh', 'peer_send', { text: 'x', typo: true }, { adapter }), /未知参数/)
  assert.equal(adapter.workspacesData.length, 2)
  assert.equal(adapter.sent.length, 0)
})

test('Codex queue receipts support both session and thread output formats', async t => {
  const directory = sandbox(t)
  const executable = join(directory, 'codex-receipt.mjs')
  const messageId = '12345678-1234-1234-1234-123456789abc'
  const threadId = 'abcdefab-1234-1234-1234-abcdefabcdef'
  writeFileSync(join(directory, 'config.json'), JSON.stringify({ codexBin: executable }))
  for (const label of ['session', 'thread']) {
    writeFileSync(executable, `console.log('Queued message ${messageId} for ${label} ${threadId}.')\n`)
    const receipt = await queueToCodex(threadId, 'test')
    assert.equal(receipt.messageId, messageId)
    assert.equal(receipt.state, 'queued')
  }
})




async function gateway(t, directory) {
  const calls = []
  const workspaces = []
  const sessions = []
  const archivedSessionIds = []
  const accepted = new Set()
  const server = createServer(async (req, res) => {
    if (req.url === '/?token=test') { res.writeHead(302, { 'set-cookie': 'test=session; HttpOnly' }); res.end(); return }
    assert.match(req.headers.cookie, /test=session/)
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const message = JSON.parse(Buffer.concat(chunks).toString())
    calls.push(message)
    const args = message.payload.args
    const request = args.request
    let value
    switch (message.method) {
      case 'workspace/create': {
        let workspace = workspaces.find(item => item.path === request.path)
        const created = !workspace
        if (!workspace) { workspace = { workspaceId: `w${workspaces.length}`, path: request.path, title: 'default', sessionIds: [] }; workspaces.push(workspace) }
        value = { workspace, created }; break
      }
      case 'workspace/rename': {
        const workspace = workspaces.find(item => item.workspaceId === request.workspaceId)
        workspace.title = request.title; value = { workspace }; break
      }
      case 'session/list': value = { items: sessions }; break
      case 'session/create': {
        if (!sessions.find(item => item.sessionId === request.sessionId)) {
          const workspace = workspaces.find(item => item.workspaceId === request.workspaceId)
          sessions.push({ sessionId: request.sessionId, cwd: workspace?.path || request.cwd })
          workspace?.sessionIds.push(request.sessionId)
        }
        value = { sessionId: request.sessionId }; break
      }
      case 'session/rename': value = { title: request.title }; break
      case 'session/prompt': accepted.add(request.requestId); value = { accepted: true }; break
      case 'workspace/archiveSession': archivedSessionIds.push(request.sessionId); value = { archivedSessionIds }; break
      default: throw new Error(`unexpected ${message.method}`)
    }
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ result: { ok: true, value } }))
  })
  const ws = new WebSocketServer({ server, path: '/api/remote.mux' })
  ws.on('connection', socket => socket.on('message', data => {
    const frame = JSON.parse(data.toString())
    if (frame.type !== 'open') return
    assert.equal(frame.endpoint, 'workspace/follow')
    socket.send(JSON.stringify({ type: 'item', streamId: frame.streamId, value: { type: 'baseline', value: { items: workspaces, archivedSessionIds } } }))
  }))
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  writeFileSync(join(directory, 'web-url.txt'), `http://127.0.0.1:${server.address().port}/?token=test`)
  t.after(async () => { for (const client of ws.clients) client.terminate(); ws.close(); await new Promise(resolve => server.close(resolve)) })
  return { calls, workspaces, sessions, accepted }
}

test('DSH transport: real registry baseline, create/adopt, workspace attachment and stable request IDs', async t => {
  const directory = sandbox(t)
  const remote = await gateway(t, directory)
  const adapter = new DshAdapter()
  const path = join(directory, 'project')
  await assert.rejects(adapter.createWorkspace({ path }), /ENOENT/)
  const first = await adapter.createWorkspace({ path, createDirectory: true, title: 'Test' })
  assert.equal(first.created, true)
  assert.equal((await adapter.createWorkspace({ path })).created, false)
  assert.equal((await adapter.workspaces())[0].title, 'Test')
  const session = await adapter.createSession(first.workspace, { title: 'Task' })
  assert.equal((await adapter.sessions())[0].workspaceId, first.workspace.workspaceId)
  await adapter.send(session, 'same message', 'stable-id')
  await adapter.send(session, 'same message', 'stable-id')
  assert.equal(remote.accepted.size, 1)
  const operations = new PeerOperations('dsh', { sourceSession: 'source', adapter })
  const before = remote.calls.length
  await assert.rejects(operations.send({ workspace: first.workspace.workspaceId, session: 'typo' }, 'x'), /不存在/)
  assert.ok(remote.calls.slice(before).every(call => call.method !== 'session/create'))
  await adapter.archiveSession(session.sessionId, true)
  assert.equal((await adapter.sessions()).length, 0)
  assert.equal((await adapter.sessions({ archived: true })).length, 1)
})

test('Codex RPC adapter paginates and persists project/session management without starting turns', async t => {
  const directory = sandbox(t)
  const executable = join(directory, 'codex-mock.mjs')
  const store = join(directory, 'mock-state.json')
  writeFileSync(store, JSON.stringify({ projects: [], threads: [], calls: [] }))
  writeFileSync(executable, `#!${process.execPath}
import {readFileSync,writeFileSync} from 'node:fs';import{createInterface}from'node:readline';
const path=${JSON.stringify(store)};
createInterface({input:process.stdin}).on('line',line=>{
 const msg=JSON.parse(line); if(msg.id===undefined)return;
 const state=JSON.parse(readFileSync(path));state.calls.push(msg);let result={};const p=msg.params;
 switch(msg.method){
 case'project/list':{const offset=Number(p.cursor||0);result={data:state.projects.slice(offset,offset+1),nextCursor:state.projects.length>offset+1?String(offset+1):null};break;}
 case'project/create':{const project={id:'p'+state.projects.length,name:p.name,roots:p.roots};state.projects.push(project);result={project};break;}
 case'project/update':{const project=state.projects.find(x=>x.id===p.projectId);project.name=p.name;result={project};break;}
 case'project/read':result={project:state.projects.find(x=>x.id===p.projectId)};break;
 case'thread/list':result={data:p.archived?state.threads.filter(x=>x.archived):[],nextCursor:null};break;
 case'thread/read':result={thread:state.threads.find(x=>x.id===p.threadId)};break;
 case'thread/start':{const thread={id:'t'+state.threads.length,cwd:p.cwd,projectId:p.projectId};state.threads.push(thread);result={thread};break;}
 case'thread/name/set':state.threads.find(x=>x.id===p.threadId).name=p.name;break;
 case'thread/archive':state.threads.find(x=>x.id===p.threadId).archived=true;break;
 case'thread/unarchive':state.threads.find(x=>x.id===p.threadId).archived=false;break;
 }
 writeFileSync(path,JSON.stringify(state));console.log(JSON.stringify({id:msg.id,result}));
});
`, { mode: 0o755 })
  writeFileSync(join(directory, 'config.json'), JSON.stringify({ codexBin: executable }))
  const adapter = new CodexAdapter()
  mkdirSync(join(directory, 'project1'))
  mkdirSync(join(directory, 'project2'))
  const first = await adapter.createWorkspace({ path: join(directory, 'project1'), title: 'First' })
  assert.equal(first.backendRegistered, true)
  assert.equal(first.completed, false)
  assert.equal(first.workspace.desktopSync.liveUiVerified, false)
  await adapter.createWorkspace({ path: join(directory, 'project2') })
  assert.equal((await adapter.workspaces()).length, 2)
  const repeated = await adapter.createWorkspace({ path: join(directory, 'project1') })
  assert.equal(repeated.created, false)
  assert.equal(repeated.workspace.workspaceId, first.workspace.workspaceId)
  assert.equal(repeated.completed, false)
  await adapter.renameWorkspace(first.workspace.workspaceId, 'Renamed')
  const session = await adapter.createSession(first.workspace, { title: 'Task' })
  assert.equal((await adapter.sessions())[0].title, 'Task')
  await adapter.archiveSession(session.sessionId, true)
  assert.equal((await adapter.sessions()).length, 0)
  await adapter.archiveSession(session.sessionId, false)
  assert.equal((await adapter.sessions()).length, 1)
  const state = JSON.parse(readFileSync(store))
  assert.ok(!state.calls.some(call => call.method === 'turn/start'))
  const create = state.calls.find(call => call.method === 'project/create')
  assert.ok(create.params.idempotencyKey.startsWith('peerbridge-'))
  assert.equal(state.threads[0].projectId, first.workspace.workspaceId)

  const previousHome = process.env.CODEX_HOME
  process.env.CODEX_HOME = directory
  t.after(() => { if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome })
  const desktop = join(directory, 'desktop-mock.mjs')
  writeFileSync(desktop, `#!${process.execPath}
import {readFileSync,writeFileSync} from 'node:fs';import{basename,join}from'node:path';
const statePath=${JSON.stringify(store)}, home=${JSON.stringify(directory)};
const path=new URL(process.argv[2]).searchParams.get('path');
const state=JSON.parse(readFileSync(statePath));const id='p'+state.projects.length;
state.projects.push({id,name:basename(path),roots:[{path}]});state.desktopLaunches=(state.desktopLaunches||0)+1;state.desktopNodeFlag=process.env.ELECTRON_RUN_AS_NODE||null;
writeFileSync(statePath,JSON.stringify(state));
const cachePath=join(home,'.codex-global-state.json');let cache;try{cache=JSON.parse(readFileSync(cachePath))}catch{cache={'local-projects':{},'app-server-project-id-by-legacy-project-id-by-host':{}}}
cache['local-projects']['ui-'+id]={id:'ui-'+id,name:basename(path),rootPaths:[path]};
(cache['app-server-project-id-by-legacy-project-id-by-host']['local:'+home]||={})['ui-'+id]=id;
writeFileSync(cachePath,JSON.stringify(cache));
`, { mode: 0o755 })
  writeFileSync(join(directory, 'config.json'), JSON.stringify({ codexBin: executable, codexDesktopBin: desktop }))
  const previousNodeFlag = process.env.ELECTRON_RUN_AS_NODE
  process.env.ELECTRON_RUN_AS_NODE = '1'
  t.after(() => { if (previousNodeFlag === undefined) delete process.env.ELECTRON_RUN_AS_NODE; else process.env.ELECTRON_RUN_AS_NODE = previousNodeFlag })
  const uiPath = join(directory, 'ui-project')
  const uiCreated = await adapter.createWorkspace({ path: uiPath, createDirectory: true })
  assert.equal(uiCreated.completed, true)
  assert.equal(uiCreated.workspace.desktopSync.state, 'registered')
  assert.equal(uiCreated.workspace.desktopSync.desktopProjectId, 'ui-p2')
  const rename = await new PeerOperations('codex', { adapter }).execute('peer_rename_workspace', {
    workspace: uiCreated.workspace.workspaceId, title: 'Backend rename',
  })
  assert.equal(rename.backendUpdated, true)
  assert.equal(rename.completed, false)
  assert.equal(rename.workspace.desktopSync.displayTitle, 'ui-project')
  assert.equal((await adapter.createWorkspace({ path: uiPath })).created, false)
  const titleMismatch = await adapter.createWorkspace({ path: join(directory, 'title-project'), createDirectory: true, title: 'Friendly title' })
  assert.equal(titleMismatch.completed, false)
  assert.equal(titleMismatch.titleApplied, false)
  assert.equal(titleMismatch.workspace.title, 'title-project')
  const finalState = JSON.parse(readFileSync(store))
  assert.equal(finalState.desktopLaunches, 2)
  assert.equal(finalState.desktopNodeFlag, null)
  assert.equal(finalState.calls.filter(call => call.method === 'project/create').length, 2)
  assert.equal((await adapter.createWorkspace({ path: join(directory, 'project1') })).completed, false)
  await assert.rejects(waitForDesktopProject('/unregistered', { timeoutMs: 2 }), { code: 'DESKTOP_REGISTRATION_TIMEOUT' })
  await assert.rejects(waitForDesktopProject('/unregistered', { signal: AbortSignal.abort(new Error('cancelled')) }), /cancelled/)
})

test('actual Codex creates, lists, renames, archives and restores an empty session in an isolated CODEX_HOME', {
  skip: !process.env.PEERBRIDGE_TEST_CODEX_BIN,
}, async t => {
  const directory = sandbox(t)
  const previous = process.env.CODEX_HOME
  process.env.CODEX_HOME = join(directory, 'codex-home')
  mkdirSync(process.env.CODEX_HOME)
  t.after(() => { if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous })
  writeFileSync(join(directory, 'config.json'), JSON.stringify({ codexBin: process.env.PEERBRIDGE_TEST_CODEX_BIN }))
  const adapter = new CodexAdapter()
  const created = await adapter.createWorkspace({ path: join(directory, 'project'), createDirectory: true, title: 'Isolated test project' })
  assert.equal((await adapter.createWorkspace({ path: created.workspace.path })).created, false)
  const session = await adapter.createSession(created.workspace, { title: 'Empty test session' })
  assert.equal((await adapter.sessions())[0].sessionId, session.sessionId)
  assert.equal((await adapter.sessions())[0].workspaceId, created.workspace.workspaceId)
  await adapter.renameSession(session.sessionId, 'Renamed test session')
  assert.equal((await adapter.sessions())[0].title, 'Renamed test session')
  await adapter.renameWorkspace(created.workspace.workspaceId, 'Renamed test project')
  assert.equal((await adapter.workspaces())[0].title, 'Renamed test project')
  await adapter.archiveSession(session.sessionId, true)
  assert.equal((await adapter.sessions()).length, 0)
  assert.equal((await adapter.sessions({ archived: true }))[0].sessionId, session.sessionId)
  await adapter.archiveSession(session.sessionId, false)
  assert.equal((await adapter.sessions())[0].sessionId, session.sessionId)
})

test('actual DSH gateway uses explicit targets for create, rename, archive and restore', {
  skip: !process.env.PEERBRIDGE_TEST_DSH_BIN,
  timeout: 30000,
}, async t => {
  const directory = sandbox(t)
  const child = spawn(process.execPath, [process.env.PEERBRIDGE_TEST_DSH_BIN, 'web', '--no-open', '--port', '0'], {
    cwd: directory, env: { ...process.env, HOME: directory, DSH_HOME: join(directory, 'dsh-home') },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(async () => { const done = once(child, 'exit'); child.kill(); await done })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('isolated DSH startup timeout')), 20000)
    let log = ''
    const read = data => {
      log += data.toString()
      const match = /http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s\x1b]+/.exec(log)
      if (!match) return
      writeFileSync(join(directory, 'web-url.txt'), match[0])
      clearTimeout(timer); resolve()
    }
    child.stdout.on('data', read)
    child.stderr.on('data', read)
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`isolated DSH exited ${code}: ${log.replace(/token=[^\s]+/g, 'token=REDACTED').slice(-1500)}`)) })
  })
  const operations = new PeerOperations('dsh')
  const created = await operations.execute('peer_create_workspace', { path: join(directory, 'project'), createDirectory: true, title: 'Isolated test project' })
  assert.equal(created.created, true)
  assert.equal((await operations.execute('peer_workspaces')).workspaces[0].workspaceId, created.workspace.workspaceId)
  const workspaceId = created.workspace.workspaceId
  const session = (await operations.execute('peer_create_session', { workspace: workspaceId, title: 'Empty test session' })).session
  const target = { workspace: workspaceId, session: session.sessionId }
  assert.equal((await operations.execute('peer_sessions', { workspace: workspaceId })).sessions[0].sessionId, session.sessionId)
  await operations.execute('peer_rename_session', { ...target, title: 'Renamed test session' })
  assert.equal((await operations.execute('peer_sessions', { workspace: workspaceId })).sessions[0].title, 'Renamed test session')
  await operations.execute('peer_rename_workspace', { workspace: created.workspace.workspaceId, title: 'Renamed test project' })
  await operations.execute('peer_archive_session', { ...target, archived: true })
  assert.equal((await operations.execute('peer_sessions', { workspace: workspaceId })).sessions.length, 0)
  assert.equal((await operations.execute('peer_sessions', { workspace: workspaceId, archived: true })).sessions[0].sessionId, session.sessionId)
  await operations.execute('peer_archive_session', { ...target, archived: false })
  assert.equal((await operations.target(target)).sessionId, session.sessionId)
  await assert.rejects(operations.target({}), /workspace/)
})
