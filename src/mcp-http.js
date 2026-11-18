import { randomUUID, timingSafeEqual } from 'node:crypto'
import { dispatchMcp } from './mcp-protocol.js'

const loopback = address => address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(body === undefined ? undefined : JSON.stringify(body))
}

// Streamable HTTP with JSON responses, optional GET streams declined, explicit
// sessions for cancellation isolation, and no browser cookie authentication.
export function createMcpHttp({ token, origin, adapter, signal, maxBodyBytes = 1024 * 1024 }) {
  const sessions = new Map()
  const lifetime = new AbortController()
  const stop = () => {
    lifetime.abort(new Error('DSH bridge stopped'))
    for (const session of sessions.values()) for (const controller of session.pending.values()) controller.abort(lifetime.signal.reason)
    sessions.clear()
  }
  signal?.addEventListener('abort', stop, { once: true })
  if (signal?.aborted) stop()
  const close = () => { signal?.removeEventListener('abort', stop); stop() }
  const handler = async (req, res) => {
    if (lifetime.signal.aborted) { send(res, 503, { error: 'bridge stopped' }); return }
    const expectedOrigin = typeof origin === 'function' ? origin() : origin
    if (!loopback(req.socket.remoteAddress) || req.headers.host !== new URL(expectedOrigin).host
      || (req.headers.origin !== undefined && req.headers.origin !== expectedOrigin)) {
      send(res, 403, { error: 'local requests only' }); return
    }
    const expected = Buffer.from(`Bearer ${token}`)
    const actual = Buffer.from(typeof req.headers.authorization === 'string' ? req.headers.authorization : '')
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) { send(res, 401, { error: 'unauthorized' }); return }
    const protocol = req.headers['mcp-protocol-version']
    if (protocol !== undefined && !['2025-03-26', '2025-06-18', '2025-11-25'].includes(protocol)) { send(res, 400, { error: 'unsupported MCP protocol version' }); return }
    if (req.method === 'GET' || !['POST', 'DELETE'].includes(req.method)) {
      res.setHeader('allow', 'POST, DELETE'); send(res, 405, { error: 'method not allowed' }); return
    }
    const sessionId = req.headers['mcp-session-id']
    let session = sessions.get(sessionId)
    if (req.method === 'DELETE') {
      if (!session) { send(res, 404, { error: 'session not found' }); return }
      for (const controller of session.pending.values()) controller.abort(new Error('MCP session closed'))
      sessions.delete(sessionId); send(res, 200); return
    }
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) { send(res, 415, { error: 'application/json required' }); return }
    if (Number(req.headers['content-length']) > maxBodyBytes) { send(res, 413, { error: 'request too large' }); return }
    let message
    try {
      const chunks = []; let bytes = 0
      for await (const chunk of req) {
        bytes += chunk.length
        if (bytes > maxBodyBytes) { send(res, 413, { error: 'request too large' }); return }
        chunks.push(chunk)
      }
      message = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch { send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON' } }); return }
    // Reading an HTTP body yields to disposal and DELETE. A session captured
    // before that await may have been closed while the request was uploading.
    if (lifetime.signal.aborted) { send(res, 503, { error: 'bridge stopped' }); return }
    session = sessions.get(sessionId)
    if (!message || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string'
      || (message.params !== undefined && (!message.params || typeof message.params !== 'object' || Array.isArray(message.params)))
      || (message.id !== undefined && message.id !== null && !['string', 'number'].includes(typeof message.id))) {
      send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } }); return
    }
    if (message.method === 'initialize') {
      if (message.id === undefined) { send(res, 400, { error: 'initialize requires an id' }); return }
      const now = Date.now()
      for (const [id, value] of sessions) if (!value.pending.size && now - value.lastSeen > 3600000) sessions.delete(id)
      if (sessions.size >= 128) { send(res, 503, { error: 'too many MCP sessions' }); return }
      const id = randomUUID()
      session = { pending: new Map(), lastSeen: now }
      sessions.set(id, session)
      res.setHeader('mcp-session-id', id)
      send(res, 200, { jsonrpc: '2.0', id: message.id, result: await dispatchMcp('initialize', message.params) }); return
    }
    if (!session) { send(res, 404, { error: 'MCP session expired; initialize again' }); return }
    session.lastSeen = Date.now()
    if (message.id === undefined) {
      if (message.method === 'notifications/cancelled') session.pending.get(message.params?.requestId)?.abort(new Error('MCP request cancelled'))
      send(res, 202); return
    }
    if (session.pending.has(message.id)) { send(res, 400, { jsonrpc: '2.0', id: message.id, error: { code: -32600, message: 'Duplicate pending id' } }); return }
    const controller = new AbortController()
    session.pending.set(message.id, controller)
    const cancelled = () => { if (!res.writableEnded) controller.abort(new Error('MCP client disconnected')) }
    res.on('close', cancelled)
    try {
      const requestSignal = AbortSignal.any([lifetime.signal, controller.signal])
      const result = await dispatchMcp(message.method, message.params, {
        signal: requestSignal, adapter: message.method === 'tools/call' ? adapter?.(requestSignal) : undefined,
      })
      if (!res.destroyed) send(res, 200, { jsonrpc: '2.0', id: message.id, result })
    } catch (error) {
      if (!res.destroyed) send(res, 200, { jsonrpc: '2.0', id: message.id, error: {
        code: Number.isInteger(error?.code) ? error.code : -32603,
        message: error?.message || String(error),
      } })
    } finally { res.off('close', cancelled); session.pending.delete(message.id) }
  }
  return { handler, close }
}
