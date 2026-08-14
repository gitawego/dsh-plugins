/** dsh-vision configuration: full pi-vision surface + DSH-only transport fields.
 *  Persisted in the DSH Settings document (`vision` namespace) via ctx.settings.
 *  Secrets never live here — `http.credential` is a credentialRef name. */
import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { VisionError } from './errors.ts'

export const VISION_SETTINGS_NAMESPACE = settingsNamespace('vision')

export const MAX_BATCH_IMAGES = 50

export const REASONING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const
export type ReasoningLevel = (typeof REASONING_LEVELS)[number]

export const MARKER_STYLES = ['code', 'bold', 'plain'] as const
export type MarkerStyle = (typeof MARKER_STYLES)[number]

export const PASTE_MODES = ['hint', 'auto', 'off'] as const
export type PasteMode = (typeof PASTE_MODES)[number]

export const DELEGATION_MODES = ['auto', 'native', 'http'] as const
export type DelegationMode = (typeof DELEGATION_MODES)[number]

export const DEFAULT_AUTO_DELEGATE_PROMPT =
  'Describe this image concisely, focusing on visible content, text, diagrams, and layout.'

export interface VisionConfig {
  provider: string | undefined
  model: string | undefined
  enabled: boolean
  maxDimension: number
  jpegQuality: number
  defaultReasoningEffort: ReasoningLevel
  systemPrompt: string | undefined
  cacheEnabled: boolean
  cachePersist: boolean
  cacheMaxEntries: number
  retryAttempts: number
  retryBackoffMs: number
  fallbackProvider: string | undefined
  fallbackModel: string | undefined
  markerStyle: MarkerStyle
  textOnlyPasteMode: PasteMode
  autoDelegatePrompt: string
  autoDelegateTimeoutMs: number
  composePreview: boolean
  previewMaxWidthCells: number
  batchConcurrency: number
  localOnly: boolean
  auditLog: boolean
  auditLogPath: string | undefined
  autoDetectVisionModel: boolean
  /** DSH-only: how delegation reaches the vision model. auto/native = spawn a
   *  DSH sub-agent with the configured provider/model (the image travels by
   *  filepath in a normal message); http = the plugin's own endpoint call. */
  delegation: DelegationMode
  /** DSH-only: OpenAI-compatible endpoint used by the http transport. */
  http: {
    baseUrl: string | undefined
    credential: string | undefined
    model: string | undefined
    /** 'openai' (default) uses /chat/completions; 'anthropic' uses /v1/messages. */
    protocol: 'openai' | 'anthropic'
  }
}

export const DEFAULT_CONFIG: VisionConfig = {
  provider: undefined,
  model: undefined,
  enabled: true,
  maxDimension: 1568,
  jpegQuality: 85,
  defaultReasoningEffort: 'off',
  systemPrompt: undefined,
  cacheEnabled: true,
  cachePersist: false,
  cacheMaxEntries: 256,
  retryAttempts: 2,
  retryBackoffMs: 500,
  fallbackProvider: undefined,
  fallbackModel: undefined,
  // 'plain' keeps [Image-#N] markers readable in plain-text chat rendering
  // (no literal backticks); switch via /vision marker-style code|bold|plain.
  markerStyle: 'plain',
  textOnlyPasteMode: 'hint',
  autoDelegatePrompt: DEFAULT_AUTO_DELEGATE_PROMPT,
  autoDelegateTimeoutMs: 30000,
  composePreview: true,
  previewMaxWidthCells: 80,
  batchConcurrency: 5,
  localOnly: false,
  auditLog: true,
  auditLogPath: undefined,
  autoDetectVisionModel: true,
  delegation: 'auto',
  http: { baseUrl: undefined, credential: undefined, model: undefined, protocol: 'openai' },
}

export const Config: Schema<VisionConfig> = z.object({
  provider: z.string(),
  model: z.string(),
  enabled: z.boolean().default(true),
  maxDimension: z.number().default(1568),
  jpegQuality: z.number().default(85),
  defaultReasoningEffort: z.union([...REASONING_LEVELS] as const).default('off'),
  systemPrompt: z.string(),
  cacheEnabled: z.boolean().default(true),
  cachePersist: z.boolean().default(false),
  cacheMaxEntries: z.number().default(256),
  retryAttempts: z.number().default(2),
  retryBackoffMs: z.number().default(500),
  fallbackProvider: z.string(),
  fallbackModel: z.string(),
  markerStyle: z.union([...MARKER_STYLES] as const).default('plain'),
  textOnlyPasteMode: z.union([...PASTE_MODES] as const).default('hint'),
  autoDelegatePrompt: z.string().default(DEFAULT_AUTO_DELEGATE_PROMPT),
  autoDelegateTimeoutMs: z.number().default(30000),
  composePreview: z.boolean().default(true),
  previewMaxWidthCells: z.number().default(80),
  batchConcurrency: z.number().default(5),
  localOnly: z.boolean().default(false),
  auditLog: z.boolean().default(true),
  auditLogPath: z.string(),
  autoDetectVisionModel: z.boolean().default(true),
  delegation: z.union([...DELEGATION_MODES] as const).default('auto'),
  http: z.object({
    baseUrl: z.string(),
    credential: z.string(),
    model: z.string(),
    protocol: z.union(['openai', 'anthropic'] as const).default('openai'),
  }),
})

/** Fully materialized configuration after validation. */
export interface ResolvedVisionConfig {
  provider: string | undefined
  model: string | undefined
  enabled: boolean
  maxDimension: number
  jpegQuality: number
  defaultReasoningEffort: ReasoningLevel
  systemPrompt: string | undefined
  cacheEnabled: boolean
  cachePersist: boolean
  cacheMaxEntries: number
  retryAttempts: number
  retryBackoffMs: number
  fallbackProvider: string | undefined
  fallbackModel: string | undefined
  markerStyle: MarkerStyle
  textOnlyPasteMode: PasteMode
  autoDelegatePrompt: string
  autoDelegateTimeoutMs: number
  composePreview: boolean
  previewMaxWidthCells: number
  batchConcurrency: number
  localOnly: boolean
  auditLog: boolean
  auditLogPath: string | undefined
  autoDetectVisionModel: boolean
  delegation: DelegationMode
  http: {
    baseUrl: string | undefined
    credential: CredentialRef | undefined
    model: string | undefined
    protocol: 'openai' | 'anthropic'
  }
}

export function isReasoningLevel(value: unknown): value is ReasoningLevel {
  return typeof value === 'string' && (REASONING_LEVELS as readonly string[]).includes(value)
}
function isMarkerStyle(value: unknown): value is MarkerStyle {
  return typeof value === 'string' && (MARKER_STYLES as readonly string[]).includes(value)
}
function isPasteMode(value: unknown): value is PasteMode {
  return typeof value === 'string' && (PASTE_MODES as readonly string[]).includes(value)
}
function isDelegationMode(value: unknown): value is DelegationMode {
  return typeof value === 'string' && (DELEGATION_MODES as readonly string[]).includes(value)
}
function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}
function strOrUndef(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/** Merge a partial config over defaults, validating + clamping every field. */
export function mergeConfig(partial: unknown): VisionConfig {
  const p = (partial ?? {}) as Partial<Record<string, unknown>>
  const http = (p.http ?? {}) as Partial<Record<string, unknown>>
  return {
    provider: strOrUndef(p.provider),
    model: strOrUndef(p.model),
    enabled: typeof p.enabled === 'boolean' ? p.enabled : DEFAULT_CONFIG.enabled,
    maxDimension: clampInt(p.maxDimension, 1, 8000, DEFAULT_CONFIG.maxDimension),
    jpegQuality: clampInt(p.jpegQuality, 1, 100, DEFAULT_CONFIG.jpegQuality),
    defaultReasoningEffort: isReasoningLevel(p.defaultReasoningEffort)
      ? p.defaultReasoningEffort : DEFAULT_CONFIG.defaultReasoningEffort,
    systemPrompt: strOrUndef(p.systemPrompt),
    cacheEnabled: typeof p.cacheEnabled === 'boolean' ? p.cacheEnabled : DEFAULT_CONFIG.cacheEnabled,
    cachePersist: typeof p.cachePersist === 'boolean' ? p.cachePersist : DEFAULT_CONFIG.cachePersist,
    cacheMaxEntries: clampInt(p.cacheMaxEntries, 1, 10000, DEFAULT_CONFIG.cacheMaxEntries),
    retryAttempts: clampInt(p.retryAttempts, 0, 10, DEFAULT_CONFIG.retryAttempts),
    retryBackoffMs: clampInt(p.retryBackoffMs, 0, 60000, DEFAULT_CONFIG.retryBackoffMs),
    fallbackProvider: strOrUndef(p.fallbackProvider),
    fallbackModel: strOrUndef(p.fallbackModel),
    markerStyle: isMarkerStyle(p.markerStyle) ? p.markerStyle : DEFAULT_CONFIG.markerStyle,
    textOnlyPasteMode: isPasteMode(p.textOnlyPasteMode) ? p.textOnlyPasteMode : DEFAULT_CONFIG.textOnlyPasteMode,
    autoDelegatePrompt: strOrUndef(p.autoDelegatePrompt) ?? DEFAULT_CONFIG.autoDelegatePrompt,
    autoDelegateTimeoutMs: clampInt(p.autoDelegateTimeoutMs, 1000, 120000, DEFAULT_CONFIG.autoDelegateTimeoutMs),
    composePreview: typeof p.composePreview === 'boolean' ? p.composePreview : DEFAULT_CONFIG.composePreview,
    previewMaxWidthCells: clampInt(p.previewMaxWidthCells, 20, 200, DEFAULT_CONFIG.previewMaxWidthCells),
    batchConcurrency: clampInt(p.batchConcurrency, 1, 20, DEFAULT_CONFIG.batchConcurrency),
    localOnly: typeof p.localOnly === 'boolean' ? p.localOnly : DEFAULT_CONFIG.localOnly,
    auditLog: typeof p.auditLog === 'boolean' ? p.auditLog : DEFAULT_CONFIG.auditLog,
    auditLogPath: strOrUndef(p.auditLogPath),
    autoDetectVisionModel: typeof p.autoDetectVisionModel === 'boolean' ? p.autoDetectVisionModel : DEFAULT_CONFIG.autoDetectVisionModel,
    delegation: isDelegationMode(p.delegation) ? p.delegation : DEFAULT_CONFIG.delegation,
    http: {
      baseUrl: strOrUndef(http.baseUrl),
      credential: strOrUndef(http.credential),
      model: strOrUndef(http.model),
      protocol: http.protocol === 'anthropic' ? 'anthropic' : 'openai',
    },
  }
}

/** Validate + materialize a config; throws VisionError on invalid input. */
export function resolveConfig(config: VisionConfig = DEFAULT_CONFIG): ResolvedVisionConfig {
  let httpCredential: CredentialRef | undefined
  const rawCredential = config.http?.credential?.trim()
  if (rawCredential !== undefined && rawCredential.length > 0) {
    try {
      httpCredential = credentialRef(rawCredential)
    } catch (error) {
      throw new VisionError('not_configured', `http.credential "${rawCredential}" is not a valid credential reference`, { cause: error })
    }
  }
  const httpBaseUrl = config.http?.baseUrl?.trim().replace(/\/+$/, '')
  if (httpBaseUrl !== undefined && httpBaseUrl.length > 0 && !/^https?:\/\//i.test(httpBaseUrl)) {
    throw new VisionError('not_configured', 'http.baseUrl must be an http(s) URL')
  }
  return {
    ...config,
    http: {
      baseUrl: httpBaseUrl && httpBaseUrl.length > 0 ? httpBaseUrl : undefined,
      credential: httpCredential,
      model: strOrUndef(config.http?.model),
      protocol: config.http?.protocol === 'anthropic' ? 'anthropic' : 'openai',
    },
  }
}

/** Whether the config has the minimum required fields for DELEGATE mode. */
export function isConfiguredForDelegation(config: ResolvedVisionConfig): boolean {
  if (config.delegation === 'http') {
    return !!(config.http.baseUrl && config.http.credential && config.http.model)
  }
  return !!(config.provider && config.model)
}
