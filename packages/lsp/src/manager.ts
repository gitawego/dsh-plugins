import { resolveBinary, resolveCommand } from './binary.js'
import { createClient, type LspClient } from './client.js'
import type { ResolvedLspConfig, ResolvedServer } from './config.js'
import { canAutoDownload, downloadPlanFor, feasibleOn, install } from './download.js'
import { detectPlatform } from './platform.js'
import { resolveTsserverPath } from './tsserver.js'
import { nearestRoot } from './root.js'
import type { Diagnostic } from './types.js'
import { fileURLToPath, pathToFileURL } from 'node:url'

// LspManager (OpenCode/pi-lsp-inspired): a lazy pool of persistent LSP clients,
// keyed by (projectRoot, serverID). Servers start on first use for a matching
// file, are reused across calls, are marked broken (no retry storms) when they
// fail to start, and are all shut down when disposed.

export interface LocInput {
  file: string
  line: number
  character: number
}

export interface LspSymbol {
  name: string
  kind: number
  location?: { uri?: string; range?: unknown }
}

export interface SessionStatus {
  id: string
  name: string
  root: string
  status: 'connected' | 'error'
}

// SymbolKind values kept for workspace/symbol results.
const SYMBOL_KINDS = new Set([5, 12, 6, 11, 13, 14, 23, 10])

export interface ManagerOptions {
  config: ResolvedLspConfig
  cwd: string
  signal?: AbortSignal
  onStatus?: (text: string | undefined) => void
}

interface ClientState {
  client: LspClient
  root: string
}

export class LspManager {
  readonly #options: ManagerOptions
  readonly #clients = new Map<string, ClientState>()
  readonly #spawning = new Map<string, Promise<LspClient | undefined>>()
  readonly #broken = new Set<string>()
  #shutdown = false

  constructor(options: ManagerOptions) {
    this.#options = options
  }

  /** All live clients that serve `file` (lazy-started). Empty when none match or all failed. */
  async getClients(file: string): Promise<LspClient[]> {
    if (this.#shutdown) return []
    const result: LspClient[] = []
    for (const [id, server] of Object.entries(this.#options.config.servers)) {
      if (!server.extensions.some((ext) => file.endsWith(ext))) continue
      const root = await nearestRoot(server.rootMarkers ?? [])(file, { directory: this.#options.cwd })
      if (!root) continue
      const key = `${root}\u0000${id}`
      if (this.#broken.has(key)) continue
      const existing = this.#clients.get(key)
      if (existing) {
        result.push(existing.client)
        continue
      }
      const inflight = this.#spawning.get(key)
      if (inflight) {
        const client = await inflight
        if (client) result.push(client)
        continue
      }
      const client = await this.#spawn(id, server, root, key)
      if (client) result.push(client)
    }
    return result
  }

  async #spawn(
    id: string,
    server: ResolvedServer,
    root: string,
    key: string,
  ): Promise<LspClient | undefined> {
    const task = (async () => {
      const env = { ...process.env, ...server.env }
      let resolved = await resolveCommand(server, root, env)
      const info = detectPlatform(env)
      // Auto-download intent: when the binary is missing and this server opts in
      // on a supported platform, try a managed install before declaring a miss.
      if (!resolved && canAutoDownload(server) && info.supported) {
        const plan = downloadPlanFor({ id, download: server.download })
        if (plan && (await feasibleOn(plan, info, env))) {
          this.#options.onStatus?.(`${id} installing`)
          try {
            const installed = await install(plan, info, {
              binDir: this.#options.config.binDir,
              env,
            })
            if (installed) {
              const [name, ...args] = server.command
              void args
              if (!name) return
              const resolvedAfter = await resolveBinary(name, root, { env })
              if (resolvedAfter && installed === resolvedAfter) {
                resolved = { command: resolvedAfter, args }
              }
            }
          } finally {
            this.#options.onStatus?.(undefined)
          }
        }
      }
      if (!resolved) {
        this.#broken.add(key)
        return undefined
      }
      // Transparent global TypeScript payload: typescript-language-server needs
      // a real `tsserver` (typescript JS payload). Resolve (or install globally)
      // one so boot never fails with an opaque "no TypeScript installation".
      let effectiveInitialization = server.initialization
      if (id === 'typescript') {
        const explicit = (server.initialization?.tsserver as { path?: string } | undefined)?.path
        const ts = await resolveTsserverPath({
          binDir: this.#options.config.binDir,
          cwd: root,
          explicit,
          info,
          version: server.payloadVersion,
          onStatus: this.#options.onStatus,
        })
        if (ts.path) {
          effectiveInitialization = {
            ...(server.initialization ?? {}),
            tsserver: { path: ts.path },
          }
        }
        if (ts.action) {
          this.#options.onStatus?.(`${id}: ${ts.action}`)
        }
      }
      this.#options.onStatus?.(`${id} starting`)
      try {
        const client = await createClient({
          serverID: id,
          command: [resolved.command, ...resolved.args],
          cwd: root,
          initialization: effectiveInitialization,
          env: server.env,
          timeoutMs: this.#options.config.timeout,
          signal: this.#options.signal,
        })
        this.#clients.set(key, { client, root })
        return client
      } catch {
        this.#broken.add(key)
        return undefined
      } finally {
        this.#options.onStatus?.(undefined)
      }
    })()
    this.#spawning.set(key, task)
    task.finally(() => {
      if (this.#spawning.get(key) === task) this.#spawning.delete(key)
    })
    return task
  }

  /** Open/re-sync a file in all matching clients and optionally wait for diagnostics. */
  async touchFile(file: string, diagnostics?: 'document' | 'full'): Promise<void> {
    const clients = await this.getClients(file)
    await Promise.all(
      clients.map(async (client) => {
        const version = await client.touchFile(file)
        if (diagnostics) {
          await client.waitForDiagnostics({ path: file, version, mode: diagnostics })
        }
      }),
    )
  }

  /** Whether any configured server can serve `file` (extension + root + not broken). */
  async hasClients(file: string): Promise<boolean> {
    if (this.#shutdown) return false
    for (const [id, server] of Object.entries(this.#options.config.servers)) {
      if (!server.extensions.some((ext) => file.endsWith(ext))) continue
      const root = await nearestRoot(server.rootMarkers ?? [])(file, { directory: this.#options.cwd })
      if (!root) continue
      const key = `${root}\u0000${id}`
      if (this.#broken.has(key)) continue
      return true
    }
    return false
  }

  /** No-op warm init for API parity (sessions are lazy). */
  async init(): Promise<void> {}

  /** Merge diagnostics from all live clients into a Record keyed by absolute path. */
  async diagnostics(): Promise<Record<string, Diagnostic[]>> {
    const merged: Record<string, Diagnostic[]> = {}
    for (const state of this.#clients.values()) {
      for (const [file, diags] of state.client.diagnostics) {
        merged[file] = [...(merged[file] ?? []), ...diags]
      }
    }
    return merged
  }

  async hover(input: LocInput): Promise<unknown> {
    return this.request(input.file, 'textDocument/hover', {
      textDocument: { uri: pathToFileURL(input.file).href },
      position: { line: input.line, character: input.character },
    })
  }

  async definition(input: LocInput): Promise<unknown[]> {
    const result = await this.request<unknown[]>(input.file, 'textDocument/definition', {
      textDocument: { uri: pathToFileURL(input.file).href },
      position: { line: input.line, character: input.character },
    })
    return (result ?? []).flat().filter(Boolean)
  }

  async references(input: LocInput): Promise<unknown[]> {
    const result = await this.request<unknown[]>(input.file, 'textDocument/references', {
      textDocument: { uri: pathToFileURL(input.file).href },
      position: { line: input.line, character: input.character },
      context: { includeDeclaration: true },
    })
    return (result ?? []).flat().filter(Boolean)
  }

  async implementation(input: LocInput): Promise<unknown[]> {
    const result = await this.request<unknown[]>(input.file, 'textDocument/implementation', {
      textDocument: { uri: pathToFileURL(input.file).href },
      position: { line: input.line, character: input.character },
    })
    return (result ?? []).flat().filter(Boolean)
  }

  /** Takes a document URI; routed via the file path. */
  async documentSymbol(uri: string): Promise<unknown[]> {
    const file = uri.startsWith('file://') ? fileURLToPath(uri) : uri
    const result = await this.request<unknown[]>(file, 'textDocument/documentSymbol', {
      textDocument: { uri },
    })
    return (result ?? []).flat().filter(Boolean)
  }

  async workspaceSymbol(query: string): Promise<LspSymbol[]> {
    const results: LspSymbol[][] = []
    for (const state of this.#clients.values()) {
      const symbols = await state.client.request<LspSymbol[]>('workspace/symbol', { query })
      if (symbols) results.push(symbols)
    }
    return results
      .flat()
      .filter((s) => SYMBOL_KINDS.has(s.kind))
      .slice(0, 10)
  }

  async prepareCallHierarchy(input: LocInput): Promise<unknown[]> {
    const result = await this.request<unknown[]>(input.file, 'textDocument/prepareCallHierarchy', {
      textDocument: { uri: pathToFileURL(input.file).href },
      position: { line: input.line, character: input.character },
    })
    return (result ?? []).flat().filter(Boolean)
  }

  async incomingCalls(input: LocInput): Promise<unknown[]> {
    return this.#callHierarchy(input, 'callHierarchy/incomingCalls')
  }

  async outgoingCalls(input: LocInput): Promise<unknown[]> {
    return this.#callHierarchy(input, 'callHierarchy/outgoingCalls')
  }

  async #callHierarchy(
    input: LocInput,
    direction: 'callHierarchy/incomingCalls' | 'callHierarchy/outgoingCalls',
  ): Promise<unknown[]> {
    const prepared = await this.prepareCallHierarchy(input)
    if (!prepared.length) return []
    const result = await this.request<unknown[]>(input.file, direction, { item: prepared[0] })
    return (result ?? []).flat().filter(Boolean)
  }

  status(): SessionStatus[] {
    const result: SessionStatus[] = []
    for (const state of this.#clients.values()) {
      result.push({
        id: state.client.serverID,
        name: state.client.serverID,
        root: state.root,
        status: 'connected',
      })
    }
    for (const key of this.#broken) {
      const [root, id] = key.split('\u0000')
      result.push({ id: id ?? '?', name: id ?? '?', root: root ?? '?', status: 'error' })
    }
    return result
  }

  /** Clear broken markers (and any orphaned states) so servers can retry. */
  refresh(): void {
    this.#broken.clear()
  }

  /** Send a request through the first matching client that returns a result. */
  async request<T>(file: string, method: string, params?: unknown): Promise<T | null> {
    const clients = await this.getClients(file)
    const results = await Promise.all(clients.map((client) => client.request<T>(method, params)))
    const found = results.find((r) => r !== null && r !== undefined)
    return found ?? null
  }

  async shutdown(): Promise<void> {
    if (this.#shutdown) return
    this.#shutdown = true
    for (const task of this.#spawning.values()) {
      try {
        await task
      } catch {
        // ignore in-flight spawn failures
      }
    }
    await Promise.all([...this.#clients.values()].map((s) => s.client.shutdown()))
    this.#clients.clear()
  }
}
