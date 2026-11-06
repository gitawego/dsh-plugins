/**
 * The two surfaces that make the status readable: the command and the tool.
 *
 * Both read the same snapshot, so these tests drive one fake snapshot through
 * every path and assert the exact lines a user or a model sees.
 */
import { describe, expect, it, vi } from 'vitest'
import type { QuotaSnapshot } from '../src/gateway-api.ts'
import { composeStatus, type ProviderStatus } from '../src/status.ts'
import { createQuotaTool, formatModel, formatStatus, runProviderCommand, type SurfaceDeps } from '../src/surface.ts'

/** A status with one known and one gateway-only model. */
function status(overrides: Partial<Parameters<typeof composeStatus>[0]> = {}): ProviderStatus {
    return composeStatus({
        route: 'opencode-go',
        endpoint: 'https://gw.test/v1',
        credential: 'MY_KEY',
        apiKey: 'sk-live',
        knownModels: [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }],
        liveIds: ['deepseek-v4-flash', 'deepseek-v4.1-flash'],
        metadata: new Map([
            ['deepseek-v4-flash', { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', input: ['text'], reasoning: true, contextWindow: 1_000_000, maxTokens: 384_000 }],
        ]),
        fetchedAt: Date.UTC(2026, 0, 2, 3, 4, 5),
        ...overrides,
    })
}

/** A quota report with all three windows. */
const quota: QuotaSnapshot = {
    route: 'opencode-go',
    fetchedAt: 1_700_000_000_000,
    windows: [
        { id: 'rolling', label: '5-hour', percentUsed: 12, percentRemaining: 88, status: 'ok', resetsAt: '2026-01-02T08:00:00.000Z' },
        { id: 'weekly', label: 'weekly', percentUsed: 40, percentRemaining: 60, status: 'ok' },
        { id: 'monthly', label: 'monthly', percentUsed: 5, percentRemaining: 95, status: 'ok' },
    ],
}

/** Dependencies over one snapshot. */
function deps(overrides: Partial<SurfaceDeps> = {}): SurfaceDeps {
    return {
        route: 'opencode-go',
        status: () => status(),
        refresh: async () => status(),
        quotaOf: async () => quota,
        ...overrides,
    }
}

describe('rendering one model', () => {
    it('states capacities, modalities, and where the id came from', () => {
        const row = status().models.find((entry) => entry.id === 'deepseek-v4-flash')!
        expect(formatModel(row)).toBe('deepseek-v4-flash — 1M ctx, 384k out, text, thinking · catalog+live')
    })

    it('marks a gateway-only id', () => {
        const row = status().models.find((entry) => entry.id === 'deepseek-v4.1-flash')!
        expect(formatModel(row)).toContain('live only')
    })

    it('says so when nothing is disclosed', () => {
        const row = status().models.find((entry) => entry.id === 'deepseek-v4.1-flash')!
        expect(formatModel(row)).toContain('no capacities disclosed')
    })
})

describe('rendering the status', () => {
    it('reports both counts and the read time', () => {
        const lines = formatStatus(status())
        expect(lines[0]).toBe('Live catalog: 2 served by https://gw.test/v1, 1 advertised by the harness catalog (read 2026-01-02T03:04:05.000Z).')
    })

    it('names the ids the catalog cannot offer', () => {
        expect(formatStatus(status())).toContain('Not in the installed catalog: deepseek-v4.1-flash.')
    })

    it('reports a read problem instead of hiding it', () => {
        const lines = formatStatus(status({ liveIds: [], error: 'the gateway listed no models' }))
        expect(lines).toContain('Read problem: the gateway listed no models.')
    })
})

describe('the /llm-provider command', () => {
    it('defaults to the model list', async () => {
        const outcome = await runProviderCommand(deps(), '')
        expect(outcome.text.split('\n')[0]).toBe('opencode-go models:')
    })

    it('prints the paste-ready block when the catalog is behind', async () => {
        const text = (await runProviderCommand(deps(), 'models')).text
        expect(text).toContain('add them to llm-pi-ai.providers.opencode-go:')
        expect(text).toContain('      - id: deepseek-v4.1-flash')
    })

    it('omits the block when the catalog already knows every id', async () => {
        const text = (await runProviderCommand(deps({ status: () => status({ liveIds: ['deepseek-v4-flash'] }) }), 'models')).text
        expect(text).not.toContain('add them to')
    })

    it('prints every quota window', async () => {
        const text = (await runProviderCommand(deps(), 'quota')).text
        expect(text.split('\n')[0]).toBe('opencode-go quota:')
        expect(text).toContain('5-hour: 88% left')
        expect(text).toContain('weekly: 60% left')
        expect(text).toContain('monthly: 95% left')
    })

    it('re-reads on refresh', async () => {
        const refresh = vi.fn(async () => status({ liveIds: [] }))
        const text = (await runProviderCommand(deps({ refresh }), 'refresh')).text
        expect(refresh).toHaveBeenCalledOnce()
        expect(text).toContain('0 served')
    })

    it('lists the known subcommands for anything else', async () => {
        expect((await runProviderCommand(deps(), 'nonsense')).text).toBe('Unknown subcommand "nonsense". Use: models, quota, refresh.')
    })
})

describe('the llm_quota tool', () => {
    it('answers the same windows as the command', async () => {
        const tool = createQuotaTool(deps())
        const result = await tool.execute({} as never, {} as never) as { text: string; details: Record<string, unknown> }
        expect(result.text).toContain('weekly: 60% left')
        expect(result.details['route']).toBe('opencode-go')
        expect((result.details['windows'] as unknown[]).length).toBe(3)
    })

    it('carries the reset time and a null for the windows that have none', async () => {
        const tool = createQuotaTool(deps())
        const result = await tool.execute({} as never, {} as never) as { details: { windows: { id: string; resetsAt: string | null }[] } }
        const rolling = result.details.windows.find((window) => window.id === 'rolling')
        const weekly = result.details.windows.find((window) => window.id === 'weekly')
        expect(rolling?.resetsAt).toBe('2026-01-02T08:00:00.000Z')
        expect(weekly?.resetsAt).toBeNull()
    })

    it('reports an unreadable allowance instead of throwing', async () => {
        const tool = createQuotaTool(deps({
            quotaOf: async () => ({ route: 'opencode-go', windows: [], fetchedAt: 0, error: 'no credential for route "opencode-go"' }),
        }))
        const result = await tool.execute({} as never, {} as never) as { text: string; details: Record<string, unknown> }
        expect(result.text).toContain('No quota reported for opencode-go: no credential')
        expect(result.details['error']).toBe('no credential for route "opencode-go"')
    })

    it('takes no arguments: the route is the profile\'s, not the model\'s', () => {
        const tool = createQuotaTool(deps())
        expect((tool.parameters as { properties?: Record<string, unknown> }).properties ?? {}).toEqual({})
    })
})
