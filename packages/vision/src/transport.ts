/** Delegation transports. Per the DESIGN RULE, delegation is a DSH subagent
 *  with the vision model (delegate.ts); the http transport here is the
 *  plugin's own direct endpoint call (OpenAI-compatible /chat/completions or
 *  Anthropic /v1/messages with base64 image parts) for delegation=http — it
 *  is NOT another agent tool and does not touch the attachment store. */
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

