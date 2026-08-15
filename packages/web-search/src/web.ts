/**
 * Optional Web-profile host routes for the web-search plugin: a same-origin
 * GET/POST settings endpoint. The harness settings proxy does not expose
 * plugin namespaces by default, so the Web client reads/writes the
 * `web-search-enhanced` namespace through its own route over the settings
 * seam. No secrets cross the route (credential is a credential-ref name).
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { WebSearchConfig } from './config.ts'
import { createResolvedConfig } from './config.ts'

export const SETTINGS_ROUTE = '/_dsh/web-search/settings'

export interface WebSearchSettingsLike {
  get(): WebSearchConfig
  update(patch: Record<string, unknown>): Promise<void>
}

export interface WebSearchSettingsSnapshot {
  writable: boolean
  value: WebSearchConfig
}

export function buildSettingsSnapshot(
  ctx: Context,
  settings: WebSearchSettingsLike,
): WebSearchSettingsSnapshot {
  return { writable: ctx.settings.writable, value: settings.get() }
}

export async function applySettingsPatch(
  ctx: Context,
  settings: WebSearchSettingsLike,
  patch: unknown,
): Promise<WebSearchSettingsSnapshot> {
  if (!isRecord(patch)) throw new TypeError('settings value must be an object')
  if (!ctx.settings.writable) throw new Error('settings provider is read-only')
  // Validate the incoming shape by resolving it (throws on invalid values).
  createResolvedConfig(patch as Partial<WebSearchConfig>)
  await settings.update(patch as Record<string, unknown>)
  return buildSettingsSnapshot(ctx, settings)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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

async function readJson(req: IncomingMessage, maxBytes = 64 * 1024): Promise<unknown> {
  const contentType = req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'application/json') throw new TypeError('Content-Type must be application/json')
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of req) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += part.length
    if (bytes > maxBytes) throw new RangeError('request body exceeds ' + maxBytes + ' bytes')
    chunks.push(part)
  }
  if (chunks.length === 0) throw new TypeError('request body is empty')
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

export class WebSearchWebBackend {
  constructor(
    private readonly ctx: Context,
    private readonly settings: WebSearchSettingsLike,
  ) {}

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.url?.split('?', 1)[0] !== SETTINGS_ROUTE) {
      requestError(res, 404, 'not-found', 'Not found')
      return
    }
    if (req.method === 'GET') {
      try {
        responseJson(res, 200, { ok: true, value: buildSettingsSnapshot(this.ctx, this.settings) })
      } catch (error) {
        this.ctx.logger.warn('dsh-web-search: settings snapshot failed: %s', error instanceof Error ? error.message : String(error))
        requestError(res, 503, 'settings-unavailable', 'Web Search settings are unavailable')
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
      this.ctx.logger.warn('dsh-web-search: settings save failed: %s', error instanceof Error ? error.message : String(error))
      requestError(res, 400, 'settings-rejected', error instanceof Error ? error.message : String(error))
    }
  }
}

/** Attach the optional route whenever a webServer service is present (web
 *  profile only; headless/TUI hosts never activate them). */
export function installWebSearchWeb(ctx: Context, settings: WebSearchSettingsLike): void {
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      const backend = new WebSearchWebBackend(webCtx, settings)
      const dispose = webCtx.webServer.register({
        kind: 'prefix',
        path: '/_dsh/web-search',
        handler: (req, res) => backend.handle(req, res),
      })
      return () => { dispose() }
    }, 'dsh-web-search: Web routes')
  })
}
