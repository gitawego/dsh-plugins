import { describe, expect, it } from 'vitest'
import { providerSummary } from '../src/client/models-page.ts'
import type { CardSnapshot } from '../src/client/controller.ts'

/** Only the fields the summary reads matter here. */
function card(over: Partial<CardSnapshot> = {}): CardSnapshot {
    return { advertisedCount: 2, servedCount: 36, sessionRouting: true, ...over } as CardSnapshot
}

const t = (key: string): string =>
    ({ modelsPageSummary: '{allowed} of {served} models allowed · session routing {routing}', on: 'on', off: 'off' })[key] ?? key

describe('providerSummary', () => {
    it('states how many models are allowed and whether routing is on', () => {
        expect(providerSummary(card(), t)).toBe('2 of 36 models allowed · session routing on')
    })

    it('says routing is off when the profile disabled it', () => {
        expect(providerSummary(card({ sessionRouting: false }), t)).toBe('2 of 36 models allowed · session routing off')
    })

    it('reports an all-models route as its full count, not as zero pinned', () => {
        expect(providerSummary(card({ advertisedCount: 36 }), t)).toContain('36 of 36')
    })
})
