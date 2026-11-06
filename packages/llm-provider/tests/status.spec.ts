/**
 * The status read: what the provider serves beside what the harness knows.
 *
 * The merge rules are the feature — which name wins, which flags are set, and
 * which ids the route still has to declare — so they are asserted against
 * already-fetched parts, with no network and no context.
 */
import { describe, expect, it } from 'vitest'
import type { ModelMetadata } from '../src/models-dev.ts'
import { composeStatus, modelsSnippet, readStatus, type StatusInput } from '../src/status.ts'

/** One models.dev metadata entry. */
function meta(id: string, overrides: Partial<ModelMetadata> = {}): ModelMetadata {
    return { id, name: id.toUpperCase(), input: ['text'], reasoning: true, ...overrides }
}

/** A composition input with sensible defaults. */
function input(overrides: Partial<StatusInput> = {}): StatusInput {
    return {
        route: 'opencode-go',
        endpoint: 'https://gw.test/v1',
        credential: 'MY_KEY',
        apiKey: 'sk-live',
        knownModels: [],
        liveIds: [],
        metadata: new Map(),
        fetchedAt: 1_700_000_000_000,
        ...overrides,
    }
}

describe('composing the status', () => {
    it('marks an id the catalog and the gateway both know', () => {
        const status = composeStatus(input({ knownModels: [{ id: 'alpha' }], liveIds: ['alpha'] }))
        expect(status.models).toHaveLength(1)
        expect(status.models[0]).toMatchObject({ id: 'alpha', known: true, live: true })
        expect(status.unknownIds).toEqual([])
        expect(status.knownCount).toBe(1)
        expect(status.servedCount).toBe(1)
    })

    it('lists a gateway id the installed catalog does not describe', () => {
        const status = composeStatus(input({ knownModels: [{ id: 'alpha' }], liveIds: ['alpha', 'beta'] }))
        expect(status.unknownIds).toEqual(['beta'])
        expect(status.models.find((row) => row.id === 'beta')).toMatchObject({ known: false, live: true })
    })

    it('keeps a catalog model the gateway no longer lists', () => {
        // A model removed from the endpoint is still worth showing: it is what
        // the picker offers and what a request will fail on.
        const status = composeStatus(input({ knownModels: [{ id: 'alpha' }], liveIds: [] }))
        expect(status.models[0]).toMatchObject({ id: 'alpha', known: true, live: false })
        expect(status.unknownIds).toEqual([])
    })

    it('sorts known ids first, then by id', () => {
        const status = composeStatus(input({
            knownModels: [{ id: 'zeta' }, { id: 'alpha' }],
            liveIds: ['beta', 'alpha', 'zeta'],
        }))
        expect(status.models.map((row) => row.id)).toEqual(['alpha', 'zeta', 'beta'])
    })

    it('prefers the models.dev name, then the catalog name, then the id', () => {
        const status = composeStatus(input({
            knownModels: [{ id: 'alpha', name: 'Catalog Alpha' }, { id: 'beta', name: 'Catalog Beta' }],
            liveIds: ['alpha', 'beta', 'gamma'],
            metadata: new Map([['alpha', meta('alpha', { name: 'Dataset Alpha' })]]),
        }))
        expect(status.models.map((row) => row.name)).toEqual(['Dataset Alpha', 'Catalog Beta', 'gamma'])
    })

    it('carries capacities and modalities when models.dev discloses them', () => {
        const status = composeStatus(input({
            liveIds: ['alpha'],
            metadata: new Map([['alpha', meta('alpha', { contextWindow: 1_000_000, maxTokens: 384_000, input: ['text', 'image'], reasoning: true })]]),
        }))
        expect(status.models[0]).toMatchObject({ contextWindow: 1_000_000, maxTokens: 384_000, input: ['text', 'image'], reasoning: true })
    })

    it('omits undisclosed facts instead of inventing them', () => {
        const status = composeStatus(input({ liveIds: ['alpha'] }))
        expect(status.models[0]).not.toHaveProperty('contextWindow')
        expect(status.models[0]).not.toHaveProperty('maxTokens')
        expect(status.models[0]).not.toHaveProperty('input')
        expect(status.models[0]).not.toHaveProperty('reasoning')
    })

    it('reports credential presence without echoing the secret', () => {
        const status = composeStatus(input())
        expect(status.credentialPresent).toBe(true)
        expect(status.credential).toBe('MY_KEY')
        expect(JSON.stringify(status)).not.toContain('sk-live')
    })

    it('marks an unresolved credential', () => {
        expect(composeStatus(input({ apiKey: undefined })).credentialPresent).toBe(false)
    })
})

describe('reading the status', () => {
    it('reads the gateway list, the catalog, and the metadata together', async () => {
        const status = await readStatus({
            route: 'opencode-go',
            endpoint: 'https://gw.test/v1',
            credential: 'MY_KEY',
            apiKey: 'sk-live',
            deps: {
                fetchIds: async () => ['alpha', 'beta'],
                knownModels: async () => [{ id: 'alpha', name: 'Alpha' }],
                fetchMetadata: async () => new Map([['beta', meta('beta')]]),
            },
        })
        expect(status.servedCount).toBe(2)
        expect(status.knownCount).toBe(1)
        expect(status.unknownIds).toEqual(['beta'])
        expect(status.error).toBeUndefined()
    })

    it('asks the endpoint and the route it was given', async () => {
        const asked: { endpoint?: string; route?: string } = {}
        await readStatus({
            route: 'my-route',
            endpoint: 'https://gw.test/v7',
            credential: 'K',
            apiKey: 'sk',
            deps: {
                fetchIds: async (options) => { asked.endpoint = options.baseURL; return [] },
                knownModels: async (route) => { asked.route = route; return [] },
                fetchMetadata: async () => new Map(),
            },
        })
        expect(asked).toEqual({ endpoint: 'https://gw.test/v7', route: 'my-route' })
    })

    it('survives a failing metadata read', async () => {
        const status = await readStatus({
            route: 'opencode-go',
            endpoint: 'https://gw.test/v1',
            credential: 'K',
            apiKey: 'sk',
            deps: {
                fetchIds: async () => ['alpha'],
                knownModels: async () => [{ id: 'alpha' }],
                fetchMetadata: async () => { throw new Error('models.dev is down') },
            },
        })
        expect(status.models).toHaveLength(1)
        expect(status.models[0]?.contextWindow).toBeUndefined()
    })

    it('survives a failing catalog read', async () => {
        const status = await readStatus({
            route: 'opencode-go',
            endpoint: 'https://gw.test/v1',
            credential: 'K',
            apiKey: 'sk',
            deps: {
                fetchIds: async () => ['alpha'],
                knownModels: async () => { throw new Error('no adapter') },
                fetchMetadata: async () => new Map(),
            },
        })
        expect(status.knownCount).toBe(0)
        expect(status.unknownIds).toEqual(['alpha'])
    })

    it('explains an empty live list instead of showing a silent zero', async () => {
        const status = await readStatus({
            route: 'opencode-go',
            endpoint: 'https://gw.test/v1',
            credential: 'K',
            apiKey: 'sk',
            deps: { fetchIds: async () => [], knownModels: async () => [], fetchMetadata: async () => new Map() },
        })
        expect(status.error).toBe('the gateway listed no models')
    })

    it('names the credential when nothing resolved', async () => {
        const status = await readStatus({
            route: 'opencode-go',
            endpoint: 'https://gw.test/v1',
            credential: 'MY_KEY',
            apiKey: undefined,
            deps: {
                fetchIds: async (options) => { expect(options.apiKey).toBeUndefined(); return [] },
                knownModels: async () => [],
                fetchMetadata: async () => new Map(),
            },
        })
        expect(status.error).toBe('no credential resolved')
    })
})

describe('the paste-ready models block', () => {
    it('spells out every id, because a declared list replaces the catalog', () => {
        const status = composeStatus(input({
            knownModels: [{ id: 'alpha' }],
            liveIds: ['alpha', 'beta'],
            metadata: new Map([['beta', meta('beta', { contextWindow: 1_000_000, maxTokens: 384_000, input: ['text', 'image'] })]]),
        }))
        expect(modelsSnippet(status)).toEqual([
            '    models:',
            '      - id: alpha',
            '      - id: beta',
            '        contextWindow: 1000000',
            '        maxTokens: 384000',
            '        input: [text, image]',
            '        reasoning: true',
        ])
    })

    it('says why it is empty rather than emitting a stub block', () => {
        expect(modelsSnippet(composeStatus(input()))).toEqual(['# no models read yet; refresh to generate this block'])
    })
})
