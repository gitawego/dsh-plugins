/** Optional Web-profile routes (webServer present only): a live LSP session +
 *  catalog facts endpoint AND a writeable LSP-settings endpoint so the Web
 *  Settings section can edit timeout / progressive / per-server config
 *  (incl. `tsserver.path`). The client form reads/writes through this
 *  plugin-owned same-origin route because plugin namespaces are not exposed by
 *  the host apiproxy by default. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
// Type-only import activates the optional webServer Context declaration.
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { LspSettings, ResolvedLspConfig } from './config.ts'
import { mergeConfig, resolveConfig } from './config.ts'
import type { SessionStatus } from './manager.ts'

export const STATUS_ROUTE = '/_dsh/lsp'
export const SETTINGS_ROUTE = '/_dsh/lsp/settings'

export interface LspSnapshot {
  writable: boolean
  configured: ResolvedLspConfig
  sessions: SessionStatus[]
}

/** Settings write surface used by the route (mirrors the /lsp command seam). */
export interface LspSettingsLike {
  get(): LspSettings
  update(patch: Record<string, unknown>): Promise<void>
  mutate(ops: Array<{ op: 'set'; path: string | string[]; value?: unknown } | { op: 'unset'; path: string | string[] }>): Promise<void>
}

export interface LspSettingsSnapshot {
  writable: boolean
  value: LspSettings
}

interface JsonEnvelope<T> {
  ok: boolean
  value?: T
  error?: { code: string; message: string }
}

function responseJson<T>(res: ServerResponse, status: number, body: JsonEnvelope<T>): void {
  const bytes = Buffer.from(JSON.stringify(body))
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Content-Length', String(bytes.length))
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.writeHead(status)
  res.end(bytes)
}

function requestError(res: ServerResponse, status: number, code: string, message: string): void {
  responseJson(res, status, { ok: false, error: { code, message } })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Same-origin gate for state-changing POSTs (mirrors the reference plugin). */
function sameOriginPost(req: IncomingMessage): boolean {
  const fetchSite = req.headers['sec-fetch-site']
  if (fetchSite === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return fetchSite === 'same-origin' || fetchSite === 'same-site' || fetchSite === 'none'
  const host = req.headers.host
  if (host === undefined) return false
  try {
    const parsed = new URL(origin)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host === host
  } catch {
    return false
  }
}

async function readJson(req: IncomingMessage, maxBytes = 256 * 1024): Promise<unknown> {
  const contentType = req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'application/json') throw new TypeError('Content-Type must be application/json')
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of req) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += part.length
    if (bytes > maxBytes) throw new RangeError(`request body exceeds ${maxBytes} bytes`)
    chunks.push(part)
  }
  if (chunks.length === 0) throw new TypeError('request body is empty')
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

/** Read the current config for the form. */
export async function buildSettingsSnapshot(
  ctx: Context,
  settings: LspSettingsLike,
): Promise<LspSettingsSnapshot> {
  return {
    writable: ctx.settings.writable,
    value: settings.get(),
  }
}

/**
 * Validate + apply one form submission through the settings seam. The patch
 * carries the editable fields (timeout, binDir, progressive, servers). Empty
 * optional strings are cleared via mutate. Validation mirrors mergeConfig /
 * resolveConfig so a bad form is rejected before any write.
 */
export async function applySettingsPatch(
  ctx: Context,
  settings: LspSettingsLike,
  patch: unknown,
): Promise<LspSettingsSnapshot> {
  if (!isRecord(patch)) throw new TypeError('settings value must be an object')
  if (!ctx.settings.writable) throw new Error('settings provider is read-only')
  const resolved = resolveConfig(mergeConfig(patch)) // throws on invalid input

  // Build the set of mutations: timeout/binDir/progressive always set;
  // the `servers` map is written whole (server overrides are full entries).
  const ops: Array<{ op: 'set'; path: string | string[]; value?: unknown } | { op: 'unset'; path: string | string[] }> = []
  ops.push({ op: 'set', path: 'timeout', value: resolved.timeout })
  ops.push({ op: 'set', path: 'binDir', value: resolved.binDir })
  ops.push({ op: 'set', path: 'progressive', value: resolved.progressive })
  ops.push({ op: 'set', path: 'servers', value: patch.servers ?? {} })
  await settings.mutate(ops)
  return buildSettingsSnapshot(ctx, settings)
}

export class LspWebBackend {
  constructor(
    private readonly ctx: Context,
    private readonly resolved: () => ResolvedLspConfig,
    private readonly sessions: () => SessionStatus[],
    private readonly settings: LspSettingsLike,
  ) {}

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url?.split('?', 1)[0] ?? ''
    if (url === SETTINGS_ROUTE) return this.handleSettings(req, res)
    if (url === STATUS_ROUTE) return this.handleStatus(req, res)
    responseJson(res, 404, { ok: false, error: { code: 'not-found', message: 'Not found' } })
  }

  private async handleStatus(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET')
      requestError(res, 405, 'method-not-allowed', 'Use GET')
      return
    }
    try {
      const value: LspSnapshot = {
        writable: this.ctx.settings.writable,
        configured: this.resolved(),
        sessions: this.sessions(),
      }
      responseJson(res, 200, { ok: true, value })
    } catch (error) {
      this.ctx.logger.warn('dsh-lsp: status snapshot failed: %s', error instanceof Error ? error.message : String(error))
      requestError(res, 503, 'unavailable', 'LSP status is unavailable')
    }
  }

  private async handleSettings(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === 'GET') {
      try {
        responseJson(res, 200, { ok: true, value: await buildSettingsSnapshot(this.ctx, this.settings) })
      } catch (error) {
        this.ctx.logger.warn('dsh-lsp: settings snapshot failed: %s', error instanceof Error ? error.message : String(error))
        requestError(res, 503, 'settings-unavailable', 'LSP settings are unavailable')
      }
      return
    }
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST')
      requestError(res, 405, 'method-not-allowed', 'Use GET or POST')
      return
    }
    if (!sameOriginPost(req)) {
      requestError(res, 403, 'origin-rejected', 'The request must originate from this DSH Web application')
      return
    }
    let patch: unknown
    try {
      patch = await readJson(req)
    } catch (error) {
      requestError(res, 400, 'invalid-request', error instanceof Error ? error.message : String(error))
      return
    }
    try {
      const value = await applySettingsPatch(this.ctx, this.settings, patch)
      responseJson(res, 200, { ok: true, value })
    } catch (error) {
      this.ctx.logger.warn('dsh-lsp: settings save failed: %s', error instanceof Error ? error.message : String(error))
      requestError(res, 400, 'settings-rejected', error instanceof Error ? error.message : String(error))
    }
  }
}

/** Attach the optional routes whenever a webServer service is present (web profile only). */
export function installLspWeb(
  ctx: Context,
  resolved: () => ResolvedLspConfig,
  sessions: () => SessionStatus[],
  settings: LspSettingsLike,
): void {
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      const backend = new LspWebBackend(webCtx, resolved, sessions, settings)
      const dispose = webCtx.webServer.register({
        kind: 'prefix',
        path: '/_dsh/lsp',
        handler: (req, res) => backend.handle(req, res),
      })
      return () => { dispose() }
    }, 'dsh-lsp: Web route')
  })
}
