/**
 * pi-ai assistant events → harness `StreamChunk` values.
 *
 * pi-ai never throws mid-stream: after `start`, failures arrive as a terminal
 * `error` event carrying the failing assistant message. The harness protocol
 * allows both styles, so this module converts terminal events into the
 * terminal `usage` + `finish` pair and keeps the failure's machine code from
 * pi-ai's message text.
 *
 * @module @gitawego/dsh-llm-provider/stream
 */
import {
    CONTEXT_WINDOW_EXCEEDED_CODE,
    EMPTY_RESPONSE_CODE,
    isContextWindowExceededError,
    isQuotaExceededError,
    LlmError,
    QUOTA_EXCEEDED_CODE,
    type FinishReason,
    type StreamChunk,
    type TokenUsage,
    type ToolCallId,
} from '@deepseek-ai/dsh-llm'
import { isContextOverflow, type AssistantMessage, type AssistantMessageEvent, type Usage } from '@earendil-works/pi-ai'

/**
 * Brand a provider tool-call id as the harness's `ToolCallId`.
 *
 * Deliberately a cast rather than `brandString<ToolCallId>` from
 * `@deepseek-ai/dsh-brand`: the brand is a `unique symbol`, and a plugin that
 * devDepends on its own copy of that package can end up with two distinct
 * declarations of the same-named symbol, which no amount of matching versions
 * makes interchangeable. A cast states exactly what is true here — the string
 * came from the provider and only the harness's nominal type is missing.
 * @param value - provider-issued call id.
 * @returns the same string under the harness's nominal type.
 */
const asToolCallId = (value: string): ToolCallId => value as unknown as ToolCallId

/**
 * Map pi-ai usage (reasoning folded into output by pi-ai) onto harness counts.
 * @param usage - cumulative usage from the terminal pi-ai event.
 * @returns harness counts with pi-ai's exact total; cache fields appear only
 *   when non-zero because pi-ai reports zeros, not absence.
 */
export function mapUsage(usage: Usage): TokenUsage {
    return {
        inputTokens: usage.input,
        outputTokens: usage.output,
        totalTokens: usage.totalTokens,
        ...(usage.cacheRead > 0 ? { cacheReadTokens: usage.cacheRead } : {}),
        ...(usage.cacheWrite > 0 ? { cacheWriteTokens: usage.cacheWrite } : {}),
        ...(usage.reasoning !== undefined && usage.reasoning > 0 ? { reasoningTokens: usage.reasoning } : {}),
    }
}

/**
 * Classify a pi-ai failure message into a stable harness code.
 *
 * pi-ai surfaces provider failures as text, so the mapping is textual by
 * necessity. Order matters: an explicit context-overflow phrase is checked
 * before the generic 400 arm, because an overflowing request is also an
 * invalid one and the loop's compaction policy keys on the specific code.
 * @param message - pi-ai's failure text.
 * @returns a stable code; unknown text keeps `PI_AI_ERROR`.
 */
export function classifyPiAiError(message: string): string {
    if (isContextWindowExceededError(message)) return CONTEXT_WINDOW_EXCEEDED_CODE
    if (isQuotaExceededError(message)) return QUOTA_EXCEEDED_CODE
    if (/\b(?:401|403)\b/.test(message)) return 'AUTH'
    if (/\b429\b|rate.?limit/i.test(message)) return 'RATE_LIMIT'
    if (/\b413\b|payload too large|request body too large|length limit exceeded/i.test(message)) return 'INVALID_REQUEST'
    if (/\b400\b|invalid.?request/i.test(message)) return 'INVALID_REQUEST'
    if (/\b5\d\d\b/.test(message)) return 'SERVER'
    if (/\btime(?:d)?\s*out\b|timeout/i.test(message)) return 'TIMEOUT'
    if (/stream ended (?:before|without)\b/i.test(message)) return 'TRANSPORT'
    if (
        /\b(?:network|connection|socket|fetch)\b|\bECONN[A-Z]+\b/i.test(message) ||
        /\b(?:other side closed|HTTP2 request did not get a response|WebSocket closed unexpectedly)\b/i.test(message) ||
        /\bterminated\b|premature close/i.test(message)
    ) {
        return 'TRANSPORT'
    }
    return 'PI_AI_ERROR'
}

/**
 * The prefix of a model's own tool-call control token at the start of a reply.
 *
 * DeepSeek (and its relatives) emit tool calls in a native template —
 * `<｜DSML｜ calls>` … `<｜DSML｜ invoke name="bash">`, with **one** U+FF5C
 * fullwidth bar on each side of `DSML` (read from a real leaked reply; an
 * earlier attempt here matched two bars and therefore never fired) — that the
 * serving stack
 * converts into structured `tool_calls`. When that conversion does not happen,
 * the template arrives as ordinary text: the turn looks completed, no tool runs,
 * and the transcript records markup. Nothing in the harness or pi-ai emits or
 * parses this syntax (verified: no occurrence in either package), so decoding it
 * here would be a workaround for an upstream fault rather than a fix.
 *
 * Anchored at the start on purpose: a model *discussing* the markup quotes it
 * inside prose, while a leaked call is the whole reply.
 */
const TOOL_TEMPLATE_PREFIX = /^\s*<[\s|｜]*(?:DSML|DSLM)[\s|｜]*/i

/**
 * Whether one reply is entirely the model's own tool-call control syntax.
 * @param text - the reply's text content.
 * @returns true when the reply begins with a tool-call control token.
 */
export function looksLikeToolTemplate(text: string): boolean {
    return TOOL_TEMPLATE_PREFIX.test(text)
}

/**
 * Map a terminal pi-ai event's assistant message onto a harness finish reason.
 * @param message - the assistant message carried by the `done` or `error` event.
 * @param contextWindow - exact model capacity, for usage-based overflow detection.
 * @param toolsOffered - whether the request declared tools; leaked tool-call
 *   syntax is only a defect on a request that offered tools.
 * @returns the mapped reason. Recognized overflow text and pi-ai's own overflow
 *   detection map to `CONTEXT_WINDOW_EXCEEDED`; a completed response with no
 *   content maps to an `EMPTY_RESPONSE` error, because an empty history entry
 *   would silently stall the loop; a reply that is the model's raw tool-call
 *   template maps to a retryable `SERVER` failure — the fault is upstream, and
 *   it must not be recorded as a completed turn.
 */
export function mapStopReason(message: AssistantMessage, contextWindow: number, toolsOffered = false): FinishReason {
    const overflow = isContextOverflow(message, contextWindow) ||
        (message.stopReason === 'error' && message.errorMessage !== undefined && isContextWindowExceededError(message.errorMessage))
    if (toolsOffered && message.stopReason === 'stop' && !message.content.some((piece) => piece.type === 'toolCall')) {
        const text = message.content
            .map((piece) => (piece.type === 'text' ? piece.text : ''))
            .join('')
        if (looksLikeToolTemplate(text)) {
            return {
                kind: 'error',
                failure: {
                    message: 'the provider returned the model\'s native tool-call syntax as text instead of a tool call; the upstream skipped its tool-call parsing',
                    code: 'SERVER',
                },
            }
        }
    }
    if (overflow) {
        return {
            kind: 'error',
            failure: {
                message: message.errorMessage ?? `pi-ai detected context overflow for model "${message.model}"`,
                code: CONTEXT_WINDOW_EXCEEDED_CODE,
            },
        }
    }
    switch (message.stopReason) {
        case 'stop':
            if (message.content.length === 0) {
                return {
                    kind: 'error',
                    failure: {
                        message: `model "${message.model}" returned a completed response with no content`,
                        code: EMPTY_RESPONSE_CODE,
                    },
                }
            }
            return { kind: 'stop' }
        case 'length':
            return { kind: 'max-tokens' }
        case 'toolUse':
            return { kind: 'tool-calls' }
        case 'pending':
            return { kind: 'error', failure: { message: `pi-ai stream for model "${message.model}" ended pending`, code: 'PI_AI_ERROR' } }
        case 'deferred':
            return {
                kind: 'error',
                failure: { message: `pi-ai deferred response for model "${message.model}" is not supported`, code: 'PI_AI_ERROR' },
            }
        case 'aborted':
            return { kind: 'aborted', failure: { message: message.errorMessage ?? 'pi-ai stream aborted', code: 'ABORTED' } }
        case 'error': {
            const text = message.errorMessage ?? 'pi-ai stream error'
            return { kind: 'error', failure: { message: text, code: classifyPiAiError(text) } }
        }
    }
}

/**
 * Translate one pi-ai event stream into harness chunks.
 *
 * Tool-call ids are only known once pi-ai's partial message carries the call, so
 * the first delta for a block records the id and every later delta reuses it —
 * the harness correlates a delta stream by that id.
 *
 * Text streams straight through. A lane that leaks a tool call as markup is
 * *detected* at the terminal event and failed as a retryable server fault (see
 * {@link looksLikeToolTemplate}) — it is never parsed: the markup is the
 * model's native template, the conversion belongs to the serving stack, and a
 * client-side decoder would invent call ids while hiding the upstream fault.
 * @param events - one assistant turn's pi-ai event stream.
 * @param contextWindow - exact model capacity for overflow detection.
 * @param callerSignal - caller cancellation; an aborted caller turns an
 *   in-band terminal error into an aborted finish.
 * @returns harness chunks ending with `usage` then `finish`.
 * @throws {LlmError} `STREAM_CLOSED` when the source ends without a terminal event.
 */
export async function* toStreamChunks(
    events: AsyncIterable<AssistantMessageEvent>,
    contextWindow: number,
    callerSignal?: AbortSignal,
    toolsOffered = false,
): AsyncGenerator<StreamChunk> {
    const toolIds = new Map<number, { id: string; name: string }>()
    for await (const event of events) {
        switch (event.type) {
            case 'start':
                break
            case 'text_start':
                yield { type: 'block-start', index: event.contentIndex, blockType: 'text' }
                break
            case 'text_delta':
                yield { type: 'text-delta', index: event.contentIndex, text: event.delta }
                break
            case 'text_end':
                yield { type: 'block-end', index: event.contentIndex, block: { type: 'text', text: event.content } }
                break
            case 'thinking_start':
                yield { type: 'block-start', index: event.contentIndex, blockType: 'reasoning' }
                break
            case 'thinking_delta':
                yield { type: 'reasoning-delta', index: event.contentIndex, text: event.delta }
                break
            case 'thinking_end':
                yield { type: 'block-end', index: event.contentIndex, block: { type: 'reasoning', text: event.content } }
                break
            case 'toolcall_start': {
                const partial = event.partial.content[event.contentIndex]
                toolIds.set(event.contentIndex, {
                    id: partial?.type === 'toolCall' ? partial.id : '',
                    name: partial?.type === 'toolCall' ? partial.name : '',
                })
                yield { type: 'block-start', index: event.contentIndex, blockType: 'tool-call' }
                break
            }
            case 'toolcall_delta': {
                const known = toolIds.get(event.contentIndex)
                yield {
                    type: 'tool-call-delta',
                    index: event.contentIndex,
                    id: asToolCallId(known?.id ?? ''),
                    ...(known !== undefined && known.name.length > 0 ? { name: known.name } : {}),
                    argumentsDelta: event.delta,
                }
                break
            }
            case 'toolcall_end':
                yield {
                    type: 'block-end',
                    index: event.contentIndex,
                    block: {
                        type: 'tool-call',
                        id: asToolCallId(event.toolCall.id),
                        name: event.toolCall.name,
                        arguments: JSON.stringify(event.toolCall.arguments),
                    },
                }
                break
            case 'done':
                yield { type: 'usage', usage: mapUsage(event.message.usage) }
                yield { type: 'finish', reason: mapStopReason(event.message, contextWindow, toolsOffered) }
                return
            case 'error':
                yield { type: 'usage', usage: mapUsage(event.error.usage) }
                yield {
                    type: 'finish',
                    reason: mapStopReason(
                        callerSignal?.aborted === true ? { ...event.error, stopReason: 'aborted' as const } : event.error,
                        contextWindow,
                        toolsOffered,
                    ),
                }
                return
        }
    }
    throw new LlmError('pi-ai event stream ended without done/error', 'STREAM_CLOSED')
}
