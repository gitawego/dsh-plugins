/** [Image-#N] marker rendering, hint lines, and the structured batch result
 *  block — ports of pi-vision's lib/marker.ts surfaces.
 *
 *  MARKER RESOLUTION: models frequently pass the marker they SEE in the
 *  conversation ("Image-#1") as describe_image's image_path instead of the
 *  real path the paste hook replaced. MarkerRegistry bridges the two: the
 *  paste hook records marker -> real path per agent when it renders markers,
 *  and describe_image resolves [Image-#N] tokens back to the recorded path. */
import type { Agent } from '@deepseek-ai/dsh-agent'
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
 *  it as-is. When the HOST cannot deliver images natively (Termux attachment
 *  store EACCES — the reason is delivery, not model capability), the wording
 *  says so: describe_image still works there via the http transport. */
export function buildPasteHintLine(
  images: readonly { token: string; index: number }[],
  style: MarkerStyle = 'code',
  options: { deliveryUnavailable?: boolean } = {},
): string {
  const n = images.length
  if (n === 0) return '0 images referenced.'
  const reason = options.deliveryUnavailable
    ? 'native image delivery is unavailable on this host (attachment store cannot write)'
    : "the active model can't process images"
  const noun = n === 1 ? 'image' : 'images'
  const verb = n === 1 ? 'analyze it' : 'analyze them'
  const clause = n >= 2 ? ' with image_paths (pass all paths in one batch)' : ''
  const header = `[${n} ${noun} referenced — ${reason}; call describe_image to ${verb}${clause}]`
  if (n === 1) {
    return `${header}\nImage path: ${images[0]!.token}`
  }
  const pathLines = images.map((img) => `  ${img.token}`).join('\n')
  return `${header}\nImage paths:\n${pathLines}`
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
/** Per-agent map from canonical [Image-#N] markers to the real image paths
 *  the paste hook replaced (latest wins per marker name — the model usually
 *  refers to the most recently rendered markers). */
export class MarkerRegistry {
  private readonly agents = new Map<Agent, Map<string, string>>()

  /** Record marker → real path for one agent. */
  record(agent: Agent, marker: string, path: string): void {
    let map = this.agents.get(agent)
    if (map === undefined) {
      map = new Map()
      this.agents.set(agent, map)
    }
    map.set(marker, path)
  }

  /** Resolve a canonical marker name to the recorded real path. */
  resolve(agent: Agent, marker: string): string | undefined {
    return this.agents.get(agent)?.get(marker)
  }

  /** Drop one agent's mappings (agent/disposed). */
  detach(agent: Agent): void {
    this.agents.delete(agent)
  }
}

const MARKER_RE = /^Image-#(\d+)$/i

/** Normalize a model-passed token to a canonical marker name: strips bracket /
 *  backtick / bold decoration around [Image-#N]. Returns undefined when the
 *  token is not a marker — real paths pass through untouched. */
export function asImageMarker(token: string): string | undefined {
  const clean = token.trim().replace(/^\[|\]$/g, '').replace(/[*`]/g, '')
  const m = MARKER_RE.exec(clean)
  return m ? `Image-#${m[1]}` : undefined
}

/** Resolve [Image-#N] markers in a path list to the recorded real paths.
 *  Unknown markers pass through unchanged (the delegate then reports
 *  not_found, which is informative for a genuinely missing file). */
export function resolveMarkerPaths(
  paths: readonly string[],
  markers: MarkerRegistry,
  agent: Agent,
): string[] {
  return paths.map((p) => {
    const marker = asImageMarker(p)
    return marker === undefined ? p : (markers.resolve(agent, marker) ?? p)
  })
}
