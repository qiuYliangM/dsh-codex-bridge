import { adapterFor } from './adapters.js'
import { requireText } from './state.js'

export const workspaceParameter = { type: 'string', required: true, description: 'Exact workspaceId or absolute path from peer_workspaces.' }
export const sessionParameter = { type: 'string', required: true, description: 'Exact sessionId belonging to workspace, from peer_sessions or peer_create_session.' }

export const operationTools = [
  ['peer_status', 'Check peer connectivity and supported operations. Routing always requires explicit workspace and session arguments.', {}],
  ['peer_workspaces', 'List peer backend registered projects/workspaces, including empty ones. Codex desktopSync reports persisted desktop registration separately; live UI synchronization is unverified. Use the returned workspaceId or exact absolute path.', {}],
  ['peer_create_workspace', 'Register a local directory as a peer project; optionally create the directory. On the local Codex desktop, open its project entry and wait for matching desktop/backend IDs. This selects the new project in the desktop. Codex desktop titles default to the directory name; a different requested title returns titleApplied:false and completed:false. Backend-only or previously orphaned registrations also return completed:false: do not claim UI success or create duplicates. Returns its ID; no session or message is created and no routing default is saved.', {
    path: { type: 'string', required: true, description: 'Absolute local directory path.' },
    title: { type: 'string' }, createDirectory: { type: 'boolean', description: 'Explicitly allow creating directories (default false).' },
  }],
  ['peer_rename_workspace', 'Rename an explicitly identified peer backend project; does not move its directory. Codex reports completed:false when its desktop title has not synchronized.', {
    workspace: workspaceParameter, title: { type: 'string', required: true },
  }],
  ['peer_sessions', 'List sessions belonging to the explicitly supplied peer workspace. Use archived: true to list archived sessions. Codex desktopSync distinguishes the native list from bridge-only empty sessions; it does not verify the live UI.', {
    workspace: workspaceParameter, archived: { type: 'boolean' },
  }],
  ['peer_create_session', 'Create an empty session in the explicitly supplied registered project. Returns its ID; no prompt is sent and no routing default is saved. Codex may hide empty sessions: created:true confirms backend creation, while completed:false and desktopSync report unverified UI visibility. Do not create duplicates; use the returned ID for sending, or open desktopSync.openUrl if available.', {
    workspace: workspaceParameter, title: { type: 'string' },
  }],
  ['peer_rename_session', 'Rename the explicitly identified peer session. It must belong to the supplied workspace.', {
    workspace: workspaceParameter, session: sessionParameter, title: { type: 'string', required: true },
  }],
  ['peer_archive_session', 'Archive or restore the explicitly identified peer session in the supplied workspace. Does not delete files or history.', {
    workspace: workspaceParameter, session: sessionParameter, archived: { type: 'boolean', required: true },
  }],
]

export class TargetError extends Error {
  constructor(code, message, details, nextTools) {
    super(message)
    this.code = code
    this.details = details
    this.nextTools = nextTools
  }
}

export class PeerOperations {
  constructor(peer, { sourceSession, signal, adapter } = {}) {
    this.peer = peer
    this.sourceSession = sourceSession
    this.adapter = adapter || adapterFor(peer, { signal })
  }

  async workspace(selector) {
    selector = requireText(selector, 'workspace')
    const workspaces = await this.adapter.workspaces()
    const matches = workspaces.filter(item => item.workspaceId === selector || item.path === selector || item.paths?.includes(selector))
    if (matches.length > 1) throw new TargetError('WORKSPACE_AMBIGUOUS', '目录匹配多个工程，请从 peer_workspaces 返回值中明确指定 workspaceId', { workspace: selector }, ['peer_workspaces'])
    if (!matches.length) throw new TargetError('WORKSPACE_NOT_FOUND', '工作区不存在，请调用 peer_workspaces 查询，或 peer_create_workspace 新建', { workspace: selector }, ['peer_workspaces', 'peer_create_workspace'])
    return matches[0]
  }

  async target(args, archived = false) {
    const selector = requireText(args.workspace, 'workspace')
    const id = requireText(args.session, 'session')
    const workspace = await this.workspace(selector)
    const target = (await this.adapter.sessions({ archived })).find(item => item.sessionId === id)
    if (!target) throw new TargetError('SESSION_NOT_FOUND', `会话 ${id} 不存在或${archived ? '未归档' : '已归档'}，请调用 peer_sessions 查询，或 peer_create_session 新建`, { workspaceId: workspace.workspaceId, sessionId: id, archived }, ['peer_sessions', 'peer_create_session'])
    if (target.workspaceId !== workspace.workspaceId) {
      throw new TargetError('TARGET_MISMATCH', '会话不属于指定工程，请重新确认 workspace 和 session', {
        workspaceId: workspace.workspaceId, sessionId: id, actualWorkspaceId: target.workspaceId ?? null,
      }, ['peer_workspaces', 'peer_sessions'])
    }
    return target
  }

  async execute(name, args = {}) {
    if (args.title !== undefined) requireText(args.title, 'title')
    switch (name) {
      case 'peer_status': return {
        peer: this.peer, connected: true, routing: 'explicit',
        capabilities: [...operationTools.map(tool => tool[0]), 'peer_send', 'peer_ask', 'peer_answer', 'peer_events'],
        workspaces: (await this.adapter.workspaces()).length,
      }
      case 'peer_workspaces': return { workspaces: await this.adapter.workspaces() }
      case 'peer_create_workspace': return this.adapter.createWorkspace(args)
      case 'peer_rename_workspace': {
        const workspace = await this.workspace(args.workspace)
        const renamed = await this.adapter.renameWorkspace(workspace.workspaceId, requireText(args.title, 'title'))
        const completed = renamed.desktopSync?.state === 'registered' && renamed.desktopSync.titleMatches === true
        return { workspace: renamed, ...(this.peer === 'codex' ? {
          backendUpdated: true, completed,
          ...(!completed ? { warning: '后台名称已更新，但 Codex 桌面显示名称尚未确认同步。' } : {}),
        } : {}) }
      }
      case 'peer_sessions': {
        const workspace = await this.workspace(args.workspace)
        const sessions = (await this.adapter.sessions({ archived: args.archived === true })).filter(item => item.workspaceId === workspace.workspaceId)
        return { sessions, workspaceId: workspace.workspaceId }
      }
      case 'peer_create_session': {
        const workspace = await this.workspace(args.workspace)
        const session = await this.adapter.createSession(workspace, args)
        return { created: true, session, ...(this.peer === 'codex' ? {
          backendCreated: true, completed: false,
          warning: session.desktopSync?.nativeListVisible === false
            ? '空会话已在后台创建，但 Codex 原生列表尚未收录，桥接列表不等于侧栏。请使用已返回的会话 ID；发送后会请求唤起匹配的本机桌面。不要重复创建。'
            : '会话已在后台创建；尚未核验 Codex 实时界面，不要报告侧栏同步完成或重复创建。',
        } : {}) }
      }
      case 'peer_rename_session': {
        const target = await this.target(args)
        const title = requireText(args.title, 'title')
        await this.adapter.renameSession(target.sessionId, title)
        return { workspaceId: target.workspaceId, sessionId: target.sessionId, title }
      }
      case 'peer_archive_session': {
        if (typeof args.archived !== 'boolean') throw new Error('archived 必须是布尔值')
        const target = await this.target(args, !args.archived)
        await this.adapter.archiveSession(target.sessionId, args.archived)
        return { workspaceId: target.workspaceId, sessionId: target.sessionId, archived: args.archived }
      }
      default: throw new Error(`未知管理操作 ${name}`)
    }
  }

  async send(args, text) {
    const target = await this.target(args)
    const source = args.sourceSession || this.sourceSession
    const label = this.peer === 'dsh' ? 'ChatGPT/Codex' : 'DeepSeek Harness'
    const receipt = await this.adapter.send(target,
      `【来自 ${label}${source ? ` · 会话 ${source}` : ''}】\n${text}`, args.requestId)
    return { ...receipt, accepted: true, deliveryConfirmed: false, completed: false, workspaceId: target.workspaceId, sessionId: target.sessionId }
  }
}
