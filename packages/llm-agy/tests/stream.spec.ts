import { describe, expect, it } from 'vitest'
import { ChunkTranslator, finishReason } from '../src/stream.ts'
import type { AcpSessionUpdate } from '../src/protocol.ts'

function textUpdate(type: 'agent_message_chunk' | 'agent_thought_chunk', text: string, messageId?: string): AcpSessionUpdate {
    return {
        sessionUpdate: type,
        ...(messageId !== undefined ? { messageId } : {}),
        content: { type: 'text', text },
    }
}

const usage = { totalTokens: 30, inputTokens: 20, outputTokens: 10, thoughtTokens: 3, cachedReadTokens: 2 }

describe('ChunkTranslator', () => {
    it('maps text chunks into one block with a terminal finish', () => {
        const translator = new ChunkTranslator()
        const chunks = [
            ...translator.update(textUpdate('agent_message_chunk', 'Hel', 'm1')),
            ...translator.update(textUpdate('agent_message_chunk', 'lo', 'm1')),
            ...translator.finish({ stopReason: 'end_turn', usage }),
        ]
        expect(chunks).toEqual([
            { type: 'block-start', index: 0, blockType: 'text' },
            { type: 'text-delta', index: 0, text: 'Hel' },
            { type: 'text-delta', index: 0, text: 'lo' },
            { type: 'block-end', index: 0, block: { type: 'text', text: 'Hello' } },
            {
                type: 'usage',
                usage: { inputTokens: 18, outputTokens: 10, totalTokens: 30, cacheReadTokens: 2, reasoningTokens: 3 },
            },
            { type: 'finish', reason: { kind: 'stop' } },
        ])
    })

    it('separates reasoning and text into distinct blocks', () => {
        const translator = new ChunkTranslator()
        const chunks = [
            ...translator.update(textUpdate('agent_thought_chunk', 'think', 'm1')),
            ...translator.update(textUpdate('agent_message_chunk', 'answer', 'm2')),
            ...translator.finish({ stopReason: 'end_turn' }),
        ]
        expect(chunks.filter((chunk) => chunk.type === 'block-start')).toEqual([
            { type: 'block-start', index: 0, blockType: 'reasoning' },
            { type: 'block-start', index: 1, blockType: 'text' },
        ])
        expect(chunks.find((chunk) => chunk.type === 'block-end' && chunk.index === 0)).toEqual({
            type: 'block-end',
            index: 0,
            block: { type: 'reasoning', text: 'think' },
        })
    })

    it('starts a new block when messageId changes', () => {
        const translator = new ChunkTranslator()
        const chunks = [
            ...translator.update(textUpdate('agent_message_chunk', 'one', 'm1')),
            ...translator.update(textUpdate('agent_message_chunk', 'two', 'm2')),
            ...translator.finish({ stopReason: 'end_turn' }),
        ]
        expect(chunks.filter((chunk) => chunk.type === 'block-start')).toHaveLength(2)
        expect(chunks).toContainEqual({ type: 'block-end', index: 0, block: { type: 'text', text: 'one' } })
    })

    it('ignores tool events and agent echoes', () => {
        const translator = new ChunkTranslator()
        expect(translator.update({ sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'Read' })).toEqual([])
        expect(translator.update({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'echo' } })).toEqual([])
        expect(translator.update({ sessionUpdate: 'plan', entries: [] })).toEqual([])
        expect(translator.update({ sessionUpdate: 'usage_update', used: 1, size: 2 })).toEqual([])
    })

    it('does not count an empty text chunk as content', () => {
        const translator = new ChunkTranslator()
        expect(translator.update(textUpdate('agent_message_chunk', ''))).toEqual([])
        expect(() => translator.finish({ stopReason: 'end_turn' })).toThrowError(/without text or reasoning/)
    })

    it('classifies a cancelled turn as aborted', () => {
        const translator = new ChunkTranslator()
        translator.update(textUpdate('agent_message_chunk', 'partial'))
        const chunks = translator.finish({ stopReason: 'cancelled' })
        expect(chunks.at(-1)).toEqual({
            type: 'finish',
            reason: { kind: 'aborted', failure: { message: 'Antigravity ACP turn was cancelled', code: 'ABORTED' } },
        })
    })
})

describe('finishReason', () => {
    it('maps the ACP stop vocabulary', () => {
        expect(finishReason('end_turn')).toEqual({ kind: 'stop' })
        expect(finishReason('refusal')).toEqual({ kind: 'stop' })
        expect(finishReason('max_tokens')).toEqual({ kind: 'max-tokens' })
        expect(finishReason('max_turn_requests')).toEqual({ kind: 'max-tokens' })
        expect(finishReason('cancelled')).toMatchObject({ kind: 'aborted' })
        expect(finishReason('future_reason')).toEqual({ kind: 'stop' })
    })
})
