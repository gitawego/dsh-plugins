/** Optional Web-profile routes: a data-driven vision-model catalog for the
 *  Settings form. Provider and model lists come from the LIVE LLM adapter
 *  catalog (ctx.llm.listProviders/listModels) — nothing is hardcoded; the
 *  detected default is the image-capable model the catalog scan prefers
 *  (primary-provider first). No secrets cross this route. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
// Type-only import activates the optional webServer Context declaration.
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { ResolvedVisionConfig } from './config.ts'
import { detectVisionModel, type VisionModelCandidate } from './defaults.ts'

export const MODELS_ROUTE = '/_dsh/vision/models'

export interface VisionProviderRow {
  id: string
  name: string
}

export interface VisionModelRow extends VisionModelCandidate {
  /** True for the catalog-scan preferred default. */
  default?: boolean
}

export interface VisionModelsSnapshot {
  /** All registered providers from the live adapter registry. */
  providers: VisionProviderRow[]
  /** Image-capable models across the live catalog (data-driven). */
  visionModels: VisionModelRow[]
  /** Currently configured provider/model (settings), when set. */
  configured: { provider: string | undefined; model: string | undefined }
  /** The preferred vision-capable default from the catalog scan, if any. */
  detected: VisionModelRow | undefined
  /** Whether the LLM catalog is queryable on this host. */
  available: boolean
}

/** Build the catalog snapshot from the live LLM registry (best-effort per
 *  provider: a provider that fails to list models is skipped, not fatal). */
export async function buildModelsSnapshot(ctx: Context, resolved: ResolvedVisionConfig): Promise<VisionModelsSnapshot> {
  let providers: VisionProviderRow[] = []
  try {
    providers = ctx.llm.listProviders().map((p) => ({ id: p.id, name: p.name }))
  } catch {
    providers = []
  }
  const visionModels: VisionModelRow[] = []
  for (const { id } of providers) {
    let models
    try {
      models = await ctx.llm.listModels(id)
    } catch {
      continue
    }
    for (const m of models) {
      if (m.inputModalities?.includes('image')) {
        visionModels.push({ provider: id, model: m.id, name: m.name })
      }
    }
  }
  const candidate = await detectVisionModel(ctx.llm)
  const detected: VisionModelRow | undefined = candidate === undefined ? undefined : { ...candidate, default: true }
  return {
    providers,
    visionModels,
    configured: { provider: resolved.provider, model: resolved.model },
    detected,
    available: providers.length > 0,
  }
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

export class VisionWebBackend {
  constructor(
    private readonly ctx: Context,
    private readonly resolved: () => ResolvedVisionConfig,
  ) {}

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET')
      requestError(res, 405, 'method-not-allowed', 'Use GET')
      return
    }
    try {
      const value = await buildModelsSnapshot(this.ctx, this.resolved())
      responseJson(res, 200, { ok: true, value })
    } catch (error) {
      this.ctx.logger.warn('dsh-vision: models catalog failed: %s', error instanceof Error ? error.message : String(error))
      requestError(res, 503, 'catalog-unavailable', 'The vision model catalog is unavailable')
    }
  }
}

/** Attach the optional models route whenever a webServer service is present
 *  (web profile only; headless/TUI hosts never activate it). */
export function installVisionWeb(ctx: Context, resolved: () => ResolvedVisionConfig): void {
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      const backend = new VisionWebBackend(webCtx, resolved)
      const dispose = webCtx.webServer.register({
        kind: 'exact',
        path: MODELS_ROUTE,
        handler: (req, res) => backend.handle(req, res),
      })
      return () => { dispose() }
    }, 'dsh-vision: Web routes')
  })
}

