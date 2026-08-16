import { defineTool, type JsonValue, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { pathToFileURL } from 'node:url'
import type { LspManager } from './manager.js'
import { resolvePath, workspaceOf } from './tools.js'
import { textBlock } from './output.js'

// Rich query tools: hover, definition, references, symbols, rename. Thin
// sendRequest wrappers through the manager's first-matching-client semantics.
// Each tool declares its output inline so defineTool contextually types the
// schema + render (values are canonical `{ text, details }` objects).

const PositionProps = {
  path: { type: 'string', required: true, description: 'File path (absolute or relative to the workspace).' },
  line: { type: 'number', required: true, description: 'Zero-based line.' },
  character: { type: 'number', required: true, description: 'Zero-based character.' },
} as const

interface LocationLike {
  uri?: string
  range?: { start: { line: number; character: number } }
}

function renderLocations(locations: LocationLike[]): string {
  const lines = locations.map((l) => {
    const file = l.uri?.startsWith('file://')
      ? decodeURIComponent(new URL(l.uri).pathname)
      : (l.uri ?? '?')
    return `${file}:${(l.range?.start.line ?? 0) + 1}:${(l.range?.start.character ?? 0) + 1}`
  })
  return lines.length ? lines.join('\n') : 'No results.'
}

function out(text: string, details: Record<string, unknown>) {
  return { text, details } as Record<string, JsonValue> & { text: string }
}

export function createDefinitionTool(getManager: (exec: ToolRunContext) => LspManager) {
  return defineTool({
    name: 'lsp_definition',
    description: 'Find the definition of the symbol at a position.',
    parameters: PositionProps,
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { text: { type: 'string', required: true }, details: { type: 'object', additionalProperties: true } } },
      render: (_args, value) => textBlock((value as { text: string }).text),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const file = resolvePath(args.path, workspaceOf(exec))
      const locations = (await getManager(exec).request<LocationLike[]>(file, 'textDocument/definition', {
        textDocument: { uri: pathToFileURL(file).href },
        position: { line: args.line, character: args.character },
      })) ?? []
      return out(renderLocations(locations), { locations: locations as unknown as JsonValue[] })
    },
  })
}

export function createReferencesTool(getManager: (exec: ToolRunContext) => LspManager) {
  return defineTool({
    name: 'lsp_references',
    description: 'Find all references to the symbol at a position (including the declaration).',
    parameters: PositionProps,
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { text: { type: 'string', required: true }, details: { type: 'object', additionalProperties: true } } },
      render: (_args, value) => textBlock((value as { text: string }).text),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const file = resolvePath(args.path, workspaceOf(exec))
      const locations = (await getManager(exec).request<LocationLike[]>(file, 'textDocument/references', {
        textDocument: { uri: pathToFileURL(file).href },
        position: { line: args.line, character: args.character },
        context: { includeDeclaration: true },
      })) ?? []
      return out(renderLocations(locations), { locations: locations as unknown as JsonValue[] })
    },
  })
}

export function createHoverTool(getManager: (exec: ToolRunContext) => LspManager) {
  return defineTool({
    name: 'lsp_hover',
    description: 'Get hover documentation for the symbol at a position.',
    parameters: PositionProps,
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { text: { type: 'string', required: true }, details: { type: 'object', additionalProperties: true } } },
      render: (_args, value) => textBlock((value as { text: string }).text),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const file = resolvePath(args.path, workspaceOf(exec))
      const hover = (await getManager(exec).request<{ contents?: unknown }>(file, 'textDocument/hover', {
        textDocument: { uri: pathToFileURL(file).href },
        position: { line: args.line, character: args.character },
      })) ?? null
      const value =
        typeof hover?.contents === 'string'
          ? hover.contents
          : ((hover?.contents as { value?: unknown } | undefined)?.value ??
            (hover?.contents ? JSON.stringify(hover.contents) : 'No hover info.'))
      return out(String(value), { hover: hover as unknown as JsonValue })
    },
  })
}

export function createImplementationTool(getManager: (exec: ToolRunContext) => LspManager) {
  return defineTool({
    name: 'lsp_implementation',
    description: 'Find implementations of the symbol at a position.',
    parameters: PositionProps,
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { text: { type: 'string', required: true }, details: { type: 'object', additionalProperties: true } } },
      render: (_args, value) => textBlock((value as { text: string }).text),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const file = resolvePath(args.path, workspaceOf(exec))
      const locations = (await getManager(exec).implementation({
        file,
        line: args.line,
        character: args.character,
      })) as LocationLike[]
      return out(renderLocations(locations ?? []), { locations: (locations ?? []) as unknown as JsonValue[] })
    },
  })
}

export function createWorkspaceSymbolTool(getManager: (exec: ToolRunContext) => LspManager) {
  return defineTool({
    name: 'lsp_workspace_symbol',
    description: 'Search workspace symbols by query (classes, functions, methods, ...). Up to 10 results.',
    parameters: { query: { type: 'string', required: true, description: 'Symbol name query.' } },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { text: { type: 'string', required: true }, details: { type: 'object', additionalProperties: true } } },
      render: (_args, value) => textBlock((value as { text: string }).text),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const symbols = (await getManager(exec).workspaceSymbol(args.query)) ?? []
      const text = symbols.length
        ? symbols.map((s) => `${s.name} (kind ${s.kind})`).join('\n')
        : 'No workspace symbols found.'
      return out(text, { symbols: symbols as unknown as JsonValue[] })
    },
  })
}

export function createCallHierarchyTool(getManager: (exec: ToolRunContext) => LspManager) {
  return defineTool({
    name: 'lsp_call_hierarchy',
    description:
      'Prepare call hierarchy for the symbol at a position, or list incoming/outgoing calls.',
    parameters: {
      ...PositionProps,
      direction: {
        type: 'string',
        enum: ['prepare', 'incoming', 'outgoing'],
        description: 'prepare | incoming | outgoing. Defaults to prepare.',
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { text: { type: 'string', required: true }, details: { type: 'object', additionalProperties: true } } },
      render: (_args, value) => textBlock((value as { text: string }).text),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const manager = getManager(exec)
      const file = resolvePath(args.path, workspaceOf(exec))
      const input = { file, line: args.line, character: args.character }
      const direction = (args.direction as 'prepare' | 'incoming' | 'outgoing' | undefined) ?? 'prepare'
      const items =
        direction === 'incoming'
          ? ((await manager.incomingCalls(input)) ?? [])
          : direction === 'outgoing'
            ? ((await manager.outgoingCalls(input)) ?? [])
            : ((await manager.prepareCallHierarchy(input)) ?? [])
      const names = (
        items as Array<{ name?: string; from?: { name?: string }; to?: { name?: string } }>
      ).map((item) => item.name ?? item.from?.name ?? item.to?.name ?? '?')
      const text = names.length ? names.join('\n') : `No ${direction} call hierarchy items.`
      return out(text, { direction, items: items as unknown as JsonValue[] })
    },
  })
}

export function createSymbolsTool(getManager: (exec: ToolRunContext) => LspManager) {
  return defineTool({
    name: 'lsp_symbols',
    description: 'List symbols declared in a file.',
    parameters: { path: { type: 'string', required: true, description: 'File path.' } },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { text: { type: 'string', required: true }, details: { type: 'object', additionalProperties: true } } },
      render: (_args, value) => textBlock((value as { text: string }).text),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const file = resolvePath(args.path, workspaceOf(exec))
      const symbols = (await getManager(exec).request<Array<{ name: string }>>(
        file,
        'textDocument/documentSymbol',
        { textDocument: { uri: pathToFileURL(file).href } },
      )) ?? []
      const names = symbols.map((s) => s.name)
      return out(names.length ? names.join('\n') : 'No symbols.', { symbols: names })
    },
  })
}

export function createRenameTool(getManager: (exec: ToolRunContext) => LspManager) {
  return defineTool({
    name: 'lsp_rename',
    description:
      'Compute a workspace rename of the symbol at a position. Preview only — returns edits, never writes.',
    parameters: {
      ...PositionProps,
      newName: { type: 'string', required: true, description: 'New symbol name.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { text: { type: 'string', required: true }, details: { type: 'object', additionalProperties: true } } },
      render: (_args, value) => textBlock((value as { text: string }).text),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const file = resolvePath(args.path, workspaceOf(exec))
      const edit = (await getManager(exec).request<{ changes?: Record<string, unknown[]> }>(
        file,
        'textDocument/rename',
        {
          textDocument: { uri: pathToFileURL(file).href },
          position: { line: args.line, character: args.character },
          newName: args.newName,
        },
      )) ?? null
      const changes = (edit?.changes ?? {}) as Record<string, unknown[]>
      const count = Object.values(changes).reduce((n, arr) => n + arr.length, 0)
      return out(
        `${args.newName}: ${count} edit(s) across ${Object.keys(changes).length} file(s).`,
        { edit: edit as unknown as JsonValue },
      )
    },
  })
}
