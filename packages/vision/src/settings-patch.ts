/** Domain-level helpers for the vision settings patch — input validation,
 *  normalization, and the schema-level rescue so the client form can
 *  submit a single flat patch even when the schema is nested. Extracted
 *  from the rc.6 bespoke HTTP route so the same logic powers both the
 *  /vision command (host-side) and the rc.7 settings.widget (client-side
 *  via ctx.settingsScope.bind). Not HTTP-coupled. */
import type { VisionConfig } from './config.ts'
import { mergeConfig, resolveConfig } from './config.ts'

export interface VisionSettingsLike {
  get(): VisionConfig
  update(patch: Record<string, unknown>): Promise<void>
  mutate(ops: Array<{ op: 'set'; path: string; value?: unknown } | { op: 'unset'; path: string }>): Promise<void>
}

export interface VisionSettingsSnapshot {
  writable: boolean
  value: VisionConfig
}

const MAX_DIMENSION = 8000
const MIN_DIMENSION = 64
const MAX_JPEG_QUALITY = 100
const MIN_JPEG_QUALITY = 1
const MAX_CACHE_ENTRIES = 1024
const MIN_CACHE_ENTRIES = 0
const MAX_RETRIES = 8
const MIN_RETRIES = 0
const MAX_TIMEOUT_MS = 5 * 60_000
const MIN_TIMEOUT_MS = 1_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : Number.NaN
  if (!Number.isFinite(n)) return fallback
  if (n < min) return min
  if (n > max) return max
  return n
}

function nonEmptyString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeProtocol(value: unknown): 'openai' | 'anthropic' {
  return value === 'anthropic' ? 'anthropic' : 'openai'
}

function normalizeDelegation(value: unknown): 'auto' | 'native' | 'http' {
  return value === 'native' || value === 'http' ? value : 'auto'
}

function normalizePasteMode(value: unknown): 'hint' | 'auto' | 'off' {
  return value === 'auto' || value === 'off' ? value : 'hint'
}

function normalizeMarkerStyle(value: unknown): 'code' | 'bold' | 'plain' {
  return value === 'bold' || value === 'plain' ? value : 'code'
}

function normalizeHttp(raw: unknown): VisionConfig['http'] {
  // Default: empty http block with an `openai` fallback protocol. The form
  // can override any field, including `protocol` without `baseUrl` — the
  // helper honors whichever fields are present in the patch.
  const base: VisionConfig['http'] = { baseUrl: undefined, credential: undefined, model: undefined, protocol: 'openai' }
  if (!isRecord(raw)) return base
  return {
    baseUrl: nonEmptyString(raw.baseUrl) || undefined,
    credential: nonEmptyString(raw.credential) || undefined,
    model: nonEmptyString(raw.model) || undefined,
    protocol: normalizeProtocol(raw.protocol),
  }
}

/** Apply a single flat patch from the form onto the settings namespace. */
export async function applySettingsPatch(
  ctx: { settings: { writable: boolean } },
  settings: VisionSettingsLike,
  patch: unknown,
): Promise<VisionSettingsSnapshot> {
  if (!isRecord(patch)) throw new TypeError('settings patch must be an object')
  if (!ctx.settings.writable) throw new Error('the active Settings provider is read-only')

  const ops: Array<{ op: 'set'; path: string; value?: unknown } | { op: 'unset'; path: string }> = []

  const provider = nonEmptyString(patch.provider)
  const model = nonEmptyString(patch.model)
  if (provider.length === 0) ops.push({ op: 'unset', path: 'provider' })
  else ops.push({ op: 'set', path: 'provider', value: provider })
  if (model.length === 0) ops.push({ op: 'unset', path: 'model' })
  else ops.push({ op: 'set', path: 'model', value: model })

  const updatePatch: Record<string, unknown> = {
    enabled: patch.enabled === true,
    delegation: normalizeDelegation(patch.delegation),
    textOnlyPasteMode: normalizePasteMode(patch.textOnlyPasteMode),
    markerStyle: normalizeMarkerStyle(patch.markerStyle),
    maxDimension: clampInt(patch.maxDimension, MIN_DIMENSION, MAX_DIMENSION, 1568),
    jpegQuality: clampInt(patch.jpegQuality, MIN_JPEG_QUALITY, MAX_JPEG_QUALITY, 85),
    cacheEnabled: patch.cacheEnabled !== false,
    cachePersist: patch.cachePersist === true,
    cacheMaxEntries: clampInt(patch.cacheMaxEntries, MIN_CACHE_ENTRIES, MAX_CACHE_ENTRIES, 256),
    retryAttempts: clampInt(patch.retryAttempts, MIN_RETRIES, MAX_RETRIES, 2),
    autoDelegateTimeoutMs: clampInt(patch.autoDelegateTimeoutMs, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS, 30_000),
    localOnly: patch.localOnly === true,
    auditLog: patch.auditLog !== false,
    autoDetectVisionModel: patch.autoDetectVisionModel !== false,
    http: normalizeHttp(patch.http),
  }

  await settings.update(updatePatch)
  if (ops.length > 0) await settings.mutate(ops)

  const value = resolveConfig(mergeConfig(settings.get()))
  return { writable: ctx.settings.writable, value }
}

export async function buildSettingsSnapshot(
  ctx: { settings: { writable: boolean } },
  settings: VisionSettingsLike,
): Promise<VisionSettingsSnapshot> {
  return {
    writable: ctx.settings.writable,
    value: resolveConfig(mergeConfig(settings.get())),
  }
}
