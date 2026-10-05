import { describe, expect, it, vi } from 'vitest'
import type { Api, Model } from '@earendil-works/pi-ai'
import { createQuotaTool, formatCatalog, formatModel, runProviderCommand, type SurfaceDeps } from '../src/surface.ts'
import type { CatalogFeed, RouteCatalogSnapshot } from '../src/catalog-feed.ts'
import { parseQuota } from '../src/gateway-api.ts'

function model(id: string, over: Partial<Model<'openai-completions'>> = {}): Model<Api> {
    return {
        id,
        name: id,
        api: 'openai-completions',
        provider: 'opencode-go',
        baseUrl: 'https://opencode.ai/zen/go/v1',
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1_000_000,
        maxTokens: 384_000,
        thinkingLevelMap: { minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: 'max' },
        ...over,
    } as Model<Api>
}

const snapshot = (over: Partial<RouteCatalogSnapshot> = {}): RouteCatalogSnapshot => ({
    route: 'opencode-go',
    modelCount: 36,
    liveCount: 36,
    discovered: ['deepseek-v4.1-flash'],
    metadataLoaded: true,
    fetchedAt: 1_791_212_000_000,
    ...over,
})

function deps(over: Partial<SurfaceDeps> = {}): SurfaceDeps {
    const plainFeed: CatalogFeed = {
        refresh: vi.fn(async () => [snapshot()]),
        snapshot: () => snapshot(),
        snapshots: () => [snapshot()],
    }
    return {
        routes: ['opencode-go'],
        feed: plainFeed,
        modelsOf: () => [model('a'), model('b', { reasoning: false, thinkingLevelMap: undefined })],
        quotaOf: async () => parseQuota({ usage: { rolling: { status: 'ok', percent: 2 } } }, 'opencode-go', 0),
        ...over,
    }
}

describe('formatModel', () => {
    it('leads with the facts a picker needs', () => {
        expect(formatModel(model('deepseek-v4.1-flash'))).toBe(
            'deepseek-v4.1-flash — 1000k ctx, 384k out, thinking: off/low/high/max, text+image, openai-completions',
        )
    })

    it('says so when a model cannot think, rather than printing an empty list', () => {
        expect(formatModel(model('plain', { reasoning: false, thinkingLevelMap: undefined }))).toContain('no thinking')
    })
})

describe('formatCatalog', () => {
    it('reports where the list came from and what is new', () => {
        const lines = formatCatalog(snapshot(), [model('a')])
        expect(lines[0]).toMatch(/Live catalog: 36 models from the gateway, 36 advertised/)
        expect(lines[1]).toBe('New since this pi-ai build: deepseek-v4.1-flash')
        expect(lines[2]).toMatch(/models\.dev/)
        expect(lines[3]).toContain('a — ')
    })

    it('explains a failed live read instead of pretending the catalog is complete', () => {
        const lines = formatCatalog(
            snapshot({ liveCount: 0, modelCount: 27, discovered: [], metadataLoaded: false, error: 'boom' }),
            [model('a')],
        )
        expect(lines[0]).toMatch(/No live catalog read \(boom\)/)
        expect(lines[1]).toMatch(/capacities fall back/)
    })

    it('renders just the models before the first refresh', () => {
        expect(formatCatalog(undefined, [model('a')])).toHaveLength(1)
    })
})

describe('runProviderCommand', () => {
    it('lists the primary route when called with no subcommand', async () => {
        const result = await runProviderCommand(deps(), '')
        expect(result.kind).toBe('success')
        expect(result.text.split('\n')[0]).toBe('opencode-go models:')
    })

    it('prints the quota windows', async () => {
        const result = await runProviderCommand(deps(), 'quota')
        expect(result.text).toContain('opencode-go quota:')
        expect(result.text).toContain('5-hour: 98% left')
    })

    it('refreshes on demand and reports what the fetch found', async () => {
        const refresh = vi.fn(async () => [snapshot({ liveCount: 40, discovered: ['x'] })])
        const feed: CatalogFeed = { refresh, snapshot: () => snapshot(), snapshots: () => [] }
        const result = await runProviderCommand(deps({ feed }), 'refresh')
        expect(refresh).toHaveBeenCalledWith('opencode-go')
        expect(result.text).toMatch(/40 models from the gateway/)
    })

    it('accepts an explicit route and refuses an unknown one', async () => {
        expect((await runProviderCommand(deps(), 'models opencode-go')).text).toContain('opencode-go models:')
        expect((await runProviderCommand(deps(), 'models nope')).text).toMatch(/Unknown route "nope".*opencode-go/)
    })

    it('lists the subcommands when given something else', async () => {
        expect((await runProviderCommand(deps(), 'wat')).text).toMatch(/Unknown subcommand "wat".*models \[route\], quota \[route\], refresh \[route\]/)
    })
})

describe('createQuotaTool', () => {
    it('describes the windows the agent can check before a long job', () => {
        const tool = createQuotaTool(deps())
        expect(tool.name).toBe('llm_quota')
        expect(tool.description).toMatch(/5-hour, weekly, and monthly/)
        // `defineTool` publishes a converted JSON schema, not the spec object.
        expect(tool.parameters).toMatchObject({ type: 'object' })
        expect(Object.keys((tool.parameters as { properties?: Record<string, unknown> }).properties ?? {})).toEqual(['route'])
    })

    it('reports the primary route when the model names none', async () => {
        const tool = createQuotaTool(deps())
        const result = (await tool.execute?.({}, {} as never)) as { text: string; details: Record<string, unknown> }
        expect(result.text).toContain('5-hour: 98% left')
        expect(result.details['route']).toBe('opencode-go')
        expect(result.details['windows']).toEqual([
            { id: 'rolling', label: '5-hour', percentUsed: 2, percentRemaining: 98, status: 'ok', resetsAt: null },
        ])
    })

    it('refuses an unknown route as an answer, not a crash', async () => {
        const tool = createQuotaTool(deps())
        const result = (await tool.execute?.({ route: 'nope' }, {} as never)) as { text: string; details: Record<string, unknown> }
        expect(result.text).toMatch(/Unknown provider route "nope"/)
        expect(result.details['error']).toBe('unknown route')
    })

    it('rejects a wrongly-typed argument before the handler runs, through its own schema', async () => {
        const quotaOf = vi.fn(async () => ({ route: 'opencode-go', windows: [], fetchedAt: 0 }))
        const tool = createQuotaTool(deps({ quotaOf }))
        await expect(tool.execute?.({ route: 7 }, {} as never)).rejects.toThrow(/must be a string/)
        expect(quotaOf).not.toHaveBeenCalled()
    })

    it('passes the provider failure through as an explainable empty report', async () => {
        const tool = createQuotaTool(deps({ quotaOf: async () => ({ route: 'opencode-go', windows: [], fetchedAt: 0, error: 'usage endpoint answered 429' }) }))
        const result = (await tool.execute?.({}, {} as never)) as { text: string; details: Record<string, unknown> }
        expect(result.text).toContain('usage endpoint answered 429')
        expect(result.details['error']).toBe('usage endpoint answered 429')
    })
})
