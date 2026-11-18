import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { readConfig } from './state.js'
import { cliCommand } from './cli-command.js'
import { defaultCodexBin } from './codex-client.js'

export function desktopExecutable(options = {}) {
  const config = readConfig()
  if (config.codexDesktopBin === false) return null
  if (typeof config.codexDesktopBin === 'string') return config.codexDesktopBin
  if (process.platform !== 'linux' || config.codexSocket
    || (options.codexBin || config.codexBin || defaultCodexBin()) !== '/usr/lib/chatgpt/resources/codex'
    || (options.codexHome && resolve(options.codexHome) !== join(homedir(), '.codex'))
    || (process.env.CODEX_HOME && resolve(process.env.CODEX_HOME) !== join(homedir(), '.codex'))) return null
  return existsSync('/usr/bin/chatgpt') && readDesktopProjects().available ? '/usr/bin/chatgpt' : null
}

export async function openDesktopProject(executable, path, { signal } = {}) {
  signal?.throwIfAborted()
  const url = new URL('codex://new')
  url.searchParams.set('path', path)
  const env = { ...process.env }
  // DSH runs Node through Electron; do not pass its Node flag to the GUI.
  delete env.ELECTRON_RUN_AS_NODE
  await new Promise((resolve, reject) => {
    const cli = cliCommand(executable, [url.href])
    const child = spawn(cli.command, cli.args, { env, detached: true, stdio: 'ignore' })
    child.once('error', error => reject(new Error(`Codex 桌面工程入口失败: ${error.message}`)))
    child.once('spawn', () => { child.unref(); resolve() })
  })
}

export async function waitForDesktopProject(path, { signal, timeoutMs = 30000, codexHome } = {}) {
  const deadline = Date.now() + timeoutMs
  do {
    signal?.throwIfAborted()
    const snapshot = readDesktopProjects(codexHome)
    const matching = snapshot.available ? snapshot.projects.filter(item => Array.isArray(item?.rootPaths) && item.rootPaths.length === 1 && item.rootPaths[0] === path) : []
    if (matching.length > 1) throw new Error('桌面目录对应多个工程，请明确指定工程 ID')
    if (matching.length === 1 && snapshot.ids[matching[0].id]) {
      return { projectId: snapshot.ids[matching[0].id], snapshot }
    }
    await delay(Math.min(200, Math.max(1, deadline - Date.now())), undefined, { signal })
  } while (Date.now() < deadline)
  const error = new Error('等待 Codex 桌面登记超时；如有目录信任提示请在客户端处理，然后用 peer_workspaces 查询。不要重复创建。')
  error.code = 'DESKTOP_REGISTRATION_TIMEOUT'
  throw error
}

// A separate app-server cannot publish into the desktop's in-memory project
// catalog. Read its persisted registration only; never mutate this app-owned file.
export function readDesktopProjects(home = process.env.CODEX_HOME || join(homedir(), '.codex')) {
  try {
    const state = JSON.parse(readFileSync(join(home, '.codex-global-state.json'), 'utf8'))
    if (!state['local-projects'] || typeof state['local-projects'] !== 'object' || Array.isArray(state['local-projects'])) {
      return { available: false, reason: 'unsupported-desktop-state' }
    }
    let canonicalHome = resolve(home)
    try { canonicalHome = realpathSync(home) } catch { /* The state file may disappear during shutdown. */ }
    const mappings = state['app-server-project-id-by-legacy-project-id-by-host']
    return {
      available: true,
      projects: Object.values(state['local-projects']),
      ids: mappings?.[`local:${canonicalHome}`] || {},
    }
  } catch (error) {
    return { available: false, reason: error.code === 'ENOENT' ? 'desktop-state-not-found' : 'desktop-state-unreadable' }
  }
}

export function desktopProjectStatus(project, snapshot) {
  const base = { verification: 'persisted-desktop-state', liveUiVerified: false }
  if (!snapshot.available) return { ...base, state: 'unavailable', reason: snapshot.reason }
  const paths = project.roots.map(root => root.path)
  const matching = snapshot.projects.filter(item => item && Array.isArray(item.rootPaths)
    && item.rootPaths.length === paths.length && paths.every(path => item.rootPaths.includes(path)))
  const registered = matching.filter(item => snapshot.ids[item.id] === project.id)
  if (registered.length === 1) return {
    ...base, state: 'registered', desktopProjectId: registered[0].id,
    displayTitle: registered[0].name, titleMatches: registered[0].name === project.name,
  }
  return { ...base, state: matching.length ? 'identity-mismatch' : 'missing' }
}

export function workspaceCreationReceipt(workspace, created, requestedTitle) {
  const desktopRegistered = workspace.desktopSync.state === 'registered'
  const titleApplied = !requestedTitle || workspace.title === requestedTitle
  return {
    workspace, created, backendRegistered: true,
    completed: desktopRegistered && workspace.desktopSync.titleMatches === true && titleApplied,
    ...(requestedTitle ? { titleApplied, requestedTitle } : {}),
    warning: !desktopRegistered
      ? '工程已在后台登记，但 Codex 桌面界面尚未确认同步。不要报告界面创建成功，也不要重复创建；请先用 peer_workspaces 查询已有工程 ID。'
      : !titleApplied ? '工程已通过桌面端登记；桌面入口使用目录名，自定义工程标题尚未应用。'
        : workspace.desktopSync.titleMatches !== true ? '工程已登记，但后台名称与桌面显示名称尚未同步。' : undefined,
  }
}
