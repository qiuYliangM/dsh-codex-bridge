import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { createServer } from 'node:net'
import { basename, dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { withCodex } from './codex-client.js'
import { dataDir } from './state.js'

function save(path, value) {
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
    renameSync(temp, path)
    chmodSync(path, 0o600)
  } finally { try { unlinkSync(temp) } catch (error) { if (error.code !== 'ENOENT') throw error } }
}

function load(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch (error) { if (error.code === 'ENOENT') return undefined; throw error }
}

// A PID alone can identify an unrelated process after a crash and PID reuse.
// Store the OS process birth identity where available; old records and hosts
// without such an API remain conservative when a PID is still alive.
function processBirth(pid) {
  try {
    if (process.platform === 'linux') {
      const fields = readFileSync(`/proc/${pid}/stat`, 'utf8').split(/\) /).at(-1).split(' ')
      return `linux:${readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()}:${fields[19]}`
    }
    if (process.platform === 'darwin') return `darwin:${execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 2000, env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' } }).trim()}`
    if (process.platform === 'win32') {
      const value = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`], { encoding: 'utf8', timeout: 2000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
      if (/^\d+$/.test(value)) return `win32:${value}`
    }
  } catch { /* Missing platform facilities must not permit stealing a live lock. */ }
}

function alive(owner) {
  if (!Number.isInteger(owner?.pid) || owner.pid <= 0) return false
  try { process.kill(owner.pid, 0) } catch (error) { if (error.code === 'ESRCH') return false }
  const birth = owner.processBirth && processBirth(owner.pid)
  return !birth || birth === owner.processBirth
}

async function semaphore(location, run) {
  // The OS releases this mutex on process exit. File-lock stale recovery alone
  // cannot compare-and-unlink atomically and can delete a new owner's lock.
  // Key by the config target, not this package's data directory: two installs
  // with different PEERBRIDGE_HOME values must still serialize that target.
  const digest = createHash('sha256').update(pathIdentity(location.home)).update('\0').update(location.serverName).digest()
  // Stay below normal ephemeral-client ranges to avoid outgoing loopback
  // connections/TIME_WAIT making an otherwise free target appear locked.
  const port = 16384 + digest.readUInt16BE(0) % 16384
  for (let retry = 0; ; retry++) {
    const server = createServer(socket => socket.destroy())
    try {
      await new Promise((resolve, reject) => {
        const failed = error => { server.off('listening', ready); reject(error) }
        const ready = () => { server.off('error', failed); resolve() }
        server.once('error', failed); server.once('listening', ready)
        server.listen({ host: '127.0.0.1', port, exclusive: true })
      })
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error
      if (retry >= 200) throw new Error(`Codex 配置更新互斥端口 ${port} 正忙，请稍后重试；未改用其他端口`)
      await delay(50); continue
    }
    try { return await run() }
    finally { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
  }
}

async function locked(location, run) {
  return semaphore(location, async () => {
    const path = location.path
    const lock = `${path}.lock`
    const candidate = `${lock}.${randomUUID()}.tmp`
    const identity = { pid: process.pid, processBirth: processBirth(process.pid), lockId: randomUUID(), codexHome: location.home, serverName: location.serverName }
    // Retain the old file-lock protocol to respect a running 0.5.1 plugin.
    // Publish its complete owner atomically, then immediately drop the helper.
    writeFileSync(candidate, JSON.stringify(identity), { mode: 0o600, flag: 'wx' })
    try {
      for (let retry = 0; ; retry++) {
        try { linkSync(candidate, lock) } catch (error) {
          if (error.code !== 'EEXIST') throw error
          try {
            const owner = load(lock)
            if (Number.isInteger(owner?.pid) && !alive(owner)) { unlinkSync(lock); continue }
            if (!Number.isInteger(owner?.pid) && Date.now() - statSync(lock).mtimeMs > 30000) { unlinkSync(lock); continue }
          } catch (error) {
            if (error.code === 'ENOENT') continue
            // Recover only old, malformed locks from the previous version.
            // Newly created locks may belong to that plugin mid-acquisition.
            if (error instanceof SyntaxError && Date.now() - statSync(lock).mtimeMs > 30000) { unlinkSync(lock); continue }
          }
          if (retry >= 200) throw new Error('另一个进程正在更新 Codex MCP 配置，请稍后重试')
          await delay(50); continue
        }
        unlinkSync(candidate)
        try { return await run() }
        finally { if (load(lock)?.lockId === identity.lockId) unlinkSync(lock) }
      }
    } finally { try { unlinkSync(candidate) } catch (error) { if (error.code !== 'ENOENT') throw error } }
  })
}

export function registrationLocation({ serverName = 'peerbridge', codexHome = process.env.CODEX_HOME || join(homedir(), '.codex'), directory = dataDir(), createDirectory = true } = {}) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(serverName)) throw new Error('mcpServerName 必须是 1–64 位字母、数字、下划线或连字符')
  const home = canonical(codexHome)
  const key = createHash('sha256').update(pathIdentity(home)).digest('hex').slice(0, 20)
  const dir = join(directory, 'registrations')
  if (createDirectory) mkdirSync(dir, { recursive: true, mode: 0o700 })
  return { path: join(dir, `${serverName}-${key}.json`), home, serverName }
}

function canonical(path) {
  const absolute = resolve(path)
  try { return realpathSync.native(absolute) } catch {
    const parent = dirname(absolute)
    return parent === absolute ? absolute : join(canonical(parent), basename(absolute))
  }
}

const pathIdentity = path => process.platform === 'win32' ? canonical(path).toLowerCase() : canonical(path)

export async function registrationSecret(options) {
  const location = registrationLocation(options)
  return locked(location, () => {
    const existing = load(location.path)
    if (existing && (existing.schema !== 1 || typeof existing.token !== 'string' || !/^[a-f0-9]{64}$/.test(existing.token))) throw new Error('桥接注册记录损坏，未修改 Codex 配置')
    const record = existing || { schema: 1, token: randomBytes(32).toString('hex'), codexHome: location.home, serverName: location.serverName, active: false }
    if (!existing) save(location.path, record)
    return record.token
  })
}

function ownsTransport(block, record) {
  return [record?.url, ...(record?.recoveryUrls || [])].some(url => typeof url === 'string' && block?.url === url) && typeof record?.token === 'string'
    && block?.http_headers?.Authorization === `Bearer ${record.token}`
}

const validRecord = record => record?.schema === 1 && typeof record.token === 'string' && /^[a-f0-9]{64}$/.test(record.token)
const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}'

function registrationArtifacts(location) {
  const prefix = basename(location.path).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`^${prefix}(\\.lock)?\\.${uuid}\\.tmp$`)
  let names
  try { names = readdirSync(dirname(location.path)) } catch (error) { if (error.code === 'ENOENT') return []; throw error }
  return names.filter(name => pattern.test(name)).map(name => {
    const path = join(dirname(location.path), name)
    try {
      const record = load(path)
      const lock = !!pattern.exec(name)[1]
      const matches = lock ? typeof record?.lockId === 'string' && Number.isInteger(record?.pid)
        : validRecord(record) && (!record.codexHome || pathIdentity(record.codexHome) === pathIdentity(location.home)) && (!record.serverName || record.serverName === location.serverName)
      return { path, record, removable: matches && !alive(record), lock, modified: statSync(path).mtimeMs }
    } catch { return { path, removable: false } }
  })
}

function cleanupArtifacts(location, { apply, profileDir } = {}) {
  const removed = [], retained = []
  for (const artifact of registrationArtifacts(location)) {
    const sameProfile = !profileDir || !artifact.record?.profileDir || pathIdentity(profileDir) === pathIdentity(artifact.record.profileDir)
    if (!artifact.removable || !sameProfile) { retained.push(artifact.path); continue }
    if (apply) unlinkSync(artifact.path)
    removed.push(artifact.path)
  }
  return { [apply ? 'removedArtifacts' : 'removableArtifacts']: removed, retainedArtifacts: retained }
}

function legacy(block, file, serverName) {
  // The retired CLI only owned this exact table name. A marker elsewhere in
  // the file must not authorize taking over another plugin's connection.
  if (serverName !== 'peerbridge') return false
  if (typeof block?.command !== 'string' || !/^node(?:\.exe)?$/i.test(basename(block.command)) || !Array.isArray(block.args)
    || block.args.length !== 1 || typeof block.args[0] !== 'string' || !/[\\/]bin[\\/]codex-mcp\.mjs$/.test(block.args[0])) return false
  // A user may retain the old marker while selecting an unrelated executable.
  // Verify the retired launcher itself rather than guessing from its filename.
  try {
    const launcher = readFileSync(block.args[0], 'utf8').replace(/\r\n/g, '\n').trim()
    if (launcher !== "#!/usr/bin/env node\n// PeerBridge Codex MCP bridge 启动器（stdio JSON-RPC）\nawait import('../src/codex/mcp.js')") return false
  } catch { return false }
  if (!existsSync(file)) return false
  const marker = '# PeerBridge: peer collaboration bridge (managed by peerbridge CLI; remove via peerbridge uninstall)'
  const lines = readFileSync(file, 'utf8').split(/\r?\n/)
  return lines.some((line, index) => line.trim() === marker
    && /^\[mcp_servers\.peerbridge\]\s*(?:#.*)?$/.test(lines.slice(index + 1).find(value => value.trim() && !value.trimStart().startsWith('#'))?.trim() || ''))
}

async function snapshot(client, home, serverName) {
  const read = await client.call('config/read', { includeLayers: true })
  const file = join(home, 'config.toml')
  const layer = read.layers?.find(layer => layer.name?.type === 'user' && pathIdentity(layer.name.file) === pathIdentity(file))
  if (!layer || typeof layer.version !== 'string') throw new Error('当前 Codex 未返回可校验版本的用户配置层，未修改配置')
  return { file, version: layer.version, block: layer.config?.mcp_servers?.[serverName], effectiveBlock: read.config?.mcp_servers?.[serverName] }
}

async function edit(client, state, serverName, value) {
  const written = await client.call('config/batchWrite', {
    filePath: state.file, expectedVersion: state.version,
    edits: [{ keyPath: `mcp_servers.${serverName}`, mergeStrategy: 'replace', value }],
    reloadUserConfig: true,
  })
  if (written.status !== 'ok') throw new Error('Codex 未确认 MCP 配置更新成功')
  // The bearer token is intentionally confined to the user's private config.
  chmodSync(state.file, 0o600)
  return written
}

const conflict = error => /version|conflict|concurrent/i.test(error.message)

export async function leaseCodexRegistration({ profileDir, url, token, codexHome, serverName = 'peerbridge', directory }) {
  const location = registrationLocation({ codexHome, serverName, directory })
  const ownerId = randomUUID()
  const profile = canonical(profileDir)
  await locked(location, () => {
    const previous = load(location.path)
    if (previous?.token !== token) throw new Error('MCP 注册密钥与当前记录不匹配')
    if (previous.active && alive(previous)) throw new Error('该 MCP 名称已由另一个活动 DSH 插件占用；请设置不同的 mcpServerName')
    if (previous.profileDir && pathIdentity(previous.profileDir) !== pathIdentity(profile)) throw new Error('该 MCP 名称属于另一 DSH profile；请设置不同的 mcpServerName')
    save(location.path, { ...previous, codexHome: location.home, serverName, profileDir: profile, ownerId,
      pid: process.pid, processBirth: processBirth(process.pid), active: true, url,
      recoveryUrls: [...new Set([previous.url, ...(previous.recoveryUrls || [])].filter(value => typeof value === 'string'))],
    })
  })
  return { location: location.path, async release() {
    return locked(location, () => {
      const record = load(location.path)
      if (record?.ownerId !== ownerId) return { removed: false, reason: 'ownership-changed' }
      save(location.path, { ...record, active: false })
      return { removed: false, reason: 'manual-registration-retained' }
    })
  } }
}

// Use Codex's own TOML parser/writer and expectedVersion compare-and-swap.
// No regex edits of user TOML; no project trust or model execution requests.
export async function configureCodex({ profileDir, url, token, codexBin, codexHome, serverName = 'peerbridge', directory, signal, rpc = withCodex }) {
  const location = registrationLocation({ codexHome, serverName, directory })
  const profile = resolve(profileDir)
  const ownerId = randomUUID()
  const options = { codexBin, codexHome: location.home, signal }
  mkdirSync(location.home, { recursive: true, mode: 0o700 })
  await locked(location, async () => {
    const previous = load(location.path)
    if (previous?.token !== token) throw new Error('MCP 注册密钥与当前记录不匹配')
    if (previous.active && previous.ownerId && alive(previous)) throw new Error('该 MCP 名称已由另一个活动 DSH 插件占用；请为另一 profile 设置不同的 mcpServerName')
    await rpc(options, async client => {
      for (let attempt = 0; ; attempt++) {
        signal?.throwIfAborted()
        const state = await snapshot(client, location.home, serverName)
        if (!state.block && state.effectiveBlock && !ownsTransport(state.effectiveBlock, previous)) {
          throw new Error(`Codex MCP ${serverName} 已由其他配置层提供，未覆盖；请设置不同的 mcpServerName`)
        }
        if (state.block && !ownsTransport(state.block, previous) && !legacy(state.block, state.file, serverName)) {
          throw new Error(`Codex MCP ${serverName} 已有其他连接，未覆盖；请设置不同的 mcpServerName`)
        }
        if (state.block && previous.profileDir && pathIdentity(previous.profileDir) !== pathIdentity(profile) && !legacy(state.block, state.file, serverName)) {
          throw new Error('该 MCP 名称属于另一 DSH profile，未替换其目标；请设置不同的 mcpServerName')
        }
        const block = { ...state.block }
        for (const key of ['command', 'args', 'env', 'env_vars', 'cwd', 'bearer_token_env_var', 'env_http_headers', 'http_headers_helper', 'auth', 'oauth']) delete block[key]
        Object.assign(block, { url, http_headers: { ...block.http_headers, Authorization: `Bearer ${token}` }, enabled: block.enabled ?? true, tool_timeout_sec: block.tool_timeout_sec ?? 910 })
        // Save the recovery intent before the config write. A killed process
        // leaves an attributable transport which the same profile can recover.
        const record = { ...previous, schema: 1, token, url, serverName, codexHome: location.home, profileDir: profile, ownerId, pid: process.pid, processBirth: processBirth(process.pid), active: false, pending: true,
          recoveryUrls: [...new Set([previous.url, ...(previous.recoveryUrls || [])].filter(value => typeof value === 'string'))],
          previousBlock: previous.previousBlock ?? state.block ?? null }
        save(location.path, record)
        try {
          await edit(client, state, serverName, block)
          save(location.path, { ...record, recoveryUrls: [], active: true, pending: false })
          return
        } catch (error) {
          if (attempt < 2 && conflict(error)) continue
          throw error
        }
      }
    })
  })
  return {
    location: location.path,
    async release() {
      // Disposal is independent of the request lifetime: disabling a plugin
      // first cancels calls, then still needs a working config writer.
      return locked(location, async () => {
        const record = load(location.path)
        if (record?.ownerId !== ownerId) return { removed: false, reason: 'ownership-changed' }
        try {
          const result = await rpc({ codexBin, codexHome: location.home }, async client => {
            for (let attempt = 0; ; attempt++) {
              const state = await snapshot(client, location.home, serverName)
              if (!state.block) return { removed: true }
              if (!ownsTransport(state.block, record)) return { removed: false, reason: 'user-changed-transport' }
              try { await edit(client, state, serverName, null); return { removed: true } }
              catch (error) { if (attempt < 2 && conflict(error)) continue; throw error }
            }
          })
          save(location.path, { ...record, active: false, pending: false, cleanup: result })
          return result
        } catch (error) {
          save(location.path, { ...record, active: false, pending: true, cleanup: { removed: false, reason: 'codex-config-unavailable' } })
          throw error
        }
      })
    },
  }
}

// Listing deliberately omits transport URLs, tokens and prior user config.
// Legacy records without codexHome can still be addressed by explicitly passing
// the original home to cleanupCodexRegistration.
export function listCodexRegistrations({ directory = dataDir() } = {}) {
  const root = join(directory, 'registrations')
  let names
  try { names = readdirSync(root) } catch (error) { if (error.code === 'ENOENT') return []; throw error }
  const records = new Map(names.filter(name => /^[A-Za-z0-9_-]+-[a-f0-9]{20}\.json$/.test(name)).map(name => [name, name]))
  // A crash during the very first atomic save may leave only a temporary
  // credential record. Include it in inspection instead of hiding the residue.
  const temporary = new RegExp(`^([A-Za-z0-9_-]+-[a-f0-9]{20}\\.json)(?:\\.lock)?\\.${uuid}\\.tmp$`)
  for (const name of names) {
    const base = temporary.exec(name)?.[1]
    if (base && !records.has(base)) records.set(base, name)
  }
  return [...records].map(([name, source]) => {
    const path = join(root, name)
    try {
      const record = load(join(root, source))
      return { path, serverName: name.slice(0, -26), codexHome: record?.codexHome, profileDir: record?.profileDir,
        active: !!(record?.active || record?.lockId) && alive(record), pending: !!record?.pending, artifactOnly: source !== name }
    } catch { return { path, serverName: name.slice(0, -26), status: 'invalid-record' } }
  })
}

// Explicit uninstall cleanup is separate from runtime release. Runtime release
// retains the secret for a later enable; this operation removes it only after
// proving that the matching owned MCP block is gone. Inspection is the default.
export async function cleanupCodexRegistration({ codexHome, serverName = 'peerbridge', directory, codexBin, profileDir, apply = false, rpc = withCodex } = {}) {
  const location = registrationLocation({ codexHome, serverName, directory, createDirectory: false })
  if (!existsSync(location.path) && !registrationArtifacts(location).length) return { status: 'not-found', changed: false, path: location.path }
  return locked(location, async () => {
    const record = load(location.path) || registrationArtifacts(location).filter(item => !item.lock && validRecord(item.record)).sort((a, b) => b.modified - a.modified)[0]?.record
    if (!record) {
      const artifacts = cleanupArtifacts(location, { apply, profileDir })
      return { status: apply ? 'artifacts-cleaned' : 'artifacts-only', changed: !!artifacts.removedArtifacts?.length, path: location.path, ...artifacts }
    }
    if (!validRecord(record)) return { status: 'invalid-record', changed: false, path: location.path }
    if (record.serverName && record.serverName !== serverName) return { status: 'server-mismatch', changed: false, path: location.path }
    if (record.codexHome && pathIdentity(record.codexHome) !== pathIdentity(location.home)) return { status: 'home-mismatch', changed: false, path: location.path }
    if (profileDir && record.profileDir && pathIdentity(record.profileDir) !== pathIdentity(profileDir)) return { status: 'profile-mismatch', changed: false, path: location.path }
    if (record.active && alive(record)) return { status: 'active', changed: false, path: location.path }
    return rpc({ codexBin, codexHome: location.home }, async client => {
      for (let attempt = 0; ; attempt++) {
        const state = await snapshot(client, location.home, serverName)
        const neverConfigured = !record.ownerId && !record.url && !record.recoveryUrls?.length && !record.pending
        if (state.block && !ownsTransport(state.block, record) && !neverConfigured) return { status: 'user-changed-transport', changed: false, path: location.path }
        const owned = !!state.block && ownsTransport(state.block, record)
        if (!apply) return { status: owned ? 'owned-stale-transport' : 'unused-registration', changed: false, path: location.path, ...cleanupArtifacts(location, { profileDir }) }
        try {
          if (owned) await edit(client, state, serverName, null)
          const artifacts = cleanupArtifacts(location, { apply: true, profileDir })
          try { unlinkSync(location.path) } catch (error) { if (error.code !== 'ENOENT') throw error }
          return { status: artifacts.retainedArtifacts.length ? 'cleaned-with-retained-artifacts' : 'cleaned', changed: true, removedTransport: owned, path: location.path, ...artifacts }
        } catch (error) { if (attempt < 2 && conflict(error)) continue; throw error }
      }
    })
  })
}
