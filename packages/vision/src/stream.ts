/** Request-boundary image routing for HAND-BUILT llm/stream calls
 *  (compaction, session-title, …). Loop-built agent requests are marked
 *  (markAgentLoopRequest) and are READ-ONLY by contract — the reconstructability
 *  invariant — so this converter never touches them; the paste hook owns that
 *  surface at agent/pre-step. Hand-built calls are not logged message content,
 *  so a listener may return a REPLACEMENT request: image blocks are converted
 *  to cached text descriptions through the vision pipeline when the target
 *  model is text-only, so e.g. compaction does not fail on history that
 *  contains native ImageBlocks from an earlier multimodal primary.
 *
 *  The description is embedded as "[image: <description>]" text (cache-friendly,
 *  deterministic) and the original session messages are never modified — only
 *  the ephemeral request payload changes. */
import type { ContentBlock, GenerateOptions, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import { isAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { DelegateParams, DelegateResult } from './delegate.ts'
import { writeBlockTempFile } from './paste.ts'

export type StreamImageDelegate = (params: DelegateParams, signal: AbortSignal) => Promise<DelegateResult>

export interface StreamConverterDeps {
  /** True when the target model accepts image input; undefined when unknown.
   *  Only a KNOWN text-only target triggers conversion (safe default). */
  resolveModelImageCapable: (provider: string, model: string) => Promise<boolean | undefined>
  readImage: (ref: ImageAttachmentRef, signal?: AbortSignal) => Promise<{ ref: ImageAttachmentRef; data: Uint8Array }>
  tmpDir: string
  /** Workspace for a session id (drives delegation cwd + relative paths). */
  workspaceFor: (sessionId: string | undefined) => string | undefined
  /** Vision-delegation entry point for one workspace (shared pipeline). */
  delegateFor: (workspace: string) => StreamImageDelegate
  /** Prompt used for auto conversion (vision.autoDelegatePrompt). */
  prompt: string
  /** Re-enter the llm stream with a replaced request (no-image → pass-through). */
  stream: (options: GenerateOptions) => AsyncIterable<StreamChunk>
  logger?: { warn: (message: string, ...args: unknown[]) => void }
}

function contentHasImageBlocks(content: readonly ContentBlock[] | undefined): boolean {
  return (content ?? []).some((b) => b.type === 'image')
}

function messagesHaveImages(messages: readonly Message[]): boolean {
  return messages.some((m) => contentHasImageBlocks(m.content))
}

/** Convert one message's image blocks to "[image: …]" text blocks. Returns the
 *  new message, or undefined when nothing changed. Never throws. */
async function convertMessage(
  deps: StreamConverterDeps,
  message: Message,
  delegate: StreamImageDelegate,
  signal: AbortSignal,
): Promise<Message | undefined> {
  if (!contentHasImageBlocks(message.content)) return undefined
  const newContent: ContentBlock[] = []
  const tempFiles: string[] = []
  try {
    for (const block of message.content) {
      if (block.type !== 'image') {
        newContent.push(block)
        continue
      }
      const ref = (block as { attachment: ImageAttachmentRef }).attachment
      let text: string
      try {
        const stored = await deps.readImage(ref, signal)
        const file = writeBlockTempFile(deps.tmpDir, stored.data, ref.mediaType)
        if (file === undefined) {
          text = '[image: unsupported media type]'
        } else {
          tempFiles.push(file)
          const result = await delegate({ image_path: file, prompt: deps.prompt, compress: true, reasoning: 'off' }, signal)
          text = result.ok ? `[image: ${result.text}]` : `[image: description failed (${result.error.code})]`
        }
      } catch {
        text = '[image: could not be read]'
      }
      newContent.push({ type: 'text', text })
    }
  } finally {
    for (const file of tempFiles) {
      try {
        const fs = await import('node:fs')
        fs.unlinkSync(file)
      } catch { /* best-effort */ }
    }
  }
  return { ...message, content: newContent }
}

/** llm/stream waterfall listener: convert image blocks to text descriptions
 *  for hand-built requests targeting a known text-only model. */
export function createStreamImageConverter(deps: StreamConverterDeps) {
  return async function* (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> {
    // Loop-built agent requests are deep-frozen and read-only by contract.
    if (isAgentLoopRequest(options) || !messagesHaveImages(options.messages)) {
      yield* next()
      return
    }
    let imageCapable: boolean | undefined
    try {
      imageCapable = await deps.resolveModelImageCapable(options.provider, options.model)
    } catch {
      imageCapable = undefined
    }
    // Multimodal targets read the blocks natively; unknown capability → leave.
    if (imageCapable !== false) {
      yield* next()
      return
    }
    const workspace = deps.workspaceFor(options.sessionId)
    if (workspace === undefined) {
      deps.logger?.warn('dsh-vision: cannot resolve workspace for image conversion — leaving blocks as-is')
      yield* next()
      return
    }
    const delegate = deps.delegateFor(workspace)
    const signal = options.signal ?? new AbortController().signal
    const converted: Message[] = []
    let changed = false
    for (const message of options.messages) {
      const nextMessage = await convertMessage(deps, message, delegate, signal)
      if (nextMessage === undefined) converted.push(message)
      else {
        converted.push(nextMessage)
        changed = true
      }
    }
    if (!changed) {
      yield* next()
      return
    }
    deps.logger?.warn('dsh-vision: converted image blocks to text for text-only model %s/%s (purpose=%s)', options.provider, options.model, options.purpose ?? 'stream')
    yield* deps.stream({ ...options, messages: converted })
  }
}
