/** [Image-#N] marker rendering, hint lines, and the structured batch result
 *  block — ports of pi-vision's lib/marker.ts surfaces. */
import type { MarkerStyle } from './config.ts'

export function renderMarker(n: number, style: MarkerStyle): string {
  const token = `Image-#${n}`
  switch (style) {
    case 'code': return '[' + '`' + token + '`' + ']'
    case 'bold': return '[**' + token + '**]'
    default: return '[' + token + ']'
  }
}

/** Replace image path tokens in a message with sequential markers (1-indexed),
 *  returning the rewritten text and the ordered paths they map to. */
export function renderMarkers(text: string, paths: readonly string[], style: MarkerStyle): string {
  let out = text
  paths.forEach((path, index) => {
    const token = renderMarker(index + 1, style)
    // Replace the FIRST occurrence of the literal path with its marker.
    const idx = out.indexOf(path)
    if (idx >= 0) out = out.slice(0, idx) + token + out.slice(idx + path.length)
  })
  return out
}

/** Zero-token hint appended on text-only primaries (paste mode "hint"):
 *  names the paths and the image_paths batch affordance (pi-vision v0.4.0). */
export function buildHintLine(paths: readonly string[], markerStyle: MarkerStyle): string {
  const quoted = paths.map((p) => `"${p}"`).join(', ')
  return [
    `[Image markers above reference ${paths.length} image file(s): ${quoted}]`,
    'The active model cannot process images natively. To analyze them, call describe_image',
    paths.length === 1
      ? 'with image_path (single image).'
      : `with image_paths (all ${paths.length} in one batch call).`,
  ].join(' ')
}

export type BatchImageOutcome =
  | { ok: true; text: string; cached: boolean; fallback: boolean }
  | { ok: false; errorCode: string; message: string }

/** Structured, order-stable batch result block ([Batch: N image(s)] ...). */
export function buildBatchToolResult(paths: readonly string[], results: readonly BatchImageOutcome[]): string {
  const lines: string[] = [`[Batch: ${paths.length} image(s)]`, '']
  paths.forEach((path, index) => {
    const result = results[index]
    lines.push(`[Image ${index + 1}] ${path}`)
    if (!result) {
      lines.push('[error: unexpected — no result for this image]')
    } else if (result.ok) {
      const tags = result.cached ? ' (cached)' : result.fallback ? ' (fallback)' : ''
      lines.push(result.text + tags)
    } else {
      lines.push(`[error: ${result.errorCode} — ${result.message}]`)
    }
    lines.push('')
  })
  return lines.join('\n').trimEnd()
}
