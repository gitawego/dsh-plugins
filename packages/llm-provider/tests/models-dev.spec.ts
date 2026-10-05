/**
 * Fixtures mirror the live documents, trimmed: the shapes here are the contract
 * with two external services, so they are asserted field by field.
 */
import { describe, expect, it, vi } from 'vitest'
import {
    MODELS_DEV_PROVIDER,
    fetchModelsDevCatalog,
    parseModelsDevCatalog,
    parseReasoningOptions,
} from '../src/models-dev.ts'

const document = () => ({
    'opencode-go': {
        id: 'opencode-go',
        name: 'OpenCode Go',
        api: 'https://opencode.ai/zen/go/v1',
        env: ['OPENCODE_API_KEY'],
        models: {
            'deepseek-v4.1-flash': {
                id: 'deepseek-v4.1-flash',
                name: 'DeepSeek V4.1 Flash',
                family: 'deepseek-flash',
                reasoning: true,
                reasoning_options: [{ type: 'effort', values: ['low', 'high', 'max'] }],
                interleaved: { field: 'reasoning_content' },
                modalities: { input: ['text', 'image'], output: ['text'] },
                limit: { context: 1000000, output: 384000 },
                cost: { input: 0.15, output: 0.6, cache_read: 0.003 },
                release_date: '2026-09-30',
            },
            'space-bunny-free': {
                id: 'space-bunny-free',
                name: 'Space Bunny Free',
                family: 'bunny',
                reasoning: true,
                reasoning_options: [{ type: 'toggle' }, { type: 'budget_tokens', max: 262144 }],
                modalities: { input: ['text', 'image', 'video'] },
                limit: { context: 1048576, output: 524288 },
                cost: { input: 0, output: 0, cache_read: 0 },
            },
            'plain-model': { id: 'plain-model', name: 'Plain', reasoning: false, modalities: { input: ['text'] }, limit: { context: 8000, output: 1000 } },
        },
    },
})

describe('parseReasoningOptions', () => {
    it('reads the effort values a model accepts', () => {
        expect(parseReasoningOptions([{ type: 'effort', values: ['low', 'high', 'max'] }])).toEqual({ effort: ['low', 'high', 'max'], toggle: false })
    })

    it('records a toggle and a token budget when those are what the model offers', () => {
        expect(parseReasoningOptions([{ type: 'toggle' }, { type: 'budget_tokens', max: 262144 }])).toEqual({
            effort: [],
            toggle: true,
            budgetMax: 262144,
        })
    })

    it('keeps both facts when a model publishes several options at once', () => {
        expect(parseReasoningOptions([{ type: 'toggle' }, { type: 'effort', values: ['low', 'medium', 'xhigh'] }])).toEqual({
            effort: ['low', 'medium', 'xhigh'],
            toggle: true,
        })
    })

    it('answers undefined for an empty or malformed list', () => {
        expect(parseReasoningOptions([])).toBeUndefined()
        expect(parseReasoningOptions(undefined)).toBeUndefined()
        expect(parseReasoningOptions([{ type: 'something-else' }])).toBeUndefined()
        expect(parseReasoningOptions(['nonsense'])).toBeUndefined()
    })
})

describe('parseModelsDevCatalog', () => {
    it('reads capacities, cost, family, and thinking levels', () => {
        const meta = parseModelsDevCatalog(document()).get('deepseek-v4.1-flash')
        expect(meta).toMatchObject({
            id: 'deepseek-v4.1-flash',
            name: 'DeepSeek V4.1 Flash',
            family: 'deepseek-flash',
            contextWindow: 1_000_000,
            maxTokens: 384_000,
            input: ['text', 'image'],
            reasoning: true,
            reasoningField: 'reasoning_content',
            releasedAt: '2026-09-30',
        })
        expect(meta?.options?.effort).toEqual(['low', 'high', 'max'])
        expect(meta?.cost).toEqual({ input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 })
    })

    it('drops modalities pi-ai cannot send, keeping text and image', () => {
        expect(parseModelsDevCatalog(document()).get('space-bunny-free')?.input).toEqual(['text', 'image'])
    })

    it('keeps a model that does not reason, with no options', () => {
        const meta = parseModelsDevCatalog(document()).get('plain-model')
        expect(meta?.reasoning).toBe(false)
        expect(meta?.options).toBeUndefined()
    })

    it('defaults missing capacities rather than inventing them', () => {
        const meta = parseModelsDevCatalog({ 'opencode-go': { models: { x: { id: 'x' } } } }).get('x')
        expect(meta?.contextWindow).toBeUndefined()
        expect(meta?.maxTokens).toBeUndefined()
        expect(meta?.input).toEqual(['text'])
        expect(meta?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
    })

    it('answers an empty map for an absent provider or a malformed document', () => {
        expect(parseModelsDevCatalog(document(), 'not-a-provider').size).toBe(0)
        expect(parseModelsDevCatalog(undefined).size).toBe(0)
        expect(parseModelsDevCatalog({ 'opencode-go': {} }).size).toBe(0)
    })

    it('reads the provider this plugin is built for by default', () => {
        expect(MODELS_DEV_PROVIDER).toBe('opencode-go')
    })
})

describe('fetchModelsDevCatalog', () => {
    it('reads the dataset over HTTP', async () => {
        const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify(document()), { status: 200 }))
        const meta = await fetchModelsDevCatalog({ fetch: fetchImpl as unknown as typeof fetch })
        expect(fetchImpl).toHaveBeenCalledOnce()
        expect(meta.get('deepseek-v4.1-flash')?.contextWindow).toBe(1_000_000)
    })

    it('degrades to an empty map instead of failing the route when the service is down', async () => {
        const failing = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response('nope', { status: 503 }))
        await expect(fetchModelsDevCatalog({ fetch: failing as unknown as typeof fetch })).resolves.toEqual(new Map())
        const throwing = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => {
            throw new Error('offline')
        })
        await expect(fetchModelsDevCatalog({ fetch: throwing as unknown as typeof fetch })).resolves.toEqual(new Map())
    })

    it('identifies the client, which the dataset serves as a public read', async () => {
        const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response('{}', { status: 200 }))
        await fetchModelsDevCatalog({ fetch: fetchImpl as unknown as typeof fetch })
        const init = fetchImpl.mock.calls[0]?.[1] as RequestInit
        expect(Object.keys((init.headers ?? {}) as Record<string, string>).map((name) => name.toLowerCase())).toContain('user-agent')
    })
})
