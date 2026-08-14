/** M2 — paste UX (SPEC-3 port). An agent/pre-step waterfall listener that
 *  turns image file-path tokens in user messages into the same capability-aware
 *  surface pi-vision's input hook provides:
 *
 *  - multimodal primary: [Image-#N] markers + native ImageBlock attachments
 *    (the model sees the images; delegation is structurally impossible)
 *  - text-only primary, textOnlyPasteMode "hint" (default): markers + a hint
 *    line naming the paths and nudging describe_image — zero tokens of
 *    model-facing instruction
 *  - text-only primary, "auto": markers + auto-delegated descriptions through
 *    the shared cache/retry/fallback pipeline (bounded concurrency, batch
 *    timeout, hint fallback)
 *  - text-only primary, "off": markers only
 *
 *  KV-cache (SPEC §18): the hook adds text ONLY when a user message contains
 *  resolvable image path tokens. Ordinary messages keep a byte-identical
 *  request prefix; marker/hint/description text is a suffix of the user's own
 *  input, never a repeated prefix contribution. */
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock, UserMessage } from '@deepseek-ai/dsh-llm'
import { freezeMessage } from '@deepseek-ai/dsh-llm'
import { existsSync, statSync } from 'node:fs'
import { isAbsolute, resolve as resolvePath } from 'node:path'
import { mapWithConcurrency } from './batch.ts'
import { isConfiguredForDelegation, type PasteMode, type ResolvedVisionConfig } from './config.ts'
import type { DelegateParams, DelegateResult } from './delegate.ts'
import { loadImage, type SupportedMime } from './image.ts'
import { buildDescriptionsBlock, buildPasteHintLine, renderMarkersResolved } from './marker.ts'
import { resolveInputPath } from './paths.ts'

// Path-like tokens ending in a known image extension (pi-vision F8 port):
//   POSIX: absolute /…, home ~/…, relative ./…/…/
//   Windows: drive paths C:\…, C:/…, D:\…, D:/…
// Allows \ (escaped space) — what terminal drag-and-drop produces for paths
// with spaces. Bare filenames without a path separator are deliberately not
// matched (no false positives on ordinary words). URLs can match but are
// filtered later by the existsSync check.
const PATH_TOKEN_RE = /(?:[A-Za-z]:[\\/]|\/|~\/|\.{1,2}\/)(?:\\ |[^\s)"'<>])+\.(?:png|jpe?g|gif|webp|bmp)/gi

/** Extract candidate image file-path tokens from free text (deduped, order
 *  preserved). Port of pi-vision's findImagePathTokens. */
export function findImagePathTokens(text: string): string[] {
  const out: string[] = []
  PATH_TOKEN_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = PATH_TOKEN_RE.exec(text)) !== null) {
    out.push(m[0])
  }
  return [...new Set(out)]
}

/** Resolve a token against cwd; return the absolute path when it is a real
 *  file, else undefined. Unescapes \ (escaped spaces from terminal
 *  drag-and-drop) before resolving. */
function resolveImageFile(token: string, cwd: string): string | undefined {
  const unescaped = token.replace(/\\ /g, ' ')
  const expanded = unescaped.startsWith('~/') ? resolvePath(cwd, unescaped) : unescaped
  const abs0 = isAbsolute(expanded) ? expanded : resolvePath(cwd, expanded)
  // Android/Termux: translate shared-storage spellings to the accessible path.
  const abs = resolveInputPath(abs0)
  if (!existsSync(abs)) return undefined
  try {
    if (!statSync(abs).isFile()) return undefined
  } catch {
    return undefined
  }
  return abs
}

/** One image loaded for the paste hook, ready to attach or delegate. */
export interface PasteImage {
  token: string
  abs: string
  /** base64-encoded original bytes (dedup + attachment use ORIGINAL bytes;
   *  delegation compresses on its own miss path). */
  data: string
  mimeType: SupportedMime
  hash: string
}

/** Load + path-dedup all resolvable tokens. */
async function loadAndDedup(tokens: readonly string[], cwd: string): Promise<PasteImage[]> {
  const loaded: PasteImage[] = []
  const seen = new Set<string>()
  for (const token of tokens) {
    const abs = resolveImageFile(token, cwd)
    if (abs === undefined || seen.has(abs)) continue
    seen.add(abs)
    const result = await loadImage(abs, { cwd })
    if (!result.ok) continue // unreadable/unsupported → skip, token stays as-is
    loaded.push({ token, abs, data: result.image.data, mimeType: result.image.mimeType, hash: result.sourceHash })
  }
  return loaded
}

/** Marker index map: multimodal primaries count new images AFTER existing
 *  image blocks in the message (markers are positional); text-only primaries
 *  number new images sequentially (nothing is attached). */
function buildResolvedMap(
  tokens: readonly string[],
  loaded: readonly PasteImage[],
  existingImageCount: number,
  multimodal: boolean,
): Map<string, { index: number }> {
  const resolved = new Map<string, { index: number }>()
  let idx = 0
  for (const token of tokens) {
    if (loaded.find((l) => l.token === token) === undefined) continue
    resolved.set(token, { index: multimodal ? existingImageCount + idx : idx })
    idx++
  }
  return resolved
}

/** Attachment seam (ctx.attachments.saveImage) so tests inject a fake. */
export type SaveAttachment = (input: { data: Uint8Array; mediaType: ImageMediaType; name?: string }) => Promise<ImageAttachmentRef>

/** One delegation entry point for a specific agent workspace. */
export type PasteDelegate = (params: DelegateParams, signal: AbortSignal) => Promise<DelegateResult>

export interface PasteDeps {
  config: () => ResolvedVisionConfig
  /** Whether the given agent's primary model processes images natively. */
  isMultimodal: (agent: Agent) => boolean
  saveAttachment: SaveAttachment
  /** Build the delegation entry point for one agent's workspace. */
  delegateFor: (workspace: string) => PasteDelegate
  logger?: { warn: (message: string, ...args: unknown[]) => void }
}

const ATTACHABLE_MIME: readonly string[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

/** Save one pasted image as a durable attachment; BMP (loaded but not
 *  attachable) and storage failures are skipped, keeping the marker. */
async function saveAttachmentSafe(deps: PasteDeps, img: PasteImage): Promise<ImageAttachmentRef | undefined> {
  if (!ATTACHABLE_MIME.includes(img.mimeType)) return undefined
  try {
    return await deps.saveAttachment({
      data: Buffer.from(img.data, 'base64'),
      mediaType: img.mimeType as ImageMediaType,
      name: 'pasted-image',
    })
  } catch {
    return undefined // attachment limits etc. — the marker still names the path
  }
}

/** Auto-delegate one image with the shared batch signal; failures and
 *  timeouts return undefined so the caller can fall back to the hint. */
async function autoDelegateOne(
  delegate: PasteDelegate,
  config: ResolvedVisionConfig,
  img: PasteImage,
  signal: AbortSignal,
): Promise<{ text: string; cached: boolean } | undefined> {
  try {
    const result = await delegate(
      { image_path: img.abs, prompt: config.autoDelegatePrompt, compress: true, reasoning: 'off' },
      signal,
    )
    return result.ok ? { text: result.text, cached: result.details.cached } : undefined
  } catch {
    return undefined
  }
}

/** Rewrite one user message: markers (+ attachments / hint / descriptions).
 *  Returns undefined when the message is untouched. */
async function transformMessage(
  deps: PasteDeps,
  config: ResolvedVisionConfig,
  msg: UserMessage,
  workspace: string,
  signal: AbortSignal,
  multimodal: boolean,
  mode: PasteMode,
): Promise<UserMessage | undefined> {
  const textBlocks = msg.content.filter((b): b is { type: 'text'; text: string } => b.type === 'text')
  if (textBlocks.length === 0) return undefined
  const text = textBlocks.map((b) => b.text).join('\n')
  const tokens = findImagePathTokens(text)
  if (tokens.length === 0) return undefined
  const existingImageCount = msg.content.filter((b) => b.type === 'image').length
  const loaded = await loadAndDedup(tokens, workspace)
  if (loaded.length === 0) return undefined
  const resolved = buildResolvedMap(tokens, loaded, existingImageCount, multimodal)
  const rewritten = renderMarkersResolved(text, tokens, resolved, config.markerStyle)
  const nonText = msg.content.filter((b) => b.type !== 'text')

  // ── MULTIMODAL: attach images natively (markers reference positions) ──
  if (multimodal) {
    const imageBlocks: ContentBlock[] = []
    for (const img of loaded) {
      const ref = await saveAttachmentSafe(deps, img)
      if (ref !== undefined) imageBlocks.push({ type: 'image', attachment: ref })
    }
    return freezeMessage({ ...msg, content: [{ type: 'text', text: rewritten }, ...nonText, ...imageBlocks] })
  }

  // ── TEXT-ONLY: markers + branch on paste mode ──
  const hintImages = loaded.map((l) => ({ token: l.token, index: resolved.get(l.token)?.index ?? 0 }))
  const hint = buildPasteHintLine(hintImages)
  if (mode === 'off') {
    return freezeMessage({ ...msg, content: [{ type: 'text', text: rewritten }, ...nonText] })
  }
  if (mode === 'hint') {
    return freezeMessage({ ...msg, content: [{ type: 'text', text: rewritten + '\n' + hint }, ...nonText] })
  }

  // mode === 'auto': short-circuit when every delegation would be refused.
  if (config.localOnly || !isConfiguredForDelegation(config)) {
    return freezeMessage({ ...msg, content: [{ type: 'text', text: rewritten + '\n' + hint }, ...nonText] })
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.autoDelegateTimeoutMs)
  const combined = AbortSignal.any([signal, controller.signal])
  let results: Array<{ text: string; cached: boolean } | undefined>
  try {
    const delegate = deps.delegateFor(workspace)
    results = await mapWithConcurrency(loaded, config.batchConcurrency, (img) => autoDelegateOne(delegate, config, img, combined), combined)
  } finally {
    clearTimeout(timer)
  }

  const descriptions: Array<{ token: string; index: number; text: string; cached: boolean }> = []
  let ok = 0
  for (let i = 0; i < loaded.length; i++) {
    const r = results[i]
    if (r !== undefined) {
      descriptions.push({ token: loaded[i]!.token, index: resolved.get(loaded[i]!.token)?.index ?? i, text: r.text, cached: r.cached })
      ok++
    }
  }
  if (ok === 0) {
    // All failed/timed out → hint fallback (paths intact for describe_image).
    return freezeMessage({ ...msg, content: [{ type: 'text', text: rewritten + '\n' + hint }, ...nonText] })
  }
  const visionModel = config.provider && config.model ? `${config.provider}/${config.model}` : '(unconfigured)'
  const block = buildDescriptionsBlock(descriptions, visionModel, config.markerStyle)
  return freezeMessage({ ...msg, content: [{ type: 'text', text: rewritten + block }, ...nonText] })
}

/** Transform the enter-batch: rewrite user messages, leave everything else
 *  untouched. Returns undefined when nothing changed. */
async function transformBatch(
  deps: PasteDeps,
  agent: Agent,
  messages: readonly UserMessage[],
  signal: AbortSignal,
): Promise<UserMessage[] | undefined> {
  const config = deps.config()
  const multimodal = deps.isMultimodal(agent)
  const workspace = agent.session.header.cwd ?? process.cwd()
  const mode: PasteMode = config.enabled ? config.textOnlyPasteMode : 'off'
  const out: UserMessage[] = []
  let changed = false
  for (const msg of messages) {
    if (msg.source.kind !== 'user') {
      out.push(msg)
      continue
    }
    const transformed = await transformMessage(deps, config, msg, workspace, signal, multimodal, mode)
    if (transformed === undefined) out.push(msg)
    else {
      out.push(transformed)
      changed = true
    }
  }
  return changed ? out : undefined
}

/** Payload shape of the agent/pre-step waterfall (structural subset). */
export interface PreStepPayload {
  agent: Agent
  messages: UserMessage[]
  turn: number
  step: number
  signal: AbortSignal
}

/** The M2 hook: an agent/pre-step waterfall listener. Register with
 *  ctx.on('agent/pre-step', createPasteHook(deps)). Never throws — a paste
 *  failure must not break the user's step. */
export function createPasteHook(deps: PasteDeps) {
  return async (payload: PreStepPayload, next: () => Promise<PreStepDecision>): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    try {
      const transformed = await transformBatch(deps, payload.agent, decision.messages, payload.signal)
      return transformed === undefined ? decision : { kind: 'enter', messages: transformed }
    } catch (error) {
      deps.logger?.warn('dsh-vision: paste hook failed, leaving messages unchanged: %s', error instanceof Error ? error.message : String(error))
      return decision
    }
  }
}

