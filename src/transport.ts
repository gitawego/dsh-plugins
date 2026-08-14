/** Delegation transports. http = exact pi-vision port (OpenAI-compatible
 *  /chat/completions or Anthropic /v1/messages with base64 image parts).
 *  native = ctx.llm.stream with a durable ImageBlock attachment (pi-ai
 *  adapter resolves the ref; retry/metering come from the harness). */
import type { AttachmentStore, ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { BlockAssembler, GenerateOptions, LlmRuntime, StreamChunk } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ReasoningLevel } from './config.ts'
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

export interface LlmLike {
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

export interface AttachmentsLike {
  saveImage(input: { data: Uint8Array; mediaType: ImageMediaType; name?: string }): Promise<ImageAttachmentRef>
}

export interface NativeCallOptions {
  llm: LlmLike
  attachments: AttachmentsLike
  provider: string
  model: string
  system?: string
  reasoningEffort?: string
  temperature?: number
  maxTokens?: number
  signal?: AbortSignal
}

/** Native transport: save bytes as a durable attachment, send an ImageBlock
 *  through ctx.llm.stream, assemble the text reply. */
export async function callNativeVision(opts: NativeCallOptions, image: LoadedImage, prompt: string): Promise<string> {
  const mediaType = image.mimeType as ImageMediaType
  const ref = await opts.attachments.saveImage({
    data: Buffer.from(image.data, 'base64'),
    mediaType,
    name: 'describe_image',
  })
  const message = createUserMessage({
    content: [
      { type: 'image', attachment: ref },
      { type: 'text', text: prompt },
    ],
    source: { kind: 'user' },
  })
  const { BlockAssembler } = await import('@deepseek-ai/dsh-llm')
  const assembler: BlockAssembler = new BlockAssembler()
  for await (const chunk of opts.llm.stream({
    provider: opts.provider,
    model: opts.model,
    messages: [message],
    ...(opts.system === undefined ? {} : { system: opts.system }),
    ...(opts.reasoningEffort === undefined ? {} : { reasoningEffort: opts.reasoningEffort as import('@deepseek-ai/dsh-llm').ReasoningEffortId }),
    ...(opts.temperature === undefined ? {} : { temperature: opts.temperature }),
    ...(opts.maxTokens === undefined ? {} : { maxTokens: opts.maxTokens }),
    ...(opts.signal === undefined ? {} : { signal: opts.signal }),
  })) {
    assembler.push(chunk)
  }
  const text = assembler.blocks()
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim()
  if (text.length === 0) throw new Error('Vision model returned no content in the response')
  return text
}

/** Minimal LlmRuntime surface the native transport needs. */
export type { LlmRuntime }
