/**
 * DSH conversation → ACP prompt projection.
 *
 * The harness sends the complete conversation on every model call. ACP
 * sessions are stateful, so the adapter keeps a cursor of message ids already
 * delivered to one `agy` session and sends only the new turn. The first call
 * replays the existing history as a role-labelled transcript.
 *
 * No DSH tool schemas are sent: `agy` owns its tools. A tool-role message can
 * therefore only appear if a previous route left one in the history; it is
 * rendered as text so the agent still sees the result.
 *
 * @module @gitawego/dsh-llm-agy/messages
 */
import type { ContentBlock, GenerateOptions, RequestMessage } from '@deepseek-ai/dsh-llm'

/** Text carried by one content-block list, excluding internal reasoning. */
export function contentText(content: readonly ContentBlock[]): string {
    const parts: string[] = []
    for (const block of content) {
        switch (block.type) {
            case 'text':
                parts.push(block.text)
                break
            case 'reasoning':
                // Reasoning is provider-private; do not replay it as user-visible history.
                break
            case 'image':
                parts.push(`[image: ${block.attachment.name ?? block.attachment.mediaType}]`)
                break
            case 'file':
                parts.push(`[file: ${block.attachment.name}]`)
                break
            case 'tool-call':
                parts.push(`[tool call ${block.name} ${block.arguments}]`)
                break
            case 'tool-addition':
            case 'tool-removal':
                // Tool-declaration history has no meaning to an agent that owns its tools.
                break
            default:
                break
        }
    }
    return parts.join('\n').trim()
}

/** The effective system prompt for one request. */
export function systemPromptOf(options: GenerateOptions): string | undefined {
    if (typeof options.system === 'string' && options.system.trim().length > 0) {
        return options.system.trim()
    }
    let latest: string | undefined
    for (const message of options.messages) {
        if (message.role !== 'system') continue
        const text = contentText(message.content)
        if (text.length > 0) latest = text
    }
    return latest
}

/** Render one conversation message as a labelled transcript line. */
export function renderMessage(message: RequestMessage): string {
    const text = contentText(message.content)
    if (message.role === 'user') return text.length > 0 ? `User: ${text}` : 'User: [empty message]'
    if (message.role === 'assistant') {
        return text.length > 0 ? `Assistant: ${text}` : 'Assistant: [no text]'
    }
    if (message.role === 'tool') {
        const label = message.isError === true ? 'Tool error' : 'Tool result'
        return text.length > 0 ? `${label}: ${text}` : `${label}: [no output]`
    }
    return text
}

/** Messages that carry conversation content (not system/developer scaffolding). */
export function conversationMessages(messages: readonly RequestMessage[]): RequestMessage[] {
    return messages.filter((message) => message.role !== 'system' && message.role !== 'developer')
}

/** Stable message ids, for the per-session delivery cursor. */
export function messageIds(messages: readonly RequestMessage[]): string[] {
    const ids: string[] = []
    for (const message of messages) {
        if ('id' in message && typeof message.id === 'string') ids.push(message.id)
    }
    return ids
}

/** One prompt ready for `session/prompt`, plus the ids it delivered. */
export interface BuiltPrompt {
    text: string
    deliveredIds: string[]
}

const FIRST_CALL_PREAMBLE =
    'The following is the conversation so far. Continue it by responding to the latest user message. Do not repeat the transcript.'

/**
 * Build the next ACP prompt from the harness history.
 * @param options - the exact model request.
 * @param delivered - message ids already delivered to this ACP session.
 * @returns prompt text and the ids this prompt delivers.
 */
export function buildPrompt(options: GenerateOptions, delivered: ReadonlySet<string>): BuiltPrompt {
    const conversation = conversationMessages(options.messages)
    const firstCall = delivered.size === 0
    const fresh = conversation.filter((message) => {
        // On later turns the agent already produced its own assistant message;
        // replaying DSH's copy would duplicate the answer.
        if (!firstCall && message.role === 'assistant') return false
        if (!('id' in message) || typeof message.id !== 'string') return true
        return !delivered.has(message.id)
    })
    const deliveredIds = messageIds(conversation)

    if (firstCall) {
        if (conversation.length === 0) return { text: 'Continue.', deliveredIds }
        if (conversation.length === 1) {
            return { text: renderMessage(conversation[0]!), deliveredIds }
        }
        return {
            text: `${FIRST_CALL_PREAMBLE}\n\n${conversation.map(renderMessage).join('\n\n')}`,
            deliveredIds,
        }
    }

    if (fresh.length === 0) return { text: 'Continue.', deliveredIds }
    if (fresh.length === 1 && fresh[0]?.role === 'user') {
        return { text: renderMessage(fresh[0]), deliveredIds }
    }
    return {
        text: `New messages since your last turn:\n\n${fresh.map(renderMessage).join('\n\n')}`,
        deliveredIds,
    }
}

/** A system-prompt change delivered mid-session, where ACP has no update slot. */
export function systemUpdateText(system: string): string {
    return `[Updated system instructions]\n${system}`
}
