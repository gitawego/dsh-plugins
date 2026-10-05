import { describe, expect, it, vi } from 'vitest'
import type { Api, Model, Provider } from '@earendil-works/pi-ai'
import { withAttribution, createGatewayTransport } from '../src/transport.ts'
import { defaultProfile, type ProviderSettings } from '../src/config.ts'
import { OPENCODE_SESSION_HEADER } from '../src/session-header.ts'
import { GATEWAYS, OPENCODE_GO } from '../src/gateways.ts'

function model(id: string, over: Partial<Model<'openai-completions'>> = {}): Model<Api> {
    return {
        id,
        name: id,
        api: 'openai-completions',
        provider: 'opencode-go',
        baseUrl: 'https://opencode.ai/zen/go/v1',
        reasoning: true,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1000,
        maxTokens: 100,
        ...over,
    } as Model<Api>
}

/** A catalog provider shaped like pi-ai's built-ins, with recording streams. */
function fakeCatalog(models: readonly Model<Api>[]) {
    const calls: { options: Record<string, unknown> | undefined; model: Model<Api> }[] = []
    const provider: Provider = {
        id: 'opencode-go',
        name: 'OpenCode Go',
        auth: { apiKey: { name: 'OpenCode API key' } } as Provider['auth'],
        getModels: () => models,
        stream: (_model, _context, options) => {
            calls.push({ model: _model, options: options as Record<string, unknown> | undefined })
            return undefined as never
        },
        streamSimple: (_model, _context, options) => {
            calls.push({ model: _model, options: options as Record<string, unknown> | undefined })
            return undefined as never
        },
    }
    return { provider, calls, factory: () => provider }
}

/** A profile set with the shipped defaults for every served route. */
function profiles(over: Partial<ProviderSettings[string]> = {}): ProviderSettings {
    return { 'opencode-go': { ...defaultProfile(OPENCODE_GO), ...over } }
}

describe('withAttribution', () => {
    it('always sends the harness user-agent', () => {
        const headers = withAttribution(undefined)
        expect(Object.keys(headers).map((name) => name.toLowerCase())).toContain('user-agent')
    })

    it('lets a caller header through but never a shadowed user-agent', () => {
        const headers = withAttribution({ 'x-trace': 't', 'User-Agent': 'impostor/1.0' })
        expect(headers['x-trace']).toBe('t')
        expect(headers['User-Agent']).toBeUndefined()
        expect(headers['user-agent']).toBeTruthy()
    })
})

describe('createGatewayTransport', () => {
    it('advertises the catalog in order', () => {
        const { factory } = fakeCatalog([model('a'), model('b')])
        const transport = createGatewayTransport(GATEWAYS, profiles(), { 'opencode-go': factory })
        expect(transport.listModels('opencode-go').map((entry) => entry.id)).toEqual(['a', 'b'])
        expect(transport.getModel('opencode-go', 'b')?.id).toBe('b')
    })

    it('restricts the catalog to an allowlist when the profile sets one', () => {
        const { factory } = fakeCatalog([model('a'), model('b')])
        const transport = createGatewayTransport(GATEWAYS, profiles({ models: ['b'] }), { 'opencode-go': factory })
        expect(transport.listModels('opencode-go').map((entry) => entry.id)).toEqual(['b'])
        expect(transport.getModel('opencode-go', 'a')).toBeUndefined()
    })

    it('stamps the session header and attribution on every dispatch', () => {
        const { factory, calls } = fakeCatalog([model('a')])
        const transport = createGatewayTransport(GATEWAYS, profiles(), { 'opencode-go': factory })
        transport.stream('opencode-go', 'a', { messages: [] }, { sessionId: 'sess-7', apiKey: 'k' })
        const headers = calls[0]?.options?.['headers'] as Record<string, string> | undefined
        expect(headers?.[OPENCODE_SESSION_HEADER]).toBe('sess-7')
        expect(headers?.['user-agent']).toBeTruthy()
        expect(calls[0]?.options?.['apiKey']).toBe('k')
    })

    it('sends no session header when the request has no session identity', () => {
        const { factory, calls } = fakeCatalog([model('a')])
        const transport = createGatewayTransport(GATEWAYS, profiles(), { 'opencode-go': factory })
        transport.stream('opencode-go', 'a', { messages: [] }, {})
        const headers = calls[0]?.options?.['headers'] as Record<string, string> | undefined
        expect(headers?.[OPENCODE_SESSION_HEADER]).toBeUndefined()
        expect(headers?.['user-agent']).toBeTruthy()
    })

    it('routes models under the route key pi-ai dispatches on', () => {
        const { factory, calls } = fakeCatalog([model('a')])
        const transport = createGatewayTransport(GATEWAYS, profiles(), { 'opencode-go': factory })
        transport.stream('opencode-go', 'a', { messages: [] }, {})
        expect(calls[0]?.model.provider).toBe('opencode-go')
    })

    it('applies an endpoint override to the models it dispatches', () => {
        const { factory } = fakeCatalog([model('a')])
        const transport = createGatewayTransport(GATEWAYS, profiles({ baseURL: 'https://proxy.example/v1' }), {
            'opencode-go': factory,
        })
        expect(transport.getModel('opencode-go', 'a')?.baseUrl).toBe('https://proxy.example/v1')
    })

    it('rebuilds a route only when its profile actually moved', () => {
        const build = vi.fn(() => fakeCatalog([model('a')]).provider)
        const transport = createGatewayTransport(GATEWAYS, profiles(), { 'opencode-go': build })
        expect(build).toHaveBeenCalledTimes(1)
        transport.setProfiles(profiles())
        expect(build).toHaveBeenCalledTimes(1)
        transport.setProfiles(profiles({ models: ['a'] }))
        expect(build).toHaveBeenCalledTimes(2)
    })

    it('serves nothing for a route this build has no catalog for', () => {
        const transport = createGatewayTransport(GATEWAYS, profiles(), {})
        expect(transport.listModels('opencode-go')).toEqual([])
        expect(() => transport.stream('opencode-go', 'a', { messages: [] }, {})).toThrow(/does not serve route/)
    })

    it('refuses a model the route does not advertise', () => {
        const { factory } = fakeCatalog([model('a')])
        const transport = createGatewayTransport(GATEWAYS, profiles(), { 'opencode-go': factory })
        expect(() => transport.stream('opencode-go', 'zzz', { messages: [] }, {})).toThrow(/does not serve model/)
    })
})
