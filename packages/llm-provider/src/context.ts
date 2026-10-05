/**
 * Harness → pi-ai request conversion.
 *
 * The harness request vocabulary (messages, content blocks, tool schemas) is
 * provider-neutral; pi-ai expects its own `Context`. Everything in this module
 * is one direction only, and it is deliberately the *provider-neutral* path:
 * the adapter keeps no replay state, so an assistant message is rebuilt from
 * durable content exactly as `dsh-llm-pi-ai` rebuilds one produced by a foreign
 * adapter. Reasoning therefore travels as unsigned thinking, which pi-ai's
 * Anthropic converter downgrades to text rather than sending an unsigned block
 * the API would reject.
 *
 * Images are the one place the conversion needs a service: the durable
 * `ImageBlock` references are projected to request bytes through the attachment
 * store, under the route's pixel/byte policy, with the harness's deterministic
 * oldest-first offload applied at the aggregate budget.
 *
 * @module @gitawego/dsh-llm-provider/context
 */
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import {
    contentHasImage,
    LlmError,
    offloadedImageText,
    offloadRequestImagesWithPolicy,
    requestImageHandleText,
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
 * Flatten text recursively inside one tool result — a nested tool result can
 * carry the only prose a parent result has.
 * @param blocks - tool-result content blocks.
 * @returns the concatenated text.
 */
export function toolResultText(blocks: readonly ContentBlock[]): string {
    return blocks
        .map((block) => {
            if (block.type === 'text') return block.text
            if (block.type === 'tool-result') return toolResultText(block.content)
            return ''
        })
        .join('')
}

/**
 * Reject image occurrences pi-ai cannot represent in history. Assistant-role
 * images have no wire form pi-ai can replay, so they fail here rather than
 * silently disappearing from the request.
 * @param messages - request history.
 */
export function assertSupportedImageRoles(messages: readonly Message[]): void {
    for (const message of messages) {
        if (message.role !== 'user' && contentHasImage(message.content)) {
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
    messages: readonly Message[]
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
 * Rebuild one assistant history message from durable content, without replay
 * metadata.
 * @param message - a harness assistant message.
 * @returns the pi-ai assistant message.
 */
export function foreignAssistant(message: Message): PiAssistantMessage {
    const source = message.source.kind === 'model' ? message.source : undefined
    const content: PiAssistantMessage['content'] = []
    for (const block of message.content) {
        switch (block.type) {
            case 'text':
                content.push({ type: 'text', text: block.text })
                break
            case 'reasoning':
                content.push({ type: 'thinking', thinking: block.text })
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
        // Provider-neutral provenance: the history came from the durable log,
        // not from a pi-ai response this process still holds replay data for.
        api: 'dsh-foreign' as PiAssistantMessage['api'],
        provider: source?.provider ?? 'dsh-foreign',
        model: source?.model ?? 'dsh-foreign',
        usage: emptyPiUsage(),
        stopReason: content.some((piece) => piece.type === 'toolCall') ? 'toolUse' : 'stop',
        timestamp: 0,
    }
}

/** Track tool names by call id so a tool result can name its tool. */
function appendAssistant(message: Message, messages: PiMessage[], toolNames: Map<string, string>): void {
    const assistant = foreignAssistant(message)
    for (const block of assistant.content) {
        if (block.type === 'toolCall') toolNames.set(block.id, block.name)
    }
    messages.push(assistant)
}

/**
 * Convert a request with no image occurrences.
 * @param options - the assembled request.
 * @returns the pi-ai context.
 */
export function textOnlyContext(options: GenerateOptions): PiContext {
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
            appendAssistant(message, messages, toolNames)
            continue
        }
        const text = flattenText(message.content)
        const results = message.content.filter((block) => block.type === 'tool-result')
        if (text.length > 0 || results.length === 0) {
            messages.push({ role: 'user', content: text, timestamp: 0 })
        }
        for (const result of results) {
            messages.push({
                role: 'toolResult',
                toolCallId: result.toolCallId,
                toolName: toolNames.get(result.toolCallId) ?? 'unknown',
                content: [{ type: 'text', text: toolResultText(result.content) || '(no output)' }],
                isError: result.isError ?? false,
                timestamp: 0,
            })
        }
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

/** Every image reference reachable from one content list, keyed by attachment id. */
function collectImageRefs(content: readonly ContentBlock[], refs: Map<string, ImageAttachmentRef>): void {
    for (const block of content) {
        if (block.type === 'image') refs.set(block.attachment.attachmentId, block.attachment)
        else if (block.type === 'tool-result') collectImageRefs(block.content, refs)
    }
}

/**
 * Build one user-side content list, projecting each image to its request bytes
 * plus the deterministic handle text the harness also shows the model.
 * @param content - harness content blocks.
 * @param requestImages - request versions by attachment id.
 * @returns a plain string when the result is text-only, otherwise pi-ai content.
 */
async function userContent(
    content: readonly ContentBlock[],
    requestImages: ReadonlyMap<string, Awaited<ReturnType<AttachmentStore['readImageRequest']>>>,
): Promise<string | { type: 'text'; text: string }[] | ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[]> {
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
            case 'tool-result': {
                const nested = await userContent(block.content, requestImages)
                if (typeof nested === 'string') {
                    if (nested.length > 0) projected.push({ type: 'text', text: nested })
                } else projected.push(...nested)
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
 * @param options - the assembled request.
 * @param conversion - attachment store, profile budgets, and cancellation.
 * @returns the pi-ai context.
 */
export async function imagesContext(options: GenerateOptions, conversion: ImageConversion): Promise<PiContext> {
    const { attachments, profile } = conversion
    const requestImagePolicy = { maxPixels: profile.requestImagePixelBudget, maxBytes: profile.requestImageMaxBytes }
    assertSupportedImageRoles(options.messages)
    const split = splitSystemPrompt(options)

    // First projection: the harness's own deterministic budget decision, made
    // with the *normalized* byte size the durable reference already knows. This
    // is what makes offload reproducible from the log alone.
    const requestMessages = offloadRequestImagesWithPolicy(split.messages, {
        representation: 'base64',
        maxBytes: profile.maxRequestImageBytes,
        byteQuantum: 1,
        byteLength: (ref) => Math.min(ref.bytes, requestImagePolicy.maxBytes),
        placeholder: (ref) => offloadedImageText(ref),
    })

    const refs = new Map<string, ImageAttachmentRef>()
    for (const message of requestMessages) collectImageRefs(message.content, refs)
    const ordered = [...refs.values()]
    const prepared = await Promise.all(ordered.map((ref) => attachments.readImageRequest(ref, requestImagePolicy, conversion.signal)))
    const requestImages = new Map(ordered.map((ref, index) => [ref.attachmentId, prepared[index]!]))

    // Second projection: same decision, now priced with the exact encoded
    // length each retained image will occupy after base64 expansion.
    const exactMessages = offloadRequestImagesWithPolicy(requestMessages, {
        representation: 'base64',
        maxBytes: profile.maxRequestImageBytes,
        byteQuantum: 1,
        byteLength: (ref) => requestImages.get(ref.attachmentId)?.bytes ?? Math.min(ref.bytes, requestImagePolicy.maxBytes),
        placeholder: (ref) => offloadedImageText(ref),
    })

    const toolNames = new Map<string, string>()
    const messages: PiMessage[] = []
    for (const message of exactMessages) {
        if (message.role === 'system') {
            messages.push({ role: 'user', content: flattenText(message.content), timestamp: 0 })
            continue
        }
        if (message.role === 'assistant') {
            appendAssistant(message, messages, toolNames)
            continue
        }
        const inline = message.content.filter((block) => block.type !== 'tool-result')
        const content = await userContent(inline, requestImages)
        const results = message.content.filter((block) => block.type === 'tool-result')
        if (content.length > 0 || results.length === 0) {
            messages.push({ role: 'user', content, timestamp: 0 })
        }
        for (const result of results) {
            const resultContent = await userContent(result.content, requestImages)
            messages.push({
                role: 'toolResult',
                toolCallId: result.toolCallId,
                toolName: toolNames.get(result.toolCallId) ?? 'unknown',
                content: typeof resultContent === 'string' ? [{ type: 'text', text: resultContent || '(no output)' }] : resultContent,
                isError: result.isError ?? false,
                timestamp: 0,
            })
        }
    }
    return piContext(split.systemPrompt, options, messages)
}

/**
 * Convert one assembled harness request into a pi-ai context, choosing the text
 * or image path from the request itself.
 * @param options - the assembled request.
 * @param hasImage - whether the request carries any image occurrence.
 * @param images - image conversion inputs; required when `hasImage` is true.
 * @returns the pi-ai context.
 */
export async function toPiContext(
    options: GenerateOptions,
    hasImage: boolean,
    images?: ImageConversion,
): Promise<PiContext> {
    if (!hasImage) return textOnlyContext(options)
    if (images === undefined) {
        throw new LlmError('llm-provider image conversion requires the durable attachment service', 'UNSUPPORTED_CONTENT')
    }
    return imagesContext(options, images)
}
