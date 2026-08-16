/** dsh-lsp configuration: full pi-lsp surface, persisted in the DSH Settings
 *  document (`lsp` namespace) via ctx.settings. The `servers` map is the
 *  config-driven catalog: users may override defaults, drop them (disabled),
 *  or add custom servers. Validation/clamping lives in mergeConfig/resolveConfig
 *  so malformed documented settings degrade to defaults instead of crashing. */
import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { DEFAULT_SERVERS } from './catalog.js'
import { managedBinDir } from './platform.js'

export const LSP_SETTINGS_NAMESPACE = settingsNamespace('lsp')

export const PROGRESS_INJECT_MODES = ['status', 'conversation', 'none'] as const
export type ProgressInject = (typeof PROGRESS_INJECT_MODES)[number]

/** Per-server override/drop/add entry in the `servers` map. */
export interface ServerConfig {
  /** Override the spawn command (argv array). */
  command?: string[]
  /** Override which file extensions route to this server. */
  extensions?: string[]
  /** Explicit languageId; otherwise derived from the file extension. */
  languageId?: string
  /** Project-root marker files for root detection. */
  rootMarkers?: string[]
  /** Environment overrides for the server process. */
  env?: Record<string, string>
  /** LSP initialization options / workspace configuration values. */
  initialization?: Record<string, unknown>
  /** Opt-in managed install when the binary is missing. */
  autoDownload?: boolean
  /** Drop this server from the catalog. */
  disabled?: boolean
}

export interface ResolvedServer {
  command: string[]
  extensions: string[]
  languageId?: string
  rootMarkers?: string[]
  env?: Record<string, string>
  initialization?: Record<string, unknown>
  autoDownload?: boolean
  /** Download strategy for autoDownload (from the default catalog). */
  download?: 'npm' | 'github-release' | 'go-install'
}

export interface ProgressiveConfig {
  enabled: boolean
  inject: ProgressInject
  maxDiagnostics: number
  quietMs: number
}

export interface LspSettings {
  timeout: number
  /** Directory for managed server installs. */
  binDir: string
  progressive: ProgressiveConfig
  /** Configured servers (defaults merged + overrides applied at resolve time). */
  servers: Record<string, ServerConfig>
}

export interface ResolvedLspConfig extends LspSettings {
  servers: Record<string, ResolvedServer>
}

const DEFAULT_PROGRESSIVE: ProgressiveConfig = {
  enabled: true,
  inject: 'status',
  maxDiagnostics: 20,
  quietMs: 2000,
}

const DEFAULT_TIMEOUT = 30_000

/** Raw server entry as it appears in settings.yaml. */
function ServerEntry(): Schema<ServerConfig> {
  return z.object({
    command: z.array(z.string()),
    extensions: z.array(z.string()),
    languageId: z.string(),
    rootMarkers: z.array(z.string()),
    env: z.dict(z.string()),
    initialization: z.dict(z.any()),
    autoDownload: z.boolean(),
    disabled: z.boolean(),
  })
}

export const Config: Schema<LspSettings> = z.object({
  timeout: z.number().default(DEFAULT_TIMEOUT),
  binDir: z.string(),
  progressive: z
    .object({
      enabled: z.boolean().default(DEFAULT_PROGRESSIVE.enabled),
      inject: z.union([...PROGRESS_INJECT_MODES] as const).default(DEFAULT_PROGRESSIVE.inject),
      maxDiagnostics: z.number().default(DEFAULT_PROGRESSIVE.maxDiagnostics),
      quietMs: z.number().default(DEFAULT_PROGRESSIVE.quietMs),
    })
    .default(DEFAULT_PROGRESSIVE),
  servers: z.dict(ServerEntry()),
})

// ── validation / clamping ──────────────────────────────────────────────────

function rawServers(value: unknown): Record<string, ServerConfig> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const out: Record<string, ServerConfig> = {}
  for (const [id, entry] of Object.entries(value)) {
    if (typeof entry !== 'object' || entry === null) continue
    out[id] = entry as ServerConfig
  }
  return out
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n < min) return fallback
  return Math.min(max, Math.round(n))
}

function strOrUndef(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function boolOrUndef(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function strArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out = value.filter((x): x is string => typeof x === 'string')
  return out.length > 0 ? out : undefined
}

function isProgressInject(value: unknown): value is ProgressInject {
  return typeof value === 'string' && (PROGRESS_INJECT_MODES as readonly string[]).includes(value)
}

/** Merge a partial config over defaults, validating + clamping every field.
 *  Never throws — malformed values fall back to defaults per-field. */
export function mergeConfig(partial: unknown): LspSettings {
  const p = (partial ?? {}) as Partial<LspSettings & Record<string, unknown>>
  const prog = (p.progressive ?? {}) as Partial<ProgressiveConfig & Record<string, unknown>>

  const userServers = rawServers(p.servers)
  const servers: Record<string, ServerConfig> = {}
  for (const [id, def] of Object.entries(DEFAULT_SERVERS)) {
    servers[id] = {
      command: def.command,
      extensions: def.extensions,
      ...(def.languageId !== undefined ? { languageId: def.languageId } : {}),
      ...(def.rootMarkers !== undefined ? { rootMarkers: def.rootMarkers } : {}),
      ...(def.autoDownload !== undefined ? { autoDownload: def.autoDownload } : {}),
    }
  }
  if (userServers) {
    for (const [id, cfg] of Object.entries(userServers)) {
      if (cfg.disabled === true) {
        delete servers[id]
        continue
      }
      const existing = servers[id] ?? { command: [], extensions: [] }
      servers[id] = {
        ...existing,
        ...(cfg.command !== undefined ? { command: cfg.command } : {}),
        ...(cfg.extensions !== undefined ? { extensions: cfg.extensions } : {}),
        ...(cfg.languageId !== undefined ? { languageId: cfg.languageId } : {}),
        ...(cfg.rootMarkers !== undefined ? { rootMarkers: cfg.rootMarkers } : {}),
        ...(cfg.env !== undefined ? { env: cfg.env } : {}),
        ...(cfg.initialization !== undefined ? { initialization: cfg.initialization } : {}),
        ...(boolOrUndef(cfg.autoDownload) !== undefined ? { autoDownload: cfg.autoDownload } : {}),
      }
    }
  }

  return {
    timeout: clampInt(p.timeout, 1000, 300000, DEFAULT_TIMEOUT),
    binDir: strOrUndef(p.binDir) ?? managedBinDir(),
    progressive: {
      enabled: typeof prog.enabled === 'boolean' ? prog.enabled : DEFAULT_PROGRESSIVE.enabled,
      inject: isProgressInject(prog.inject) ? prog.inject : DEFAULT_PROGRESSIVE.inject,
      maxDiagnostics: clampInt(prog.maxDiagnostics, 0, 1000, DEFAULT_PROGRESSIVE.maxDiagnostics),
      quietMs: clampInt(prog.quietMs, 0, 600000, DEFAULT_PROGRESSIVE.quietMs),
    },
    servers,
  }
}

/** Materialize a resolved config: merge each ServerConfig over its default, drop
 *  empty-command entries, and normalize extension lists. Never throws. */
export function resolveConfig(config: LspSettings): ResolvedLspConfig {
  const servers: Record<string, ResolvedServer> = {}
  for (const [id, server] of Object.entries(config.servers)) {
    const def = DEFAULT_SERVERS[id]
    const command = strArray(server.command) ?? def?.command ?? []
    if (command.length === 0) continue
    servers[id] = {
      command,
      extensions: strArray(server.extensions) ?? def?.extensions ?? [],
      ...(strOrUndef(server.languageId) !== undefined ? { languageId: server.languageId } : {}),
      ...(strArray(server.rootMarkers) !== undefined ? { rootMarkers: server.rootMarkers } : {}),
      ...(server.env !== undefined ? { env: server.env } : {}),
      ...(server.initialization !== undefined ? { initialization: server.initialization } : {}),
      ...(boolOrUndef(server.autoDownload) !== undefined ? { autoDownload: server.autoDownload } : {}),
      ...(def?.download !== undefined ? { download: def.download } : {}),
    }
  }
  return {
    timeout: config.timeout,
    binDir: config.binDir,
    progressive: config.progressive,
    servers,
  }
}

/** Pick one resolved server by id (used for `server` tool filters + status). */
export function serverById(config: ResolvedLspConfig, id: string): ResolvedServer | undefined {
  return config.servers[id]
}
