import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { PeerOperations } from '../src/operations.js'
import { cleanupExpiredQuestions, runTool } from '../src/tools.js'
import { CodexAdapter, DshAdapter } from '../src/adapters.js'
import { writeJson, writeJsonExclusive } from '../src/state.js'

function sandbox(t) {
  const directory = mkdtempSync(join(tmpdir(), 'peerbridge-routing-review-'))
  const previous = process.env.PEERBRIDGE_HOME
  process.env.PEERBRIDGE_HOME = directory
  t.after(() => {
    if (previous === undefined) delete process.env.PEERBRIDGE_HOME
    else process.env.PEERBRIDGE_HOME = previous
    rmSync(directory, { recursive: true, force: true })
  })
  return directory
}

class QuestionAdapter {
  constructor(send) { this.onSend = send }
  async workspaces() { return [{ workspaceId: 'workspace', path: '/project' }] }
  async sessions() { return [{ sessionId: 'target-session', workspaceId: 'workspace', cwd: '/project' }] }
  async send(target, text) {
    await this.onSend?.(/问题 (q-[0-9a-f]{12})/.exec(text)[1], target)
    return { state: 'queued' }
  }
}

const question = { workspace: 'workspace', session: 'target-session', question: 'Please answer' }

test('ask accepts a fast answer in either direction and removes its transient state', async t => {
  const directory = sandbox(t)
  for (const [askingPeer, answeringPeer, expectedBy] of [['dsh', 'codex', 'dsh'], ['codex', 'dsh', 'codex']]) {
    let questionId
    const adapter = new QuestionAdapter(async id => {
      questionId = id
      await runTool(answeringPeer, 'peer_answer', { questionId: id, answer: 'confirmed' }, {
        sourceSession: 'target-session', sourceSessionLocked: true,
      })
    })
    const result = await runTool(askingPeer, 'peer_ask', question, { adapter, sourceSession: 'asking-session' })
    assert.equal(result.answer, 'confirmed')
    assert.equal(result.by, expectedBy)
    assert.equal(existsSync(join(directory, 'questions', questionId)), false)
  }
  assert.deepEqual(readdirSync(join(directory, 'questions')), [])
})

test('answer rejects the asking side and another host session without consuming the question', async t => {
  sandbox(t)
  const adapter = new QuestionAdapter(async questionId => {
    await assert.rejects(runTool('dsh', 'peer_answer', { questionId, answer: 'wrong side' }), { code: 'QUESTION_TARGET_MISMATCH' })
    await assert.rejects(runTool('codex', 'peer_answer', { questionId, answer: 'wrong session' }, {
      sourceSession: 'another-session', sourceSessionLocked: true,
    }), { code: 'QUESTION_TARGET_MISMATCH' })
    await runTool('codex', 'peer_answer', { questionId, answer: 'right session' }, {
      sourceSession: 'target-session', sourceSessionLocked: true,
    })
    await assert.rejects(runTool('codex', 'peer_answer', { questionId, answer: 'overwrite' }), { code: 'QUESTION_ALREADY_ANSWERED' })
  })
  const result = await runTool('dsh', 'peer_ask', question, { adapter })
  assert.equal(result.answer, 'right session')
})

test('missing host context preserves legacy answers to a valid pending question', async t => {
  sandbox(t)
  const adapter = new QuestionAdapter(questionId => runTool('codex', 'peer_answer', { questionId, answer: 'legacy' }))
  assert.equal((await runTool('dsh', 'peer_ask', question, { adapter })).answer, 'legacy')
})

test('unknown and late answers cannot create files', async t => {
  const directory = sandbox(t)
  await assert.rejects(runTool('dsh', 'peer_answer', { questionId: 'q-123456abcdef', answer: 'unsolicited' }), { code: 'QUESTION_NOT_PENDING' })
  assert.equal(existsSync(join(directory, 'questions')), false)
  let id
  const controller = new AbortController()
  const adapter = new QuestionAdapter(questionId => { id = questionId; controller.abort(new Error('user cancelled')) })
  await assert.rejects(runTool('dsh', 'peer_ask', question, { adapter, signal: controller.signal }), /user cancelled/)
  assert.deepEqual(readdirSync(join(directory, 'questions')), [])
  await assert.rejects(runTool('codex', 'peer_answer', { questionId: id, answer: 'late' }), { code: 'QUESTION_NOT_PENDING' })
  assert.deepEqual(readdirSync(join(directory, 'questions')), [])
})

test('delivery failures remove pending question state', async t => {
  const directory = sandbox(t)
  const adapter = new QuestionAdapter(() => { throw new Error('gateway unavailable') })
  await assert.rejects(runTool('dsh', 'peer_ask', question, { adapter }), /gateway unavailable/)
  assert.deepEqual(readdirSync(join(directory, 'questions')), [])
})

test('ask timeout removes pending records and rejects a subsequent answer', { timeout: 7000 }, async t => {
  const directory = sandbox(t)
  let id
  const adapter = new QuestionAdapter(questionId => { id = questionId })
  const result = await runTool('dsh', 'peer_ask', { ...question, timeoutSec: 5 }, { adapter })
  assert.equal(result.state, 'timeout')
  assert.equal(result.questionId, id)
  assert.deepEqual(readdirSync(join(directory, 'questions')), [])
  await assert.rejects(runTool('codex', 'peer_answer', { questionId: id, answer: 'late' }), { code: 'QUESTION_NOT_PENDING' })
})

test('restart cleanup removes expired requests while preserving live requests and unrelated data', async t => {
  const directory = sandbox(t)
  const root = join(directory, 'questions')
  for (const [id, expiresAt] of [['q-000000000001', Date.now() - 1], ['q-000000000002', Date.now() + 50000]]) {
    mkdirSync(join(root, id), { recursive: true })
    writeJson(join(root, id, 'request.json'), { questionId: id, answerBy: 'dsh', answerSession: 'target-session', expiresAt })
  }
  mkdirSync(join(root, 'user-data'))
  writeFileSync(join(root, 'user-data', 'keep.txt'), 'keep')
  cleanupExpiredQuestions()
  assert.equal(existsSync(join(root, 'q-000000000001')), false)
  assert.equal(readFileSync(join(root, 'user-data', 'keep.txt'), 'utf8'), 'keep')
  await runTool('codex', 'peer_answer', { questionId: 'q-000000000002', answer: 'after restart' })
  assert.equal(JSON.parse(readFileSync(join(root, 'q-000000000002', 'answer.json'))).answer, 'after restart')
})

test('atomic JSON publication preserves the first answer and removes failed temporary files', t => {
  const directory = sandbox(t)
  const answer = join(directory, 'answer.json')
  writeJsonExclusive(answer, { answer: 'first' })
  assert.throws(() => writeJsonExclusive(answer, { answer: 'second' }), { code: 'EEXIST' })
  assert.equal(JSON.parse(readFileSync(answer)).answer, 'first')
  const destinationDirectory = join(directory, 'cannot-replace')
  mkdirSync(destinationDirectory)
  assert.throws(() => writeJson(destinationDirectory, { data: true }))
  assert.deepEqual(readdirSync(directory).sort(), ['answer.json', 'cannot-replace'])
})

test('sending to DSH never creates or recreates a target session', async () => {
  const adapter = new DshAdapter()
  const methods = []
  adapter.client = () => ({ async call(method) { methods.push(method); throw new Error('session/not-found') } })
  await assert.rejects(adapter.send({ sessionId: 'deleted', cwd: '/project', workspaceId: 'workspace' }, 'message'), /session\/not-found/)
  assert.deepEqual(methods, ['session/prompt'])
})

test('queue acceptance never claims that the peer chat consumed or completed a message', async () => {
  for (const peer of ['dsh', 'codex']) {
    const operations = new PeerOperations(peer, { adapter: new QuestionAdapter() })
    const result = await operations.send({ workspace: 'workspace', session: 'target-session' }, 'queued')
    assert.equal(result.state, 'queued')
    assert.equal(result.accepted, true)
    assert.equal(result.deliveryConfirmed, false)
    assert.equal(result.completed, false)
    assert.equal(Object.hasOwn(result, 'delivered'), false)
  }
})

test('adapter timeout rebinding preserves transport options and aborts an in-flight ask send', { timeout: 10000 }, async t => {
  sandbox(t)
  const controller = new AbortController()
  for (const Adapter of [CodexAdapter, DshAdapter]) {
    const options = { signal: controller.signal, codexBin: '/isolated/codex', codexHome: '/isolated/home', url: 'http://127.0.0.1/?token=fixture' }
    const original = new Adapter(options)
    const rebound = original.withSignal(AbortSignal.abort())
    assert.equal(rebound.options.signal.aborted, true)
    assert.equal(original.options.signal.aborted, false)
    assert.equal(rebound.options.codexHome, options.codexHome)
    assert.equal(rebound.options.url, options.url)
  }
  let reboundSignal
  const adapter = {
    withSignal(signal) {
      reboundSignal = signal
      return new QuestionAdapter(() => delay(20000, undefined, { signal }))
    },
  }
  const result = await runTool('dsh', 'peer_ask', { ...question, timeoutSec: 5 }, { adapter, signal: controller.signal })
  assert.equal(result.state, 'timeout')
  assert.equal(reboundSignal.aborted, true)
  assert.equal(controller.signal.aborted, false)
})

test('index write failure after a successful Codex creation retains the exact created session identity', async t => {
  const directory = sandbox(t)
  writeFileSync(join(directory, 'codex-sessions'), 'cannot create a directory here')
  const adapter = new CodexAdapter()
  const calls = []
  adapter.rpc = run => run({ async call(method) {
    calls.push(method)
    assert.equal(method, 'thread/start')
    return { thread: { id: 'already-created', projectId: 'workspace', cwd: '/project' } }
  } })
  await assert.rejects(adapter.createSession({ workspaceId: 'workspace', path: '/project' }, {}), error => {
    assert.equal(error.code, 'SESSION_CREATED_INDEX_FAILED')
    assert.equal(error.details.created, true)
    assert.equal(error.details.completed, false)
    assert.equal(error.details.session.sessionId, 'already-created')
    assert.equal(error.details.session.workspaceId, 'workspace')
    assert.match(error.message, /already-created.*请勿重复创建/)
    return true
  })
  assert.deepEqual(calls, ['thread/start'])
  assert.equal(readFileSync(join(directory, 'codex-sessions'), 'utf8'), 'cannot create a directory here')
})
