import { homedir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { CodexAdapter, DshAdapter } from './adapters.js'
import { defaultCodexBin } from './codex-client.js'
import { configureCodex, leaseCodexRegistration, registrationSecret } from './codex-registration.js'
import { migrateLegacyPatch } from './legacy-migration.js'
import { createMcpHttp } from './mcp-http.js'
import { readConfig } from './state.js'
import { cleanupExpiredQuestions, runTool, toolDefinitions } from './tools.js'

const skippedLegacy = new Set()

export function localOrigin(webServer) {
  if (!Number.isInteger(webServer.port) || webServer.port < 1 || webServer.port > 65535) throw new Error('DSH Web 服务尚未监听，无法创建 MCP 接入口')
  const host = webServer.host || '127.0.0.1'
  const protocol = (webServer.protocol || 'http').replace(/:$/, '')
  const origin = new URL(typeof webServer.getOrigin === 'function'
    ? webServer.getOrigin() : `${protocol}://${host === '::1' ? '[::1]' : host}:${webServer.port}`).origin
  const url = new URL(origin)
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('当前插件要求 DSH 使用本机回环 HTTP 监听；其他网络绑定或 TLS 尚未支持，未注册 Codex 接入口')
  }
  return origin
}

export async function mountPlugin(ctx, config, defineTool, { register = configureCodex } = {}) {
  const profile = ctx.profileContext
  // Existing user patches can still refer to the old ID during the first
  // migration generation. It must never register a second set of peer tools.
  if (ctx.fiber?.entry?.options?.id === 'peerbridge') { skippedLegacy.add(profile.dir); return }
  try { cleanupExpiredQuestions() } catch (error) {
    ctx.logger.warn?.(`过期问答记录清理失败：${error.message}`)
  }
  const removed = migrateLegacyPatch(profile.patchPath)
  if (removed) ctx.logger.info('已移除旧 PeerBridge 安装器管理的 patch；后续由标准 DSH bundle 管理。')
  const lifetime = new AbortController()
  await ctx.effect(async () => {
    let transport, unregister, registration
    let disarmed = false
    const tools = []
    let cleanupPromise
    const cleanupTasks = []
    const dispose = () => {
      if (cleanupPromise) return cleanupPromise
      if (!disarmed) {
        disarmed = true
        lifetime.abort(new Error('DSH bridge disabled'))
        if (transport) cleanupTasks.push(() => transport.close())
        if (unregister) cleanupTasks.push(unregister)
        cleanupTasks.push(...tools.reverse())
        if (registration) cleanupTasks.push(() => registration.release())
      }
      cleanupPromise = (async () => {
        const errors = []
        for (const release of [...cleanupTasks]) {
          try {
            await release()
            cleanupTasks.splice(cleanupTasks.indexOf(release), 1)
          } catch (error) { errors.push(error) }
        }
        if (errors.length) throw new AggregateError(errors, 'PeerBridge cleanup failed; failed resources can be retried')
      })().finally(() => { cleanupPromise = undefined })
      return cleanupPromise
    }
    try {
      const origin = localOrigin(ctx.webServer)
      const serverName = config.mcpServerName || 'peerbridge'
      const shared = readConfig()
      const codexBin = config.codexBin || shared.codexBin || defaultCodexBin()
      const explicitHome = config.codexHome || process.env.CODEX_HOME
      const codexHome = explicitHome || join(homedir(), '.codex')
      const options = { serverName, codexHome }
      const token = await registrationSecret(options)
      const path = `/peerbridge/${serverName}/mcp`
      transport = createMcpHttp({ token, origin, signal: lifetime.signal,
        adapter: signal => new DshAdapter({ signal, url: ctx.connection.authenticatedUrl(origin) }),
      })
      unregister = ctx.webServer.register({ kind: 'exact', path, handler: transport.handler })
      // HMR tears down the former tools after the owned profile block changes.
      // Startup-only profiles need one restart when migrating the old plugin.
      for (let i = 0; ; i++) {
        const old = [...ctx.loader.entries()].find(entry => entry.options.id === 'peerbridge' && entry.options.name === 'peerbridge-dsh-plugin')
        if (!old?.fiber || old.disabled || skippedLegacy.has(profile.dir)) break
        if (!ctx.get('hmr') || i >= 150) throw new Error('旧版 PeerBridge 仍在运行；迁移已写入，请重启 DSH 完成切换')
        await delay(100, undefined, { signal: lifetime.signal })
      }
      for (const tool of toolDefinitions) {
        tools.push(ctx.tools.register(defineTool({ ...tool,
          output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
          async execute(args, exec) {
            const signal = exec.signal ? AbortSignal.any([exec.signal, lifetime.signal]) : lifetime.signal
            const sourceSession = exec.agent?.session?.id ?? exec.sessionId
            const value = await runTool('codex', tool.name, args, {
              sourceSession, sourceSessionLocked: !!sourceSession, signal,
              adapter: new CodexAdapter({ codexBin, codexHome: explicitHome, signal }),
            })
            return JSON.parse(JSON.stringify(value))
          },
        })))
      }
      // Tool-name conflicts must fail before changing the user's Codex entry.
      if (config.autoConfigureCodex !== false) {
        registration = await register({ ...options, profileDir: profile.dir, url: `${origin}${path}`, token, codexBin, signal: lifetime.signal })
      } else {
        registration = await leaseCodexRegistration({ ...options, profileDir: profile.dir, url: `${origin}${path}`, token })
      }
      ctx.logger.info(config.autoConfigureCodex !== false
        ? `Codex MCP ${serverName} 已自动配置；首次接入请重载 Codex。`
        : `本机 MCP 服务已启动（${serverName}）；自动配置已关闭。`)
      return dispose
    } catch (error) {
      try { await dispose() } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], `${error.message}; PeerBridge startup rollback failed`)
      }
      throw error
    }
  }, 'peerbridge: MCP route, Codex registration and tools')
}
