import type { ProgressiveConfig } from './config.js'
import type { Diagnostic } from './types.js'

// Progressive diagnostics: after each agent turn, collect the files the agent
// edited (edit/write/lsp_fix tool results, plus bash redirect targets), re-sync
// them with the live LSP sessions, and surface a throttled, compact summary.

export const MUTATING_TOOLS = new Set(['edit', 'write', 'lsp_fix', 'apply_patch'])
export const REDIRECT_RE = /(?:>>|>)\s*("[^"]+"|'[^']+'|[^\s;|&]+)/g

export interface ToolResultLike {
  toolName: string
  input?: { path?: string; command?: string }
}

export function collectEditedFiles(toolResults: ToolResultLike[]): string[] {
  const files: string[] = []
  for (const result of toolResults) {
    const input = result.input ?? {}
    if (MUTATING_TOOLS.has(result.toolName) && input.path) files.push(input.path)
    if (result.toolName === 'bash' && input.command) {
      for (const match of input.command.matchAll(REDIRECT_RE)) {
        files.push(match[1]!.replace(/^["']|["']$/g, ''))
      }
    }
  }
  return [...new Set(files)]
}

export function buildInjection(diagnostics: Record<string, Diagnostic[]>, max: number): string | undefined {
  const lines: string[] = []
  let count = 0
  for (const [file, diags] of Object.entries(diagnostics)) {
    if (!diags.length) continue
    const shown = diags.slice(0, Math.max(0, max - count))
    count += shown.length
    for (const d of shown) {
      lines.push(`${file}:${d.range.start.line + 1}: ${d.message}`)
    }
    if (count >= max) break
  }
  if (!lines.length) return undefined
  return `LSP diagnostics after edits (showing ${Math.min(count, max)}):\n${lines.join('\n')}`
}

export interface ProgressiveDeps {
  manager: {
    touchFile(file: string, mode?: 'document' | 'full'): Promise<void>
    diagnostics(): Promise<Record<string, Diagnostic[]>>
    getClients(file: string): Promise<unknown[]>
  }
  config: ProgressiveConfig
  onInjection: (text: string) => void
  now?: () => number
}

export class ProgressiveSink {
  readonly #deps: ProgressiveDeps
  #lastInjectionAt = Number.NEGATIVE_INFINITY

  constructor(deps: ProgressiveDeps) {
    this.#deps = deps
  }

  /** Returns the injected text, or undefined when nothing was injected. */
  async handleTurn(toolResults: unknown[]): Promise<string | undefined> {
    const { config } = this.#deps
    if (!config.enabled || config.inject === 'none') return undefined

    const files = collectEditedFiles(toolResults as ToolResultLike[])
    if (!files.length) return undefined

    for (const file of files) {
      await this.#deps.manager.touchFile(file, 'document')
    }

    const now = this.#deps.now?.() ?? Date.now()
    if (now - this.#lastInjectionAt < config.quietMs) return undefined

    const diagnostics = await this.#deps.manager.diagnostics()
    const text = buildInjection(diagnostics, config.maxDiagnostics)
    if (!text) return undefined

    this.#lastInjectionAt = now
    this.#deps.onInjection(text)
    return text
  }
}

/**
 * Map one settled tool execution (from a `tools/result` listener) to the shape
 * `collectEditedFiles` reads: file edits by `path`, bash by its command string.
 */
export function toolResultLike(
  name: string,
  args: unknown,
): ToolResultLike {
  const input = (args ?? {}) as Record<string, unknown>
  const pathValue =
    typeof input.path === 'string' ? input.path : typeof input.file === 'string' ? input.file : undefined
  const command = typeof input.command === 'string' ? input.command : undefined
  return { toolName: name, input: { path: pathValue, command } }
}
