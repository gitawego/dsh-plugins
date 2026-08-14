/** Image loading, hashing, MIME sniffing, and (graceful) compression.
 *  Compression uses sharp when available and degrades to original bytes when
 *  it is not — mirroring pi-vision's "degrade gracefully" contract. */
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { isAbsolute, resolve as resolvePath } from 'node:path'

export const MAX_IMAGE_BYTES = 64 * 1024 * 1024

export const SUPPORTED_MIME = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp'] as const
export type SupportedMime = (typeof SUPPORTED_MIME)[number]

export interface LoadedImage {
  /** base64-encoded image data (no data: prefix). */
  data: string
  /** MIME type, e.g. "image/png". */
  mimeType: SupportedMime
  /** Byte length of the original encoded bytes. */
  bytes: number
}

export type ImageLoadErrorCode =
  | 'not_found' | 'not_a_file' | 'too_large' | 'unsupported_format' | 'read_error'
  | 'invalid_data_url' | 'invalid_base64'

export interface ImageLoadError {
  code: ImageLoadErrorCode
  path?: string
  size?: number
  message?: string
}

export type ImageLoadResult =
  | { ok: true; image: LoadedImage; sourceHash: string; kind: 'file' | 'data' | 'base64'; path?: string }
  | { ok: false; error: ImageLoadError }

/** SHA-256 (hex) of raw bytes — the content-addressed cache key base. */
export function hashBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Sniff MIME from magic bytes (PNG/JPEG/GIF/WebP/BMP). */
export function sniffMime(bytes: Uint8Array): SupportedMime | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'image/gif'
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp'
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image/bmp'
  return undefined
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}

/** Decode a data: URL into bytes + media type. */
function parseDataUrl(input: string): { bytes: Uint8Array; mimeType: SupportedMime } | undefined {
  const m = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(input.trim())
  if (!m) return undefined
  const mime = m[1]!.toLowerCase()
  if (!(SUPPORTED_MIME as readonly string[]).includes(mime)) return undefined
  try {
    return { bytes: new Uint8Array(Buffer.from(m[2]!, 'base64')), mimeType: mime as SupportedMime }
  } catch {
    return undefined
  }
}

/** Load an image from a file path, data: URL, or raw base64. */
export async function loadImage(
  input: string,
  opts: { cwd: string; maxBytes?: number },
): Promise<ImageLoadResult> {
  const maxBytes = opts.maxBytes ?? MAX_IMAGE_BYTES
  const trimmed = input.trim()

  // data: URL
  if (trimmed.startsWith('data:')) {
    const parsed = parseDataUrl(trimmed)
    if (!parsed) return { ok: false, error: { code: 'invalid_data_url', message: 'malformed data: URL or unsupported media type' } }
    if (parsed.bytes.byteLength > maxBytes) return { ok: false, error: { code: 'too_large', size: parsed.bytes.byteLength } }
    const sourceHash = hashBytes(parsed.bytes)
    return {
      ok: true,
      image: { data: toBase64(parsed.bytes), mimeType: parsed.mimeType, bytes: parsed.bytes.byteLength },
      sourceHash,
      kind: 'data',
    }
  }

  // raw base64 (no data: prefix): try decode; accept only if it yields a known image
  if (!trimmed.includes('/') && !trimmed.includes('\\')) {
    try {
      const bytes = new Uint8Array(Buffer.from(trimmed, 'base64'))
      const mime = sniffMime(bytes)
      if (bytes.byteLength > 0 && mime !== undefined && bytes.byteLength <= maxBytes) {
        return { ok: true, image: { data: toBase64(bytes), mimeType: mime, bytes: bytes.byteLength }, sourceHash: hashBytes(bytes), kind: 'base64' }
      }
    } catch {
      /* not base64 — fall through to file handling */
    }
  }

  // file path
  const expanded = trimmed.startsWith('~/') ? resolvePath(opts.cwd, trimmed) : trimmed
  const abs = isAbsolute(expanded) ? expanded : resolvePath(opts.cwd, expanded)
  if (!existsSync(abs)) return { ok: false, error: { code: 'not_found', path: input } }
  let st
  try {
    st = await stat(abs)
  } catch (error) {
    return { ok: false, error: { code: 'read_error', path: input, message: error instanceof Error ? error.message : String(error) } }
  }
  if (!st.isFile()) return { ok: false, error: { code: 'not_a_file', path: input } }
  if (st.size > maxBytes) return { ok: false, error: { code: 'too_large', path: input, size: st.size } }
  let raw: Buffer
  try {
    raw = await readFile(abs)
  } catch (error) {
    return { ok: false, error: { code: 'read_error', path: input, message: error instanceof Error ? error.message : String(error) } }
  }
  const bytes = new Uint8Array(raw)
  const mime = sniffMime(bytes)
  if (mime === undefined) {
    return { ok: false, error: { code: 'unsupported_format', path: input, message: 'supported: PNG, JPEG, GIF, WebP, BMP' } }
  }
  return { ok: true, image: { data: toBase64(bytes), mimeType: mime, bytes: bytes.byteLength }, sourceHash: hashBytes(bytes), kind: 'file', path: abs }
}

export interface CompressOptions {
  maxDimension: number
  jpegQuality: number
}

/** Resize to the max long-edge dimension and re-encode as JPEG at the given
 *  quality. Graceful: returns the original bytes when sharp is unavailable
 *  or decoding fails (pi-vision's degrade-gracefully contract). */
export async function compressImage(
  image: LoadedImage,
  options: CompressOptions,
): Promise<{ data: string; mimeType: SupportedMime; resized: boolean }> {
  try {
    const mod = (await import('sharp')) as { default?: unknown }
    const sharp = mod.default as unknown
    if (typeof sharp !== 'function') return { data: image.data, mimeType: image.mimeType, resized: false }
    interface SharpImage {
      metadata(): Promise<{ width?: number; height?: number }>
      resize(opts: { width: number; height: number; fit: string; withoutEnlargement: boolean }): SharpImage
      jpeg(opts: { quality: number }): SharpImage
      toBuffer(): Promise<Buffer>
    }
    const factory = sharp as (input: Buffer) => SharpImage
    const input = Buffer.from(image.data, 'base64')
    const meta = await factory(input).metadata()
    const width = meta.width ?? 0
    const height = meta.height ?? 0
    const longEdge = Math.max(width, height)
    if (longEdge === 0) return { data: image.data, mimeType: image.mimeType, resized: false }
    const scale = Math.min(1, options.maxDimension / longEdge)
    if (scale >= 1 && image.mimeType === 'image/jpeg') return { data: image.data, mimeType: image.mimeType, resized: false }
    const resized = await factory(input)
      .resize({ width: Math.round(width * scale), height: Math.round(height * scale), fit: 'fill', withoutEnlargement: true })
      .jpeg({ quality: options.jpegQuality })
      .toBuffer()
    const bytes = new Uint8Array(resized)
    return { data: toBase64(bytes), mimeType: 'image/jpeg', resized: true }
  } catch {
    return { data: image.data, mimeType: image.mimeType, resized: false }
  }
}
