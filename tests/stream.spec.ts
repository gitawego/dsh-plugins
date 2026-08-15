/** Request-boundary (llm/stream) image converter tests: hand-built calls
 *  (compaction/session-title) targeting a known text-only model get image
 *  blocks converted to cached text descriptions; loop-built and multimodal
 *  requests pass through untouched. */
import { describe, expect, it, vi } from 'vitest'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { markAgentLoopRequest, type GenerateOptions, type Message, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { createStreamImageConverter, type StreamConverterDeps } from '../src/stream.ts'
import type { DelegateResult } from '../src/delegate.ts'

const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

const IMG_REF = {
  attachmentId: 'att-1', mediaType: 'image/png', bytes: PNG_1x1.byteLength, width: 1, height: 1, name: 'x.png',
} as ImageAttachmentRef

function message(role: 'user' | 'assistant', blocks: Array<{ type: string; [k: string]: unknown }>): Message {
  return { id: 'm1' as never, role, content: blocks as never, source: { kind: 'user' } as never }
}

function okResult(imagePath: string): DelegateResult {
  return {
    ok: true,
    text: 'a cat on a mat',
    details: {
      model: 'p/m', image_path: imagePath, prompt: 'prompt', compressed: true,
      reasoning: 'off', cached: false, fallback: false, transport: 'http',
    },
  }
}

function makeDeps(overrides: Partial<StreamConverterDeps> = {}): StreamConverterDeps & {
  streamCalls: GenerateOptions[]
  delegateCalls: string[]
} {
  const streamCalls: GenerateOptions[] = []
  const delegateCalls: string[] = []
  const deps: StreamConverterDeps = {
    resolveModelImageCapable: async (provider, model) => (model.startsWith('text-') ? false : true),
    readImage: async (ref) => ({ ref, data: new Uint8Array(PNG_1x1) }),
    tmpDir: (() => {
      const d = join(tmpdir(), 'dsh-vision-stream-' + Date.now() + '-' + Math.floor(Math.random() * 1e6))
      mkdirSync(d, { recursive: true })
      return d
    })(),
    workspaceFor: () => '/ws',
    delegateFor: () => async (params) => { delegateCalls.push(params.image_path); return okResult(params.image_path) },
    prompt: 'describe this image',
    stream: async function* (options) { streamCalls.push(options); yield { type: 'chunk' } as never }
    ,
    ...overrides,
  }
  return Object.assign(deps, { streamCalls, delegateCalls })
}

async function* passThrough(): AsyncIterable<StreamChunk> {
  yield { type: 'chunk' } as never
}

function allText(msg: Message): string {
  return (msg.content as Array<{ type?: string; text?: string }>)
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join(' ')
}

async function collect(iter: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const c of iter) out.push(c)
  return out
}

function textOnlyOptions(messages: Message[]): GenerateOptions {
  return { provider: 'p', model: 'text-5.2', messages } as GenerateOptions
}

function imageOptions(): GenerateOptions {
  return textOnlyOptions([message('user', [{ type: 'text', text: 'see this' }, { type: 'image', attachment: IMG_REF }])])
}

describe('createStreamImageConverter', () => {
  it('passes through requests without image blocks (no stream replacement)', async () => {
    const deps = makeDeps()
    const converter = createStreamImageConverter(deps)
    const options = textOnlyOptions([message('user', [{ type: 'text', text: 'hello' }])])
    const chunks = await collect(converter(options, passThrough))
    expect(chunks).toHaveLength(1)
    expect(deps.streamCalls).toHaveLength(0)
  })

  it('never rewrites loop-built (agent) requests, even with images', async () => {
    const deps = makeDeps()
    const converter = createStreamImageConverter(deps)
    const options = imageOptions()
    markAgentLoopRequest(options)
    const chunks = await collect(converter(options, passThrough))
    expect(chunks).toHaveLength(1)
    expect(deps.streamCalls).toHaveLength(0)
    expect(deps.delegateCalls).toHaveLength(0)
  })

  it('leaves multimodal targets untouched (native image reading)', async () => {
    const deps = makeDeps()
    const converter = createStreamImageConverter(deps)
    const options = { provider: 'p', model: 'vision-m', messages: imageOptions().messages } as GenerateOptions
    const chunks = await collect(converter(options, passThrough))
    expect(chunks).toHaveLength(1)
    expect(deps.streamCalls).toHaveLength(0)
    expect(deps.delegateCalls).toHaveLength(0)
  })

  it('leaves unknown-capability targets untouched (safe default)', async () => {
    const deps = makeDeps({ resolveModelImageCapable: async () => undefined })
    const converter = createStreamImageConverter(deps)
    const chunks = await collect(converter(imageOptions(), passThrough))
    expect(chunks).toHaveLength(1)
    expect(deps.streamCalls).toHaveLength(0)
  })

  it('converts image blocks to text for a text-only target (compaction case)', async () => {
    const deps = makeDeps()
    const converter = createStreamImageConverter(deps)
    const options = { ...imageOptions(), purpose: 'compaction' as const }
    const chunks = await collect(converter(options, passThrough))
    expect(deps.delegateCalls).toHaveLength(1)
    expect(deps.streamCalls).toHaveLength(1)
    const replaced = deps.streamCalls[0]!
    expect(replaced.messages[0]!.content.some((b: { type?: string }) => b.type === 'image')).toBe(false)
    expect(allText(replaced.messages[0]!)).toContain('a cat on a mat')
    expect(chunks).toHaveLength(1) // re-entered stream yields the chunk
    // Original options untouched
    expect(options.messages[0]!.content.some((b: { type?: string }) => b.type === 'image')).toBe(true)
  })

  it('replaces failed conversions with a note so compaction still proceeds', async () => {
    const deps = makeDeps({ delegateFor: () => async () => ({ ok: false, error: { code: 'not_configured', message: 'nope' } }) })
    const converter = createStreamImageConverter(deps)
    const chunks = await collect(converter(imageOptions(), passThrough))
    expect(deps.streamCalls).toHaveLength(1)
    expect(allText(deps.streamCalls[0]!.messages[0]!)).toContain('description failed')
    expect(chunks).toHaveLength(1)
  })
})
