import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { join } from 'node:path'
import { homedir } from 'node:os'
import {
  Config,
  LSP_SETTINGS_NAMESPACE,
  mergeConfig,
  resolveConfig,
  type LspSettings,
  type ResolvedLspConfig,
} from './config.ts'
import { LspManager } from './manager.ts'
import type { SessionStatus } from './manager.ts'
import { RootPool } from './pool.ts'
import { ProgressiveSink, toolResultLike } from './progressive.ts'
import path from 'node:path'
import { DEFAULT_SERVERS } from './catalog.ts'
import {
  createDiagnosticsTool,
  createFixTool,
  createStatusTool,
} from './tools.ts'
import {
  createCallHierarchyTool,
  createDefinitionTool,
  createHoverTool,
  createImplementationTool,
  createReferencesTool,
  createRenameTool,
  createSymbolsTool,
  createWorkspaceSymbolTool,
} from './queries.ts'
import { installLspWeb } from './web.ts'

export const name = 'dsh-lsp'

export { Config }

export const inject = ['tools', 'agents', 'settings', 'commands']

/** DSH editing tools whose edits we track for progressive diagnostics. */
const PROGRESSIVE_MUTATING = new Set(['edit', 'write', 'lsp_fix', 'apply_patch'])

/** Union of catalog root markers plus `.git`, used to key shared managers by
 *  project root so agents whose cwd falls under the same project share one
 *  LspManager (dedupe sessions + bounded process count). */
const BOUNDARY_MARKERS = [...new Set([
  ...Object.values(DEFAULT_SERVERS).flatMap((s) => s.rootMarkers ?? []),
  '.git',
])]

/** Surface a progressive-diagnostics summary per the configured inject mode. */
function surfaceInjection(
  ctx: Context,
  config: ResolvedLspConfig['progressive'],
  agent: Agent | undefined,
  text: string,
): void {
  switch (config.inject) {
    case 'status':
      // Status card / running line text (the Web UI mirrors this via /_dsh/lsp).
      ctx.logger.info('dsh-lsp: %s', text.split('\n')[0] ?? text)
      break
    case 'conversation':
      if (agent) {
        try {
          const message: UserMessage = createUserMessage({
            content: [{ type: 'text', text }],
            source: { kind: 'plugin', plugin: 'dsh-lsp', form: 'relay' },
          })
          agent.inject(message)
        } catch (error) {
          ctx.logger.warn('dsh-lsp: conversation injection failed: %s', error instanceof Error ? error.message : String(error))
        }
      }
      break
    default:
      break
  }
}

export function apply(ctx: Context, base: Partial<LspSettings> = {}) {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const settings = ctx.settings.register(LSP_SETTINGS_NAMESPACE, Config, {
    base: base as Record<string, unknown>,
    applies: 'live',
    validate: (value: unknown) => {
      resolveConfig(mergeConfig(value))
    },
  })

  let resolved: ResolvedLspConfig = resolveConfig(mergeConfig(settings.get()))
  const settingsWatch = settings.watch(async (next: unknown) => {
    resolved = resolveConfig(mergeConfig(next))
  })

  // Shared LSP manager pool keyed by resolved project root (the agent's
  // workspace cwd), so agents in the same workspace share one LspManager —
  // sessions are reused, processes are bounded, and teardown is refcounted.
  const pool = new RootPool<LspManager>(
    (root) => new LspManager({ config: resolved, cwd: root, onStatus: () => {} }),
    (_root, manager) => { void manager.shutdown() },
  )
  const agentIdOf = (agent: Agent): string => String(agent.id)
  const rootKeyOf = (agent: Agent): string => {
    const cwd = (agent.session?.header?.cwd as string | undefined)
    return cwd && cwd.length > 0 ? path.resolve(cwd) : process.cwd()
  }
  const getManager = (agent: Agent | undefined): LspManager => {
    if (!agent) throw new Error('LSP requires an agent session')
    return pool.acquire(rootKeyOf(agent), agent)
  }
  const releaseManager = (agent: Agent): void => { pool.release(agent) }
  const getManagerFromExec = (exec: ToolRunContext): LspManager =>
    getManager(exec.agent)

  // Register the 11 tools once; each routes through the calling agent's manager.
  const toolDisposers = [
    createDiagnosticsTool(getManagerFromExec),
    createStatusTool(getManagerFromExec),
    createFixTool(getManagerFromExec),
    createHoverTool(getManagerFromExec),
    createDefinitionTool(getManagerFromExec),
    createReferencesTool(getManagerFromExec),
    createImplementationTool(getManagerFromExec),
    createSymbolsTool(getManagerFromExec),
    createWorkspaceSymbolTool(getManagerFromExec),
    createCallHierarchyTool(getManagerFromExec),
    createRenameTool(getManagerFromExec),
  ].map((tool) => ctx.tools.register(tool))

  const liveStatus = (): SessionStatus[] => {
    const out: SessionStatus[] = []
    for (const manager of pool.handles) out.push(...manager.status())
    return out
  }

  // ── /lsp slash command ─────────────────────────────────────────────────────
  const commandDisposer = ctx.commands.register({
    name: 'lsp',
    description:
      'Show live LSP server sessions (id, root, status) and which servers failed to start, or refresh broken-state markers.',
    handler: async (invocation) => {
      const parts = invocation.rawInput.trim().split(/\s+/).filter(Boolean)
      const sub = parts[0] ?? ''
      if (sub === 'refresh') {
        for (const manager of pool.handles) manager.refresh()
        return { kind: 'success', text: 'LSP broken-state markers cleared.' }
      }
      const sessions = liveStatus()
      let lines = sessions.length
        ? sessions.map((s) => `${s.id} @ ${s.root}: ${s.status}`)
        : ['No LSP sessions started yet.']
      if (sub === 'show') {
        const configured = Object.keys(resolved.servers)
        lines = [
          `Configured servers: ${configured.length ? configured.join(', ') : '(none)'}`,
          ...lines,
        ]
      }
      lines.push('Config via the Settings page (LSP section) or the `lsp` namespace in settings.yaml.')
      return { kind: 'success', text: lines.join('\n') }
    },
  })

  // ── Progressive diagnostics: track edits, surface at turn-stopping ────────
  const pendingEdits = new Map<string, Array<{ toolName: string; input?: { path?: string; command?: string } }>>()
  const sinks = new Map<string, ProgressiveSink>()
  const sinkFor = (agent: Agent): ProgressiveSink => {
    const id = agentIdOf(agent)
    let sink = sinks.get(id)
    if (!sink) {
      sink = new ProgressiveSink({
        manager: {
          touchFile: (file, mode) => getManager(agent).touchFile(file, mode),
          diagnostics: () => getManager(agent).diagnostics(),
          getClients: (file) => getManager(agent).getClients(file),
        },
        config: resolved.progressive,
        onInjection: (text) => surfaceInjection(ctx, resolved.progressive, agent, text),
      })
      sinks.set(id, sink)
    }
    return sink
  }


  const toolsResultDisposer = ctx.on('tools/result', (exec, _result) => {
    if (!exec?.agent) return
    if (!PROGRESSIVE_MUTATING.has(exec.name) && exec.name !== 'bash') return
    const agent = exec.agent
    const id = agentIdOf(agent)
    const acc = pendingEdits.get(id) ?? []
    acc.push(toolResultLike(exec.name, exec.arguments))
    pendingEdits.set(id, acc)
    void sinkFor(agent)
  })

  const turnStoppingDisposer = ctx.on('agent/turn-stopping', async (payload) => {
    const agent = payload.agent
    const id = agentIdOf(agent)
    const acc = pendingEdits.get(id)
    pendingEdits.delete(id)
    if (!acc || acc.length === 0) return
    const sink = sinks.get(id)
    if (!sink) return
    try {
      await sink.handleTurn(acc)
    } catch (error) {
      ctx.logger.warn('dsh-lsp: progressive diagnostics failed: %s', error instanceof Error ? error.message : String(error))
    }
  })

  // ── lifecycle teardown per agent ──────────────────────────────────────────
  const agentDisposedDisposer = ctx.on('agent/disposed', ({ agent }) => {
    const id = agentIdOf(agent)
    pendingEdits.delete(id)
    sinks.delete(id)
    releaseManager(agent)
  })

  installLspWeb(ctx, () => resolved, liveStatus)

  ctx.logger.info('dsh-lsp ready (%d server routes configured)', Object.keys(resolved.servers).length)

  // Full lifecycle teardown (LIFO over registration order); fiber-scoped
  // registrations (settings namespace, web routes) are also auto-disposed.
  return () => {
    agentDisposedDisposer()
    turnStoppingDisposer()
    toolsResultDisposer()
    commandDisposer()
    toolDisposers.forEach((dispose) => dispose())
    settingsWatch()
    pool.releaseAll((_root, manager) => { void manager.shutdown() })
  }
}
