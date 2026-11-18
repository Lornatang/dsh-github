import assert from 'node:assert/strict'
import { test } from 'node:test'
import { limitResponse } from '../lib/response-limit.js'

const encoder = new TextEncoder()
function streamResponse(chunks, contentType = 'text/event-stream', status = 200) {
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk)
      controller.close()
    },
  })
  return new Response(stream, { status, headers: { 'content-type': contentType } })
}
async function drain(response) {
  const reader = response.body.getReader()
  const parts = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    parts.push(value)
  }
  return Buffer.concat(parts).toString('utf8')
}

test('passes SSE bytes through and counts events across split CRLF separators', async () => {
  let events = 0
  const text = 'data: a\r\n\r\ndata: b\n\n'
  const response = await limitResponse(streamResponse(['data: a\r', '\n\r', '\ndata: b\n', '\n']), 1024, () => assert.fail('limit'), () => { events++ })
  assert.equal(await drain(response), text)
  assert.equal(events, 2)
})

test('CR-only separators and comment lines follow SSE event accounting', async () => {
  let events = 0
  let limits = 0
  const response = await limitResponse(streamResponse(['data: a\r', '\rdata: b\r\r']), 1024, () => { limits++ }, () => { events++ })
  assert.equal(await drain(response), 'data: a\r\rdata: b\r\r')
  assert.equal(events, 2)
  assert.equal(limits, 0)
  // Comment lines rewind the per-event budget, so keepalives never trip it.
  let commentEvents = 0
  const comments = await limitResponse(streamResponse([': keepalive\n', ': keepalive\n', '\n', 'data: ok\n\n']), 16, () => assert.fail('limit'), () => { commentEvents++ })
  assert.equal(await drain(comments), ': keepalive\n: keepalive\n\ndata: ok\n\n')
  assert.equal(commentEvents, 2)
})

test('limits a single oversized event and separator-free bulk chunks alike', async () => {
  let limits = 0
  const response = await limitResponse(streamResponse(['data: ', 'x'.repeat(50), '\n\n']), 10, () => { limits++ })
  await assert.rejects(drain(response), /byte limit/)
  assert.equal(limits, 1)
  // The bulk fast path (chunks without CR/LF) must enforce the same budget.
  let bulkLimits = 0
  const bulk = await limitResponse(streamResponse(['data: ', ...Array.from({ length: 10 }, () => 'y'.repeat(100)), '\n\n']), 500, () => { bulkLimits++ })
  await assert.rejects(drain(bulk), /byte limit/)
  assert.equal(bulkLimits, 1)
  let events = 0
  const ok = await limitResponse(streamResponse(['data: ', ...Array.from({ length: 10 }, () => 'y'.repeat(100)), '\n\n']), 2000, () => assert.fail('limit'), () => { events++ })
  assert.equal((await drain(ok)).length, 1008)
  assert.equal(events, 1)
})

test('whole-body consumers enforce a total limit on SSE responses', async () => {
  let limits = 0
  const chunks = ['data: aaaaaaaaaa\n\n', 'data: bbbbbbbbbb\n\n']
  const perEvent = await limitResponse(streamResponse(chunks), 20, () => { limits++ })
  assert.equal((await drain(perEvent)).length, 36)
  assert.equal(limits, 0)
  const whole = await limitResponse(streamResponse(chunks), 20, () => { limits++ })
  await assert.rejects(whole.text(), /byte limit/)
  assert.equal(limits, 1)
})

test('non-SSE and error responses enforce the total limit', async () => {
  let limits = 0
  const json = await limitResponse(streamResponse(['x'.repeat(30)], 'application/json'), 20, () => { limits++ })
  await assert.rejects(json.arrayBuffer(), /byte limit/)
  assert.equal(limits, 1)
  const smallError = await limitResponse(streamResponse(['oops'], 'text/plain', 403), 20, () => assert.fail('limit'))
  assert.equal(await smallError.text(), 'oops')
  let errorLimits = 0
  // Error bodies are buffered inside limitResponse, so the limit rejects there.
  await assert.rejects(limitResponse(streamResponse(['x'.repeat(30)], 'text/plain', 403), 20, () => { errorLimits++ }), /byte limit/)
  assert.equal(errorLimits, 1)
})
