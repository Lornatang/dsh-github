import { createServer } from 'node:http'

export async function startMockMcp({ token = 'testtoken', initializeDelay = 0, duplicate = false, structured = false } = {}) {
  const requests = []
  let origin
  const definitions = [
    { name: 'get_file_contents', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } }, annotations: { readOnlyHint: true } },
    { name: 'push_files', description: 'Push files', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: false } },
    { name: 'unknown_tool', description: 'No safety hint', inputSchema: { type: 'object', properties: {} } },
  ]
  if (structured) definitions.push({ name: 'structured', inputSchema: { type: 'object', properties: { bad: { type: 'boolean' } } }, outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }, annotations: { readOnlyHint: true } })
  if (duplicate) definitions.push(definitions[0])
  const server = createServer(async (req, res) => {
    requests.push({ method: req.method, authorization: req.headers.authorization, toolsets: req.headers['x-mcp-toolsets'], readOnly: req.headers['x-mcp-readonly'] })
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401).end(); return }
    if (req.method === 'DELETE') { res.writeHead(204).end(); return }
    if (req.method !== 'POST') { res.writeHead(405).end(); return }
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const message = JSON.parse(Buffer.concat(chunks).toString())
    if (message.id === undefined) { res.writeHead(202).end(); return }
    let result
    if (message.method === 'initialize') {
      if (initializeDelay) await new Promise((resolve) => setTimeout(resolve, initializeDelay))
      result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'github-mock', version: '1' } }
    } else if (message.method === 'tools/list') result = { tools: definitions }
    else if (message.method === 'tools/call') {
      result = message.params.name === 'structured'
        ? { content: [{ type: 'text', text: 'structured' }], structuredContent: { ok: message.params.arguments?.bad ? 'invalid' : true } }
        : message.params.arguments?.path === 'fail'
        ? { isError: true, content: [{ type: 'text', text: `Permission denied for ${token}` }] }
        : { content: [{ type: 'text', text: `Read ${message.params.arguments?.path ?? 'file'} ${token}` }] }
    } else { res.writeHead(400).end(); return }
    if (!res.destroyed) res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${server.address().port}`
  return { url: `${origin}/mcp`, requests, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve) }) }
}
