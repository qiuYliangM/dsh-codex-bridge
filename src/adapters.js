import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { basename, isAbsolute, join } from 'node:path'
import { DshClient } from './dsh-client.js'
import { withCodex, queueToCodex } from './codex-client.js'
import { desktopExecutable, desktopProjectStatus, desktopSessionExecutable, desktopSessionUrl, openDesktopProject, readDesktopProjects, waitForDesktopProject, wakeDesktopSession, workspaceCreationReceipt } from './codex-desktop.js'
import { dataDir, readJson, requireText, writeJson } from './state.js'

function localDirectory(path, createDirectory) {
  requireText(path, 'path')
  if (!isAbsolute(path)) throw new Error('path 必须是本机绝对路径')
  if (createDirectory === true) mkdirSync(path, { recursive: true })
  if (!statSync(path).isDirectory()) throw new Error('path 必须指向目录')
  return realpathSync(path)
}

function dshWorkspace(value) {
  return { ...value, workspace: value.path, registered: true }
}

function codexWorkspace(value, snapshot = readDesktopProjects()) {
  return {
    workspaceId: value.id, workspace: value.roots[0]?.path, path: value.roots[0]?.path,
    paths: value.roots.map(root => root.path), title: value.name, registered: true,
    desktopSync: desktopProjectStatus(value, snapshot),
  }
}

function codexSession(value) {
  return {
    sessionId: value.id, workspaceId: value.projectId, cwd: value.cwd,
    title: value.name || value.preview, updatedAt: value.updatedAt,
    running: value.status?.type === 'active',
  }
}

async function pages(client, method, params = {}) {
  const items = []
  let cursor
  const seen = new Set()
  do {
    const result = await client.call(method, { ...params, limit: 100, ...(cursor ? { cursor } : {}) })
    if (!Array.isArray(result.data)) throw new Error(`Codex ${method} 列表格式错误`)
    items.push(...result.data)
    cursor = result.nextCursor
    if (cursor && seen.has(cursor)) throw new Error(`Codex ${method} 返回重复分页游标`)
    seen.add(cursor)
  } while (cursor)
  return items
}

export class DshAdapter {
  constructor(options = {}) { this.options = options }
  client() { return new DshClient(this.options) }
  withSignal(signal) { return new DshAdapter({ ...this.options, signal }) }

  async workspaces() {
    const baseline = await this.client().baseline()
    return baseline.items.map(dshWorkspace)
  }

  async createWorkspace(args) {
    const path = localDirectory(args.path, args.createDirectory)
    const client = this.client()
    const result = await client.call('workspace/create', { request: { path } })
    let workspace = result.workspace
    if (args.title && result.created) {
      try { workspace = (await client.call('workspace/rename', { request: { workspaceId: workspace.workspaceId, title: args.title } })).workspace }
      catch (error) { throw new Error(`工作区已创建 ${workspace.workspaceId} (${path})，但命名失败: ${error.message}`) }
    }
    return { workspace: dshWorkspace(workspace), created: result.created }
  }

  async renameWorkspace(workspaceId, title) {
    const result = await this.client().call('workspace/rename', { request: { workspaceId, title } })
    return dshWorkspace(result.workspace)
  }

  async sessions({ archived = false } = {}) {
    const client = this.client()
    const [baseline, result] = await Promise.all([
      client.baseline(), client.call('session/list', { _request: {} }),
    ])
    const archivedIds = new Set(baseline.archivedSessionIds)
    return result.items.filter(item => archivedIds.has(item.sessionId) === archived).map(item => ({
      sessionId: item.sessionId, cwd: item.cwd, running: item.running, blank: item.blank,
      updatedAt: item.updatedAt, title: item.projections?.values?.title,
      workspaceId: baseline.items.find(workspace => workspace.sessionIds.includes(item.sessionId))?.workspaceId,
      archived,
    }))
  }

  async createSession(workspace, args) {
    const client = this.client()
    const sessionId = `session-${randomUUID()}`
    await client.call('session/create', { request: { sessionId, workspaceId: workspace.workspaceId } })
    if (args.title) {
      try { await client.call('session/rename', { request: { sessionId, title: args.title } }) }
      catch (error) { throw new Error(`会话已创建 ${sessionId}，但命名失败: ${error.message}`) }
    }
    return { sessionId, workspaceId: workspace.workspaceId, cwd: workspace.path, title: args.title, archived: false }
  }

  async renameSession(sessionId, title) {
    await this.client().call('session/rename', { request: { sessionId, title } })
  }

  async archiveSession(sessionId, archived) {
    await this.client().call(`workspace/${archived ? 'archiveSession' : 'unarchiveSession'}`, { request: { sessionId } })
  }

  async send(target, text, requestId) {
    const client = this.client()
    // session/prompt resumes an existing cold session itself. Creating here
    // could recreate a target deleted after validation, outside its workspace.
    const result = await client.call('session/prompt', { request: {
      requestId: requestId || `peerbridge-${randomUUID()}`, sessionId: target.sessionId,
      mode: 'queue', content: [{ type: 'text', text }],
    } })
    if (result.accepted !== true) throw new Error('DSH 未确认入队')
    return { state: 'queued' }
  }
}

export class CodexAdapter {
  constructor(options = {}) { this.options = options }
  rpc(run) { return withCodex(this.options, run) }
  withSignal(signal) { return new CodexAdapter({ ...this.options, signal }) }

  async workspaces() {
    return this.rpc(async client => {
      const items = await pages(client, 'project/list')
      const snapshot = readDesktopProjects(this.options.codexHome)
      return items.map(item => codexWorkspace(item, snapshot))
    })
  }

  async createWorkspace(args) {
    const path = localDirectory(args.path, args.createDirectory)
    return this.rpc(async client => {
      const existing = (await pages(client, 'project/list')).filter(item => item.roots.some(root => root.path === path))
      if (existing.length > 1) throw new Error('该目录属于多个 Codex 工程，请通过工程 ID 选择')
      if (existing.length) return workspaceCreationReceipt(codexWorkspace(existing[0], readDesktopProjects(this.options.codexHome)), false)
      const executable = desktopExecutable(this.options)
      if (executable) {
        await openDesktopProject(executable, path, this.options)
        const registration = await waitForDesktopProject(path, this.options)
        const result = await client.call('project/read', { projectId: registration.projectId })
        if (result.project.roots.length !== 1 || result.project.roots[0].path !== path) throw new Error('桌面工程与后台工程目录不一致，拒绝确认创建成功')
        return workspaceCreationReceipt(codexWorkspace(result.project, registration.snapshot), true, args.title)
      }
      const result = await client.call('project/create', {
        name: args.title || basename(path), roots: [{ path }],
        idempotencyKey: `peerbridge-${createHash('sha256').update(path).digest('hex')}`,
      })
      return workspaceCreationReceipt(codexWorkspace(result.project, readDesktopProjects(this.options.codexHome)), true, args.title)
    })
  }

  async renameWorkspace(projectId, name) {
    return this.rpc(async client => codexWorkspace((await client.call('project/update', { projectId, name })).project, readDesktopProjects(this.options.codexHome)))
  }

  async sessions({ archived = false } = {}) {
    return this.rpc(async client => {
      const items = await pages(client, 'thread/list', { archived, modelProviders: [] })
      const nativeIds = new Set(items.map(item => item.id))
      if (!archived) {
        const known = this.knownSessions()
        const missing = known.filter(id => !items.some(item => item.id === id))
        if (missing.length) {
          const archivedIds = new Set((await pages(client, 'thread/list', { archived: true, modelProviders: [] })).map(item => item.id))
          for (const threadId of missing) {
            if (archivedIds.has(threadId)) continue
            try {
              const result = await client.call('thread/read', { threadId, includeTurns: false })
              items.push(result.thread)
            } catch (error) {
              if (!/not found|does not exist|no rollout|unknown thread/i.test(error.message)) throw error
            }
          }
        }
      }
      return items.map(item => ({ ...codexSession(item), archived,
        desktopSync: this.sessionDesktopStatus(item.id, nativeIds.has(item.id)),
      }))
    })
  }

  sessionDesktopStatus(sessionId, nativeListVisible) {
    let openUrl
    try { if (desktopSessionExecutable(this.options)) openUrl = desktopSessionUrl(sessionId) } catch { /* No matching local desktop entry. */ }
    return {
      state: nativeListVisible === true ? 'listed' : nativeListVisible === false ? 'not-listed' : 'unverified',
      nativeListVisible, verification: 'app-server-thread-list', liveUiVerified: false,
      ...(openUrl ? { openUrl } : {}),
    }
  }

  knownSessions() {
    const directory = join(dataDir(), 'codex-sessions')
    let files
    try { files = readdirSync(directory) } catch (error) { if (error.code === 'ENOENT') return []; throw error }
    return files.filter(file => file.endsWith('.json')).map(file => readJson(join(directory, file), {}).sessionId).filter(Boolean)
  }

  rememberSession(sessionId) {
    const directory = join(dataDir(), 'codex-sessions')
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const key = createHash('sha256').update(sessionId).digest('hex')
    writeJson(join(directory, `${key}.json`), { sessionId })
  }

  async createSession(workspace, args) {
    return this.rpc(async client => {
      const result = await client.call('thread/start', { cwd: workspace.path, projectId: workspace.workspaceId })
      const session = codexSession(result.thread)
      // Codex omits empty unarchived threads from thread/list; re-read these IDs from the server.
      try { this.rememberSession(session.sessionId) }
      catch (error) {
        throw Object.assign(new Error(`Codex 会话已创建 ${session.sessionId}，但本地空会话索引保存失败: ${error.message}。请勿重复创建；该空会话暂可能不出现在列表中。`), {
          code: 'SESSION_CREATED_INDEX_FAILED',
          details: { created: true, completed: false, session, indexSaved: false },
        })
      }
      if (args.title) {
        try { await client.call('thread/name/set', { threadId: session.sessionId, name: args.title }) }
        catch (error) { throw new Error(`会话已创建 ${session.sessionId}，但命名失败: ${error.message}`) }
      }
      let nativeListVisible = null
      try { nativeListVisible = (await pages(client, 'thread/list', { archived: false, modelProviders: [] })).some(item => item.id === session.sessionId) }
      catch { /* Creation succeeded; a failed visibility probe must not invite duplicate creation. */ }
      return { ...session, title: args.title || session.title, archived: false,
        desktopSync: this.sessionDesktopStatus(session.sessionId, nativeListVisible),
      }
    })
  }

  async renameSession(threadId, name) {
    await this.rpc(client => client.call('thread/name/set', { threadId, name }))
  }

  async archiveSession(threadId, archived) {
    await this.rpc(client => client.call(archived ? 'thread/archive' : 'thread/unarchive', { threadId }))
  }

  async send(target, text) {
    const receipt = await queueToCodex(target.sessionId, text, this.options.signal, this.options)
    // Queue acceptance alone leaves a cold, empty thread invisible and idle.
    // Request the desktop's existing background wake after the message is saved.
    // A wake failure must retain the queue receipt so callers do not resend it.
    try {
      const executable = desktopSessionExecutable(this.options)
      if (executable) {
        await wakeDesktopSession(executable, target.sessionId, this.options)
        return { ...receipt, desktopActivation: { state: 'requested', confirmed: false } }
      }
      return { ...receipt, desktopActivation: { state: 'unavailable', confirmed: false },
        warning: '消息已排队，但当前没有匹配的本机 Codex 桌面入口。冷会话可能仍需由用户或宿主恢复；请勿重复发送。',
      }
    } catch (error) {
      return { ...receipt, desktopActivation: { state: 'failed', confirmed: false, error: error.message },
        warning: '消息已排队，但请求唤起 Codex 桌面失败。请打开已有会话或恢复宿主，不要重复发送消息。',
      }
    }
  }
}

export function adapterFor(peer, options) {
  if (peer === 'dsh') return new DshAdapter(options)
  if (peer === 'codex') return new CodexAdapter(options)
  throw new Error('peer 必须是 dsh 或 codex')
}
