import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { operationTools, PeerOperations, workspaceParameter, sessionParameter } from './operations.js'
import { boundedNumber, dataDir, requireText, writeJson, writeJsonExclusive } from './state.js'

export const toolDefinitions = [
  ...operationTools,
  ['peer_send', 'Send a message using explicit workspace and session arguments. Missing, nonexistent, archived or mismatched targets fail; list or create targets separately. Returns queue acceptance, not completion.', {
    workspace: workspaceParameter, session: sessionParameter, text: { type: 'string', required: true },
    requestId: { type: 'string', description: 'Optional stable DSH prompt request ID for retrying one logical message.' },
  }],
  ['peer_ask', 'Ask using explicit workspace and session arguments and wait for peer_answer. Invalid targets fail; list or create separately. Do not synchronously ask a peer that is already waiting on you.', {
    workspace: workspaceParameter, session: sessionParameter, question: { type: 'string', required: true }, timeoutSec: { type: 'number' },
  }],
  ['peer_answer', 'Answer an active peer question once using its q-xxxxxxxxxxxx questionId. Unknown, expired, duplicate, wrong-side or conflicting host-session replies fail.', {
    questionId: { type: 'string', required: true }, answer: { type: 'string', required: true },
  }],
  ['peer_events', 'Read recent shared PeerBridge timeline entries.', { limit: { type: 'number' } }],
].map(([name, description, parameters]) => ({
  name, description,
  parameters: { ...parameters, ...(['peer_send', 'peer_ask'].includes(name) ? {
    sourceSession: { type: 'string', description: 'Legacy source attribution when host context is unavailable. Codex/DSH supply the current session automatically; a conflicting value fails. Does not choose the target.' },
  } : {}) },
}))

function timeline(side, kind, data, sessionId) {
  try {
    mkdirSync(dataDir(), { recursive: true, mode: 0o700 })
    appendFileSync(join(dataDir(), 'timeline.jsonl'), `${JSON.stringify({ t: Date.now(), side, kind, sessionId, data })}\n`, { mode: 0o600 })
  } catch { /* Observation does not change delivery results. */ }
}

const questionPattern = /^q-[0-9a-f]{12}$/
const questionDirectory = id => join(dataDir(), 'questions', id)

export function cleanupExpiredQuestions(now = Date.now()) {
  const directory = join(dataDir(), 'questions')
  let entries
  try { entries = readdirSync(directory, { withFileTypes: true }) } catch (error) { if (error.code === 'ENOENT') return; throw error }
  for (const entry of entries) {
    if (!entry.isDirectory() || !questionPattern.test(entry.name)) continue
    const path = join(directory, entry.name)
    try {
      let expired
      try {
        const pending = JSON.parse(readFileSync(join(path, 'request.json'), 'utf8'))
        expired = pending.questionId !== entry.name || !Number.isFinite(pending.expiresAt) || pending.expiresAt <= now
      } catch { // Allow another process to finish publishing a newly made request.
        expired = statSync(path).mtimeMs < now - 60000
      }
      if (expired) rmSync(path, { recursive: true, force: true })
    } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
}

export async function runTool(peer, name, args = {}, { sourceSession, sourceSessionLocked = false, signal, adapter } = {}) {
  signal?.throwIfAborted()
  const definition = toolDefinitions.find(tool => tool.name === name)
  if (!definition) throw new Error(`unknown tool: ${name}`)
  if (args === null || typeof args !== 'object' || Array.isArray(args)) throw new Error('工具参数必须是对象')
  for (const [key, value] of Object.entries(args)) {
    const parameter = definition.parameters[key]
    if (!parameter) throw new Error(`未知参数 ${key}`)
    if (typeof value !== parameter.type || (parameter.type === 'number' && !Number.isFinite(value))) throw new Error(`${key} 必须是 ${parameter.type}`)
  }
  for (const [key, parameter] of Object.entries(definition.parameters)) {
    if (parameter.required && args[key] === undefined) throw new Error(`缺少参数 ${key}`)
  }
  if (sourceSessionLocked && args.sourceSession && args.sourceSession !== sourceSession) {
    throw Object.assign(new Error('sourceSession 与宿主当前会话不一致，未发送；请省略该参数以使用自动来源'), { code: 'SOURCE_SESSION_MISMATCH' })
  }
  sourceSession = sourceSessionLocked ? sourceSession : args.sourceSession || sourceSession
  try { cleanupExpiredQuestions() } catch { /* Stale observation state must not block unrelated peer operations. */ }
  const operations = new PeerOperations(peer, { sourceSession, signal, adapter })
  const side = peer === 'dsh' ? 'codex' : 'dsh'
  if (operationTools.some(tool => tool[0] === name)) {
    const result = await operations.execute(name, args)
    if (!['peer_status', 'peer_workspaces', 'peer_sessions'].includes(name)) timeline(side, name, result, sourceSession)
    return result
  }
  if (name === 'peer_send') {
    const text = requireText(args.text, 'text')
    const result = await operations.send(args, text)
    timeline(side, 'peer-message', { text: text.slice(0, 500), to: peer, ...result }, sourceSession)
    return result
  }
  if (name === 'peer_ask') {
    const question = requireText(args.question, 'question')
    const questionId = `q-${randomUUID().replaceAll('-', '').slice(0, 12)}`
    const timeout = AbortSignal.timeout(boundedNumber(args.timeoutSec, 300, 5, 900) * 1000)
    const lifetime = signal ? AbortSignal.any([signal, timeout]) : timeout
    const askOperations = new PeerOperations(peer, { sourceSession, signal: lifetime, adapter: adapter?.withSignal?.(lifetime) || adapter })
    const directory = questionDirectory(questionId)
    let ownsDirectory = false
    try {
      const target = await askOperations.target(args)
      lifetime.throwIfAborted()
      mkdirSync(join(dataDir(), 'questions'), { recursive: true, mode: 0o700 })
      mkdirSync(directory, { mode: 0o700 })
      ownsDirectory = true
      writeJson(join(directory, 'request.json'), {
        questionId, answerBy: peer, answerSession: target.sessionId,
        expiresAt: Date.now() + boundedNumber(args.timeoutSec, 300, 5, 900) * 1000,
      })
      await askOperations.send(args, `问题 ${questionId}\n${question}\n（请用 peer_answer 工具回答并引用问题 id）`)
      timeline(side, 'question', { questionId, question, to: peer }, sourceSession)
      const path = join(directory, 'answer.json')
      for (;;) {
        lifetime.throwIfAborted()
        if (existsSync(path)) {
          const value = JSON.parse(readFileSync(path, 'utf8'))
          if (value.questionId !== questionId) throw new Error('回答的 questionId 不匹配')
          return value
        }
        await delay(250, undefined, { signal: lifetime })
      }
    } catch (error) {
      if (signal?.aborted) throw signal.reason
      if (timeout.aborted) return { questionId, state: 'timeout' }
      throw error
    } finally {
      if (ownsDirectory) rmSync(directory, { recursive: true, force: true })
    }
  }
  if (name === 'peer_answer') {
    const questionId = requireText(args.questionId, 'questionId').toLowerCase()
    if (!questionPattern.test(questionId)) throw new Error('questionId 格式无效')
    const answer = requireText(args.answer, 'answer')
    const directory = questionDirectory(questionId)
    let pending
    try { pending = JSON.parse(readFileSync(join(directory, 'request.json'), 'utf8')) }
    catch (error) {
      if (error.code === 'ENOENT') throw Object.assign(new Error('问题不存在、已回答或已过期，未保存回答'), { code: 'QUESTION_NOT_PENDING' })
      throw error
    }
    if (pending.questionId !== questionId || !Number.isFinite(pending.expiresAt) || pending.expiresAt <= Date.now()) {
      throw Object.assign(new Error('问题已过期，未保存回答'), { code: 'QUESTION_NOT_PENDING' })
    }
    if (pending.answerBy !== side || (sourceSession && pending.answerSession !== sourceSession)) {
      throw Object.assign(new Error('回答端或宿主会话与被提问目标不一致'), { code: 'QUESTION_TARGET_MISMATCH' })
    }
    const payload = { questionId, answer, by: side, t: Date.now() }
    try { writeJsonExclusive(join(directory, 'answer.json'), payload) }
    catch (error) {
      if (error.code === 'EEXIST') throw Object.assign(new Error('问题已有回答，未覆盖先前结果'), { code: 'QUESTION_ALREADY_ANSWERED' })
      if (error.code === 'ENOENT') throw Object.assign(new Error('问题已取消或已过期，未保存回答'), { code: 'QUESTION_NOT_PENDING' })
      throw error
    }
    timeline(side, 'answer', payload, sourceSession)
    return { answered: true, questionId }
  }
  if (name === 'peer_events') {
    const path = join(dataDir(), 'timeline.jsonl')
    const limit = boundedNumber(args.limit, 30, 0, 200)
    if (!limit || !existsSync(path)) return { entries: [] }
    const lines = readFileSync(path, 'utf8').split('\n').filter(line => line.trim())
    return { entries: lines.slice(-limit).flatMap(line => { try { return [JSON.parse(line)] } catch { return [] } }) }
  }
  throw new Error(`unknown tool: ${name}`)
}
