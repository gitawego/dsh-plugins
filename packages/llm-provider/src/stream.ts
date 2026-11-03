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
import { dsmlHoldIndex, splitDsml, type DsmlToolCall } from './dsml.ts'

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
 * Map a terminal pi-ai event's assistant message onto a harness finish reason.
 * @param message - the assistant message carried by the `done` or `error` event.
 * @param contextWindow - exact model capacity, for usage-based overflow detection.
 * @returns the mapped reason. Recognized overflow text and pi-ai's own overflow
 *   detection map to `CONTEXT_WINDOW_EXCEEDED`; a completed response with no
 *   content maps to an `EMPTY_RESPONSE` error, because an empty history entry
 *   would silently stall the loop.
 */
export function mapStopReason(message: AssistantMessage, contextWindow: number): FinishReason {
    const overflow = isContextOverflow(message, contextWindow) ||
        (message.stopReason === 'error' && message.errorMessage !== undefined && isContextWindowExceededError(message.errorMessage))
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
 * Text blocks pass through a DSML holdback: a DeepSeek lane can leak a tool call
 * as markup inside `content`, and the leak only becomes recognizable once the
 * closing tag arrives. The tail that could still become the DSML token is
 * withheld from the delta stream, and at `text_end` a complete block is turned
 * into real tool-call blocks with a `tool-calls` finish — see `dsml.ts`. Text
 * that parses to nothing is emitted unchanged, so this is a recovery path and
 * never a rewrite of ordinary prose.
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
): AsyncGenerator<StreamChunk> {
    const toolIds = new Map<number, { id: string; name: string }>()
    /** Withheld text per text block, and what of that block already reached the caller. */
    const textBlocks = new Map<number, { held: string; emitted: string }>()
    /** Tool calls recovered from leaked markup, emitted once the stream ends. */
    const recovered: DsmlToolCall[] = []
    let lastIndex = -1
    for await (const event of events) {
        if ('contentIndex' in event) lastIndex = Math.max(lastIndex, event.contentIndex)
        switch (event.type) {
            case 'start':
                break
            case 'text_start':
                textBlocks.set(event.contentIndex, { held: '', emitted: '' })
                yield { type: 'block-start', index: event.contentIndex, blockType: 'text' }
                break
            case 'text_delta': {
                const block = textBlocks.get(event.contentIndex) ?? { held: '', emitted: '' }
                block.held += event.delta
                const cut = dsmlHoldIndex(block.held)
                if (cut > 0) {
                    const text = block.held.slice(0, cut)
                    block.held = block.held.slice(cut)
                    block.emitted += text
                    yield { type: 'text-delta', index: event.contentIndex, text }
                }
                textBlocks.set(event.contentIndex, block)
                break
            }
            case 'text_end': {
                const block = textBlocks.get(event.contentIndex) ?? { held: '', emitted: '' }
                // The held tail is the only place a DSML block can start, so it
                // is the only thing that has to be parsed.
                const split = splitDsml(block.held)
                if (split.calls.length === 0) {
                    if (block.held.length > 0) {
                        block.emitted += block.held
                        yield { type: 'text-delta', index: event.contentIndex, text: block.held }
                    }
                } else {
                    recovered.push(...split.calls)
                    if (split.text.length > 0) {
                        block.emitted += split.text
                        yield { type: 'text-delta', index: event.contentIndex, text: split.text }
                    }
                }
                textBlocks.delete(event.contentIndex)
                yield { type: 'block-end', index: event.contentIndex, block: { type: 'text', text: block.emitted } }
                break
            }
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
                yield* recoveredBlocks(recovered, lastIndex)
                yield { type: 'usage', usage: mapUsage(event.message.usage) }
                yield {
                    type: 'finish',
                    // Recovered calls are the reason the turn has work to do; the
                    // provider's own `stop` describes the leak, not the intent.
                    reason: recovered.length > 0 ? { kind: 'tool-calls' } : mapStopReason(event.message, contextWindow),
                }
                return
            case 'error':
                yield { type: 'usage', usage: mapUsage(event.error.usage) }
                yield {
                    type: 'finish',
                    reason: mapStopReason(
                        callerSignal?.aborted === true ? { ...event.error, stopReason: 'aborted' as const } : event.error,
                        contextWindow,
                    ),
                }
                return
        }
    }
    throw new LlmError('pi-ai event stream ended without done/error', 'STREAM_CLOSED')
}

/**
 * Monotonic suffix for synthesized call ids.
 *
 * A recovered call has no provider id — DSML carries none — and the harness
 * correlates each tool result with the id of the call that asked for it, so two
 * recovered calls must never share one. A counter is enough: ids are unique for
 * the process, and their shape is visibly not a provider's (`call_8d15…`).
 */
let recoveredCalls = 0

/**
 * Emit one complete tool-call block per recovered call.
 *
 * The blocks are numbered after the highest content index the provider used, so
 * a recovery can never collide with a block pi-ai itself described.
 * @param calls - calls parsed out of leaked markup.
 * @param start - highest content index seen in the stream; `-1` when none.
 * @returns the block-start / delta / block-end trio per call.
 */
function* recoveredBlocks(calls: readonly DsmlToolCall[], start: number): Generator<StreamChunk> {
    for (const [offset, call] of calls.entries()) {
        const index = start + 1 + offset
        recoveredCalls += 1
        const id = asToolCallId(`call_dsml_${recoveredCalls.toString(36)}`)
        const arguments_ = JSON.stringify(call.arguments)
        yield { type: 'block-start', index, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index, id, name: call.name, argumentsDelta: arguments_ }
        yield { type: 'block-end', index, block: { type: 'tool-call', id, name: call.name, arguments: arguments_ } }
    }
}
