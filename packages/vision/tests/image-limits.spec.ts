/** Image-limit enforcement tests (rc.8 ImageAttachmentLimits adoption).
 *  enforceImageLimits maps the harness's typed limits (maxImageBytes,
 *  maxPixels, maxImageDimension, mediaTypes) to the plugin's ImageLoadError
 *  codes so admission failures keep the plugin's error vocabulary while
 *  the codes line up 1:1 with the rc.8 ImageAdmissionErrorCode union
 *  (validated via isImageAdmissionError in [6]). */
import { describe, expect, it } from 'vitest'
import type { ImageAttachmentLimits } from '@deepseek-ai/dsh-attachment'
import { enforceImageLimits } from '../src/image.ts'

const REASONABLE_LIMITS: ImageAttachmentLimits = {
  maxImageBytes: 1024 * 1024, // 1 MiB
  maxImagesPerMessage: 10,
  maxMessageImageBytes: 4 * 1024 * 1024, // 4 MiB
  maxImagePixels: 4096 * 4096,
  maxImageDimension: 4096,
  mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const,
}

describe('enforceImageLimits', () => {
  it('rejects bytes above maxImageBytes with code IMAGE_TOO_LARGE', () => {
    const result = enforceImageLimits({
      bytes: 2 * 1024 * 1024,
      mimeType: 'image/png',
      limits: REASONABLE_LIMITS,
    })
    expect(result).toEqual({ ok: false, code: 'too_large', message: expect.stringContaining('byte limit') })
  })

  it('rejects unsupported MIME with code unsupported_format (UNSUPPORTED_IMAGE_TYPE)', () => {
    const result = enforceImageLimits({
      bytes: 100,
      mimeType: 'image/bmp',
      limits: REASONABLE_LIMITS,
    })
    expect(result).toEqual({ ok: false, code: 'unsupported_format', message: expect.stringContaining('image/bmp') })
  })

  it('rejects dimensions above maxImageDimension with code too_large', () => {
    const result = enforceImageLimits({
      bytes: 100,
      mimeType: 'image/png',
      limits: REASONABLE_LIMITS,
      dimensions: { width: 5000, height: 100 },
    })
    expect(result).toEqual({ ok: false, code: 'too_large', message: expect.stringContaining('dimension limit') })
  })

  it('rejects total pixels above maxImagePixels with code too_large', () => {
    const result = enforceImageLimits({
      bytes: 100,
      mimeType: 'image/png',
      limits: REASONABLE_LIMITS,
      dimensions: { width: 5000, height: 5000 },
    })
    expect(result).toEqual({ ok: false, code: 'too_large', message: expect.stringContaining('pixel limit') })
  })

  it('passes when under every limit', () => {
    const result = enforceImageLimits({
      bytes: 100,
      mimeType: 'image/png',
      limits: REASONABLE_LIMITS,
      dimensions: { width: 100, height: 100 },
    })
    expect(result).toEqual({ ok: true })
  })

  it('skips dimension checks when dimensions are not provided', () => {
    const result = enforceImageLimits({
      bytes: 100,
      mimeType: 'image/png',
      limits: REASONABLE_LIMITS,
    })
    expect(result).toEqual({ ok: true })
  })

  it('includes the matching rc.8 ImageAdmissionErrorCode in the message', () => {
    const result = enforceImageLimits({
      bytes: 2 * 1024 * 1024,
      mimeType: 'image/png',
      limits: REASONABLE_LIMITS,
    })
    expect(result.ok).toBe(false)
    if (result.ok === false) {
      expect(result.message).toContain('IMAGE_TOO_LARGE')
    }
  })
})
