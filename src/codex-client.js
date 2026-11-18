import { spawn, execFile } from 'node:child_process'
import { createInterface } from 'node:readline'
import { readConfig } from './state.js'
import { cliCommand, cliEnvironment } from './cli-command.js'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function defaultCodexBin() {
  const candidates = ['/usr/lib/chatgpt/resources/codex']
  if (process.platform === 'darwin') {
    for (const base of ['/Applications', join(homedir(), 'Applications')]) {
      for (const app of ['Codex', 'ChatGPT']) candidates.push(join(base, `${app}.app/Contents/Resources/codex`))
    }
  }
  return candidates.find(path => existsSync(path)) || 'codex'
}

export class CodexClient {
  constructor({ timeoutMs = 20000, signal, codexBin, codexHome } = {}) {
    this.timeoutMs = timeoutMs
    this.signal = signal
    this.codexBin = codexBin
    this.codexHome = codexHome
    this.pending = new Map()
    this.serial = 0
  }

  async open() {
    this.signal?.throwIfAborted()
    const config = readConfig()
    const args = config.codexSocket && !this.codexHome
      ? ['app-server', 'proxy', '--sock', config.codexSocket]
      : ['app-server', '--listen', 'stdio://']
    const cli = cliCommand(this.codexBin || config.codexBin || defaultCodexBin(), args)
    const env = cliEnvironment()
    if (this.codexHome) env.CODEX_HOME = this.codexHome
    this.child = spawn(cli.command, cli.args, { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    this.child.stderr.on('data', () => {})
    this.child.stdin.on('error', error => this.fail(error))
    this.child.on('error', error => this.fail(error))
    this.child.on('exit', (code, signal) => this.fail(new Error(`Codex app-server 已退出 (${code ?? signal})`)))
    this.lines = createInterface({ input: this.child.stdout })
    this.lines.on('line', line => {
      let message
      try { message = JSON.parse(line) } catch { return }
      if (message.method && message.id !== undefined) {
        // Management calls never approve execution requests from the server.
        this.child.stdin.write(`${JSON.stringify({ id: message.id, error: { code: -32601, message: 'PeerBridge management client does not handle execution requests' } })}\n`)
        return
      }
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      message.error ? pending.reject(Object.assign(new Error(`Codex: ${message.error.message}`), { code: message.error.code, data: message.error.data })) : pending.resolve(message.result)
    })
    this.abort = () => this.fail(this.signal.reason || new Error('操作已取消'))
    this.signal?.addEventListener('abort', this.abort, { once: true })
    if (this.signal?.aborted) this.abort()
    await this.call('initialize', {
      clientInfo: { name: 'peerbridge', title: 'Codex DeepSeek Bridge', version: '0.5.2' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    })
    this.child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`)
    return this
  }

  call(method, params) {
    this.signal?.throwIfAborted()
    if (this.failure) return Promise.reject(this.failure)
    return new Promise((resolve, reject) => {
      const id = ++this.serial
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Codex ${method} 超时；若为创建操作，请先列出结果再重试`))
        this.close()
      }, this.timeoutMs)
      this.pending.set(id, {
        resolve: value => { clearTimeout(timer); resolve(value) },
        reject: error => { clearTimeout(timer); reject(error) },
      })
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
    })
  }

  fail(error) {
    this.failure = error
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }

  close() {
    this.signal?.removeEventListener('abort', this.abort)
    this.fail(new Error('Codex 管理连接已关闭'))
    this.lines?.close()
    this.child?.stdin.end()
    this.child?.kill()
  }
}

export async function withCodex(options, run) {
  const client = new CodexClient(options)
  try { await client.open(); return await run(client) } finally { client.close() }
}

export function queueToCodex(threadId, text, signal, options = {}) {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const cli = cliCommand(options.codexBin || readConfig().codexBin || defaultCodexBin(), ['queue', '--thread', threadId, '--message', text])
    const env = cliEnvironment()
    if (options.codexHome) env.CODEX_HOME = options.codexHome
    execFile(cli.command, cli.args,
      { env, windowsHide: true, encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024, signal }, (error, stdout, stderr) => {
        if (error) { reject(new Error(`codex queue 失败: ${(stderr || error.message).slice(0, 500)}`)); return }
        const messageId = /Queued message ([0-9a-f-]+) for (?:session|thread)/i.exec(stdout)?.[1]
        resolve({ state: 'queued', messageId, receipt: messageId ? undefined : stdout.trim().slice(0, 500) })
      })
  })
}
