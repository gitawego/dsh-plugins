import { describe, expect, it } from 'vitest'
import {
    Config,
    DEFAULT_MAX_REQUEST_IMAGE_BYTES,
    DEFAULT_REQUEST_IMAGE_MAX_BYTES,
    DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET,
    defaultProfile,
    resolveProfile,
    resolveProfiles,
} from '../src/config.ts'
import { GATEWAYS, OPENCODE_GO, gatewayById } from '../src/gateways.ts'

describe('gateway definitions', () => {
    it('ships OpenCode Go, the gateway whose missing header this plugin fixes', () => {
        expect(GATEWAYS[0]).toBe(OPENCODE_GO)
        expect(OPENCODE_GO.id).toBe('opencode-go')
        expect(OPENCODE_GO.sessionRouting).toBe(true)
        expect(OPENCODE_GO.apiKeyEnv).toBe('OPENCODE_API_KEY')
        expect(gatewayById('opencode-go')).toBe(OPENCODE_GO)
    })

    it('answers undefined for a route this build does not serve', () => {
        expect(gatewayById('nope')).toBeUndefined()
    })
})

describe('defaultProfile', () => {
    it('derives every default from the gateway definition', () => {
        expect(defaultProfile(OPENCODE_GO)).toEqual({
            apiKeyEnv: 'OPENCODE_API_KEY',
            baseURL: 'https://opencode.ai/zen/go/v1',
            models: [],
            extraModels: [],
            sessionRouting: true,
            reasoning: '',
            maxRequestImageBytes: DEFAULT_MAX_REQUEST_IMAGE_BYTES,
            requestImagePixelBudget: DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET,
            requestImageMaxBytes: DEFAULT_REQUEST_IMAGE_MAX_BYTES,
        })
    })
})

describe('resolveProfile', () => {
    it('falls back to the shipped defaults for a missing section', () => {
        expect(resolveProfile(OPENCODE_GO, undefined)).toEqual(defaultProfile(OPENCODE_GO))
    })

    it('degrades a malformed hand-edited section to defaults instead of disabling the route', () => {
        const profile = resolveProfile(OPENCODE_GO, {
            apiKeyEnv: '   ',
            models: ['a', 'a', ' b ', 7, ''],
            reasoning: 'ultra',
            sessionRouting: 'yes',
            maxRequestImageBytes: -1,
            requestImagePixelBudget: 0,
            requestImageMaxBytes: Number.NaN,
        })
        expect(profile.apiKeyEnv).toBe('OPENCODE_API_KEY')
        expect(profile.models).toEqual(['a', 'b'])
        expect(profile.reasoning).toBe('')
        expect(profile.sessionRouting).toBe(true)
        expect(profile.maxRequestImageBytes).toBe(DEFAULT_MAX_REQUEST_IMAGE_BYTES)
        expect(profile.requestImagePixelBudget).toBe(DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET)
        expect(profile.requestImageMaxBytes).toBe(DEFAULT_REQUEST_IMAGE_MAX_BYTES)
    })

    it('honors an explicit endpoint override and an explicitly cleared one', () => {
        expect(resolveProfile(OPENCODE_GO, { baseURL: 'https://proxy.example/v1' }).baseURL).toBe('https://proxy.example/v1')
        expect(resolveProfile(OPENCODE_GO, { baseURL: '' }).baseURL).toBe('')
    })

    it('honors a valid reasoning level and a disabled routing header', () => {
        const profile = resolveProfile(OPENCODE_GO, { reasoning: 'high', sessionRouting: false })
        expect(profile.reasoning).toBe('high')
        expect(profile.sessionRouting).toBe(false)
    })
})

describe('resolveProfiles', () => {
    it('materializes one profile per served route', () => {
        const profiles = resolveProfiles({ 'opencode-go': { apiKeyEnv: 'MY_KEY' } })
        expect(Object.keys(profiles)).toEqual(GATEWAYS.map((gateway) => gateway.id))
        expect(profiles['opencode-go']?.apiKeyEnv).toBe('MY_KEY')
    })
})

describe('Config schema', () => {
    it('accepts an empty section and resolves every served route through its defaults', () => {
        const parsed = Config({}) as Record<string, unknown>
        expect(resolveProfiles(parsed)['opencode-go']).toEqual(defaultProfile(OPENCODE_GO))
    })

    it('keeps a partial section resolvable', () => {
        // A stored section is partial by construction (the schema supplies the
        // rest), so the cast reflects how the seam hands it to the plugin.
        const parsed = Config({ 'opencode-go': { reasoning: 'low' } } as never)
        expect(resolveProfiles(parsed)['opencode-go']?.reasoning).toBe('low')
    })
})
