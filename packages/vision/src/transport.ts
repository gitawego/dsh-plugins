/** Delegation transports. Per the DESIGN RULE, delegation is a DSH subagent
 *  with the vision model (delegate.ts); the http transport here is the
 *  plugin's own direct endpoint call (OpenAI-compatible /chat/completions or
 *  Anthropic /v1/messages with base64 image parts) for delegation=http — it
 *  is NOT another agent tool and does not touch the attachment store.
 *
 *  rc.8 ADOPTION: when the host exposes a working attachment store
 *  (ctx.attachments.saveImage), the http transport FIRST validates the
 *  image against the harness's ImageAttachmentLimits via the canonical
 *  saveImage seam. Admission failures throw a VisionError mapped from the
 *  rc.8 AttachmentErrorCode taxonomy so callers see a closed vocabulary.
 *  The HTTP body still carries the inline base64 (providers cannot
 *  dereference a DSH ImageAttachmentRef) — admission is pre-flight
 *  validation only. When the store cannot write (Termux: durability walk
 *  EACCES at /data/data), the call site omits `attachments` and the
 *  transport falls through to base64 exactly as before. */
import type { AttachmentError, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ReasoningLevel } from './config.ts'
import { VisionError } from './errors.ts'
import type { LoadedImage } from './image.ts'

export type HttpProtocol = 'openai' | 'anthropic'

export interface HttpCallOptions {
  baseUrl: string
  protocol: HttpProtocol
  model: string
  apiKey: string | undefined
  image: LoadedImage
  prompt: string
  systemPrompt: string | undefined
  reasoning: ReasoningLevel
  maxTokens: number
  signal: AbortSignal | undefined
  /** Optional rc.8 attachment-store seam for pre-flight admission. When
   *  provided, the transport validates the image via saveImage (which runs
   *  ImageAttachmentLimits + media-type allowlist) before hitting the HTTP
   *  endpoint. When absent, the transport falls through to base64 inline
   *  (the Termux path: the store cannot write). */
  attachments?: {
    saveImage: (input: { data: Uint8Array; mediaType: string; name?: string }) => Promise<ImageAttachmentRef>
  }
}

/** Map a single rc.8 AttachmentError code to the plugin's VisionErrorCode
 *  vocabulary. The mapping is 1:1 for the closed ImageAdmissionErrorCode
 *  subset (IMAGE_TOO_LARGE, IMAGE_DIMENSION_TOO_LARGE, IMAGE_TOO_MANY_PIXELS,
 *  IMAGE_TYPE_MISMATCH, UNSUPPORTED_IMAGE_TYPE, INVALID_IMAGE_BASE64,
 *  INVALID_IMAGE) and the batch-level codes (TOO_MANY_IMAGES, IMAGES_TOO_LARGE).
 *  Other attachment codes (storage faults) bubble up as 'unexpected'. */
export function mapAttachmentCode(code: string): import('./errors.ts').VisionErrorCode {
  switch (code) {
    case 'IMAGE_TOO_LARGE':
    case 'IMAGE_DIMENSION_TOO_LARGE':
    case 'IMAGE_TOO_MANY_PIXELS':
    case 'IMAGES_TOO_LARGE':
      return 'too_large'
    case 'UNSUPPORTED_IMAGE_TYPE':
    case 'IMAGE_TYPE_MISMATCH':
      return 'unsupported_format'
    case 'INVALID_IMAGE_BASE64':
      return 'invalid_data_url'
    case 'INVALID_IMAGE':
      return 'invalid_data_url'
    case 'TOO_MANY_IMAGES':
      return 'batch_too_large'
    default:
      return 'unexpected'
  }
}

/** Convert a thrown AttachmentError to a VisionError. */
export function attachmentErrorToVisionError(err: AttachmentError): VisionError {
  return new VisionError(mapAttachmentCode(err.code), `rc.8 attachment admission failed (${err.code}): ${err.message}`)
}

/** Requested output-token cap. Default 4096; never exceed a known ceiling
 *  (F3: data-driven, not an arbitrary constant). */
export function maxTokensFor(ceiling: number | undefined): number {
  if (ceiling === undefined || ceiling <= 0) return 4096
  return Math.min(ceiling, 4096)
}

/** OpenAI-compatible request body: images as image_url data URLs, system
 *  prompt as a leading system message, optional reasoning_effort. */
export function buildOpenAIBody(
  opts: { model: string; image: LoadedImage; prompt: string; systemPrompt: string | undefined; reasoning: ReasoningLevel; maxTokens: number },
): Record<string, unknown> {
  const messages: unknown[] = []
  if (opts.systemPrompt !== undefined && opts.systemPrompt.length > 0) {
    messages.push({ role: 'system', content: opts.systemPrompt })
  }
  messages.push({
    role: 'user',
    content: [
      { type: 'image_url', image_url: { url: `data:${opts.image.mimeType};base64,${opts.image.data}` } },
      { type: 'text', text: opts.prompt },
    ],
  })
  const body: Record<string, unknown> = {
    model: opts.model,
    messages,
    max_tokens: opts.maxTokens,
    temperature: 0, // deliberate determinism: reproducible descriptions
  }
  if (opts.reasoning !== 'off') body.reasoning_effort = opts.reasoning
  return body
}

/** Anthropic Messages request body: images as source.base64 blocks, system
 *  prompt as a top-level system field. */
export function buildAnthropicBody(
  opts: { model: string; image: LoadedImage; prompt: string; systemPrompt: string | undefined; maxTokens: number },
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: opts.model,
    max_tokens: opts.maxTokens,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: opts.image.mimeType, data: opts.image.data } },
          { type: 'text', text: opts.prompt },
        ],
      },
    ],
  }
  if (opts.systemPrompt !== undefined && opts.systemPrompt.length > 0) body.system = opts.systemPrompt
  return body
}

/** Extract the assistant text from an OpenAI-compatible response. */
export function extractOpenAIText(json: unknown): string | undefined {
  const choices = (json as { choices?: Array<{ message?: { content?: string; reasoning_content?: string } }> })?.choices
  const msg = choices?.[0]?.message
  return msg?.content || msg?.reasoning_content
}

/** Extract text from an Anthropic Messages response (text block, else thinking). */
export function extractAnthropicText(json: unknown): string | undefined {
  const blocks = (json as { content?: Array<{ type?: string; text?: string; thinking?: string }> })?.content
  if (!Array.isArray(blocks)) return undefined
  const textBlock = blocks.find((b) => b.type === 'text' && typeof b.text === 'string' && b.text.length > 0)
  if (textBlock?.text) return textBlock.text
  const thinkingBlock = blocks.find((b) => b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking.length > 0)
  return thinkingBlock?.thinking
}

/** Call the vision endpoint (OpenAI-compatible or Anthropic Messages). */
export async function callHttpVision(opts: HttpCallOptions): Promise<string> {
  // Pre-flight admission via the rc.8 attachment store (when the host exposes
  // one). This validates the image against ImageAttachmentLimits (byte / pixel /
  // dimension / media-type) BEFORE we hit the provider. On hosts where the store
  // cannot write (Termux: durability walk hits EACCES at /data/data), call sites
  // omit `attachments` and we fall through to base64 inline — the same code path
  // that ran before this adoption.
  if (opts.attachments !== undefined) {
    try {
      await opts.attachments.saveImage({
        data: Buffer.from(opts.image.data, 'base64'),
        mediaType: opts.image.mimeType,
      })
    } catch (err) {
      // Re-throw any non-attachment errors (network, programming bugs).
      if (err instanceof Error && 'code' in err && typeof (err as { code?: unknown }).code === 'string') {
        throw attachmentErrorToVisionError(err as AttachmentError)
      }
      throw err
    }
  }

  const baseUrl = opts.baseUrl.replace(/\/+$/, '')
  const url = opts.protocol === 'anthropic' ? `${baseUrl}/v1/messages` : `${baseUrl}/chat/completions`
  const body = opts.protocol === 'anthropic'
    ? buildAnthropicBody(opts)
    : buildOpenAIBody(opts)
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts.apiKey !== undefined) headers.Authorization = `Bearer ${opts.apiKey}`
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: opts.signal,
  })
  if (!response.ok) {
    const errBody = await response.text().catch(() => '')
    throw new Error(`Vision model returned ${response.status}: ${errBody.slice(0, 500)}`)
  }
  const json = await response.json()
  const text = opts.protocol === 'anthropic' ? extractAnthropicText(json) : extractOpenAIText(json)
  if (!text) throw new Error('Vision model returned no content in the response')
  return text
}

