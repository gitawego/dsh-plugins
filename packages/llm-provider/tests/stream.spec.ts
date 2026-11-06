import { describe, expect, it } from 'vitest'
import type { AssistantMessage, AssistantMessageEvent, Usage } from '@earendil-works/pi-ai'
import { classifyPiAiError, mapStopReason, mapUsage, toStreamChunks } from '../src/stream.ts'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'

const usage = (over: Partial<Usage> = {}): Usage => ({
    input: 10,
    output: 4,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 14,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    ...over,
})

function assistant(over: Partial<AssistantMessage> = {}): AssistantMessage {
    return {
        role: 'assistant',
        content: [{ type: 'text', text: 'hi' }],
        api: 'openai-completions',
        provider: 'opencode-go',
        model: 'deepseek-v4.1-flash',
        usage: usage(),
        stopReason: 'stop',
        timestamp: 0,
        ...over,
    }
}

async function collect(events: AssistantMessageEvent[], contextWindow = 1000, signal?: AbortSignal, toolsOffered = false): Promise<StreamChunk[]> {
    const chunks: StreamChunk[] = []
    async function* source(): AsyncIterable<AssistantMessageEvent> {
        for (const event of events) yield event
    }
    for await (const chunk of toStreamChunks(source(), contextWindow, signal, toolsOffered)) chunks.push(chunk)
    return chunks
}

describe('mapUsage', () => {
    it('reports pi-ai counts and omits zero cache fields', () => {
        expect(mapUsage(usage())).toEqual({ inputTokens: 10, outputTokens: 4, totalTokens: 14 })
    })

    it('surfaces cache and reasoning counts when the provider reports them', () => {
        expect(mapUsage(usage({ cacheRead: 7, cacheWrite: 3, reasoning: 2 }))).toEqual({
            inputTokens: 10,
            outputTokens: 4,
            totalTokens: 14,
            cacheReadTokens: 7,
            cacheWriteTokens: 3,
            reasoningTokens: 2,
        })
    })
})

describe('classifyPiAiError', () => {
    it('uses the harness codes for the failures the loop routes on', () => {
        expect(classifyPiAiError('prompt is too long: context length exceeded')).toBe('CONTEXT_WINDOW_EXCEEDED')
        expect(classifyPiAiError('insufficient_quota: your credit balance is too low')).toBe('QUOTA')
        expect(classifyPiAiError('401 Unauthorized')).toBe('AUTH')
        expect(classifyPiAiError('429 rate limit reached')).toBe('RATE_LIMIT')
        expect(classifyPiAiError('503 Service Unavailable')).toBe('SERVER')
        expect(classifyPiAiError('request timeout after 300000ms')).toBe('TIMEOUT')
        expect(classifyPiAiError('fetch failed: other side closed')).toBe('TRANSPORT')
    })

    it('classifies the MissingSessionID refusal as a request problem, not a transport one', () => {
        expect(classifyPiAiError('400 {"type":"MissingSessionID"}')).toBe('INVALID_REQUEST')
    })

    it('keeps an unrecognized message on the adapter-specific code', () => {
        expect(classifyPiAiError('something entirely novel')).toBe('PI_AI_ERROR')
    })
})

describe('mapStopReason', () => {
    it('maps the completed reasons', () => {
        expect(mapStopReason(assistant(), 1000)).toEqual({ kind: 'stop' })
        expect(mapStopReason(assistant({ stopReason: 'length' }), 1000)).toEqual({ kind: 'max-tokens' })
        expect(mapStopReason(assistant({ stopReason: 'toolUse' }), 1000)).toEqual({ kind: 'tool-calls' })
    })

    it('refuses a completed response with no content rather than storing an empty turn', () => {
        const reason = mapStopReason(assistant({ content: [] }), 1000)
        expect(reason.kind).toBe('error')
        expect(reason.kind === 'error' && reason.failure.code).toBe('EMPTY_RESPONSE')
    })

    it('maps usage filling the context window to the overflow code', () => {
        const reason = mapStopReason(
            // pi-ai's length-stop overflow shape: the provider truncated the
            // input to fill the window and left no room for output.
            assistant({ stopReason: 'length', usage: usage({ input: 1000, output: 0, totalTokens: 1000 }) }),
            1000,
        )
        expect(reason.kind).toBe('error')
        expect(reason.kind === 'error' && reason.failure.code).toBe('CONTEXT_WINDOW_EXCEEDED')
    })

    it('maps an in-band provider error to its classified code', () => {
        const reason = mapStopReason(assistant({ stopReason: 'error', errorMessage: '429 rate limit reached' }), 1000)
        expect(reason.kind).toBe('error')
        expect(reason.kind === 'error' && reason.failure.code).toBe('RATE_LIMIT')
    })

    it('maps an abort to the aborted arm', () => {
        const reason = mapStopReason(assistant({ stopReason: 'aborted', errorMessage: 'caller stopped' }), 1000)
        expect(reason.kind).toBe('aborted')
    })

    it('refuses terminal states the harness cannot act on', () => {
        expect(mapStopReason(assistant({ stopReason: 'pending' }), 1000).kind).toBe('error')
        expect(mapStopReason(assistant({ stopReason: 'deferred' }), 1000).kind).toBe('error')
    })
})

describe('toStreamChunks', () => {
    it('maps a text turn end to end', async () => {
        const chunks = await collect([
            { type: 'start', partial: assistant() },
            { type: 'text_start', contentIndex: 0, partial: assistant() },
            { type: 'text_delta', contentIndex: 0, delta: 'Hel', partial: assistant() },
            { type: 'text_delta', contentIndex: 0, delta: 'lo', partial: assistant() },
            { type: 'text_end', contentIndex: 0, content: 'Hello', partial: assistant() },
            { type: 'done', reason: 'stop', message: assistant({ content: [{ type: 'text', text: 'Hello' }] }) },
        ])
        expect(chunks).toEqual([
            { type: 'block-start', index: 0, blockType: 'text' },
            { type: 'text-delta', index: 0, text: 'Hel' },
            { type: 'text-delta', index: 0, text: 'lo' },
            { type: 'block-end', index: 0, block: { type: 'text', text: 'Hello' } },
            { type: 'usage', usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 } },
            { type: 'finish', reason: { kind: 'stop' } },
        ])
    })

    it('maps thinking blocks to reasoning chunks', async () => {
        const chunks = await collect([
            { type: 'thinking_start', contentIndex: 0, partial: assistant() },
            { type: 'thinking_delta', contentIndex: 0, delta: 'why', partial: assistant() },
            { type: 'thinking_end', contentIndex: 0, content: 'why', partial: assistant() },
            { type: 'done', reason: 'stop', message: assistant({ content: [{ type: 'thinking', thinking: 'why' }] }) },
        ])
        expect(chunks[0]).toEqual({ type: 'block-start', index: 0, blockType: 'reasoning' })
        expect(chunks[1]).toEqual({ type: 'reasoning-delta', index: 0, text: 'why' })
        expect(chunks[2]).toEqual({ type: 'block-end', index: 0, block: { type: 'reasoning', text: 'why' } })
    })

    it('carries the tool-call id and name onto every delta and keeps raw argument JSON', async () => {
        const partial = assistant({
            content: [{ type: 'toolCall', id: 'call-1', name: 'bash', arguments: {} }],
            stopReason: 'toolUse',
        })
        const chunks = await collect([
            { type: 'toolcall_start', contentIndex: 0, partial },
            { type: 'toolcall_delta', contentIndex: 0, delta: '{"command":', partial },
            { type: 'toolcall_delta', contentIndex: 0, delta: '"ls"}', partial },
            {
                type: 'toolcall_end',
                contentIndex: 0,
                toolCall: { type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'ls' } },
                partial,
            },
            { type: 'done', reason: 'toolUse', message: partial },
        ])
        expect(chunks[0]).toEqual({ type: 'block-start', index: 0, blockType: 'tool-call' })
        expect(chunks[1]).toMatchObject({ type: 'tool-call-delta', index: 0, id: 'call-1', name: 'bash', argumentsDelta: '{"command":' })
        expect(chunks[2]).toMatchObject({ type: 'tool-call-delta', index: 0, argumentsDelta: '"ls"}' })
        expect(chunks[3]).toEqual({
            type: 'block-end',
            index: 0,
            block: { type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{"command":"ls"}' },
        })
        expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
    })

    it('emits usage before a terminal error finish', async () => {
        const chunks = await collect([
            { type: 'error', reason: 'error', error: assistant({ stopReason: 'error', errorMessage: '502 bad gateway' }) },
        ])
        expect(chunks[0]?.type).toBe('usage')
        expect(chunks[1]).toEqual({
            type: 'finish',
            reason: { kind: 'error', failure: { message: '502 bad gateway', code: 'SERVER' } },
        })
    })

    it('reports an in-band error as aborted when the caller was cancelled', async () => {
        const controller = new AbortController()
        controller.abort()
        const chunks = await collect(
            [{ type: 'error', reason: 'error', error: assistant({ stopReason: 'error', errorMessage: 'socket closed' }) }],
            1000,
            controller.signal,
        )
        expect(chunks[1]).toEqual({ type: 'finish', reason: { kind: 'aborted', failure: { message: 'socket closed', code: 'ABORTED' } } })
    })

    it('fails loudly when the source ends without a terminal event', async () => {
        await expect(collect([{ type: 'text_delta', contentIndex: 0, delta: 'x', partial: assistant() }])).rejects.toThrow(
            /ended without done\/error/,
        )
    })
})

/**
 * The DeepSeek DSML leak, verbatim from a real `opencode-go-session` turn: the
 * model asked for the `skill` tool, the lane never parsed it, and the markup
 * arrived as the assistant's text with `finish_reason: "stop"`.
 */
const DSML_LEAK =
    '<\u{FF5C}\u{FF5C}DSML\u{FF5C}\u{FF5C} calls>\n' +
    '<\u{FF5C}\u{FF5C}DSML\u{FF5C}\u{FF5C} invoke name="skill">\n' +
    '<\u{FF5C}\u{FF5C}DSML\u{FF5C}\u{FF5C} parameter name="name" string="true">cordis-plugin-development</\u{FF5C}\u{FF5C}DSML\u{FF5C}\u{FF5C} parameter>\n' +
    '</\u{FF5C}\u{FF5C}DSML\u{FF5C}\u{FF5C} invoke>\n' +
    '</\u{FF5C}\u{FF5C}DSML\u{FF5C}\u{FF5C} calls>'

describe('a reply that is the model tool-call template', () => {
    const template = '< | DSLM | calls> < | DSLM | invoke name="bash"> < | DSLM | parameter name="command" string="true">ls< / | DSLM | parameter> < / | DSLM | invoke> < / | DSLM | calls>'

    it('is a retryable server failure when tools were offered', () => {
        // The upstream skipped its tool-call parsing: the turn did NOT complete,
        // and recording the markup as an answer silently loses the tool call.
        const reason = mapStopReason(assistant({ content: [{ type: 'text', text: template }] }), 1000, true)
        expect(reason.kind).toBe('error')
        expect(reason.kind === 'error' && reason.failure.code).toBe('SERVER')
        expect(reason.kind === 'error' && reason.failure.message).toMatch(/tool-call syntax as text/)
    })

    it('recognises the exact token a real leak carries', () => {
        // Copied from a live session log: `<` + ONE U+FF5C fullwidth bar + DSML +
        // one bar. An earlier workaround in this repo matched two bars per side
        // and therefore never fired on the real thing.
        const real = '<\u{FF5C}DSML\u{FF5C} calls>\n<\u{FF5C}DSML\u{FF5C} invoke name="bash">\n<\u{FF5C}DSML\u{FF5C} parameter name="command" string="true">ls</\u{FF5C}DSML\u{FF5C} parameter>'
        const reason = mapStopReason(assistant({ content: [{ type: 'text', text: real }] }), 1000, true)
        expect(reason.kind).toBe('error')
        expect(reason.kind === 'error' && reason.failure.code).toBe('SERVER')
    })

    it('is accepted as text when the request offered no tools, where markup is not a defect', () => {
        const reason = mapStopReason(assistant({ content: [{ type: 'text', text: template }] }), 1000, false)
        expect(reason).toEqual({ kind: 'stop' })
    })

    it('does not fire when a model merely discusses the markup inside prose', () => {
        const prose = `DeepSeek's template looks like ${template} at the start of a call, but this answer is prose.`
        expect(mapStopReason(assistant({ content: [{ type: 'text', text: prose }] }), 1000, true)).toEqual({ kind: 'stop' })
    })

    it('does not fire when the reply carries a real tool call', () => {
        const reason = mapStopReason(
            assistant({ stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'c', name: 'bash', arguments: {} }] }),
            1000,
            true,
        )
        expect(reason).toEqual({ kind: 'tool-calls' })
    })

    it('is recognised through the chunk stream, so the loop sees the failure', async () => {
        const chunks = await collect(
            [{ type: 'done', reason: 'stop', message: assistant({ content: [{ type: 'text', text: template }] }) }],
            1000,
            undefined,
            true,
        )
        const finish = chunks.at(-1)
        expect(finish?.type === 'finish' && finish.reason.kind).toBe('error')
    })
})
