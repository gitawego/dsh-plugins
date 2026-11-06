import { describe, expect, it, vi } from 'vitest'
import type { Api, Model } from '@earendil-works/pi-ai'
import { createCatalogFeed, mergeCatalog, nearestInstalled, thinkingLevelMapFor, type LiveCatalog } from '../src/catalog-feed.ts'
import { defaultProfile, resolveProfiles, type GatewayProfile } from '../src/config.ts'
import { GATEWAYS, OPENCODE_GO, protocolFor, type GatewayDefinition } from '../src/gateways.ts'
import type { ModelMetadata } from '../src/models-dev.ts'
import type { ProviderSettings } from '../src/config.ts'

function model(id: string, over: Record<string, unknown> = {}): Model<Api> {
    return {
        id,
        name: id,
        api: 'openai-completions',
        provider: 'opencode-go',
        baseUrl: 'https://opencode.ai/zen/go/v1',
        reasoning: true,
        input: ['text'],
        cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 8_000,
        ...over,
    } as unknown as Model<Api>
}

function metadata(entries: Record<string, Partial<ModelMetadata>>): Map<string, ModelMetadata> {
    return new Map(
        Object.entries(entries).map(([id, over]) => [id, { id, name: id, input: ['text'], reasoning: false, ...over }]),
    )
}

function live(ids: string[], meta: Map<string, ModelMetadata> = new Map()): LiveCatalog {
    return { ids, metadata: meta, fetchedAt: 1_000 }
}

function profile(over: Partial<GatewayProfile> = {}): GatewayProfile {
    return { ...defaultProfile(OPENCODE_GO), ...over }
}

describe('thinkingLevelMapFor', () => {
    it('marks the declared levels available and the rest unsupported', () => {
        expect(thinkingLevelMapFor(['low', 'high', 'max'])).toEqual({
            minimal: null,
            low: 'low',
            medium: null,
            high: 'high',
            xhigh: null,
            max: 'max',
        })
    })

    it('leaves off unmapped, because pi-ai reads that as "omit the effort"', () => {
        expect(thinkingLevelMapFor(['high'])).not.toHaveProperty('off')
    })

    it('answers undefined when a model declares no levels', () => {
        expect(thinkingLevelMapFor([])).toBeUndefined()
        expect(thinkingLevelMapFor(undefined)).toBeUndefined()
    })
})

describe('protocolFor', () => {
    it('uses the endpoint table for the models the gateway documents differently', () => {
        expect(protocolFor(OPENCODE_GO, 'gpt-6-luna')).toBe('openai-responses')
        expect(protocolFor(OPENCODE_GO, 'minimax-m3')).toBe('anthropic-messages')
        expect(protocolFor(OPENCODE_GO, 'qwen3.8-max')).toBe('anthropic-messages')
    })

    it('falls back to the route default for everything else, including new models', () => {
        expect(protocolFor(OPENCODE_GO, 'deepseek-v4.1-flash')).toBe('openai-completions')
        expect(protocolFor(OPENCODE_GO, 'a-model-from-next-year')).toBe('openai-completions')
    })
})

describe('mergeCatalog', () => {
    it('serves the installed catalog when nothing live is available', () => {
        const models = mergeCatalog({ gateway: OPENCODE_GO, profile: profile(), installed: [model('a'), model('b')] })
        expect(models.map((entry) => entry.id)).toEqual(['a', 'b'])
        expect(models[0]?.provider).toBe(OPENCODE_GO.id)
    })

    it('adds the ids the gateway reports beyond the installed catalog', () => {
        const models = mergeCatalog({
            gateway: OPENCODE_GO,
            profile: profile(),
            installed: [model('a')],
            live: live(['a', 'new-one'], metadata({ 'new-one': { name: 'New One', contextWindow: 500_000, maxTokens: 20_000 } })),
        })
        expect(models.map((entry) => entry.id)).toEqual(['a', 'new-one'])
        expect(models[1]).toMatchObject({ name: 'New One', contextWindow: 500_000, maxTokens: 20_000 })
    })

    it('keeps the installed catalog when the live list comes back empty', () => {
        const models = mergeCatalog({ gateway: OPENCODE_GO, profile: profile(), installed: [model('a')], live: live([]) })
        expect(models.map((entry) => entry.id)).toEqual(['a'])
    })

    it('lets a profile declaration outrank both sources', () => {
        const models = mergeCatalog({
            gateway: OPENCODE_GO,
            profile: profile({ extraModels: [{ id: 'a', name: 'Renamed', contextWindow: 9, maxTokens: 5, reasoning: false }] }),
            installed: [model('a')],
        })
        expect(models[0]).toMatchObject({ name: 'Renamed', contextWindow: 9, maxTokens: 5, reasoning: false })
    })

    it('narrows the installed catalog to the allowlist but never hides a declaration', () => {
        const models = mergeCatalog({
            gateway: OPENCODE_GO,
            profile: profile({ models: ['b'], extraModels: [{ id: 'declared' }] }),
            installed: [model('a'), model('b')],
        })
        expect(models.map((entry) => entry.id).sort()).toEqual(['b', 'declared'])
    })

    it('still serves an allowlisted id no source describes yet', () => {
        // The live fetch has not landed (or failed): the id is only known to the
        // allowlist, and the route must not go dark because of it.
        const models = mergeCatalog({
            gateway: OPENCODE_GO,
            profile: profile({ models: ['deepseek-v4.1-flash'] }),
            installed: [model('deepseek-v4-flash')],
        })
        expect(models.map((entry) => entry.id)).toEqual(['deepseek-v4.1-flash'])
        expect(models[0]).toMatchObject({ provider: OPENCODE_GO.id, api: protocolFor(OPENCODE_GO, 'deepseek-v4.1-flash') })
    })

    it('keeps an allowlisted id once the live catalog describes it', () => {
        const models = mergeCatalog({
            gateway: OPENCODE_GO,
            profile: profile({ models: ['deepseek-v4.1-flash'] }),
            installed: [],
            live: live(['deepseek-v4.1-flash', 'other'], metadata({ 'deepseek-v4.1-flash': { contextWindow: 1_000_000, maxTokens: 384_000 } })),
        })
        expect(models.map((entry) => entry.id)).toEqual(['deepseek-v4.1-flash'])
        expect(models[0]).toMatchObject({ contextWindow: 1_000_000, maxTokens: 384_000 })
    })

    it('resolves the protocol most-authoritative-first: catalog, table, relative, default', () => {
        const installed = [model('minimax-m3', { api: 'anthropic-messages' })]
        const models = mergeCatalog({
            gateway: OPENCODE_GO,
            profile: profile(),
            installed,
            live: live(['minimax-m3', 'minimax-m2.5', 'gpt-6-luna', 'brand-new'], metadata({ 'brand-new': {} })),
        })
        const byId = new Map(models.map((entry) => [entry.id, entry]))
        // Exact catalog entry.
        expect(byId.get('minimax-m3')?.api).toBe('anthropic-messages')
        // The gateway's published endpoint table, for an id the catalog lacks.
        expect(byId.get('gpt-6-luna')?.api).toBe('openai-responses')
        // Undocumented, but a surveyed relative shares the id family.
        expect(byId.get('minimax-m2.5')?.api).toBe('anthropic-messages')
        // Nothing in common with anything surveyed: the route default.
        expect(byId.get('brand-new')?.api).toBe('openai-completions')
    })

    it('inherits compat switches from the nearest surveyed relative', () => {
        const compat = { thinkingFormat: 'deepseek' as const, supportsStore: false, maxTokensField: 'max_tokens' as const, requiresReasoningContentOnAssistantMessages: true }
        const models = mergeCatalog({
            gateway: OPENCODE_GO,
            profile: profile(),
            installed: [model('deepseek-v4-flash', { compat })],
            live: live(
                ['deepseek-v4-flash', 'deepseek-v4.1-flash'],
                metadata({
                    'deepseek-v4-flash': { family: 'deepseek-flash' },
                    'deepseek-v4.1-flash': { family: 'deepseek-flash', contextWindow: 1_000_000, maxTokens: 384_000, reasoning: true, options: { effort: ['low', 'high', 'max'], toggle: false } },
                }),
            ),
        })
        const fresh = models.find((entry) => entry.id === 'deepseek-v4.1-flash')
        expect(fresh?.compat).toEqual(compat)
        expect(fresh?.thinkingLevelMap).toEqual({ minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: 'max' })
    })

    it('leaves compat to pi-ai when no relative has been surveyed', () => {
        const models = mergeCatalog({
            gateway: OPENCODE_GO,
            profile: profile(),
            installed: [model('a')],
            live: live(['a', 'orphan'], metadata({ orphan: { family: 'nobody' } })),
        })
        expect(models.find((entry) => entry.id === 'orphan')?.compat).toBeUndefined()
    })

    it('prefers a provider-published cost over the surveyed one, and keeps the survey when it is zero', () => {
        const models = mergeCatalog({
            gateway: OPENCODE_GO,
            profile: profile(),
            installed: [model('a')],
            live: live(['a'], metadata({ a: { cost: { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 } } })),
        })
        expect(models[0]?.cost.input).toBe(0.15)
    })

    it('drops the reasoning map for a model that does not reason', () => {
        const models = mergeCatalog({
            gateway: OPENCODE_GO,
            profile: profile(),
            installed: [model('a', { reasoning: false })],
            live: live(['a'], metadata({ a: { reasoning: false } })),
        })
        expect(models[0]?.reasoning).toBe(false)
        expect(models[0]?.thinkingLevelMap).toBeUndefined()
    })

    it('honours a profile endpoint override for every merged model', () => {
        const models = mergeCatalog({
            gateway: OPENCODE_GO,
            profile: profile({ baseURL: 'https://proxy.example/v1' }),
            installed: [model('a')],
            live: live(['a', 'b'], metadata({ b: {} })),
        })
        expect(models.map((entry) => entry.baseUrl)).toEqual(['https://proxy.example/v1', 'https://proxy.example/v1'])
    })
})

describe('createCatalogFeed', () => {
    const profiles = (): ProviderSettings => resolveProfiles({})

    function feed(options: { ids?: string[]; status?: number; installed?: readonly Model<Api>[] } = {}) {
        const applied: { route: string; live: LiveCatalog }[] = []
        const fetchImpl = vi.fn(async (input: string | URL | Request) => {
            const url = String(input)
            if (url.includes('models.dev')) {
                return new Response('{"opencode-go":{"models":{"fresh":{"id":"fresh","name":"Fresh","limit":{"context":500000,"output":9000}}}}}', { status: 200 })
            }
            if (options.status !== undefined && options.status !== 200) return new Response('nope', { status: options.status })
            return new Response(JSON.stringify({ object: 'list', data: (options.ids ?? ['a', 'fresh']).map((id) => ({ id })) }), { status: 200 })
        })
        const catalog = createCatalogFeed({
            gateways: GATEWAYS,
            profileOf: () => profile(),
            resolveApiKey: async () => 'k',
            installedModels: () => options.installed ?? [model('a')],
            apply: (route, live) => applied.push({ route, live }),
            fetch: fetchImpl as unknown as typeof fetch,
            now: () => 4_242,
        })
        return { catalog, applied, fetchImpl }
    }

    it('fetches once and installs the live catalog with metadata', async () => {
        const { catalog, applied } = feed()
        const [snapshot] = await catalog.refresh()
        expect(applied).toHaveLength(1)
        expect(applied[0]?.live.ids).toEqual(['a', 'fresh'])
        expect(applied[0]?.live.metadata.get('fresh')?.contextWindow).toBe(500_000)
        expect(snapshot).toMatchObject({ route: OPENCODE_GO.id, liveCount: 2, modelCount: 2, metadataLoaded: true, fetchedAt: 4_242 })
    })

    it('names the models the installed catalog does not know — the point of the refresh', async () => {
        const { catalog } = feed({ ids: ['a', 'fresh', 'brand-new'], installed: [model('a')] })
        const [snapshot] = await catalog.refresh()
        expect(snapshot?.discovered).toEqual(['fresh', 'brand-new'])
    })

    it('does not install anything when the gateway refuses, and says so', async () => {
        const { catalog, applied } = feed({ status: 401 })
        const [snapshot] = await catalog.refresh()
        expect(applied).toEqual([])
        expect(snapshot?.liveCount).toBe(0)
        expect(snapshot?.error).toMatch(/could not be read/)
        expect(snapshot?.modelCount).toBe(1)
    })

    it('fetches only the requested route', async () => {
        const { catalog } = feed()
        const snapshots = await catalog.refresh(OPENCODE_GO.id)
        expect(snapshots.map((entry) => entry.route)).toEqual([OPENCODE_GO.id])
        expect(await catalog.refresh('not-a-route')).toEqual([])
    })

    it('reports the last snapshot without fetching again', async () => {
        const { catalog, fetchImpl } = feed()
        expect(catalog.snapshot(OPENCODE_GO.id)).toBeUndefined()
        await catalog.refresh()
        const calls = fetchImpl.mock.calls.length
        expect(catalog.snapshot(OPENCODE_GO.id)?.liveCount).toBe(2)
        expect(catalog.snapshots()).toHaveLength(1)
        expect(fetchImpl.mock.calls.length).toBe(calls)
    })

    it('calls the metadata dataset once for a multi-route refresh', async () => {
        const applied: { route: string; live: LiveCatalog }[] = []
        const fetchImpl = vi.fn(async (input: string | URL | Request) => {
            const url = String(input)
            if (url.includes('models.dev')) return new Response('{"opencode-go":{"models":{}}}', { status: 200 })
            return new Response(JSON.stringify({ object: 'list', data: [{ id: 'a' }] }), { status: 200 })
        })
        const two: readonly GatewayDefinition[] = [GATEWAYS[0]!, { ...GATEWAYS[0]!, id: 'second' }]
        const catalog = createCatalogFeed({
            gateways: two,
            profileOf: () => profile(),
            resolveApiKey: async () => undefined,
            installedModels: () => [model('a')],
            apply: (route, live) => applied.push({ route, live }),
            fetch: fetchImpl as unknown as typeof fetch,
        })
        const snapshots = await catalog.refresh()
        expect(snapshots.map((entry) => entry.route)).toEqual([OPENCODE_GO.id, 'second'])
        expect(fetchImpl.mock.calls.filter(([input]) => String(input).includes('models.dev'))).toHaveLength(1)
    })
})

describe('inheriting a wire dialect when the dataset has moved on', () => {
    const compat = { thinkingFormat: 'deepseek' as const, supportsStore: false, maxTokensField: 'max_tokens' as const, requiresReasoningContentOnAssistantMessages: true }

    it('finds the nearest installed model by id when the dataset names no family', () => {
        // models.dev dropped `deepseek-v4-flash` while the gateway kept serving it
        // and its successor; without this fallback the successor had no compat at
        // all and the second turn failed with a 400.
        const installed = [model('deepseek-v4-flash', { compat }), model('kimi-k3')]
        expect(nearestInstalled('deepseek-v4.1-flash', installed)?.id).toBe('deepseek-v4-flash')
    })

    it('refuses a distant match, so an unrelated model inherits nothing', () => {
        expect(nearestInstalled('zzz-brand-new', [model('deepseek-v4-flash', { compat })])).toBeUndefined()
        expect(nearestInstalled('kimi-k2.6', [model('kimi-k2.7')])?.id).toBe('kimi-k2.7')
    })

    it('carries the compat onto a live-only model when metadata for the relative is gone', () => {
        const models = mergeCatalog({
            gateway: OPENCODE_GO,
            profile: profile(),
            installed: [model('deepseek-v4-flash', { compat })],
            // Live list has the successor; models.dev knows nothing about either.
            live: live(['deepseek-v4-flash', 'deepseek-v4.1-flash'], metadata({})),
        })
        expect(models.find((entry) => entry.id === 'deepseek-v4.1-flash')?.compat).toEqual(compat)
    })

    it('still prefers the dataset family when one is available', () => {
        const models = mergeCatalog({
            gateway: OPENCODE_GO,
            profile: profile(),
            installed: [model('muse-spark-1.2', { compat: { thinkingFormat: 'openai' } })],
            live: live(['muse-spark-1.3'], metadata({ 'muse-spark-1.2': { family: 'muse' }, 'muse-spark-1.3': { family: 'muse' } })),
        })
        expect(models.find((entry) => entry.id === 'muse-spark-1.3')?.compat).toEqual({ thinkingFormat: 'openai' })
    })
})
