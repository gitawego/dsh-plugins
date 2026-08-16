/** Optional Web-profile route (webServer present only): a live LSP session +
 *  catalog facts endpoint so the Web client status card has data. The client
 *  form reads/writes through the settings seam (plugin namespaces are not in
 *  the host apiproxy allowlist), so this route is read-only facts. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
// Type-only import activates the optional webServer Context declaration.
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { ResolvedLspConfig } from './config.ts'
import type { SessionStatus } from './manager.ts'

export const STATUS_ROUTE = '/_dsh/lsp'

export interface LspSnapshot {
  writable: boolean
  configured: ResolvedLspConfig
  sessions: SessionStatus[]
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

export class LspWebBackend {
  constructor(
    private readonly ctx: Context,
    private readonly resolved: () => ResolvedLspConfig,
    private readonly sessions: () => SessionStatus[],
  ) {}

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.url?.split('?', 1)[0] !== STATUS_ROUTE) {
      responseJson(res, 404, { ok: false, error: { code: 'not-found', message: 'Not found' } })
      return
    }
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET')
      responseJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'Use GET' } })
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
      responseJson(res, 503, { ok: false, error: { code: 'unavailable', message: 'LSP status is unavailable' } })
    }
  }
}

/** Attach the optional route whenever a webServer service is present (web profile only). */
export function installLspWeb(
  ctx: Context,
  resolved: () => ResolvedLspConfig,
  sessions: () => SessionStatus[],
): void {
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      const backend = new LspWebBackend(webCtx, resolved, sessions)
      const dispose = webCtx.webServer.register({
        kind: 'prefix',
        path: '/_dsh/lsp',
        handler: (req, res) => backend.handle(req, res),
      })
      return () => { dispose() }
    }, 'dsh-lsp: Web route')
  })
}
