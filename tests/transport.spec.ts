/** Native-transport tests: durable-attachment failures must produce actionable
 *  http-delegation guidance GENERICALLY — any permission/filesystem-class store
 *  failure (EACCES/EPERM/EROFS/ENOSPC/EDQUOT, possibly wrapped in a cause),
 *  cross-platform, while unrelated errors pass through untouched. */
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { describe, expect, it } from 'vitest'
import { callNativeVision } from '../src/transport.ts'

const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

function fsError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string }
  error.code = code
  return error
}

const image = { data: PNG_1x1.toString('base64'), mimeType: 'image/png' as const, bytes: PNG_1x1.byteLength }

function failingAttachments(error: unknown) {
  return { saveImage: async () => { throw error } }
}

function streamingLlm() {
  return {
    stream: async function* () {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'a cat' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'a cat' } }
    },
  }
}

const VALID_REF: ImageAttachmentRef = { attachmentId: 'a1', mediaType: 'image/png', bytes: 1, width: 1, height: 1 }

describe('callNativeVision attachment-store failures (generic, cross-platform)', () => {
  it.each(['EACCES', 'EPERM', 'EROFS', 'ENOSPC', 'EDQUOT'])(
    'gives http-delegation guidance on %s',
    async (code) => {
      await expect(callNativeVision(
        { llm: streamingLlm() as never, attachments: failingAttachments(fsError(code, 'nope')), provider: 'p', model: 'm' },
        image,
        'describe',
      )).rejects.toThrow(/http delegation/i)
    },
  )

  it('recognizes the code on a wrapped cause (fs error inside another error)', async () => {
    const inner = fsError('EACCES', "EACCES: permission denied, open '/data/data'")
    const wrapper = new Error('attachment save failed', { cause: inner })
    await expect(callNativeVision(
      { llm: streamingLlm() as never, attachments: failingAttachments(wrapper), provider: 'p', model: 'm' },
      image,
      'describe',
    )).rejects.toThrow(/http delegation/i)
  })

  it('passes through non-filesystem errors unchanged (store validation errors)', async () => {
    const storeError = new Error('Image exceeds the configured byte limit.')
    await expect(callNativeVision(
      { llm: streamingLlm() as never, attachments: failingAttachments(storeError), provider: 'p', model: 'm' },
      image,
      'describe',
    )).rejects.toThrow('Image exceeds the configured byte limit.')
  })

  it('streams a successful reply', async () => {
    const text = await callNativeVision(
      { llm: streamingLlm() as never, attachments: { saveImage: async () => VALID_REF }, provider: 'p', model: 'm' },
      image,
      'describe',
    )
    expect(text).toBe('a cat')
  })
})

