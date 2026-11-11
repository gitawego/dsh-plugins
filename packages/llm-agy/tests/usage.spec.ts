import { describe, expect, it } from 'vitest'
import { mapAcpUsage } from '../src/usage.ts'

describe('mapAcpUsage', () => {
    it('subtracts cache reads and writes from the total input count', () => {
        expect(
            mapAcpUsage({
                totalTokens: 100,
                inputTokens: 70,
                outputTokens: 30,
                thoughtTokens: 7,
                cachedReadTokens: 20,
                cachedWriteTokens: 5,
            }),
        ).toEqual({
            inputTokens: 45,
            outputTokens: 30,
            totalTokens: 100,
            cacheReadTokens: 20,
            cacheWriteTokens: 5,
            reasoningTokens: 7,
        })
    })

    it('omits zero cache and reasoning counters', () => {
        expect(mapAcpUsage({ totalTokens: 10, inputTokens: 8, outputTokens: 2, cachedReadTokens: 0, cachedWriteTokens: 0, thoughtTokens: 0 })).toEqual({
            inputTokens: 8,
            outputTokens: 2,
            totalTokens: 10,
        })
    })

    it('clamps a cache total larger than the reported input', () => {
        expect(mapAcpUsage({ totalTokens: 5, inputTokens: 3, outputTokens: 2, cachedReadTokens: 9 })).toEqual({
            inputTokens: 0,
            outputTokens: 2,
            totalTokens: 5,
            cacheReadTokens: 9,
        })
    })

    it('returns undefined when the agent disclosed no usage', () => {
        expect(mapAcpUsage(undefined)).toBeUndefined()
        expect(mapAcpUsage(null)).toBeUndefined()
    })

    it('ignores negative and non-finite counts', () => {
        expect(mapAcpUsage({ totalTokens: Number.NaN, inputTokens: -4, outputTokens: 2, cachedReadTokens: -1 })).toEqual({
            inputTokens: 0,
            outputTokens: 2,
        })
    })
})
