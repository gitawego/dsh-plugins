/** Http-transport tests: request-body shapes (base64 image parts, no
 *  attachment-store references), response extraction, output-token caps, and
 *  the endpoint call itself (mocked fetch). Delegation to the vision model as
 *  a DSH subagent is covered by delegate.spec.ts / subagent.spec.ts. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildAnthropicBody, buildOpenAIBody, callHttpVision, extractAnthropicText,
  extractOpenAIText, maxTokensFor,
} from '../src/transport.ts'
import type { LoadedImage } from '../src/image.ts'

const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
const image: LoadedImage = { data: PNG_1x1.toString('base64'), mimeType: 'image/png', bytes: PNG_1x1.byteLength }

const BASE_OPTS = {
  baseUrl: 'https://api.example.com', protocol: 'openai' as const, model: 'vision-1',
  apiKey: 'k', image, prompt: 'describe', systemPrompt: undefined,
  reasoning: 'off' as const, maxTokens: 2048, signal: undefined,
}

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body, text: async () => '' } as unknown as Response
}

afterEach(() => vi.unstubAllGlobals())

describe('maxTokensFor', () => {
  it('defaults to 4096 with no ceiling and caps at 4096 otherwise', () => {
    expect(maxTokensFor(undefined)).toBe(4096)
    expect(maxTokensFor(0)).toBe(4096)
    expect(maxTokensFor(10000)).toBe(4096)
    expect(maxTokensFor(512)).toBe(512)
  })
})

describe('buildOpenAIBody', () => {
  it('carries the image as a data-URL part (no attachment refs) and a system message when set', () => {
    const body = buildOpenAIBody({ ...BASE_OPTS, systemPrompt: 'be terse' })
    expect(body.model).toBe('vision-1')
    expect(body.max_tokens).toBe(2048)
    expect(body.temperature).toBe(0)
    const messages = body.messages as Array<{ role: string; content: unknown }>
    expect(messages[0]).toMatchObject({ role: 'system', content: 'be terse' })
    const user = messages[1]!
    const parts = user.content as Array<Record<string, unknown>>
    expect(parts[0]).toMatchObject({ type: 'image_url', image_url: { url: `data:image/png;base64,${image.data}` } })
    expect(parts[1]).toMatchObject({ type: 'text', text: 'describe' })
    expect(body.reasoning_effort).toBeUndefined()
  })

  it('adds reasoning_effort when reasoning is set and omits the system message when absent', () => {
    const body = buildOpenAIBody({ ...BASE_OPTS, reasoning: 'high' })
    expect(body.reasoning_effort).toBe('high')
    const messages = body.messages as Array<{ role: string }>
    expect(messages.find((m) => m.role === 'system')).toBeUndefined()
  })
})

describe('buildAnthropicBody', () => {
  it('carries the image as a base64 source block and the system prompt top-level', () => {
    const body = buildAnthropicBody({ ...BASE_OPTS, systemPrompt: 'be terse' })
    expect(body.model).toBe('vision-1')
    expect(body.max_tokens).toBe(2048)
    expect(body.system).toBe('be terse')
    const content = (body.messages as Array<{ content: Array<Record<string, unknown>> }>)[0]!.content
    expect(content[0]).toMatchObject({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: image.data } })
    expect(content[1]).toMatchObject({ type: 'text', text: 'describe' })
  })
})

describe('response extraction', () => {
  it('extracts OpenAI content, falling back to reasoning_content', () => {
    expect(extractOpenAIText({ choices: [{ message: { content: 'answer' } }] })).toBe('answer')
    expect(extractOpenAIText({ choices: [{ message: { reasoning_content: 'thought' } }] })).toBe('thought')
    expect(extractOpenAIText({ choices: [] })).toBeUndefined()
  })

  it('extracts Anthropic text blocks, falling back to thinking', () => {
    expect(extractAnthropicText({ content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'answer' }] })).toBe('answer')
    expect(extractAnthropicText({ content: [{ type: 'thinking', thinking: 'hmm' }] })).toBe('hmm')
    expect(extractAnthropicText({ content: [] })).toBeUndefined()
  })
})

describe('callHttpVision (mocked fetch)', () => {
  it('calls /chat/completions with the Authorization header and returns the text', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => jsonResponse({ choices: [{ message: { content: 'a cat' } }] }))
    vi.stubGlobal('fetch', fetchMock)
    const text = await callHttpVision(BASE_OPTS)
    expect(text).toBe('a cat')
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://api.example.com/chat/completions')
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer k' })
  })

  it('trims trailing slashes and uses /v1/messages for the anthropic protocol', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => jsonResponse({ content: [{ type: 'text', text: 'ok' }] }))
    vi.stubGlobal('fetch', fetchMock)
    await callHttpVision({ ...BASE_OPTS, baseUrl: 'https://api.example.com/', protocol: 'anthropic' })
    expect(fetchMock.mock.calls[0]![0]).toBe('https://api.example.com/v1/messages')
  })

  it('throws a status-bearing error on non-ok responses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 429, text: async () => 'slow down', json: async () => ({}) }) as unknown as Response))
    await expect(callHttpVision(BASE_OPTS)).rejects.toThrow(/Vision model returned 429/)
  })

  it('throws when the response carries no content', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ choices: [] })))
    await expect(callHttpVision(BASE_OPTS)).rejects.toThrow(/no content/i)
  })
})

/** admitEncodedImages path: when the host exposes a working attachment
 *  store, the http transport validates the image against the rc.8
 *  ImageAttachmentLimits via ctx.attachments.saveImage BEFORE hitting the
 *  endpoint. Admission failures throw with the canonical AttachmentErrorCode
 *  (mapped to VisionError); on hosts where the store cannot write
 *  (Termux: no `attachments` arg), the transport falls through to base64
 *  exactly as before. */
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'

/** Helper: build a typed saveImage seam whose mock returns a properly
 *  branded ImageAttachmentRef. The cast at the boundary is intentional —
 *  tests only care about the call shape, not the brand. */
function fakeRef(): ImageAttachmentRef {
  return {
    attachmentId: AttachmentId('sha256:abc'),
    mediaType: 'image/png',
    bytes: PNG_1x1.byteLength,
    width: 1,
    height: 1,
  }
}

describe('callHttpVision admission via admitEncodedImages (rc.8)', () => {
  it('skips admission when no attachments seam is provided (Termux path)', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ choices: [{ message: { content: 'a cat' } }] }))
    vi.stubGlobal('fetch', fetchMock)
    // No attachments argument — existing behavior, must not break.
    const text = await callHttpVision(BASE_OPTS)
    expect(text).toBe('a cat')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('admits via saveImage before fetching when an attachments seam is provided', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ choices: [{ message: { content: 'a cat' } }] }))
    vi.stubGlobal('fetch', fetchMock)
    const saveImage = vi.fn(async (_input: { data: Uint8Array; mediaType: string }) => fakeRef())
    await callHttpVision({ ...BASE_OPTS, attachments: { saveImage } })
    expect(saveImage).toHaveBeenCalledTimes(1)
    // The saveImage call must carry the actual image bytes + declared MIME.
    const arg = saveImage.mock.calls[0]?.[0]
    expect(arg).toBeDefined()
    expect(arg!.mediaType).toBe('image/png')
    expect(arg!.data).toBeInstanceOf(Uint8Array)
    expect(arg!.data.byteLength).toBe(PNG_1x1.byteLength)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('throws a VisionError with mapped code when admission fails (rc.8 IMAGE_TOO_LARGE)', async () => {
    vi.stubGlobal('fetch', vi.fn())
    const { AttachmentError } = await import('@deepseek-ai/dsh-attachment')
    const saveImage = vi.fn(async () => {
      throw new AttachmentError('too large', 'IMAGE_TOO_LARGE')
    })
    await expect(
      callHttpVision({ ...BASE_OPTS, attachments: { saveImage } }),
    ).rejects.toMatchObject({ code: 'too_large', name: 'VisionError' })
  })

  it('throws a VisionError with mapped code on UNSUPPORTED_IMAGE_TYPE', async () => {
    vi.stubGlobal('fetch', vi.fn())
    const { AttachmentError } = await import('@deepseek-ai/dsh-attachment')
    const saveImage = vi.fn(async () => {
      throw new AttachmentError('unsupported', 'UNSUPPORTED_IMAGE_TYPE')
    })
    await expect(
      callHttpVision({ ...BASE_OPTS, attachments: { saveImage } }),
    ).rejects.toMatchObject({ code: 'unsupported_format' })
  })

  it('still fetches even when admission succeeds (admission is validation, not transport)', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) =>
      jsonResponse({ choices: [{ message: { content: 'ok' } }] }) as unknown as Response & { _init?: RequestInit },
    )
    vi.stubGlobal('fetch', fetchMock)
    const saveImage = vi.fn(async () => fakeRef())
    const text = await callHttpVision({ ...BASE_OPTS, attachments: { saveImage } })
    expect(text).toBe('ok')
    // The fetch body still carries the inline base64 — providers cannot
    // dereference a DSH ImageAttachmentRef. Admission is pre-flight only.
    const call = fetchMock.mock.calls[0]
    expect(call).toBeDefined()
    const init = call![1]
    expect(init).toBeDefined()
    const body = JSON.parse(init!.body as string)
    // BASE_OPTS has no systemPrompt → messages[0] is the user message.
    const user = body.messages[0]
    expect(user).toBeDefined()
    const imagePart = user.content[0]
    expect(imagePart.image_url.url.startsWith('data:image/png;base64,')).toBe(true)
  })
})
