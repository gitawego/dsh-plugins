/** DELEGATE pipeline: cache → local-only gate → compress → retry+fallback →
 *  audit. Per the NON-NEGOTIABLE DESIGN RULE, the vision model is driven as a
 *  DSH SUBAGENT (ctx.agents.create with the vision model; the image is sent by
 *  FILEPATH in a normal text message — the subagent's own pre-step paste hook
 *  attaches it for the multimodal primary). NO attachment store, NO
 *  llm.stream-with-ImageBlock, NO base64 in the message, NO pi-ai internals.
 *  delegation=http keeps the plugin's own direct endpoint call (config-driven,
 *  not another agent tool). */
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ResolvedVisionConfig, ReasoningLevel } from './config.ts'
import { isConfiguredForDelegation } from './config.ts'
import { loadImage, compressImage, type LoadedImage } from './image.ts'
import { cacheKey, type VisionCache } from './cache.ts'
import {
  appendAuditEntry, resolveAuditPath, truncateImagePathForLog, type AuditEntry,
} from './audit.ts'
import { callHttpVision, maxTokensFor, type HttpProtocol } from './transport.ts'
import { VisionError } from './errors.ts'

export interface DelegateParams {
  image_path: string
  prompt: string
  compress: boolean
  reasoning: ReasoningLevel
}

export interface CredentialLike {
  value: string
}

/** A spawned vision sub-agent: send the image path, wait for quiescence,
 *  read the final assistant text, dispose. */
export interface SubagentHandle {
  send(message: UserMessage): void
  whenIdle(): Promise<void>
  replyText(): string | undefined
  dispose(): Promise<void>
}

/** Create the sub-agent with the vision model (DSH public API seam). */
export type CreateSubagent = (opts: {
  provider: string
  model: string
  cwd: string
}) => Promise<SubagentHandle>

export interface DelegateDeps {
  config: ResolvedVisionConfig
  /** DSH home: audit log + disk cache live under it. */
  home: string
  /** Workspace root used to resolve relative image paths. */
  workspace: string
  resolveCredential: (ref: import('@deepseek-ai/dsh-credentials').CredentialRef) => Promise<CredentialLike | undefined>
  /** Spawn the vision-model sub-agent (DSH public API, DESIGN RULE). */
  createSubagent: CreateSubagent
  /** Whether the harness can deliver image bytes to a spawned sub-agent
   *  NATIVELY (ImageBlock via the attachment store). Injected from index.ts
   *  as a memoized probe; absent (tests) means the native path is assumed
   *  available. When it is not (Android/Termux: the store's durability walk
   *  hits EACCES at /data/data), auto delegation falls back to the plugin's
   *  own http endpoint call and native mode refuses loudly. */
  canDeliverImage?: () => Promise<boolean>
  signal?: AbortSignal
  cache?: VisionCache
}

export interface DelegateSuccess {
  ok: true
  text: string
  details: {
    model: string
    image_path: string
    prompt: string
    compressed: boolean
    reasoning: ReasoningLevel
    cached: boolean
    fallback: boolean
    transport: 'subagent' | 'http'
  }
}

export interface DelegateFailure {
  ok: false
  error: { code: string; message: string }
  details?: { primaryError?: string; fallbackModel?: string }
}

export type DelegateResult = DelegateSuccess | DelegateFailure

export type RetryableClass = 'retryable' | 'auth' | 'terminal' | 'abort'

export function classifyError(err: unknown): RetryableClass {
  if (err instanceof Error && err.name === 'AbortError') return 'abort'
  if (err instanceof VisionError && err.code === 'aborted') return 'abort'
  if (err instanceof Error && err.message.includes('aborted')) return 'abort'
  // fetch-level network failures
  if (err instanceof TypeError) return 'retryable'
  if (err instanceof Error) {
    const statusMatch = /returned (\d{3})/.exec(err.message)
    if (statusMatch) {
      const status = Number(statusMatch[1])
      if (status === 401 || status === 403) return 'auth'
      if (status === 429 || status >= 500) return 'retryable'
      return 'terminal'
    }
    if (err.cause instanceof TypeError) return 'retryable'
    return 'terminal'
  }
  return 'terminal'
}

/** Abort-aware exponential backoff retry. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: { attempts: number; backoffMs: number; signal?: AbortSignal },
): Promise<T> {
  let attempt = 0
  while (true) {
    try {
      return await fn()
    } catch (err) {
      if (options.signal?.aborted) throw err
      const cls = classifyError(err)
      if (cls === 'abort') throw err
      if (cls === 'auth' || cls === 'terminal') throw err
      attempt++
      if (attempt >= options.attempts) throw err
      const delay = Math.min(options.backoffMs * 2 ** (attempt - 1), 8000)
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
}

const NOT_CONFIGURED_MSG = [
  'Vision tool is not configured.',
  '',
  'Use /vision show or the Web Settings to set the vision provider and model (an image-capable model from the harness catalog), or the http endpoint fields for raw-http delegation.',
  'For delegation: auto/native needs provider+model of a registered image-capable model; http needs http.baseUrl, http.credential (a DSH Credential reference), and http.model.',
].join('\n')

/** The sub-agent cannot receive the image natively on this host (the
 *  attachment store cannot write — Android/Termux EACCES at /data/data).
 *  Native mode refuses; auto mode falls back to the http endpoint. */
const IMAGE_DELIVERY_UNAVAILABLE_MSG = [
  'The vision sub-agent cannot receive images natively on this host: the DSH attachment store cannot write under this DSH home (on Android/Termux the durability walk hits EACCES at /data/data).',
  '',
  'Options:',
  '  - Use delegation=http and set http.baseUrl, http.credential (a DSH credential), and http.model to call the vision endpoint directly (image sent as base64 in the standard API request).',
  '  - Run on a host where the attachment store can write, so delegation auto/native delivers the image natively (ImageBlock).',
].join('\n')

const LOCAL_ONLY_MSG = (cacheHint: string): string => [
  'Vision tool is in local-only mode — image bytes are not sent to any provider.',
  '',
  `This image has no cached description. ${cacheHint}`,
  '',
  'To delegate this image to a vision model:',
  '  /vision local-only off',
  '',
  'To inspect the cache:',
  '  /vision cache show',
].join('\n')

function formatImageError(error: { code: string; path?: string; message?: string }, inputPath: string): string {
  switch (error.code) {
    case 'not_found': return `Vision tool error: image not found at "${inputPath}".`
    case 'not_a_file': return `Vision tool error: "${inputPath}" is not a file.`
    case 'too_large': return `Vision tool error: image "${inputPath}" exceeds the 64MB source cap. Compress it first or pass a smaller file.`
    case 'unsupported_format': return `Vision tool error: could not determine the image format of "${inputPath}". Supported: PNG, JPEG, GIF, WebP, BMP.`
    default: return `Vision tool error: could not read image "${inputPath}"${error.message ? `: ${error.message}` : '.'}`
  }
}

async function audit(deps: DelegateDeps, entry: AuditEntry): Promise<void> {
  if (!deps.config.auditLog) return
  try {
    await appendAuditEntry(resolveAuditPath(deps.config.auditLogPath, deps.home), entry)
  } catch {
    /* audit is best-effort */
  }
}

/** The sub-agent message body: the image FILEPATH (never base64, never an
 *  ImageBlock — the subagent's own paste hook attaches it for the multimodal
 *  primary) plus the request and optional system prompt. */
export function buildSubagentPrompt(imagePath: string, prompt: string, systemPrompt?: string): string {
  const lines = [
    'You are a vision analysis sub-agent. Read the image referenced by the path below and answer the request.',
    'Respond with the description/answer text only — do not call any tools.',
    `Image path: ${imagePath}`,
    `Request: ${prompt}`,
  ]
  if (systemPrompt !== undefined && systemPrompt.length > 0) lines.push(`Guidelines: ${systemPrompt}`)
  return lines.join('\n')
}

/** Run one vision-model sub-agent and return its final text. */
async function delegateToSubagent(
  deps: DelegateDeps,
  params: DelegateParams,
  model: { provider: string; model: string },
  signal: AbortSignal | undefined,
): Promise<{ text: string; model: string }> {
  signal?.throwIfAborted()
  const handle = await deps.createSubagent({
    provider: model.provider,
    model: model.model,
    cwd: deps.workspace,
  })
  try {
    // A NORMAL user-sourced message carrying the filepath: the subagent's own
    // pre-step paste hook turns the path token into markers + a native
    // ImageBlock attachment for its multimodal primary (the same UX a user
    // pasting the path gets). Never base64, never a plugin-injected ImageBlock.
    handle.send(createUserMessage({
      content: [{ type: 'text', text: buildSubagentPrompt(params.image_path, params.prompt, deps.config.systemPrompt) }],
      source: { kind: 'user' },
    }))
    await handle.whenIdle()
    signal?.throwIfAborted()
    const text = handle.replyText()?.trim()
    if (text === undefined || text.length === 0) throw new Error('vision subagent returned no content')
    return { text, model: `${model.provider}/${model.model}` }
  } finally {
    await handle.dispose()
  }
}

interface ResolvedTransport {
  kind: 'subagent' | 'http'
  label: string
}

function httpConfigured(deps: DelegateDeps): boolean {
  return !!(deps.config.http.baseUrl && deps.config.http.credential && deps.config.http.model)
}

/** Decide the transport for this call. NATIVE-first (DESIGN RULE + user
 *  directive): auto/native → the DSH sub-agent with the configured vision
 *  model, whose message carries the image by filepath and attaches it natively
 *  (ImageBlock) for its multimodal primary. Only when the harness cannot
 *  deliver the image natively (attachment store unavailable — Android/Termux)
 *  does auto fall back to the plugin's own http endpoint call (base64 image);
 *  native mode refuses loudly instead of silently degrading. */
async function resolveTransport(deps: DelegateDeps): Promise<ResolvedTransport> {
  const mode = deps.config.delegation
  if (mode === 'http') {
    if (!httpConfigured(deps)) throw new VisionError('not_configured', NOT_CONFIGURED_MSG)
    return { kind: 'http', label: `${deps.config.http.baseUrl}/${deps.config.http.model}` }
  }
  // auto / native → sub-agent with the configured vision model (native path).
  if (deps.config.provider && deps.config.model) {
    const deliverable = deps.canDeliverImage === undefined ? true : await deps.canDeliverImage()
    if (deliverable) return { kind: 'subagent', label: `${deps.config.provider}/${deps.config.model}` }
    // Native delivery impossible on this host.
    if (mode === 'native') throw new VisionError('image_delivery_unavailable', IMAGE_DELIVERY_UNAVAILABLE_MSG)
    if (httpConfigured(deps)) return { kind: 'http', label: `${deps.config.http.baseUrl}/${deps.config.http.model}` }
    throw new VisionError('not_configured', IMAGE_DELIVERY_UNAVAILABLE_MSG)
  }
  throw new VisionError('not_configured', NOT_CONFIGURED_MSG)
}

async function callTransport(
  deps: DelegateDeps,
  transport: ResolvedTransport,
  image: LoadedImage,
  params: DelegateParams,
  maxTokens: number,
): Promise<{ text: string; model: string }> {
  if (transport.kind === 'subagent') {
    return delegateToSubagent(deps, params, {
      provider: deps.config.provider as string,
      model: deps.config.model as string,
    }, deps.signal)
  }
  const credential = await deps.resolveCredential(deps.config.http.credential as import('@deepseek-ai/dsh-credentials').CredentialRef)
  if (credential === undefined) {
    throw new VisionError('auth_error', `Vision tool error: credential "${deps.config.http.credential}" is not configured. Run: dsh credentials set ${deps.config.http.credential}`)
  }
  const text = await callHttpVision({
    baseUrl: deps.config.http.baseUrl as string,
    protocol: deps.config.http.protocol as HttpProtocol,
    model: deps.config.http.model as string,
    apiKey: credential.value,
    image,
    prompt: params.prompt,
    systemPrompt: deps.config.systemPrompt,
    reasoning: params.reasoning,
    maxTokens,
    signal: deps.signal,
  })
  return { text, model: `${deps.config.http.baseUrl}/${deps.config.http.model}` }
}

/** Resolve + call the fallback vision model (one attempt, no retry). */
async function runFallback(
  deps: DelegateDeps,
  transport: ResolvedTransport,
  image: LoadedImage,
  params: DelegateParams,
  maxTokens: number,
  primaryErr: unknown,
): Promise<DelegateResult> {
  if (!deps.config.fallbackProvider || !deps.config.fallbackModel) {
    return {
      ok: false,
      error: { code: 'vision_call_error', message: `Vision tool error: ${primaryErr instanceof Error ? primaryErr.message : String(primaryErr)}` },
    }
  }
  const fallbackId = `${deps.config.fallbackProvider}/${deps.config.fallbackModel}`
  if (transport.kind === 'http') {
    return {
      ok: false,
      error: { code: 'vision_call_error', message: 'Vision tool error: fallback requires the subagent transport (provider/model), but delegation uses http.' },
      details: { primaryError: String(primaryErr instanceof Error ? primaryErr.message : primaryErr).slice(0, 120), fallbackModel: fallbackId },
    }
  }
  try {
    const called = await delegateToSubagent(deps, params, {
      provider: deps.config.fallbackProvider,
      model: deps.config.fallbackModel,
    }, deps.signal)
    return { ok: true, text: called.text, details: { model: fallbackId, image_path: params.image_path, prompt: params.prompt, compressed: params.compress, reasoning: params.reasoning, cached: false, fallback: true, transport: 'subagent' } }
  } catch (fbErr) {
    return {
      ok: false,
      error: { code: 'vision_call_error', message: `Vision tool error (fallback ${fallbackId}): ${fbErr instanceof Error ? fbErr.message : String(fbErr)}` },
      details: { primaryError: String(primaryErr instanceof Error ? primaryErr.message : primaryErr).slice(0, 120), fallbackModel: fallbackId },
    }
  }
}

/** Run the full DELEGATE pipeline. Every failure returns a structured error. */
export async function delegateToVisionModel(deps: DelegateDeps, params: DelegateParams): Promise<DelegateResult> {
  if (!deps.config.enabled) {
    return { ok: false, error: { code: 'disabled', message: 'Vision tool is disabled. Use /vision on to enable.' } }
  }
  if (!isConfiguredForDelegation(deps.config)) {
    return { ok: false, error: { code: 'not_configured', message: NOT_CONFIGURED_MSG } }
  }

  let transport: ResolvedTransport
  try {
    transport = await resolveTransport(deps)
  } catch (err) {
    const code = err instanceof VisionError ? err.code : 'not_configured'
    return { ok: false, error: { code, message: err instanceof Error ? err.message : String(err) } }
  }

  const loaded = await loadImage(params.image_path, { cwd: deps.workspace })
  if (!loaded.ok) {
    return { ok: false, error: { code: loaded.error.code, message: formatImageError(loaded.error, params.image_path) } }
  }

  const baseDetails = {
    model: transport.label,
    image_path: params.image_path,
    prompt: params.prompt,
    compressed: params.compress,
    reasoning: params.reasoning,
  }

  const useCache = !!(deps.cache && deps.config.cacheEnabled)
  const modelId = transport.label
  const key = useCache
    ? cacheKey(loaded.sourceHash, params.compress, deps.config.maxDimension, deps.config.jpegQuality, params.prompt, modelId, params.reasoning, deps.config.systemPrompt, transport.kind)
    : undefined

  // Cache hit (local-only safe — the cache is local; 0 network calls).
  if (key && deps.cache) {
    const hit = await deps.cache.get(key)
    if (hit) {
      await audit(deps, {
        ts: new Date().toISOString(),
        provider: deps.config.provider ?? '(unset)',
        model: modelId,
        image_path: truncateImagePathForLog(params.image_path),
        source_hash: loaded.sourceHash,
        cached: true, fallback: false, fallback_model: undefined,
        ok: true, error_code: undefined, latency_ms: 0, local_only: deps.config.localOnly,
        transport: transport.kind,
      })
      return { ok: true, text: hit.text, details: { ...baseDetails, cached: true, fallback: false, transport: transport.kind } }
    }
  }

  // LOCAL-ONLY GATE — cache miss + localOnly → refuse, NO network path.
  if (deps.config.localOnly) {
    const cacheHint = deps.config.cacheEnabled
      ? 'Enable delegation (local-only off) to describe it, or re-use a previously-cached description.'
      : 'Enable delegation (local-only off) to describe it.'
    await audit(deps, {
      ts: new Date().toISOString(),
      provider: deps.config.provider ?? '(unset)',
      model: modelId,
      image_path: truncateImagePathForLog(params.image_path),
      source_hash: loaded.sourceHash,
      cached: false, fallback: false, fallback_model: undefined,
      ok: false, error_code: 'local_only', latency_ms: 0, local_only: true,
      transport: transport.kind,
    })
    return { ok: false, error: { code: 'local_only', message: LOCAL_ONLY_MSG(cacheHint) } }
  }

  // Compress on miss (only when requested).
  let networkImage: LoadedImage = loaded.image
  if (params.compress) {
    const compressed = await compressImage(loaded.image, { maxDimension: deps.config.maxDimension, jpegQuality: deps.config.jpegQuality })
    networkImage = { data: compressed.data, mimeType: compressed.mimeType, bytes: Buffer.from(compressed.data, 'base64').byteLength }
  }

  const maxTokens = 4096
  const t0 = performance.now()
  let result: { ok: boolean; text: string; model: string; fallback: boolean }
  try {
    const called = await withRetry(
      () => callTransport(deps, transport, networkImage, params, maxTokens),
      { attempts: deps.config.retryAttempts + 1, backoffMs: deps.config.retryBackoffMs, signal: deps.signal },
    )
    result = { ok: true, text: called.text, model: called.model, fallback: false }
  } catch (err) {
    if (classifyError(err) === 'abort') {
      await audit(deps, {
        ts: new Date().toISOString(), provider: deps.config.provider ?? '(unset)', model: modelId,
        image_path: truncateImagePathForLog(params.image_path), source_hash: loaded.sourceHash,
        cached: false, fallback: false, fallback_model: undefined, ok: false, error_code: 'aborted', latency_ms: Math.round(performance.now() - t0), local_only: false, transport: transport.kind,
      })
      return { ok: false, error: { code: 'aborted', message: 'Vision tool aborted.' } }
    }
    if (classifyError(err) === 'auth' && !deps.config.fallbackProvider) {
      await audit(deps, {
        ts: new Date().toISOString(), provider: deps.config.provider ?? '(unset)', model: modelId,
        image_path: truncateImagePathForLog(params.image_path), source_hash: loaded.sourceHash,
        cached: false, fallback: false, fallback_model: undefined, ok: false, error_code: 'auth_failed', latency_ms: Math.round(performance.now() - t0), local_only: false, transport: transport.kind,
      })
      return { ok: false, error: { code: 'auth_failed', message: `Vision tool error: the vision provider rejected the credentials (${err instanceof Error ? err.message : String(err)}). Check the API key / re-authorize the provider.` } }
    }
    const fallbackResult = await runFallback(deps, transport, networkImage, params, maxTokens, err)
    if (fallbackResult.ok) {
      result = { ok: true, text: fallbackResult.text, model: fallbackResult.details.model, fallback: true }
    } else {
      await audit(deps, {
        ts: new Date().toISOString(), provider: deps.config.provider ?? '(unset)', model: modelId,
        image_path: truncateImagePathForLog(params.image_path), source_hash: loaded.sourceHash,
        cached: false, fallback: false, fallback_model: undefined, ok: false, error_code: 'vision_call_error', latency_ms: Math.round(performance.now() - t0), local_only: false, transport: transport.kind,
      })
      return fallbackResult
    }
  }
  const latency_ms = Math.round(performance.now() - t0)

  // Cache store on success — NEVER a fallback result (F10).
  if (result.ok && !result.fallback && useCache && key && deps.cache) {
    await deps.cache.set(key, { text: result.text, details: { model: result.model, cached: false }, storedAt: Date.now() })
  }

  await audit(deps, {
    ts: new Date().toISOString(),
    provider: deps.config.provider ?? '(unset)',
    model: result.model,
    image_path: truncateImagePathForLog(params.image_path),
    source_hash: loaded.sourceHash,
    cached: false,
    fallback: result.fallback,
    fallback_model: result.fallback ? result.model : undefined,
    ok: result.ok,
    error_code: result.ok ? undefined : undefined,
    latency_ms,
    local_only: false,
    transport: transport.kind,
  })

  return {
    ok: true,
    text: result.text,
    details: { ...baseDetails, model: result.model, cached: false, fallback: result.fallback, transport: transport.kind },
  }
}

