import { runTool, toolDefinitions } from './tools.js'

export const VERSION = '0.5.2'
const versions = new Set(['2025-03-26', '2025-06-18', '2025-11-25'])

export function toolSchema(parameters) {
  return {
    type: 'object',
    properties: Object.fromEntries(Object.entries(parameters).map(([key, { required: _, ...value }]) => [key, value])),
    required: Object.entries(parameters).filter(([, value]) => value.required).map(([key]) => key),
    additionalProperties: false,
  }
}

function requestSourceSession(params, fallback) {
  const meta = params._meta
  if (meta === undefined) return { sourceSession: fallback }
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw Object.assign(new Error('MCP _meta 必须是对象'), { code: 'INVALID_SOURCE_CONTEXT' })
  if (meta.threadId === undefined) return { sourceSession: fallback }
  if (typeof meta.threadId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(meta.threadId)) {
    throw Object.assign(new Error('MCP 来源 threadId 格式无效'), { code: 'INVALID_SOURCE_CONTEXT' })
  }
  // This is per-call host context, never the shared HTTP MCP session ID.
  return { sourceSession: meta.threadId, sourceSessionLocked: true }
}

export async function dispatchMcp(method, params = {}, { signal, sourceSession, adapter } = {}) {
  switch (method) {
    case 'initialize': return {
      protocolVersion: versions.has(params.protocolVersion) ? params.protocolVersion : '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'peerbridge-codex-bridge', title: 'Codex DeepSeek Bridge', version: VERSION },
    }
    case 'ping': return {}
    case 'tools/list': return { tools: toolDefinitions.map(tool => ({
      name: tool.name, description: tool.description, inputSchema: toolSchema(tool.parameters),
    })) }
    case 'tools/call': {
      try {
        if (typeof params.name !== 'string') throw new Error('工具名必须是字符串')
        const result = await runTool('dsh', params.name, params.arguments ?? {}, { ...requestSourceSession(params, sourceSession), signal, adapter })
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], isError: false }
      } catch (error) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: {
          code: error.code || 'PEER_ERROR', message: error.message || String(error), details: error.details, nextTools: error.nextTools,
        } }) }], isError: true }
      }
    }
    default: throw Object.assign(new Error(`method not found: ${method}`), { code: -32601 })
  }
}
