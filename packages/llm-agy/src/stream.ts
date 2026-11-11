/**
 * ACP `session/update` → DSH `StreamChunk` translation.
 *
 * Text and thought chunks become ordinary DSH text/reasoning blocks. ACP tool
 * events are deliberately dropped: `agy` already executed those tools, so
 * emitting a DSH `tool-call` would make the harness execute them a second time.
 * Plan, config, command, usage-update, and session-info notifications are
 * presentation metadata the harness does not consume.
 *
 * @module @gitawego/dsh-llm-agy/stream
 */
import { EMPTY_RESPONSE_CODE, LlmError, type FinishReason, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { AcpPromptResponse, AcpSessionUpdate } from './protocol.ts'
import { mapAcpUsage } from './usage.ts'

type OpenBlockType = 'text' | 'reasoning'

interface OpenBlock {
    index: number
    type: OpenBlockType
    text: string
    messageId?: string
}

const IGNORED_UPDATES = new Set([
    'user_message_chunk',
    'tool_call',
    'tool_call_update',
    'plan',
    'plan_update',
    'plan_removed',
    'available_commands_update',
    'current_mode_update',
    'config_option_update',
    'session_info_update',
    'usage_update',
    'compaction_update',
    'compaction_summary_chunk',
    'notice',
])

/** One stream translator per prompt turn. */
export class ChunkTranslator {
    private open: OpenBlock | undefined
    private nextIndex = 0
    private contentSeen = false

    /** Translate one update into zero or more chunks. */
    update(update: AcpSessionUpdate): StreamChunk[] {
        if (IGNORED_UPDATES.has(update.sessionUpdate)) return []
        if (update.sessionUpdate !== 'agent_message_chunk' && update.sessionUpdate !== 'agent_thought_chunk') {
            return []
        }
        const block = update.content
        if (block === undefined || block.type !== 'text' || block.text.length === 0) return []
        const type: OpenBlockType = update.sessionUpdate === 'agent_message_chunk' ? 'text' : 'reasoning'
        const messageId = typeof update.messageId === 'string' ? update.messageId : undefined
        const chunks: StreamChunk[] = []
        let open = this.open

        if (open !== undefined && open.type !== type) {
            chunks.push(this.closeOpen())
            open = undefined
        }
        if (open !== undefined && messageId !== undefined && open.messageId !== undefined && messageId !== open.messageId) {
            chunks.push(this.closeOpen())
            open = undefined
        }
        if (open === undefined) {
            const index = this.nextIndex++
            open = { index, type, text: '', ...(messageId !== undefined ? { messageId } : {}) }
            this.open = open
            chunks.push({ type: 'block-start', index, blockType: type })
        }

        open.text += block.text
        this.contentSeen = true
        chunks.push({ type: type === 'text' ? 'text-delta' : 'reasoning-delta', index: open.index, text: block.text })
        return chunks
    }

    /**
     * Finish the turn.
     * @param response - the ACP prompt response.
     * @returns usage + terminal finish chunks.
     * @throws LlmError with `EMPTY_RESPONSE` when the agent produced no content.
     */
    finish(response: AcpPromptResponse): StreamChunk[] {
        const chunks: StreamChunk[] = []
        if (this.open !== undefined) chunks.push(this.closeOpen())
        if (!this.contentSeen) {
            throw new LlmError('Antigravity ACP completed without text or reasoning content', EMPTY_RESPONSE_CODE)
        }
        const usage = mapAcpUsage(response.usage)
        if (usage !== undefined) chunks.push({ type: 'usage', usage })
        chunks.push({ type: 'finish', reason: finishReason(response.stopReason) })
        return chunks
    }

    private closeOpen(): StreamChunk {
        const open = this.open!
        this.open = undefined
        return {
            type: 'block-end',
            index: open.index,
            block: open.type === 'text' ? { type: 'text', text: open.text } : { type: 'reasoning', text: open.text },
        }
    }
}

/** Map ACP's stop vocabulary onto DSH's finish vocabulary. */
export function finishReason(stopReason: string): FinishReason {
    if (stopReason === 'cancelled') {
        return { kind: 'aborted', failure: { message: 'Antigravity ACP turn was cancelled', code: 'ABORTED' } }
    }
    if (stopReason === 'max_tokens' || stopReason === 'max_turn_requests') {
        return { kind: 'max-tokens' }
    }
    // `end_turn`, `refusal`, and unknown future values are normal completions.
    return { kind: 'stop' }
}
