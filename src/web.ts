/** Optional Web-profile routes (webServer present only): a data-driven
 *  vision-model catalog AND the Vision settings snapshot/save endpoint.
 *  Provider and model lists come from the LIVE LLM adapter catalog
 *  (ctx.llm.listProviders/listModels) — nothing is hardcoded; the detected
 *  default is the catalog scan's preference (primary-provider first). The
 *  settings route exists because the web client's settings proxy only exposes
 *  an allowlisted namespace set (dsh-host-apiproxy) — plugin namespaces are
 *  not remotely configurable by default, so the form reads/writes through its
 *  own same-origin route over the settings seam. No secrets cross either
 *  route (http.credential is a credential-ref name, never a value). */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
// Type-only import activates the optional webServer Context declaration.
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { ResolvedVisionConfig, VisionConfig } from './config.ts'
import { mergeConfig, resolveConfig } from './config.ts'
import { detectVisionModel, type VisionModelCandidate } from './defaults.ts'

export const MODELS_ROUTE = '/_dsh/vision/models'
export const SETTINGS_ROUTE = '/_dsh/vision/settings'

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

/** Settings write surface used by the route (mirrors the /vision command). */
export interface VisionSettingsLike {
  get(): VisionConfig
  update(patch: Record<string, unknown>): Promise<void>
  mutate(ops: Array<{ op: 'set'; path: string; value?: unknown } | { op: 'unset'; path: string }>): Promise<void>
}

export interface VisionSettingsSnapshot {
  /** Whether the active settings provider accepts writes. */
  writable: boolean
  /** The resolved current config (readable, no secrets). */
  value: VisionConfig
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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

/** Read the current config for the form. */
export async function buildSettingsSnapshot(
  ctx: Context,
  settings: VisionSettingsLike,
): Promise<VisionSettingsSnapshot> {
  return {
    writable: ctx.settings.writable,
    value: settings.get(),
  }
}

/** Validate + apply one form submission through the settings seam. The patch
 *  may carry the full form; empty provider/model are cleared via mutate. */
export async function applySettingsPatch(
  ctx: Context,
  settings: VisionSettingsLike,
  patch: unknown,
): Promise<VisionSettingsSnapshot> {
  if (!isRecord(patch)) throw new TypeError('settings value must be an object')
  if (!ctx.settings.writable) throw new Error('settings provider is read-only')
  const resolved = resolveConfig(mergeConfig(patch)) // throws on invalid input
  const ops: Array<{ op: 'set'; path: string; value?: unknown } | { op: 'unset'; path: string }> = []
  const provider = typeof patch.provider === 'string' ? patch.provider.trim() : ''
  const model = typeof patch.model === 'string' ? patch.model.trim() : ''
  ops.push(provider.length === 0 ? { op: 'unset', path: 'provider' } : { op: 'set', path: 'provider', value: provider })
  ops.push(model.length === 0 ? { op: 'unset', path: 'model' } : { op: 'set', path: 'model', value: model })
  await settings.mutate(ops)
  await settings.update({
    enabled: resolved.enabled,
    delegation: resolved.delegation,
    textOnlyPasteMode: resolved.textOnlyPasteMode,
    markerStyle: resolved.markerStyle,
    maxDimension: resolved.maxDimension,
    jpegQuality: resolved.jpegQuality,
    cacheEnabled: resolved.cacheEnabled,
    cachePersist: resolved.cachePersist,
    cacheMaxEntries: resolved.cacheMaxEntries,
    retryAttempts: resolved.retryAttempts,
    autoDelegateTimeoutMs: resolved.autoDelegateTimeoutMs,
    localOnly: resolved.localOnly,
    auditLog: resolved.auditLog,
    autoDetectVisionModel: resolved.autoDetectVisionModel,
    http: {
      ...(resolved.http.baseUrl === undefined ? {} : { baseUrl: resolved.http.baseUrl }),
      ...(resolved.http.credential === undefined ? {} : { credential: String(resolved.http.credential) }),
      ...(resolved.http.model === undefined ? {} : { model: resolved.http.model }),
      protocol: resolved.http.protocol,
    },
  })
  return buildSettingsSnapshot(ctx, settings)
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

async function readJson(req: IncomingMessage, maxBytes = 64 * 1024): Promise<unknown> {
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

export class VisionWebBackend {
  constructor(
    private readonly ctx: Context,
    private readonly resolved: () => ResolvedVisionConfig,
    private readonly settings: VisionSettingsLike,
  ) {}

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url?.split('?', 1)[0] ?? ''
    if (url === SETTINGS_ROUTE) return this.handleSettings(req, res)
    return this.handleModels(req, res)
  }

  private async handleModels(req: IncomingMessage, res: ServerResponse): Promise<void> {
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

  private async handleSettings(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === 'GET') {
      try {
        responseJson(res, 200, { ok: true, value: await buildSettingsSnapshot(this.ctx, this.settings) })
      } catch (error) {
        this.ctx.logger.warn('dsh-vision: settings snapshot failed: %s', error instanceof Error ? error.message : String(error))
        requestError(res, 503, 'settings-unavailable', 'Vision settings are unavailable')
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
      this.ctx.logger.warn('dsh-vision: settings save failed: %s', error instanceof Error ? error.message : String(error))
      requestError(res, 400, 'settings-rejected', error instanceof Error ? error.message : String(error))
    }
  }
}

/** Attach the optional routes whenever a webServer service is present (web
 *  profile only; headless/TUI hosts never activate them). */
export function installVisionWeb(
  ctx: Context,
  resolved: () => ResolvedVisionConfig,
  settings: VisionSettingsLike,
): void {
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      const backend = new VisionWebBackend(webCtx, resolved, settings)
      const dispose = webCtx.webServer.register({
        kind: 'prefix',
        path: '/_dsh/vision',
        handler: (req, res) => backend.handle(req, res),
      })
      return () => { dispose() }
    }, 'dsh-vision: Web routes')
  })
}

