/**
 * ACP prompt usage → DSH token accounting.
 *
 * DSH counts are disjoint: `inputTokens` is uncached input only, and cache
 * reads/writes are separate. ACP's experimental usage reports a total input
 * count plus cache counters, so cached tokens are subtracted out (clamped at
 * zero) before the value reaches the harness. `outputTokens` already includes
 * thought tokens in the observed ACP responses; `reasoningTokens` records the
 * thought subset without adding it again.
 *
 * @module @gitawego/dsh-llm-agy/usage
 */
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type { AcpUsage } from './protocol.ts'

/** A finite non-negative integer, or zero. */
function count(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0
}

/**
 * Map one ACP usage record.
 * @param usage - ACP's optional prompt usage.
 * @returns the DSH record, or undefined when the agent disclosed nothing.
 */
export function mapAcpUsage(usage: AcpUsage | null | undefined): TokenUsage | undefined {
    if (usage === null || usage === undefined) return undefined
    const cacheRead = count(usage.cachedReadTokens)
    const cacheWrite = count(usage.cachedWriteTokens)
    const totalInput = count(usage.inputTokens)
    const output = count(usage.outputTokens)
    const reasoning = count(usage.thoughtTokens)
    const mapped: TokenUsage = {
        inputTokens: Math.max(0, totalInput - cacheRead - cacheWrite),
        outputTokens: output,
    }
    const total = count(usage.totalTokens)
    if (total > 0) mapped.totalTokens = total
    if (cacheRead > 0) mapped.cacheReadTokens = cacheRead
    if (cacheWrite > 0) mapped.cacheWriteTokens = cacheWrite
    if (reasoning > 0) mapped.reasoningTokens = reasoning
    return mapped
}
