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
 *  - image BLOCKS (GUI/direct-API attachments) on text-only primaries are
 *    materialized to hash-named temp files (join(home,'tmp','dsh-vision'))
 *    and flow through the SAME pipeline: markers + hint (path nameable for
 *    describe_image) / auto-delegated descriptions. A raw image block never
 *    reaches a text-only model's request boundary.
 *
 *  KV-cache (SPEC §18): the hook adds text ONLY when a user message contains
 *  resolvable image path tokens. Ordinary messages keep a byte-identical
 *  request prefix; marker/hint/description text is a suffix of the user's own
 *  input, never a repeated prefix contribution. */
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock, UserMessage } from '@deepseek-ai/dsh-llm'
import { freezeMessage } from '@deepseek-ai/dsh-llm'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { isAbsolute, join as joinPath, resolve as resolvePath } from 'node:path'
import { mapWithConcurrency } from './batch.ts'
import { isConfiguredForDelegation, type PasteMode, type ResolvedVisionConfig } from './config.ts'
import type { DelegateParams, DelegateResult } from './delegate.ts'
import { loadImage, type SupportedMime } from './image.ts'
import { buildDescriptionsBlock, buildPasteHintLine, renderMarker, renderMarkersResolved, type MarkerRegistry } from './marker.ts'
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

/** Attachment read seam (ctx.attachments.readImage): fetch stored bytes for
 *  an image block so text-only primaries can convert it to text. */
export type ReadImage = (
  ref: ImageAttachmentRef,
  signal?: AbortSignal,
) => Promise<{ ref: ImageAttachmentRef; data: Uint8Array }>

const BLOCK_EXT: Partial<Record<ImageMediaType, string>> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
}

/** Write image-block bytes to a content-hash-named temp file under the
 *  plugin-owned tmp dir (Termux: DSH home, not the OS tmpdir). Returns the
 *  absolute path (a normal filepath the delegate pipeline and the
 *  describe_image hint can name), or undefined for unsupported media. */
export function writeBlockTempFile(tmpDir: string, data: Uint8Array, mediaType: ImageMediaType): string | undefined {
  const ext = BLOCK_EXT[mediaType]
  if (ext === undefined) return undefined
  const hash = createHash('sha256').update(data).digest('hex').slice(0, 24)
  mkdirSync(tmpDir, { recursive: true })
  const file = joinPath(tmpDir, hash + ext)
  if (!existsSync(file)) writeFileSync(file, data, { mode: 0o600 })
  return file
}

/** One delegation entry point for a specific agent workspace. */
export type PasteDelegate = (params: DelegateParams, signal: AbortSignal) => Promise<DelegateResult>

export interface PasteDeps {
  config: () => ResolvedVisionConfig
  /** Whether the given agent's primary model processes images natively. */
  isMultimodal: (agent: Agent) => boolean
  saveAttachment: SaveAttachment
  /** Read stored bytes for an image block (text-only conversion). */
  readImage: ReadImage
  /** Plugin-owned temp dir for materialized image blocks (join(home,'tmp','dsh-vision')). */
  tmpDir: string
  /** Per-agent marker → real-path registry, so describe_image can resolve the
   *  [Image-#N] markers the model sees back to the paths this hook replaced. */
  markers: MarkerRegistry
  /** Whether the harness can deliver images natively (attachment store can
   *  write). On Android/Termux it never can (durability walk EACCES at
   *  /data/data), so even a multimodal primary cannot receive an ImageBlock —
   *  the hook must fall back to delegation instead of dropping the image. */
  canDeliverImage: () => Promise<boolean>
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

/** Best-effort delete of materialized block temp files (auto mode: the
 *  description is embedded + cached, so the file is no longer needed; on
 *  full hint fallback the files are kept because the hint names them). */
function cleanupTempFiles(paths: readonly string[]): void {
  for (const p of paths) {
    try { unlinkSync(p) } catch { /* best-effort */ }
  }
}

/** One image block materialized to a temp-file path (or failed). */
interface BlockMaterialization {
  blockIndex: number
  /** Absolute temp-file path when the bytes were readable + writable. */
  path?: string
  failed?: boolean
  name?: string
}

/** Read every image block of a user message and materialize it to a
 *  content-hash-named temp file (text-only primaries only — multimodal keeps
 *  blocks native). Failures are recorded, never thrown. */
async function materializeImageBlocks(
  deps: PasteDeps,
  msg: UserMessage,
  signal: AbortSignal,
): Promise<BlockMaterialization[]> {
  const out: BlockMaterialization[] = []
  for (let i = 0; i < msg.content.length; i++) {
    const block = msg.content[i]
    if (block === undefined || block.type !== 'image') continue
    const ref = (block as { attachment: ImageAttachmentRef }).attachment
    try {
      const stored = await deps.readImage(ref, signal)
      const file = writeBlockTempFile(deps.tmpDir, stored.data, ref.mediaType)
      if (file === undefined) out.push({ blockIndex: i, failed: true, name: ref.name })
      else out.push({ blockIndex: i, path: file })
    } catch {
      out.push({ blockIndex: i, failed: true, name: ref.name })
    }
  }
  return out
}

/** Rewrite one user message: markers (+ attachments / hint / descriptions).
 *  Image BLOCKS on text-only primaries are materialized to temp-file paths
 *  and flow through the same pipeline; a raw image block never reaches a
 *  text-only model's request boundary. Returns undefined when untouched. */
async function transformMessage(
  deps: PasteDeps,
  agent: Agent,
  config: ResolvedVisionConfig,
  msg: UserMessage,
  workspace: string,
  signal: AbortSignal,
  multimodal: boolean,
  mode: PasteMode,
  /** Extra explanatory line prepended to auto-delegated output (e.g. why the
   *  image was described although the primary is multimodal). */
  note?: string,
): Promise<UserMessage | undefined> {
  const textBlocks = msg.content.filter((b): b is { type: 'text'; text: string } => b.type === 'text')
  const imageBlockCount = msg.content.filter((b) => b.type === 'image').length
  if (textBlocks.length === 0 && imageBlockCount === 0) return undefined
  const text = textBlocks.map((b) => b.text).join('\n')
  const pathTokens = findImagePathTokens(text)

  // Text-only primaries: materialize image blocks to temp files so markers /
  // hint / auto-delegation handle them like pasted path tokens. Multimodal
  // primaries keep the blocks untouched (native passthrough).
  const blockMaterializations = !multimodal && imageBlockCount > 0
    ? await materializeImageBlocks(deps, msg, signal)
    : []
  const blockTokens = blockMaterializations.filter((m) => m.path !== undefined).map((m) => m.path as string)

  const tokens = [...pathTokens, ...blockTokens]
  const existingImageCount = imageBlockCount
  const loaded = await loadAndDedup(tokens, workspace)
  if (loaded.length === 0 && blockMaterializations.length === 0) return undefined
  const resolved = buildResolvedMap(tokens, loaded, existingImageCount, multimodal)
  // Bridge to describe_image: remember marker → real path per agent so the
  // model can pass the [Image-#N] it sees instead of the path.
  for (const img of loaded) {
    const idx = resolved.get(img.token)?.index
    if (idx !== undefined) deps.markers.record(agent, `Image-#${idx + 1}`, img.token)
  }
  const rewritten = renderMarkersResolved(text, pathTokens, resolved, config.markerStyle)
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

  // Rebuild content: collapsed rewritten text first, then every non-text
  // block in original order — image blocks become marker text blocks (or a
  // note when the bytes could not be read). Raw image blocks never reach the
  // model's request boundary on a text-only primary.
  const markerByIndex = new Map<number, string>()
  for (const m of blockMaterializations) {
    if (m.path !== undefined) {
      markerByIndex.set(m.blockIndex, renderMarker((resolved.get(m.path)?.index ?? 0) + 1, config.markerStyle))
    } else {
      markerByIndex.set(m.blockIndex, `[Image: ${m.name ?? 'attachment'} (unreadable — the active model cannot process images)]`)
    }
  }
  const body: ContentBlock[] = []
  for (let i = 0; i < msg.content.length; i++) {
    const block = msg.content[i]!
    if (block.type === 'text') continue
    if (block.type === 'image') {
      const marker = markerByIndex.get(i)
      if (marker !== undefined) body.push({ type: 'text', text: marker })
      continue
    }
    body.push(block)
  }

  if (mode === 'off') {
    return freezeMessage({ ...msg, content: [{ type: 'text', text: rewritten }, ...body] })
  }
  if (mode === 'hint') {
    return freezeMessage({ ...msg, content: [{ type: 'text', text: rewritten + '\n' + hint }, ...body] })
  }

  // mode === 'auto': short-circuit when every delegation would be refused.
  if (config.localOnly || !isConfiguredForDelegation(config)) {
    return freezeMessage({ ...msg, content: [{ type: 'text', text: rewritten + '\n' + hint }, ...body] })
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
    return freezeMessage({ ...msg, content: [{ type: 'text', text: rewritten + '\n' + hint }, ...body] })
  }
  // Auto mode: descriptions are embedded (and cached), so the materialized
  // block temp files are no longer needed — best-effort remove them.
  cleanupTempFiles(blockTokens)
  const visionModel = config.provider && config.model ? `${config.provider}/${config.model}` : '(unconfigured)'
  const block = buildDescriptionsBlock(descriptions, visionModel, config.markerStyle)
  const prefix = note === undefined ? '' : '\n[' + note + ']\n'
  return freezeMessage({ ...msg, content: [{ type: 'text', text: rewritten + prefix + block }, ...body] })
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
  // Native delivery may be impossible (Termux attachment-store EACCES). A
  // multimodal primary then has NO way to receive the image natively and
  // describe_image is hidden for it — hint/off would dead-end. Force auto so
  // the image is never silently dropped; a note explains why.
  const nativeDelivery = multimodal ? await deps.canDeliverImage() : false
  const undeliverable = multimodal && !nativeDelivery
  const mode: PasteMode = !config.enabled
    ? 'off'
    : undeliverable
      ? 'auto'
      : config.textOnlyPasteMode
  const note = undeliverable
    ? 'native image delivery is unavailable on this host (Termux attachment store cannot write) — image analyzed via the configured vision model'
    : undefined
  const out: UserMessage[] = []
  let changed = false
  for (const msg of messages) {
    if (msg.source.kind !== 'user') {
      out.push(msg)
      continue
    }
    const transformed = await transformMessage(deps, agent, config, msg, workspace, signal, multimodal && nativeDelivery, mode, note)
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

