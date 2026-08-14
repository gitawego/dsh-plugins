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

/** ── Paste-UX surfaces (M2, pi-vision SPEC-3 port) ───────────────────────── */

/** Replace path tokens with `[Image-#N]` markers using a resolved token→index
 *  map (0-based index; markers are 1-based). Unresolvable tokens are left
 *  as-is. Replacement runs in one right-to-left pass so earlier indices are
 *  not shifted; when two tokens overlap at the same position the longer
 *  match wins. */
export function renderMarkersResolved(
  text: string,
  tokens: readonly string[],
  resolved: ReadonlyMap<string, { index: number }>,
  style: MarkerStyle,
): string {
  type Replacement = { start: number; end: number; marker: string }
  const replacements: Replacement[] = []
  for (const token of tokens) {
    const info = resolved.get(token)
    if (info === undefined) continue
    const marker = renderMarker(info.index + 1, style)
    let searchFrom = 0
    while (searchFrom <= text.length) {
      const pos = text.indexOf(token, searchFrom)
      if (pos === -1) break
      replacements.push({ start: pos, end: pos + token.length, marker })
      searchFrom = pos + token.length
    }
  }
  if (replacements.length === 0) return text
  replacements.sort((a, b) => b.start - a.start || b.end - a.end)
  const accepted: Replacement[] = []
  let lastStart = Infinity
  for (const r of replacements) {
    if (r.end <= lastStart) {
      accepted.push(r)
      lastStart = r.start
    }
  }
  let result = text
  for (const r of accepted) result = result.slice(0, r.start) + r.marker + result.slice(r.end)
  return result
}

/** Hint line for text-only primaries (paste mode "hint"): names the image
 *  paths so the model can call describe_image, and the image_paths batch
 *  affordance for N ≥ 2 (pi-vision SPEC-3 §3.4). Plain text — the model reads
 *  it as-is. */
export function buildPasteHintLine(images: readonly { token: string; index: number }[]): string {
  const n = images.length
  if (n === 0) return '0 images referenced.'
  const noun = n === 1 ? 'image' : 'images'
  const verb = n === 1 ? 'analyze it' : 'analyze them'
  const clause = n >= 2 ? ' (single, or pass all paths to image_paths for batch analysis)' : ''
  const pathLines = images.map((img) => `  ${img.token}`).join('\n')
  return [
    `${n} ${noun} referenced. The active model cannot process images natively — use the describe_image tool to ${verb}${clause}.`,
    'Image paths:',
    pathLines,
  ].join('\n')
}

/** Descriptions block appended in text-only paste mode "auto": one labeled
 *  line per image plus a cost-aware footer naming the vision model. */
export function buildDescriptionsBlock(
  descriptions: readonly { token: string; index: number; text: string; cached: boolean }[],
  visionModel: string,
  style: MarkerStyle = 'code',
): string {
  if (descriptions.length === 0) return ''
  const lines = descriptions.map((d) => {
    const label = renderMarker(d.index + 1, style)
    const cachedTag = d.cached ? ' (cached)' : ''
    return `[${label} ${d.token}]: ${d.text}${cachedTag}`
  })
  const footer = `[${descriptions.length} image(s) auto-described via ${visionModel}. Set textOnlyPasteMode to "hint" to delegate on-demand instead.]`
  return `\n\n${lines.join('\n')}\n${footer}`
}

