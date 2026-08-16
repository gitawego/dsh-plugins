// Scriptable LSP server for client tests. Speaks framed JSON-RPC over stdio.
// Env:
//   FAKE_PUSH_DELAY_MS  — publish diagnostics N ms after didOpen (default 20)
//   FAKE_PULL           — "1" advertises diagnosticProvider (pull mode)
//   FAKE_REGISTER       — "1" sends client/registerCapability for textDocument/diagnostic
//   FAKE_ERRORS         — "1" publishes 1 error + 1 warning after didOpen
//   FAKE_CONFIG         — "1" asks the client for workspace/configuration after initialized

let buffer = Buffer.alloc(0)
let id = 0
let configAnswer = null

const send = (msg) => {
  const body = Buffer.from(JSON.stringify(msg))
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`)
  process.stdout.write(body)
}

const publish = (uri, diagnostics) => {
  send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri, diagnostics } })
}

const readFrame = () => {
  const sep = buffer.indexOf('\r\n\r\n')
  if (sep < 0) return undefined
  const header = buffer.subarray(0, sep).toString('utf8')
  const len = Number(/Content-Length:\s*(\d+)/i.exec(header)?.[1])
  const bodyStart = sep + 4
  if (buffer.length < bodyStart + len) return undefined
  const body = buffer.subarray(bodyStart, bodyStart + len).toString('utf8')
  buffer = buffer.subarray(bodyStart + len)
  return JSON.parse(body)
}

const handle = (msg) => {
  if (Object.hasOwn(msg, 'id') && !msg.method) {
    configAnswer = msg.result?.[0] ?? null
    return
  }
  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        capabilities: {
          textDocumentSync: 2,
          ...(process.env.FAKE_PULL === '1'
            ? { diagnosticProvider: { interFileDependencies: false, workspaceDiagnostics: false } }
            : {}),
        },
      },
    })
    return
  }
  if (msg.method === 'shutdown') {
    send({ jsonrpc: '2.0', id: msg.id, result: null })
    return
  }
  if (msg.method === 'exit') {
    process.exit(0)
    return
  }
  if (msg.method === 'initialized') {
    if (process.env.FAKE_REGISTER === '1') {
      send({
        jsonrpc: '2.0',
        id: ++id,
        method: 'client/registerCapability',
        params: { registrations: [{ id: 'diag-1', method: 'textDocument/diagnostic' }] },
      })
    }
    if (process.env.FAKE_CONFIG === '1') {
      send({
        jsonrpc: '2.0',
        id: ++id,
        method: 'workspace/configuration',
        params: { items: [{ section: 'server' }] },
      })
    }
    return
  }
  // --- Canned query handlers (API parity tests) ---
  const LOC = { uri: msg.params?.textDocument?.uri ?? 'file:///canned.ts', range: { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } } }
  if (msg.method === 'textDocument/definition') {
    send({ jsonrpc: '2.0', id: msg.id, result: [LOC] })
    return
  }
  if (msg.method === 'textDocument/references') {
    send({ jsonrpc: '2.0', id: msg.id, result: [LOC, LOC] })
    return
  }
  if (msg.method === 'textDocument/implementation') {
    send({ jsonrpc: '2.0', id: msg.id, result: [LOC] })
    return
  }
  if (msg.method === 'textDocument/hover') {
    send({ jsonrpc: '2.0', id: msg.id, result: { contents: { kind: 'markdown', value: 'hover docs' } } })
    return
  }
  if (msg.method === 'textDocument/documentSymbol') {
    send({ jsonrpc: '2.0', id: msg.id, result: [{ name: 'cannedFn', kind: 12, range: LOC.range, selectionRange: LOC.range }] })
    return
  }
  if (msg.method === 'workspace/symbol') {
    send({ jsonrpc: '2.0', id: msg.id, result: [
      { name: 'keepMe', kind: 12, location: LOC },
      { name: 'dropMe', kind: 99, location: LOC },
    ] })
    return
  }
  if (msg.method === 'textDocument/prepareCallHierarchy') {
    send({ jsonrpc: '2.0', id: msg.id, result: [{ name: 'cannedCall', kind: 12, uri: LOC.uri, range: LOC.range, selectionRange: LOC.range }] })
    return
  }
  if (msg.method === 'callHierarchy/incomingCalls' || msg.method === 'callHierarchy/outgoingCalls') {
    send({ jsonrpc: '2.0', id: msg.id, result: [{ from: { name: 'caller' }, to: { name: 'callee' } }] })
    return
  }
  if (msg.method === 'textDocument/didOpen') {
    const uri = msg.params.textDocument.uri
    const delay = Number(process.env.FAKE_PUSH_DELAY_MS ?? 20)
    const publishAt = (diagnostics, ms) => setTimeout(() => publish(uri, diagnostics), ms)
    if (process.env.FAKE_ERRORS === '1') {
      publishAt([
        {
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
          severity: 1,
          source: 'fake',
          code: 'E1',
          message: 'fake error',
        },
        {
          range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } },
          severity: 2,
          source: 'fake',
          message: 'fake warning',
        },
      ], delay)
      return
    }
    publishAt([], delay)
    return
  }
  if (msg.method === 'textDocument/diagnostic') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        items: [
          {
            range: { start: { line: 2, character: 0 }, end: { line: 2, character: 2 } },
            severity: 1,
            message: 'pulled',
          },
        ],
      },
    })
    return
  }
  if (Object.hasOwn(msg, 'id')) send({ jsonrpc: '2.0', id: msg.id, result: null })
}

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk])
  let frame
  while ((frame = readFrame())) handle(frame)
})
