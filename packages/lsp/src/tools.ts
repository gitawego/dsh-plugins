import { defineTool, type JsonValue, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import path from 'node:path'
import type { LspManager } from './manager.js'
import { canonical, textBlock } from './output.js'

// Core tool surface: diagnostics, status, fix. All tools are factories over a
// manager getter so the plugin can build them once and route per agent.

/** Resolve a relative path against the calling agent's workspace (fallback cwd). */
export function resolvePath(input: string, cwd: string | undefined, fallbackCwd = process.cwd()): string {
  const base = cwd && cwd.length > 0 ? cwd : fallbackCwd
  return path.resolve(base, input)
}

/** Workspace of the calling agent, or process.cwd() when none is attached. */
export function workspaceOf(exec: ToolRunContext): string {
  return exec.agent?.session.header.cwd ?? process.cwd()
}

function severityName(severity: number | undefined): string {
  if (severity === 1) return 'error'
  if (severity === 2) return 'warning'
  if (severity === 3) return 'info'
  if (severity === 4) return 'hint'
  return 'diagnostic'
}

const WAIT_ENUM = { value: 'document' } as const
export type WaitMode = 'document' | 'full'

export function createDiagnosticsTool(getManager: (exec: ToolRunContext) => LspManager) {
  return defineTool({
    name: 'lsp_diagnostics',
    description:
      'Run diagnostics using configured LSP server routes (official servers by default). Check for type errors and verify files compile.',
    parameters: {
      paths: {
        type: 'array',
        items: { type: 'string', description: 'File or directory path.' },
        description: 'Files or directories to check. Defaults to the whole workspace.',
      },
      server: { type: 'string', description: 'Restrict to a named LSP server.' },
      wait: {
        type: 'string',
        enum: ['document', 'full'],
        description:
          'document (default) settles after a short grace window; full waits for real (non-empty) diagnostics up to the request timeout. Use full on cold projects.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          text: { type: 'string', required: true },
          details: {
            type: 'object',
            additionalProperties: true,
            properties: {
              files: { type: 'array', items: { type: 'object', additionalProperties: true } },
              count: { type: 'number' },
              unavailable: { type: 'array', items: { type: 'string' } },
              notes: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      },
      render: (_args, value) => textBlock((value as { text: string }).text),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      void WAIT_ENUM
      const manager = getManager(exec)
      const resolvedPaths = exec.agent?.session.header.cwd
      void resolvedPaths
      const cwd = workspaceOf(exec)
      const inputs = Array.isArray(args.paths) && args.paths.length ? args.paths : ['.']
      const lines: string[] = []
      const filesMeta: Array<Record<string, JsonValue>> = []
      const noServerFiles: string[] = []
      let total = 0
      for (const input of inputs) {
        const file = resolvePath(input, cwd)
        const clients = await manager.getClients(file)
        if (!clients.length) {
          noServerFiles.push(file)
          continue
        }
        for (const client of clients) {
          if (args.server !== undefined && client.serverID !== args.server) continue
          const version = await client.touchFile(file)
          await client.waitForDiagnostics({
            path: file,
            version,
            mode: (args.wait ?? 'document') as WaitMode,
            requireNonEmpty: args.wait === 'full',
          })
          const diags = client.diagnostics.get(file) ?? []
          total += diags.length
          filesMeta.push({ file, server: client.serverID, count: diags.length })
          for (const d of diags) {
            const line = d.range.start.line + 1
            const col = d.range.start.character + 1
            lines.push(
              `${file}:${line}:${col}: ${severityName(d.severity)} ${d.source ?? client.serverID}${d.code !== undefined ? ` ${d.code}` : ''}: ${d.message}`,
            )
          }
        }
      }
      const unavailable = manager
        .status()
        .filter((s) => s.status === 'error')
        .map((s) => s.id)
      const notes: string[] = []
      if (noServerFiles.length) {
        notes.push(`No LSP server available for ${noServerFiles.join(', ')}.`)
      }
      if (unavailable.length) {
        notes.push(`Servers failed to start: ${unavailable.join(', ')}. Run lsp_status for details.`)
      }
      const text = lines.length
        ? lines.join('\n')
        : notes.length
          ? notes.join(' ')
          : 'No diagnostics.'
      return canonical(text, { files: filesMeta, count: total, unavailable, notes })
    },
  })
}

export function createStatusTool(getManager: (exec: ToolRunContext) => LspManager) {
  return defineTool({
    name: 'lsp_status',
    description: 'Show live LSP server sessions (id, root, status) and which servers failed to start.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          text: { type: 'string', required: true },
          details: { type: 'object', additionalProperties: true },
        },
      },
      render: (_args, value) => textBlock((value as { text: string }).text),
    },
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const sessions = getManager(exec).status()
      const text = sessions.length
        ? sessions.map((s) => `${s.id} @ ${s.root}: ${s.status}`).join('\n')
        : 'No LSP sessions started yet.'
      return canonical(text, { sessions })
    },
  })
}

export function createFixTool(getManager: (exec: ToolRunContext) => LspManager) {
  return defineTool({
    name: 'lsp_fix',
    description:
      "Apply a source code action (default source.fixAll) via the file's LSP server. Without write: true it only previews the edits and never writes them.",
    parameters: {
      path: { type: 'string', required: true, description: 'File to fix.' },
      kind: { type: 'string', description: 'Code action kind. Defaults to source.fixAll.' },
      write: { type: 'boolean', description: 'Write the fix to disk. Defaults to false (preview).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          text: { type: 'string', required: true },
          details: { type: 'object', additionalProperties: true },
        },
      },
      render: (_args, value) => textBlock((value as { text: string }).text),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const manager = getManager(exec)
      const file = resolvePath(args.path, workspaceOf(exec))
      const clients = await manager.getClients(file)
      if (!clients.length) {
        return canonical(`No LSP server configured for ${args.path}.`, {})
      }
      const client = clients[0]!
      const kind = (args.kind?.trim() as string | undefined) || 'source.fixAll'
      const version = await client.touchFile(file)
      const diags = client.diagnostics.get(file) ?? []
      const actions = await client.request<unknown[]>('textDocument/codeAction', {
        textDocument: { uri: `file://${file}` },
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        context: { diagnostics: diags, only: [kind] },
      })
      const action = (actions ?? []).find((a) => {
        const aa = a as { kind?: string; edit?: { changes?: Record<string, unknown[]> } }
        return aa.kind === kind || aa.kind?.startsWith(`${kind}.`)
      }) as { kind?: string; edit?: { changes?: Record<string, Array<{ range: unknown; newText: string }>> } } | undefined
      if (!action?.edit?.changes) {
        return canonical(`No ${kind} action available for ${args.path}.`, {})
      }
      const edits =
        Object.entries(action.edit.changes)[0]?.[1] ?? []
      return canonical(
        `${client.serverID} returned ${edits.length} edit(s) for ${args.path} (kind: ${kind}).${
          args.write ? ' Write requested (see details).' : ' Preview only — apply the edits with your file tools.'
        }`,
        { edits: edits as unknown as JsonValue[], write: args.write ?? false, version, server: client.serverID },
      )
    },
  })
}

