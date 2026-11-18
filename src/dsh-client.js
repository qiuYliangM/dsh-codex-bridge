import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import WebSocket from '../vendor/ws/wrapper.mjs'
import { dataDir } from './state.js'

export function parseGatewayUrl(value) {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('PeerBridge 仅支持本机回环 DSH 网关')
  }
  if (url.username || url.password) throw new Error('DSH 网关地址不能包含用户名或密码')
  if (!url.searchParams.get('token')?.trim()) throw new Error('DSH 网关地址缺少 token')
  return url
}

export class DshClient {
  constructor({ timeoutMs = 15000, signal, url: gatewayUrl } = {}) {
    const url = parseGatewayUrl(gatewayUrl ?? readFileSync(join(dataDir(), 'web-url.txt'), 'utf8').trim())
    this.base = url.origin
    this.token = url.searchParams.get('token')
    this.signal = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)
  }

  async authenticate() {
    if (this.cookie) return
    const response = await fetch(`${this.base}/?token=${encodeURIComponent(this.token)}`, { redirect: 'manual', signal: this.signal })
    this.cookie = response.headers.getSetCookie().map(line => line.split(';')[0]).join('; ')
    if (!this.cookie) throw new Error(`DSH 登录失败（HTTP ${response.status}），请更新 web-url.txt`)
  }

  async call(method, args) {
    await this.authenticate()
    const response = await fetch(`${this.base}/api/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: this.cookie }, signal: this.signal,
      body: JSON.stringify({ type: 'client-request', rpcId: `pb-${randomUUID()}`, method, payload: { args } }),
    })
    let body
    try { body = await response.json() } catch { throw new Error(`DSH ${method}: HTTP ${response.status}，响应不是 JSON`) }
    if (!response.ok || body.result?.ok !== true) throw new Error(`DSH ${method}: ${body.result?.error?.message || `HTTP ${response.status}`}`)
    return body.result.value
  }

  async baseline() {
    await this.authenticate()
    this.signal.throwIfAborted()
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(`${this.base.replace(/^http/, 'ws')}/api/remote.mux`, {
        headers: { cookie: this.cookie, origin: this.base },
      })
      const streamId = randomUUID()
      let settled = false
      const finish = (error, value) => {
        if (settled) return
        settled = true
        this.signal.removeEventListener('abort', abort)
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'cancel', streamId }))
          socket.close()
        } else socket.terminate()
        error ? reject(error) : resolve(value)
      }
      const abort = () => finish(this.signal.reason)
      this.signal.addEventListener('abort', abort, { once: true })
      socket.on('open', () => socket.send(JSON.stringify({ type: 'open', streamId, endpoint: 'workspace/follow', payload: { args: {} } })))
      socket.on('error', error => finish(error))
      socket.on('close', () => finish(new Error('DSH 工作区列表连接提前关闭')))
      socket.on('message', raw => {
        try {
          const frame = JSON.parse(raw.toString())
          if (frame.streamId !== streamId) return
          if (frame.type === 'error') throw new Error(frame.error?.message || 'DSH 工作区列表失败')
          if (frame.type === 'end') throw new Error('DSH 未返回工作区列表')
          if (frame.type === 'item' && frame.value?.type === 'baseline') {
            if (!Array.isArray(frame.value.value?.items)) throw new Error('DSH 工作区列表格式错误')
            finish(undefined, frame.value.value)
          }
        } catch (error) { finish(error) }
      })
      if (this.signal.aborted) abort()
    })
  }
}
