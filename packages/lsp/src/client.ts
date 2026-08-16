import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { languageIdFor } from './language.js'
import type { Diagnostic } from './types.js'

// Persistent LSP client (OpenCode/pi-lsp-inspired): keeps the server process
// alive for the session, tracks open documents with versions, merges push + pull
// diagnostics, and answers server-initiated requests (workspace/configuration,
// client/registerCapability, workspace/workspaceFolders).

export interface LspClient {
  readonly serverID: string
  readonly root: string
  /** Open (or re-sync) a file; returns its document version. */
  touchFile(input: string): Promise<number>
  waitForDiagnostics(request: {
    path: string
    version: number
    mode?: 'document' | 'full'
    after?: number
    /** Wait for the first non-empty publication instead of settling on provisional empties. */
    requireNonEmpty?: boolean
  }): Promise<void>
  get diagnostics(): Map<string, Diagnostic[]>
  request<T>(method: string, params?: unknown): Promise<T | null>
  shutdown(): Promise<void>
}

export interface ClientOptions {
  serverID: string
  command: string[]
  cwd: string
  initialization?: Record<string, unknown>
  env?: Record<string, string>
  timeoutMs: number
  signal?: AbortSignal
  /** How long to keep waiting after a provisional empty publish for real (non-empty) diagnostics. Defaults to 3000. */
  diagnosticsGraceMs?: number
}

const SETTLE_MS = 100

export async function createClient(options: ClientOptions): Promise<LspClient> {
  const child: ChildProcessWithoutNullStreams = spawn(options.command[0]!, options.command.slice(1), {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: 'pipe',
  })
  child.stderr.resume()

  let buffer = Buffer.alloc(0)
  let nextId = 1
  let ended = false
  const pending = new Map<
    number,
    { resolve: (m: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >()
  const pushDiagnostics = new Map<string, Diagnostic[]>()
  const pullDiagnostics = new Map<string, Diagnostic[]>()
  const published = new Map<string, { at: number }>()
  const documents = new Map<string, { version: number; text: string }>()
  const pushWaiters = new Map<string, Set<() => void>>()
  let capabilities: {
    textDocumentSync?: number | { change?: number }
    diagnosticProvider?: unknown
  } = {}

  const filePathOf = (uri: string) => {
    if (!uri.startsWith('file://')) return undefined
    try {
      return decodeURIComponent(new URL(uri).pathname)
    } catch {
      return undefined
    }
  }
  const merged = (file: string) =>
    dedupe([...(pushDiagnostics.get(file) ?? []), ...(pullDiagnostics.get(file) ?? [])])

  function requestWithTimeout<T>(method: string, params: unknown, timeoutMs: number): Promise<T | null> {
    if (ended) return Promise.resolve(null)
    return new Promise<T | null>((resolve, reject) => {
      const id = nextId++
      const timer = setTimeout(() => {
        pending.delete(id)
        resolve(null)
      }, timeoutMs)
      pending.set(id, { resolve: (m) => resolve(m as T), reject, timer })
      try {
        send({ jsonrpc: '2.0', id, method, params })
      } catch (error) {
        clearTimeout(timer)
        pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  const notify = (method: string, params: unknown) => send({ jsonrpc: '2.0', method, params })

  function send(msg: unknown) {
    if (ended) throw new Error('client is shut down')
    const body = Buffer.from(JSON.stringify(msg))
    child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`)
    child.stdin.write(body)
  }

  function lookup(section: string | undefined) {
    if (!section || !options.initialization) return options.initialization ?? null
    return (
      section
        .split('.')
        .reduce<unknown>(
          (acc, key) =>
            acc && typeof acc === 'object'
              ? (acc as Record<string, unknown>)[key]
              : undefined,
          options.initialization,
        ) ?? null
    )
  }

  function handle(msg: any) {
    // Server request (has id + method) → answer it.
    if (Object.hasOwn(msg, 'id') && msg.method) {
      if (msg.method === 'workspace/configuration') {
        const items: Array<{ section?: string }> = msg.params?.items ?? []
        send({ jsonrpc: '2.0', id: msg.id, result: items.map((i) => lookup(i.section)) })
        return
      }
      if (msg.method === 'workspace/workspaceFolders') {
        send({
          jsonrpc: '2.0',
          id: msg.id,
          result: [{ uri: pathToFileURL(options.cwd).href, name: 'workspace' }],
        })
        return
      }
      if (
        msg.method === 'client/registerCapability' ||
        msg.method === 'client/unregisterCapability'
      ) {
        send({ jsonrpc: '2.0', id: msg.id, result: null })
        return
      }
      send({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32601, message: `Method not found: ${msg.method}` },
      })
      return
    }
    // Server response (has id, no method).
    if (Object.hasOwn(msg, 'id') && !msg.method) {
      const p = pending.get(msg.id)
      if (!p) return
      clearTimeout(p.timer)
      pending.delete(msg.id)
      if (msg.error) p.reject(new Error(msg.error.message))
      else p.resolve(msg.result)
      return
    }
    // Server notification.
    if (msg.method === 'textDocument/publishDiagnostics') {
      const uri = msg.params?.uri
      const file = uri && filePathOf(uri)
      if (!file) return
      pushDiagnostics.set(file, msg.params?.diagnostics ?? [])
      published.set(file, { at: Date.now() })
      for (const waiter of pushWaiters.get(file) ?? []) waiter()
    }
  }

  child.stdout.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    while (true) {
      const sep = buffer.indexOf('\r\n\r\n')
      if (sep < 0) return
      const header = buffer.subarray(0, sep).toString('utf8')
      const lenMatch = /Content-Length:\s*(\d+)/i.exec(header)
      if (!lenMatch) {
        // Malformed header: discard the frame and re-sync at the next boundary.
        buffer = buffer.subarray(sep + 4)
        continue
      }
      const len = Number(lenMatch[1])
      const bodyStart = sep + 4
      if (buffer.length < bodyStart + len) return
      const raw = buffer.subarray(bodyStart, bodyStart + len).toString('utf8')
      buffer = buffer.subarray(bodyStart + len)
      try {
        handle(JSON.parse(raw))
      } catch {
        // A malformed frame or an unexpected payload must never crash the
        // host process: drop the frame and keep the session alive.
      }
    }
  })
  child.once('exit', () => {
    if (ended) return
    for (const p of [...pending.values()]) {
      clearTimeout(p.timer)
      p.reject(new Error('server exited'))
    }
    pending.clear()
  })

  const init = await requestWithTimeout<{ capabilities?: typeof capabilities }>(
    'initialize',
    {
      rootUri: pathToFileURL(options.cwd).href,
      processId: process.pid,
      workspaceFolders: [{ uri: pathToFileURL(options.cwd).href, name: 'workspace' }],
      initializationOptions: options.initialization ?? {},
      capabilities: {
        workspace: { configuration: true, workspaceFolders: true },
        textDocument: {
          synchronization: { didOpen: true, didChange: true },
          publishDiagnostics: {},
        },
      },
    },
    options.timeoutMs,
  )
  if (!init) throw new Error(`${options.serverID} initialize failed`)
  capabilities = init.capabilities ?? {}
  notify('initialized', {})
  if (options.initialization) {
    notify('workspace/didChangeConfiguration', { settings: options.initialization })
  }

  const syncKind =
    typeof capabilities.textDocumentSync === 'object'
      ? capabilities.textDocumentSync.change
      : capabilities.textDocumentSync

  async function touchFile(input: string): Promise<number> {
    const file = path.resolve(options.cwd, input)
    const uri = pathToFileURL(file).href
    const text = readFileSync(file, 'utf8')
    const doc = documents.get(file)
    const version = doc ? doc.version + 1 : 0
    notify('workspace/didChangeWatchedFiles', { changes: [{ uri, type: doc ? 2 : 1 }] })
    if (doc) {
      notify('textDocument/didChange', {
        textDocument: { uri, version },
        contentChanges:
          syncKind === 2
            ? [{ range: { start: { line: 0, character: 0 }, end: endPosition(doc.text) }, text }]
            : [{ text }],
      })
    } else {
      notify('textDocument/didOpen', {
        textDocument: { uri, languageId: languageIdFor(file), version, text },
      })
    }
    documents.set(file, { version, text })
    return version
  }

  function waitForFreshPush(
    file: string,
    after: number,
    timeoutMs: number,
    requireNonEmpty: boolean,
  ): Promise<boolean> {
    const graceMs = options.diagnosticsGraceMs ?? 3000
    return new Promise<boolean>((resolve) => {
      let settleTimer: NodeJS.Timeout | undefined
      let graceTimer: NodeJS.Timeout | undefined
      let overallTimer: NodeJS.Timeout | undefined
      let sawPublication = false
      let sawNonEmpty = false
      const done = (result: boolean) => {
        if (settleTimer) clearTimeout(settleTimer)
        if (graceTimer) clearTimeout(graceTimer)
        if (overallTimer) clearTimeout(overallTimer)
        pushWaiters.get(file)?.delete(check)
        resolve(result)
      }
      const armGrace = () => {
        if (graceTimer) return
        // A provisional empty publish means the server is still analyzing;
        // give it a grace window to send the real diagnostics.
        graceTimer = setTimeout(() => done(sawPublication), graceMs)
      }
      const check = () => {
        const hit = published.get(file)
        if (!hit || hit.at < after) return
        sawPublication = true
        const count = pushDiagnostics.get(file)?.length ?? 0
        if (count > 0) {
          sawNonEmpty = true
          if (settleTimer) clearTimeout(settleTimer)
          settleTimer = setTimeout(() => done(true), SETTLE_MS)
        } else if (!sawNonEmpty && !requireNonEmpty) {
          armGrace()
        }
      }
      const set = pushWaiters.get(file) ?? new Set<() => void>()
      set.add(check)
      pushWaiters.set(file, set)
      overallTimer = setTimeout(() => done(sawPublication), timeoutMs)
      check()
    })
  }

  async function waitForDiagnostics(input: {
    path: string
    version: number
    mode?: 'document' | 'full'
    after?: number
    requireNonEmpty?: boolean
  }): Promise<void> {
    const file = path.resolve(options.cwd, input.path)
    const after = input.after ?? Date.now()
    const hasPull = Boolean(capabilities.diagnosticProvider)
    if (hasPull) {
      const result = await requestWithTimeout<{ items?: Diagnostic[] }>(
        'textDocument/diagnostic',
        { textDocument: { uri: pathToFileURL(file).href } },
        options.timeoutMs,
      )
      if (result?.items) pullDiagnostics.set(file, result.items)
    }
    const hasRealPull = (pullDiagnostics.get(file)?.length ?? 0) > 0
    const requireNonEmpty = (input.requireNonEmpty ?? input.mode === 'full') && !hasRealPull
    await waitForFreshPush(file, after, options.timeoutMs, requireNonEmpty)
  }

  async function shutdown(): Promise<void> {
    if (ended) return
    ended = true
    try {
      await requestWithTimeout('shutdown', null, 2000)
    } catch {
      // process may already be gone; close below still guarantees cleanup
    }
    try {
      notify('exit', undefined)
    } catch {
      // already closed
    }
    child.kill('SIGTERM')
  }

  return {
    serverID: options.serverID,
    root: options.cwd,
    touchFile,
    waitForDiagnostics,
    get diagnostics() {
      const result = new Map<string, Diagnostic[]>()
      for (const key of new Set([...pushDiagnostics.keys(), ...pullDiagnostics.keys()])) {
        result.set(key, merged(key))
      }
      return result
    },
    request: <T>(method: string, params?: unknown) =>
      requestWithTimeout<T>(method, params, options.timeoutMs),
    shutdown,
  }
}

function dedupe(items: Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>()
  return items.filter((item) => {
    const key = `${item.source ?? ''}|${item.code ?? ''}|${item.message}|${item.range.start.line}:${item.range.start.character}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function endPosition(text: string): { line: number; character: number } {
  const lines = text.split(/\r\n|\r|\n/)
  return { line: lines.length - 1, character: lines.at(-1)?.length ?? 0 }
}
