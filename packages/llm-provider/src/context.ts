/**
 * Harness → pi-ai request conversion.
 *
 * The harness request vocabulary is provider-neutral; pi-ai expects its own
 * `Context`. Everything here is one direction only, and deliberately the
 * *durable* path: the adapter keeps no replay state, so an assistant message is
 * rebuilt from durable content. Provenance decides what pi-ai does with the
 * reasoning — history this route produced is replayed as the same model's own
 * (DeepSeek's thinking mode requires it back verbatim), while history from
 * anywhere else stays provider-neutral and degrades to text.
 *
 * DSH 0.2 changed two things this module owns:
 *
 * - a tool result is a first-class `role: 'tool'` message, not a content block
 *   inside a user message;
 * - image offloading is the *surface's* decision (`ImageBlock.offloaded`). A
 *   route no longer removes occurrences itself: it prices what remains and
 *   fails with `IMAGE_OFFLOAD_REQUIRED` when the retained set is over budget.
 *
 * @module @gitawego/dsh-llm-provider/context
 */
import type { AttachmentStore, ImageAttachmentRef, ImageRequestTarget } from '@deepseek-ai/dsh-attachment'
import {
    contentHasImage,
    IMAGE_OFFLOAD_REQUIRED_CODE,
    LlmError,
    offloadedImageText,
    projectOffloadedImages,
    requestImageHandleText,
    requiredImageOffload,
    type ContentBlock,
    type GenerateOptions,
    type Message,
} from '@deepseek-ai/dsh-llm'
import type {
    AssistantMessage as PiAssistantMessage,
    Context as PiContext,
    Message as PiMessage,
    Tool as PiTool,
} from '@earendil-works/pi-ai'
import { requestImageDimensions } from '@deepseek-ai/dsh-attachment'
import type { GatewayProfile } from './config.ts'

/** Zeroed pi-ai usage for a reconstructed history message. */
export function emptyPiUsage(): PiAssistantMessage['usage'] {
    return {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    }
}

/**
 * Parse a raw tool-argument JSON string.
 *
 * A malformed argument string is a durable-log fact (a cancelled stream can
 * persist a partial call), not a request-stopping error: pi-ai needs an object,
 * and an empty one keeps the tool name and id replayable.
 * @param raw - raw JSON text from the durable tool-call block.
 * @returns the parsed object, or an empty object when unparseable.
 */
export function parseArguments(raw: string): Record<string, unknown> {
    try {
        const parsed: unknown = JSON.parse(raw)
        return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : {}
    } catch {
        return {}
    }
}

/**
 * Concatenate the visible text of one content list.
 * @param content - harness content blocks.
 * @returns the text of every `text` block, in order.
 */
export function flattenText(content: readonly ContentBlock[]): string {
    return content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('')
}

/**
 * Reject image occurrences pi-ai cannot represent in history. Assistant-role
 * images have no wire form pi-ai can replay, so they fail here rather than
 * silently disappearing from the request.
 * @param messages - request history.
 */
export function assertSupportedImageRoles(messages: GenerateOptions['messages']): void {
    for (const message of messages) {
        if (message.role !== 'user' && message.role !== 'tool' && contentHasImage(message.content)) {
            throw new LlmError(
                `pi-ai cannot represent an image in an in-history ${message.role} message`,
                'UNSUPPORTED_CONTENT',
            )
        }
    }
}

/**
 * Select the system prompt for one request and the messages that remain.
 *
 * `GenerateOptions.system` (a one-shot caller's prompt) wins when present; a
 * loop-built request leaves it undefined and carries a leading `system` message
 * instead, which folds into the prompt and drops out of the history.
 * @param options - the assembled request.
 * @returns the system prompt when one applies, plus the remaining messages.
 */
export function splitSystemPrompt(options: GenerateOptions): {
    systemPrompt: string | undefined
    messages: GenerateOptions['messages']
} {
    if (options.system !== undefined) return { systemPrompt: options.system, messages: options.messages }
    const [first, ...rest] = options.messages
    if (first?.role !== 'system') return { systemPrompt: undefined, messages: options.messages }
    const text = flattenText(first.content)
    return { systemPrompt: text.length > 0 ? text : undefined, messages: rest }
}

/**
 * Map harness tool schemas onto pi-ai tools.
 * @param options - the assembled request.
 * @returns pi-ai tools, or undefined when the request declares none.
 */
export function toolsOf(options: GenerateOptions): PiTool[] | undefined {
    if (options.tools === undefined || options.tools.length === 0) return undefined
    return options.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters as PiTool['parameters'],
    }))
}

/** Assemble the request envelope shared by both conversion paths. */
function piContext(systemPrompt: string | undefined, options: GenerateOptions, messages: PiMessage[]): PiContext {
    const tools = toolsOf(options)
    return {
        ...(systemPrompt !== undefined ? { systemPrompt } : {}),
        messages,
        ...(tools !== undefined ? { tools } : {}),
    }
}

/**
 * The wire field a provider wants replayed reasoning under.
 *
 * pi-ai's OpenAI-completions serializer echoes a thinking block only when the
 * block names a field that vocabulary knows; without one it emits an empty
 * `reasoning_content`, which DeepSeek's thinking mode rejects once the request
 * carries tools.
 */
export type ReplayedReasoning = 'reasoning_content'

/**
 * How this request's own history is replayed to pi-ai.
 *
 * pi-ai treats an assistant message whose `api`/`provider`/`model` disagree with
 * the model being called as *foreign*: `transformMessages` downgrades its
 * thinking to plain text, on the assumption that another vendor's reasoning is
 * not this model's reasoning. That is right for history this route did not
 * produce, and wrong for the log it did — DeepSeek's thinking mode requires
 * those turns back as `reasoning_content`, and prose in `content` is not it.
 */
export interface ReplayContract {
    /** Wire protocol this request dispatches with. */
    api: string
    /** Route key the durable history was produced on. */
    provider: string
    /** Model id the durable history was produced by. */
    model: string
    /** Wire field to echo replayed reasoning under, when the provider requires it. */
    reasoning?: ReplayedReasoning
}

/**
 * Rebuild one assistant history message from durable content.
 *
 * Wire identity is stamped only when the durable source *is* the model being
 * called and that model requires its reasoning replayed. Every other message
 * keeps the provider-neutral `dsh-foreign` provenance, which is what makes pi-ai
 * downgrade another vendor's thinking to text rather than sending it as this
 * model's own.
 * @param message - a harness assistant message.
 * @param replay - this request's replay contract, when the route replays reasoning.
 * @returns the pi-ai assistant message.
 */
export function foreignAssistant(message: Message, replay?: ReplayContract): PiAssistantMessage {
    const source = message.source.kind === 'model' ? message.source : undefined
    const reasoning = replay?.reasoning
    const sameModel =
        replay !== undefined &&
        reasoning !== undefined &&
        source !== undefined &&
        source.provider === replay.provider &&
        source.model === replay.model
    const content: PiAssistantMessage['content'] = []
    for (const block of message.content) {
        switch (block.type) {
            case 'text':
                content.push({ type: 'text', text: block.text })
                break
            case 'reasoning':
                content.push({
                    type: 'thinking',
                    thinking: block.text,
                    ...(sameModel && reasoning !== undefined ? { thinkingSignature: reasoning } : {}),
                })
                break
            case 'tool-call':
                content.push({
                    type: 'toolCall',
                    id: block.id,
                    name: block.name,
                    arguments: parseArguments(block.arguments),
                })
                break
            case 'image':
                throw new LlmError('pi-ai chat history cannot represent structured assistant image output', 'UNSUPPORTED_CONTENT')
            default:
                break
        }
    }
    return {
        role: 'assistant',
        content,
        // Same-model provenance is what keeps the reasoning on the wire; every
        // other message stays provider-neutral on purpose.
        api: (sameModel && replay !== undefined ? replay.api : 'dsh-foreign') as PiAssistantMessage['api'],
        provider: sameModel && replay !== undefined ? replay.provider : (source?.provider ?? 'dsh-foreign'),
        model: sameModel && replay !== undefined ? replay.model : (source?.model ?? 'dsh-foreign'),
        usage: emptyPiUsage(),
        stopReason: content.some((piece) => piece.type === 'toolCall') ? 'toolUse' : 'stop',
        timestamp: 0,
    }
}

/** Track tool names by call id so a tool result can name its tool. */
function appendAssistant(
    message: Message,
    messages: PiMessage[],
    toolNames: Map<string, string>,
    replay?: ReplayContract,
): void {
    const assistant = foreignAssistant(message, replay)
    for (const block of assistant.content) {
        if (block.type === 'toolCall') toolNames.set(block.id, block.name)
    }
    messages.push(assistant)
}

/** Rebuild the pi-ai toolResult message for one harness tool-role message. */
function appendToolResult(
    message: Message & { role: 'tool' },
    messages: PiMessage[],
    toolNames: Map<string, string>,
    content: string,
): void {
    messages.push({
        role: 'toolResult',
        toolCallId: message.toolCallId,
        toolName: toolNames.get(message.toolCallId) ?? 'unknown',
        content: [{ type: 'text', text: content || '(no output)' }],
        isError: message.isError ?? false,
        timestamp: 0,
    })
}

/**
 * Convert a request with no image occurrences.
 * @param options - the assembled request.
 * @param replay - this request's replay contract, when the route replays reasoning.
 * @returns the pi-ai context.
 */
export function textOnlyContext(options: GenerateOptions, replay?: ReplayContract): PiContext {
    assertSupportedImageRoles(options.messages)
    const split = splitSystemPrompt(options)
    const toolNames = new Map<string, string>()
    const messages: PiMessage[] = []
    for (const message of split.messages) {
        if (contentHasImage(message.content)) {
            throw new LlmError('llm-provider image conversion requires the durable attachment service', 'UNSUPPORTED_CONTENT')
        }
        if (message.role === 'system') {
            // A mid-history system message has no pi-ai slot: it becomes user
            // text so the model still reads it, in position.
            messages.push({ role: 'user', content: flattenText(message.content), timestamp: 0 })
            continue
        }
        if (message.role === 'assistant') {
            appendAssistant(message, messages, toolNames, replay)
            continue
        }
        if (message.role === 'tool') {
            appendToolResult(message, messages, toolNames, flattenText(message.content))
            continue
        }
        messages.push({ role: 'user', content: flattenText(message.content), timestamp: 0 })
    }
    return piContext(split.systemPrompt, options, messages)
}

/** Request-image state one conversion needs. */
export interface ImageConversion {
    /** Durable attachment store projecting images to request bytes. */
    attachments: AttachmentStore
    /** Route profile supplying the pixel and byte budgets. */
    profile: GatewayProfile
    /** Caller cancellation, forwarded to the attachment store. */
    signal?: AbortSignal
}

/** Every retained image reference reachable from one content list, keyed by attachment id. */
function collectImageRefs(content: readonly ContentBlock[], refs: Map<string, ImageAttachmentRef>): void {
    for (const block of content) {
        if (block.type === 'image' && block.offloaded !== true) refs.set(block.attachment.attachmentId, block.attachment)
    }
}

/** The request target for one source under the route's pixel and byte budgets. */
function imageTarget(ref: ImageAttachmentRef, budget: { maxPixels: number; maxBytes: number }): ImageRequestTarget {
    return { ...requestImageDimensions(ref.width, ref.height, budget.maxPixels), maxBytes: budget.maxBytes }
}

/**
 * Build one user-side content list, projecting each retained image to its
 * request bytes plus the deterministic handle text the harness also shows the
 * model.
 * @param content - harness content blocks.
 * @param requestImages - request versions by attachment id.
 * @returns a plain string when the result is text-only, otherwise pi-ai content.
 */
function userContent(
    content: readonly ContentBlock[],
    requestImages: ReadonlyMap<string, Awaited<ReturnType<AttachmentStore['readImageRequest']>>>,
): string | ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[] {
    const projected: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[] = []
    for (const block of content) {
        switch (block.type) {
            case 'text':
                if (block.text.length > 0) projected.push({ type: 'text', text: block.text })
                break
            case 'image': {
                const version = requestImages.get(block.attachment.attachmentId)
                if (version === undefined) {
                    projected.push({ type: 'text', text: offloadedImageText(block.attachment) })
                    break
                }
                projected.push({ type: 'text', text: requestImageHandleText(block.attachment, version) })
                projected.push({ type: 'image', data: Buffer.from(version.data).toString('base64'), mimeType: version.mediaType })
                break
            }
            default:
                break
        }
    }
    if (projected.every((block) => block.type === 'text')) {
        return projected.map((block) => (block as { type: 'text'; text: string }).text).join('')
    }
    return projected
}

/**
 * Convert a request that contains image occurrences.
 *
 * The offload decision is the surface's, carried on each block as
 * `offloaded`. What this route does is price the retained set and refuse the
 * request when it still exceeds the profile's aggregate byte budget, naming how
 * many more occurrences must be offloaded — the same contract
 * `dsh-llm-pi-ai` follows.
 * @param options - the assembled request.
 * @param conversion - attachment store, profile budgets, and cancellation.
 * @param replay - this request's replay contract, when the route replays reasoning.
 * @returns the pi-ai context.
 */
export async function imagesContext(
    options: GenerateOptions,
    conversion: ImageConversion,
    replay?: ReplayContract,
): Promise<PiContext> {
    const { attachments, profile } = conversion
    const policy = { maxPixels: profile.requestImagePixelBudget, maxBytes: profile.requestImageMaxBytes }
    assertSupportedImageRoles(options.messages)
    const split = splitSystemPrompt(options)

    const refs = new Map<string, ImageAttachmentRef>()
    for (const message of split.messages) collectImageRefs(message.content, refs)
    const ordered = [...refs.values()]
    const prepared = await Promise.all(ordered.map((ref) => attachments.readImageRequest(ref, imageTarget(ref, policy), conversion.signal)))
    const requestImages = new Map(ordered.map((ref, index) => [ref.attachmentId, prepared[index]!]))

    const more = requiredImageOffload(
        split.messages,
        { representation: 'base64', maxBytes: profile.maxRequestImageBytes, byteQuantum: 1 },
        (block) => requestImages.get(block.attachment.attachmentId)?.bytes ?? 0,
    )
    if (more > 0) {
        throw new LlmError(
            `llm-provider request images exceed the ${profile.maxRequestImageBytes}-byte base64 bound; ${more} more oldest occurrence(s) must be offloaded.`,
            IMAGE_OFFLOAD_REQUIRED_CODE,
            { offloadImages: more },
        )
    }

    const exactMessages = projectOffloadedImages(split.messages, (ref) => offloadedImageText(ref))
    const toolNames = new Map<string, string>()
    const messages: PiMessage[] = []
    for (const message of exactMessages) {
        if (message.role === 'system') {
            messages.push({ role: 'user', content: flattenText(message.content), timestamp: 0 })
            continue
        }
        if (message.role === 'assistant') {
            appendAssistant(message, messages, toolNames, replay)
            continue
        }
        if (message.role === 'tool') {
            messages.push({
                role: 'toolResult',
                toolCallId: message.toolCallId,
                toolName: toolNames.get(message.toolCallId) ?? 'unknown',
                content: [{ type: 'text', text: flattenText(message.content) || '(no output)' }],
                isError: message.isError ?? false,
                timestamp: 0,
            })
            continue
        }
        messages.push({ role: 'user', content: userContent(message.content, requestImages), timestamp: 0 })
    }
    return piContext(split.systemPrompt, options, messages)
}

/**
 * Convert one assembled harness request into a pi-ai context, choosing the text
 * or image path from the request itself.
 * @param options - the assembled request.
 * @param hasImage - whether the request carries any image occurrence.
 * @param images - image conversion inputs; required when `hasImage` is true.
 * @param replay - this request's replay contract, when the route replays reasoning.
 * @returns the pi-ai context.
 */
export async function toPiContext(
    options: GenerateOptions,
    hasImage: boolean,
    images?: ImageConversion,
    replay?: ReplayContract,
): Promise<PiContext> {
    if (!hasImage) return textOnlyContext(options, replay)
    if (images === undefined) {
        throw new LlmError('llm-provider image conversion requires the durable attachment service', 'UNSUPPORTED_CONTENT')
    }
    return imagesContext(options, images, replay)
}
